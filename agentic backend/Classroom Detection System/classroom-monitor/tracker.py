"""
Centroid-based multi-person tracker.
Assigns a persistent integer ID to each student bounding box
and keeps it across frames using nearest-centroid matching.
"""

import numpy as np
from collections import OrderedDict
from scipy.spatial import distance as dist


class CentroidTracker:
    def __init__(self, max_disappeared: int = 30, max_distance: int = 120):
        self.next_id      = 0
        self.objects      = OrderedDict()   # id → centroid (x, y)
        self.bboxes       = OrderedDict()   # id → (x1, y1, x2, y2)
        self.disappeared  = OrderedDict()   # id → consecutive missing frames
        self.max_disappeared = max_disappeared
        self.max_distance    = max_distance

    # ── public ─────────────────────────────────────────────────────────────────

    def update(self, rects: list) -> dict:
        """
        rects : list of (x1, y1, x2, y2)
        returns: {id: (centroid, bbox)} for all currently tracked objects
        """
        if len(rects) == 0:
            for oid in list(self.disappeared):
                self.disappeared[oid] += 1
                if self.disappeared[oid] > self.max_disappeared:
                    self._deregister(oid)
            return self._snapshot()

        input_centroids = np.array([
            ((r[0] + r[2]) // 2, (r[1] + r[3]) // 2) for r in rects
        ])

        if len(self.objects) == 0:
            for i, c in enumerate(input_centroids):
                self._register(c, rects[i])
            return self._snapshot()

        oids           = list(self.objects.keys())
        obj_centroids  = np.array(list(self.objects.values()))
        D              = dist.cdist(obj_centroids, input_centroids)

        # Sort rows by minimum distance so closest pairs are matched first
        rows = D.min(axis=1).argsort()
        cols = D.argmin(axis=1)[rows]

        used_rows, used_cols = set(), set()
        for row, col in zip(rows, cols):
            if row in used_rows or col in used_cols:
                continue
            if D[row, col] > self.max_distance:
                continue
            oid = oids[row]
            self.objects[oid]     = input_centroids[col]
            self.bboxes[oid]      = rects[col]
            self.disappeared[oid] = 0
            used_rows.add(row)
            used_cols.add(col)

        # Age out unmatched existing objects
        for row in set(range(D.shape[0])) - used_rows:
            oid = oids[row]
            self.disappeared[oid] += 1
            if self.disappeared[oid] > self.max_disappeared:
                self._deregister(oid)

        # Register new detections that had no match
        for col in set(range(D.shape[1])) - used_cols:
            self._register(input_centroids[col], rects[col])

        return self._snapshot()

    def snapshot(self) -> dict:
        """Return current tracked state without updating."""
        return self._snapshot()

    # ── private ────────────────────────────────────────────────────────────────

    def _register(self, centroid, bbox):
        self.objects[self.next_id]     = centroid
        self.bboxes[self.next_id]      = bbox
        self.disappeared[self.next_id] = 0
        self.next_id += 1

    def _deregister(self, oid):
        del self.objects[oid]
        del self.bboxes[oid]
        del self.disappeared[oid]

    def _snapshot(self) -> dict:
        return {oid: (self.objects[oid], self.bboxes[oid]) for oid in self.objects}
