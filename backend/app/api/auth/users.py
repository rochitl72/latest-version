"""Admin user management — create accounts, change roles, deactivate.

All endpoints here require the admin role. Two safety rails matter:
  * The last active admin can't be demoted or deactivated (that would lock
    everyone out of administration) — see `_guard_last_admin`.
  * Users are deactivated, never hard-deleted, so their past annotations keep
    a valid author reference.

`create_user_row` is shared with self-registration in `auth.py`, which is why
it lives here as a reusable helper rather than inline in the endpoint.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import current_user, hash_password, require_admin
from app.db.database import get_db
from app.models import Action, Annotation, Image, Project, Role, User
from app.services import activity, storage

router = APIRouter(prefix="/api/users", tags=["users"])


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    full_name: str
    role: str
    is_active: bool
    status: str

    class Config:
        from_attributes = True


class UserCreate(BaseModel):
    username: str
    password: str
    email: str = ""
    full_name: str = ""
    role: str = Role.USER


class UserUpdate(BaseModel):
    email: str | None = None
    full_name: str | None = None
    role: str | None = None
    is_active: bool | None = None
    password: str | None = None


async def create_user_row(
    db: AsyncSession,
    *,
    username: str,
    password: str,
    email: str = "",
    full_name: str = "",
    role: str = Role.USER,
) -> User:
    """Shared by admin creation and self-registration. Does not commit."""
    username = username.strip()
    if not username:
        raise HTTPException(400, "Username is required")
    # No password rules by design: no minimum length, no complexity, no reuse
    # or expiry checks. Any string is accepted, including an empty one.
    if role not in Role.ALL:
        raise HTTPException(400, f"Invalid role. Use one of: {', '.join(Role.ALL)}")

    existing = await db.scalar(select(User).where(User.username == username))
    if existing:
        raise HTTPException(409, f"Username {username!r} is already taken")

    user = User(
        username=username,
        email=email.strip(),
        full_name=full_name.strip(),
        password_hash=hash_password(password),
        role=role,
    )
    db.add(user)
    await db.flush()
    # Create this account's on-disk home folder immediately, so their storage
    # tree exists the moment the account does (per the per-user storage model).
    storage.ensure_user_dir(user.id, user.username)
    return user


@router.get("", response_model=list[UserOut])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    res = await db.execute(select(User).order_by(User.username))
    return res.scalars().all()


@router.post("", response_model=UserOut)
async def create_user(
    payload: UserCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = await create_user_row(
        db,
        username=payload.username,
        password=payload.password,
        email=payload.email,
        full_name=payload.full_name,
        role=payload.role,
    )
    await activity.record(
        db, admin, Action.USER_CREATE,
        details={"created_user": user.username, "role": user.role},
    )
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int,
    payload: UserUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    changes: dict = {}

    if payload.role is not None and payload.role != user.role:
        if payload.role not in Role.ALL:
            raise HTTPException(400, f"Invalid role. Use one of: {', '.join(Role.ALL)}")
        # Don't allow removing the last admin — that would lock everyone out.
        if user.role == Role.ADMIN and payload.role != Role.ADMIN:
            await _guard_last_admin(db, user)
        changes["role"] = {"from": user.role, "to": payload.role}
        user.role = payload.role

    if payload.is_active is not None and payload.is_active != user.is_active:
        if not payload.is_active and user.role == Role.ADMIN:
            await _guard_last_admin(db, user)
        if not payload.is_active and user.id == admin.id:
            raise HTTPException(400, "You cannot deactivate your own account")
        changes["is_active"] = {"from": user.is_active, "to": payload.is_active}
        user.is_active = payload.is_active

    if payload.email is not None:
        user.email = payload.email.strip()
        changes["email"] = user.email
    if payload.full_name is not None:
        user.full_name = payload.full_name.strip()
        changes["full_name"] = user.full_name
    if payload.password is not None:
        # Accepted as-is — see create_user_row: there are no password rules.
        user.password_hash = hash_password(payload.password)
        changes["password"] = "reset"

    action = (
        Action.USER_DEACTIVATE
        if payload.is_active is False
        else Action.USER_UPDATE
    )
    await activity.record(
        db, admin, action, details={"target_user": user.username, "changes": changes}
    )
    await db.commit()
    await db.refresh(user)
    return user


async def _guard_last_admin(db: AsyncSession, user: User) -> None:
    remaining = await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role == Role.ADMIN, User.status == "active", User.id != user.id)
    )
    if not remaining:
        raise HTTPException(
            400,
            "This is the last active admin — promote another admin first, "
            "otherwise nobody could administer the system.",
        )


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Deactivate rather than delete, so their annotations keep an author."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == admin.id:
        raise HTTPException(400, "You cannot remove your own account")
    if user.role == Role.ADMIN:
        await _guard_last_admin(db, user)

    user.is_active = False
    await activity.record(
        db, admin, Action.USER_DEACTIVATE, details={"target_user": user.username}
    )
    await db.commit()
    return {"ok": True, "deactivated": user.username}


@router.get("/me/stats")
async def my_stats(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Any user can see their own numbers; admins get the team view elsewhere.

    Under the single-user-per-project model, "assigned" work is measured over
    the projects assigned to this user rather than per-image assignment.
    """
    annotations = await db.scalar(
        select(func.count()).select_from(Annotation).where(Annotation.created_by == user.id)
    )

    # Projects assigned to this user, and the images inside them.
    project_ids = [
        r[0]
        for r in (
            await db.execute(
                select(Project.id).where(Project.assigned_user_id == user.id)
            )
        ).all()
    ]
    projects_assigned = len(project_ids)

    async def _img_count(*conds) -> int:
        if not project_ids:
            return 0
        q = select(func.count()).select_from(Image).where(
            Image.project_id.in_(project_ids), *conds
        )
        return (await db.scalar(q)) or 0

    total_images = await _img_count()
    approved = await _img_count(Image.status == "approved")
    rejected = await _img_count(Image.status == "rejected")

    return {
        "username": user.username,
        "role": user.role,
        "annotations_created": annotations or 0,
        "projects_assigned": projects_assigned,
        "images_assigned": total_images,   # images in this user's projects
        "images_approved": approved,
        "images_rejected": rejected,
    }
