"""Annotations API — manual annotation CRUD.

Ownership rules:
  * a plain user may edit and delete only their own annotations
  * an admin may edit and delete anyone's
Project access is required for any of it: a project is reachable by an admin, or
by the single user it is assigned to (see `services/membership.py`). Every rule
here is enforced server-side, so a client that skips a check still cannot write.

An image with status "approved" is frozen to everyone but an admin.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import current_user
from app.db.database import get_db
from app.models import Action, Annotation, Image, Label, Project, User, utcnow
from app.services import activity, membership, storage

router = APIRouter(prefix="/api", tags=["annotations"])


async def _sync_annotations_file(db: AsyncSession, image: Image) -> None:
    """Rewrite this image's annotations.json backup to match the DB, and store
    its path on the image row.

    This is the "annotations as files for backup" half of the dual-write:
    Postgres stays the authoritative, queryable store (so dashboards, stats,
    filtering and fast export keep working), and after every change we mirror
    the image's current annotations to a JSON file under the owning user's
    project folder. Best-effort: a disk failure must not roll back a saved
    annotation, so problems are swallowed by the storage layer / caught here.
    """
    try:
        project = await db.get(Project, image.project_id)
        if not project or not project.assigned_user_id:
            return  # no owner folder to write into yet
        owner = await db.get(User, project.assigned_user_id)
        if not owner:
            return
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
        meta = {
            "image_id": image.id,
            "project_id": image.project_id,
            "filename": image.filename,
            "width": image.width,
            "height": image.height,
            "status": image.status,
        }
        path = storage.annotations_file_path(
            owner.id, owner.username, project.id, project.name, image.id,
        )
        storage.write_annotations_json(path, meta, ann_list)
        image.annotations_path = str(path)
    except Exception:  # pragma: no cover - backup must never break the request
        import logging
        logging.getLogger("annoforge.annotations").exception(
            "Failed syncing annotations.json for image %s", image.id
        )


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
    await _sync_annotations_file(db, img)
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
        await _sync_annotations_file(db, img)
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
        await _sync_annotations_file(db, img)
    await db.commit()
    return {"ok": True}
