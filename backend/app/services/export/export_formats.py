"""Shared COCO / YOLO export helpers."""
from app.models import Image, Annotation
from app.services.export.rle_utils import internal_rle_to_mask, mask_to_coco_rle, mask_bbox_area
from app.services.export.rle_utils import _mask_to_polygon


def coco_segmentation(ann: Annotation, img: Image) -> tuple[dict | list, list[float], float]:
    geo = ann.geometry
    h, w = img.height, img.width

    if ann.type == "mask" and geo.get("rle"):
        mask = internal_rle_to_mask(geo["rle"], geo.get("size", [h, w]))
        seg = mask_to_coco_rle(mask)
        bbox, area = mask_bbox_area(mask)
        return seg, bbox, area

    if ann.type == "polygon":
        pts = geo.get("points", [])
        if len(pts) < 3:
            raise ValueError("empty polygon")
        flat = []
        for px, py in pts:
            flat.extend([px * w, py * h])
        xs = [p[0] * w for p in pts]
        ys = [p[1] * h for p in pts]
        bbox = [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]
        area = bbox[2] * bbox[3]
        return [flat], bbox, area

    if ann.type == "bbox":
        x, y, bw, bh = geo["x"] * w, geo["y"] * h, geo["w"] * w, geo["h"] * h
        return [], [x, y, bw, bh], bw * bh

    raise ValueError(f"unsupported type {ann.type}")


def yolo_seg_line(ann: Annotation, cls_idx: int, w: int, h: int) -> str | None:
    geo = ann.geometry
    if ann.type == "bbox":
        cx = geo["x"] + geo["w"] / 2
        cy = geo["y"] + geo["h"] / 2
        return f"{cls_idx} {cx:.6f} {cy:.6f} {geo['w']:.6f} {geo['h']:.6f}"

    pts = geo.get("points", [])
    if ann.type == "mask" and geo.get("rle") and len(pts) < 3:
        mask = internal_rle_to_mask(geo["rle"], geo.get("size", [h, w]))
        poly_px = _mask_to_polygon(mask, simplify=50.0)
        if len(poly_px) < 3:
            return None
        flat = " ".join(f"{x / w:.6f} {y / h:.6f}" for x, y in poly_px)
        return f"{cls_idx} {flat}"

    if ann.type in ("polygon", "mask") and len(pts) >= 3:
        flat = " ".join(f"{p[0]:.6f} {p[1]:.6f}" for p in pts)
        return f"{cls_idx} {flat}"
    return None
