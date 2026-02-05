"""
AI Classroom Doubt Assistant - State machine for handling student doubts.

States:
- VIDEO_PLAYING: Normal video playback mode
- DOUBT_MODE: Video paused, listening for student's doubt question

Transitions:
- VIDEO_PLAYING -> DOUBT_MODE: On "doubt" trigger word
- DOUBT_MODE -> VIDEO_PLAYING: On "okay"/"understood" trigger word
"""

import re
from datetime import datetime
from audio_module.trigger_detector import TriggerDetector, get_trigger_detector
from audio_module.stt import SpeechToText, get_stt


class DoubtAssistant:
    """
    State machine for managing doubt mode in classroom.

    Listens for trigger words, pauses/resumes video, and sends doubts to AI.
    """

    STATE_VIDEO_PLAYING = "VIDEO_PLAYING"
    STATE_DOUBT_MODE = "DOUBT_MODE"

    def __init__(self, client, on_state_change=None, on_doubt_processed=None):
        """
        Initialize Doubt Assistant.

        Args:
            client: ClassroomClient instance for socket communication
            on_state_change: Callback when state changes (state, data)
            on_doubt_processed: Callback when doubt is sent to AI (doubt_text, speaker)
        """
        self.client = client
        self.state = self.STATE_VIDEO_PLAYING
        self.on_state_change = on_state_change
        self.on_doubt_processed = on_doubt_processed

        # Trigger detection
        self.trigger_detector = get_trigger_detector()

        # Video context for AI
        self.video_context = {
            "url": None,
            "title": None,
            "topic": None,
            "paused_at": None,
            "paused_position": 0,
        }

        # Current doubt session
        self._current_speaker = None
        self._doubt_start_time = None
        self._waiting_for_question = False

        # Setup socket handlers for video context
        self._setup_socket_handlers()

    def _setup_socket_handlers(self):
        """Setup socket event handlers for tracking video context."""
        if not self.client or not hasattr(self.client, 'sio'):
            return

        @self.client.sio.on("video:context")
        def on_video_context(data):
            """Receive video context from classroom display."""
            self.video_context.update({
                "url": data.get("url"),
                "title": data.get("title"),
                "topic": data.get("topic"),
                "current_position": data.get("currentTime", 0),
            })

    def set_video_context(self, url=None, title=None, topic=None):
        """Manually set video context."""
        if url:
            self.video_context["url"] = url
            # Extract topic from YouTube title if available
            if title:
                self.video_context["title"] = title
                self.video_context["topic"] = self._extract_topic(title)

    def _extract_topic(self, title):
        """Extract topic from video title."""
        if not title:
            return None
        # Clean up common YouTube title patterns
        topic = re.sub(r'\s*[\|\-]\s*.*$', '', title)  # Remove " | Channel Name"
        topic = re.sub(r'\s*\(.*?\)\s*', ' ', topic)   # Remove parentheses
        topic = re.sub(r'\s+', ' ', topic).strip()      # Clean whitespace
        return topic

    def on_speech_transcript(self, transcript, speaker=None):
        """
        Process speech transcript and handle state transitions.

        Args:
            transcript: Transcribed speech text
            speaker: Speaker name (from face recognition)

        Returns:
            dict with action taken and any relevant data
        """
        if not transcript:
            return {"action": "no_transcript"}

        transcript = transcript.strip()
        trigger = self.trigger_detector.detect_trigger(transcript)

        print(f"[DoubtAssistant] Transcript: '{transcript}' | Trigger: {trigger} | State: {self.state}")

        # State: VIDEO_PLAYING
        if self.state == self.STATE_VIDEO_PLAYING:
            if trigger == "doubt":
                return self._enter_doubt_mode(speaker)

        # State: DOUBT_MODE
        elif self.state == self.STATE_DOUBT_MODE:
            if trigger == "resume":
                return self._exit_doubt_mode()

            # If waiting for question and this is not a trigger, process as doubt
            if self._waiting_for_question and trigger is None:
                return self._process_doubt(transcript, speaker)

            # If it's another doubt trigger while already in doubt mode, just acknowledge
            if trigger == "doubt":
                return {"action": "already_in_doubt_mode"}

        return {"action": "no_action", "transcript": transcript}

    def _enter_doubt_mode(self, speaker=None):
        """Enter doubt mode - pause video and wait for question."""
        self.state = self.STATE_DOUBT_MODE
        self._current_speaker = speaker
        self._doubt_start_time = datetime.now()
        self._waiting_for_question = True

        # Save current video position
        self.video_context["paused_at"] = datetime.now().isoformat()

        # Emit pause command to classroom
        if self.client and self.client.is_connected():
            self.client.sio.emit("video:pause", {
                "deviceId": self.client.device_id,
                "reason": "doubt_mode",
                "timestamp": datetime.now().isoformat(),
            })

            # Notify about doubt mode entry
            self.client.sio.emit("doubt:mode-entered", {
                "deviceId": self.client.device_id,
                "speaker": speaker,
                "timestamp": datetime.now().isoformat(),
            })

        # Callback
        if self.on_state_change:
            self.on_state_change(self.STATE_DOUBT_MODE, {"speaker": speaker})

        print(f"[DoubtAssistant] Entered DOUBT_MODE. Speaker: {speaker}")
        return {
            "action": "entered_doubt_mode",
            "speaker": speaker,
            "message": "Video paused. Please state your doubt clearly.",
        }

    def _exit_doubt_mode(self):
        """Exit doubt mode - resume video playback."""
        self.state = self.STATE_VIDEO_PLAYING
        self._waiting_for_question = False

        # Emit resume command to classroom
        if self.client and self.client.is_connected():
            self.client.sio.emit("video:resume", {
                "deviceId": self.client.device_id,
                "reason": "doubt_resolved",
                "timestamp": datetime.now().isoformat(),
            })

            # Notify about doubt mode exit
            self.client.sio.emit("doubt:mode-exited", {
                "deviceId": self.client.device_id,
                "timestamp": datetime.now().isoformat(),
            })

        # Callback
        if self.on_state_change:
            self.on_state_change(self.STATE_VIDEO_PLAYING, {})

        # Reset session
        speaker = self._current_speaker
        self._current_speaker = None
        self._doubt_start_time = None

        print(f"[DoubtAssistant] Exited DOUBT_MODE. Resuming video.")
        return {
            "action": "exited_doubt_mode",
            "speaker": speaker,
            "message": "Resuming video playback.",
        }

    def _process_doubt(self, doubt_text, speaker=None):
        """Process the student's doubt question."""
        self._waiting_for_question = False

        # Clean up the doubt text
        question = self.trigger_detector.extract_question(doubt_text)
        if not question:
            question = doubt_text

        # Build context for AI
        context = {
            "video_title": self.video_context.get("title"),
            "video_topic": self.video_context.get("topic"),
            "video_url": self.video_context.get("url"),
        }

        # Send to AI via client
        if self.client and self.client.is_connected():
            # Emit doubt query with context
            self.client.sio.emit("doubt:query", {
                "deviceId": self.client.device_id,
                "question": question,
                "speaker": speaker or self._current_speaker or "Student",
                "context": context,
                "timestamp": datetime.now().isoformat(),
            })

            # Also use standard AI query with enhanced prompt
            enhanced_question = self._build_contextual_query(question, context)
            self.client.emit_ai_query(
                text=enhanced_question,
                speaker=speaker or self._current_speaker,
                context=context,
            )

        # Callback
        if self.on_doubt_processed:
            self.on_doubt_processed(question, speaker or self._current_speaker)

        print(f"[DoubtAssistant] Processing doubt: '{question}' from {speaker}")
        return {
            "action": "doubt_processed",
            "question": question,
            "speaker": speaker or self._current_speaker,
            "context": context,
        }

    def _build_contextual_query(self, question, context):
        """Build a contextual query for the AI."""
        parts = []

        if context.get("video_topic"):
            parts.append(f"[Video Topic: {context['video_topic']}]")
        elif context.get("video_title"):
            parts.append(f"[Video: {context['video_title']}]")

        parts.append(f"Student's doubt: {question}")

        return " ".join(parts)

    def force_exit_doubt_mode(self):
        """Force exit doubt mode (for timeout or manual override)."""
        if self.state == self.STATE_DOUBT_MODE:
            return self._exit_doubt_mode()
        return {"action": "not_in_doubt_mode"}

    def get_state(self):
        """Get current state information."""
        return {
            "state": self.state,
            "in_doubt_mode": self.state == self.STATE_DOUBT_MODE,
            "current_speaker": self._current_speaker,
            "video_context": self.video_context,
            "waiting_for_question": self._waiting_for_question,
        }


if __name__ == "__main__":
    # Test the doubt assistant
    print("Testing Doubt Assistant State Machine")
    print("=" * 50)

    # Mock client for testing
    class MockClient:
        def __init__(self):
            self.device_id = "test-classroom"
            self.sio = type('obj', (object,), {
                'emit': lambda self, event, data: print(f"  [Socket] {event}: {data}"),
                'on': lambda self, event: lambda fn: None,
            })()

        def is_connected(self):
            return True

        def emit_ai_query(self, text, speaker=None, context=None):
            print(f"  [AI Query] {speaker}: {text}")

    client = MockClient()
    assistant = DoubtAssistant(client)

    # Set some video context
    assistant.set_video_context(
        url="https://youtube.com/watch?v=abc123",
        title="Photosynthesis Explained | Biology Class 10",
    )

    # Test scenarios
    test_transcripts = [
        ("I have a doubt", "Student A"),
        ("What is the role of chlorophyll?", "Student A"),
        ("Okay, I understood", "Student A"),
        ("The weather is nice", None),
        ("Question about light reaction", "Student B"),
        ("Thank you, that's clear", "Student B"),
    ]

    print("\nRunning test scenarios:")
    print("-" * 50)

    for transcript, speaker in test_transcripts:
        print(f"\nInput: '{transcript}' (Speaker: {speaker})")
        result = assistant.on_speech_transcript(transcript, speaker)
        print(f"Result: {result['action']}")
        print(f"State: {assistant.state}")
