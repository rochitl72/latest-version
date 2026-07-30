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
from types import SimpleNamespace

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
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


# ─── Derived artifacts (overlay / COCO / YOLO / logs) ────────────────
# These are written to disk on every annotation change, but NOT on the request
# path. Doing them inline made saving a shape take seconds: rendering the
# overlay reads and re-encodes the whole photo, and the seven file writes land
# on a bind-mounted volume, which on Docker Desktop for macOS is an order of
# magnitude slower than a native write. The user clicked to close a polygon and
# waited three or four seconds for it to appear.
#
# Now the request does only the database work and hands a plain-data payload to
# a background task. FastAPI runs a SYNC background function in a threadpool, so
# the blocking encode never stalls the event loop either. Postgres remains the
# authoritative store; everything here is a mirror that can lag by a moment.


def _write_artifacts(payload: dict) -> None:
    """Pure file I/O + rendering. No database access — by the time this runs the
    request's session is closed, so it is handed plain values only."""
    try:
        owner = payload["owner"]
        proj = payload["project"]
        image = payload["image"]
        anns = payload["annotations"]
        labels = payload["labels"]

        args = (owner["id"], owner["username"], owner["role"], proj["id"], proj["name"])

        # ── overlay: the annotations drawn on top of the image ──
        overlay_path = storage.overlay_file_path(
            *args, image["id"], image["filename"]
        )
        src = Path(image["storage_path"]) if image["storage_path"] else None
        if anns and src and src.is_file():
            try:
                render_overlay(
                    src,
                    [SimpleNamespace(**a) for a in anns],
                    {l["id"]: SimpleNamespace(**l) for l in labels},
                    overlay_path,
                    image["width"],
                    image["height"],
                )
            except Exception:
                log.exception("Failed rendering overlay for image %s", image["id"])
        else:
            # No shapes left (or the source is gone) — a stale overlay must not
            # outlive the annotations it depicts.
            overlay_path.unlink(missing_ok=True)

        # ── this image's YOLO label file + the shared class files ──
        label_idx = {l["id"]: i for i, l in enumerate(labels)}
        yolo_root, yolo_labels_root = storage.yolo_dirs(*args)
        split = image["split"] if image["split"] in ("train", "val", "test") else "train"
        split_dir = yolo_labels_root / split
        split_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(image["filename"]).stem
        lines = []
        for a in anns:
            if a["label_id"] not in label_idx:
                continue
            line = yolo_seg_line(
                SimpleNamespace(**a), label_idx[a["label_id"]],
                image["width"], image["height"],
            )
            if line:
                lines.append(line)
        (split_dir / f"{stem}.txt").write_text("\n".join(lines))
        (yolo_root / "classes.txt").write_text(
            "\n".join(l["name"] for l in labels) + ("\n" if labels else "")
        )
        (yolo_root / "data.yaml").write_text(
            f"# YOLO labels for project {proj['name']!r}. Images live in the\n"
            f"# sibling project/{proj['id']}_{storage._safe(proj['name'])}/images/ folder.\n"
            f"train: labels/train\nval: labels/val\ntest: labels/test\n\n"
            f"nc: {len(labels)}\nnames: {[l['name'] for l in labels]}\n"
        )

        # ── patch this image's entries into the project's live COCO file ──
        coco_id = {l["id"]: i + 1 for i, l in enumerate(labels)}
        coco_path = storage.coco_export_path(*args)
        coco = {
            "info": {"description": f"RBG export: {proj['name']}", "version": "1.0"},
            "licenses": [], "images": [], "annotations": [], "categories": [],
        }
        if coco_path.is_file():
            try:
                coco = json.loads(coco_path.read_text())
            except Exception:
                log.warning(
                    "COCO export for project %s unreadable; rebuilding", proj["id"]
                )
        coco["categories"] = [
            {"id": coco_id[l["id"]], "name": l["name"], "supercategory": "object"}
            for l in labels
        ]
        coco["images"] = [
            im for im in coco.get("images", []) if im.get("id") != image["id"]
        ]
        coco["annotations"] = [
            a for a in coco.get("annotations", []) if a.get("image_id") != image["id"]
        ]
        coco["images"].append({
            "id": image["id"], "file_name": image["filename"],
            "width": image["width"], "height": image["height"],
        })
        img_ns = SimpleNamespace(width=image["width"], height=image["height"])
        for a in anns:
            if a["label_id"] not in coco_id:
                continue
            try:
                seg, bbox, area = coco_segmentation(SimpleNamespace(**a), img_ns)
            except ValueError:
                continue
            coco["annotations"].append({
                "id": a["id"], "image_id": image["id"],
                "category_id": coco_id[a["label_id"]],
                "segmentation": seg, "area": area, "bbox": bbox, "iscrowd": 0,
            })
        tmp = coco_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(coco, indent=2, default=str))
        tmp.replace(coco_path)

        # ── project-scoped log line ──
        storage.append_project_log(
            *args,
            f"{payload['action']} image={image['id']} ({image['filename']}) "
            f"annotations={len(anns)} by={payload['actor']}",
        )
    except Exception:  # pragma: no cover - a mirror must never crash anything
        log.exception("Failed writing export artifacts")


async def _sync_export_artifacts(
    db: AsyncSession,
    image: Image,
    action: str,
    user: User | None,
    background: BackgroundTasks | None = None,
) -> None:
    """Mirror this image's annotations to disk.

    The small JSON backup is written inline (it is a few KB and its path is
    stored on the image row). Everything expensive — the overlay render, the
    COCO rewrite, the YOLO files — is handed to `background` so the caller can
    respond immediately.
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
        rows = (await db.execute(
            select(Annotation).where(Annotation.image_id == image.id).order_by(Annotation.id)
        )).scalars().all()

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

        # Inline: the JSON backup. Small, and images.annotations_path must point
        # at it as part of this transaction.
        json_path = storage.annotations_file_path(
            owner.id, owner.username, owner.role, project.id, project.name, image.id,
        )
        storage.write_annotations_json(
            json_path,
            {
                "image_id": image.id,
                "project_id": image.project_id,
                "filename": image.filename,
                "width": image.width,
                "height": image.height,
                "status": image.status,
            },
            ann_list,
        )
        image.annotations_path = str(json_path)

        # Deferred: everything that reads or re-encodes the image.
        payload = {
            "action": action,
            "actor": user.username if user else "system",
            "owner": {"id": owner.id, "username": owner.username, "role": owner.role},
            "project": {"id": project.id, "name": project.name},
            "image": {
                "id": image.id, "filename": image.filename,
                "width": image.width, "height": image.height,
                "split": image.split, "storage_path": image.storage_path,
            },
            "annotations": ann_list,
            "labels": [
                {
                    "id": l.id, "name": l.name, "color": l.color,
                    "keypoint_names": l.keypoint_names,
                }
                for l in labels
            ],
        }
        if background is not None:
            background.add_task(_write_artifacts, payload)
        else:
            _write_artifacts(payload)
    except Exception:  # pragma: no cover - backup must never break the request
        log.exception("Failed syncing annotations for image %s", image.id)



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

    # The image's status AFTER this write. Creating the first shape flips an
    # image from "unannotated" to "in_progress" server-side, and the client has
    # no other way to learn that happened — it used to keep showing the stale
    # status for the rest of the session. Reporting it here keeps the rule in
    # one place instead of re-implementing it in the frontend.
    image_status: str | None = None

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
    background: BackgroundTasks,
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
    await _sync_export_artifacts(db, img, Action.ANNOTATION_CREATE, user, background)
    await db.commit()
    await db.refresh(ann)
    await db.refresh(img)
    # Tell the client where the image ended up, so it can show "In progress"
    # without reloading. Set on the response object only — `ann` is an ORM row
    # and image_status is not one of its columns.
    out = AnnotationOut.model_validate(ann).model_dump()
    out["image_status"] = img.status
    return out


@router.patch("/annotations/{annotation_id}", response_model=AnnotationOut)
async def update_annotation(
    annotation_id: int,
    payload: AnnotationUpdate,
    background: BackgroundTasks,
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
        await _sync_export_artifacts(db, img, Action.ANNOTATION_UPDATE, user, background)
    await db.commit()
    await db.refresh(ann)
    return ann


@router.delete("/annotations/{annotation_id}")
async def delete_annotation(
    annotation_id: int,
    background: BackgroundTasks,
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
        await _sync_export_artifacts(db, img, Action.ANNOTATION_DELETE, user, background)
    await db.commit()
    return {"ok": True}
