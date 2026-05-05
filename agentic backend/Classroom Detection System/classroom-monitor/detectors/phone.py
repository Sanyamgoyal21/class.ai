"""
Phone detector using YOLOv8.
COCO class 67 = 'cell phone'.
The main loop passes its own YOLO model to avoid loading it twice.
"""


def check_student_has_phone(phone_boxes: list, student_bbox: tuple) -> bool:
    """
    Return True if any detected phone overlaps with the student's bounding box.
    phone_boxes : list of (x1, y1, x2, y2, conf)
    student_bbox: (x1, y1, x2, y2)
    """
    sx1, sy1, sx2, sy2 = student_bbox
    for px1, py1, px2, py2, _ in phone_boxes:
        # Intersection check
        if px1 < sx2 and px2 > sx1 and py1 < sy2 and py2 > sy1:
            return True
    return False
