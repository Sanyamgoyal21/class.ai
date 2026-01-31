import os

# MongoDB configuration
MONGO_URI = os.getenv("MONGO_URI", "")  # set to e.g. "mongodb://localhost:27017"
USE_MONGO = bool(MONGO_URI)
DB_NAME = os.getenv("MONGO_DBNAME", "attendance_system")
FACES_COLLECTION = os.getenv("FACES_COLLECTION", "faces")
ATT_COLLECTION = os.getenv("ATT_COLLECTION", "attendance")
TALK_COLLECTION = os.getenv("TALK_COLLECTION", "talks")

# Face recognizer settings
LBPH_CONFIDENCE_THRESHOLD = int(os.getenv("LBPH_CONFIDENCE_THRESHOLD", "70"))