from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

from config import (
    ATTENDANCE_EVENT_DEVICE_ID,
    ATTENDANCE_EVENT_DEVICE_NAME,
    SUPERNODE_URL,
)
from device_client import DeviceClient


class AttendanceEventRelay:
    """Pushes attendance events from the FastAPI service to the supernode socket layer."""

    def __init__(
        self,
        supernode_url: str = SUPERNODE_URL,
        device_name: str = ATTENDANCE_EVENT_DEVICE_NAME,
        device_id: str = ATTENDANCE_EVENT_DEVICE_ID,
    ) -> None:
        self.client = DeviceClient(
            supernode_url=supernode_url,
            device_type="attendance",
            device_name=device_name,
            device_id=device_id,
            capabilities=["camera", "attendance", "face_recognition"],
        )
        self._connect_lock = threading.Lock()
        self._connect_attempted = False

    def ensure_connected(self) -> bool:
        if self.client.is_connected():
            return True

        with self._connect_lock:
            if self.client.is_connected():
                return True
            if not self._connect_attempted:
                self._connect_attempted = True
            try:
                return bool(self.client.connect())
            except Exception:
                return False

    def emit_live_status(self, live: dict[str, Any]) -> None:
        if not self.ensure_connected():
            return
        self.client.sio.emit(
            "attendance:service-status",
            {
                "live": live,
                "timestamp": datetime.utcnow().isoformat(),
            },
        )

    def emit_detection(self, payload: dict[str, Any]) -> None:
        if not self.ensure_connected():
            return
        self.client.sio.emit(
            "attendance:live-update",
            {
                "type": "detection",
                "payload": payload,
                "timestamp": datetime.utcnow().isoformat(),
            },
        )

    def emit_student_registered(self, student: dict[str, Any]) -> None:
        if not self.ensure_connected():
            return
        self.client.sio.emit(
            "attendance:student-registered",
            {
                "student": student,
                "timestamp": datetime.utcnow().isoformat(),
            },
        )

    def emit_attendance_record(self, record: dict[str, Any]) -> None:
        if not self.ensure_connected():
            return
        student = record.get("student") or {}
        self.client.emit_attendance(
            student_name=student.get("name", "Unknown"),
            confidence=record.get("confidence") or 1.0,
            roll=student.get("rollNumber"),
        )
        self.client.sio.emit(
            "attendance:live-update",
            {
                "type": "attendance_marked",
                "payload": record,
                "timestamp": datetime.utcnow().isoformat(),
            },
        )

    def disconnect(self) -> None:
        try:
            self.client.disconnect()
        except Exception:
            pass
