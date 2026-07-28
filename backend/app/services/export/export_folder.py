"""Export labeled dataset to a folder on disk (e.g. ~/Downloads)."""
from __future__ import annotations

import json
import re
import shutil
import zipfile
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.services.export.export_formats import coco_segmentation, yolo_seg_line
from app.services.export.export_overlay import render_overlay
from app.models import Project, Image, Label


def _safe_dir_name(name: str) -> str:
    s = re.sub(r"[^\w\s-]", "", name, flags=re.UNICODE)
    s = re.sub(r"[-\s]+", "_", s.strip())
    return s or "project"


async def export_labeled_to_folder(
    db: AsyncSession,
    project: Project,
    out_dir: Path,
    only_annotated: bool = True,
) -> dict:
    """Copy images + YOLO labels + COCO JSON into out_dir. Returns summary dict."""
    labels_res = await db.execute(
        select(Label).where(Label.project_id == project.id).order_by(Label.id)
    )
    labels = labels_res.scalars().all()
    label_id_to_idx = {lbl.id: idx for idx, lbl in enumerate(labels)}
    label_id_to_coco = {lbl.id: idx + 1 for idx, lbl in enumerate(labels)}
    labels_by_id = {lbl.id: lbl for lbl in labels}

    q = select(Image).where(Image.project_id == project.id)
    if project.active_version_id:
        q = q.where(Image.version_id == project.active_version_id)
    imgs_res = await db.execute(q.options(selectinload(Image.annotations)))
    images = list(imgs_res.scalars().all())

    if only_annotated:
        images = [img for img in images if img.annotations]

    if not images:
        raise ValueError("No labeled images to export")

    out_dir = out_dir.resolve()
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    coco = {
        "info": {
            "description": f"RBG export: {project.name}",
            "version": "1.0",
            "only_annotated": only_annotated,
        },
        "images": [],
        "annotations": [],
        "categories": [
            {"id": label_id_to_coco[lbl.id], "name": lbl.name, "supercategory": "object"}
            for lbl in labels
        ],
    }
    ann_id = 1
    manifest = []

    for img in images:
        split = img.split if img.split in ("train", "val", "test") else "train"
        src = Path(img.storage_path)
        if not src.exists():
            continue

        dest_img_dir = out_dir / "images" / split
        dest_lbl_dir = out_dir / "labels" / split
        dest_overlay_dir = out_dir / "overlays" / split
        dest_img_dir.mkdir(parents=True, exist_ok=True)
        dest_lbl_dir.mkdir(parents=True, exist_ok=True)
        dest_overlay_dir.mkdir(parents=True, exist_ok=True)

        dest_name = src.name
        shutil.copy2(src, dest_img_dir / dest_name)

        if img.annotations:
            render_overlay(
                src,
                img.annotations,
                labels_by_id,
                dest_overlay_dir / dest_name,
                img.width,
                img.height,
            )

        stem = Path(img.filename).stem
        yolo_lines = []
        for ann in img.annotations:
            if ann.label_id not in label_id_to_idx:
                continue
            line = yolo_seg_line(
                ann, label_id_to_idx[ann.label_id], img.width, img.height
            )
            if line:
                yolo_lines.append(line)
            if ann.label_id in label_id_to_coco:
                try:
                    seg, bbox, area = coco_segmentation(ann, img)
                    coco["annotations"].append({
                        "id": ann_id,
                        "image_id": img.id,
                        "category_id": label_id_to_coco[ann.label_id],
                        "segmentation": seg,
                        "area": area,
                        "bbox": bbox,
                        "iscrowd": 0,
                    })
                    ann_id += 1
                except ValueError:
                    pass

        (dest_lbl_dir / f"{stem}.txt").write_text("\n".join(yolo_lines))

        coco["images"].append({
            "id": img.id,
            "file_name": dest_name,
            "width": img.width,
            "height": img.height,
            "split": split,
            "status": img.status,
        })
        manifest.append({
            "image_id": img.id,
            "filename": img.filename,
            "split": split,
            "status": img.status,
            "annotation_count": len(img.annotations),
        })

    (out_dir / "annotations_coco.json").write_text(json.dumps(coco, indent=2))
    (out_dir / "classes.txt").write_text("\n".join(lbl.name for lbl in labels) + "\n")
    (out_dir / "data.yaml").write_text(
        f"path: {out_dir}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"test: images/test\n\n"
        f"nc: {len(labels)}\n"
        f"names: {[lbl.name for lbl in labels]}\n"
    )
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    zip_path = out_dir.parent / f"{out_dir.name}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in out_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(out_dir.parent))

    return {
        "folder": str(out_dir),
        "zip": str(zip_path),
        "image_count": len(manifest),
        "annotation_count": ann_id - 1,
        "classes": [lbl.name for lbl in labels],
    }
