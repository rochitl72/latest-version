"""Annotations API — manual annotation CRUD.

Ownership rules:
  * a plain user may edit and delete only their own annotations
  * an admin may edit and delete anyone's
Project access is required for any of it: a project is reachable by an admin, or
by the single user it is assigned to (see `services/membership.py`). Every rule
here is enforced server-side, so a client that skips a check still cannot write.

An image with status "approved" is frozen to everyone but an admin.
"""
import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import current_user
from app.db.database import get_db
from app.models import Action, Annotation, Image, Label, Project, User, utcnow
from app.services import activity, membership, storage
from app.services.export.export_formats import coco_segmentation, yolo_seg_line
from app.services.export.export_overlay import render_overlay

router = APIRouter(prefix="/api", tags=["annotations"])

log = logging.getLogger("annoforge.annotations")


async def _sync_export_artifacts(
    db: AsyncSession, image: Image, action: str, user: User | None,
) -> None:
    """After every annotation create/update/delete, refresh everything under
    this image's `annotation/{project}/` folder:
      * json/{id}.json      — the DB-backed per-image backup (unchanged)
      * overlays/{id}_*.png — the annotation redrawn on top of the image
      * yolo/labels/.../.txt — this image's YOLO label file
      * coco/annotations_coco.json — this image's entries patched in place
      * logs/activity.log   — one line for this project

    Scoped to a single image throughout (never re-scans the whole project), so
    a single annotation save stays cheap regardless of project size. Postgres
    remains the authoritative, queryable store; everything here is a mirror.
    Best-effort: a disk failure must never roll back a saved annotation, so
    every step is wrapped and swallowed rather than raised.
    """
    try:
        project = await db.get(Project, image.project_id)
        if not project or not project.assigned_user_id:
            return  # no owner folder to write into yet
        owner = await db.get(User, project.assigned_user_id)
        if not owner:
            return

        labels = (
            await db.execute(
                select(Label).where(Label.project_id == project.id).order_by(Label.id)
            )
        ).scalars().all()
        labels_by_id = {l.id: l for l in labels}
        label_id_to_idx = {l.id: idx for idx, l in enumerate(labels)}
        label_id_to_coco = {l.id: idx + 1 for idx, l in enumerate(labels)}

        rows = (await db.execute(
            select(Annotation).where(Annotation.image_id == image.id).order_by(Annotation.id)
        )).scalars().all()

        # ── 1. annotations.json backup ──────────────────────────────
        ann_list = [
            {
                "id": a.id,
                "label_id": a.label_id,
                "type": a.type,
                "geometry": a.geometry,
                "confidence": a.confidence,
                "source": a.source,
                "created_by": a.created_by,
                "updated_by": a.updated_by,
            }
            for a in rows
        ]
        meta = {
            "image_id": image.id,
            "project_id": image.project_id,
            "filename": image.filename,
            "width": image.width,
            "height": image.height,
            "status": image.status,
        }
        json_path = storage.annotations_file_path(
            owner.id, owner.username, owner.role, project.id, project.name, image.id,
        )
        storage.write_annotations_json(json_path, meta, ann_list)
        image.annotations_path = str(json_path)

        # ── 2. overlay PNG (annotations drawn on the image) ─────────
        overlay_path = storage.overlay_file_path(
            owner.id, owner.username, owner.role, project.id, project.name,
            image.id, image.filename,
        )
        src = Path(image.storage_path)
        if rows and src.is_file():
            try:
                render_overlay(
                    src, rows, labels_by_id, overlay_path, image.width, image.height,
                )
            except Exception:
                log.exception("Failed rendering overlay for image %s", image.id)
        else:
            # No annotations left (or the source file is gone) — no overlay
            # should remain either, so a stale one doesn't outlive its shapes.
            overlay_path.unlink(missing_ok=True)

        # ── 3. this image's YOLO label file + the shared classes/data.yaml ──
        split = image.split if image.split in ("train", "val", "test") else "train"
        yolo_root, yolo_labels_root = storage.yolo_dirs(
            owner.id, owner.username, owner.role, project.id, project.name,
        )
        yolo_split_dir = yolo_labels_root / split
        yolo_split_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(image.filename).stem
        yolo_lines = []
        for a in rows:
            if a.label_id not in label_id_to_idx:
                continue
            line = yolo_seg_line(a, label_id_to_idx[a.label_id], image.width, image.height)
            if line:
                yolo_lines.append(line)
        (yolo_split_dir / f"{stem}.txt").write_text("\n".join(yolo_lines))
        (yolo_root / "classes.txt").write_text(
            "\n".join(l.name for l in labels) + ("\n" if labels else "")
        )
        (yolo_root / "data.yaml").write_text(
            f"# YOLO labels for project {project.name!r}. Images live in the\n"
            f"# sibling project/{project.id}_{storage._safe(project.name)}/images/ folder.\n"
            f"train: labels/train\nval: labels/val\ntest: labels/test\n\n"
            f"nc: {len(labels)}\nnames: {[l.name for l in labels]}\n"
        )

        # ── 4. patch this image's entries into the project's live COCO file ──
        coco_path = storage.coco_export_path(
            owner.id, owner.username, owner.role, project.id, project.name,
        )
        coco = {
            "info": {"description": f"RBG export: {project.name}", "version": "1.0"},
            "licenses": [], "images": [], "annotations": [], "categories": [],
        }
        if coco_path.is_file():
            try:
                coco = json.loads(coco_path.read_text())
            except Exception:
                log.warning("Existing coco export for project %s unreadable; rebuilding", project.id)
        coco["categories"] = [
            {"id": label_id_to_coco[l.id], "name": l.name, "supercategory": "object"}
            for l in labels
        ]
        coco["images"] = [im for im in coco.get("images", []) if im.get("id") != image.id]
        coco["annotations"] = [
            a for a in coco.get("annotations", []) if a.get("image_id") != image.id
        ]
        coco["images"].append({
            "id": image.id, "file_name": image.filename,
            "width": image.width, "height": image.height,
        })
        for a in rows:
            if a.label_id not in label_id_to_coco:
                continue
            try:
                seg, bbox, area = coco_segmentation(a, image)
            except ValueError:
                continue
            coco["annotations"].append({
                "id": a.id, "image_id": image.id,
                "category_id": label_id_to_coco[a.label_id],
                "segmentation": seg, "area": area, "bbox": bbox, "iscrowd": 0,
            })
        tmp = coco_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(coco, indent=2, default=str))
        tmp.replace(coco_path)

        # ── 5. project-scoped log line ───────────────────────────────
        storage.append_project_log(
            owner.id, owner.username, owner.role, project.id, project.name,
            f"{action} image={image.id} ({image.filename}) annotations={len(rows)} "
            f"by={user.username if user else 'system'}",
        )
    except Exception:  # pragma: no cover - backup must never break the request
        log.exception("Failed syncing export artifacts for image %s", image.id)


class AnnotationCreate(BaseModel):
    image_id: int
    label_id: int
    type: str  # bbox | polygon | mask | keypoint | ellipse
    geometry: dict
    source: str = "manual"
    confidence: float = 1.0


class AnnotationUpdate(BaseModel):
    label_id: int | None = None
    geometry: dict | None = None


class AnnotationOut(BaseModel):
    id: int
    image_id: int
    label_id: int
    type: str
    geometry: dict
    confidence: float
    source: str
    created_by: int | None = None
    created_by_username: str | None = None

    class Config:
        from_attributes = True


async def _with_authors(db: AsyncSession, anns: list[Annotation]) -> list[dict]:
    """Attach usernames so the UI can show who drew each shape."""
    ids = {a.created_by for a in anns if a.created_by}
    names: dict[int, str] = {}
    if ids:
        rows = (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all()
        names = {u.id: u.username for u in rows}
    out = []
    for a in anns:
        d = AnnotationOut.model_validate(a).model_dump()
        d["created_by_username"] = names.get(a.created_by)
        out.append(d)
    return out


def _may_modify(user: User, ann: Annotation) -> bool:
    return user.can_review or ann.created_by in (None, user.id)


# ─── CRUD ──────────────────────────────────────────────────────────
@router.get("/images/{image_id}/annotations")
async def list_annotations(
    image_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    await membership.assert_member(db, img.project_id, user)
    res = await db.execute(
        select(Annotation).where(Annotation.image_id == image_id).order_by(Annotation.id)
    )
    return await _with_authors(db, list(res.scalars().all()))


@router.post("/annotations", response_model=AnnotationOut)
async def create_annotation(
    payload: AnnotationCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    img = await db.get(Image, payload.image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    label = await db.get(Label, payload.label_id)
    if not label:
        raise HTTPException(404, "Label not found")

    await membership.assert_member(db, img.project_id, user)

    if img.status == "approved" and not user.can_review:
        raise HTTPException(403, "This image is approved and locked for editing")

    ann = Annotation(**payload.model_dump(), created_by=user.id, updated_by=user.id)
    db.add(ann)
    if img.status == "unannotated":
        img.status = "in_progress"
    await db.flush()

    await activity.record(
        db, user, Action.ANNOTATION_CREATE,
        project_id=img.project_id, image_id=img.id, annotation_id=ann.id,
        details={"type": ann.type, "label_id": ann.label_id},
    )
    await _sync_export_artifacts(db, img, Action.ANNOTATION_CREATE, user)
    await db.commit()
    await db.refresh(ann)
    return ann


@router.patch("/annotations/{annotation_id}", response_model=AnnotationOut)
async def update_annotation(
    annotation_id: int,
    payload: AnnotationUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    ann = await db.get(Annotation, annotation_id)
    if not ann:
        raise HTTPException(404, "Annotation not found")
    if not _may_modify(user, ann):
        raise HTTPException(403, "You can only edit your own annotations")

    img = await db.get(Image, ann.image_id)
    if img:
        await membership.assert_member(db, img.project_id, user)
        # An approved image is locked to everyone but an admin — same rule the
        # create path enforces, applied here so edits can't slip past it.
        if img.status == "approved" and not user.can_review:
            raise HTTPException(403, "This image is approved and locked for editing")

    before = {"geometry": ann.geometry, "label_id": ann.label_id}
    if payload.label_id is not None:
        ann.label_id = payload.label_id
    if payload.geometry is not None:
        ann.geometry = payload.geometry
    ann.updated_by = user.id
    await activity.record(
        db, user, Action.ANNOTATION_UPDATE,
        project_id=img.project_id if img else None,
        image_id=ann.image_id, annotation_id=ann.id,
        details={"before": before, "after": {"geometry": ann.geometry,
                                             "label_id": ann.label_id}},
    )
    if img:
        await _sync_export_artifacts(db, img, Action.ANNOTATION_UPDATE, user)
    await db.commit()
    await db.refresh(ann)
    return ann


@router.delete("/annotations/{annotation_id}")
async def delete_annotation(
    annotation_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    ann = await db.get(Annotation, annotation_id)
    if not ann:
        raise HTTPException(404, "Annotation not found")
    if not _may_modify(user, ann):
        raise HTTPException(403, "You can only delete your own annotations")

    img = await db.get(Image, ann.image_id)
    if img:
        await membership.assert_member(db, img.project_id, user)
        if img.status == "approved" and not user.can_review:
            raise HTTPException(403, "This image is approved and locked for editing")
    await activity.record(
        db, user, Action.ANNOTATION_DELETE,
        project_id=img.project_id if img else None,
        image_id=ann.image_id, annotation_id=ann.id,
        details={"type": ann.type, "geometry": ann.geometry},
    )
    await db.delete(ann)
    await db.flush()
    if img:
        await _sync_export_artifacts(db, img, Action.ANNOTATION_DELETE, user)
    await db.commit()
    return {"ok": True}
