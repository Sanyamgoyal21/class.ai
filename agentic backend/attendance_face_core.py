from __future__ import annotations

import os
import re
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from attendance_repository import AttendanceRepository
from attendance_events import AttendanceEventRelay
from config import ATTENDANCE_CAMERA_INDEX, ATTENDANCE_DATASET_DIR

try:
    import face_recognition
except Exception as exc:  # pragma: no cover - import failure is surfaced at runtime
    face_recognition = None
    FACE_IMPORT_ERROR = exc
else:
    FACE_IMPORT_ERROR = None


FACE_MATCH_TOLERANCE = 0.55
FRONTAL_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
PROFILE_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
LEGACY_DATASET_DIR = str(Path(__file__).resolve().parent / "Attendance Sytem by Face Recognition" / "dataset")


def ensure_face_runtime():
    if face_recognition is None:
        raise RuntimeError(
            f"face_recognition is required for attendance features: {FACE_IMPORT_ERROR}"
        )


def safe_name(value: str) -> str:
    value = value.strip()
    value = re.sub(r'[<>:"/\\|?*]', "_", value)
    value = re.sub(r"\s+", " ", value)
    return value


def clamp_location(top: int, right: int, bottom: int, left: int, height: int, width: int) -> tuple[int, int, int, int]:
    return (
        max(top, 0),
        min(right, width),
        min(bottom, height),
        max(left, 0),
    )


def location_iou(first: tuple[int, int, int, int], second: tuple[int, int, int, int]) -> float:
    top1, right1, bottom1, left1 = first
    top2, right2, bottom2, left2 = second

    inter_left = max(left1, left2)
    inter_top = max(top1, top2)
    inter_right = min(right1, right2)
    inter_bottom = min(bottom1, bottom2)

    if inter_right <= inter_left or inter_bottom <= inter_top:
        return 0.0

    intersection = (inter_right - inter_left) * (inter_bottom - inter_top)
    first_area = (right1 - left1) * (bottom1 - top1)
    second_area = (right2 - left2) * (bottom2 - top2)
    return intersection / float(first_area + second_area - intersection)


def add_location(locations: list[tuple[int, int, int, int]], location: tuple[int, int, int, int], min_iou: float = 0.35) -> None:
    if all(location_iou(location, existing) < min_iou for existing in locations):
        locations.append(location)


def cascade_locations(gray_frame: np.ndarray, cascade: cv2.CascadeClassifier, flipped: bool = False) -> list[tuple[int, int, int, int]]:
    height, width = gray_frame.shape[:2]
    source = cv2.flip(gray_frame, 1) if flipped else gray_frame
    detections = cascade.detectMultiScale(source, scaleFactor=1.08, minNeighbors=4, minSize=(45, 45))
    locations: list[tuple[int, int, int, int]] = []

    for x, y, w, h in detections:
        if flipped:
            left = width - (x + w)
            right = width - x
        else:
            left = x
            right = x + w

        locations.append(clamp_location(y, right, y + h, left, height, width))

    return locations


def detect_face_locations(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    ensure_face_runtime()
    height, width = frame.shape[:2]
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray_frame = cv2.equalizeHist(gray_frame)
    locations: list[tuple[int, int, int, int]] = []

    for location in face_recognition.face_locations(rgb_frame, number_of_times_to_upsample=1, model="hog"):
        add_location(locations, clamp_location(*location, height, width))

    for location in cascade_locations(gray_frame, FRONTAL_FACE_CASCADE):
        add_location(locations, location)

    for location in cascade_locations(gray_frame, PROFILE_FACE_CASCADE):
        add_location(locations, location)

    for location in cascade_locations(gray_frame, PROFILE_FACE_CASCADE, flipped=True):
        add_location(locations, location)

    return locations


def largest_face_location(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    face_locations = detect_face_locations(frame)
    if not face_locations:
        return None
    return max(face_locations, key=lambda location: (location[2] - location[0]) * (location[1] - location[3]))


def crop_face(frame: np.ndarray, face_location: tuple[int, int, int, int], padding: int = 35) -> np.ndarray:
    top, right, bottom, left = face_location
    height, width = frame.shape[:2]

    top = max(top - padding, 0)
    right = min(right + padding, width)
    bottom = min(bottom + padding, height)
    left = max(left - padding, 0)

    return frame[top:bottom, left:right]


def next_legacy_image_path(dataset_dir: str, name: str) -> str:
    first_path = os.path.join(dataset_dir, f"{name}.jpg")
    if not os.path.exists(first_path):
        return first_path

    index = 2
    while True:
        image_path = os.path.join(dataset_dir, f"{name}_{index}.jpg")
        if not os.path.exists(image_path):
            return image_path
        index += 1


def decode_image_bytes(file_bytes: bytes) -> np.ndarray:
    buffer = np.frombuffer(file_bytes, dtype=np.uint8)
    frame = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Could not decode uploaded image.")
    return frame


class AttendanceFaceService:
    def __init__(
        self,
        repository: AttendanceRepository | None = None,
        dataset_dir: str = ATTENDANCE_DATASET_DIR,
        camera_index: int = ATTENDANCE_CAMERA_INDEX,
        event_relay: AttendanceEventRelay | None = None,
    ) -> None:
        ensure_face_runtime()
        self.repository = repository or AttendanceRepository()
        self.dataset_dir = dataset_dir
        self.camera_index = camera_index
        self.event_relay = event_relay
        self.legacy_dataset_dir = LEGACY_DATASET_DIR
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._running = False
        self._last_error: str | None = None
        self._recent_detections: deque[dict[str, Any]] = deque(maxlen=25)
        self._active_students_seen: dict[str, float] = {}
        self._confirm_counts: defaultdict[str, int] = defaultdict(int)
        self._known_encodings: list[np.ndarray] = []
        self._known_student_ids: list[str] = []
        os.makedirs(self.dataset_dir, exist_ok=True)
        os.makedirs(self.legacy_dataset_dir, exist_ok=True)

    def register_student(
        self,
        name: str,
        roll_number: str,
        class_name: str,
        section: str,
        image_payloads: list[bytes],
    ) -> dict[str, Any]:
        if not image_payloads:
            raise ValueError("At least one face image is required.")

        safe_student_name = safe_name(name)
        student_dir = os.path.join(self.dataset_dir, safe_student_name)
        processed_faces: list[np.ndarray] = []
        try:
            for image_bytes in image_payloads:
                frame = decode_image_bytes(image_bytes)
                face_location = largest_face_location(frame)
                if face_location is None:
                    raise ValueError("No face detected in one of the uploaded samples.")
                processed_faces.append(crop_face(frame, face_location))
        except Exception:
            raise

        student = self.repository.create_student(name, roll_number, class_name, section)
        os.makedirs(student_dir, exist_ok=True)

        saved_paths: list[str] = []
        legacy_saved_paths: list[str] = []
        try:
            for index, face_image in enumerate(processed_faces, start=1):
                absolute_path = os.path.join(student_dir, f"sample_{index}.jpg")
                if not cv2.imwrite(absolute_path, face_image):
                    raise ValueError(f"Could not save sample {index}.")
                saved_paths.append(absolute_path)

                legacy_path = next_legacy_image_path(self.legacy_dataset_dir, safe_student_name)
                if not cv2.imwrite(legacy_path, face_image):
                    raise ValueError(f"Could not save legacy sample {index}.")
                legacy_saved_paths.append(legacy_path)
        except Exception:
            self._remove_student_artifacts(name, saved_paths, legacy_saved_paths)
            self.repository.delete_student(student["id"])
            raise

        student = self.repository.update_student_samples(student["id"], saved_paths)
        self.reload_known_faces()
        if self.event_relay:
            self.event_relay.emit_student_registered(student)
            self.event_relay.emit_live_status(self.get_live_status())
        return student

    def _remove_student_artifacts(self, student_name: str, saved_paths: list[str], legacy_saved_paths: list[str] | None = None) -> None:
        try:
            student_dir = os.path.join(self.dataset_dir, safe_name(student_name))
            for sample_path in saved_paths:
                if os.path.exists(sample_path):
                    os.remove(sample_path)
            for sample_path in legacy_saved_paths or []:
                if os.path.exists(sample_path):
                    os.remove(sample_path)
            if os.path.isdir(student_dir) and not os.listdir(student_dir):
                os.rmdir(student_dir)
        except Exception:
            pass

    def reload_known_faces(self) -> int:
        encodings: list[np.ndarray] = []
        student_ids: list[str] = []
        for student in self.repository.iter_training_students():
            for image_path in student.get("sampleImagePaths", []):
                if not os.path.exists(image_path):
                    continue
                image = face_recognition.load_image_file(image_path)
                known_locations = [(0, image.shape[1], image.shape[0], 0)]
                known_encodings = face_recognition.face_encodings(image, known_face_locations=known_locations)
                if known_encodings:
                    encodings.append(known_encodings[0])
                    student_ids.append(str(student["_id"]))

        with self._lock:
            self._known_encodings = encodings
            self._known_student_ids = student_ids
        if self.event_relay:
            self.event_relay.emit_live_status(self.get_live_status())
        return len(student_ids)

    def start_live_attendance(self) -> dict[str, Any]:
        with self._lock:
            if self._running:
                return self.get_live_status()
            self.reload_known_faces()
            self._stop_event.clear()
            self._last_error = None
            self._recent_detections.clear()
            self._active_students_seen.clear()
            self._confirm_counts.clear()
            self._thread = threading.Thread(target=self._run_live_loop, daemon=True)
            self._running = True
            self._thread.start()
        status = self.get_live_status()
        if self.event_relay:
            self.event_relay.emit_live_status(status)
        return status

    def stop_live_attendance(self) -> dict[str, Any]:
        self._stop_event.set()
        thread = None
        with self._lock:
            thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=3)
        with self._lock:
            self._running = False
            self._thread = None
        status = self.get_live_status()
        if self.event_relay:
            self.event_relay.emit_live_status(status)
        return status

    def get_live_status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self._running,
                "cameraIndex": self.camera_index,
                "knownFaces": len(self._known_student_ids),
                "lastError": self._last_error,
                "recentDetections": list(self._recent_detections),
            }

    def _append_detection(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self._recent_detections.appendleft(payload)
        if self.event_relay:
            self.event_relay.emit_detection(payload)

    def _run_live_loop(self) -> None:
        capture = cv2.VideoCapture(self.camera_index)
        if not capture.isOpened():
            with self._lock:
                self._last_error = "Could not open camera."
                self._running = False
            if self.event_relay:
                self.event_relay.emit_live_status(self.get_live_status())
            return

        try:
            while not self._stop_event.is_set():
                success, frame = capture.read()
                if not success:
                    time.sleep(0.1)
                    continue
                self._recognize_frame(frame)
                time.sleep(0.05)
        except Exception as exc:
            with self._lock:
                self._last_error = str(exc)
        finally:
            capture.release()
            with self._lock:
                self._running = False
            if self.event_relay:
                self.event_relay.emit_live_status(self.get_live_status())

    def _recognize_frame(self, frame: np.ndarray) -> None:
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face_locations = detect_face_locations(frame)

        with self._lock:
            known_encodings = list(self._known_encodings)
            known_student_ids = list(self._known_student_ids)

        seen_student_ids: set[str] = set()
        for top, right, bottom, left in face_locations:
            encodings = face_recognition.face_encodings(rgb_frame, [(top, right, bottom, left)], num_jitters=1)
            if not encodings:
                continue

            payload = {
                "detectedAt": datetime.utcnow().isoformat(),
                "match": None,
                "confidence": None,
                "bbox": {"top": top, "right": right, "bottom": bottom, "left": left},
            }

            if known_encodings:
                face_distances = face_recognition.face_distance(known_encodings, encodings[0])
                best_match_index = int(np.argmin(face_distances))
                best_distance = float(face_distances[best_match_index])
                if best_distance <= FACE_MATCH_TOLERANCE:
                    student_id = known_student_ids[best_match_index]
                    seen_student_ids.add(student_id)
                    self._confirm_counts[student_id] += 1
                    confidence = round(1.0 - best_distance, 4)
                    payload["match"] = self.repository.get_student(student_id)
                    payload["confidence"] = confidence

                    if self._confirm_counts[student_id] >= 3:
                        last_seen = self._active_students_seen.get(student_id, 0.0)
                        now = time.time()
                        if now - last_seen >= 30:
                            record = self.repository.mark_present(student_id, confidence=confidence)
                            self._active_students_seen[student_id] = now
                            payload["attendanceRecord"] = record
                            if self.event_relay:
                                self.event_relay.emit_attendance_record(record)
                else:
                    payload["match"] = None
            self._append_detection(payload)

        for student_id in list(self._confirm_counts.keys()):
            if student_id not in seen_student_ids:
                self._confirm_counts[student_id] = 0
