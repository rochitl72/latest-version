"""Render annotation overlays on images for export."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image as PILImage

from app.services.export.rle_utils import internal_rle_to_mask, polygon_to_mask
from app.models import Annotation, Label


def _hex_to_bgr(color: str) -> tuple[int, int, int]:
    c = (color or "#6B4EFF").lstrip("#")
    if len(c) != 6:
        c = "6B4EFF"
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    return b, g, r


def render_overlay(
    image_path: Path,
    annotations: list[Annotation],
    labels_by_id: dict[int, Label],
    out_path: Path,
    img_w: int,
    img_h: int,
) -> None:
    """Draw boxes, polygons, masks, ellipses, and keypoints onto a copy of the image."""
    img = cv2.imread(str(image_path))
    if img is None:
        pil = PILImage.open(image_path).convert("RGB")
        img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

    overlay = img.copy()

    for ann in annotations:
        label = labels_by_id.get(ann.label_id)
        color = _hex_to_bgr(label.color if label else "#6B4EFF")
        name = label.name if label else "object"
        geo = ann.geometry or {}

        if ann.type == "bbox":
            x = int(geo["x"] * img_w)
            y = int(geo["y"] * img_h)
            w = int(geo["w"] * img_w)
            h = int(geo["h"] * img_h)
            cv2.rectangle(overlay, (x, y), (x + w, y + h), color, 2)
            _draw_label(overlay, name, x, max(y - 4, 0), color)

        elif ann.type in ("polygon", "mask"):
            pts = geo.get("points", [])
            mask = None
            if ann.type == "mask" and geo.get("rle"):
                mask = internal_rle_to_mask(
                    geo["rle"], geo.get("size", [img_h, img_w])
                )
            elif len(pts) >= 3:
                mask = polygon_to_mask(pts, img_w, img_h)

            if mask is not None and mask.any():
                tinted = overlay.copy()
                tinted[mask > 0] = (
                    0.45 * np.array(color, dtype=np.float32)
                    + 0.55 * tinted[mask > 0].astype(np.float32)
                ).astype(np.uint8)
                overlay = tinted
                contours, _ = cv2.findContours(
                    mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                )
                cv2.drawContours(overlay, contours, -1, color, 2)
            elif len(pts) >= 3:
                poly = np.array(
                    [[int(p[0] * img_w), int(p[1] * img_h)] for p in pts],
                    dtype=np.int32,
                )
                cv2.polylines(overlay, [poly], True, color, 2)
            _draw_label(overlay, name, 8, 24, color)

        elif ann.type == "ellipse":
            cx = int((geo["x"] + geo["w"] / 2) * img_w)
            cy = int((geo["y"] + geo["h"] / 2) * img_h)
            ax = max(1, int(abs(geo["w"]) * img_w / 2))
            ay = max(1, int(abs(geo["h"]) * img_h / 2))
            cv2.ellipse(overlay, (cx, cy), (ax, ay), 0, 0, 360, color, 2)
            _draw_label(overlay, name, cx - ax, max(cy - ay - 4, 0), color)

        elif ann.type == "keypoint":
            pts = geo.get("points", [])
            for i, p in enumerate(pts):
                px, py = int(p[0] * img_w), int(p[1] * img_h)
                cv2.circle(overlay, (px, py), 5, color, -1)
                cv2.circle(overlay, (px, py), 5, (255, 255, 255), 1)
                kp_name = ""
                if label and label.keypoint_names and i < len(label.keypoint_names):
                    kp_name = label.keypoint_names[i]
                if kp_name:
                    _draw_label(overlay, kp_name, px + 6, py - 6, color)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), overlay)


_FONT = cv2.FONT_HERSHEY_SIMPLEX
_FONT_SCALE = 0.45
_FONT_THICK = 1


def _draw_label(img, text: str, x: int, y: int, bgr: tuple[int, int, int]) -> None:
    """Draw a filled caption chip with the text on top, in place.

    Uses OpenCV's own text rendering rather than round-tripping through PIL.
    The old version did, for EVERY label on the image:
        BGR array -> RGB -> PIL Image -> draw -> numpy -> BGR array
    which is four full-image copies per annotation — O(width x height) work to
    paint a caption a few dozen pixels wide. On a 1920x1080 photo that was
    ~15 ms each, so a fifteen-shape image spent a quarter of a second just
    converting colour spaces. This touches only the caption's own pixels.
    """
    (tw, th), baseline = cv2.getTextSize(text, _FONT, _FONT_SCALE, _FONT_THICK)
    pad = 3
    h, w = img.shape[:2]

    # Keep the chip on-canvas: a caption for a shape at the very top would
    # otherwise be drawn at a negative y and silently clipped away.
    x0 = max(0, min(int(x), w - (tw + 2 * pad) - 1))
    y1 = max(th + 2 * pad, min(int(y), h - 1))
    y0 = y1 - (th + 2 * pad)

    cv2.rectangle(img, (x0, y0), (x0 + tw + 2 * pad, y1), bgr, -1)
    cv2.putText(
        img,
        text,
        (x0 + pad, y1 - pad - baseline // 2),
        _FONT,
        _FONT_SCALE,
        (255, 255, 255),
        _FONT_THICK,
        cv2.LINE_AA,
    )
