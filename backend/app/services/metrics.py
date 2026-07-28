"""Geometric metrics for inter-annotator agreement.

Annotation geometry is stored normalised (0..1) and varies by type, so
everything is reduced to a bounding box before comparison. That keeps the
comparison meaningful across mixed shape types on the same image.
"""
from __future__ import annotations


def _bbox_from_geometry(ann_type: str, geom: dict) -> tuple[float, float, float, float] | None:
    """Reduce any annotation to (x1, y1, x2, y2) in normalised coordinates."""
    if not isinstance(geom, dict):
        return None

    if ann_type == "bbox":
        try:
            x, y = float(geom["x"]), float(geom["y"])
            w, h = float(geom["w"]), float(geom["h"])
        except (KeyError, TypeError, ValueError):
            return None
        return (x, y, x + w, y + h)

    if ann_type == "ellipse":
        try:
            cx, cy = float(geom["cx"]), float(geom["cy"])
            rx, ry = float(geom["rx"]), float(geom["ry"])
        except (KeyError, TypeError, ValueError):
            return None
        return (cx - rx, cy - ry, cx + rx, cy + ry)

    if ann_type in ("polygon", "keypoint"):
        pts = geom.get("points") or []
        xs, ys = [], []
        for p in pts:
            if isinstance(p, dict):
                x, y = p.get("x"), p.get("y")
            elif isinstance(p, (list, tuple)) and len(p) >= 2:
                x, y = p[0], p[1]
            else:
                continue
            try:
                xs.append(float(x))
                ys.append(float(y))
            except (TypeError, ValueError):
                continue
        if not xs:
            return None
        return (min(xs), min(ys), max(xs), max(ys))

    # Masks are stored as RLE; decoding one per comparison is too expensive
    # for a dashboard endpoint, so they're skipped.
    return None


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    inter_w = min(ax2, bx2) - max(ax1, bx1)
    inter_h = min(ay2, by2) - max(ay1, by1)
    if inter_w <= 0 or inter_h <= 0:
        return 0.0
    inter = inter_w * inter_h

    area_a = max(ax2 - ax1, 0) * max(ay2 - ay1, 0)
    area_b = max(bx2 - bx1, 0) * max(by2 - by1, 0)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def iou_matrix(list_a: list, list_b: list) -> list[list[float]]:
    """IoU of every annotation in A against every annotation in B."""
    boxes_a = [_bbox_from_geometry(a.type, a.geometry) for a in list_a]
    boxes_b = [_bbox_from_geometry(b.type, b.geometry) for b in list_b]
    return [
        [0.0 if ba is None or bb is None else iou(ba, bb) for bb in boxes_b]
        for ba in boxes_a
    ]


def pairwise_agreement(list_a: list, list_b: list, threshold: float = 0.5) -> float:
    """Agreement between two annotators on one image, in 0..1.

    Greedily matches each of A's shapes to its best unused partner in B above
    the threshold, then scores matches against the larger set. Using the
    larger set means unmatched extras on either side reduce the score, so
    over- and under-labelling are both penalised.

    Two annotators who both drew nothing agree completely — that is a real
    signal (both judged the image empty), so it scores 1.0.
    """
    if not list_a and not list_b:
        return 1.0
    if not list_a or not list_b:
        return 0.0

    matrix = iou_matrix(list_a, list_b)
    used_b: set[int] = set()
    matches = 0

    for row in matrix:
        best_idx, best_val = None, threshold
        for j, val in enumerate(row):
            if j in used_b:
                continue
            if val >= best_val:
                best_idx, best_val = j, val
        if best_idx is not None:
            used_b.add(best_idx)
            matches += 1

    return matches / max(len(list_a), len(list_b))
