import cv2
import os

name = input("Enter student name: ")
folder = f"data/faces/{name}"
os.makedirs(folder, exist_ok=True)

# Haar cascade for face detection (used to crop faces before saving)
cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
detector = cv2.CascadeClassifier(cascade_path)

cap = cv2.VideoCapture(0)
count = len([f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))])
print(f"Starting capture for {name}. Existing samples: {count}")

print("Instructions: position face in frame; press 's' to save a cropped face; press ESC or 'q' to finish.")

while True:
    ret, frame = cap.read()
    if not ret:
        break

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80))

    # show the largest face (if multiple)
    if len(faces) > 0:
        faces = sorted(faces, key=lambda r: r[2]*r[3], reverse=True)
        (x, y, w, h) = faces[0]
        cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
        cv2.putText(frame, "Press 's' to save", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,255,0), 2)

    cv2.imshow("Register Face", frame)
    key = cv2.waitKey(1) & 0xFF

    if key == ord('s') and len(faces) > 0:
        x, y, w, h = faces[0]
        roi = gray[y:y+h, x:x+w]
        try:
            face_img = cv2.resize(roi, (200, 200))
        except Exception:
            face_img = roi
        filename = os.path.join(folder, f"{count}.jpg")
        cv2.imwrite(filename, face_img)
        count += 1
        print("Saved cropped face:", filename)

    if key == 27 or key == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
print(f"Finished. Total samples for {name}: {count}")
