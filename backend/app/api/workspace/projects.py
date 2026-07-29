"""Projects, labels, and project assignment.

A *project* is the top-level container: it owns images, label classes, and
dataset versions. This router handles creating/listing/deleting projects and
their label classes, plus the single-user assignment an admin uses to decide
who works on a project.

Access rules enforced here:
  * Listing projects returns only the one(s) assigned to the caller (admins see
    all). Access is checked through `app.services.membership` (which, under the
    single-user model, means "is the assigned user, or an admin").
  * Creating/deleting projects and labels, and changing the assignee, are
    admin-only (`require_admin`).

Every mutation writes an entry to the audit log via `app.services.activity`.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.security import current_user, require_admin
from app.db.database import get_db
from app.models import (
    Action, DatasetVersion, Image, Label, Project, Role, User,
)
from app.services import activity, membership, storage

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    task_type: str = "detection"


class ProjectOut(BaseModel):
    id: int
    name: str
    description: str
    task_type: str
    assigned_user_id: int | None = None

    class Config:
        from_attributes = True


class LabelCreate(BaseModel):
    name: str
    color: str = "#ffffff"
    shortcut: str = ""
    keypoint_names: list[str] | None = None
    skeleton_edges: list[list[int]] | None = None


class LabelOut(BaseModel):
    id: int
    name: str
    color: str
    shortcut: str
    keypoint_names: list[str] | None = None
    skeleton_edges: list[list[int]] | None = None

    class Config:
        from_attributes = True


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Admins see every project; a plain user sees only their memberships."""
    stmt = select(Project).order_by(Project.created_at.desc())
    if not user.is_admin:
        member_of = await membership.member_project_ids(db, user)
        if not member_of:
            return []
        stmt = stmt.where(Project.id.in_(member_of))
    res = await db.execute(stmt)
    return res.scalars().all()


@router.post("", response_model=ProjectOut)
async def create_project(
    payload: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    project = Project(**payload.model_dump(), created_by=user.id)
    db.add(project)
    await db.flush()
    version = DatasetVersion(
        project_id=project.id, name="v1 — working", version_number=1,
        created_by=user.id,
    )
    db.add(version)
    await db.flush()
    project.active_version_id = version.id
    await activity.record(
        db, user, Action.PROJECT_CREATE,
        project_id=project.id, details={"name": project.name},
    )
    await db.commit()
    await db.refresh(project)
    return project


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    await membership.assert_member(db, project_id, user)
    return project


@router.delete("/{project_id}")
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    await activity.record(
        db, user, Action.PROJECT_DELETE,
        project_id=project.id, details={"name": project.name},
    )
    await db.delete(project)
    await db.commit()
    return {"ok": True}


# ─── Labels ──────────────────────────────────────────────────────
@router.get("/{project_id}/labels", response_model=list[LabelOut])
async def list_labels(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    await membership.assert_member(db, project_id, user)
    res = await db.execute(
        select(Label).where(Label.project_id == project_id).order_by(Label.id)
    )
    return res.scalars().all()


@router.post("/{project_id}/labels", response_model=LabelOut)
async def create_label(
    project_id: int,
    payload: LabelCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    label = Label(project_id=project_id, **payload.model_dump())
    db.add(label)
    await db.flush()
    await activity.record(
        db, user, Action.LABEL_CREATE,
        project_id=project_id, details={"name": label.name},
    )
    await db.commit()
    await db.refresh(label)
    return label


@router.delete("/{project_id}/labels/{label_id}")
async def delete_label(
    project_id: int,
    label_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    label = await db.get(Label, label_id)
    if not label or label.project_id != project_id:
        raise HTTPException(404, "Label not found")
    await db.delete(label)
    await db.commit()
    return {"ok": True}


# ─── Assignment (admin-only) ─────────────────────────────────────────
# One non-admin user per project. Assigning (or reassigning) a project changes
# projects.assigned_user_id AND — because a project's files live under the
# assigned user's folder — physically moves the project's file subtree to the
# new owner and rewrites the affected image paths, all in one transaction.
class AssigneeOut(BaseModel):
    project_id: int
    assigned_user_id: int | None
    assigned_username: str | None


class AssigneeSet(BaseModel):
    user_id: int | None  # None clears the assignment


@router.get("/{project_id}/assignee", response_model=AssigneeOut)
async def get_assignee(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    username = None
    if project.assigned_user_id:
        u = await db.get(User, project.assigned_user_id)
        username = u.username if u else None
    return AssigneeOut(
        project_id=project.id,
        assigned_user_id=project.assigned_user_id,
        assigned_username=username,
    )


@router.put("/{project_id}/assignee", response_model=AssigneeOut)
async def set_assignee(
    project_id: int,
    payload: AssigneeSet,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    old_id = project.assigned_user_id
    new_id = payload.user_id

    # Validate the incoming user (must exist, be active, and be a plain user —
    # admins already have access to every project, so assigning to one is moot).
    new_user = None
    if new_id is not None:
        new_user = await db.get(User, new_id)
        if not new_user or not new_user.is_active:
            raise HTTPException(404, "User not found or deactivated")
        if new_user.is_admin:
            raise HTTPException(400, "Assign a project to a plain user, not an admin.")

    if old_id == new_id:
        return AssigneeOut(
            project_id=project.id, assigned_user_id=new_id,
            assigned_username=new_user.username if new_user else None,
        )

    old_user = await db.get(User, old_id) if old_id else None

    # Move the project's files on disk to follow the new owner (Option A), then
    # rewrite the stored paths so the DB matches. If there is no old owner (a
    # first-time assignment) there are no files yet — nothing to move.
    if old_user and new_user:
        # Note: project_dir/annotation_dir are two SEPARATE subtrees now
        # (project/{proj}/images and annotation/{proj}/...). A prefix rewrite
        # only works cleanly if both share the same owner-root prefix, which
        # they do (both live under user_dir(...)), so a single prefix swap
        # still correctly retargets paths under either subtree.
        old_prefix = str(storage.user_dir(old_user.id, old_user.username, old_user.role))
        new_prefix = str(storage.user_dir(new_user.id, new_user.username, new_user.role))
        storage.move_project_dir(
            old_user.id, old_user.username, old_user.role,
            new_user.id, new_user.username, new_user.role,
            project.id, project.name,
        )
        # Rewrite every affected image path from the old owner prefix to the new.
        imgs = (await db.execute(
            select(Image).where(Image.project_id == project.id)
        )).scalars().all()
        for img in imgs:
            if img.storage_path and img.storage_path.startswith(old_prefix):
                img.storage_path = new_prefix + img.storage_path[len(old_prefix):]
            if img.annotations_path and img.annotations_path.startswith(old_prefix):
                img.annotations_path = new_prefix + img.annotations_path[len(old_prefix):]
    elif new_user:
        # First assignment: just make sure the new owner's folders exist.
        storage.ensure_project_dirs(
            new_user.id, new_user.username, new_user.role, project.id, project.name)

    project.assigned_user_id = new_id
    await activity.record(
        db, admin,
        Action.PROJECT_ASSIGN if new_id else Action.PROJECT_UNASSIGN,
        project_id=project.id,
        details={
            "from": old_user.username if old_user else None,
            "to": new_user.username if new_user else None,
        },
    )
    await db.commit()
    return AssigneeOut(
        project_id=project.id, assigned_user_id=new_id,
        assigned_username=new_user.username if new_user else None,
    )
