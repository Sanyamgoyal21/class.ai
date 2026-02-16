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
        known_dir="data/faces",
        camera_index=0,
        display=True,
        lbph_confidence_thresh=70,
        detection_model='hog',  # Changed from 'cnn' to 'hog' for much faster detection
        tolerance=0.45,
        min_face_area=2000,
        confirm_frames=3,
        process_every_n_frames=2,  # Process every Nth frame to reduce lag
        resize_scale=0.5,  # Resize frame for faster processing
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
        self.tolerance = tolerance  # max distance for a positive match (lower = stricter)
        self.min_face_area = min_face_area  # ignore tiny faces
        self.confirm_frames = confirm_frames  # consecutive frames required to confirm attendance
        from collections import defaultdict
        self._confirm_counts = defaultdict(int)

        # Performance tuning
        self.process_every_n_frames = process_every_n_frames
        self.resize_scale = resize_scale
        self._frame_count = 0

        # Identity persistence - remember last known identity for temporary occlusions
        self._last_known_name = "Unknown"
        self._last_detection_time = 0
        self._identity_timeout = 3.0  # seconds to keep identity when face not detected

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
                                encoding = face_recognition.face_encodings(image)
                                if encoding:
                                    self.known_encodings.append(encoding[0])
                                    self.known_names.append(student)
                            except Exception:
                                continue

                print("Using dlib/face_recognition for face matching.")
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
                    # Resize frame for faster processing
                    small_frame = cv2.resize(frame, (0, 0), fx=self.resize_scale, fy=self.resize_scale)
                    rgb = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

                    # Use configured detector model
                    locations = face_recognition.face_locations(rgb, model=self.detection_model)
                    encodings = face_recognition.face_encodings(rgb, locations)

                    # Scale locations back to original frame size
                    scale = 1.0 / self.resize_scale
                    locations = [(int(t*scale), int(r*scale), int(b*scale), int(l*scale))
                                 for (t, r, b, l) in locations]
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

                    if self.display:
                        label = name
                        if name != "Unknown" and self.known_encodings:
                            label = f"{name} ({best_dist:.2f})"
                        cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)
                        cv2.putText(frame, label, (left, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

                # If no faces detected, use cached identity within timeout period
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

