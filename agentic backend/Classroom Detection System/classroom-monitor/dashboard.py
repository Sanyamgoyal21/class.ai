"""
Dashboard renderer.
Draws coloured bounding boxes around each student, overlays status badges,
and renders a semi-transparent right-side panel with live stats and an event log.
"""

import cv2
import numpy as np
from datetime import datetime
import config

_FONT       = cv2.FONT_HERSHEY_SIMPLEX
_FONT_SMALL = 0.38
_FONT_MED   = 0.45
_FONT_BOLD  = 0.52
_WHITE      = (255, 255, 255)
_GREY       = (160, 160, 160)
_DARK       = (20,  20,  20)


class Dashboard:
    def __init__(self):
        self._log: list[tuple] = []   # (timestamp_str, student_id, event)
        self._max_log = 20

    # ── public ─────────────────────────────────────────────────────────────────

    def add_event(self, student_id: int, event: str):
        ts = datetime.now().strftime('%H:%M:%S')
        self._log.append((ts, student_id, event))
        if len(self._log) > self._max_log:
            self._log.pop(0)

    def render(self, frame, student_states: dict, fps: float):
        """
        Draws everything onto a copy of frame and returns the annotated image.
        student_states: {id: {'bbox', 'activity', 'phone', 'sleep', 'hand_raise', ...}}
        """
        out = frame.copy()
        self._draw_boxes(out, student_states)
        self._draw_sidebar(out, student_states, fps)
        return out

    # ── private: per-student boxes ─────────────────────────────────────────────

    def _draw_boxes(self, frame, student_states: dict):
        for sid, state in student_states.items():
            bbox = state.get('bbox')
            if bbox is None:
                continue
            x1, y1, x2, y2 = bbox
            activity = state.get('activity', 'attentive')
            color    = config.ALERT_COLORS.get(activity, _GREY)

            # Main box
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

            # Corner accents for style
            sz = 10
            for (cx, cy), (dx, dy) in [
                ((x1, y1), (1, 1)), ((x2, y1), (-1, 1)),
                ((x1, y2), (1, -1)), ((x2, y2), (-1, -1)),
            ]:
                cv2.line(frame, (cx, cy), (cx + dx * sz, cy), color, 3)
                cv2.line(frame, (cx, cy), (cx, cy + dy * sz), color, 3)

            # Badge row
            badges = [f'S{sid}']
            if state.get('phone'):      badges.append('PHONE')
            if state.get('sleep'):      badges.append('SLEEP')
            if state.get('hand_raise'): badges.append('HAND')
            act_label = {
                'turn_left':  'LEFT',
                'turn_right': 'RIGHT',
                'reading':    'READ',
                'writing':    'WRITE',
            }.get(activity)
            if act_label:
                badges.append(act_label)

            label = '  '.join(badges)
            (tw, th), _ = cv2.getTextSize(label, _FONT, _FONT_MED, 1)
            label_y = max(y1 - 4, th + 6)
            cv2.rectangle(frame, (x1, label_y - th - 5), (x1 + tw + 8, label_y + 2), color, -1)
            cv2.putText(frame, label, (x1 + 4, label_y - 2), _FONT, _FONT_MED, _DARK, 1, cv2.LINE_AA)

    # ── private: sidebar ───────────────────────────────────────────────────────

    def _draw_sidebar(self, frame, student_states: dict, fps: float):
        h, w   = frame.shape[:2]
        sb_x   = w - config.DASHBOARD_WIDTH
        margin = sb_x + 10

        # Semi-transparent background
        overlay = frame.copy()
        cv2.rectangle(overlay, (sb_x, 0), (w, h), _DARK, -1)
        cv2.addWeighted(overlay, 0.72, frame, 0.28, 0, frame)

        y = 22
        # Title
        cv2.putText(frame, 'CLASSROOM MONITOR', (margin, y),
                    _FONT, _FONT_BOLD, _WHITE, 1, cv2.LINE_AA)
        y += 18
        cv2.putText(frame, datetime.now().strftime('%Y-%m-%d  %H:%M:%S'),
                    (margin, y), _FONT, _FONT_SMALL, _GREY, 1, cv2.LINE_AA)
        y += 16
        cv2.putText(frame, f'FPS: {fps:4.1f}   Students: {len(student_states)}',
                    (margin, y), _FONT, _FONT_SMALL, _GREY, 1, cv2.LINE_AA)
        y += 12
        self._hline(frame, sb_x, w, y)
        y += 14

        # ── live counts ──
        counts = {k: 0 for k in ('phone', 'sleep', 'hand_raise', 'turn_left', 'turn_right', 'reading')}
        for state in student_states.values():
            if state.get('phone'):      counts['phone']      += 1
            if state.get('sleep'):      counts['sleep']      += 1
            if state.get('hand_raise'): counts['hand_raise'] += 1
            act = state.get('activity', '')
            if act in counts:           counts[act]          += 1

        stat_rows = [
            ('Phone Use',    counts['phone'],      config.ALERT_COLORS['phone']),
            ('Sleeping',     counts['sleep'],      config.ALERT_COLORS['sleep']),
            ('Turn Left',    counts['turn_left'],  config.ALERT_COLORS['turn_left']),
            ('Turn Right',   counts['turn_right'], config.ALERT_COLORS['turn_right']),
            ('Reading',      counts['reading'],    config.ALERT_COLORS['reading']),
            ('Hand Raised',  counts['hand_raise'], config.ALERT_COLORS['hand_raise']),
        ]
        cv2.putText(frame, 'LIVE STATS', (margin, y), _FONT, _FONT_SMALL, _GREY, 1, cv2.LINE_AA)
        y += 14
        for label, count, color in stat_rows:
            bar_len = min(count * 8, config.DASHBOARD_WIDTH - 80)
            cv2.rectangle(frame, (margin, y - 9), (margin + bar_len, y - 1), color, -1)
            cv2.putText(frame, f'{label}: {count}', (margin, y),
                        _FONT, _FONT_SMALL, color, 1, cv2.LINE_AA)
            y += 17

        y += 4
        self._hline(frame, sb_x, w, y)
        y += 14

        # ── event log ──
        cv2.putText(frame, 'EVENT LOG', (margin, y), _FONT, _FONT_SMALL, _GREY, 1, cv2.LINE_AA)
        y += 14
        for ts, sid, event in reversed(self._log):
            color = config.ALERT_COLORS.get(event.lower().replace(' ', '_'), _GREY)
            text  = f'{ts}  S{sid}: {event.upper()}'
            cv2.putText(frame, text, (margin, y), _FONT, _FONT_SMALL, color, 1, cv2.LINE_AA)
            y += 14
            if y > h - 10:
                break

    @staticmethod
    def _hline(frame, x1, x2, y):
        cv2.line(frame, (x1 + 4, y), (x2 - 4, y), (70, 70, 70), 1)
