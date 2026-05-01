import threading

import cv2
import os
import numpy as np
import time
from datetime import datetime
import sys
sys.path.append('..')
from database import attendence_db as adb

# Optional: prefer face_recognition (dlib), but fall back to OpenCV LBPH if unavailable
try:
    import face_recognition
    USE_FACE_RECOGNITION = True
except Exception:
    USE_FACE_RECOGNITION = False

try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except Exception:
    HAS_MEDIAPIPE = False

class FaceRecognizer(threading.Thread):
    """Runs face recognition (dlib) or OpenCV LBPH fallback in a background thread.

    Improvements:
      - Use `cnn` detector for higher accuracy (configurable)
      - Use distance-based matching with configurable tolerance
      - Require multiple consecutive frames of same match before marking attendance
      - Skip tiny faces to reduce false positives

    Attributes:
        latest_faces: list of dicts {name, bbox, area, center}
        marked: set of names already marked present
    """

    def __init__(
        self,
        known_dir=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "faces"),
        camera_index=0,
        display=True,
        lbph_confidence_thresh=70,
        detection_model='hog',  # Changed from 'cnn' to 'hog' for much faster detection
        detection_upsample=1,
        tolerance=0.6,
        min_face_area=2000,
        confirm_frames=3,
        process_every_n_frames=2,  # Process every Nth frame to reduce lag
        resize_scale=0.75,  # Resize frame for faster processing
        use_mediapipe=True,
        use_profile_cascade=True,
        face_encoding_jitters=1,
        identity_timeout=8.0,
        enable_tracking=True,
    ):
        super().__init__(daemon=True)
        self.known_dir = known_dir
        self.latest_faces = []
        self.marked = set()
        self._lock = threading.Lock()
        self.camera_index = camera_index
        self.display = display
        self.running = False

        self.use_fr = USE_FACE_RECOGNITION

        # LBPH-related
        self.lbph_confidence_thresh = lbph_confidence_thresh
        self.recognizer = None
        self.label2name = {}

        # New parameters for improved matching
        self.detection_model = detection_model  # 'hog' or 'cnn'
        self.detection_upsample = detection_upsample
        self.tolerance = tolerance  # max distance for a positive match (lower = stricter)
        self.min_face_area = min_face_area  # ignore tiny faces
        self.confirm_frames = confirm_frames  # consecutive frames required to confirm attendance
        self.face_encoding_jitters = face_encoding_jitters
        from collections import defaultdict
        self._confirm_counts = defaultdict(int)

        # Performance tuning
        self.process_every_n_frames = process_every_n_frames
        self.resize_scale = resize_scale
        self._frame_count = 0

        # Identity persistence - remember last known identity for temporary occlusions
        self._last_known_name = "Unknown"
        self._last_detection_time = 0
        self._identity_timeout = identity_timeout  # seconds to keep identity when face not detected
        self.enable_tracking = enable_tracking
        self._tracker = None
        self._tracker_name = "Unknown"
        self._tracker_bbox = None  # OpenCV format: x, y, w, h
        self._tracker_last_update = 0
        self._mp_face_detection = None
        self._profile_detector = None

        if self.use_fr and use_mediapipe and HAS_MEDIAPIPE:
            try:
                self._mp_face_detection = mp.solutions.face_detection.FaceDetection(
                    model_selection=1,
                    min_detection_confidence=0.45,
                )
                print("MediaPipe face detector enabled for angled/partial faces.")
            except Exception as e:
                print("MediaPipe face detector unavailable:", e)
                self._mp_face_detection = None

        if self.use_fr and use_profile_cascade:
            profile_path = cv2.data.haarcascades + "haarcascade_profileface.xml"
            self._profile_detector = cv2.CascadeClassifier(profile_path)
            if self._profile_detector.empty():
                self._profile_detector = None

        if self.use_fr:
            # load known faces with face_recognition (either from filesystem or MongoDB)
            self.known_encodings = []
            self.known_names = []

            try:
                from config import USE_MONGO
                if USE_MONGO:
                    from database import mongo_db as mdb
                    docs = mdb.get_faces_for_training()
                    for item in docs:
                        name = item.get("name")
                        img = item.get("img")  # BGR or gray
                        try:
                            if img.ndim == 2:
                                rgb = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
                            else:
                                rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                            enc = face_recognition.face_encodings(rgb)
                            if enc:
                                self.known_encodings.append(enc[0])
                                self.known_names.append(name)
                        except Exception:
                            continue
                else:
                    for student in os.listdir(self.known_dir):
                        student_dir = os.path.join(self.known_dir, student)
                        if not os.path.isdir(student_dir):
                            continue
                        for img in os.listdir(student_dir):
                            path = os.path.join(student_dir, img)
                            try:
                                image = face_recognition.load_image_file(path)
                                # Ensure RGB (saved images may be grayscale)
                                if image.ndim == 2:
                                    image = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
                                elif image.shape[2] == 1:
                                    image = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
                                # Images are pre-cropped faces (200x200), so pass the
                                # full image as the face location to skip re-detection
                                h, w = image.shape[:2]
                                known_locations = [(0, w, h, 0)]  # top, right, bottom, left
                                encoding = face_recognition.face_encodings(
                                    image,
                                    known_face_locations=known_locations,
                                    num_jitters=max(1, self.face_encoding_jitters),
                                )
                                if encoding:
                                    self.known_encodings.append(encoding[0])
                                    self.known_names.append(student)
                            except Exception:
                                continue

                print(f"Using dlib/face_recognition for face matching. Loaded {len(self.known_encodings)} encodings for: {list(set(self.known_names))}")
            except Exception as e:
                print("Error loading faces for face_recognition:", e)
                # fall back to filesystem load
                self.known_encodings = []
                self.known_names = []

        else:
            # fallback: train LBPH on available images
            print("face_recognition not available; using OpenCV LBPH fallback.")
            cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            self.detector = cv2.CascadeClassifier(cascade_path)

            self._train_lbph()

    def _train_lbph(self):
        images = []
        labels = []
        name_to_label = {}
        label = 0

        try:
            from config import USE_MONGO
        except Exception:
            USE_MONGO = False

        if USE_MONGO:
            try:
                from database import mongo_db as mdb
                docs = mdb.get_faces_for_training()
                for item in docs:
                    name = item.get("name")
                    img = item.get("img")
                    if img is None:
                        continue
                    # ensure grayscale
                    if img.ndim == 3:
                        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                    else:
                        gray = img
                    try:
                        roi = cv2.resize(gray, (200, 200))
                    except Exception:
                        roi = gray

                    if name not in name_to_label:
                        name_to_label[name] = label
                        self.label2name[label] = name
                        label += 1
                    images.append(roi)
                    labels.append(name_to_label[name])
            except Exception as e:
                print("LBPH mongo training failed:", e)
                USE_MONGO = False

        if not USE_MONGO:
            for student in os.listdir(self.known_dir):
                student_dir = os.path.join(self.known_dir, student)
                if not os.path.isdir(student_dir):
                    continue
                name_to_label[student] = label
                self.label2name[label] = student

                for img in os.listdir(student_dir):
                    path = os.path.join(student_dir, img)
                    try:
                        im = cv2.imread(path)
                        gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
                        faces = self.detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4)
                        for (x, y, w, h) in faces:
                            roi = gray[y:y+h, x:x+w]
                            roi = cv2.resize(roi, (200, 200))
                            images.append(roi)
                            labels.append(label)
                    except Exception:
                        continue

                label += 1

        if not images:
            print("LBPH training: no faces found in data; recognizer disabled.")
            self.recognizer = None
            return

        try:
            self.recognizer = cv2.face.LBPHFaceRecognizer_create()
        except Exception:
            print("OpenCV 'face' module not available. Install 'opencv-contrib-python' to enable LBPH fallback.")
            self.recognizer = None
            return

        self.recognizer.train(images, np.array(labels))
        print(f"Trained LBPH recognizer on {len(images)} face samples.")

    def _clip_location(self, loc, frame_shape):
        top, right, bottom, left = loc
        h, w = frame_shape[:2]
        top = max(0, min(h - 1, int(top)))
        bottom = max(0, min(h, int(bottom)))
        left = max(0, min(w - 1, int(left)))
        right = max(0, min(w, int(right)))
        if bottom <= top or right <= left:
            return None
        return (top, right, bottom, left)

    def _expand_location(self, loc, frame_shape, amount=0.18):
        top, right, bottom, left = loc
        width = right - left
        height = bottom - top
        pad_x = int(width * amount)
        pad_y = int(height * amount)
        return self._clip_location((top - pad_y, right + pad_x, bottom + pad_y, left - pad_x), frame_shape)

    def _location_area(self, loc):
        top, right, bottom, left = loc
        return max(0, right - left) * max(0, bottom - top)

    def _location_iou(self, a, b):
        at, ar, ab, al = a
        bt, br, bb, bl = b
        inter_left = max(al, bl)
        inter_top = max(at, bt)
        inter_right = min(ar, br)
        inter_bottom = min(ab, bb)
        inter_area = max(0, inter_right - inter_left) * max(0, inter_bottom - inter_top)
        if inter_area == 0:
            return 0.0
        union = self._location_area(a) + self._location_area(b) - inter_area
        return inter_area / union if union else 0.0

    def _loc_to_tracker_bbox(self, loc):
        top, right, bottom, left = loc
        return (int(left), int(top), int(right - left), int(bottom - top))

    def _tracker_bbox_to_loc(self, bbox, frame_shape):
        x, y, w, h = bbox
        return self._clip_location((y, x + w, y + h, x), frame_shape)

    def _create_tracker(self):
        tracker_names = ("TrackerCSRT_create", "TrackerKCF_create", "TrackerMIL_create")
        for name in tracker_names:
            creator = getattr(cv2, name, None)
            if creator:
                try:
                    return creator()
                except Exception:
                    pass
        legacy = getattr(cv2, "legacy", None)
        if legacy:
            for name in tracker_names:
                creator = getattr(legacy, name, None)
                if creator:
                    try:
                        return creator()
                    except Exception:
                        pass
        return None

    def _start_identity_tracker(self, frame, name, loc):
        if not self.enable_tracking or name == "Unknown":
            return
        tracker = self._create_tracker()
        if tracker is None:
            return
        bbox = self._loc_to_tracker_bbox(loc)
        try:
            ok = tracker.init(frame, bbox)
        except Exception:
            ok = False
        if ok is None or ok:
            self._tracker = tracker
            self._tracker_name = name
            self._tracker_bbox = bbox
            self._tracker_last_update = time.time()

    def _tracked_face_info(self, frame):
        if not self.enable_tracking or self._tracker is None or self._tracker_name == "Unknown":
            return None
        if time.time() - self._last_detection_time > self._identity_timeout:
            self._tracker = None
            return None
        try:
            ok, bbox = self._tracker.update(frame)
        except Exception:
            self._tracker = None
            return None
        if not ok:
            self._tracker = None
            return None

        loc = self._tracker_bbox_to_loc(tuple(int(v) for v in bbox), frame.shape)
        if not loc:
            self._tracker = None
            return None
        top, right, bottom, left = loc
        area = (right - left) * (bottom - top)
        if area < self.min_face_area:
            return None
        self._tracker_bbox = self._loc_to_tracker_bbox(loc)
        self._tracker_last_update = time.time()
        return {
            "name": self._tracker_name,
            "bbox": loc,
            "area": area,
            "center": ((left + right) // 2, (top + bottom) // 2),
            "tracked": True,
        }

    def _dedupe_locations(self, locations):
        unique = []
        for loc in sorted(locations, key=self._location_area, reverse=True):
            if all(self._location_iou(loc, existing) < 0.35 for existing in unique):
                unique.append(loc)
        return unique

    def _mediapipe_locations(self, frame):
        if self._mp_face_detection is None:
            return []

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = self._mp_face_detection.process(rgb)
        if not result.detections:
            return []

        h, w = frame.shape[:2]
        locations = []
        for detection in result.detections:
            bbox = detection.location_data.relative_bounding_box
            left = int(bbox.xmin * w)
            top = int(bbox.ymin * h)
            right = int((bbox.xmin + bbox.width) * w)
            bottom = int((bbox.ymin + bbox.height) * h)
            loc = self._expand_location((top, right, bottom, left), frame.shape)
            if loc:
                locations.append(loc)
        return locations

    def _profile_locations(self, frame):
        if self._profile_detector is None:
            return []

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        min_side = max(45, min(frame.shape[:2]) // 10)
        locations = []

        faces = self._profile_detector.detectMultiScale(
            gray, scaleFactor=1.08, minNeighbors=3, minSize=(min_side, min_side)
        )
        for (x, y, w, h) in faces:
            loc = self._expand_location((y, x + w, y + h, x), frame.shape, amount=0.22)
            if loc:
                locations.append(loc)

        flipped = cv2.flip(gray, 1)
        flipped_faces = self._profile_detector.detectMultiScale(
            flipped, scaleFactor=1.08, minNeighbors=3, minSize=(min_side, min_side)
        )
        frame_w = frame.shape[1]
        for (x, y, w, h) in flipped_faces:
            left = frame_w - x - w
            loc = self._expand_location((y, left + w, y + h, left), frame.shape, amount=0.22)
            if loc:
                locations.append(loc)

        return locations

    def _detect_face_locations(self, frame):
        locations = []

        if self.resize_scale and self.resize_scale != 1.0:
            small_frame = cv2.resize(frame, (0, 0), fx=self.resize_scale, fy=self.resize_scale)
            rgb_small = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
            small_locations = face_recognition.face_locations(
                rgb_small,
                number_of_times_to_upsample=self.detection_upsample,
                model=self.detection_model,
            )
            scale = 1.0 / self.resize_scale
            locations.extend(
                self._clip_location((t * scale, r * scale, b * scale, l * scale), frame.shape)
                for (t, r, b, l) in small_locations
            )
        else:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            locations.extend(face_recognition.face_locations(
                rgb,
                number_of_times_to_upsample=self.detection_upsample,
                model=self.detection_model,
            ))

        locations.extend(self._mediapipe_locations(frame))
        locations.extend(self._profile_locations(frame))
        locations = [loc for loc in locations if loc is not None]
        return self._dedupe_locations(locations)

    def run(self):
        cap = cv2.VideoCapture(self.camera_index)
        self.running = True

        # Cache for last detected faces (used when skipping frames)
        cached_locations = []

        while self.running:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.01)
                continue

            self._frame_count += 1
            faces_info = []

            # Only process every Nth frame for face detection
            should_process = (self._frame_count % self.process_every_n_frames == 0)

            if self.use_fr:
                if should_process:
                    # Detect on resized/auxiliary detectors, then encode from
                    # the original frame so angled faces keep more landmark detail.
                    locations = self._detect_face_locations(frame)
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    encodings = face_recognition.face_encodings(
                        rgb,
                        locations,
                        num_jitters=max(1, self.face_encoding_jitters),
                    )
                    cached_locations = list(zip(encodings, locations))
                else:
                    # Use cached results but still draw on current frame
                    locations = []
                    encodings = []
                    for enc, loc in cached_locations:
                        encodings.append(enc)
                        locations.append(loc)

                seen_names_this_frame = set()
                for enc, loc in zip(encodings, locations):
                    top, right, bottom, left = loc
                    area = (right - left) * (bottom - top)
                    if area < self.min_face_area:
                        # skip tiny faces to reduce false positives
                        continue

                    name = "Unknown"
                    # distance-based matching (choose smallest distance)
                    if self.known_encodings:
                        distances = face_recognition.face_distance(self.known_encodings, enc)
                        best_idx = int(np.argmin(distances))
                        best_dist = float(distances[best_idx])
                        if best_dist <= self.tolerance:
                            name = self.known_names[best_idx]

                    center = ((left + right) // 2, (top + bottom) // 2)
                    faces_info.append({"name": name, "bbox": loc, "area": area, "center": center})

                    # record seen names for per-frame confirmation
                    if name != "Unknown":
                        seen_names_this_frame.add(name)
                        # Update last known identity cache
                        self._last_known_name = name
                        self._last_detection_time = time.time()
                        self._start_identity_tracker(frame, name, loc)

                    if self.display:
                        label = name
                        if name != "Unknown" and self.known_encodings:
                            label = f"{name} ({best_dist:.2f})"
                        cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)
                        cv2.putText(frame, label, (left, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

                # If the detector loses an angled/covered face, keep following the
                # last confirmed face with an OpenCV tracker for a short window.
                if not faces_info and self._last_known_name != "Unknown":
                    tracked_face = self._tracked_face_info(frame)
                    if tracked_face:
                        faces_info.append(tracked_face)
                        seen_names_this_frame.add(tracked_face["name"])
                        if self.display:
                            top, right, bottom, left = tracked_face["bbox"]
                            cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 255), 2)
                            cv2.putText(
                                frame,
                                f"{tracked_face['name']} (tracked)",
                                (left, top - 10),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.8,
                                (0, 255, 255),
                                2,
                            )

                # If tracking is unavailable, use cached identity within timeout period.
                if not faces_info and self._last_known_name != "Unknown":
                    elapsed = time.time() - self._last_detection_time
                    if elapsed < self._identity_timeout:
                        # Add a virtual face entry with the cached identity
                        faces_info.append({
                            "name": self._last_known_name,
                            "bbox": (0, 0, 0, 0),  # No bbox since face not visible
                            "area": 0,
                            "center": (0, 0),
                            "cached": True  # Flag to indicate this is from cache
                        })
                        seen_names_this_frame.add(self._last_known_name)

                # Simple multi-frame confirmation: increment counters for names seen, reset others
                for n in seen_names_this_frame:
                    self._confirm_counts[n] += 1
                # reset counts for names not seen in this frame
                for n in list(self._confirm_counts.keys()):
                    if n not in seen_names_this_frame:
                        self._confirm_counts[n] = 0

                # mark attendance only when a name has been seen in `confirm_frames` consecutive frames
                for n, cnt in list(self._confirm_counts.items()):
                    if cnt >= self.confirm_frames and n not in self.marked:
                        adb.mark_attendance(n)
                        print(f"{n} marked present at {datetime.now().isoformat()} (confirmed {cnt} frames)")
                        self.marked.add(n)
                        # optional: keep count at max to avoid re-triggering
                        self._confirm_counts[n] = self.confirm_frames
            else:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = self.detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4)
                for (x, y, w, h) in faces:
                    roi = gray[y:y+h, x:x+w]
                    try:
                        roi_resized = cv2.resize(roi, (200, 200))
                    except Exception:
                        continue

                    name = "Unknown"
                    confidence = None
                    if self.recognizer is not None:
                        try:
                            label, confidence = self.recognizer.predict(roi_resized)
                            # lower confidence = better match for LBPH
                            if confidence <= self.lbph_confidence_thresh and label in self.label2name:
                                name = self.label2name[label]
                        except Exception:
                            name = "Unknown"

                    area = w * h
                    center = (x + w // 2, y + h // 2)
                    bbox = (y, x + w, y + h, x)  # top,right,bottom,left to match dlib style

                    faces_info.append({"name": name, "bbox": bbox, "area": area, "center": center})

                    if name != "Unknown" and name not in self.marked:
                        adb.mark_attendance(name)
                        print(f"{name} marked present at {datetime.now().isoformat()} (confidence={confidence})")
                        self.marked.add(name)

                    if self.display:
                        cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
                        label_str = name
                        if confidence is not None:
                            label_str = f"{name} ({confidence:.1f})"
                        cv2.putText(frame, label_str, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

            with self._lock:
                self.latest_faces = faces_info

            if self.display:
                cv2.imshow("Attendance", frame)
                key = cv2.waitKey(1)
                if key == 27:  # ESC key
                    break
                if key == ord('r'):
                    print("Retraining LBPH recognizer...")
                    self._train_lbph()
                    print("Retraining complete.")

        cap.release()
        if self._mp_face_detection is not None:
            try:
                self._mp_face_detection.close()
            except Exception:
                pass
        if self.display:
            cv2.destroyAllWindows()

    def get_latest_faces(self):
        with self._lock:
            return list(self.latest_faces)


if __name__ == "__main__":
    fr = FaceRecognizer()
    fr.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        fr.running = False
        fr.join()

