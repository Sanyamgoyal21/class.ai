"""
Speech-to-Text module using OpenAI Whisper for offline transcription.
"""

import io
import numpy as np

try:
    import whisper
    HAS_WHISPER = True
except ImportError:
    HAS_WHISPER = False
    print("[STT] Whisper not installed. Run: pip install openai-whisper")


class SpeechToText:
    """Speech-to-Text transcription using OpenAI Whisper."""

    def __init__(self, model_name="base", language="en"):
        """
        Initialize Whisper STT.

        Args:
            model_name: Whisper model size ("tiny", "base", "small", "medium", "large")
                       - tiny: fastest, least accurate
                       - base: good balance for real-time (recommended)
                       - small/medium/large: more accurate but slower
            language: Language code (e.g., "en" for English)
        """
        self.model_name = model_name
        self.language = language
        self.model = None

        if HAS_WHISPER:
            print(f"[STT] Loading Whisper model: {model_name}")
            self.model = whisper.load_model(model_name)
            print(f"[STT] Whisper model loaded successfully")
        else:
            print("[STT] Whisper not available, transcription disabled")

    def transcribe(self, audio_data, sample_rate=16000):
        """
        Transcribe audio data to text.

        Args:
            audio_data: Audio bytes (16-bit PCM) or numpy array
            sample_rate: Audio sample rate (default 16000 Hz)

        Returns:
            Transcribed text string, or empty string on error
        """
        if not self.model:
            return ""

        try:
            # Convert bytes to numpy array if needed
            if isinstance(audio_data, bytes):
                audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
            elif isinstance(audio_data, np.ndarray):
                if audio_data.dtype == np.int16:
                    audio_np = audio_data.astype(np.float32) / 32768.0
                else:
                    audio_np = audio_data
            else:
                print("[STT] Invalid audio data type")
                return ""

            # Ensure correct sample rate (Whisper expects 16kHz)
            if sample_rate != 16000:
                # Simple resampling (for production, use librosa or scipy)
                ratio = 16000 / sample_rate
                new_length = int(len(audio_np) * ratio)
                audio_np = np.interp(
                    np.linspace(0, len(audio_np), new_length),
                    np.arange(len(audio_np)),
                    audio_np
                )

            # Transcribe with Whisper
            result = self.model.transcribe(
                audio_np,
                language=self.language,
                fp16=False,  # Use FP32 for CPU compatibility
                task="transcribe"
            )

            transcript = result.get("text", "").strip()
            return transcript

        except Exception as e:
            print(f"[STT] Transcription error: {e}")
            return ""

    def is_available(self):
        """Check if Whisper is available and model is loaded."""
        return self.model is not None


# Singleton instance for reuse
_stt_instance = None


def get_stt(model_name="base", language="en"):
    """Get or create a shared STT instance."""
    global _stt_instance
    if _stt_instance is None:
        _stt_instance = SpeechToText(model_name=model_name, language=language)
    return _stt_instance


if __name__ == "__main__":
    # Test the STT module
    import pyaudio
    import time

    print("Testing Speech-to-Text...")
    stt = SpeechToText(model_name="base")

    if not stt.is_available():
        print("Whisper not available, exiting")
        exit(1)

    # Record 5 seconds of audio
    print("Recording 5 seconds of audio... Speak now!")

    audio = pyaudio.PyAudio()
    stream = audio.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=16000,
        input=True,
        frames_per_buffer=1024
    )

    frames = []
    for _ in range(int(16000 / 1024 * 5)):  # 5 seconds
        data = stream.read(1024, exception_on_overflow=False)
        frames.append(data)

    stream.stop_stream()
    stream.close()
    audio.terminate()

    # Transcribe
    audio_bytes = b''.join(frames)
    print("Transcribing...")

    start = time.time()
    transcript = stt.transcribe(audio_bytes)
    elapsed = time.time() - start

    print(f"Transcript: {transcript}")
    print(f"Transcription time: {elapsed:.2f}s")
