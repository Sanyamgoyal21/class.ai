import time
from datetime import datetime
from face_module.recognize_faces import FaceRecognizer
from audio_module.vad import VADDetector
from database import talking_db as tdb
from config import USE_MONGO

if USE_MONGO:
    try:
        # test Mongo availability
        from database import mongo_db as mdb
        _ = mdb.get_faces_for_training()[:1]
    except Exception as e:
        print("Warning: MongoDB appears enabled but not available or not configured correctly:", e)
        print("Falling back to filesystem/CSV for now.")
        # set USE_MONGO to False locally to avoid further errors
        USE_MONGO = False


def choose_speaker(faces):
    """Return the most likely speaker name from a list of face dicts.
    Heuristic: prefer largest face (area), or the one closest to frame center.
    """
    if not faces:
        return "Unknown"
    # pick face with max area
    face = max(faces, key=lambda x: x.get("area", 0))
    return face.get("name", "Unknown")


def on_speech_segment(start, end, audio_data=None):
    """Called by VAD when a speech segment is detected.
    Signature accepts optional audio_data to support downstream transcription.
    """
    duration = (end - start).total_seconds()
    faces = fr.get_latest_faces()
    name = choose_speaker(faces)
    print(f"Detected speech by {name}: start={start.isoformat()} duration={duration:.2f}s")
    tdb.log_speech(name, start, duration)
    # Optional: if audio_data is provided we could enqueue it for STT processing
    # For now we accept it to avoid callback signature errors from VAD.
    if audio_data is not None:
        # keep minimal processing here; STT runs elsewhere in the system
        pass


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
