import time
from datetime import datetime
from face_module.recognize_faces import FaceRecognizer
from audio_module.vad import VADDetector
from database import talking_db as tdb


def choose_speaker(faces):
    """Return the most likely speaker name from a list of face dicts.
    Heuristic: prefer largest face (area), or the one closest to frame center.
    """
    if not faces:
        return "Unknown"
    # pick face with max area
    face = max(faces, key=lambda x: x.get("area", 0))
    return face.get("name", "Unknown")


def on_speech_segment(start, end):
    duration = (end - start).total_seconds()
    faces = fr.get_latest_faces()
    name = choose_speaker(faces)
    print(f"Detected speech by {name}: start={start.isoformat()} duration={duration:.2f}s")
    tdb.log_speech(name, start, duration)


if __name__ == "__main__":
    fr = FaceRecognizer(display=True)
    fr.start()

    vad = VADDetector(on_segment=on_speech_segment)
    vad.start()

    print("System running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Shutting down...")
        vad.stop()
        fr.running = False
        vad.join()
        fr.join()
        print("Stopped.")
