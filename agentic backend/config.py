import os
from pathlib import Path


def _load_env_files() -> None:
    base_dir = Path(__file__).resolve().parent
    repo_root = base_dir.parent
    candidates = [
        base_dir / ".env",
        repo_root / ".env",
        repo_root / "backend" / ".env",
    ]

    for candidate in candidates:
        if candidate.exists():
            for raw_line in candidate.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value


_load_env_files()

# MongoDB configuration
MONGO_URI = os.getenv("MONGO_URI", "")  # set to e.g. "mongodb://localhost:27017"
USE_MONGO = bool(MONGO_URI)
DB_NAME = os.getenv("MONGO_DBNAME", "attendance_system")
FACES_COLLECTION = os.getenv("FACES_COLLECTION", "faces")
ATT_COLLECTION = os.getenv("ATT_COLLECTION", "attendance")
TALK_COLLECTION = os.getenv("TALK_COLLECTION", "talks")
STUDENTS_COLLECTION = os.getenv("STUDENTS_COLLECTION", "students")
ATTENDANCE_RECORDS_COLLECTION = os.getenv("ATTENDANCE_RECORDS_COLLECTION", "attendance_records")

# Face recognizer settings
LBPH_CONFIDENCE_THRESHOLD = int(os.getenv("LBPH_CONFIDENCE_THRESHOLD", "70"))

# Attendance service configuration
ATTENDANCE_SERVICE_PORT = int(os.getenv("ATTENDANCE_SERVICE_PORT", "8000"))
ATTENDANCE_CAMERA_INDEX = int(os.getenv("ATTENDANCE_CAMERA_INDEX", "0"))
ATTENDANCE_DATASET_DIR = os.getenv(
    "ATTENDANCE_DATASET_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "attendance_dataset"),
)
SUPERNODE_URL = os.getenv("SUPERNODE_URL", "http://localhost:5000")
ATTENDANCE_EVENT_DEVICE_NAME = os.getenv("ATTENDANCE_EVENT_DEVICE_NAME", "Attendance Camera")
ATTENDANCE_EVENT_DEVICE_ID = os.getenv("ATTENDANCE_EVENT_DEVICE_ID", "attendance-camera")
