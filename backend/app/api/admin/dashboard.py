"""Admin dashboards. Read-only metrics; admin role required throughout.

Endpoints, grouped by what they answer:
  progress & velocity   /overview, /velocity, /contributors
  quality & agreement   /quality, /agreement
  workload & review     /workload, /review-queue
  activity feed         (see api/admin/activity.py)

Note: /overview and /review-queue are the two the UI currently renders.
/velocity, /quality and /workload are implemented and wired into
`frontend/src/lib/api/client.js`, but no component displays them yet.
"""
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import current_user, require_admin
from app.db.database import get_db
from app.models import (
    Action, ActivityLog, Annotation, Image, Project, User, utcnow,
)
from app.services import activity
from app.services.metrics import iou_matrix, pairwise_agreement

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _images_of_user(user_id: int):
    """Subquery: image ids in projects assigned to this user.

    Under the single-user-per-project model there is no per-image assignment;
    an image "belongs" to a user through its project's assigned_user_id. The
    dashboards use this in place of the old `Image.assigned_to == user`.
    """
    return select(Image.id).join(Project, Image.project_id == Project.id).where(
        Project.assigned_user_id == user_id
    )

STATUSES = (
    "unannotated", "in_progress", "annotated",
    "needs_review", "approved", "rejected",
)


def _aware(dt):
    from datetime import timezone
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ─── C1 · Progress & velocity ────────────────────────────────────────
@router.get("/overview")
async def overview(
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Headline numbers: completion split, totals, and projected finish."""
    q = select(Image.status, func.count()).group_by(Image.status)
    if project_id:
        q = q.where(Image.project_id == project_id)
    by_status = {s: 0 for s in STATUSES}
    for status, n in (await db.execute(q)).all():
        by_status[status] = n
    total = sum(by_status.values())

    done = by_status["approved"]
    in_flight = by_status["annotated"] + by_status["needs_review"]
    remaining = total - done

    aq = select(func.count()).select_from(Annotation)
    uq = select(func.count()).select_from(User).where(User.status == "active")
    if project_id:
        aq = aq.join(Image, Annotation.image_id == Image.id).where(
            Image.project_id == project_id
        )

    # Throughput over the last 7 days → naive ETA.
    week_ago = utcnow() - timedelta(days=7)
    recent_q = (
        select(func.count())
        .select_from(ActivityLog)
        .where(
            ActivityLog.action == Action.REVIEW_APPROVE,
            ActivityLog.created_at >= week_ago,
        )
    )
    if project_id:
        recent_q = recent_q.where(ActivityLog.project_id == project_id)
    approved_last_week = await db.scalar(recent_q) or 0
    per_day = approved_last_week / 7 if approved_last_week else 0
    eta_days = round(remaining / per_day, 1) if per_day > 0 else None

    return {
        "total_images": total,
        "by_status": by_status,
        "completion_pct": round(done / total * 100, 1) if total else 0.0,
        "in_flight": in_flight,
        "remaining": remaining,
        "total_annotations": await db.scalar(aq) or 0,
        "active_users": await db.scalar(uq) or 0,
        "approved_last_7_days": approved_last_week,
        "throughput_per_day": round(per_day, 2),
        "projected_days_remaining": eta_days,
    }


@router.get("/velocity")
async def velocity(
    project_id: int | None = None,
    days: int = Query(14, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Daily completed-vs-approved counts, for the trend chart."""
    since = utcnow() - timedelta(days=days)
    q = select(ActivityLog).where(
        ActivityLog.created_at >= since,
        ActivityLog.action.in_(
            [Action.IMAGE_STATUS, Action.REVIEW_APPROVE, Action.ANNOTATION_CREATE]
        ),
    )
    if project_id:
        q = q.where(ActivityLog.project_id == project_id)
    rows = (await db.execute(q)).scalars().all()

    buckets: dict[str, dict] = {}
    for i in range(days + 1):
        d = (utcnow().date() - timedelta(days=days - i)).isoformat()
        buckets[d] = {"date": d, "annotations": 0, "approved": 0, "completed": 0}

    for r in rows:
        created = _aware(r.created_at)
        if not created:
            continue
        key = created.date().isoformat()
        if key not in buckets:
            continue
        if r.action == Action.ANNOTATION_CREATE:
            buckets[key]["annotations"] += 1
        elif r.action == Action.REVIEW_APPROVE:
            buckets[key]["approved"] += 1
        elif r.action == Action.IMAGE_STATUS:
            if (r.details or {}).get("to") == "annotated":
                buckets[key]["completed"] += 1

    return {"days": days, "series": list(buckets.values())}


@router.get("/contributors")
async def contributors(
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Per-user contribution table."""
    users = (
        await db.execute(select(User).where(User.status == "active").order_by(User.username))
    ).scalars().all()

    today = utcnow().date()
    week_ago = utcnow() - timedelta(days=7)

    out = []
    for u in users:
        aq = select(func.count()).select_from(Annotation).where(
            Annotation.created_by == u.id
        )
        if project_id:
            aq = aq.join(Image, Annotation.image_id == Image.id).where(
                Image.project_id == project_id
            )
        total_ann = await db.scalar(aq) or 0

        recent = (
            await db.execute(
                select(ActivityLog).where(
                    ActivityLog.user_id == u.id,
                    ActivityLog.created_at >= week_ago,
                )
            )
        ).scalars().all()
        today_count = sum(
            1 for r in recent
            if r.action == Action.ANNOTATION_CREATE
            and _aware(r.created_at) and _aware(r.created_at).date() == today
        )
        week_count = sum(1 for r in recent if r.action == Action.ANNOTATION_CREATE)

        assigned = await db.scalar(
            select(func.count()).select_from(Image).where(
                Image.id.in_(_images_of_user(u.id))
            )
        ) or 0
        approved = await db.scalar(
            select(func.count()).select_from(Image).where(
                Image.id.in_(_images_of_user(u.id)), Image.status == "approved"
            )
        ) or 0

        out.append({
            "user_id": u.id,
            "username": u.username,
            "full_name": u.full_name,
            "role": u.role,
            "annotations_total": total_ann,
            "annotations_today": today_count,
            "annotations_this_week": week_count,
            "images_assigned": assigned,
            "images_approved": approved,
            "last_login_at": u.last_login_at,
        })
    out.sort(key=lambda r: r["annotations_total"], reverse=True)
    return {"contributors": out}


# ─── C2 · Quality & agreement ────────────────────────────────────────
@router.get("/quality")
async def quality(
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Rejection rate and labelling density per annotator.

    Rejection rate is the strongest quality signal available: of the images a
    person worked on that a reviewer has ruled on, how many were sent back.
    """
    users = (
        await db.execute(select(User).where(User.status == "active"))
    ).scalars().all()

    # Project-wide average annotations per image, as a comparison baseline.
    img_q = select(func.count()).select_from(Image)
    ann_q = select(func.count()).select_from(Annotation)
    if project_id:
        img_q = img_q.where(Image.project_id == project_id)
        ann_q = ann_q.join(Image, Annotation.image_id == Image.id).where(
            Image.project_id == project_id
        )
    total_images = await db.scalar(img_q) or 0
    total_anns = await db.scalar(ann_q) or 0
    project_avg = round(total_anns / total_images, 2) if total_images else 0.0

    rows = []
    for u in users:
        base = select(func.count()).select_from(Image).where(
            Image.id.in_(_images_of_user(u.id))
        )
        if project_id:
            base = base.where(Image.project_id == project_id)
        approved = await db.scalar(base.where(Image.status == "approved")) or 0
        rejected = await db.scalar(base.where(Image.status == "rejected")) or 0
        judged = approved + rejected

        # Images this user actually drew on, and how densely.
        touched_q = (
            select(func.count(func.distinct(Annotation.image_id)))
            .where(Annotation.created_by == u.id)
        )
        ann_count_q = select(func.count()).select_from(Annotation).where(
            Annotation.created_by == u.id
        )
        if project_id:
            touched_q = touched_q.join(Image, Annotation.image_id == Image.id).where(
                Image.project_id == project_id
            )
            ann_count_q = ann_count_q.join(
                Image, Annotation.image_id == Image.id
            ).where(Image.project_id == project_id)
        touched = await db.scalar(touched_q) or 0
        made = await db.scalar(ann_count_q) or 0

        rows.append({
            "user_id": u.id,
            "username": u.username,
            "images_judged": judged,
            "approved": approved,
            "rejected": rejected,
            "rejection_rate": round(rejected / judged * 100, 1) if judged else None,
            "images_touched": touched,
            "annotations_made": made,
            "avg_annotations_per_image": round(made / touched, 2) if touched else 0.0,
            "vs_project_avg": (
                round(made / touched - project_avg, 2) if touched else None
            ),
        })
    rows.sort(key=lambda r: (r["rejection_rate"] is None, -(r["rejection_rate"] or 0)))
    return {"project_avg_annotations_per_image": project_avg, "annotators": rows}


@router.get("/agreement")
async def agreement(
    project_id: int | None = None,
    iou_threshold: float = Query(0.5, ge=0.1, le=0.95),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Inter-annotator agreement.

    Finds images that more than one person annotated and compares their work
    geometrically: for each pair, what fraction of one's boxes have a matching
    box from the other above the IoU threshold. This is the metric that makes
    multiple annotators on one image worth having — it quantifies whether two
    people label the same thing the same way.
    """
    q = (
        select(Annotation.image_id, Annotation.created_by)
        .where(Annotation.created_by.is_not(None))
        .distinct()
    )
    if project_id:
        q = q.join(Image, Annotation.image_id == Image.id).where(
            Image.project_id == project_id
        )
    pairs = (await db.execute(q)).all()

    by_image: dict[int, set[int]] = defaultdict(set)
    for image_id, uid in pairs:
        by_image[image_id].add(uid)
    shared = {i: us for i, us in by_image.items() if len(us) > 1}

    if not shared:
        return {
            "images_compared": 0,
            "note": "No image has been annotated by more than one person yet.",
            "pairs": [],
            "per_image": [],
        }

    usernames = {
        u.id: u.username
        for u in (await db.execute(select(User))).scalars().all()
    }

    anns = (
        await db.execute(
            select(Annotation).where(Annotation.image_id.in_(list(shared.keys())))
        )
    ).scalars().all()

    grouped: dict[tuple[int, int], list] = defaultdict(list)
    for a in anns:
        if a.created_by is not None:
            grouped[(a.image_id, a.created_by)].append(a)

    pair_scores: dict[tuple[int, int], list[float]] = defaultdict(list)
    per_image = []
    for image_id, users_on_image in shared.items():
        ordered = sorted(users_on_image)
        image_scores = []
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                a_list = grouped[(image_id, ordered[i])]
                b_list = grouped[(image_id, ordered[j])]
                score = pairwise_agreement(a_list, b_list, iou_threshold)
                pair_scores[(ordered[i], ordered[j])].append(score)
                image_scores.append(score)
        per_image.append({
            "image_id": image_id,
            "annotators": [usernames.get(u, str(u)) for u in ordered],
            "agreement": round(sum(image_scores) / len(image_scores), 3)
            if image_scores else 0.0,
        })

    pairs_out = [
        {
            "user_a": usernames.get(a, str(a)),
            "user_b": usernames.get(b, str(b)),
            "images_compared": len(scores),
            "mean_agreement": round(sum(scores) / len(scores), 3),
        }
        for (a, b), scores in pair_scores.items()
    ]
    pairs_out.sort(key=lambda r: r["mean_agreement"])

    overall = [s for scores in pair_scores.values() for s in scores]
    return {
        "iou_threshold": iou_threshold,
        "images_compared": len(shared),
        "mean_agreement": round(sum(overall) / len(overall), 3) if overall else 0.0,
        "pairs": pairs_out,
        "per_image": sorted(per_image, key=lambda r: r["agreement"])[:50],
    }


# ─── C4 · Workload ───────────────────────────────────────────────────
# Per-image assignment and image locks were removed with the multi-user model.
# "Workload" is now measured over the projects assigned to each user.
@router.get("/workload")
async def workload(
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Per-annotator: images in their assigned projects, pending vs completed,
    plus the count of images in projects that have no assigned user yet."""
    users = (
        await db.execute(
            select(User).where(User.status == "active").order_by(User.username)
        )
    ).scalars().all()

    rows = []
    for u in users:
        base = select(func.count()).select_from(Image).where(
            Image.id.in_(_images_of_user(u.id))
        )
        if project_id:
            base = base.where(Image.project_id == project_id)
        assigned = await db.scalar(base) or 0
        pending = await db.scalar(
            base.where(Image.status.in_(["unannotated", "in_progress"]))
        ) or 0
        done = await db.scalar(
            base.where(Image.status.in_(["annotated", "needs_review", "approved"]))
        ) or 0
        rows.append({
            "user_id": u.id,
            "username": u.username,
            "role": u.role,
            "assigned": assigned,
            "pending": pending,
            "completed": done,
            "completion_pct": round(done / assigned * 100, 1) if assigned else 0.0,
        })

    # Backlog: images in projects that have not been assigned to anyone.
    unassigned_q = select(func.count()).select_from(Image).where(
        Image.project_id.in_(
            select(Project.id).where(Project.assigned_user_id.is_(None))
        )
    )
    if project_id:
        unassigned_q = unassigned_q.where(Image.project_id == project_id)

    return {"workload": rows, "unassigned": await db.scalar(unassigned_q) or 0}


@router.get("/review-queue")
async def review_queue(
    project_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Images waiting on a reviewer, oldest first."""
    q = select(Image).where(Image.status.in_(["annotated", "needs_review"]))
    if project_id:
        q = q.where(Image.project_id == project_id)
    q = q.order_by(Image.created_at).limit(limit)
    images = (await db.execute(q)).scalars().all()

    # Map each project to its assigned user's name, so the queue can show who
    # owns each image (its project's assignee) without a per-image field.
    proj_assignee = {
        pid: uid
        for pid, uid in (
            await db.execute(select(Project.id, Project.assigned_user_id))
        ).all()
    }
    usernames = {
        u.id: u.username for u in (await db.execute(select(User))).scalars().all()
    }
    out = []
    for img in images:
        n = await db.scalar(
            select(func.count()).select_from(Annotation).where(
                Annotation.image_id == img.id
            )
        )
        out.append({
            "image_id": img.id,
            "project_id": img.project_id,
            "filename": img.filename,
            "status": img.status,
            "assigned_to": usernames.get(proj_assignee.get(img.project_id)),
            "annotation_count": n or 0,
        })
    return {"queue": out, "count": len(out)}
