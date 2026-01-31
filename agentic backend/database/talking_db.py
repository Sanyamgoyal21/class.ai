import csv
import os
from datetime import datetime

TALK_FILE = os.path.join(os.path.dirname(__file__), "talk_log.csv")


def init_db():
    os.makedirs(os.path.dirname(TALK_FILE), exist_ok=True)
    if not os.path.exists(TALK_FILE):
        with open(TALK_FILE, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["name", "start_time", "duration_seconds"])


def log_speech(name: str, start_time: datetime, duration: float):
    init_db()
    start_iso = start_time.isoformat()
    with open(TALK_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([name, start_iso, round(duration, 2)])


def read_all():
    init_db()
    rows = []
    with open(TALK_FILE, "r", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    return rows
