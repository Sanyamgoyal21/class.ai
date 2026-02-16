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
from contextlib import contextmanager

# Optional screen capture
HAS_SCREEN_CAPTURE = False
try:
    import mss
    import numpy as np
    HAS_SCREEN_CAPTURE = True
    print("[Classroom] Screen capture (mss) available")
except ImportError as e:
    print(f"[Classroom] Screen capture not available - install 'mss': {e}")

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Optional imports with availability flags
HAS_FACE_RECOGNITION = False
HAS_VAD = False
HAS_STT = False
HAS_DOUBT_ASSISTANT = False
HAS_LOCAL_OLLAMA = False
HAS_DEVICE_CLIENT = False
HAS_DATABASE = False

try:
    from device_client import ClassroomClient
    HAS_DEVICE_CLIENT = True
except ImportError:
    print("[Classroom] Device client not available - running in standalone mode")

try:
    from database import talking_db as tdb
    HAS_DATABASE = True
except ImportError:
    print("[Classroom] Database not available - speech logging disabled")

try:
    from face_module.recognize_faces import FaceRecognizer
    HAS_FACE_RECOGNITION = True
except ImportError:
    print("[Classroom] Face recognition not available")

try:
    from audio_module.vad import VADDetector
    HAS_VAD = True
except ImportError:
    print("[Classroom] VAD not available")

try:
    from audio_module.stt import SpeechToText
    HAS_STT = True
except ImportError:
    print("[Classroom] Speech-to-Text not available")

try:
    from doubt_assistant import DoubtAssistant
    HAS_DOUBT_ASSISTANT = True
except ImportError:
    print("[Classroom] Doubt Assistant not available")

try:
    from ai_module.local_ollama import LocalOllama
    HAS_LOCAL_OLLAMA = True
except ImportError:
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
        enable_aec=True,
        stream_camera=True,
        stream_display=True,
        stream_interval=0.5,
        display_stream_interval=1.0,
    ):
        self.supernode_url = supernode_url
        self.classroom_name = classroom_name
        self.camera_index = camera_index
        self.display = display
        self.known_dir = known_dir
        self.enable_face = enable_face and HAS_FACE_RECOGNITION
        self.enable_vad = enable_vad and HAS_VAD
        self.enable_aec = enable_aec
        self.stream_camera = stream_camera
        self.stream_display = stream_display and HAS_SCREEN_CAPTURE
        self.stream_interval = stream_interval
        self.display_stream_interval = display_stream_interval

        self._running = False
        self._client = None
        self._recognizer = None
        self._vad = None
        self._stt = None
        self._local_ollama = None
        self._doubt_assistant = None
        self._last_stream_time = 0
        self._last_display_stream_time = 0
        self._screen_capture = None

        # Thread-safe state with locks
        self._lock = threading.RLock()
        self._current_faces = []
        self._display_content = None

    @property
    def current_faces(self):
        """Thread-safe getter for current faces."""
        with self._lock:
            return self._current_faces.copy()

    @current_faces.setter
    def current_faces(self, value):
        """Thread-safe setter for current faces."""
        with self._lock:
            self._current_faces = value

    @property
    def display_content(self):
        """Thread-safe getter for display content."""
        with self._lock:
            return self._display_content

    @display_content.setter
    def display_content(self, value):
        """Thread-safe setter for display content."""
        with self._lock:
            self._display_content = value

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
                try:
                    self._recognizer._train_lbph()
                    return {"reloaded": True}
                except Exception as e:
                    return {"reloaded": False, "error": str(e)}
            return {"reloaded": False, "error": "No recognizer available"}

        elif action == "display-content":
            self.display_content = data.get("params", {}).get("content")
            return {"displayed": True}

        elif action == "get-presence":
            return {"faces": self.current_faces}

        return {"unknown_action": action}

    def _on_broadcast(self, data):
        """Handle broadcast messages."""
        content = data.get("content", "")
        msg_type = data.get("type", "announcement")
        priority = data.get("priority", "normal")

        print(f"[Classroom] {msg_type.upper()}: {content}")
        self.display_content = {
            "type": msg_type,
            "content": content,
            "priority": priority,
            "timestamp": datetime.now().isoformat(),
        }

    def _on_ai_response(self, data):
        """Handle AI responses."""
        response = data.get("response", "")
        source = data.get("source", "unknown")
        speaker = data.get("speaker", "Student")
        question = data.get("question", "")

        print(f"[Classroom] AI ({source}): {response[:100]}...")
        self.display_content = {
            "type": "ai_response",
            "content": response,
            "source": source,
            "speaker": speaker,
            "question": question,
            "timestamp": datetime.now().isoformat(),
        }
        # Auto-clear AI response after 30 seconds
        threading.Timer(30.0, self._clear_ai_response).start()

    def _clear_ai_response(self):
        """Clear AI response from display after timeout."""
        current = self.display_content
        if current and isinstance(current, dict) and current.get("type") == "ai_response":
            self.display_content = None

    def _on_emergency(self, data):
        """Handle emergency alerts and stop signals."""
        action = data.get("action")

        # Handle emergency stop
        if action == "stop":
            print("[Classroom] Emergency alert stopped")
            # Clear emergency display if current display is emergency type
            current = self.display_content
            if current and isinstance(current, dict) and current.get("type") == "emergency":
                self.display_content = None
            return

        message = data.get("message", "EMERGENCY")
        from_admin = data.get("from", "Admin")

        print(f"[Classroom] !!! EMERGENCY ALERT from {from_admin}: {message} !!!")
        self.display_content = {
            "type": "emergency",
            "content": message,
            "from": from_admin,
            "priority": "critical",
            "timestamp": datetime.now().isoformat(),
        }

    def _on_doubt_state_change(self, state, data):
        """Called when doubt assistant state changes."""
        if state == "DOUBT_MODE":
            speaker = data.get("speaker", "Unknown") if data else "Unknown"
            print(f"[Classroom] Entered DOUBT MODE (speaker: {speaker})")
            self.display_content = {
                "type": "doubt_mode",
                "content": "Listening for your question...",
                "speaker": speaker,
                "timestamp": datetime.now().isoformat(),
            }
        else:
            print("[Classroom] Exited DOUBT MODE, resuming video")
            self.display_content = None

    def _on_doubt_processed(self, doubt_text, speaker):
        """Called when a doubt question is processed."""
        print(f"[Classroom] Doubt from {speaker}: {doubt_text}")
        self.display_content = {
            "type": "doubt_question",
            "content": doubt_text,
            "speaker": speaker,
            "timestamp": datetime.now().isoformat(),
        }

    def _on_speech_segment(self, start_time, end_time, audio_data=None):
        """Called when VAD detects a speech segment."""
        try:
            duration = (end_time - start_time).total_seconds()

            # Try to associate with a visible face
            speaker = "Unknown"
            faces = self.current_faces
            if faces:
                largest = max(faces, key=lambda f: f.get("area", 0))
                speaker = largest.get("name", "Unknown")

            # Log locally if database available
            if HAS_DATABASE:
                try:
                    tdb.log_speech(speaker, start_time, duration)
                except Exception as e:
                    print(f"[Classroom] Failed to log speech: {e}")

            print(f"[Classroom] Speech: {speaker} ({duration:.1f}s)")

            # Process through doubt assistant if STT and doubt assistant are available
            if self._stt and self._doubt_assistant and audio_data is not None:
                try:
                    transcript = self._stt.transcribe(audio_data)
                    if transcript:
                        print(f"[Classroom] Transcript: '{transcript}'")
                        result = self._doubt_assistant.on_speech_transcript(transcript, speaker)
                        print(f"[Classroom] Doubt Assistant: {result.get('action', 'no_action')}")
                except Exception as e:
                    print(f"[Classroom] STT/Doubt processing error: {e}")

        except Exception as e:
            print(f"[Classroom] Speech segment handler error: {e}")

    def _init_client(self):
        """Initialize Supernode client."""
        if not HAS_DEVICE_CLIENT:
            print("[Classroom] Device client not available - skipping")
            return False

        try:
            self._client = ClassroomClient(
                supernode_url=self.supernode_url,
                classroom_name=self.classroom_name,
                on_command=self._on_command,
                on_broadcast=self._on_broadcast,
                on_ai_response=self._on_ai_response,
                on_emergency=self._on_emergency,
            )
            connected = self._client.connect()
            if connected:
                print(f"[Classroom] Connected to Supernode at {self.supernode_url}")
                return True
            else:
                print("[Classroom] Failed to connect - running in offline mode")
                return False
        except Exception as e:
            print(f"[Classroom] Client initialization error: {e}")
            return False

    def _init_face_recognizer(self):
        """Initialize face recognizer."""
        if not self.enable_face:
            return False

        try:
            self._recognizer = FaceRecognizer(
                known_dir=self.known_dir,
                camera_index=self.camera_index,
                display=False,
            )
            print("[Classroom] Face recognition initialized")
            return True
        except Exception as e:
            print(f"[Classroom] Face recognition init error: {e}")
            self._recognizer = None
            return False

    def _init_stt(self):
        """Initialize Speech-to-Text."""
        if not HAS_STT:
            return False

        try:
            print("[Classroom] Loading Speech-to-Text model...")
            self._stt = SpeechToText(model_name="base", language="en")
            if self._stt.is_available():
                print("[Classroom] Speech-to-Text initialized")
                return True
            else:
                print("[Classroom] Speech-to-Text failed to initialize")
                self._stt = None
                return False
        except Exception as e:
            print(f"[Classroom] STT init error: {e}")
            self._stt = None
            return False

    def _init_local_ollama(self):
        """Initialize Local Ollama."""
        if not HAS_LOCAL_OLLAMA:
            return False

        try:
            print("[Classroom] Initializing Local Ollama...")
            self._local_ollama = LocalOllama()
            if self._local_ollama.check_health(force=True):
                print(f"[Classroom] Local Ollama initialized (model: {self._local_ollama.model})")
                return True
            else:
                print("[Classroom] Local Ollama not available, will use supernode fallback")
                self._local_ollama = None
                return False
        except Exception as e:
            print(f"[Classroom] Ollama init error: {e}")
            self._local_ollama = None
            return False

    def _init_doubt_assistant(self):
        """Initialize Doubt Assistant."""
        if not HAS_DOUBT_ASSISTANT:
            return False

        if not self._client:
            print("[Classroom] Doubt Assistant requires client - skipping")
            return False

        try:
            self._doubt_assistant = DoubtAssistant(
                client=self._client,
                local_ollama=self._local_ollama,
                on_state_change=self._on_doubt_state_change,
                on_doubt_processed=self._on_doubt_processed,
            )
            print("[Classroom] Doubt Assistant initialized")
            return True
        except Exception as e:
            print(f"[Classroom] Doubt Assistant init error: {e}")
            self._doubt_assistant = None
            return False

    def _init_vad(self):
        """Initialize Voice Activity Detection."""
        if not self.enable_vad:
            return False

        try:
            self._vad = VADDetector(
                on_segment=self._on_speech_segment,
                aggressiveness=2,
                buffer_audio=True,
                enable_aec=self.enable_aec,
            )
            self._vad.start()
            aec_status = "with AEC" if self.enable_aec else "without AEC"
            print(f"[Classroom] Voice activity detection started ({aec_status})")
            return True
        except Exception as e:
            print(f"[Classroom] VAD init error: {e}")
            self._vad = None
            return False

    def start(self):
        """Start the classroom runner."""
        print(f"[Classroom] Starting {self.classroom_name}...")
        print(f"[Classroom] Camera streaming: {self.stream_camera}")
        print(f"[Classroom] Display streaming: {self.stream_display} (mss available: {HAS_SCREEN_CAPTURE})")

        # Initialize components
        self._init_client()
        self._init_face_recognizer()
        self._init_stt()
        self._init_local_ollama()
        self._init_doubt_assistant()
        self._init_vad()

        self._running = True

        try:
            self._run_loop()
        except KeyboardInterrupt:
            print("\n[Classroom] Interrupted by user")
        except Exception as e:
            print(f"[Classroom] Main loop error: {e}")
        finally:
            self.stop()

    def _run_loop(self):
        """Main loop - face recognition and camera streaming."""
        cap = None
        if self.enable_face or self.stream_camera:
            cap = cv2.VideoCapture(self.camera_index)
            if not cap.isOpened():
                print(f"[Classroom] Failed to open camera {self.camera_index}")
                cap = None

        print("[Classroom] Main loop started")
        print("[Classroom] Press ESC to quit, 'r' to reload faces, 'q' to test AI query")

        presence_update_interval = 2.0
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
                try:
                    faces_info = self._detect_faces(frame)
                    self.current_faces = faces_info

                    # Send presence update periodically
                    now = time.time()
                    if now - last_presence_update > presence_update_interval:
                        if self._client and self._client.is_connected():
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
                except Exception as e:
                    print(f"[Classroom] Face detection error: {e}")

            # Stream camera frame
            if frame is not None and self.stream_camera:
                now = time.time()
                if now - self._last_stream_time > self.stream_interval:
                    if self._client and self._client.is_connected():
                        try:
                            _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                            self._client.emit_camera_frame(jpeg.tobytes())
                        except Exception as e:
                            print(f"[Classroom] Frame streaming error: {e}")
                    self._last_stream_time = now

            # Stream display/screen frame (runs independently of camera)
            if self.stream_display and HAS_SCREEN_CAPTURE:
                now = time.time()
                if now - self._last_display_stream_time > self.display_stream_interval:
                    if self._client and self._client.is_connected():
                        try:
                            display_frame = self._capture_screen()
                            if display_frame is not None:
                                _, jpeg = cv2.imencode(".jpg", display_frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
                                self._client.emit_display_frame(jpeg.tobytes())
                        except Exception as e:
                            print(f"[Classroom] Display streaming error: {e}")
                    self._last_display_stream_time = now

            # Display
            if frame is not None and self.display:
                self._render_display(frame)
                key = cv2.waitKey(1) & 0xFF
                if key == 27:  # ESC
                    break
                elif key == ord('r'):
                    self._handle_reload_faces()
                elif key == ord('q'):
                    self._handle_test_query()

            time.sleep(0.01)

        # Cleanup
        if cap:
            cap.release()
        if self.display:
            cv2.destroyAllWindows()

    def _render_display(self, frame):
        """Render the display with overlays."""
        display_frame = frame.copy()

        # Draw face boxes
        faces = self.current_faces
        for face in faces:
            bbox = face.get("bbox")
            name = face.get("name", "Unknown")
            if bbox:
                top, right, bottom, left = bbox
                color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)
                cv2.rectangle(display_frame, (left, top), (right, bottom), color, 2)
                cv2.putText(
                    display_frame, name, (left, top - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2
                )

        # Draw display content overlay
        content = self.display_content
        if content:
            if isinstance(content, dict):
                text = str(content.get("content", ""))
                msg_type = content.get("type", "info")
                priority = content.get("priority", "normal")
            else:
                text = str(content)
                msg_type = "info"
                priority = "normal"

            # Determine colors based on type
            if msg_type == "emergency":
                bg_color = (0, 0, 180)  # Dark red
                text_color = (255, 255, 255)
                overlay_h = 100
            elif msg_type == "ai_response":
                bg_color = (80, 50, 20)  # Dark blue
                text_color = (255, 200, 100)  # Light blue text
                overlay_h = 120
            elif msg_type == "doubt_mode":
                bg_color = (50, 80, 20)  # Dark green
                text_color = (100, 255, 100)
                overlay_h = 80
            else:
                bg_color = (0, 0, 0)
                text_color = (255, 255, 255)
                overlay_h = 60

            cv2.rectangle(
                display_frame,
                (0, frame.shape[0] - overlay_h),
                (frame.shape[1], frame.shape[0]),
                bg_color,
                -1
            )

            # For AI responses, show more detail
            if msg_type == "ai_response":
                source = content.get("source", "AI")
                speaker = content.get("speaker", "")
                # Truncate response for display
                display_text = text[:100] + "..." if len(text) > 100 else text

                cv2.putText(
                    display_frame,
                    f"AI ({source})" + (f" - Asked by {speaker}" if speaker else ""),
                    (10, frame.shape[0] - overlay_h + 25),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    (200, 200, 200),
                    1
                )
                cv2.putText(
                    display_frame,
                    display_text[:60],
                    (10, frame.shape[0] - overlay_h + 55),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.55,
                    text_color,
                    1
                )
                if len(display_text) > 60:
                    cv2.putText(
                        display_frame,
                        display_text[60:120],
                        (10, frame.shape[0] - overlay_h + 85),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        text_color,
                        1
                    )
            elif msg_type == "emergency":
                # Large emergency text
                cv2.putText(
                    display_frame,
                    "!!! EMERGENCY !!!",
                    (10, frame.shape[0] - overlay_h + 35),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (0, 0, 255),
                    2
                )
                cv2.putText(
                    display_frame,
                    text[:60],
                    (10, frame.shape[0] - overlay_h + 70),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    text_color,
                    1
                )
            else:
                cv2.putText(
                    display_frame,
                    f"[{msg_type}] {text[:50]}",
                    (10, frame.shape[0] - 20),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    text_color,
                    1
                )

        cv2.imshow(f"Classroom - {self.classroom_name}", display_frame)

    def _handle_reload_faces(self):
        """Handle face reload request."""
        if self._recognizer and hasattr(self._recognizer, "_train_lbph"):
            print("[Classroom] Reloading faces...")
            try:
                self._recognizer._train_lbph()
                print("[Classroom] Faces reloaded successfully")
            except Exception as e:
                print(f"[Classroom] Failed to reload faces: {e}")

    def _handle_test_query(self):
        """Handle test AI query."""
        if self._client and self._client.is_connected():
            print("[Classroom] Sending test AI query...")
            try:
                self._client.emit_ai_query("What is photosynthesis?", speaker="Test")
            except Exception as e:
                print(f"[Classroom] Failed to send query: {e}")

    def _detect_faces(self, frame):
        """Detect and recognize faces in frame."""
        if not self._recognizer:
            return []

        faces_info = []

        try:
            if getattr(self._recognizer, 'use_fr', False):
                faces_info = self._detect_faces_fr(frame)
            else:
                faces_info = self._detect_faces_lbph(frame)
        except Exception as e:
            print(f"[Classroom] Face detection error: {e}")

        return faces_info

    def _detect_faces_fr(self, frame):
        """Detect faces using face_recognition library."""
        import face_recognition

        faces_info = []
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        locations = face_recognition.face_locations(rgb)
        encodings = face_recognition.face_encodings(rgb, locations)

        known_encodings = getattr(self._recognizer, 'known_encodings', [])
        known_names = getattr(self._recognizer, 'known_names', [])

        for enc, loc in zip(encodings, locations):
            name = "Unknown"
            confidence = 0.0

            if known_encodings:
                matches = face_recognition.compare_faces(known_encodings, enc)
                if True in matches:
                    idx = matches.index(True)
                    if idx < len(known_names):
                        name = known_names[idx]
                    distances = face_recognition.face_distance(known_encodings, enc)
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

        return faces_info

    def _detect_faces_lbph(self, frame):
        """Detect faces using LBPH (fallback)."""
        faces_info = []
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        detector = getattr(self._recognizer, 'detector', None)
        if detector is None:
            return []

        faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4)

        recognizer = getattr(self._recognizer, 'recognizer', None)
        label2name = getattr(self._recognizer, 'label2name', {})
        thresh = getattr(self._recognizer, 'lbph_confidence_thresh', 100)

        for (x, y, w, h) in faces:
            roi = gray[y:y+h, x:x+w]
            try:
                roi_resized = cv2.resize(roi, (200, 200))
            except Exception:
                continue

            name = "Unknown"
            confidence = 0.0

            if recognizer is not None:
                try:
                    label, conf = recognizer.predict(roi_resized)
                    if conf <= thresh:
                        if label in label2name:
                            name = label2name[label]
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

    def _capture_screen(self):
        """Capture the display/screen."""
        if not HAS_SCREEN_CAPTURE:
            return None

        try:
            import numpy as np

            # Initialize screen capture if not already
            if self._screen_capture is None:
                self._screen_capture = mss.mss()

            # Capture primary monitor
            monitor = self._screen_capture.monitors[1]  # Primary monitor
            screenshot = self._screen_capture.grab(monitor)

            # Convert to numpy array and then to BGR for OpenCV
            img = np.array(screenshot)
            # mss returns BGRA, convert to BGR
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

            # Resize for bandwidth efficiency (720p max)
            height, width = img.shape[:2]
            max_height = 720
            if height > max_height:
                scale = max_height / height
                new_width = int(width * scale)
                img = cv2.resize(img, (new_width, max_height))

            return img
        except Exception as e:
            print(f"[Classroom] Screen capture error: {e}")
            return None

    def stop(self):
        """Stop the runner gracefully."""
        print("[Classroom] Stopping...")
        self._running = False

        # Stop VAD
        if self._vad:
            try:
                if hasattr(self._vad, 'stop'):
                    self._vad.stop()
                elif hasattr(self._vad, 'running'):
                    self._vad.running = False
            except Exception as e:
                print(f"[Classroom] VAD stop error: {e}")

        # Close screen capture
        if self._screen_capture:
            try:
                self._screen_capture.close()
            except Exception as e:
                print(f"[Classroom] Screen capture close error: {e}")

        # Disconnect client
        if self._client:
            try:
                self._client.disconnect()
            except Exception as e:
                print(f"[Classroom] Client disconnect error: {e}")

        print("[Classroom] Stopped")


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="Classroom Device Runner")
    parser.add_argument("--url", default="http://localhost:5000", help="Supernode URL")
    parser.add_argument("--name", default="Classroom 1", help="Classroom name")
    parser.add_argument("--camera", type=int, default=0, help="Camera index")
    parser.add_argument("--no-display", action="store_true", help="Disable display")
    parser.add_argument("--no-face", action="store_true", help="Disable face recognition")
    parser.add_argument("--no-vad", action="store_true", help="Disable VAD")
    parser.add_argument("--no-aec", action="store_true", help="Disable Acoustic Echo Cancellation")
    parser.add_argument("--no-stream", action="store_true", help="Disable camera streaming")
    parser.add_argument("--no-display-stream", action="store_true", help="Disable display/screen streaming")
    parser.add_argument("--faces-dir", default="face_module/data/faces", help="Known faces directory")

    args = parser.parse_args()

    runner = ClassroomRunner(
        supernode_url=args.url,
        classroom_name=args.name,
        camera_index=args.camera,
        display=not args.no_display,
        enable_face=not args.no_face,
        enable_vad=not args.no_vad,
        enable_aec=not args.no_aec,
        stream_camera=not args.no_stream,
        stream_display=not args.no_display_stream,
        known_dir=args.faces_dir,
    )

    runner.start()


if __name__ == "__main__":
    main()