"""Dataset version registry — Roboflow-style snapshots.

Versions are dataset management (fork the current dataset into a frozen
snapshot, switch which snapshot is "active"), so every endpoint here is
admin-only. Admins bypass project membership, so `require_admin` is sufficient.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

from app.core.security import require_admin
from app.db.database import get_db
from app.models import Project, DatasetVersion, Image, Annotation, User

router = APIRouter(prefix="/api/projects/{project_id}/versions", tags=["versions"])


class VersionOut(BaseModel):
    id: int
    name: str
    version_number: int
    parent_version_id: int | None
    is_frozen: bool

    class Config:
        from_attributes = True


class VersionCreate(BaseModel):
    name: str
    freeze: bool = False


@router.get("", response_model=list[VersionOut])
async def list_versions(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    res = await db.execute(
        select(DatasetVersion)
        .where(DatasetVersion.project_id == project_id)
        .order_by(DatasetVersion.version_number)
    )
    return res.scalars().all()


@router.post("", response_model=VersionOut)
async def create_version(
    project_id: int,
    payload: VersionCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Fork current active version into a new dataset version."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    max_num = await db.scalar(
        select(func.max(DatasetVersion.version_number)).where(
            DatasetVersion.project_id == project_id
        )
    )
    next_num = (max_num or 0) + 1

    parent_id = project.active_version_id
    version = DatasetVersion(
        project_id=project_id,
        name=payload.name,
        version_number=next_num,
        parent_version_id=parent_id,
        is_frozen=payload.freeze,
    )
    db.add(version)
    await db.flush()

    # Copy images + annotations from active version
    if parent_id:
        src_res = await db.execute(
            select(Image)
            .where(Image.project_id == project_id, Image.version_id == parent_id)
            .options(selectinload(Image.annotations))
        )
        for src in src_res.scalars().all():
            new_img = Image(
                project_id=project_id,
                version_id=version.id,
                filename=src.filename,
                storage_path=src.storage_path,
                width=src.width,
                height=src.height,
                status=src.status,
                split=src.split,
                sequence_id=src.sequence_id,
                frame_index=src.frame_index,
            )
            db.add(new_img)
            await db.flush()
            for ann in src.annotations:
                db.add(
                    Annotation(
                        image_id=new_img.id,
                        label_id=ann.label_id,
                        type=ann.type,
                        geometry=ann.geometry,
                        confidence=ann.confidence,
                        source=ann.source,
                    )
                )

    project.active_version_id = version.id
    await db.commit()
    await db.refresh(version)
    return version


@router.post("/{version_id}/activate")
async def activate_version(
    project_id: int,
    version_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    version = await db.get(DatasetVersion, version_id)
    if not version or version.project_id != project_id:
        raise HTTPException(404, "Version not found")
    project = await db.get(Project, project_id)
    project.active_version_id = version_id
    await db.commit()
    return {"ok": True, "active_version_id": version_id}
