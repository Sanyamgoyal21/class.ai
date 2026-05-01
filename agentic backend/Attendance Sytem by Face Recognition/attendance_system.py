import os
import re
import tkinter as tk
from datetime import datetime

import cv2
import face_recognition
import numpy as np
import pandas as pd


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_PATH = os.path.join(BASE_DIR, "dataset")
FACE_MATCH_TOLERANCE = 0.55

FRONTAL_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
PROFILE_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")


def display_name_from_file(file_name):
    name = os.path.splitext(file_name)[0]
    return re.sub(r"_\d+$", "", name)


def clamp_location(top, right, bottom, left, height, width):
    return (
        max(top, 0),
        min(right, width),
        min(bottom, height),
        max(left, 0),
    )


def location_iou(first, second):
    top1, right1, bottom1, left1 = first
    top2, right2, bottom2, left2 = second

    inter_left = max(left1, left2)
    inter_top = max(top1, top2)
    inter_right = min(right1, right2)
    inter_bottom = min(bottom1, bottom2)

    if inter_right <= inter_left or inter_bottom <= inter_top:
        return 0

    intersection = (inter_right - inter_left) * (inter_bottom - inter_top)
    first_area = (right1 - left1) * (bottom1 - top1)
    second_area = (right2 - left2) * (bottom2 - top2)
    return intersection / float(first_area + second_area - intersection)


def add_location(locations, location, min_iou=0.35):
    if all(location_iou(location, existing) < min_iou for existing in locations):
        locations.append(location)


def cascade_locations(gray_frame, cascade, flipped=False):
    height, width = gray_frame.shape[:2]
    source = cv2.flip(gray_frame, 1) if flipped else gray_frame
    detections = cascade.detectMultiScale(source, scaleFactor=1.08, minNeighbors=4, minSize=(45, 45))
    locations = []

    for x, y, w, h in detections:
        if flipped:
            left = width - (x + w)
            right = width - x
        else:
            left = x
            right = x + w

        locations.append(clamp_location(y, right, y + h, left, height, width))

    return locations



def detect_face_locations(frame):
    height, width = frame.shape[:2]
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray_frame = cv2.equalizeHist(gray_frame)
    locations = []

    for location in face_recognition.face_locations(rgb_frame, number_of_times_to_upsample=1, model="hog"):
        add_location(locations, clamp_location(*location, height, width))

    for location in cascade_locations(gray_frame, FRONTAL_FACE_CASCADE):
        add_location(locations, location)

    for location in cascade_locations(gray_frame, PROFILE_FACE_CASCADE):
        add_location(locations, location)

    for location in cascade_locations(gray_frame, PROFILE_FACE_CASCADE, flipped=True):
        add_location(locations, location)


    return locations


def load_known_faces():
    known_face_encodings = []
    known_face_names = []

    os.makedirs(DATASET_PATH, exist_ok=True)

    for file_name in os.listdir(DATASET_PATH):
        if not file_name.lower().endswith((".jpg", ".jpeg", ".png")):
            continue

        image_path = os.path.join(DATASET_PATH, file_name)
        image = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(image)

        if not encodings:
            print(f"No face found in dataset image: {file_name}")
            continue

        known_face_encodings.append(encodings[0])
        known_face_names.append(display_name_from_file(file_name))

    return known_face_encodings, known_face_names


known_face_encodings, known_face_names = load_known_faces()

if not known_face_names:
    print("No registered faces found.")
    print("Run capture_face.py first, save at least one face, then run attendance_system.py again.")
    raise SystemExit


def mark_attendance(name):
    filename = os.path.join(BASE_DIR, f"attendance_{datetime.now().strftime('%Y-%m-%d')}.csv")

    if not os.path.exists(filename):
        df = pd.DataFrame(columns=["Name", "Time"])
    else:
        df = pd.read_csv(filename)

    if name not in df["Name"].values:
        now = datetime.now()
        new_entry = pd.DataFrame({"Name": [name], "Time": [now.strftime('%H:%M:%S')]})
        df = pd.concat([df, new_entry], ignore_index=True)
        df.to_csv(filename, index=False)
        print(f"Attendance marked for: {name}")


def recognize_frame(frame):
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    face_locations = detect_face_locations(frame)
    detected_names = []

    for top, right, bottom, left in face_locations:
        name = "Unknown"
        encodings = face_recognition.face_encodings(rgb_frame, [(top, right, bottom, left)], num_jitters=1)

        if encodings:
            face_distances = face_recognition.face_distance(known_face_encodings, encodings[0])
            best_match_index = int(np.argmin(face_distances))

            if face_distances[best_match_index] <= FACE_MATCH_TOLERANCE:
                name = known_face_names[best_match_index]
                mark_attendance(name)

        detected_names.append(name)
        cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)
        cv2.putText(frame, name, (left, max(top - 10, 20)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    detected_name = ", ".join(detected_names) if detected_names else None
    return frame, detected_name


def frame_to_photo(frame):
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    success, encoded = cv2.imencode(".ppm", rgb_frame)

    if not success:
        return None

    return tk.PhotoImage(data=encoded.tobytes(), format="PPM")


def main():
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Could not open camera.")
        return

    root = tk.Tk()
    root.title("Face Attendance System")

    video_label = tk.Label(root)
    video_label.pack()

    status_label = tk.Label(root, text="Press Q to quit", font=("Arial", 12))
    status_label.pack(pady=8)

    def close_window(event=None):
        cap.release()
        root.destroy()

    def update_frame():
        success, frame = cap.read()

        if not success:
            close_window()
            return

        frame, detected_name = recognize_frame(frame)
        photo = frame_to_photo(frame)

        if photo is not None:
            video_label.configure(image=photo)
            video_label.image = photo

        if detected_name:
            status_label.configure(text=f"Detected: {detected_name}")

        root.after(10, update_frame)

    root.bind("q", close_window)
    root.bind("Q", close_window)
    root.protocol("WM_DELETE_WINDOW", close_window)

    update_frame()
    root.mainloop()


if __name__ == "__main__":
    main()
