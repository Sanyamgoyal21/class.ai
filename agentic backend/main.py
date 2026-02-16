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
    # Run as classroom device (default)
    python main.py --mode classroom --name "Classroom 1" --url http://localhost:5000

    # Run as gate camera
    python main.py --mode gate --name "Main Gate" --url http://localhost:5000

    # Run with all features disabled except streaming
    python main.py --mode classroom --no-face --no-vad
"""

import argparse
import sys


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


def main():
    parser = argparse.ArgumentParser(
        description="Agentic Backend - Classroom/Gate Device Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --mode classroom --name "Room 101"
  python main.py --mode gate --name "Main Entrance"
  python main.py --mode classroom --no-face --no-vad  # Streaming only
        """
    )

    # Mode selection
    parser.add_argument(
        "--mode", "-m",
        choices=["classroom", "gate"],
        default="classroom",
        help="Device mode: 'classroom' or 'gate' (default: classroom)"
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
        if args.mode == "classroom":
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
