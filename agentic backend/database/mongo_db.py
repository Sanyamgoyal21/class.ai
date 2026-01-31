"""Simple MongoDB helpers for storing face images and attendance/talking logs.

Requires: pymongo
Set environment variable MONGO_URI (e.g., mongodb://localhost:27017) to enable.
"""
import os
from datetime import datetime

try:
    from pymongo import MongoClient
    from bson.binary import Binary
except Exception:
    MongoClient = None
    Binary = None

import cv2
import numpy as np

from config import MONGO_URI, DB_NAME, FACES_COLLECTION, ATT_COLLECTION, TALK_COLLECTION, USE_MONGO

_client = None
_db = None


def _ensure_connected():
    global _client, _db
    if not USE_MONGO:
        raise RuntimeError("MongoDB not enabled (set MONGO_URI in environment)")
    if MongoClient is None:
        raise RuntimeError("pymongo is not installed. Run 'pip install pymongo'")
    if _client is None:
        _client = MongoClient(MONGO_URI)
        _db = _client[DB_NAME]


def save_face(name: str, filename: str, image_bytes: bytes, timestamp: datetime = None):
    """Save a face image (raw bytes) to MongoDB."""
    _ensure_connected()
    doc = {
        "name": name,
        "filename": filename,
        "data": Binary(image_bytes),
        "timestamp": timestamp or datetime.utcnow(),
    }
    return _db[FACES_COLLECTION].insert_one(doc)


def list_faces_docs():
    """Return raw cursor of face documents."""
    _ensure_connected()
    return _db[FACES_COLLECTION].find()


def get_faces_for_training():
    """Return list of dicts: {'name': name, 'img': cv2 image (BGR or gray depending on stored)}"""
    _ensure_connected()
    results = []
    for doc in _db[FACES_COLLECTION].find():
        b = bytes(doc.get("data"))
        arr = np.frombuffer(b, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
        if img is None:
            continue
        # if grayscale image saved, imdecode may return single channel; else BGR
        results.append({"name": doc.get("name"), "img": img})
    return results


def mark_attendance(name: str, roll: str = "", timestamp: datetime = None):
    _ensure_connected()
    doc = {"name": name, "roll": roll, "timestamp": timestamp or datetime.utcnow()}
    return _db[ATT_COLLECTION].insert_one(doc)


def read_all_attendance():
    _ensure_connected()
    rows = []
    for doc in _db[ATT_COLLECTION].find().sort("timestamp", 1):
        rows.append({"name": doc.get("name"), "roll": doc.get("roll", ""), "timestamp": doc.get("timestamp").isoformat()})
    return rows


def log_speech(name: str, start_time: datetime, duration: float):
    _ensure_connected()
    doc = {"name": name, "start_time": start_time, "duration_seconds": float(duration)}
    return _db[TALK_COLLECTION].insert_one(doc)


def read_all_speech():
    _ensure_connected()
    rows = []
    for doc in _db[TALK_COLLECTION].find().sort("start_time", 1):
        rows.append({"name": doc.get("name"), "start_time": doc.get("start_time").isoformat(), "duration_seconds": doc.get("duration_seconds")})
    return rows
