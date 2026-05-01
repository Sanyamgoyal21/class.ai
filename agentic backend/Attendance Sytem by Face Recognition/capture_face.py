import os
import re
import tkinter as tk

import cv2
import face_recognition



BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_PATH = os.path.join(BASE_DIR, "dataset")
FRONTAL_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
PROFILE_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")


def safe_file_name(name):
    name = name.strip()
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r"\s+", " ", name)
    return name


def frame_to_photo(frame):
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    success, encoded = cv2.imencode(".ppm", rgb_frame)

    if not success:
        return None

    return tk.PhotoImage(data=encoded.tobytes(), format="PPM")


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


def largest_face_location(frame):
    face_locations = detect_face_locations(frame)

    if not face_locations:
        return None

    return max(face_locations, key=lambda location: (location[2] - location[0]) * (location[1] - location[3]))


def next_image_path(name):
    first_path = os.path.join(DATASET_PATH, f"{name}.jpg")

    if not os.path.exists(first_path):
        return first_path

    index = 2
    while True:
        image_path = os.path.join(DATASET_PATH, f"{name}_{index}.jpg")

        if not os.path.exists(image_path):
            return image_path

        index += 1


def crop_face(frame, face_location, padding=35):
    top, right, bottom, left = face_location
    height, width = frame.shape[:2]

    top = max(top - padding, 0)
    right = min(right + padding, width)
    bottom = min(bottom + padding, height)
    left = max(left - padding, 0)

    return frame[top:bottom, left:right]


def main():
    os.makedirs(DATASET_PATH, exist_ok=True)

    name = safe_file_name(input("Enter the Name of the person: "))

    if not name:
        print("Name cannot be empty.")
        return

    cam = cv2.VideoCapture(0)

    if not cam.isOpened():
        print("Could not open camera.")
        return

    root = tk.Tk()
    root.title("Register Face")

    video_label = tk.Label(root)
    video_label.pack()

    status_label = tk.Label(root, text="Save straight, left, right, up, and down face samples", font=("Arial", 12))
    status_label.pack(pady=8)

    def close_window(event=None):
        cam.release()
        root.destroy()

    def save_image(event=None):
        success, frame = cam.read()

        if not success:
            status_label.configure(text="Could not capture image.")
            return

        face_location = largest_face_location(frame)

        if face_location is None:
            status_label.configure(text="No face found. Face the camera and try again.")
            return

        face_image = crop_face(frame, face_location)

        img_name = next_image_path(name)
        cv2.imwrite(img_name, face_image)
        print(f"Saved: {img_name}")
        status_label.configure(text="Saved. Change face angle, press S again, or press Q to quit.")

    def update_frame():
        success, frame = cam.read()

        if not success:
            close_window()
            return

        preview = frame.copy()
        face_location = largest_face_location(preview)

        if face_location is not None:
            top, right, bottom, left = face_location
            cv2.rectangle(preview, (left, top), (right, bottom), (0, 255, 0), 2)
            status_label.configure(text="Face found. Save multiple angles with S")
        else:
            status_label.configure(text="Position your face in the camera")

        photo = frame_to_photo(preview)

        if photo is not None:
            video_label.configure(image=photo)
            video_label.image = photo

        root.after(10, update_frame)

    button_frame = tk.Frame(root)
    button_frame.pack(pady=8)

    tk.Button(button_frame, text="Save", command=save_image, width=12).pack(side=tk.LEFT, padx=6)
    tk.Button(button_frame, text="Quit", command=close_window, width=12).pack(side=tk.LEFT, padx=6)

    root.bind("s", save_image)
    root.bind("S", save_image)
    root.bind("q", close_window)
    root.bind("Q", close_window)
    root.protocol("WM_DELETE_WINDOW", close_window)

    update_frame()
    root.mainloop()


if __name__ == "__main__":
    main()
