import argparse
import asyncio
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
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING

BASE_DIR = Path(__file__).parent
ARCFACE_DIR = BASE_DIR / "Attendance by ArcFace"
DATASET_PATH = ARCFACE_DIR / "dataset"
STUDENTS_FILE = BASE_DIR / "students.json"
RECORDS_DIR = BASE_DIR / "records"
FACE_MATCH_TOLERANCE = 0.52

import sys as _sys
_sys.path.insert(0, str(ARCFACE_DIR))
from capture_face import largest_face_location as detect_largest_face, crop_face

# ---------------------------------------------------------------------------
# MongoDB setup
# ---------------------------------------------------------------------------

MONGO_URI    = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
MONGO_DBNAME = os.environ.get("MONGO_DBNAME", "classai")

_mongo_client: Optional[AsyncIOMotorClient] = None
_db = None


def get_db():
    return _db


async def connect_mongo():
    global _mongo_client, _db
    try:
        _mongo_client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=3000)
        await _mongo_client.admin.command("ping")
        _db = _mongo_client[MONGO_DBNAME]
        # indexes
        await _db.students.create_index("id", unique=True)
        await _db.students.create_index("rollNumber")
        await _db.students.create_index([("className", ASCENDING), ("section", ASCENDING)])
        await _db.attendance.create_index([("studentId", ASCENDING), ("date", ASCENDING)])
        await _db.attendance.create_index("date")
        await _db.attendance.create_index([("date", DESCENDING), ("markedAt", DESCENDING)])
        print(f"[mongodb] connected to {MONGO_URI} / {MONGO_DBNAME}")
    except Exception as exc:
        print(f"[mongodb] WARNING: could not connect — {exc}. Falling back to JSON files.")
        _mongo_client = None
        _db = None


async def mongo_ok() -> bool:
    return _db is not None


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


def _rel(path_str: str) -> str:
    try:
        return str(Path(path_str).relative_to(BASE_DIR))
    except ValueError:
        return path_str


def _abs(path_str: str) -> Path:
    p = Path(path_str)
    if p.is_absolute():
        return p
    return BASE_DIR / p


def _strip_mongo_id(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# Student storage  (MongoDB primary, JSON fallback)
# ---------------------------------------------------------------------------

async def load_students() -> list:
    if await mongo_ok():
        docs = await _db.students.find({}).to_list(length=None)
        return [_strip_mongo_id(d) for d in docs]
    return _load_students_json()


def _load_students_json() -> list:
    if not STUDENTS_FILE.exists():
        return []
    try:
        with open(STUDENTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("students", [])
    except (json.JSONDecodeError, ValueError):
        return []


async def save_student(student: dict):
    student = dict(student)
    student["sampleImagePaths"] = [_rel(p) for p in student.get("sampleImagePaths", [])]
    if await mongo_ok():
        await _db.students.update_one(
            {"id": student["id"]},
            {"$set": student},
            upsert=True,
        )
    # always keep JSON in sync as backup
    all_students = _load_students_json()
    idx = next((i for i, s in enumerate(all_students) if s["id"] == student["id"]), None)
    if idx is None:
        all_students.append(student)
    else:
        all_students[idx] = student
    _write_students_json(all_students)


def _write_students_json(students: list):
    for s in students:
        s["sampleImagePaths"] = [_rel(p) for p in s.get("sampleImagePaths", [])]
    with open(STUDENTS_FILE, "w", encoding="utf-8") as f:
        json.dump({"students": students}, f, indent=2, ensure_ascii=False)


async def sync_json_to_mongo():
    """On startup, push any JSON-only students into MongoDB."""
    if not await mongo_ok():
        return
    json_students = _load_students_json()
    for s in json_students:
        s["sampleImagePaths"] = [_rel(p) for p in s.get("sampleImagePaths", [])]
        await _db.students.update_one({"id": s["id"]}, {"$set": s}, upsert=True)
    if json_students:
        print(f"[mongodb] synced {len(json_students)} student(s) from JSON to MongoDB")


async def sync_records_to_mongo():
    """On startup, push all JSON attendance records into MongoDB."""
    if not await mongo_ok():
        return
    if not RECORDS_DIR.exists():
        return
    count = 0
    for fp in RECORDS_DIR.glob("attendance_*.json"):
        try:
            with open(fp, encoding="utf-8") as f:
                records = json.load(f)
            for r in records:
                if r.get("id", "").startswith("absent-"):
                    continue  # skip synthetic absent rows
                await _db.attendance.update_one({"id": r["id"]}, {"$set": r}, upsert=True)
                count += 1
        except Exception as exc:
            print(f"[mongodb] error syncing {fp.name}: {exc}")
    if count:
        print(f"[mongodb] synced {count} attendance record(s) from JSON to MongoDB")


# ---------------------------------------------------------------------------
# Attendance record storage  (MongoDB primary, JSON fallback)
# ---------------------------------------------------------------------------

def _records_file(for_date: str) -> Path:
    return RECORDS_DIR / f"attendance_{for_date}.json"


def _load_records_json(for_date: str) -> list:
    fp = _records_file(for_date)
    if not fp.exists():
        return []
    try:
        with open(fp, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return []


def _save_records_json(for_date: str, records: list):
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    with open(_records_file(for_date), "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)


async def _mark_attendance(student: dict) -> bool:
    """Mark student present for today. Returns True if newly marked, False if already present."""
    today = date.today().isoformat()

    if await mongo_ok():
        existing = await _db.attendance.find_one({"studentId": student["id"], "date": today})
        if existing:
            if existing["status"] == "present":
                return False
            await _db.attendance.update_one(
                {"studentId": student["id"], "date": today},
                {"$set": {"status": "present", "markedAt": datetime.utcnow().isoformat() + "Z"}},
            )
            # sync to JSON
            _sync_record_to_json(today, student["id"], "present")
            return True
        record = {
            "id": str(uuid.uuid4()),
            "studentId": student["id"],
            "student": {
                "name": student["name"],
                "rollNumber": student.get("rollNumber", ""),
                "className": student.get("className", ""),
                "section": student.get("section", ""),
                "parentMobile": student.get("parentMobile", ""),
            },
            "date": today,
            "status": "present",
            "markedAt": datetime.utcnow().isoformat() + "Z",
        }
        await _db.attendance.insert_one(record)
        record.pop("_id", None)
        # sync to JSON
        records = _load_records_json(today)
        records.append(record)
        _save_records_json(today, records)
        return True

    # JSON-only fallback
    records = _load_records_json(today)
    existing = next((r for r in records if r["studentId"] == student["id"]), None)
    if existing:
        if existing["status"] == "present":
            return False
        existing["status"] = "present"
        existing["markedAt"] = datetime.utcnow().isoformat() + "Z"
    else:
        records.append({
            "id": str(uuid.uuid4()),
            "studentId": student["id"],
            "student": {
                "name": student["name"],
                "rollNumber": student.get("rollNumber", ""),
                "className": student.get("className", ""),
                "section": student.get("section", ""),
                "parentMobile": student.get("parentMobile", ""),
            },
            "date": today,
            "status": "present",
            "markedAt": datetime.utcnow().isoformat() + "Z",
        })
    _save_records_json(today, records)
    return True


def _sync_record_to_json(for_date: str, student_id: str, status: str):
    records = _load_records_json(for_date)
    rec = next((r for r in records if r["studentId"] == student_id), None)
    if rec:
        rec["status"] = status
        rec["markedAt"] = datetime.utcnow().isoformat() + "Z"
        _save_records_json(for_date, records)


async def _get_records(for_date: str, class_name: Optional[str], section: Optional[str]) -> list:
    if await mongo_ok():
        query: dict = {"date": for_date, "status": "present"}
        if class_name:
            query["student.className"] = re.compile(f"^{re.escape(class_name)}$", re.IGNORECASE)
        if section:
            query["student.section"] = re.compile(f"^{re.escape(section)}$", re.IGNORECASE)
        docs = await _db.attendance.find(query).sort("markedAt", ASCENDING).to_list(length=None)
        return [_strip_mongo_id(d) for d in docs]
    # JSON fallback
    records = _load_records_json(for_date)
    if class_name:
        records = [r for r in records if r.get("student", {}).get("className", "").lower() == class_name.lower()]
    if section:
        records = [r for r in records if r.get("student", {}).get("section", "").lower() == section.lower()]
    return records


async def _get_student_history(student_id: str, limit: int = 30) -> list:
    """Return attendance history for one student, newest first."""
    if await mongo_ok():
        docs = await _db.attendance.find({"studentId": student_id}).sort("date", DESCENDING).limit(limit).to_list(length=None)
        return [_strip_mongo_id(d) for d in docs]
    # JSON fallback: scan all record files
    history = []
    if RECORDS_DIR.exists():
        for fp in sorted(RECORDS_DIR.glob("attendance_*.json"), reverse=True)[:limit]:
            try:
                with open(fp, encoding="utf-8") as f:
                    for r in json.load(f):
                        if r.get("studentId") == student_id:
                            history.append(r)
                            break
            except Exception:
                pass
    return history


async def _get_all_dates_summary() -> list:
    """Return a list of {date, present, absent, total} across all recorded dates."""
    if await mongo_ok():
        pipeline = [
            {"$group": {"_id": "$date", "present": {"$sum": {"$cond": [{"$eq": ["$status", "present"]}, 1, 0]}}}},
            {"$sort": {"_id": DESCENDING}},
            {"$project": {"_id": 0, "date": "$_id", "present": 1}},
        ]
        return await _db.attendance.aggregate(pipeline).to_list(length=None)
    # JSON fallback
    summary = []
    if RECORDS_DIR.exists():
        for fp in sorted(RECORDS_DIR.glob("attendance_*.json"), reverse=True):
            try:
                with open(fp, encoding="utf-8") as f:
                    records = json.load(f)
                dt = fp.stem.replace("attendance_", "")
                present = sum(1 for r in records if r.get("status") == "present")
                summary.append({"date": dt, "present": present})
            except Exception:
                pass
    return summary


# ---------------------------------------------------------------------------
# Face encoding cache
# ---------------------------------------------------------------------------

_enc_lock = threading.Lock()
_fr_lock = threading.Lock()
_known_encodings: list = []
_known_student_ids: list = []
_students_cache: dict = {}


def reload_face_encodings(students: list):
    global _known_encodings, _known_student_ids, _students_cache
    encodings: list = []
    student_ids: list = []
    cache: dict = {}

    for student in students:
        cache[student["id"]] = student
        for img_path_str in student.get("sampleImagePaths", []):
            p = _abs(img_path_str)
            if not p.exists():
                print(f"[encoding] missing file: {p}")
                continue
            try:
                with _fr_lock:
                    image = face_recognition.load_image_file(str(p))
                    h, w = image.shape[:2]
                    found = face_recognition.face_encodings(image)
                    if not found:
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
        _students_cache = cache

    _live_state["encodingCount"] = len(encodings)
    print(f"[encoding] {len(encodings)} encoding(s) for {len(students)} student(s)")


# ---------------------------------------------------------------------------
# Live recognition thread (server-side camera — optional, local only)
# ---------------------------------------------------------------------------

_live_state: dict = {
    "running": False, "recentDetections": [], "encodingCount": 0,
    "cameraOpen": False, "detectionCount": 0,
}
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
    print(f"[live] camera {cam_index} opened")
    consecutive_failures = 0
    try:
        while not stop_event.is_set():
            ok, frame = cam.read()
            if not ok:
                consecutive_failures += 1
                if consecutive_failures > 30:
                    break
                time.sleep(0.1)
                continue
            consecutive_failures = 0

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            with _fr_lock:
                face_locs = face_recognition.face_locations(rgb, number_of_times_to_upsample=1, model="hog")

            preview = frame.copy()
            face_matches: dict = {}

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
                                asyncio.run(_mark_attendance(match_student))

                        face_matches[i] = (match_student, confidence)
                        detection = {
                            "detectedAt": datetime.utcnow().isoformat() + "Z",
                            "confidence": round(confidence, 3),
                            "match": {
                                "name": match_student["name"],
                                "rollNumber": match_student.get("rollNumber", ""),
                                "className": match_student.get("className", ""),
                                "section": match_student.get("section", ""),
                            } if match_student else None,
                        }
                        _live_state["recentDetections"] = (
                            [detection] + _live_state["recentDetections"]
                        )[:20]
                        _live_state["detectionCount"] += 1

            for i, (top, right, bottom, left) in enumerate(face_locs):
                match_student, confidence = face_matches.get(i, (None, 0.0))
                color = (0, 255, 0) if match_student else (0, 0, 255)
                cv2.rectangle(preview, (left, top), (right, bottom), color, 2)
                label = f"{match_student['name']} ({confidence:.0%})" if match_student else "Unknown"
                cv2.rectangle(preview, (left, bottom), (right, bottom + 22), color, cv2.FILLED)
                cv2.putText(preview, label, (left + 4, bottom + 16),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)

            ok_enc, jpeg = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 75])
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
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    DATASET_PATH.mkdir(parents=True, exist_ok=True)
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    await connect_mongo()
    await sync_json_to_mongo()
    await sync_records_to_mongo()
    students = await load_students()
    reload_face_encodings(students)


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "mongo": _db is not None}


@app.get("/attendance/live/stream")
async def live_stream():
    def generate():
        while _live_state.get("running"):
            with _frame_lock:
                frame = _latest_frame
            if frame:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            time.sleep(0.04)
    return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.post("/attendance/students/register")
async def register_student(request: Request):
    body = await request.json()
    name          = (body.get("name") or "").strip()
    roll_number   = (body.get("rollNumber") or "").strip()
    class_name    = (body.get("className") or "").strip()
    section       = (body.get("section") or "").strip()
    parent_mobile = (body.get("parentMobile") or "").strip()
    parent_email  = (body.get("parentEmail") or "").strip()
    images_b64    = body.get("images") or []

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

        with _fr_lock:
            face_location = detect_largest_face(frame)
        if face_location is not None:
            frame = crop_face(frame, face_location)
        else:
            print(f"[register] no face in sample {len(saved_paths)+skipped+1}, saving full frame")

        img_path = next_image_path(safe_name)
        cv2.imwrite(str(img_path), frame)
        saved_paths.append(_rel(str(img_path)))

    if not saved_paths:
        raise HTTPException(status_code=400, detail="No valid images could be decoded")

    # find existing student by name (case-insensitive)
    all_students = await load_students()
    existing = next((s for s in all_students if s["name"].lower() == name.lower()), None)
    if existing:
        existing["sampleImagePaths"] = list(dict.fromkeys(
            [_rel(p) for p in existing["sampleImagePaths"]] + saved_paths
        ))
        existing["rollNumber"]   = roll_number
        existing["className"]    = class_name
        existing["section"]      = section
        existing["parentMobile"] = parent_mobile
        existing["parentEmail"]  = parent_email
    else:
        existing = {
            "id": str(uuid.uuid4()),
            "name": name,
            "rollNumber": roll_number,
            "className": class_name,
            "section": section,
            "parentMobile": parent_mobile,
            "parentEmail": parent_email,
            "sampleImagePaths": saved_paths,
            "registeredAt": datetime.utcnow().isoformat() + "Z",
        }

    await save_student(existing)
    all_students = await load_students()
    reload_face_encodings(all_students)
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


@app.post("/attendance/recognize")
async def recognize_endpoint(request: Request):
    body = await request.json()
    img_data = body.get("image", "")
    if "," in img_data:
        img_data = img_data.split(",", 1)[1]
    try:
        nparr = np.frombuffer(base64.b64decode(img_data), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception:
        return {"result": None}
    if frame is None:
        return {"result": None}

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    h, w = frame.shape[:2]

    with _fr_lock:
        face_locs = face_recognition.face_locations(rgb, number_of_times_to_upsample=1, model="hog")

    if not face_locs:
        return {"result": None}

    top, right, bottom, left = face_locs[0]
    face_box = {"top": top, "right": right, "bottom": bottom, "left": left, "frameWidth": w, "frameHeight": h}

    with _enc_lock:
        known_enc = list(_known_encodings)
        known_ids = list(_known_student_ids)
        students_snap = dict(_students_cache)

    if not known_enc:
        return {"result": {"face": face_box, "match": None, "confidence": 0.0, "alreadyPresent": False}}

    with _fr_lock:
        face_encs = face_recognition.face_encodings(rgb, [face_locs[0]])

    if not face_encs:
        return {"result": {"face": face_box, "match": None, "confidence": 0.0, "alreadyPresent": False}}

    distances = face_recognition.face_distance(known_enc, face_encs[0])
    best_idx = int(np.argmin(distances))
    confidence = float(1.0 - distances[best_idx])
    match_student = None
    already_present = False

    if distances[best_idx] <= FACE_MATCH_TOLERANCE:
        sid = known_ids[best_idx]
        match_student = students_snap.get(sid)
        if match_student:
            newly_marked = await _mark_attendance(match_student)
            already_present = not newly_marked

    detected_at = datetime.utcnow().isoformat() + "Z"
    detection = {
        "detectedAt": detected_at,
        "confidence": round(confidence, 3),
        "match": {
            "name": match_student["name"],
            "rollNumber": match_student.get("rollNumber", ""),
            "className": match_student.get("className", ""),
            "section": match_student.get("section", ""),
        } if match_student else None,
    }
    _live_state["recentDetections"] = ([detection] + _live_state["recentDetections"])[:20]
    _live_state["detectionCount"] = _live_state.get("detectionCount", 0) + 1

    return {"result": {
        "face": face_box,
        "match": detection["match"],
        "confidence": detection["confidence"],
        "detectedAt": detected_at,
        "alreadyPresent": already_present,
    }}


@app.get("/attendance/students")
async def get_students():
    return {"students": await load_students()}


@app.get("/attendance/students/{student_id}/history")
async def get_student_history(student_id: str, limit: int = 60):
    history = await _get_student_history(student_id, limit=limit)
    return {"history": history}


@app.get("/attendance/summary")
async def get_summary():
    summary = await _get_all_dates_summary()
    return {"summary": summary}


@app.post("/attendance/live/start")
async def start_live():
    global _live_thread, _live_stop_event
    if _live_state["running"]:
        return {"live": _live_state}
    students = await load_students()
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
async def reload_encodings_endpoint():
    students = await load_students()
    reload_face_encodings(students)
    return {"encodingCount": _live_state["encodingCount"]}


@app.get("/attendance/records")
async def get_records(
    date: Optional[str] = None,
    className: Optional[str] = None,
    section: Optional[str] = None,
):
    target_date = date or datetime.now().date().isoformat()
    present_records = await _get_records(target_date, className, section)
    present_ids = {r["studentId"] for r in present_records}

    # Add absent rows for registered students not yet present
    all_students = await load_students()
    for student in all_students:
        if student["id"] in present_ids:
            continue
        if className and student.get("className", "").lower() != className.lower():
            continue
        if section and student.get("section", "").lower() != section.lower():
            continue
        present_records.append({
            "id": f"absent-{student['id']}-{target_date}",
            "studentId": student["id"],
            "student": {
                "name": student["name"],
                "rollNumber": student.get("rollNumber", ""),
                "className": student.get("className", ""),
                "section": student.get("section", ""),
            },
            "date": target_date,
            "status": "absent",
        })

    return {"records": present_records}


@app.post("/attendance/records/manual")
async def manual_attendance(request: Request):
    body = await request.json()
    student_id  = body.get("studentId")
    target_date = body.get("date") or datetime.now().date().isoformat()
    status      = body.get("status", "present")

    all_students = await load_students()
    student = next((s for s in all_students if s["id"] == student_id), None)
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    if await mongo_ok():
        existing = await _db.attendance.find_one({"studentId": student_id, "date": target_date})
        if existing:
            await _db.attendance.update_one(
                {"studentId": student_id, "date": target_date},
                {"$set": {"status": status, "markedAt": datetime.utcnow().isoformat() + "Z"}},
            )
            existing["status"] = status
            existing["markedAt"] = datetime.utcnow().isoformat() + "Z"
            _strip_mongo_id(existing)
        else:
            existing = {
                "id": str(uuid.uuid4()),
                "studentId": student_id,
                "student": {
                    "name": student["name"],
                    "rollNumber": student.get("rollNumber", ""),
                    "className": student.get("className", ""),
                    "section": student.get("section", ""),
                },
                "date": target_date,
                "status": status,
                "markedAt": datetime.utcnow().isoformat() + "Z",
            }
            await _db.attendance.insert_one(existing)
            existing.pop("_id", None)
        # sync to JSON
        _sync_record_to_json(target_date, student_id, status)
        return {"record": existing}

    # JSON-only fallback
    records = _load_records_json(target_date)
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
                "rollNumber": student.get("rollNumber", ""),
                "className": student.get("className", ""),
                "section": student.get("section", ""),
            },
            "date": target_date,
            "status": status,
            "markedAt": datetime.utcnow().isoformat() + "Z",
        }
        records.append(existing)
    _save_records_json(target_date, records)
    return {"record": existing}


@app.patch("/attendance/records/{record_id}")
async def update_record(record_id: str, request: Request):
    body = await request.json()
    target_date = body.get("date") or datetime.now().date().isoformat()
    status = body.get("status")

    if await mongo_ok() and status:
        result = await _db.attendance.find_one_and_update(
            {"id": record_id},
            {"$set": {"status": status, "markedAt": datetime.utcnow().isoformat() + "Z"}},
            return_document=True,
        )
        if result:
            _strip_mongo_id(result)
            _sync_record_to_json(target_date, result["studentId"], status)
            return {"record": result}

    # JSON fallback
    records = _load_records_json(target_date)
    record = next((r for r in records if r["id"] == record_id), None)
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
    if status:
        record["status"] = status
        record["markedAt"] = datetime.utcnow().isoformat() + "Z"
    _save_records_json(target_date, records)
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

    uvicorn.run(app, host=args.host, port=args.port)
