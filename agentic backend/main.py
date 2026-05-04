import argparse
import base64
import json
import os
import re
import threading
import time
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Optional

import cv2
import face_recognition
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

BASE_DIR = Path(__file__).parent
ARCFACE_DIR = BASE_DIR / "Attendance by ArcFace"
DATASET_PATH = ARCFACE_DIR / "dataset"
STUDENTS_FILE = BASE_DIR / "students.json"
RECORDS_DIR = BASE_DIR / "records"
FACE_MATCH_TOLERANCE = 0.55

import sys as _sys
_sys.path.insert(0, str(BASE_DIR / "Attendance by ArcFace"))
from capture_face import largest_face_location as detect_largest_face, crop_face

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def safe_file_name(name: str) -> str:
    name = name.strip()
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r"\s+", " ", name)
    return name


def display_name_from_file(file_name: str) -> str:
    name = os.path.splitext(file_name)[0]
    return re.sub(r"_\d+$", "", name)


def next_image_path(safe_name: str) -> Path:
    first = DATASET_PATH / f"{safe_name}.jpg"
    if not first.exists():
        return first
    i = 2
    while True:
        p = DATASET_PATH / f"{safe_name}_{i}.jpg"
        if not p.exists():
            return p
        i += 1


# ---------------------------------------------------------------------------
# Student storage
# ---------------------------------------------------------------------------

def load_students() -> list:
    if not STUDENTS_FILE.exists():
        return []
    try:
        with open(STUDENTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("students", [])
    except (json.JSONDecodeError, ValueError):
        return []


def save_students(students: list):
    with open(STUDENTS_FILE, "w", encoding="utf-8") as f:
        json.dump({"students": students}, f, indent=2, ensure_ascii=False)


def sync_dataset_to_students():
    """Create minimal entries for dataset images that have no matching student record."""
    if not DATASET_PATH.exists():
        return
    students = load_students()
    existing_lower = {s["name"].lower() for s in students}
    changed = False

    names_seen: set = set()
    for p in sorted(DATASET_PATH.iterdir()):
        if p.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        name = display_name_from_file(p.name)
        if name.lower() in existing_lower or name.lower() in names_seen:
            continue
        names_seen.add(name.lower())
        paths = sorted(
            str(q) for q in DATASET_PATH.iterdir()
            if q.suffix.lower() in (".jpg", ".jpeg", ".png")
            and display_name_from_file(q.name).lower() == name.lower()
        )
        students.append({
            "id": str(uuid.uuid4()),
            "name": name,
            "rollNumber": "",
            "className": "",
            "section": "",
            "sampleImagePaths": paths,
            "registeredAt": datetime.utcnow().isoformat() + "Z",
        })
        existing_lower.add(name.lower())
        changed = True

    if changed:
        save_students(students)


# ---------------------------------------------------------------------------
# Face encoding cache
# ---------------------------------------------------------------------------

_enc_lock = threading.Lock()
_fr_lock = threading.Lock()   # dlib/face_recognition is NOT thread-safe; one call at a time
_known_encodings: list = []
_known_student_ids: list = []


def reload_face_encodings(students: list):
    global _known_encodings, _known_student_ids
    encodings: list = []
    student_ids: list = []

    for student in students:
        for img_path_str in student.get("sampleImagePaths", []):
            p = Path(img_path_str)
            if not p.exists():
                print(f"[encoding] missing file: {p.name}")
                continue
            try:
                with _fr_lock:
                    image = face_recognition.load_image_file(str(p))
                    h, w = image.shape[:2]
                    found = face_recognition.face_encodings(image)
                    if not found:
                        # Saved image may be a tight face crop — treat entire image as the face
                        found = face_recognition.face_encodings(image, known_face_locations=[(0, w, h, 0)])
                if found:
                    encodings.append(found[0])
                    student_ids.append(student["id"])
                else:
                    print(f"[encoding] no face found in {p.name}, skipping")
            except Exception as exc:
                print(f"[encoding] skipping {p.name}: {exc}")

    with _enc_lock:
        _known_encodings = encodings
        _known_student_ids = student_ids

    _live_state["encodingCount"] = len(encodings)
    print(f"[encoding] {len(encodings)} encoding(s) loaded for {len(students)} student(s)")


# ---------------------------------------------------------------------------
# Attendance record storage
# ---------------------------------------------------------------------------

def _records_file(for_date: str) -> Path:
    return RECORDS_DIR / f"attendance_{for_date}.json"


def _load_records(for_date: str) -> list:
    fp = _records_file(for_date)
    if not fp.exists():
        return []
    try:
        with open(fp, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return []


def _save_records(for_date: str, records: list):
    with open(_records_file(for_date), "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)


def _mark_attendance(student: dict):
    today = date.today().isoformat()
    records = _load_records(today)
    existing = next((r for r in records if r["studentId"] == student["id"]), None)
    if existing and existing["status"] == "present":
        return
    if existing:
        existing["status"] = "present"
        existing["markedAt"] = datetime.utcnow().isoformat() + "Z"
    else:
        records.append({
            "id": str(uuid.uuid4()),
            "studentId": student["id"],
            "student": {
                "name": student["name"],
                "rollNumber": student["rollNumber"],
                "className": student["className"],
                "section": student["section"],
            },
            "date": today,
            "status": "present",
            "markedAt": datetime.utcnow().isoformat() + "Z",
        })
    _save_records(today, records)


# ---------------------------------------------------------------------------
# Live recognition thread
# ---------------------------------------------------------------------------

_live_state: dict = {"running": False, "recentDetections": [], "encodingCount": 0, "cameraOpen": False, "detectionCount": 0}
_latest_frame: bytes = b""
_frame_lock = threading.Lock()
_live_thread: Optional[threading.Thread] = None
_live_stop_event = threading.Event()


def _live_worker(students_snapshot: list, stop_event: threading.Event):
    global _latest_frame
    cam_index = int(os.environ.get("ATTENDANCE_CAMERA_INDEX", "0"))
    cam = cv2.VideoCapture(cam_index)
    if not cam.isOpened():
        print(f"[live] could not open camera {cam_index}")
        _live_state["running"] = False
        _live_state["cameraOpen"] = False
        return

    _live_state["cameraOpen"] = True
    print(f"[live] camera {cam_index} opened, recognition running")
    consecutive_failures = 0
    try:
        while not stop_event.is_set():
            ok, frame = cam.read()
            if not ok:
                consecutive_failures += 1
                if consecutive_failures > 30:
                    print("[live] too many frame grab failures, stopping")
                    break
                time.sleep(0.1)
                continue
            consecutive_failures = 0

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            with _fr_lock:
                face_locs = face_recognition.face_locations(rgb, number_of_times_to_upsample=1, model="hog")

            # Draw all detected faces on the preview frame
            preview = frame.copy()
            face_matches: dict = {}  # face_loc index → student or None

            if face_locs:
                with _enc_lock:
                    known_enc = list(_known_encodings)
                    known_ids = list(_known_student_ids)

                if known_enc:
                    with _fr_lock:
                        face_encs = face_recognition.face_encodings(rgb, face_locs)

                    for i, face_enc in enumerate(face_encs):
                        distances = face_recognition.face_distance(known_enc, face_enc)
                        best_idx = int(np.argmin(distances))
                        confidence = float(1.0 - distances[best_idx])
                        match_student = None

                        if distances[best_idx] <= FACE_MATCH_TOLERANCE:
                            sid = known_ids[best_idx]
                            match_student = next((s for s in students_snapshot if s["id"] == sid), None)
                            if match_student:
                                _mark_attendance(match_student)

                        face_matches[i] = (match_student, confidence)
                        detection = {
                            "detectedAt": datetime.utcnow().isoformat() + "Z",
                            "confidence": round(confidence, 3),
                            "match": {
                                "name": match_student["name"],
                                "rollNumber": match_student["rollNumber"],
                                "className": match_student["className"],
                                "section": match_student["section"],
                            } if match_student else None,
                        }
                        _live_state["recentDetections"] = (
                            [detection] + _live_state["recentDetections"]
                        )[:20]
                        _live_state["detectionCount"] += 1

            # Draw bounding boxes and labels
            for i, (top, right, bottom, left) in enumerate(face_locs):
                match_student, confidence = face_matches.get(i, (None, 0.0))
                color = (0, 255, 0) if match_student else (0, 0, 255)
                cv2.rectangle(preview, (left, top), (right, bottom), color, 2)
                label = f"{match_student['name']} ({confidence:.0%})" if match_student else "Unknown"
                cv2.rectangle(preview, (left, bottom), (right, bottom + 22), color, cv2.FILLED)
                cv2.putText(preview, label, (left + 4, bottom + 16),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)

            # Encode frame and store for MJPEG stream
            ok_enc, jpeg = cv2.imencode(
                ".jpg", preview,
                [cv2.IMWRITE_JPEG_QUALITY, 75],
            )
            if ok_enc:
                with _frame_lock:
                    _latest_frame = jpeg.tobytes()

    finally:
        _live_state["running"] = False
        _live_state["cameraOpen"] = False
        with _frame_lock:
            _latest_frame = b""
        cam.release()
        print("[live] camera released")


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/attendance/live/stream")
async def live_stream():
    def generate():
        while _live_state.get("running"):
            with _frame_lock:
                frame = _latest_frame
            if frame:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                )
            time.sleep(0.04)  # ~25 fps cap

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.post("/attendance/students/register")
async def register_student(request: Request):
    body = await request.json()
    name = (body.get("name") or "").strip()
    roll_number = (body.get("rollNumber") or "").strip()
    class_name = (body.get("className") or "").strip()
    section = (body.get("section") or "").strip()
    images_b64 = body.get("images") or []

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not roll_number or not class_name or not section:
        raise HTTPException(status_code=400, detail="rollNumber, className, and section are required")
    if not images_b64:
        raise HTTPException(status_code=400, detail="At least one image is required")

    DATASET_PATH.mkdir(parents=True, exist_ok=True)
    safe_name = safe_file_name(name)
    saved_paths: list = []

    skipped = 0
    for img_data in images_b64:
        # Strip "data:image/jpeg;base64," prefix if present
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]
        try:
            img_bytes = base64.b64decode(img_data)
        except Exception:
            skipped += 1
            continue
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            skipped += 1
            continue

        # Detect and crop the face using capture_face.py logic
        with _fr_lock:
            face_location = detect_largest_face(frame)
        if face_location is not None:
            frame = crop_face(frame, face_location)
        else:
            print(f"[register] no face detected in sample {len(saved_paths)+skipped+1}, saving full frame")

        img_path = next_image_path(safe_name)
        cv2.imwrite(str(img_path), frame)
        saved_paths.append(str(img_path))

    if not saved_paths:
        raise HTTPException(status_code=400, detail="No valid images could be decoded")

    students = load_students()
    existing = next((s for s in students if s["name"].lower() == name.lower()), None)
    if existing:
        existing["sampleImagePaths"] = list(dict.fromkeys(existing["sampleImagePaths"] + saved_paths))
        existing["rollNumber"] = roll_number
        existing["className"] = class_name
        existing["section"] = section
    else:
        existing = {
            "id": str(uuid.uuid4()),
            "name": name,
            "rollNumber": roll_number,
            "className": class_name,
            "section": section,
            "sampleImagePaths": saved_paths,
            "registeredAt": datetime.utcnow().isoformat() + "Z",
        }
        students.append(existing)

    save_students(students)
    reload_face_encodings(students)

    return {"student": existing}


@app.post("/attendance/detect-face")
async def detect_face_endpoint(request: Request):
    body = await request.json()
    img_data = body.get("image", "")
    if "," in img_data:
        img_data = img_data.split(",", 1)[1]
    try:
        nparr = np.frombuffer(base64.b64decode(img_data), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception:
        return {"face": None}
    if frame is None:
        return {"face": None}
    with _fr_lock:
        face_location = detect_largest_face(frame)
    if face_location is None:
        return {"face": None}
    top, right, bottom, left = face_location
    h, w = frame.shape[:2]
    return {"face": {"top": top, "right": right, "bottom": bottom, "left": left, "frameWidth": w, "frameHeight": h}}


@app.get("/attendance/students")
def get_students():
    return {"students": load_students()}


@app.post("/attendance/live/start")
def start_live():
    global _live_thread, _live_stop_event
    if _live_state["running"]:
        return {"live": _live_state}

    students = load_students()
    reload_face_encodings(students)

    _live_stop_event = threading.Event()
    _live_thread = threading.Thread(
        target=_live_worker, args=(students, _live_stop_event), daemon=True
    )
    _live_state["running"] = True
    _live_state["recentDetections"] = []
    _live_state["detectionCount"] = 0
    _live_thread.start()
    return {"live": _live_state}


@app.post("/attendance/live/stop")
def stop_live():
    global _live_thread
    _live_stop_event.set()
    if _live_thread:
        _live_thread.join(timeout=5)
        _live_thread = None
    _live_state["running"] = False
    _live_state["cameraOpen"] = False
    return {"live": _live_state}


@app.get("/attendance/live/status")
def live_status():
    return {"live": _live_state}


@app.post("/attendance/reload-encodings")
def reload_encodings_endpoint():
    students = load_students()
    reload_face_encodings(students)
    return {"encodingCount": _live_state["encodingCount"]}


@app.get("/attendance/records")
def get_records(
    date: Optional[str] = None,
    className: Optional[str] = None,
    section: Optional[str] = None,
):
    target_date = date or datetime.now().date().isoformat()
    records = _load_records(target_date)

    if className:
        records = [r for r in records if r.get("student", {}).get("className", "").lower() == className.lower()]
    if section:
        records = [r for r in records if r.get("student", {}).get("section", "").lower() == section.lower()]

    # Append absent entry for every registered student not yet in the list
    students = load_students()
    present_ids = {r["studentId"] for r in records}
    for student in students:
        if student["id"] in present_ids:
            continue
        if className and student.get("className", "").lower() != className.lower():
            continue
        if section and student.get("section", "").lower() != section.lower():
            continue
        records.append({
            "id": f"absent-{student['id']}-{target_date}",
            "studentId": student["id"],
            "student": {
                "name": student["name"],
                "rollNumber": student["rollNumber"],
                "className": student["className"],
                "section": student["section"],
            },
            "date": target_date,
            "status": "absent",
        })

    return {"records": records}


@app.post("/attendance/records/manual")
async def manual_attendance(request: Request):
    body = await request.json()
    student_id = body.get("studentId")
    target_date = body.get("date") or datetime.now().date().isoformat()
    status = body.get("status", "present")

    students = load_students()
    student = next((s for s in students if s["id"] == student_id), None)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    records = _load_records(target_date)
    existing = next((r for r in records if r["studentId"] == student_id), None)
    if existing:
        existing["status"] = status
        existing["markedAt"] = datetime.utcnow().isoformat() + "Z"
    else:
        existing = {
            "id": str(uuid.uuid4()),
            "studentId": student_id,
            "student": {
                "name": student["name"],
                "rollNumber": student["rollNumber"],
                "className": student["className"],
                "section": student["section"],
            },
            "date": target_date,
            "status": status,
            "markedAt": datetime.utcnow().isoformat() + "Z",
        }
        records.append(existing)

    _save_records(target_date, records)
    return {"record": existing}


@app.patch("/attendance/records/{record_id}")
async def update_record(record_id: str, request: Request):
    body = await request.json()
    target_date = body.get("date") or datetime.now().date().isoformat()
    status = body.get("status")

    records = _load_records(target_date)
    record = next((r for r in records if r["id"] == record_id), None)
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")

    if status:
        record["status"] = status
        record["markedAt"] = datetime.utcnow().isoformat() + "Z"

    _save_records(target_date, records)
    return {"record": record}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Attendance API service")
    parser.add_argument("--mode", default="api")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    DATASET_PATH.mkdir(parents=True, exist_ok=True)
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)

    # Bring existing dataset images into the student registry
    sync_dataset_to_students()

    # Pre-load face encodings so the first recognition is fast
    reload_face_encodings(load_students())

    uvicorn.run(app, host=args.host, port=args.port)
