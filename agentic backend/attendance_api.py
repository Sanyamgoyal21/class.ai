from __future__ import annotations

import threading
from typing import Any

import base64

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from attendance_events import AttendanceEventRelay
from attendance_face_core import AttendanceFaceService
from attendance_repository import AttendanceRepository
from config import ATTENDANCE_CAMERA_INDEX, ATTENDANCE_DATASET_DIR, ATTENDANCE_SERVICE_PORT, SUPERNODE_URL


class RunnerPayload(BaseModel):
    name: str | None = None
    url: str = SUPERNODE_URL
    camera: int = ATTENDANCE_CAMERA_INDEX
    no_display: bool = False
    no_face: bool = False
    no_vad: bool = False
    no_aec: bool = False
    no_camera_stream: bool = False
    no_display_stream: bool = False
    faces_dir: str = ATTENDANCE_DATASET_DIR


class ManualAttendancePayload(BaseModel):
    studentId: str
    date: str
    status: str = Field(pattern="^(present|absent)$")


class AttendanceRecordPatchPayload(BaseModel):
    status: str | None = Field(default=None, pattern="^(present|absent)$")
    markedBy: str | None = None
    source: str | None = None
    confidence: float | None = None


class RegisterStudentJsonPayload(BaseModel):
    name: str
    rollNumber: str
    className: str
    section: str
    images: list[str]


class RunnerController:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runners: dict[str, dict[str, Any]] = {}

    def start(self, kind: str, payload: RunnerPayload) -> dict[str, Any]:
        with self._lock:
            existing = self._runners.get(kind)
            if existing and existing["thread"].is_alive():
                return {
                    "running": True,
                    "kind": kind,
                    "name": existing["name"],
                }

            stop_event = threading.Event()
            if kind == "classroom":
                target = self._run_classroom
                name = payload.name or "Classroom 1"
            elif kind == "gate":
                target = self._run_gate
                name = payload.name or "Gate Camera"
            else:
                raise ValueError(f"Unsupported runner kind: {kind}")

            thread = threading.Thread(
                target=target,
                args=(payload, stop_event),
                daemon=True,
                name=f"{kind}-runner",
            )
            self._runners[kind] = {
                "thread": thread,
                "stop_event": stop_event,
                "name": name,
                "config": payload.model_dump(),
            }
            thread.start()
            return {"running": True, "kind": kind, "name": name}

    def stop(self, kind: str) -> dict[str, Any]:
        with self._lock:
            state = self._runners.get(kind)
            if not state:
                return {"running": False, "kind": kind}
            stop_event = state["stop_event"]
            thread = state["thread"]
            stop_event.set()

        if thread.is_alive():
            thread.join(timeout=5)

        with self._lock:
            self._runners.pop(kind, None)
        return {"running": False, "kind": kind}

    def status(self) -> dict[str, Any]:
        with self._lock:
            payload: dict[str, Any] = {}
            for kind, state in self._runners.items():
                payload[kind] = {
                    "running": state["thread"].is_alive(),
                    "name": state["name"],
                    "config": state["config"],
                }
            return payload

    @staticmethod
    def _run_classroom(payload: RunnerPayload, stop_event: threading.Event) -> None:
        from classroom_runner import ClassroomRunner

        runner = ClassroomRunner(
            supernode_url=payload.url,
            classroom_name=payload.name or "Classroom 1",
            camera_index=payload.camera,
            display=not payload.no_display,
            enable_face=not payload.no_face,
            enable_vad=not payload.no_vad,
            enable_aec=not payload.no_aec,
            stream_camera=not payload.no_camera_stream,
            stream_display=not payload.no_display_stream,
            known_dir=payload.faces_dir,
        )

        thread = threading.Thread(target=runner.start, daemon=True, name="classroom-worker")
        thread.start()
        while thread.is_alive() and not stop_event.is_set():
            stop_event.wait(0.5)
        if stop_event.is_set():
            runner.stop()
        thread.join(timeout=5)

    @staticmethod
    def _run_gate(payload: RunnerPayload, stop_event: threading.Event) -> None:
        from gate_runner import GateCameraRunner

        runner = GateCameraRunner(
            supernode_url=payload.url,
            device_name=payload.name or "Gate Camera",
            camera_index=payload.camera,
            display=not payload.no_display,
            known_dir=payload.faces_dir or ATTENDANCE_DATASET_DIR,
        )

        thread = threading.Thread(target=runner.start, daemon=True, name="gate-worker")
        thread.start()
        while thread.is_alive() and not stop_event.is_set():
            stop_event.wait(0.5)
        if stop_event.is_set():
            runner.stop()
        thread.join(timeout=5)


repository = AttendanceRepository()
event_relay = AttendanceEventRelay()
face_service = AttendanceFaceService(repository=repository, event_relay=event_relay)
runner_controller = RunnerController()

app = FastAPI(title="Attendance Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    body = await request.body()
    print("[attendance-api] incoming request", request.method, request.url.path)
    print("[attendance-api] headers", {k: v for k, v in request.headers.items() if k.lower() != 'authorization'})
    print("[attendance-api] body_size", len(body))
    response = await call_next(request)
    print("[attendance-api] response", response.status_code, request.method, request.url.path)
    return response


def _error_response(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


def _decode_base64_image(value: str) -> bytes:
    encoded = value.split(",", 1)[1] if "," in value else value
    return base64.b64decode(encoded)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "agentic-backend",
        "live": face_service.get_live_status(),
        "runners": runner_controller.status(),
    }


@app.post("/attendance/students/register")
async def register_student(
    request: Request,
    name: str | None = Form(default=None),
    rollNumber: str | None = Form(default=None),
    className: str | None = Form(default=None),
    section: str | None = Form(default=None),
    images: list[UploadFile] | None = File(default=None),
) -> dict[str, Any]:
    try:
        if request.headers.get("content-type", "").startswith("application/json"):
            payload = RegisterStudentJsonPayload.model_validate(await request.json())
            image_payloads = [_decode_base64_image(item) for item in payload.images]
            print("[attendance-api] register_student called", {
                "name": payload.name,
                "rollNumber": payload.rollNumber,
                "className": payload.className,
                "section": payload.section,
                "images": len(payload.images),
                "content_type": request.headers.get("content-type"),
            })
            student = face_service.register_student(
                payload.name,
                payload.rollNumber,
                payload.className,
                payload.section,
                image_payloads,
            )
        else:
            image_payloads = [await image.read() for image in (images or []) if image.filename]
            print("[attendance-api] register_student called", {
                "name": name,
                "rollNumber": rollNumber,
                "className": className,
                "section": section,
                "images": len(image_payloads),
                "content_type": request.headers.get("content-type"),
            })
            student = face_service.register_student(
                name or "",
                rollNumber or "",
                className or "",
                section or "",
                image_payloads,
            )
        return {"success": True, "student": student}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.get("/attendance/students")
def list_students() -> dict[str, Any]:
    return {"success": True, "students": repository.list_students()}


@app.post("/attendance/live/start")
def start_live_attendance() -> dict[str, Any]:
    try:
        return {"success": True, "live": face_service.start_live_attendance()}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.post("/attendance/live/stop")
def stop_live_attendance() -> dict[str, Any]:
    return {"success": True, "live": face_service.stop_live_attendance()}


@app.get("/attendance/live/status")
def live_status() -> dict[str, Any]:
    return {"success": True, "live": face_service.get_live_status()}


@app.get("/attendance/records")
def list_records(date: str | None = None, className: str | None = None, section: str | None = None) -> dict[str, Any]:
    try:
        records = repository.list_records(date_value=date, class_name=className, section=section)
        return {"success": True, "records": records}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.post("/attendance/records/manual")
def manual_record(payload: ManualAttendancePayload) -> dict[str, Any]:
    try:
        record = repository.upsert_manual_attendance(payload.studentId, payload.date, payload.status)
        return {"success": True, "record": record}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.patch("/attendance/records/{record_id}")
def patch_record(record_id: str, payload: AttendanceRecordPatchPayload) -> dict[str, Any]:
    try:
        record = repository.update_record(record_id, payload.model_dump(exclude_unset=True))
        return {"success": True, "record": record}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.post("/system/runners/classroom/start")
def start_classroom_runner(payload: RunnerPayload) -> dict[str, Any]:
    try:
        return {"success": True, "runner": runner_controller.start("classroom", payload)}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.post("/system/runners/classroom/stop")
def stop_classroom_runner() -> dict[str, Any]:
    return {"success": True, "runner": runner_controller.stop("classroom")}


@app.post("/system/runners/gate/start")
def start_gate_runner(payload: RunnerPayload) -> dict[str, Any]:
    try:
        return {"success": True, "runner": runner_controller.start("gate", payload)}
    except Exception as exc:
        raise _error_response(exc) from exc


@app.post("/system/runners/gate/stop")
def stop_gate_runner() -> dict[str, Any]:
    return {"success": True, "runner": runner_controller.stop("gate")}


@app.get("/system/runners/status")
def runner_status() -> dict[str, Any]:
    return {"success": True, "runners": runner_controller.status()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=ATTENDANCE_SERVICE_PORT)