"""Activity feed and audit-log search.

A plain user may read their own history; an admin sees everyone's.
"""
import csv
import io
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import current_user, require_admin
from app.db.database import get_db
from app.models import ActivityLog, User, utcnow

router = APIRouter(prefix="/api/activity", tags=["activity"])


class ActivityOut(BaseModel):
    id: int
    user_id: int | None
    username: str
    action: str
    project_id: int | None
    image_id: int | None
    annotation_id: int | None
    details: dict | None
    created_at: datetime

    class Config:
        from_attributes = True


def _apply_filters(q, *, project_id, user_id, action, since, until):
    if project_id is not None:
        q = q.where(ActivityLog.project_id == project_id)
    if user_id is not None:
        q = q.where(ActivityLog.user_id == user_id)
    if action:
        # Prefix match so "annotation" catches create/update/delete.
        q = q.where(ActivityLog.action.startswith(action))
    if since:
        q = q.where(ActivityLog.created_at >= since)
    if until:
        q = q.where(ActivityLog.created_at <= until)
    return q


@router.get("", response_model=list[ActivityOut])
async def list_activity(
    project_id: int | None = None,
    user_id: int | None = None,
    action: str | None = None,
    days: int | None = Query(None, ge=1, le=365),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """The admin activity feed. Annotators are scoped to their own rows."""
    if not user.can_review:
        if user_id not in (None, user.id):
            raise HTTPException(403, "You can only view your own activity")
        user_id = user.id

    since = utcnow() - timedelta(days=days) if days else None
    q = _apply_filters(
        select(ActivityLog),
        project_id=project_id, user_id=user_id, action=action,
        since=since, until=None,
    )
    q = q.order_by(ActivityLog.created_at.desc()).limit(limit).offset(offset)
    res = await db.execute(q)
    return res.scalars().all()


@router.get("/export.csv")
async def export_activity_csv(
    project_id: int | None = None,
    user_id: int | None = None,
    action: str | None = None,
    days: int | None = Query(None, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Download the filtered audit log as CSV."""
    since = utcnow() - timedelta(days=days) if days else None
    q = _apply_filters(
        select(ActivityLog),
        project_id=project_id, user_id=user_id, action=action,
        since=since, until=None,
    ).order_by(ActivityLog.created_at.desc()).limit(50000)
    rows = (await db.execute(q)).scalars().all()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        ["timestamp", "username", "action", "project_id", "image_id",
         "annotation_id", "details"]
    )
    for r in rows:
        w.writerow([
            r.created_at.isoformat() if r.created_at else "",
            r.username, r.action, r.project_id or "", r.image_id or "",
            r.annotation_id or "", r.details or "",
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=activity_log.csv"},
    )


@router.get("/users/{target_id}", response_model=list[ActivityOut])
async def user_history(
    target_id: int,
    limit: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Per-user drill-down. Own history is always visible."""
    if target_id != user.id and not user.can_review:
        raise HTTPException(403, "You can only view your own activity")
    res = await db.execute(
        select(ActivityLog)
        .where(ActivityLog.user_id == target_id)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )
    return res.scalars().all()
