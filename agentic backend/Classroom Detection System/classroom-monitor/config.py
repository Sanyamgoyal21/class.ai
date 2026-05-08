# ── Camera ─────────────────────────────────────────────────────────────────────
CAMERA_INDEX   = 0
FRAME_WIDTH    = 1280
FRAME_HEIGHT   = 720
FPS_TARGET     = 30

# ── YOLO model ──────────────────────────────────────────────────────────────────
# yolov8n.pt  → fastest, least accurate
# yolov8s.pt  → good balance (recommended)
# yolov8m.pt  → more accurate, slower
YOLO_MODEL = 'yolov8s.pt'

# ── Detection intervals (run YOLO every N frames; MediaPipe staggered) ─────────
YOLO_INTERVAL      = 3
MEDIAPIPE_INTERVAL = 2

# ── Sleep detection ─────────────────────────────────────────────────────────────
EAR_THRESHOLD     = 0.25   # Eye Aspect Ratio below this → eyes closed
EAR_CONSEC_FRAMES = 20     # consecutive low-EAR frames to trigger SLEEP

# ── Head pose ───────────────────────────────────────────────────────────────────
HEAD_YAW_THRESHOLD         =  25   # degrees; positive = turn right
HEAD_PITCH_READ_THRESHOLD  = -20   # negative = looking down → reading
HEAD_PITCH_WRITE_THRESHOLD = -30   # steeper bow = writing (pen in hand)
ANGLE_EMA_ALPHA            = 0.35  # exponential smoothing weight for angles
                                   # lower = smoother but laggier (0.2–0.5)

# ── State hysteresis ────────────────────────────────────────────────────────────
# How many consecutive detections are needed before a state is confirmed.
# Prevents single-frame false positives from triggering alerts.
STATE_CONFIRM_FRAMES = 4   # bool states  (phone, sleep, hand_raise)
ACTIVITY_CONFIRM_FRAMES = 5  # string states (turn_left, reading, …)

# ── Hand raise ──────────────────────────────────────────────────────────────────
HAND_RAISE_THRESHOLD = 0.12   # wrist must be this many norm-units above shoulder
HAND_CROP_PAD_TOP    = 0.5    # expand crop this fraction of bbox height upward
                               # so raised arms are not cropped out

# ── Phone detection ─────────────────────────────────────────────────────────────
PHONE_CONF_THRESHOLD = 0.40

# ── YOLO tracker (BoT-SORT built into ultralytics) ──────────────────────────────
TRACKER_TYPE = 'botsort.yaml'   # or 'bytetrack.yaml'

# ── Dashboard ───────────────────────────────────────────────────────────────────
DASHBOARD_WIDTH = 300

ALERT_COLORS = {
    'phone'      : (0,   0,   255),
    'sleep'      : (80,  80,  255),
    'turn_left'  : (0,   165, 255),
    'turn_right' : (0,   165, 255),
    'reading'    : (0,   230, 230),
    'writing'    : (200, 230,   0),
    'hand_raise' : (0,   220,   0),
    'attentive'  : (0,   200,   0),
}
