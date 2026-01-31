import csv
import os
from datetime import datetime
from config import USE_MONGO

ATT_FILE = os.path.join(os.path.dirname(__file__), "attendance.csv")


def init_db():
    os.makedirs(os.path.dirname(ATT_FILE), exist_ok=True)
    if not os.path.exists(ATT_FILE):
        with open(ATT_FILE, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["name", "roll", "timestamp"])


def mark_attendance(name: str, roll: str = ""):
    """Append an attendance row (name, roll, timestamp). Uses MongoDB when enabled."""
    if USE_MONGO:
        try:
            from database import mongo_db as mdb
            mdb.mark_attendance(name, roll, datetime.now())
            return
        except Exception as e:
            print("MongoDB attendance failed:", e)
    init_db()
    timestamp = datetime.now().isoformat()
    with open(ATT_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([name, roll, timestamp])


def read_all():
    if USE_MONGO:
        try:
            from database import mongo_db as mdb
            return mdb.read_all_attendance()
        except Exception as e:
            print("MongoDB read_all failed:", e)
            # fallback to CSV
    init_db()
    rows = []
    with open(ATT_FILE, "r", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    return rows
