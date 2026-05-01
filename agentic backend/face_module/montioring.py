import face_recognition
import os
import cv2
import numpy as np
import time
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
from recognize_faces import FaceRecognizer

# ==============================
# STEP 1: LOAD DATASET + ENCODE
# ==============================

dataset_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "faces")

known_encodings = []
known_names = []

for person in os.listdir(dataset_path):
    person_path = os.path.join(dataset_path, person)

    for img_name in os.listdir(person_path):
        img_path = os.path.join(person_path, img_name)
        image = cv2.imread(img_path)
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        encodings = face_recognition.face_encodings(rgb)

        if encodings:
            known_encodings.append(encodings[0])
            known_names.append(person)

print("Encoding Complete!")

# Reuse the stronger detector from recognize_faces.py so monitoring and
# attendance behave consistently for side angles and partial occlusions.
recognition_helper = FaceRecognizer(
    known_dir=dataset_path,
    display=False,
    enable_tracking=True,
    identity_timeout=8.0,
)
if recognition_helper.known_encodings:
    known_encodings = recognition_helper.known_encodings
    known_names = recognition_helper.known_names

# ==============================
# STEP 2: MEDIAPIPE INIT (Tasks API)
# ==============================

base_options = mp_python.BaseOptions(model_asset_path="face_landmarker.task")
options = mp_vision.FaceLandmarkerOptions(base_options=base_options, num_faces=1)
face_landmarker = mp_vision.FaceLandmarker.create_from_options(options)

def get_head_direction(face_landmarks):
    nose = face_landmarks[1]  # index 1 = nose tip

    if nose.y > 0.6:
        return "Looking Down"
    elif nose.x < 0.3:
        return "Looking Left"
    elif nose.x > 0.7:
        return "Looking Right"
    else:
        return "Attentive"

# ==============================
# STEP 3: CAMERA START
# ==============================

cap = cv2.VideoCapture(0)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    face_locations = recognition_helper._detect_face_locations(frame)
    face_encodings_list = face_recognition.face_encodings(
        rgb,
        face_locations,
        num_jitters=max(1, recognition_helper.face_encoding_jitters),
    )

    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    detection_result = face_landmarker.detect(mp_image)

    visible_faces = []

    for (top, right, bottom, left), face_encoding in zip(face_locations, face_encodings_list):

        matches = face_recognition.compare_faces(known_encodings, face_encoding)
        name = "Unknown"

        face_distances = face_recognition.face_distance(known_encodings, face_encoding)

        if len(face_distances) > 0:
            best_match_index = np.argmin(face_distances)
            if face_distances[best_match_index] <= recognition_helper.tolerance:
                name = known_names[best_match_index]

        behavior = "Detecting..."

        if detection_result.face_landmarks:
            behavior = get_head_direction(detection_result.face_landmarks[0])

        # Draw box
        cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)
        if name != "Unknown":
            recognition_helper._last_known_name = name
            recognition_helper._last_detection_time = time.time()
            recognition_helper._start_identity_tracker(frame, name, (top, right, bottom, left))
            visible_faces.append(name)

        # Show label
        cv2.putText(frame, f"{name} | {behavior}",
                    (left, top - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (0, 255, 0), 2)

    if not visible_faces:
        tracked_face = recognition_helper._tracked_face_info(frame)
        if tracked_face:
            top, right, bottom, left = tracked_face["bbox"]
            name = tracked_face["name"]
            cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 255), 2)
            cv2.putText(frame, f"{name} | tracked",
                        (left, top - 10),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6, (0, 255, 255), 2)

    cv2.imshow("Class.ai", frame)

    if cv2.waitKey(1) & 0xFF == 27:
        break

cap.release()
cv2.destroyAllWindows()
