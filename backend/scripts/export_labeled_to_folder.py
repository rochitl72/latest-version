#!/usr/bin/env python3
"""Export a project's labeled images + annotations to a folder on disk."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

# Run from backend/ so app imports work
BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker, selectinload

from app.core.config import settings
from app.models import Project, Image, Annotation, Label
from app.services.export.export_formats import coco_segmentation, yolo_seg_line
from app.services.export.export_overlay import render_overlay


def export_project(
    project_name: str,
    out_dir: Path,
    only_annotated: bool = True,
    create_zip: bool = True,
) -> None:
    # Standalone CLI helper: connect to the same PostgreSQL database the app
    # uses (synchronous driver, since this script isn't async). The in-app
    # export endpoints in api/dataset/export.py are the normal path.
    engine = create_engine(settings.sync_database_url)
    Session = sessionmaker(bind=engine)

    with Session() as db:
        project = db.execute(
            select(Project).where(Project.name == project_name)
        ).scalar_one_or_none()
        if not project:
            raise SystemExit(f"Project not found: {project_name!r}")

        labels = db.execute(
            select(Label).where(Label.project_id == project.id).order_by(Label.id)
        ).scalars().all()
        label_id_to_idx = {lbl.id: idx for idx, lbl in enumerate(labels)}
        label_id_to_coco = {lbl.id: idx + 1 for idx, lbl in enumerate(labels)}
        labels_by_id = {lbl.id: lbl for lbl in labels}

        q = select(Image).where(Image.project_id == project.id)
        if project.active_version_id:
            q = q.where(Image.version_id == project.active_version_id)
        images = db.execute(q.options(selectinload(Image.annotations))).scalars().all()

        if only_annotated:
            images = [img for img in images if img.annotations]

        if not images:
            raise SystemExit("No labeled images to export.")

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
                print(f"Warning: missing file {src}", file=sys.stderr)
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

        (out_dir / "annotations_coco.json").write_text(
            json.dumps(coco, indent=2)
        )
        (out_dir / "classes.txt").write_text(
            "\n".join(lbl.name for lbl in labels) + "\n"
        )
        (out_dir / "data.yaml").write_text(
            f"path: {out_dir}\n"
            f"train: images/train\n"
            f"val: images/val\n"
            f"test: images/test\n\n"
            f"nc: {len(labels)}\n"
            f"names: {[lbl.name for lbl in labels]}\n"
        )
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        (out_dir / "README.txt").write_text(
            f"Exported from RBG Annotation Studio\n"
            f"Project: {project.name}\n"
            f"Images: {len(manifest)} (labeled only: {only_annotated})\n"
            f"Classes: {', '.join(lbl.name for lbl in labels)}\n\n"
            f"images/<split>/      — original image files\n"
            f"overlays/<split>/   — images with labels drawn on top\n"
            f"labels/<split>/      — YOLO segmentation .txt (one per image)\n"
            f"annotations_coco.json — COCO format with masks/polygons\n"
            f"classes.txt          — one class name per line\n"
            f"data.yaml            — YOLO dataset config\n"
            f"manifest.json        — export summary per image\n"
        )

        print(f"Exported {len(manifest)} labeled images")
        print(f"Folder: {out_dir}")
        if create_zip:
            zip_path = out_dir.parent / f"{out_dir.name}.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in out_dir.rglob("*"):
                    if f.is_file():
                        zf.write(f, f.relative_to(out_dir.parent))
            print(f"Zip:    {zip_path}")


def main():
    p = argparse.ArgumentParser(description="Export labeled project to a folder on disk.")
    p.add_argument("--project", required=True, help='Exact project name, e.g. "My Dataset"')
    p.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output folder (default: ~/Downloads/<project>_labeled)",
    )
    p.add_argument("--all-images", action="store_true", help="Include images without labels")
    p.add_argument("--no-zip", action="store_true", help="Skip creating a .zip alongside the folder")
    args = p.parse_args()
    out = args.out
    if out is None:
        safe = re.sub(r"[^\w\s-]", "", args.project, flags=re.UNICODE)
        safe = re.sub(r"[-\s]+", "_", safe.strip()) or "project"
        out = Path.home() / "Downloads" / f"{safe}_labeled"
    export_project(
        args.project,
        out,
        only_annotated=not args.all_images,
        create_zip=not args.no_zip,
    )


if __name__ == "__main__":
    main()
