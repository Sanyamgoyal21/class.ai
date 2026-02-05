import cv2
import os

# Try to use face_recognition (dlib) for better angle detection
try:
    import face_recognition
    USE_DLIB = True
    print("Using dlib/face_recognition for better angle detection")
except ImportError:
    USE_DLIB = False
    print("Using Haar cascade (frontal faces only)")

name = input("Enter student name: ")
folder = f"data/faces/{name}"
os.makedirs(folder, exist_ok=True)

# Haar cascade fallback
cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
haar_detector = cv2.CascadeClassifier(cascade_path)

# Also load profile face cascade for side views
profile_cascade_path = cv2.data.haarcascades + "haarcascade_profileface.xml"
profile_detector = cv2.CascadeClassifier(profile_cascade_path)

cap = cv2.VideoCapture(0)
count = len([f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))])
print(f"Starting capture for {name}. Existing samples: {count}")

print("Instructions:")
print("  's' - Save detected face")
print("  'm' - Manual save (center region, use when face not detected)")
print("  ESC or 'q' - Finish")

while True:
    ret, frame = cap.read()
    if not ret:
        break

    display_frame = frame.copy()
    face_detected = False
    face_region = None

    if USE_DLIB:
        # Use dlib - much better at detecting faces from different angles
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        # Use 'hog' model for speed, detects various angles
        locations = face_recognition.face_locations(rgb, model='hog')

        if locations:
            face_detected = True
            # Get the largest face
            largest = max(locations, key=lambda loc: (loc[2] - loc[0]) * (loc[1] - loc[3]))
            top, right, bottom, left = largest
            face_region = (left, top, right - left, bottom - top)

            # Draw rectangle
            cv2.rectangle(display_frame, (left, top), (right, bottom), (0, 255, 0), 2)
            cv2.putText(display_frame, "Face detected - press 's'", (10, 30),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    if not face_detected:
        # Fallback to Haar cascades
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # Try frontal face first
        faces = haar_detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))

        # If no frontal face, try profile (side view)
        if len(faces) == 0:
            faces = profile_detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
            # Also try flipped frame for other side profile
            if len(faces) == 0:
                flipped = cv2.flip(gray, 1)
                faces_flipped = profile_detector.detectMultiScale(flipped, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
                if len(faces_flipped) > 0:
                    # Adjust coordinates for flipped frame
                    h, w = gray.shape
                    faces = [(w - x - fw, y, fw, fh) for (x, y, fw, fh) in faces_flipped]

        if len(faces) > 0:
            face_detected = True
            faces = sorted(faces, key=lambda r: r[2]*r[3], reverse=True)
            face_region = faces[0]
            x, y, w, h = face_region
            cv2.rectangle(display_frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
            cv2.putText(display_frame, "Face detected - press 's'", (10, 30),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    if not face_detected:
        # Show manual capture hint with center region guide
        h, w = frame.shape[:2]
        cx, cy = w // 2, h // 2
        size = min(w, h) // 3
        x1, y1 = cx - size, cy - size
        x2, y2 = cx + size, cy + size
        cv2.rectangle(display_frame, (x1, y1), (x2, y2), (0, 165, 255), 2)
        cv2.putText(display_frame, "No face detected - press 'm' for manual save", (10, 30),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)

    # Show sample count
    cv2.putText(display_frame, f"Samples: {count}", (10, frame.shape[0] - 20),
               cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    cv2.imshow("Register Face", display_frame)
    key = cv2.waitKey(1) & 0xFF

    # Save detected face
    if key == ord('s') and face_detected and face_region is not None:
        x, y, w, h = face_region
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        roi = gray[y:y+h, x:x+w]
        try:
            face_img = cv2.resize(roi, (200, 200))
        except Exception:
            face_img = roi
        filename = os.path.join(folder, f"{count}.jpg")
        cv2.imwrite(filename, face_img)

        # Also save to MongoDB if enabled
        try:
            from config import USE_MONGO
            if USE_MONGO:
                from database import mongo_db as mdb
                ok, buf = cv2.imencode('.jpg', face_img)
                if ok:
                    mdb.save_face(name, os.path.basename(filename), buf.tobytes())
                    print("Saved face to MongoDB for", name)
        except Exception as e:
            print("Mongo save failed:", e)

        count += 1
        print(f"Saved detected face: {filename}")

    # Manual save - center region when detection fails
    if key == ord('m'):
        h, w = frame.shape[:2]
        cx, cy = w // 2, h // 2
        size = min(w, h) // 3
        x1, y1 = max(0, cx - size), max(0, cy - size)
        x2, y2 = min(w, cx + size), min(h, cy + size)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        roi = gray[y1:y2, x1:x2]
        try:
            face_img = cv2.resize(roi, (200, 200))
        except Exception:
            face_img = roi
        filename = os.path.join(folder, f"{count}.jpg")
        cv2.imwrite(filename, face_img)

        # Also save to MongoDB if enabled
        try:
            from config import USE_MONGO
            if USE_MONGO:
                from database import mongo_db as mdb
                ok, buf = cv2.imencode('.jpg', face_img)
                if ok:
                    mdb.save_face(name, os.path.basename(filename), buf.tobytes())
                    print("Saved face to MongoDB for", name)
        except Exception as e:
            print("Mongo save failed:", e)

        count += 1
        print(f"Saved manual capture: {filename}")

    if key == 27 or key == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
print(f"Finished. Total samples for {name}: {count}")
