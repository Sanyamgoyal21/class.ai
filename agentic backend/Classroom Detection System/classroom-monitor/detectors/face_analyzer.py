"""
FaceAnalyzer — runs MediaPipe FaceMesh ONCE per student crop and returns
both sleep data (EAR) and head-pose data (yaw / pitch / roll).

Improvements over the split sleep.py + head_pose.py approach:
  • One FaceMesh call per student per frame instead of two.
  • Exponential moving average (EMA) on yaw/pitch/roll to remove jitter.
  • Head-pitch context added to sleep: head pitched far down counts as sleeping
    even if eyes are partly open (student slumping over desk).
  • Writing distinguished from reading using a steeper pitch threshold.
"""

import cv2
import numpy as np
import mediapipe as mp
from scipy.spatial import distance as dist
import config

# ── Eye landmark indices (MediaPipe Face Mesh) ─────────────────────────────────
_LEFT_EYE  = [362, 385, 387, 263, 373, 380]
_RIGHT_EYE = [33,  160, 158, 133, 153, 144]

# ── 3-D face model points (mm) for solvePnP ───────────────────────────────────
_MODEL_3D = np.array([
    (  0.0,    0.0,    0.0),   # nose tip       #1
    (  0.0, -330.0,  -65.0),   # chin           #199
    (-225.0,  170.0, -135.0),  # left eye outer #33
    ( 225.0,  170.0, -135.0),  # right eye outer#263
    (-150.0, -150.0, -125.0),  # left mouth     #61
    ( 150.0, -150.0, -125.0),  # right mouth    #291
], dtype=np.float64)
_LM_IDX = [1, 199, 33, 263, 61, 291]


def _ear(lm, eye_idx, w, h):
    pts = [(lm[i].x * w, lm[i].y * h) for i in eye_idx]
    A = dist.euclidean(pts[1], pts[5])
    B = dist.euclidean(pts[2], pts[4])
    C = dist.euclidean(pts[0], pts[3])
    return (A + B) / (2.0 * C)


class FaceAnalyzer:
    """
    Per-student face analysis: call analyze(sid, crop) each analysis frame.
    Returns a dict with keys: ear, is_sleeping, yaw, pitch, roll, activity.
    """

    def __init__(self):
        self._fm = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        # Per-student state
        self._ear_counters: dict[int, int]   = {}
        self._angle_ema:    dict[int, tuple] = {}   # sid → (yaw, pitch, roll)

    def analyze(self, sid: int, crop) -> dict:
        """
        Returns dict:
          ear          – float
          is_sleeping  – bool
          yaw          – float (degrees, + = right)
          pitch        – float (degrees, - = down)
          roll         – float
          activity     – 'attentive' | 'turn_left' | 'turn_right' | 'reading' | 'writing'
        Returns None if no face is detected.
        """
        h, w = crop.shape[:2]
        if h < 24 or w < 24:
            return None

        rgb     = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        results = self._fm.process(rgb)
        if not results.multi_face_landmarks:
            self._ear_counters[sid] = 0
            return None

        lm = results.multi_face_landmarks[0].landmark

        # ── EAR ────────────────────────────────────────────────────────────────
        ear = (_ear(lm, _LEFT_EYE, w, h) + _ear(lm, _RIGHT_EYE, w, h)) / 2.0

        cnt = self._ear_counters.get(sid, 0)
        cnt = cnt + 1 if ear < config.EAR_THRESHOLD else 0
        self._ear_counters[sid] = cnt

        # ── Head pose via solvePnP ──────────────────────────────────────────────
        img_pts = np.array(
            [(lm[i].x * w, lm[i].y * h) for i in _LM_IDX], dtype=np.float64
        )
        focal      = w
        cam_matrix = np.array(
            [[focal, 0, w / 2], [0, focal, h / 2], [0, 0, 1]], dtype=np.float64
        )
        ok, rvec, _ = cv2.solvePnP(
            _MODEL_3D, img_pts, cam_matrix, np.zeros((4, 1)),
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            return None

        rmat, _            = cv2.Rodrigues(rvec)
        raw_angles, *_     = cv2.RQDecomp3x3(rmat)   # (pitch, yaw, roll)
        raw_pitch, raw_yaw, raw_roll = raw_angles

        # ── EMA smoothing on angles ─────────────────────────────────────────────
        a = config.ANGLE_EMA_ALPHA
        if sid in self._angle_ema:
            prev_yaw, prev_pitch, prev_roll = self._angle_ema[sid]
            yaw   = a * raw_yaw   + (1 - a) * prev_yaw
            pitch = a * raw_pitch + (1 - a) * prev_pitch
            roll  = a * raw_roll  + (1 - a) * prev_roll
        else:
            yaw, pitch, roll = raw_yaw, raw_pitch, raw_roll
        self._angle_ema[sid] = (yaw, pitch, roll)

        # ── Activity classification ─────────────────────────────────────────────
        if yaw > config.HEAD_YAW_THRESHOLD:
            activity = 'turn_right'
        elif yaw < -config.HEAD_YAW_THRESHOLD:
            activity = 'turn_left'
        elif pitch < config.HEAD_PITCH_WRITE_THRESHOLD:
            activity = 'writing'
        elif pitch < config.HEAD_PITCH_READ_THRESHOLD:
            activity = 'reading'
        else:
            activity = 'attentive'

        # ── Sleep: EAR frames OR head pitched severely down (slumped) ──────────
        slumped     = pitch < (config.HEAD_PITCH_WRITE_THRESHOLD - 15)
        is_sleeping = (cnt >= config.EAR_CONSEC_FRAMES) or slumped

        return {
            'ear'        : round(ear,   3),
            'is_sleeping': is_sleeping,
            'yaw'        : round(yaw,   1),
            'pitch'      : round(pitch, 1),
            'roll'       : round(roll,  1),
            'activity'   : activity,
        }

    def reset(self, sid: int):
        """Call when a student ID is retired to free memory."""
        self._ear_counters.pop(sid, None)
        self._angle_ema.pop(sid, None)
