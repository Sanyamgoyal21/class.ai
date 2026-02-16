"""
Device Client for connecting to the Supernode via Socket.io.
Supports classroom devices and gate cameras.
"""

import os
import uuid
import threading
import time
import base64
from datetime import datetime
import socketio

class DeviceClient:
    """WebSocket client for connecting devices to the Supernode."""

    def __init__(
        self,
        supernode_url="http://localhost:5000",
        device_type="classroom",
        device_name=None,
        device_id=None,
        capabilities=None,
        on_command=None,
        on_broadcast=None,
        on_ai_response=None,
        on_emergency=None,
    ):
        self.supernode_url = supernode_url
        self.device_type = device_type
        self.device_name = device_name or f"{device_type}-{uuid.uuid4().hex[:6]}"
        self.device_id = device_id or f"{device_type}-{uuid.uuid4().hex[:8]}"
        self.capabilities = capabilities or ["camera", "microphone"]

        # Callbacks
        self.on_command = on_command
        self.on_broadcast = on_broadcast
        self.on_ai_response = on_ai_response
        self.on_emergency = on_emergency

        # Socket.io client
        self.sio = socketio.Client(reconnection=True, reconnection_attempts=0)
        self._connected = False
        self._heartbeat_thread = None
        self._running = False

        # Setup event handlers
        self._setup_handlers()

    def _setup_handlers(self):
        @self.sio.event
        def connect():
            print(f"[DeviceClient] Connected to Supernode at {self.supernode_url}")
            self._connected = True
            # Register device
            self.sio.emit("device:register", {
                "deviceId": self.device_id,
                "type": self.device_type,
                "name": self.device_name,
                "capabilities": self.capabilities,
            })

        @self.sio.event
        def disconnect():
            print("[DeviceClient] Disconnected from Supernode")
            self._connected = False

        @self.sio.on("device:registered")
        def on_registered(data):
            if data.get("success"):
                print(f"[DeviceClient] Registered as {self.device_name} ({self.device_id})")
                config = data.get("config", {})
                self._heartbeat_interval = config.get("heartbeatInterval", 30000) / 1000
            else:
                print(f"[DeviceClient] Registration failed: {data}")

        @self.sio.on("control:command")
        def on_control(data):
            print(f"[DeviceClient] Received command: {data.get('action')}")
            result = None
            error = None

            try:
                if self.on_command:
                    result = self.on_command(data)
                else:
                    result = self._handle_default_command(data)
            except Exception as e:
                error = str(e)

            # Send acknowledgment
            self.sio.emit("control:ack", {
                "commandId": data.get("commandId"),
                "success": error is None,
                "error": error,
                "result": result,
            })

        @self.sio.on("broadcast:message")
        def on_broadcast(data):
            print(f"[DeviceClient] Broadcast: {data.get('content')}")
            if self.on_broadcast:
                self.on_broadcast(data)

        @self.sio.on("ai:response")
        def on_ai_response(data):
            print(f"[DeviceClient] AI Response ({data.get('source')}): {data.get('response')[:100]}...")
            if self.on_ai_response:
                self.on_ai_response(data)

        @self.sio.on("emergency:alert")
        def on_emergency_alert(data):
            print(f"[DeviceClient] EMERGENCY ALERT: {data.get('message')}")
            if self.on_emergency:
                self.on_emergency(data)

        @self.sio.on("emergency:stop")
        def on_emergency_stop(data):
            print(f"[DeviceClient] EMERGENCY STOPPED")
            if self.on_emergency:
                # Pass a special stop signal
                self.on_emergency({"action": "stop", "message": None})

        @self.sio.event
        def connect_error(data):
            print(f"[DeviceClient] Connection error: {data}")

    def _handle_default_command(self, data):
        """Handle built-in commands."""
        action = data.get("action")

        if action == "ping":
            return {"pong": True, "timestamp": datetime.now().isoformat()}

        elif action == "status":
            return {
                "deviceId": self.device_id,
                "status": "online",
                "timestamp": datetime.now().isoformat(),
            }

        return {"handled": False, "action": action}

    def _heartbeat_loop(self):
        """Send periodic heartbeats to Supernode."""
        while self._running:
            if self._connected:
                try:
                    self.sio.emit("device:heartbeat", {
                        "deviceId": self.device_id,
                        "status": "healthy",
                        "metrics": {
                            "timestamp": datetime.now().isoformat(),
                        },
                    })
                except Exception as e:
                    print(f"[DeviceClient] Heartbeat error: {e}")

            time.sleep(getattr(self, "_heartbeat_interval", 30))

    def connect(self):
        """Connect to the Supernode."""
        try:
            self.sio.connect(self.supernode_url)
            self._running = True
            self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
            self._heartbeat_thread.start()
            return True
        except Exception as e:
            print(f"[DeviceClient] Failed to connect: {e}")
            return False

    def disconnect(self):
        """Disconnect from the Supernode."""
        self._running = False
        if self.sio.connected:
            self.sio.disconnect()

    def is_connected(self):
        """Check if connected to Supernode."""
        return self._connected

    # =================== Event Emission Methods ===================

    def emit_attendance(self, student_name, confidence=1.0, roll=None, image_snapshot=None):
        """Emit attendance entry event to Supernode."""
        if not self._connected:
            print("[DeviceClient] Not connected, cannot emit attendance")
            return False

        payload = {
            "deviceId": self.device_id,
            "studentName": student_name,
            "confidence": confidence,
            "timestamp": datetime.now().isoformat(),
        }

        if roll:
            payload["roll"] = roll

        if image_snapshot is not None:
            # Convert to base64 if bytes
            if isinstance(image_snapshot, bytes):
                payload["imageSnapshot"] = base64.b64encode(image_snapshot).decode()
            else:
                payload["imageSnapshot"] = image_snapshot

        self.sio.emit("attendance:entry", payload)
        return True

    def emit_presence(self, faces):
        """Emit presence update (who is in frame) to Supernode."""
        if not self._connected:
            return False

        self.sio.emit("presence:update", {
            "deviceId": self.device_id,
            "faces": faces,
            "timestamp": datetime.now().isoformat(),
        })
        return True

    def emit_ai_query(self, text, speaker=None, context=None):
        """Send AI query to Supernode."""
        if not self._connected:
            return None

        query_id = str(int(time.time() * 1000))
        self.sio.emit("ai:query", {
            "deviceId": self.device_id,
            "queryId": query_id,
            "text": text,
            "speaker": speaker or "Unknown",
            "context": context or [],
        })
        return query_id

    def emit_camera_frame(self, frame_bytes):
        """Send camera frame (JPEG bytes) to Supernode."""
        if not self._connected:
            return False

        if isinstance(frame_bytes, bytes):
            frame_b64 = base64.b64encode(frame_bytes).decode()
        else:
            frame_b64 = frame_bytes

        self.sio.emit("camera:frame", {
            "deviceId": self.device_id,
            "frame": frame_b64,
            "timestamp": datetime.now().isoformat(),
        })
        return True

    def emit_display_frame(self, frame_bytes):
        """Send display/screen frame (JPEG bytes) to Supernode."""
        if not self._connected:
            return False

        if isinstance(frame_bytes, bytes):
            frame_b64 = base64.b64encode(frame_bytes).decode()
        else:
            frame_b64 = frame_bytes

        self.sio.emit("display:frame", {
            "deviceId": self.device_id,
            "frame": frame_b64,
            "timestamp": datetime.now().isoformat(),
        })
        return True

    def wait(self):
        """Block until disconnected."""
        self.sio.wait()


class GateCameraClient(DeviceClient):
    """Specialized client for gate attendance cameras."""

    def __init__(self, supernode_url="http://localhost:5000", device_name="Gate Camera", **kwargs):
        super().__init__(
            supernode_url=supernode_url,
            device_type="gate",
            device_name=device_name,
            capabilities=["camera", "face_recognition"],
            **kwargs
        )
        self._attendance_cooldown = {}  # Prevent duplicate attendance within cooldown
        self.cooldown_seconds = 300  # 5 minutes

    def emit_attendance(self, student_name, confidence=1.0, **kwargs):
        """Emit attendance with cooldown to prevent duplicates."""
        now = time.time()
        last_marked = self._attendance_cooldown.get(student_name, 0)

        if now - last_marked < self.cooldown_seconds:
            return False  # Still in cooldown

        self._attendance_cooldown[student_name] = now
        return super().emit_attendance(student_name, confidence, **kwargs)


class ClassroomClient(DeviceClient):
    """Specialized client for classroom devices (smartboard + webcam)."""

    def __init__(self, supernode_url="http://localhost:5000", classroom_name="Classroom", on_emergency=None, **kwargs):
        super().__init__(
            supernode_url=supernode_url,
            device_type="classroom",
            device_name=classroom_name,
            capabilities=["camera", "microphone", "display", "face_recognition", "vad"],
            on_emergency=on_emergency,
            **kwargs
        )
        self._display_callback = None

    def set_display_callback(self, callback):
        """Set callback for display content updates."""
        self._display_callback = callback

        # Override broadcast handler to call display callback
        original_broadcast = self.on_broadcast
        def combined_broadcast(data):
            if original_broadcast:
                original_broadcast(data)
            if self._display_callback:
                self._display_callback(data)

        self.on_broadcast = combined_broadcast

    def emit_local_ai_response(self, response, source, question, speaker, latency_ms=0):
        """
        Emit local AI response to classroom display and dashboard.

        This is used when the AI inference happens locally on the classroom device
        (via local Ollama) rather than on the supernode.

        Args:
            response: The AI-generated response text
            source: Source identifier (e.g., "local-ollama")
            question: The original question from the student
            speaker: The student who asked the question
            latency_ms: Response latency in milliseconds

        Returns:
            True if emitted successfully, False otherwise
        """
        if not self._connected:
            print("[ClassroomClient] Not connected, cannot emit local AI response")
            return False

        payload = {
            "deviceId": self.device_id,
            "response": response,
            "source": source,
            "question": question,
            "speaker": speaker or "Student",
            "latencyMs": latency_ms,
            "timestamp": datetime.now().isoformat(),
        }

        # Emit to supernode which will broadcast to:
        # 1. classroom display (to show the answer)
        # 2. dashboard (for logging)
        self.sio.emit("ai:local-response", payload)
        return True


# Example usage
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Device Client for School Automation")
    parser.add_argument("--url", default="http://localhost:5000", help="Supernode URL")
    parser.add_argument("--type", choices=["classroom", "gate"], default="classroom")
    parser.add_argument("--name", default=None, help="Device name")
    args = parser.parse_args()

    if args.type == "gate":
        client = GateCameraClient(supernode_url=args.url, device_name=args.name or "Gate Camera")
    else:
        client = ClassroomClient(supernode_url=args.url, classroom_name=args.name or "Classroom 1")

    def on_command(data):
        print(f"Command received: {data}")
        return {"executed": True}

    def on_broadcast(data):
        print(f"Announcement: {data.get('content')}")

    client.on_command = on_command
    client.on_broadcast = on_broadcast

    if client.connect():
        print("Connected! Press Ctrl+C to exit.")
        try:
            client.wait()
        except KeyboardInterrupt:
            print("\nDisconnecting...")
            client.disconnect()
    else:
        print("Failed to connect to Supernode")
