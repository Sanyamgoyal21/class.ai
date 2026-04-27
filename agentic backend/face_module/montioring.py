import face_recognition
import os
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

# ==============================
# STEP 1: LOAD DATASET + ENCODE
# ==============================

dataset_path = "data/faces"

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

    face_locations = face_recognition.face_locations(rgb)
    face_encodings_list = face_recognition.face_encodings(rgb, face_locations)

    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    detection_result = face_landmarker.detect(mp_image)

    for (top, right, bottom, left), face_encoding in zip(face_locations, face_encodings_list):

        matches = face_recognition.compare_faces(known_encodings, face_encoding)
        name = "Unknown"

        face_distances = face_recognition.face_distance(known_encodings, face_encoding)

        if len(face_distances) > 0:
            best_match_index = np.argmin(face_distances)
            if matches[best_match_index]:
                name = known_names[best_match_index]

        behavior = "Detecting..."

        if detection_result.face_landmarks:
            behavior = get_head_direction(detection_result.face_landmarks[0])

        # Draw box
        cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)

        # Show label
        cv2.putText(frame, f"{name} | {behavior}",
                    (left, top - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (0, 255, 0), 2)

    cv2.imshow("Class.ai", frame)

    if cv2.waitKey(1) & 0xFF == 27:
        break

cap.release()
cv2.destroyAllWindows()
