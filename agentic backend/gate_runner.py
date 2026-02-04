"""
Gate Camera Runner - Face recognition with Supernode integration.
Runs face recognition and sends attendance events to the Supernode.
"""

import os
import sys
import time
import threading
import cv2
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from face_module.recognize_faces import FaceRecognizer
from device_client import GateCameraClient
from database import attendence_db as adb

class GateCameraRunner:
    """Runs gate camera face recognition with Supernode connectivity."""

    def __init__(
        self,
        supernode_url="http://localhost:5000",
        device_name="Main Gate",
        camera_index=0,
        display=True,
        known_dir="face_module/data/faces",
    ):
        self.supernode_url = supernode_url
        self.device_name = device_name
        self.camera_index = camera_index
        self.display = display
        self.known_dir = known_dir

        self._running = False
        self._client = None
        self._recognizer = None
        self._marked_local = set()  # Track locally marked attendance

    def _on_command(self, data):
        """Handle control commands from Supernode."""
        action = data.get("action")

        if action == "reload-faces":
            print("[Gate] Reloading face database...")
            if hasattr(self._recognizer, "_train_lbph"):
                self._recognizer._train_lbph()
            return {"reloaded": True}

        elif action == "clear-marked":
            self._marked_local.clear()
            self._recognizer.marked.clear()
            return {"cleared": True}

        elif action == "get-marked":
            return {"marked": list(self._marked_local)}

        return {"unknown_action": action}

    def start(self):
        """Start the gate camera runner."""
        print(f"[Gate] Starting {self.device_name}...")

        # Initialize Supernode client
        self._client = GateCameraClient(
            supernode_url=self.supernode_url,
            device_name=self.device_name,
            on_command=self._on_command,
        )

        # Connect to Supernode (non-blocking)
        connected = self._client.connect()
        if connected:
            print(f"[Gate] Connected to Supernode at {self.supernode_url}")
        else:
            print("[Gate] Running in offline mode (will retry connection)")

        # Initialize face recognizer (without its own attendance marking)
        self._recognizer = FaceRecognizer(
            known_dir=self.known_dir,
            camera_index=self.camera_index,
            display=self.display,
        )

        # Override the recognizer's attendance marking to use our client
        original_marked = self._recognizer.marked

        self._running = True
        self._run_loop()

    def _run_loop(self):
        """Main loop - runs face recognition and emits attendance."""
        cap = cv2.VideoCapture(self.camera_index)

        if not cap.isOpened():
            print(f"[Gate] Failed to open camera {self.camera_index}")
            return

        print("[Gate] Camera opened, starting recognition...")

        while self._running:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.01)
                continue

            # Run face detection (reuse recognizer logic)
            faces_info = self._detect_faces(frame)

            # Process detected faces
            for face in faces_info:
                name = face.get("name")
                if name and name != "Unknown" and name not in self._marked_local:
                    confidence = face.get("confidence", 1.0)

                    # Mark attendance locally (CSV fallback)
                    adb.mark_attendance(name)
                    print(f"[Gate] {name} marked present at {datetime.now().isoformat()}")
                    self._marked_local.add(name)

                    # Send to Supernode
                    if self._client and self._client.is_connected():
                        # Encode current frame as JPEG for snapshot
                        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                        self._client.emit_attendance(
                            student_name=name,
                            confidence=confidence,
                            image_snapshot=jpeg.tobytes(),
                        )

            # Display if enabled
            if self.display:
                # Draw face boxes
                for face in faces_info:
                    bbox = face.get("bbox")
                    name = face.get("name", "Unknown")
                    if bbox:
                        top, right, bottom, left = bbox
                        color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)
                        cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
                        cv2.putText(frame, name, (left, top - 10),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)

                cv2.imshow(f"Gate - {self.device_name}", frame)
                key = cv2.waitKey(1)
                if key == 27:  # ESC
                    break
                elif key == ord('r'):
                    print("[Gate] Reloading faces...")
                    if hasattr(self._recognizer, "_train_lbph"):
                        self._recognizer._train_lbph()

            # Small delay to prevent CPU overload
            time.sleep(0.01)

        cap.release()
        if self.display:
            cv2.destroyAllWindows()

    def _detect_faces(self, frame):
        """Detect and recognize faces in frame."""
        faces_info = []

        if self._recognizer.use_fr:
            import face_recognition
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            locations = face_recognition.face_locations(rgb)
            encodings = face_recognition.face_encodings(rgb, locations)

            for enc, loc in zip(encodings, locations):
                matches = face_recognition.compare_faces(
                    self._recognizer.known_encodings, enc
                )
                name = "Unknown"
                confidence = 0.0

                if True in matches:
                    idx = matches.index(True)
                    name = self._recognizer.known_names[idx]
                    # Calculate confidence based on face distance
                    distances = face_recognition.face_distance(
                        self._recognizer.known_encodings, enc
                    )
                    confidence = 1.0 - min(distances)

                top, right, bottom, left = loc
                faces_info.append({
                    "name": name,
                    "bbox": loc,
                    "confidence": confidence,
                    "area": (right - left) * (bottom - top),
                })
        else:
            # LBPH fallback
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self._recognizer.detector.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=4
            )

            for (x, y, w, h) in faces:
                roi = gray[y:y+h, x:x+w]
                try:
                    roi_resized = cv2.resize(roi, (200, 200))
                except Exception:
                    continue

                name = "Unknown"
                confidence = 0.0

                if self._recognizer.recognizer is not None:
                    try:
                        label, conf = self._recognizer.recognizer.predict(roi_resized)
                        # Lower confidence = better match for LBPH
                        if conf <= self._recognizer.lbph_confidence_thresh:
                            if label in self._recognizer.label2name:
                                name = self._recognizer.label2name[label]
                                confidence = 1.0 - (conf / 100.0)
                    except Exception:
                        pass

                bbox = (y, x + w, y + h, x)  # top, right, bottom, left
                faces_info.append({
                    "name": name,
                    "bbox": bbox,
                    "confidence": confidence,
                    "area": w * h,
                })

        return faces_info

    def stop(self):
        """Stop the runner."""
        self._running = False
        if self._client:
            self._client.disconnect()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Gate Camera Runner")
    parser.add_argument("--url", default="http://localhost:5000", help="Supernode URL")
    parser.add_argument("--name", default="Main Gate", help="Device name")
    parser.add_argument("--camera", type=int, default=0, help="Camera index")
    parser.add_argument("--no-display", action="store_true", help="Disable display")
    parser.add_argument("--faces-dir", default="face_module/data/faces", help="Known faces directory")

    args = parser.parse_args()

    runner = GateCameraRunner(
        supernode_url=args.url,
        device_name=args.name,
        camera_index=args.camera,
        display=not args.no_display,
        known_dir=args.faces_dir,
    )

    try:
        runner.start()
    except KeyboardInterrupt:
        print("\n[Gate] Shutting down...")
        runner.stop()
