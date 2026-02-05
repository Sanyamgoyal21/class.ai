import threading
import time
import webrtcvad
import pyaudio
from datetime import datetime


class VADDetector(threading.Thread):
    """
    Runs WebRTC VAD and calls callback when a speech segment completes.

    Callback signature: on_segment(start_time, end_time, audio_data)
    - start_time: datetime when speech started
    - end_time: datetime when speech ended
    - audio_data: bytes containing the recorded audio (16-bit PCM, mono, 16kHz)
    """

    def __init__(self, on_segment, aggressiveness=2, rate=16000, frame_duration=20, buffer_audio=True):
        super().__init__(daemon=True)
        self.vad = webrtcvad.Vad(aggressiveness)
        self.rate = rate
        self.frame_duration = frame_duration  # ms
        self.frame_size = int(rate * frame_duration / 1000)  # samples
        self.frame_bytes = self.frame_size * 2  # 16-bit
        self.audio = pyaudio.PyAudio()
        self.on_segment = on_segment
        self.running = False
        self.buffer_audio = buffer_audio  # Whether to capture audio for STT
        self._audio_buffer = []  # Buffer for capturing audio frames

    def run(self):
        try:
            stream = self.audio.open(format=pyaudio.paInt16,
                                     channels=1,
                                     rate=self.rate,
                                     input=True,
                                     frames_per_buffer=self.frame_size)
        except Exception as e:
            print("Failed to open audio stream:", e)
            return

        self.running = True
        in_speech = False
        speech_start = None
        silence_count = 0
        speech_count = 0
        self._audio_buffer = []

        print("VAD listening...")
        try:
            while self.running:
                data = stream.read(self.frame_size, exception_on_overflow=False)
                is_speech = self.vad.is_speech(data, self.rate)

                if is_speech:
                    speech_count += 1
                    silence_count = 0
                    # Buffer audio when speech detected
                    if self.buffer_audio:
                        self._audio_buffer.append(data)
                    if not in_speech and speech_count >= 2:  # small hysteresis
                        in_speech = True
                        speech_start = datetime.now()
                else:
                    silence_count += 1
                    speech_count = 0
                    # Keep buffering a bit after speech ends (captures trailing sounds)
                    if self.buffer_audio and in_speech and silence_count <= 3:
                        self._audio_buffer.append(data)
                    if in_speech and silence_count >= 3:  # end of speech
                        speech_end = datetime.now()
                        duration = (speech_end - speech_start).total_seconds()
                        # Get buffered audio
                        audio_data = b''.join(self._audio_buffer) if self.buffer_audio else None
                        self._audio_buffer = []
                        # call callback with audio data
                        try:
                            self.on_segment(speech_start, speech_end, audio_data)
                        except Exception as e:
                            print("on_segment callback error:", e)
                        in_speech = False
                        speech_start = None

        finally:
            stream.stop_stream()
            stream.close()
            self.audio.terminate()

    def stop(self):
        self.running = False


if __name__ == "__main__":
    def cb(s, e, audio_data=None):
        duration = (e - s).total_seconds()
        audio_size = len(audio_data) if audio_data else 0
        print(f"Speech from {s.isoformat()} to {e.isoformat()}, duration={duration:.2f}s, audio={audio_size} bytes")

    vad = VADDetector(on_segment=cb, buffer_audio=True)
    vad.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        vad.stop()
        vad.join()

