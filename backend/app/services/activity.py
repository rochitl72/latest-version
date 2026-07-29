"""Audit trail helper.

Every mutating endpoint calls `record()` so the admin activity feed and the
per-user history have a single source of truth.
"""
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ActivityLog, User

log = logging.getLogger("annoforge.activity")


async def record(
    db: AsyncSession,
    user: User | None,
    action: str,
    *,
    project_id: int | None = None,
    image_id: int | None = None,
    annotation_id: int | None = None,
    details: dict | None = None,
    commit: bool = False,
) -> None:
    """Append one audit row.

    Added to the caller's session so it lands in the same transaction as the
    change it describes — an action and its log entry are committed together
    or not at all. Pass commit=True only when there is no surrounding commit.

    Logging must never break the request it is describing, so failures here
    are swallowed and reported rather than raised.
    """
    try:
        db.add(
            ActivityLog(
                user_id=user.id if user else None,
                username=user.username if user else "",
                action=action,
                project_id=project_id,
                image_id=image_id,
                annotation_id=annotation_id,
                details=details,
            )
        )
        if commit:
            await db.commit()
    except Exception:
        log.exception("Failed to write activity log for action=%r", action)

    # Mirror the action to the acting user's plain-text activity.log on disk
    # (the "logs as files for backup" requirement). The Postgres table above
    # remains the searchable source for the admin activity feed; this file is
    # a human-readable per-user backup. Best-effort — never breaks the request.
    if user is not None:
        try:
            from app.services import storage

            bits = [action]
            if project_id is not None:
                bits.append(f"project={project_id}")
            if image_id is not None:
                bits.append(f"image={image_id}")
            if annotation_id is not None:
                bits.append(f"annotation={annotation_id}")
            storage.append_activity_log(user.id, user.username, user.role, " ".join(bits))
        except Exception:
            log.exception("Failed to mirror activity to file for action=%r", action)
