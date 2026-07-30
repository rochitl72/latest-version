"""Image review / approval workflow + bulk status operations.

Each image moves through a small state machine:

    unannotated → in_progress → annotated → needs_review → approved / rejected

Permission split (two-role model):
  * a plain user may move an image between unannotated / in_progress / annotated
    (the ordinary "I'm working on it / I'm done" transitions)
  * approved, rejected and needs_review are *review decisions* — admin only.
    These are the `REVIEW_STATUSES` below and are checked with `user.can_review`
    (which, under two roles, means "is an admin").
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import current_user
from app.db.database import get_db
from app.models import Action, Annotation, Image, Project, User, utcnow
from app.services import activity, membership

router = APIRouter(prefix="/api", tags=["workflow"])

VALID_STATUS = (
    "unannotated", "in_progress", "annotated",
    "needs_review", "approved", "rejected",
)

# Statuses that constitute a review decision — restricted to reviewers+.
REVIEW_STATUSES = {"approved", "rejected", "needs_review"}

STATUS_ACTION = {
    "approved": Action.REVIEW_APPROVE,
    "rejected": Action.REVIEW_REJECT,
    "needs_review": Action.REVIEW_REQUEST,
}


class StatusUpdate(BaseModel):
    image_id: int
    status: str
    note: str = ""


class BulkStatusUpdate(BaseModel):
    image_ids: list[int]
    status: str
    note: str = ""


class BulkDeleteRequest(BaseModel):
    annotation_ids: list[int]


def _check_status_permission(user: User, status: str, current: str | None = None) -> None:
    """Guard both ENDS of the transition.

    Checking only the destination was a real hole: `in_progress` is not a
    review status, so an assigned user could take an APPROVED image back to
    `in_progress` and then edit it freely — the annotation endpoint's
    "approved and locked" 403 was one click away from being bypassed, and the
    UI even told them to do it. An approval has to be undoable only by
    someone who could have granted it.

    Leaving `rejected` is deliberately NOT restricted: the whole point of a
    rejection is that the annotator picks the image back up and fixes it.
    """
    if status in REVIEW_STATUSES and not user.can_review:
        raise HTTPException(
            403,
            f"Setting an image to {status!r} is a review decision and requires "
            f"the admin role.",
        )
    if current == "approved" and status != "approved" and not user.can_review:
        raise HTTPException(
            403,
            "This image has been approved. Only an admin can reopen it — ask "
            "an admin to move it back to 'In progress' if it needs more work.",
        )


async def _apply_status(
    db: AsyncSession, user: User, img: Image, status: str, note: str
) -> None:
    previous = img.status
    img.status = status
    if status in REVIEW_STATUSES:
        img.reviewed_by = user.id
        img.reviewed_at = utcnow()
        img.review_note = note
    elif previous in REVIEW_STATUSES:
        # Leaving a review state: drop the old verdict. These fields used to
        # persist, so a rejected image pulled back to `in_progress` still
        # carried the reviewer's name, timestamp and rejection note and looked
        # as though it had been reviewed in its current state.
        img.reviewed_by = None
        img.reviewed_at = None
        img.review_note = ""
    await activity.record(
        db, user, STATUS_ACTION.get(status, Action.IMAGE_STATUS),
        project_id=img.project_id, image_id=img.id,
        details={"from": previous, "to": status, "note": note or None},
    )


@router.patch("/images/status")
async def update_image_status(
    payload: StatusUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    if payload.status not in VALID_STATUS:
        raise HTTPException(400, f"Invalid status. Use: {VALID_STATUS}")

    # Membership first: a non-member (non-admin) must not touch this image even
    # if they somehow know its id. Loading it here also gives us the CURRENT
    # status, which the permission check needs — leaving `approved` is itself
    # a privileged move, not just entering one.
    img = await membership.assert_member_by_image(db, payload.image_id, user)
    _check_status_permission(user, payload.status, img.status)

    await _apply_status(db, user, img, payload.status, payload.note)
    await db.commit()
    return {"ok": True, "status": payload.status}


@router.post("/images/bulk-status")
async def bulk_update_status(
    payload: BulkStatusUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Bulk approve/reject from the review queue."""
    if payload.status not in VALID_STATUS:
        raise HTTPException(400, "Invalid status")
    _check_status_permission(user, payload.status)

    updated = 0
    locked = 0
    for iid in payload.image_ids:
        img = await db.get(Image, iid)
        if not img:
            continue
        # Skip anything the caller isn't allowed on rather than failing the
        # whole batch — the counts tell them how many actually changed.
        if not await membership.is_member(db, img.project_id, user):
            continue
        # Same rule as the single update: a non-admin cannot pull an approved
        # image back out of approval, in bulk any more than one at a time.
        if img.status == "approved" and payload.status != "approved" \
                and not user.can_review:
            locked += 1
            continue
        await _apply_status(db, user, img, payload.status, payload.note)
        updated += 1
    await db.commit()
    return {"ok": True, "updated": updated, "skipped_approved": locked}


@router.post("/annotations/bulk-delete")
async def bulk_delete_annotations(
    payload: BulkDeleteRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    deleted, skipped = 0, 0
    for aid in payload.annotation_ids:
        ann = await db.get(Annotation, aid)
        if not ann:
            continue
        # Project membership first, then the same ownership rule as single-delete.
        img = await db.get(Image, ann.image_id)
        if not img or not await membership.is_member(db, img.project_id, user):
            skipped += 1
            continue
        if not (user.can_review or ann.created_by in (None, user.id)):
            skipped += 1
            continue
        await activity.record(
            db, user, Action.ANNOTATION_DELETE,
            image_id=ann.image_id, annotation_id=ann.id,
            details={"bulk": True, "type": ann.type},
        )
        await db.delete(ann)
        deleted += 1
    await db.commit()
    return {
        "ok": True,
        "deleted": deleted,
        "skipped_not_owned": skipped,
    }


@router.get("/projects/{project_id}/workflow-stats")
async def workflow_stats(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    await membership.assert_member(db, project_id, user)

    q = select(Image.status, func.count()).where(Image.project_id == project_id)
    if project.active_version_id:
        q = q.where(Image.version_id == project.active_version_id)
    q = q.group_by(Image.status)

    counts = {s: 0 for s in VALID_STATUS}
    total = 0
    for status, n in (await db.execute(q)).all():
        counts[status] = n
        total += n
    return {"total": total, "by_status": counts}
