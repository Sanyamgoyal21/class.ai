"""
Classroom Monitor — improved main loop.

Accuracy improvements over v1:
  1. YOLO built-in BoT-SORT tracking  → persistent IDs without a hand-rolled tracker
  2. FaceAnalyzer (shared FaceMesh)   → one MediaPipe call per student instead of two
  3. EMA angle smoothing              → removes head-pose jitter
  4. State hysteresis                 → N consecutive frames required before confirming
  5. YOLOv8s                          → better person + phone detection accuracy
  6. Expanded hand-raise crop         → raises aren't cropped off

Hotkeys: q = quit  |  s = screenshot  |  r = reset tracker IDs
"""

import cv2
import sys
import time
from collections import defaultdict, deque

import config
from detectors.face_analyzer  import FaceAnalyzer
from detectors.phone          import check_student_has_phone
from detectors.hand_raise     import HandRaiseDetector
from dashboard                import Dashboard


# ── State hysteresis helper ────────────────────────────────────────────────────

class _StateBuffer:
    """
    Smooths noisy per-frame detections into stable confirmed states.
    • bool keys  : confirmed True only after STATE_CONFIRM_FRAMES consecutive Trues
    • string keys: confirmed only after ACTIVITY_CONFIRM_FRAMES consecutive same value
    """
    def __init__(self):
        self._buf: dict[int, dict[str, deque]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=max(
                config.STATE_CONFIRM_FRAMES, config.ACTIVITY_CONFIRM_FRAMES
            )))
        )
        self._confirmed: dict[int, dict] = defaultdict(dict)

    def push(self, sid: int, key: str, value):
        n   = config.ACTIVITY_CONFIRM_FRAMES if isinstance(value, str) else config.STATE_CONFIRM_FRAMES
        buf = self._buf[sid][key]
        buf.append(value)

        recent = list(buf)[-n:]
        if len(recent) < n:
            return  # not enough data yet

        if isinstance(value, str):
            if len(set(recent)) == 1:          # all n frames agree
                self._confirmed[sid][key] = value
        else:
            if all(recent):                    # all n bool frames are True
                self._confirmed[sid][key] = True
            elif not any(recent):              # all False → clear flag
                self._confirmed[sid][key] = False

    def get(self, sid: int, key: str, default=None):
        return self._confirmed[sid].get(key, default)

    def remove(self, sid: int):
        self._buf.pop(sid, None)
        self._confirmed.pop(sid, None)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    try:
        from ultralytics import YOLO
    except ImportError:
        sys.exit("ultralytics not installed — run: pip install ultralytics")

    # ── camera ─────────────────────────────────────────────────────────────────
    cap = cv2.VideoCapture(config.CAMERA_INDEX)
    if not cap.isOpened():
        sys.exit(f"Cannot open camera {config.CAMERA_INDEX}")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  config.FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.FRAME_HEIGHT)
    cap.set(cv2.CAP_PROP_FPS,          config.FPS_TARGET)
    cap.set(cv2.CAP_PROP_BUFFERSIZE,   1)

    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"[INFO] Camera {W}x{H}")

    # ── models ─────────────────────────────────────────────────────────────────
    print(f"[INFO] Loading {config.YOLO_MODEL} …")
    yolo     = YOLO(config.YOLO_MODEL)
    face_an  = FaceAnalyzer()
    hand_det = HandRaiseDetector()
    dash     = Dashboard()
    sbuf     = _StateBuffer()

    # ── runtime state ──────────────────────────────────────────────────────────
    student_states: dict = defaultdict(dict)
    frame_no = 0
    fps      = 0.0
    t_prev   = time.perf_counter()

    # Cache last YOLO results so non-tracking frames still have data
    last_tracked:    dict = {}   # id → (centroid, bbox)
    last_phone_boxes: list = []

    print("[INFO] Running — q quit | s screenshot | r reset IDs")

    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.05)
            continue

        frame_no += 1
        t_now = time.perf_counter()
        fps   = 0.9 * fps + 0.1 / max(t_now - t_prev, 1e-6)
        t_prev = t_now

        # ── YOLO tracking (BoT-SORT) every N frames ────────────────────────────
        if frame_no % config.YOLO_INTERVAL == 0:
            results = yolo.track(
                frame,
                classes=[0, 67],
                conf=0.4,
                persist=True,
                tracker=config.TRACKER_TYPE,
                verbose=False,
                imgsz=640,
            )

            new_tracked:     dict = {}
            new_phone_boxes: list = []

            for r in results:
                for box in r.boxes:
                    cls          = int(box.cls[0])
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    conf         = float(box.conf[0])

                    if cls == 0:
                        # person: use YOLO-assigned track ID
                        tid = int(box.id[0]) if box.id is not None else None
                        if tid is not None:
                            cx = (x1 + x2) // 2
                            cy = (y1 + y2) // 2
                            new_tracked[tid] = ((cx, cy), (x1, y1, x2, y2))
                    elif cls == 67:
                        new_phone_boxes.append((x1, y1, x2, y2, conf))

            # Clean up state for IDs that disappeared
            gone = set(last_tracked) - set(new_tracked)
            for sid in gone:
                face_an.reset(sid)
                sbuf.remove(sid)
                student_states.pop(sid, None)

            last_tracked    = new_tracked
            last_phone_boxes = new_phone_boxes

        # ── per-student MediaPipe analysis (staggered) ─────────────────────────
        for sid, (centroid, bbox) in last_tracked.items():
            x1, y1, x2, y2 = bbox
            x1c = max(0, x1); y1c = max(0, y1)
            x2c = min(W, x2); y2c = min(H, y2)

            student_states[sid]['bbox']     = (x1c, y1c, x2c, y2c)
            student_states[sid]['centroid'] = centroid

            crop = frame[y1c:y2c, x1c:x2c]
            if crop.size == 0:
                continue

            # Stagger analysis across students to spread CPU
            if frame_no % config.MEDIAPIPE_INTERVAL != (sid % config.MEDIAPIPE_INTERVAL):
                continue

            # ── phone ──────────────────────────────────────────────────────────
            raw_phone = check_student_has_phone(last_phone_boxes, (x1c, y1c, x2c, y2c))
            sbuf.push(sid, 'phone', raw_phone)
            confirmed_phone = sbuf.get(sid, 'phone', False)

            if confirmed_phone and not student_states[sid].get('phone', False):
                dash.add_event(sid, 'phone')
            student_states[sid]['phone'] = confirmed_phone

            # ── face (sleep + head pose) ────────────────────────────────────────
            face = face_an.analyze(sid, crop)
            if face:
                student_states[sid]['ear']   = face['ear']
                student_states[sid]['yaw']   = face['yaw']
                student_states[sid]['pitch'] = face['pitch']

                # Sleep
                sbuf.push(sid, 'sleep', face['is_sleeping'])
                confirmed_sleep = sbuf.get(sid, 'sleep', False)
                if confirmed_sleep and not student_states[sid].get('sleep', False):
                    dash.add_event(sid, 'sleep')
                student_states[sid]['sleep'] = confirmed_sleep

                # Activity (turn / read / write / attentive)
                sbuf.push(sid, 'activity', face['activity'])
                confirmed_act = sbuf.get(sid, 'activity', 'attentive')
                prev_act = student_states[sid].get('activity', 'attentive')
                if confirmed_act != prev_act and confirmed_act != 'attentive':
                    dash.add_event(sid, confirmed_act)
                student_states[sid]['activity'] = confirmed_act
            else:
                student_states[sid].setdefault('activity', 'attentive')

            # ── hand raise (use full frame + bbox for expanded crop) ────────────
            raw_hand = hand_det.check(frame, (x1c, y1c, x2c, y2c))
            sbuf.push(sid, 'hand_raise', raw_hand)
            confirmed_hand = sbuf.get(sid, 'hand_raise', False)
            if confirmed_hand and not student_states[sid].get('hand_raise', False):
                dash.add_event(sid, 'hand_raise')
            student_states[sid]['hand_raise'] = confirmed_hand

        # ── render ─────────────────────────────────────────────────────────────
        output = dash.render(frame, student_states, fps)
        cv2.imshow('Classroom Monitor', output)

        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            break
        elif key == ord('s'):
            fname = time.strftime('screenshot_%Y%m%d_%H%M%S.jpg')
            cv2.imwrite(fname, output)
            print(f"[INFO] Saved {fname}")
        elif key == ord('r'):
            for sid in list(last_tracked):
                face_an.reset(sid)
                sbuf.remove(sid)
            last_tracked.clear()
            student_states.clear()
            print("[INFO] Tracker reset")

    cap.release()
    cv2.destroyAllWindows()
    print("[INFO] Done.")


if __name__ == '__main__':
    main()
