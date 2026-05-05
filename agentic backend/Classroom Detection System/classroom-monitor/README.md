# Classroom Monitor

AI-based student behaviour monitoring system for a single classroom camera.
Detects: **phone use · sleep · turn left/right · reading · hand raise**
Tracks up to 40 students simultaneously with persistent IDs.

---

## Setup

```bash
pip install -r requirements.txt
python main.py
```

YOLOv8n weights (`yolov8n.pt`) are downloaded automatically on first run.

---

## How it works

```
Camera feed
    │
    ▼
YOLOv8n  ──►  person boxes  ──►  CentroidTracker  ──►  student ID + bbox
         ──►  phone boxes   ──┐
                              │
         Per-student crop ◄───┘
              │
    ┌─────────┼──────────────────┐
    ▼         ▼                  ▼
SleepDet  HeadPoseDet       HandRaiseDet
(EAR)    (solvePnP yaw/pitch) (wrist vs shoulder)
    │         │                  │
    └────────►│◄─────────────────┘
              ▼
          Dashboard
    (overlay + sidebar + event log)
```

| Behaviour    | Method                                    |
|--------------|-------------------------------------------|
| Phone        | YOLO class 67 overlap with student bbox   |
| Sleep        | Eye Aspect Ratio < 0.25 for 20 frames     |
| Turn left    | Head yaw < −25°                           |
| Turn right   | Head yaw > +25°                           |
| Reading      | Head pitch < −20° (looking down)          |
| Hand raise   | Wrist landmark > 0.12 units above shoulder|

---

## Hotkeys

| Key | Action                          |
|-----|---------------------------------|
| `q` | Quit                            |
| `s` | Save screenshot to current dir  |
| `r` | Reset tracker (reassign IDs)    |

---

## Tuning

All thresholds live in `config.py`:

| Variable                   | Default | Effect                                 |
|----------------------------|---------|----------------------------------------|
| `EAR_THRESHOLD`            | 0.25    | Lower → less sensitive to closed eyes  |
| `EAR_CONSEC_FRAMES`        | 20      | Higher → longer blink needed for SLEEP |
| `HEAD_YAW_THRESHOLD`       | 25°     | Higher → only flag extreme turns       |
| `HEAD_PITCH_READ_THRESHOLD`| −20°    | More negative → only flag deep bows    |
| `HAND_RAISE_THRESHOLD`     | 0.12    | Higher → only flag fully raised arms   |
| `YOLO_INTERVAL`            | 3       | Higher → faster but slower re-detect   |

---

## Performance tips

- Use a GPU if available — YOLOv8 and MediaPipe both benefit.
- Lower `FRAME_WIDTH / FRAME_HEIGHT` in `config.py` for slower hardware.
- Increase `YOLO_INTERVAL` (e.g. 5) to reduce CPU load.
- Mount the camera high (≥2 m) and angled down for best coverage of 30-40 seats.
