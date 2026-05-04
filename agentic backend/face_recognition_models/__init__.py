from __future__ import annotations

from pathlib import Path

__author__ = "Adam Geitgey"
__email__ = "ageitgey@gmail.com"
__version__ = "0.3.0-local"


def _candidate_model_dirs() -> list[Path]:
    base_dir = Path(__file__).resolve().parent
    agentic_backend_dir = base_dir.parent
    repo_root = agentic_backend_dir.parent

    return [
        base_dir / "models",
        repo_root / ".venv" / "Lib" / "site-packages" / "face_recognition_models" / "models",
        Path.home() / "AppData" / "Local" / "Programs" / "Python" / "Python310" / "Lib" / "site-packages" / "face_recognition_models" / "models",
    ]


def _model_path(filename: str) -> str:
    for directory in _candidate_model_dirs():
        candidate = directory / filename
        if candidate.exists():
            return str(candidate)
    searched = ", ".join(str(path) for path in _candidate_model_dirs())
    raise FileNotFoundError(
        f"Could not locate face recognition model '{filename}'. Searched: {searched}"
    )


def pose_predictor_model_location() -> str:
    return _model_path("shape_predictor_68_face_landmarks.dat")


def pose_predictor_five_point_model_location() -> str:
    return _model_path("shape_predictor_5_face_landmarks.dat")


def face_recognition_model_location() -> str:
    return _model_path("dlib_face_recognition_resnet_model_v1.dat")


def cnn_face_detector_model_location() -> str:
    return _model_path("mmod_human_face_detector.dat")
