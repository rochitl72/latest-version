"""Project access checks (single-user-per-project model).

Access rule: a project is reachable by an **admin** (any project) or by the
**one non-admin user it is assigned to** (`projects.assigned_user_id`). Everyone
else gets 403. This replaced the old many-to-many `project_members` table.

The function names here are unchanged from the previous membership module on
purpose — every caller (annotations, images, workflow, projects, export) keeps
working without edits; only the check underneath changed from "is a member" to
"is the assigned user, or an admin".
"""
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Image, Project, User


async def is_member(db: AsyncSession, project_id: int, user: User) -> bool:
    """True if the user may access the project (admin, or the assigned user)."""
    if user.is_admin:
        return True
    assigned = await db.scalar(
        select(Project.assigned_user_id).where(Project.id == project_id)
    )
    return assigned is not None and assigned == user.id


async def member_project_ids(db: AsyncSession, user: User) -> set[int]:
    """The set of project ids a non-admin user may see (the ones assigned to them)."""
    rows = await db.execute(
        select(Project.id).where(Project.assigned_user_id == user.id)
    )
    return {r[0] for r in rows.all()}


async def assert_member(db: AsyncSession, project_id: int, user: User) -> None:
    """Raise 403 unless the user may access the project."""
    if not await is_member(db, project_id, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not assigned to this project.",
        )


async def assert_member_by_image(db: AsyncSession, image_id: int, user: User) -> Image:
    """Load an image, confirm project access, and return it (404 if missing)."""
    image = await db.get(Image, image_id)
    if not image:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    await assert_member(db, image.project_id, user)
    return image
