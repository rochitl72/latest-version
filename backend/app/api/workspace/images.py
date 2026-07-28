"""Image upload, listing, and file serving.

The upload path does three safety checks on every file before it is accepted:
  1. Extension allowlist — the stored name is a random UUID, so the extension
     is the only attacker-controlled part of the path.
  2. A hard size cap enforced while streaming to disk, so an oversized file can
     never be buffered in memory or fill the volume.
  3. A real image-decode check (Pillow), so something merely wearing an image
     extension is rejected.

Files are stored on disk (not in the database) at
`STORAGE_DIR/project_{id}/{xx}/{uuid}.ext`. The extra `{xx}` shard directory
keeps any single folder small so the filesystem stays fast at tens of thousands
of images. The database row only holds the path.

Membership is required to list a project's images; uploading and deleting are
admin-only.
"""
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from PIL import Image as PILImage

from app.core.config import settings
from app.core.security import current_user, current_user_or_cookie, require_admin
from app.db.database import get_db
from app.models import Action, DatasetVersion, Image, Project, User, utcnow
from app.services import activity, membership, storage

log = logging.getLogger("annoforge.images")

router = APIRouter(prefix="/api/projects/{project_id}/images", tags=["images"])

# Serving the image bytes lives on its own router because it needs a different
# guard: <img> tags can't send an Authorization header, so this one route also
# accepts the auth cookie. It is read-only, so that carries no CSRF risk.
file_router = APIRouter(prefix="/api/projects/{project_id}/images", tags=["images"])

# Read uploads in 1 MB chunks so large files never sit in memory whole.
CHUNK_SIZE = 1024 * 1024

EXT_TO_MEDIA_TYPE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}


class ImageOut(BaseModel):
    id: int
    filename: str
    width: int
    height: int
    status: str
    split: str
    sequence_id: str = ""
    frame_index: int = 0
    version_id: int | None = None

    class Config:
        from_attributes = True


async def _ensure_version(db: AsyncSession, project: Project) -> int:
    if project.active_version_id:
        return project.active_version_id
    v = DatasetVersion(project_id=project.id, name="v1 — working", version_number=1)
    db.add(v)
    await db.flush()
    project.active_version_id = v.id
    orphans = await db.execute(
        select(Image).where(Image.project_id == project.id, Image.version_id.is_(None))
    )
    for img in orphans.scalars().all():
        img.version_id = v.id
    await db.commit()
    return v.id


@router.get("", response_model=list[ImageOut])
async def list_images(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    await membership.assert_member(db, project_id, user)
    await _ensure_version(db, project)
    q = select(Image).where(
        Image.project_id == project_id,
        Image.version_id == project.active_version_id,
    )
    q = q.order_by(Image.sequence_id, Image.frame_index, Image.id)
    res = await db.execute(q)
    return res.scalars().all()


@router.post("/upload", response_model=list[ImageOut])
async def upload_images(
    project_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    # A project's files live under its assigned user's folder, so the project
    # must have an assigned user before any images can be uploaded to it.
    if not project.assigned_user_id:
        raise HTTPException(
            409,
            "Assign a user to this project before uploading images "
            "(files are stored under the assigned user's folder).",
        )
    owner = await db.get(User, project.assigned_user_id)
    if not owner:
        raise HTTPException(409, "The project's assigned user no longer exists.")

    if len(files) > settings.MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            413,
            f"Too many files in one request "
            f"(got {len(files)}, limit {settings.MAX_FILES_PER_UPLOAD}).",
        )

    storage.ensure_project_dirs(owner.id, owner.username, project.id, project.name)

    version_id = project.active_version_id
    if not version_id:
        v = DatasetVersion(project_id=project_id, name="v1", version_number=1)
        db.add(v)
        await db.flush()
        project.active_version_id = v.id
        version_id = v.id

    sequence_id = uuid.uuid4().hex[:12]
    saved = []
    for frame_idx, file in enumerate(files):
        # 1. Extension allowlist. The stored name is a UUID, so the extension
        #    is the only attacker-controlled part of the path — restricting it
        #    stops us serving .html/.svg back from our own origin later.
        ext = Path(file.filename or "img.jpg").suffix.lower()
        if ext not in settings.ALLOWED_IMAGE_EXTENSIONS:
            log.warning(
                "Rejected upload %r: extension %r not allowed",
                file.filename, ext,
            )
            continue

        # Store under the assigned user's project folder, sharded by the first
        # two hex chars of the UUID so no single directory accumulates tens of
        # thousands of files. Layout:
        #   storage/users/{owner}/projects/{project}/images/{ab}/{uuid}.ext
        unique_hex = uuid.uuid4().hex
        target = storage.image_target_path(
            owner.id, owner.username, project.id, project.name, unique_hex, ext,
        )

        # 2. Stream to disk with a hard size cap, so an oversized upload can
        #    never be held in memory or fill the volume.
        written = 0
        too_big = False
        try:
            with target.open("wb") as out:
                while chunk := await file.read(CHUNK_SIZE):
                    written += len(chunk)
                    if written > settings.max_upload_bytes:
                        too_big = True
                        break
                    out.write(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            log.exception("Failed writing upload %r", file.filename)
            continue

        if too_big:
            target.unlink(missing_ok=True)
            log.warning(
                "Rejected upload %r: exceeds %d MB limit",
                file.filename, settings.MAX_UPLOAD_MB,
            )
            continue

        # 3. Confirm the bytes really are a decodable image, not just something
        #    wearing an image extension. verify() consumes the file object, so
        #    reopen afterwards to read the dimensions.
        try:
            with PILImage.open(target) as probe:
                probe.verify()
            with PILImage.open(target) as img:
                w, h = img.size
        except Exception:
            target.unlink(missing_ok=True)
            log.warning("Rejected upload %r: not a valid image", file.filename)
            continue

        img_row = Image(
            project_id=project_id,
            version_id=version_id,
            filename=file.filename or unique,
            storage_path=str(target),
            width=w,
            height=h,
            sequence_id=sequence_id if len(files) > 1 else "",
            frame_index=frame_idx if len(files) > 1 else 0,
        )
        db.add(img_row)
        saved.append(img_row)

    await db.flush()
    await activity.record(
        db, user, Action.IMAGE_UPLOAD,
        project_id=project_id,
        details={"count": len(saved), "rejected": len(files) - len(saved)},
    )
    await db.commit()
    for img in saved:
        await db.refresh(img)
    return saved


@router.get("/{image_id}", response_model=ImageOut)
async def get_image_meta(
    project_id: int,
    image_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    img = await db.get(Image, image_id)
    if not img or img.project_id != project_id:
        raise HTTPException(404, "Image not found")
    await membership.assert_member(db, project_id, user)
    return img


@file_router.get("/{image_id}/file")
async def get_image_file(
    project_id: int,
    image_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user_or_cookie),
):
    img = await db.get(Image, image_id)
    if not img or img.project_id != project_id:
        raise HTTPException(404, "Image not found")
    await membership.assert_member(db, project_id, user)
    p = Path(img.storage_path)
    if not p.exists():
        raise HTTPException(404, "File missing on disk")

    # Pin the content type to a known image type rather than letting it be
    # inferred, and tell the browser not to sniff. Uploads are already
    # restricted to real images, so this is belt-and-braces against anything
    # that slipped in before these checks existed.
    media_type = EXT_TO_MEDIA_TYPE.get(p.suffix.lower(), "application/octet-stream")
    return FileResponse(
        p,
        media_type=media_type,
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.delete("/{image_id}")
async def delete_image(
    project_id: int,
    image_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    img = await db.get(Image, image_id)
    if not img or img.project_id != project_id:
        raise HTTPException(404, "Image not found")
    Path(img.storage_path).unlink(missing_ok=True)
    await activity.record(
        db, user, Action.IMAGE_DELETE,
        project_id=project_id, image_id=image_id,
        details={"filename": img.filename},
    )
    await db.delete(img)
    await db.commit()
    return {"ok": True}
