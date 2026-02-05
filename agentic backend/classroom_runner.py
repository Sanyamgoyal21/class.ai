"""
Classroom Device Runner - Face recognition + VAD with Supernode integration.
Runs face recognition, voice activity detection, and sends events to the Supernode.
"""

import os
import sys
import time
import threading
import cv2
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import warnings
# Suppress setuptools' pkg_resources deprecation warning originating from
# third-party packages (e.g. face_recognition_models) until upstream is fixed.
warnings.filterwarnings("ignore", message="pkg_resources is deprecated as an API.*", category=UserWarning)

from device_client import ClassroomClient
from database import talking_db as tdb

# Optional imports
try:
    from face_module.recognize_faces import FaceRecognizer
    HAS_FACE_RECOGNITION = True
except ImportError:
    HAS_FACE_RECOGNITION = False
    print("[Classroom] Face recognition not available")

try:
    from audio_module.vad import VADDetector
    HAS_VAD = True
except ImportError:
    HAS_VAD = False
    print("[Classroom] VAD not available")

try:
    from audio_module.stt import SpeechToText
    HAS_STT = True
except ImportError:
    HAS_STT = False
    print("[Classroom] Speech-to-Text not available")

try:
    from doubt_assistant import DoubtAssistant
    HAS_DOUBT_ASSISTANT = True
except ImportError:
    HAS_DOUBT_ASSISTANT = False
    print("[Classroom] Doubt Assistant not available")

try:
    from ai_module.local_ollama import LocalOllama
    HAS_LOCAL_OLLAMA = True
except ImportError:
    HAS_LOCAL_OLLAMA = False
    print("[Classroom] Local Ollama not available")


class ClassroomRunner:
    """Runs classroom device with face recognition, VAD, and Supernode connectivity."""

    def __init__(
        self,
        supernode_url="http://localhost:5000",
        classroom_name="Classroom 1",
        camera_index=0,
        display=True,
        known_dir="face_module/data/faces",
        enable_face=True,
        enable_vad=True,
        stream_camera=True,
        stream_interval=0.5,  # seconds between camera frames
    ):
        self.supernode_url = supernode_url
        self.classroom_name = classroom_name
        self.camera_index = camera_index
        self.display = display
        self.known_dir = known_dir
        self.enable_face = enable_face and HAS_FACE_RECOGNITION
        self.enable_vad = enable_vad and HAS_VAD
        self.stream_camera = stream_camera
        self.stream_interval = stream_interval

        self._running = False
        self._client = None
        self._recognizer = None
        self._vad = None
        self._stt = None  # Speech-to-Text
        self._local_ollama = None  # Local AI for doubt resolution
        self._doubt_assistant = None  # Doubt mode state machine
        self._current_faces = []  # Currently visible faces
        self._last_stream_time = 0
        self._display_content = None  # Current content to display

    def _on_command(self, data):
        """Handle control commands from Supernode."""
        action = data.get("action")

        if action == "start-camera":
            self.stream_camera = True
            return {"streaming": True}

        elif action == "stop-camera":
            self.stream_camera = False
            return {"streaming": False}

        elif action == "reload-faces":
            if self._recognizer and hasattr(self._recognizer, "_train_lbph"):
                self._recognizer._train_lbph()
            return {"reloaded": True}

        elif action == "display-content":
            self._display_content = data.get("params", {}).get("content")
            return {"displayed": True}

        elif action == "get-presence":
            return {"faces": self._current_faces}

        return {"unknown_action": action}

    def _on_broadcast(self, data):
        """Handle broadcast messages."""
        content = data.get("content", "")
        msg_type = data.get("type", "announcement")
        priority = data.get("priority", "normal")

        print(f"[Classroom] {msg_type.upper()}: {content}")
        self._display_content = {
            "type": msg_type,
            "content": content,
            "priority": priority,
            "timestamp": datetime.now().isoformat(),
        }

    def _on_ai_response(self, data):
        """Handle AI responses."""
        response = data.get("response", "")
        source = data.get("source", "unknown")

        print(f"[Classroom] AI ({source}): {response[:100]}...")
        self._display_content = {
            "type": "ai_response",
            "content": response,
            "source": source,
            "timestamp": datetime.now().isoformat(),
        }

    def _on_emergency(self, data):
        """Handle emergency alerts."""
        message = data.get("message", "EMERGENCY")
        from_admin = data.get("from", "Admin")

        print(f"[Classroom] !!! EMERGENCY ALERT from {from_admin}: {message} !!!")
        self._display_content = {
            "type": "emergency",
            "content": message,
            "from": from_admin,
            "priority": "critical",
            "timestamp": datetime.now().isoformat(),
        }

    def _on_doubt_state_change(self, state, data):
        """Called when doubt assistant state changes."""
        if state == "DOUBT_MODE":
            print(f"[Classroom] Entered DOUBT MODE (speaker: {data.get('speaker', 'Unknown')})")
            self._display_content = {
                "type": "doubt_mode",
                "content": "Listening for your question...",
                "speaker": data.get("speaker"),
                "timestamp": datetime.now().isoformat(),
            }
        else:
            print("[Classroom] Exited DOUBT MODE, resuming video")
            self._display_content = None

    def _on_doubt_processed(self, doubt_text, speaker):
        """Called when a doubt question is processed."""
        print(f"[Classroom] Doubt from {speaker}: {doubt_text}")
        self._display_content = {
            "type": "doubt_question",
            "content": doubt_text,
            "speaker": speaker,
            "timestamp": datetime.now().isoformat(),
        }

    def _on_speech_segment(self, start_time, end_time, audio_data=None):
        """Called when VAD detects a speech segment."""
        duration = (end_time - start_time).total_seconds()

        # Try to associate with a visible face
        speaker = "Unknown"
        if self._current_faces:
            # Pick the face with largest area (closest to camera)
            largest = max(self._current_faces, key=lambda f: f.get("area", 0))
            speaker = largest.get("name", "Unknown")

        # Log locally
        tdb.log_speech(speaker, start_time, duration)
        print(f"[Classroom] Speech: {speaker} ({duration:.1f}s)")

        # Process through doubt assistant if STT and doubt assistant are available
        if self._stt and self._doubt_assistant and audio_data:
            # Transcribe the audio
            transcript = self._stt.transcribe(audio_data)
            if transcript:
                print(f"[Classroom] Transcript: '{transcript}'")
                # Process through doubt assistant state machine
                result = self._doubt_assistant.on_speech_transcript(transcript, speaker)
                print(f"[Classroom] Doubt Assistant: {result.get('action', 'no_action')}")

    def start(self):
        """Start the classroom runner."""
        print(f"[Classroom] Starting {self.classroom_name}...")

        # Initialize Supernode client
        self._client = ClassroomClient(
            supernode_url=self.supernode_url,
            classroom_name=self.classroom_name,
            on_command=self._on_command,
            on_broadcast=self._on_broadcast,
            on_ai_response=self._on_ai_response,
            on_emergency=self._on_emergency,
        )

        # Connect to Supernode
        connected = self._client.connect()
        if connected:
            print(f"[Classroom] Connected to Supernode at {self.supernode_url}")
        else:
            print("[Classroom] Running in offline mode")

        # Initialize face recognizer
        if self.enable_face:
            self._recognizer = FaceRecognizer(
                known_dir=self.known_dir,
                camera_index=self.camera_index,
                display=False,  # We'll handle display ourselves
            )
            print("[Classroom] Face recognition initialized")

        # Initialize Speech-to-Text (Whisper)
        if HAS_STT:
            print("[Classroom] Loading Speech-to-Text model...")
            self._stt = SpeechToText(model_name="base", language="en")
            if self._stt.is_available():
                print("[Classroom] Speech-to-Text initialized")
            else:
                print("[Classroom] Speech-to-Text failed to initialize")
                self._stt = None

        # Initialize Local Ollama for doubt resolution
        if HAS_LOCAL_OLLAMA:
            print("[Classroom] Initializing Local Ollama...")
            self._local_ollama = LocalOllama()
            if self._local_ollama.check_health(force=True):
                print(f"[Classroom] Local Ollama initialized (model: {self._local_ollama.model})")
            else:
                print("[Classroom] Local Ollama not available, will use supernode fallback")
                self._local_ollama = None

        # Initialize Doubt Assistant
        if HAS_DOUBT_ASSISTANT and self._client:
            self._doubt_assistant = DoubtAssistant(
                client=self._client,
                local_ollama=self._local_ollama,  # Pass local Ollama for local AI inference
                on_state_change=self._on_doubt_state_change,
                on_doubt_processed=self._on_doubt_processed,
            )
            print("[Classroom] Doubt Assistant initialized")

        # Initialize VAD (with audio buffering for STT)
        if self.enable_vad:
            self._vad = VADDetector(
                on_segment=self._on_speech_segment,
                aggressiveness=2,
                buffer_audio=True,  # Enable audio buffering for STT
            )
            self._vad.start()
            print("[Classroom] Voice activity detection started")

        self._running = True
        self._run_loop()

    def _run_loop(self):
        """Main loop - face recognition and camera streaming."""
        cap = None
        if self.enable_face or self.stream_camera:
            cap = cv2.VideoCapture(self.camera_index)
            if not cap.isOpened():
                print(f"[Classroom] Failed to open camera {self.camera_index}")
                cap = None

        print("[Classroom] Main loop started")
        presence_update_interval = 2.0  # Send presence updates every 2 seconds
        last_presence_update = 0

        while self._running:
            frame = None

            if cap:
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.01)
                    continue

            # Face detection
            if frame is not None and self.enable_face:
                faces_info = self._detect_faces(frame)
                self._current_faces = faces_info

                # Send presence update periodically
                now = time.time()
                if now - last_presence_update > presence_update_interval:
                    if self._client and self._client.is_connected():
                        # Format faces for transmission
                        faces_data = [
                            {
                                "name": f.get("name"),
                                "confidence": f.get("confidence", 1.0),
                                "position": {
                                    "x": f.get("center", (0, 0))[0],
                                    "y": f.get("center", (0, 0))[1],
                                },
                            }
                            for f in faces_info
                        ]
                        self._client.emit_presence(faces_data)
                    last_presence_update = now

            # Stream camera frame
            if frame is not None and self.stream_camera:
                now = time.time()
                if now - self._last_stream_time > self.stream_interval:
                    if self._client and self._client.is_connected():
                        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                        self._client.emit_camera_frame(jpeg.tobytes())
                    self._last_stream_time = now

            # Display
            if frame is not None and self.display:
                display_frame = frame.copy()

                # Draw face boxes
                if self._current_faces:
                    for face in self._current_faces:
                        bbox = face.get("bbox")
                        name = face.get("name", "Unknown")
                        if bbox:
                            top, right, bottom, left = bbox
                            color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)
                            cv2.rectangle(display_frame, (left, top), (right, bottom), color, 2)
                            cv2.putText(display_frame, name, (left, top - 10),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

                # Draw display content overlay
                if self._display_content:
                    content = self._display_content
                    if isinstance(content, dict):
                        text = content.get("content", "")[:50]
                        msg_type = content.get("type", "info")
                    else:
                        text = str(content)[:50]
                        msg_type = "info"

                    # Draw overlay at bottom
                    overlay_h = 60
                    cv2.rectangle(display_frame, (0, frame.shape[0] - overlay_h),
                                  (frame.shape[1], frame.shape[0]), (0, 0, 0), -1)
                    cv2.putText(display_frame, f"[{msg_type}] {text}",
                                (10, frame.shape[0] - 20),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)

                cv2.imshow(f"Classroom - {self.classroom_name}", display_frame)
                key = cv2.waitKey(1)
                if key == 27:  # ESC
                    break
                elif key == ord('r'):
                    if self._recognizer and hasattr(self._recognizer, "_train_lbph"):
                        print("[Classroom] Reloading faces...")
                        self._recognizer._train_lbph()
                elif key == ord('q'):
                    # Test AI query
                    if self._client and self._client.is_connected():
                        self._client.emit_ai_query("What is photosynthesis?", speaker="Test")

            time.sleep(0.01)

        if cap:
            cap.release()
        if self.display:
            cv2.destroyAllWindows()

    def _detect_faces(self, frame):
        """Detect and recognize faces in frame."""
        if not self._recognizer:
            return []

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
                    distances = face_recognition.face_distance(
                        self._recognizer.known_encodings, enc
                    )
                    confidence = 1.0 - min(distances)

                top, right, bottom, left = loc
                center = ((left + right) // 2, (top + bottom) // 2)
                faces_info.append({
                    "name": name,
                    "bbox": loc,
                    "confidence": confidence,
                    "area": (right - left) * (bottom - top),
                    "center": center,
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
                        if conf <= self._recognizer.lbph_confidence_thresh:
                            if label in self._recognizer.label2name:
                                name = self._recognizer.label2name[label]
                                confidence = 1.0 - (conf / 100.0)
                    except Exception:
                        pass

                bbox = (y, x + w, y + h, x)
                center = (x + w // 2, y + h // 2)
                faces_info.append({
                    "name": name,
                    "bbox": bbox,
                    "confidence": confidence,
                    "area": w * h,
                    "center": center,
                })

        return faces_info

    def stop(self):
        """Stop the runner."""
        self._running = False
        if self._vad:
            self._vad.running = False
        if self._client:
            self._client.disconnect()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Classroom Device Runner")
    parser.add_argument("--url", default="http://localhost:5000", help="Supernode URL")
    parser.add_argument("--name", default="Classroom 1", help="Classroom name")
    parser.add_argument("--camera", type=int, default=0, help="Camera index")
    parser.add_argument("--no-display", action="store_true", help="Disable display")
    parser.add_argument("--no-face", action="store_true", help="Disable face recognition")
    parser.add_argument("--no-vad", action="store_true", help="Disable VAD")
    parser.add_argument("--no-stream", action="store_true", help="Disable camera streaming")
    parser.add_argument("--faces-dir", default="face_module/data/faces", help="Known faces directory")

    args = parser.parse_args()

    runner = ClassroomRunner(
        supernode_url=args.url,
        classroom_name=args.name,
        camera_index=args.camera,
        display=not args.no_display,
        enable_face=not args.no_face,
        enable_vad=not args.no_vad,
        stream_camera=not args.no_stream,
        known_dir=args.faces_dir,
    )

    try:
        runner.start()
    except KeyboardInterrupt:
        print("\n[Classroom] Shutting down...")
        runner.stop()
