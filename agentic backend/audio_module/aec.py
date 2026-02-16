"""
Acoustic Echo Cancellation (AEC) module for filtering speaker audio from microphone input.

Uses speexdsp for high-quality echo cancellation, with fallback to basic
correlation-based cancellation if speexdsp is not available.
"""

import numpy as np
import threading
import pyaudio

# Try to import speexdsp for high-quality AEC
try:
    import speexdsp
    HAS_SPEEXDSP = True
except ImportError:
    HAS_SPEEXDSP = False
    print("[AEC] speexdsp not available, using basic AEC fallback")


class AcousticEchoCanceller:
    """
    Acoustic Echo Cancellation using speexdsp or basic correlation method.

    Filters out speaker/system audio that is picked up by the microphone,
    leaving only the external sounds (e.g., student speech).
    """

    def __init__(self, sample_rate=16000, frame_size=320, filter_length=1024):
        """
        Initialize AEC.

        Args:
            sample_rate: Audio sample rate in Hz
            frame_size: Number of samples per frame (20ms at 16kHz = 320)
            filter_length: Length of adaptive filter (longer = better for reverb)
        """
        self.sample_rate = sample_rate
        self.frame_size = frame_size
        self.filter_length = filter_length

        self._echo_state = None
        self._use_speexdsp = HAS_SPEEXDSP

        if self._use_speexdsp:
            try:
                # Initialize speexdsp echo canceller
                self._echo_state = speexdsp.EchoCanceller.create(
                    frame_size,
                    filter_length,
                    sample_rate,
                    1  # mono
                )
                print(f"[AEC] Initialized speexdsp AEC (frame={frame_size}, filter={filter_length})")
            except Exception as e:
                print(f"[AEC] Failed to initialize speexdsp: {e}")
                self._use_speexdsp = False

        if not self._use_speexdsp:
            # Fallback: basic correlation-based cancellation
            self._reference_buffer = np.zeros(filter_length, dtype=np.float32)
            print("[AEC] Using basic correlation-based AEC")

    def process(self, mic_frame, speaker_frame):
        """
        Process microphone audio and remove speaker echo.

        Args:
            mic_frame: Microphone audio frame (bytes, 16-bit PCM)
            speaker_frame: Speaker/loopback audio frame (bytes, 16-bit PCM)

        Returns:
            Cleaned audio frame (bytes, 16-bit PCM) with echo removed
        """
        if mic_frame is None:
            return mic_frame

        # Convert to numpy
        mic_np = np.frombuffer(mic_frame, dtype=np.int16).astype(np.float32)

        if speaker_frame is None or len(speaker_frame) == 0:
            # No reference, return original
            return mic_frame

        speaker_np = np.frombuffer(speaker_frame, dtype=np.int16).astype(np.float32)

        # Ensure same length
        min_len = min(len(mic_np), len(speaker_np))
        mic_np = mic_np[:min_len]
        speaker_np = speaker_np[:min_len]

        if self._use_speexdsp and self._echo_state:
            try:
                # Use speexdsp echo cancellation
                mic_int16 = mic_np.astype(np.int16)
                speaker_int16 = speaker_np.astype(np.int16)

                # speexdsp expects bytes
                cleaned = self._echo_state.process(
                    mic_int16.tobytes(),
                    speaker_int16.tobytes()
                )
                return cleaned
            except Exception as e:
                print(f"[AEC] speexdsp error: {e}")
                # Fall through to basic method

        # Basic correlation-based echo cancellation
        cleaned_np = self._basic_aec(mic_np, speaker_np)
        return cleaned_np.astype(np.int16).tobytes()

    def _basic_aec(self, mic, speaker):
        """
        Basic echo cancellation using correlation and subtraction.

        This is a simple NLMS (Normalized Least Mean Squares) approach.
        """
        # Update reference buffer
        self._reference_buffer = np.roll(self._reference_buffer, -len(speaker))
        self._reference_buffer[-len(speaker):] = speaker

        # Estimate echo using correlation
        if np.std(speaker) > 100:  # Only if there's significant speaker audio
            # Simple correlation-based estimate
            correlation = np.correlate(mic, speaker, mode='same')
            peak_idx = np.argmax(np.abs(correlation))

            # Estimate scale factor
            speaker_power = np.sum(speaker ** 2) + 1e-10
            mic_speaker_corr = np.sum(mic * speaker)
            scale = mic_speaker_corr / speaker_power

            # Clamp scale to reasonable range
            scale = np.clip(scale, 0, 2)

            # Subtract estimated echo
            cleaned = mic - scale * speaker
        else:
            # No significant speaker audio, return as-is
            cleaned = mic

        return cleaned


class LoopbackCapture(threading.Thread):
    """
    Captures system/loopback audio (what's playing through speakers).
    Uses WASAPI loopback on Windows.
    """

    def __init__(self, sample_rate=16000, frame_size=320, on_frame=None):
        """
        Initialize loopback capture.

        Args:
            sample_rate: Target sample rate
            frame_size: Samples per frame
            on_frame: Callback(frame_bytes) for each captured frame
        """
        super().__init__(daemon=True)
        self.sample_rate = sample_rate
        self.frame_size = frame_size
        self.on_frame = on_frame

        self.running = False
        self._audio = None
        self._stream = None
        self._device_index = None
        self._current_frame = None
        self._frame_lock = threading.Lock()

    def _find_loopback_device(self):
        """Find WASAPI loopback device on Windows."""
        self._audio = pyaudio.PyAudio()

        # Look for loopback device
        for i in range(self._audio.get_device_count()):
            try:
                info = self._audio.get_device_info_by_index(i)
                name = info.get('name', '').lower()

                # Windows WASAPI loopback indicators
                if 'loopback' in name or 'stereo mix' in name or 'what u hear' in name:
                    print(f"[Loopback] Found device: {info['name']} (index {i})")
                    return i

                # Check for output device that supports input (loopback)
                if info.get('maxInputChannels', 0) > 0:
                    host_api = self._audio.get_host_api_info_by_index(info['hostApi'])
                    if 'wasapi' in host_api.get('name', '').lower():
                        # Could be loopback capable
                        if 'speaker' in name or 'output' in name:
                            print(f"[Loopback] Potential loopback: {info['name']}")
                            return i
            except Exception:
                continue

        print("[Loopback] No loopback device found")
        return None

    def run(self):
        """Run loopback capture thread."""
        self._device_index = self._find_loopback_device()

        if self._device_index is None:
            print("[Loopback] Cannot start - no loopback device")
            return

        try:
            self._stream = self._audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.sample_rate,
                input=True,
                input_device_index=self._device_index,
                frames_per_buffer=self.frame_size,
            )
        except Exception as e:
            print(f"[Loopback] Failed to open stream: {e}")
            return

        self.running = True
        print("[Loopback] Capture started")

        try:
            while self.running:
                try:
                    data = self._stream.read(self.frame_size, exception_on_overflow=False)

                    # Store current frame
                    with self._frame_lock:
                        self._current_frame = data

                    # Callback if provided
                    if self.on_frame:
                        self.on_frame(data)

                except Exception as e:
                    if self.running:
                        print(f"[Loopback] Read error: {e}")
                    break
        finally:
            if self._stream:
                self._stream.stop_stream()
                self._stream.close()
            if self._audio:
                self._audio.terminate()

    def get_current_frame(self):
        """Get the most recently captured loopback frame."""
        with self._frame_lock:
            return self._current_frame

    def stop(self):
        """Stop loopback capture."""
        self.running = False


# Singleton instances
_aec_instance = None
_loopback_instance = None


def get_aec(sample_rate=16000, frame_size=320):
    """Get or create shared AEC instance."""
    global _aec_instance
    if _aec_instance is None:
        _aec_instance = AcousticEchoCanceller(sample_rate, frame_size)
    return _aec_instance


def get_loopback_capture(sample_rate=16000, frame_size=320):
    """Get or create shared loopback capture instance."""
    global _loopback_instance
    if _loopback_instance is None:
        _loopback_instance = LoopbackCapture(sample_rate, frame_size)
    return _loopback_instance


if __name__ == "__main__":
    # Test AEC module
    import time

    print("Testing Acoustic Echo Cancellation")
    print("=" * 50)

    # Test AEC initialization
    aec = AcousticEchoCanceller(sample_rate=16000, frame_size=320)
    print(f"AEC initialized, using speexdsp: {aec._use_speexdsp}")

    # Test with dummy data
    mic_frame = np.random.randint(-1000, 1000, 320, dtype=np.int16).tobytes()
    speaker_frame = np.random.randint(-500, 500, 320, dtype=np.int16).tobytes()

    cleaned = aec.process(mic_frame, speaker_frame)
    print(f"Processed frame: {len(cleaned)} bytes")

    # Test loopback capture
    print("\nTesting Loopback Capture...")
    loopback = LoopbackCapture(sample_rate=16000, frame_size=320)
    loopback.start()

    time.sleep(2)

    frame = loopback.get_current_frame()
    if frame:
        print(f"Captured loopback frame: {len(frame)} bytes")
    else:
        print("No loopback frame captured (no audio playing or no loopback device)")

    loopback.stop()
    loopback.join(timeout=1)

    print("\nTest complete!")
