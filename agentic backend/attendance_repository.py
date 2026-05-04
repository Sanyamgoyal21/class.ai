from __future__ import annotations

from datetime import datetime
from typing import Any

from config import ATTENDANCE_RECORDS_COLLECTION, STUDENTS_COLLECTION, USE_MONGO

if USE_MONGO:
    from database import mongo_db as mdb
else:
    mdb = None


def _require_mongo():
    if not USE_MONGO or mdb is None:
        raise RuntimeError("MongoDB is required for the attendance service. Set MONGO_URI before starting it.")
    return mdb.get_database()


def _serialize_student(document: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(document["_id"]),
        "name": document.get("name", ""),
        "rollNumber": document.get("rollNumber", ""),
        "className": document.get("className", ""),
        "section": document.get("section", ""),
        "sampleImagePaths": document.get("sampleImagePaths", []),
        "active": bool(document.get("active", True)),
        "createdAt": _iso(document.get("createdAt")),
        "updatedAt": _iso(document.get("updatedAt")),
    }


def _serialize_record(document: dict[str, Any], student: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = {
        "id": str(document["_id"]),
        "studentId": str(document.get("studentId")),
        "date": document.get("date", ""),
        "status": document.get("status", "absent"),
        "markedBy": document.get("markedBy", "teacher"),
        "firstSeenAt": _iso(document.get("firstSeenAt")),
        "lastSeenAt": _iso(document.get("lastSeenAt")),
        "updatedAt": _iso(document.get("updatedAt")),
        "confidence": document.get("confidence"),
        "source": document.get("source"),
    }
    if student:
        payload["student"] = student
    return payload


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


class AttendanceRepository:
    def __init__(self) -> None:
        self.db = _require_mongo()
        self.students = self.db[STUDENTS_COLLECTION]
        self.records = self.db[ATTENDANCE_RECORDS_COLLECTION]

    def create_student(self, name: str, roll_number: str, class_name: str, section: str) -> dict[str, Any]:
        now = datetime.utcnow()
        normalized_name = name.strip()
        normalized_roll = roll_number.strip()
        normalized_class = class_name.strip()
        normalized_section = section.strip()

        existing = None
        if normalized_roll:
            existing = self.students.find_one({"rollNumber": normalized_roll})

        if existing is None and normalized_name:
            existing = self.students.find_one({"name": normalized_name})

        if existing:
            sample_paths = existing.get("sampleImagePaths", [])
            document = {
                **existing,
                "name": normalized_name,
                "rollNumber": normalized_roll,
                "className": normalized_class,
                "section": normalized_section,
                "sampleImagePaths": sample_paths,
                "active": True,
                "updatedAt": now,
            }
            self.students.update_one(
                {"_id": existing["_id"]},
                {
                    "$set": {
                        "name": normalized_name,
                        "rollNumber": normalized_roll,
                        "className": normalized_class,
                        "section": normalized_section,
                        "sampleImagePaths": sample_paths,
                        "active": True,
                        "updatedAt": now,
                    }
                },
            )
            return _serialize_student(document)

        document = {
            "name": normalized_name,
            "rollNumber": normalized_roll,
            "className": normalized_class,
            "section": normalized_section,
            "sampleImagePaths": [],
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        result = self.students.insert_one(document)
        document["_id"] = result.inserted_id
        return _serialize_student(document)

    def update_student_samples(self, student_id: str, sample_image_paths: list[str]) -> dict[str, Any]:
        now = datetime.utcnow()
        self.students.update_one(
            {"_id": mdb.to_object_id(student_id)},
            {
                "$set": {
                    "sampleImagePaths": sample_image_paths,
                    "updatedAt": now,
                }
            },
        )
        return self.get_student(student_id)

    def delete_student(self, student_id: str) -> None:
        self.students.delete_one({"_id": mdb.to_object_id(student_id)})
        self.records.delete_many({"studentId": mdb.to_object_id(student_id)})

    def get_student(self, student_id: str) -> dict[str, Any]:
        document = self.students.find_one({"_id": mdb.to_object_id(student_id)})
        if not document:
            raise KeyError(f"Student not found: {student_id}")
        return _serialize_student(document)

    def get_student_document(self, student_id: str) -> dict[str, Any] | None:
        return self.students.find_one({"_id": mdb.to_object_id(student_id)})

    def list_students(self) -> list[dict[str, Any]]:
        return [_serialize_student(document) for document in self.students.find().sort("name", 1)]

    def list_active_students(self) -> list[dict[str, Any]]:
        return [_serialize_student(document) for document in self.students.find({"active": True}).sort("name", 1)]

    def iter_training_students(self) -> list[dict[str, Any]]:
        return list(self.students.find({"active": True}).sort("name", 1))

    def mark_present(self, student_id: str, confidence: float | None = None, source: str = "live-camera") -> dict[str, Any]:
        now = datetime.utcnow()
        date_value = now.strftime("%Y-%m-%d")
        student_oid = mdb.to_object_id(student_id)
        self.records.update_one(
            {"studentId": student_oid, "date": date_value},
            {
                "$setOnInsert": {
                    "studentId": student_oid,
                    "date": date_value,
                    "firstSeenAt": now,
                },
                "$set": {
                    "status": "present",
                    "lastSeenAt": now,
                    "updatedAt": now,
                    "markedBy": "system",
                    "confidence": confidence,
                    "source": source,
                },
            },
            upsert=True,
        )
        return self.get_record_by_student_and_date(student_id, date_value)

    def upsert_manual_attendance(
        self,
        student_id: str,
        date_value: str,
        status: str,
        marked_by: str = "teacher",
    ) -> dict[str, Any]:
        now = datetime.utcnow()
        student_oid = mdb.to_object_id(student_id)
        base_payload = {
            "status": status,
            "updatedAt": now,
            "markedBy": marked_by,
            "source": "manual-dashboard",
        }
        if status == "present":
            base_payload["lastSeenAt"] = now
        self.records.update_one(
            {"studentId": student_oid, "date": date_value},
            {
                "$setOnInsert": {
                    "studentId": student_oid,
                    "date": date_value,
                    "firstSeenAt": now if status == "present" else None,
                },
                "$set": base_payload,
            },
            upsert=True,
        )
        return self.get_record_by_student_and_date(student_id, date_value)

    def update_record(self, record_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        now = datetime.utcnow()
        update_fields = {k: v for k, v in fields.items() if v is not None}
        update_fields["updatedAt"] = now
        self.records.update_one(
            {"_id": mdb.to_object_id(record_id)},
            {"$set": update_fields},
        )
        return self.get_record(record_id)

    def get_record(self, record_id: str) -> dict[str, Any]:
        document = self.records.find_one({"_id": mdb.to_object_id(record_id)})
        if not document:
            raise KeyError(f"Attendance record not found: {record_id}")
        student = self.get_student(str(document["studentId"]))
        return _serialize_record(document, student)

    def get_record_by_student_and_date(self, student_id: str, date_value: str) -> dict[str, Any]:
        document = self.records.find_one(
            {"studentId": mdb.to_object_id(student_id), "date": date_value}
        )
        if not document:
            raise KeyError(f"Attendance record not found for {student_id} on {date_value}")
        student = self.get_student(student_id)
        return _serialize_record(document, student)

    def list_records(
        self,
        date_value: str | None = None,
        class_name: str | None = None,
        section: str | None = None,
    ) -> list[dict[str, Any]]:
        student_filter: dict[str, Any] = {}
        if class_name:
            student_filter["className"] = class_name
        if section:
            student_filter["section"] = section

        students = list(self.students.find(student_filter).sort("name", 1))
        student_map = {str(student["_id"]): _serialize_student(student) for student in students}
        student_oids = [student["_id"] for student in students]

        record_filter: dict[str, Any] = {}
        if date_value:
            record_filter["date"] = date_value
        if student_oids:
            record_filter["studentId"] = {"$in": student_oids}

        records = []
        for document in self.records.find(record_filter).sort([("date", -1), ("updatedAt", -1)]):
            student = student_map.get(str(document["studentId"]))
            if student:
                records.append(_serialize_record(document, student))

        if date_value:
            existing_ids = {record["studentId"] for record in records}
            for student in student_map.values():
                if student["id"] not in existing_ids:
                    records.append(
                        {
                            "id": f"virtual-{student['id']}-{date_value}",
                            "studentId": student["id"],
                            "date": date_value,
                            "status": "absent",
                            "markedBy": "teacher",
                            "firstSeenAt": None,
                            "lastSeenAt": None,
                            "updatedAt": None,
                            "confidence": None,
                            "source": None,
                            "student": student,
                            "virtual": True,
                        }
                    )

        records.sort(key=lambda item: (item["date"], item["student"]["name"]), reverse=True)
        return records
