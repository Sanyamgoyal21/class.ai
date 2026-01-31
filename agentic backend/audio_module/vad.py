import threading
import time
import webrtcvad
import pyaudio
from datetime import datetime


class VADDetector(threading.Thread):
    """Runs WebRTC VAD and calls `on_segment(start_time, end_time)` when a speech segment completes."""

    def __init__(self, on_segment, aggressiveness=2, rate=16000, frame_duration=20):
        super().__init__(daemon=True)
        self.vad = webrtcvad.Vad(aggressiveness)
        self.rate = rate
        self.frame_duration = frame_duration  # ms
        self.frame_size = int(rate * frame_duration / 1000)  # samples
        self.frame_bytes = self.frame_size * 2  # 16-bit
        self.audio = pyaudio.PyAudio()
        self.on_segment = on_segment
        self.running = False

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

        print("VAD listening...")
        try:
            while self.running:
                data = stream.read(self.frame_size, exception_on_overflow=False)
                is_speech = self.vad.is_speech(data, self.rate)

                if is_speech:
                    speech_count += 1
                    silence_count = 0
                    if not in_speech and speech_count >= 2:  # small hysteresis
                        in_speech = True
                        speech_start = datetime.now()
                else:
                    silence_count += 1
                    speech_count = 0
                    if in_speech and silence_count >= 3:  # end of speech
                        speech_end = datetime.now()
                        duration = (speech_end - speech_start).total_seconds()
                        # call callback
                        try:
                            self.on_segment(speech_start, speech_end)
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
    def cb(s, e):
        print(f"Speech from {s.isoformat()} to {e.isoformat()}, duration={(e-s).total_seconds():.2f}s")

    vad = VADDetector(on_segment=cb)
    vad.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        vad.stop()
        vad.join()

