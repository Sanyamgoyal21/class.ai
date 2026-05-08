"""
Hand-raise detector using MediaPipe Pose.

Improvement over v1: the caller passes the full frame + bbox so we can
expand the crop UPWARD by HAND_CROP_PAD_TOP before running pose.
This prevents raised arms being cropped out of the student region.
"""

import cv2
import mediapipe as mp
import config

_POSE = mp.solutions.pose.PoseLandmark


class HandRaiseDetector:
    def __init__(self):
        self._pose = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=1,          # 0=fast, 1=balanced, 2=accurate
            smooth_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

    def check(self, frame, bbox: tuple) -> bool:
        """
        frame : full BGR frame
        bbox  : (x1, y1, x2, y2) student bounding box

        Expands the crop upward before running pose so a fully-raised arm
        is not clipped. Returns True if at least one wrist is raised.
        """
        fh, fw = frame.shape[:2]
        x1, y1, x2, y2 = bbox

        # Expand upward
        box_h  = y2 - y1
        pad_up = int(box_h * config.HAND_CROP_PAD_TOP)
        y1_exp = max(0, y1 - pad_up)

        crop = frame[y1_exp:y2, max(0, x1):min(fw, x2)]
        if crop.size == 0 or crop.shape[0] < 60 or crop.shape[1] < 30:
            return False

        rgb     = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        results = self._pose.process(rgb)
        if not results.pose_landmarks:
            return False

        lm = results.pose_landmarks.landmark

        def _raised(shoulder_id, wrist_id) -> bool:
            s  = lm[shoulder_id]
            wr = lm[wrist_id]
            if wr.visibility < 0.45 or s.visibility < 0.45:
                return False
            return (s.y - wr.y) > config.HAND_RAISE_THRESHOLD

        return (
            _raised(_POSE.LEFT_SHOULDER,  _POSE.LEFT_WRIST) or
            _raised(_POSE.RIGHT_SHOULDER, _POSE.RIGHT_WRIST)
        )
