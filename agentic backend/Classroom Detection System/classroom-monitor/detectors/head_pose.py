"""
Head-pose estimator using MediaPipe Face Mesh + OpenCV solvePnP.

Outputs:
  yaw   > +threshold  → turn_right
  yaw   < -threshold  → turn_left
  pitch < threshold   → reading  (head tilted downward)
  else                → attentive
"""

import cv2
import numpy as np
import mediapipe as mp
import config

# Generic 3-D face model (mm) for 6 key landmarks
_MODEL_POINTS = np.array([
    (  0.0,    0.0,    0.0),   # nose tip        #1
    (  0.0, -330.0,  -65.0),   # chin            #199
    (-225.0,  170.0, -135.0),  # left eye outer  #33
    ( 225.0,  170.0, -135.0),  # right eye outer #263
    (-150.0, -150.0, -125.0),  # left mouth      #61
    ( 150.0, -150.0, -125.0),  # right mouth     #291
], dtype=np.float64)

_LANDMARK_IDX = [1, 199, 33, 263, 61, 291]


class HeadPoseDetector:
    def __init__(self):
        self._fm = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

    def get_pose(self, crop) -> tuple | None:
        """
        Returns (yaw, pitch, roll) in degrees, or None if no face found.
        crop : BGR numpy array.
        """
        h, w = crop.shape[:2]
        if h < 24 or w < 24:
            return None

        rgb     = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        results = self._fm.process(rgb)
        if not results.multi_face_landmarks:
            return None

        lm = results.multi_face_landmarks[0].landmark
        image_points = np.array(
            [(lm[i].x * w, lm[i].y * h) for i in _LANDMARK_IDX],
            dtype=np.float64,
        )

        focal      = w
        cam_matrix = np.array(
            [[focal, 0, w / 2], [0, focal, h / 2], [0, 0, 1]],
            dtype=np.float64,
        )
        dist_coeffs = np.zeros((4, 1))

        ok, rvec, _ = cv2.solvePnP(
            _MODEL_POINTS, image_points, cam_matrix, dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            return None

        rmat, _     = cv2.Rodrigues(rvec)
        angles, *_  = cv2.RQDecomp3x3(rmat)   # returns (pitch, yaw, roll) order
        pitch, yaw, roll = angles
        return yaw, pitch, roll

    @staticmethod
    def classify(yaw: float, pitch: float) -> str:
        """Map (yaw, pitch) angles to a behaviour label."""
        if yaw > config.HEAD_YAW_THRESHOLD:
            return 'turn_right'
        if yaw < -config.HEAD_YAW_THRESHOLD:
            return 'turn_left'
        if pitch < config.HEAD_PITCH_READ_THRESHOLD:
            return 'reading'
        return 'attentive'
