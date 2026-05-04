#!/usr/bin/env python3
"""
Agentic Backend - Main Entry Point

This is the main entry point for running classroom or gate devices.
It connects to the Supernode (Node.js backend) and handles:
- Face recognition
- Voice activity detection (VAD)
- Speech-to-text
- Doubt resolution with AI
- Camera/Display streaming

Usage:
    # Run the FastAPI control plane (default)
    python main.py

    # Run as classroom device
    python main.py --mode classroom --name "Classroom 1" --url http://localhost:5000

    # Run as gate camera
    python main.py --mode gate --name "Main Gate" --url http://localhost:5000

    # Run with all features disabled except streaming
    python main.py --mode classroom --no-face --no-vad
"""

import argparse
import os
import subprocess
import sys

from config import ATTENDANCE_SERVICE_PORT


def _normalize_path(value: str) -> str:
    return os.path.normcase(os.path.abspath(value))


def _preferred_python_candidates() -> list[str]:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(base_dir, ".venv", "Scripts", "python.exe"),
        os.path.join(os.path.dirname(base_dir), ".venv", "Scripts", "python.exe"),
    ]
    return [candidate for candidate in candidates if os.path.exists(candidate)]


def ensure_preferred_python() -> None:
    """Re-exec under the repo venv if the script was launched with a different Python."""
    if os.environ.get("CLASS_AI_SKIP_REEXEC") == "1":
        return

    current = _normalize_path(sys.executable)
    for candidate in _preferred_python_candidates():
        normalized_candidate = _normalize_path(candidate)
        if normalized_candidate == current:
            return

        env = os.environ.copy()
        env["CLASS_AI_SKIP_REEXEC"] = "1"
        print(f"Switching to project Python: {candidate}", flush=True)
        raise SystemExit(subprocess.call([candidate, *sys.argv], env=env))


def run_classroom(args):
    """Run the classroom device."""
    from classroom_runner import ClassroomRunner

    runner = ClassroomRunner(
        supernode_url=args.url,
        classroom_name=args.name,
        camera_index=args.camera,
        display=not args.no_display,
        enable_face=not args.no_face,
        enable_vad=not args.no_vad,
        enable_aec=not args.no_aec,
        stream_camera=not args.no_camera_stream,
        stream_display=not args.no_display_stream,
        known_dir=args.faces_dir,
    )

    print("=" * 50)
    print(f"  CLASSROOM: {args.name}")
    print(f"  Supernode: {args.url}")
    print(f"  Camera: {args.camera}")
    print("=" * 50)

    runner.start()


def run_gate(args):
    """Run the gate camera device."""
    from gate_runner import GateCameraRunner

    runner = GateCameraRunner(
        supernode_url=args.url,
        device_name=args.name,
        camera_index=args.camera,
        display=not args.no_display,
        known_dir=args.faces_dir,
    )

    print("=" * 50)
    print(f"  GATE CAMERA: {args.name}")
    print(f"  Supernode: {args.url}")
    print(f"  Camera: {args.camera}")
    print("=" * 50)

    runner.start()


def run_api(args):
    import uvicorn

    print("=" * 50)
    print("  AGENTIC BACKEND API")
    print(f"  Host: {args.host}")
    print(f"  Port: {args.port}")
    print("=" * 50)

    uvicorn.run("attendance_api:app", host=args.host, port=args.port, reload=args.reload)


def main():
    ensure_preferred_python()

    parser = argparse.ArgumentParser(
        description="Agentic Backend - FastAPI + Device Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py
  python main.py --mode api --port 8000
  python main.py --mode classroom --name "Room 101"
  python main.py --mode gate --name "Main Entrance"
  python main.py --mode classroom --no-face --no-vad  # Streaming only
        """
    )

    # Mode selection
    parser.add_argument(
        "--mode", "-m",
        choices=["api", "classroom", "gate"],
        default="api",
        help="Run mode: 'api', 'classroom', or 'gate' (default: api)"
    )

    # Connection settings
    parser.add_argument(
        "--url", "-u",
        default="http://localhost:5000",
        help="Supernode URL (default: http://localhost:5000)"
    )
    parser.add_argument(
        "--name", "-n",
        default=None,
        help="Device name (default: 'Classroom 1' or 'Gate Camera')"
    )

    # Camera settings
    parser.add_argument(
        "--camera", "-c",
        type=int,
        default=0,
        help="Camera index (default: 0)"
    )
    parser.add_argument(
        "--faces-dir",
        default="face_module/data/faces",
        help="Directory containing known faces"
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="FastAPI host when --mode api (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=ATTENDANCE_SERVICE_PORT,
        help=f"FastAPI port when --mode api (default: {ATTENDANCE_SERVICE_PORT})"
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable FastAPI auto-reload in api mode"
    )

    # Feature toggles
    parser.add_argument(
        "--no-display",
        action="store_true",
        help="Disable local display window"
    )
    parser.add_argument(
        "--no-face",
        action="store_true",
        help="Disable face recognition"
    )
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="Disable voice activity detection"
    )
    parser.add_argument(
        "--no-aec",
        action="store_true",
        help="Disable acoustic echo cancellation"
    )
    parser.add_argument(
        "--no-camera-stream",
        action="store_true",
        help="Disable camera streaming to supernode"
    )
    parser.add_argument(
        "--no-display-stream",
        action="store_true",
        help="Disable display/screen streaming to supernode"
    )

    args = parser.parse_args()

    # Set default name based on mode
    if args.name is None:
        args.name = "Classroom 1" if args.mode == "classroom" else "Gate Camera"

    # Run the appropriate mode
    try:
        if args.mode == "api":
            run_api(args)
        elif args.mode == "classroom":
            run_classroom(args)
        elif args.mode == "gate":
            run_gate(args)
    except KeyboardInterrupt:
        print("\nShutting down...")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
