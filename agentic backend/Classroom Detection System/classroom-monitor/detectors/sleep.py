"""
Sleep / drowsiness detector.
Uses Eye Aspect Ratio (EAR) computed from MediaPipe Face Mesh landmarks.
A student is marked asleep when EAR stays below the threshold for
EAR_CONSEC_FRAMES consecutive frames.
"""

import cv2
import numpy as np
import mediapipe as mp
from scipy.spatial import distance as dist
import config

# MediaPipe Face Mesh landmark indices for each eye (6 points each)
_LEFT_EYE  = [362, 385, 387, 263, 373, 380]
_RIGHT_EYE = [33,  160, 158, 133, 153, 144]


def _ear(landmarks, eye_idx: list, w: int, h: int) -> float:
    """Eye Aspect Ratio for one eye."""
    pts = [(landmarks[i].x * w, landmarks[i].y * h) for i in eye_idx]
    A = dist.euclidean(pts[1], pts[5])
    B = dist.euclidean(pts[2], pts[4])
    C = dist.euclidean(pts[0], pts[3])
    return (A + B) / (2.0 * C)


class SleepDetector:
    def __init__(self):
        self._fm = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        self._counters: dict[int, int] = {}   # student_id → consecutive low-EAR frames

    def check(self, student_id: int, crop) -> tuple[bool, float]:
        """
        Returns (is_sleeping, ear_value).
        crop : BGR numpy array of the student's bounding box region.
        """
        h, w = crop.shape[:2]
        if h < 24 or w < 24:
            return False, 1.0

        rgb     = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        results = self._fm.process(rgb)

        if not results.multi_face_landmarks:
            # No face found — reset counter so we don't accumulate false sleeps
            self._counters[student_id] = 0
            return False, 1.0

        lm       = results.multi_face_landmarks[0].landmark
        left_ear = _ear(lm, _LEFT_EYE,  w, h)
        right_ear= _ear(lm, _RIGHT_EYE, w, h)
        ear      = (left_ear + right_ear) / 2.0

        cnt = self._counters.get(student_id, 0)
        if ear < config.EAR_THRESHOLD:
            cnt += 1
        else:
            cnt = 0
        self._counters[student_id] = cnt

        return cnt >= config.EAR_CONSEC_FRAMES, ear
