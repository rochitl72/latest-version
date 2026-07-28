"""RLE utilities: internal format (UI) + COCO RLE (export)."""
from __future__ import annotations

import numpy as np

try:
    from pycocotools import mask as mask_util

    _HAS_COCO = True
except ImportError:
    _HAS_COCO = False


def internal_rle_to_mask(rle: str, size: list[int] | None = None) -> np.ndarray:
    """Decode `h,w|run,run,...` column-major RLE (matches frontend)."""
    if not rle:
        return np.zeros((1, 1), dtype=np.uint8)
    parts = rle.split("|", 1)
    if len(parts) != 2:
        return np.zeros((1, 1), dtype=np.uint8)
    dims, payload = parts[0], parts[1]
    if "," in dims and size is None:
        h, w = (int(x) for x in dims.split(",", 1))
    elif size:
        h, w = int(size[0]), int(size[1])
    else:
        h, w = int(dims), int(dims)

    runs = [int(x) for x in payload.split(",") if x != ""]
    flat = np.zeros(h * w, dtype=np.uint8)
    idx, val = 0, 0
    for run in runs:
        if val == 1:
            for p in range(idx, min(idx + run, h * w)):
                x = p // h
                y = p % h
                if x < w and y < h:
                    flat[y * w + x] = 1
        idx += run
        val = 1 - val

    return flat.reshape((h, w))


def mask_to_internal_rle(mask: np.ndarray) -> str:
    """Encode binary mask to frontend-compatible column-major RLE."""
    h, w = mask.shape
    runs: list[int] = []
    cur_val = 0
    cur_run = 0
    for x in range(w):
        for y in range(h):
            v = 1 if mask[y, x] > 0 else 0
            if v == cur_val:
                cur_run += 1
            else:
                runs.append(cur_run)
                cur_run = 1
                cur_val = v
    runs.append(cur_run)
    if not any(runs[i] > 0 for i in range(1, len(runs), 2)):
        return ""
    return f"{h},{w}|{','.join(str(r) for r in runs)}"


def mask_to_coco_rle(mask: np.ndarray) -> dict:
    """Standard COCO RLE dict: {size: [h,w], counts: str}."""
    mask = (mask > 0).astype(np.uint8)
    if _HAS_COCO:
        rle = mask_util.encode(np.asfortranarray(mask))
        counts = rle["counts"]
        if isinstance(counts, bytes):
            counts = counts.decode("utf-8")
        return {"size": [int(mask.shape[0]), int(mask.shape[1])], "counts": counts}

    # Pure-numpy fallback (Fortran-order, same as COCO)
    h, w = mask.shape
    flat = np.array(mask, order="F").flatten()
    padded = np.concatenate([[0], flat, [0]])
    changes = np.where(padded[1:] != padded[:-1])[0]
    runs: list[int] = []
    prev = 0
    for ch in changes:
        runs.append(int(ch - prev))
        prev = ch
    runs.append(int(len(padded) - prev))
    return {"size": [h, w], "counts": runs}


def mask_bbox_area(mask: np.ndarray) -> tuple[list[float], float]:
    """COCO bbox [x,y,w,h] and area from binary mask."""
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return [0.0, 0.0, 0.0, 0.0], 0.0
    x1, x2 = float(xs.min()), float(xs.max())
    y1, y2 = float(ys.min()), float(ys.max())
    return [x1, y1, x2 - x1 + 1, y2 - y1 + 1], float(np.sum(mask > 0))


def polygon_to_mask(points: list, w: int, h: int) -> np.ndarray:
    import cv2

    mask = np.zeros((h, w), dtype=np.uint8)
    if len(points) < 3:
        return mask
    poly = np.array([[int(p[0] * w), int(p[1] * h)] for p in points], dtype=np.int32)
    cv2.fillPoly(mask, [poly], 1)
    return mask


def _mask_to_polygon(mask: np.ndarray, simplify: float = 50.0, fast: bool = True) -> list[list[float]]:
    """Convert a binary mask to a simplified polygon outline.

    simplify: 0 = few vertices (simple), 100 = detailed (complex).
    """
    import cv2
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    # Map slider 0..100 → epsilon factor (higher simplify = more detail)
    t = max(0.0, min(100.0, float(simplify))) / 100.0
    factor = 0.0008 + t * 0.008
    epsilon = factor * cv2.arcLength(contour, True)
    simplified = cv2.approxPolyDP(contour, epsilon, True)
    points = simplified.squeeze(1).tolist()
    if not points:
        return []
    if isinstance(points[0], (int, float)):
        return [[float(points[0]), float(points[1])]]
    out = [[float(p[0]), float(p[1])] for p in points]
    max_pts = int(40 + t * 140)
    if len(out) > max_pts:
        step = max(1, len(out) // max_pts)
        out = out[::step]
    return out
