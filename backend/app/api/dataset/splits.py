"""Dataset split assignment (train / val / test).

Splitting a dataset is dataset *curation*, not annotation work, so both
endpoints here are admin-only — the same tier as creating versions or
exporting. (Admins bypass project membership, so no separate membership check
is needed once `require_admin` has run.)
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.security import require_admin
from app.db.database import get_db
from app.models import Image, Project, User

router = APIRouter(prefix="/api", tags=["splits"])


class SplitAssignment(BaseModel):
    image_id: int
    split: str


@router.patch("/images/split")
async def update_split(
    payload: SplitAssignment,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    img = await db.get(Image, payload.image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    if payload.split not in ("train", "val", "test"):
        raise HTTPException(400, "Bad split")
    img.split = payload.split
    await db.commit()
    return {"ok": True}


class AutoSplitRequest(BaseModel):
    project_id: int
    train_pct: float = 0.7
    val_pct: float = 0.2
    test_pct: float = 0.1
    only_annotated: bool = False


@router.post("/projects/auto-split")
async def auto_split(
    payload: AutoSplitRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    import random
    total = payload.train_pct + payload.val_pct + payload.test_pct
    if abs(total - 1.0) > 0.001:
        raise HTTPException(400, "Percentages must sum to 1.0")

    project = await db.get(Project, payload.project_id)
    q = select(Image).where(Image.project_id == payload.project_id)
    if project and project.active_version_id:
        q = q.where(Image.version_id == project.active_version_id)
    if payload.only_annotated:
        q = q.where(Image.status.in_(["in_progress", "annotated", "needs_review", "approved"]))
    res = await db.execute(q)
    imgs = list(res.scalars().all())
    random.shuffle(imgs)

    n = len(imgs)
    n_train = int(n * payload.train_pct)
    n_val = int(n * payload.val_pct)
    for i, img in enumerate(imgs):
        if i < n_train:
            img.split = "train"
        elif i < n_train + n_val:
            img.split = "val"
        else:
            img.split = "test"
    await db.commit()
    return {
        "train": n_train,
        "val": n_val,
        "test": n - n_train - n_val,
        "total": n,
    }
