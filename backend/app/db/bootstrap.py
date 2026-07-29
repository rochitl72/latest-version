"""Seed the first admin so a fresh database is never locked out."""
import logging

from sqlalchemy import func, select

from app.core.config import settings
from app.db.database import AsyncSessionLocal
from app.models import Role, User

log = logging.getLogger("annoforge.bootstrap")


async def ensure_bootstrap_admin() -> None:
    """Create the initial admin account if no users exist yet.

    Runs on every startup but only acts on a genuinely empty user table, so
    it can't resurrect or overwrite an account an admin deliberately removed
    or edited.
    """
    from app.core.security import hash_password

    async with AsyncSessionLocal() as db:
        count = await db.scalar(select(func.count()).select_from(User))
        if count:
            return

        admin = User(
            username=settings.BOOTSTRAP_ADMIN_USERNAME,
            email=settings.BOOTSTRAP_ADMIN_EMAIL,
            full_name="Administrator",
            password_hash=hash_password(settings.BOOTSTRAP_ADMIN_PASSWORD),
            role=Role.ADMIN,
            # status defaults to "active".
            # Force a password change on first sign-in if we seeded the built-in
            # default. If the operator set a real password, no need to nag.
            must_change_password=settings.using_default_credentials,
        )
        db.add(admin)
        await db.flush()
        from app.services import storage
        storage.ensure_user_dir(admin.id, admin.username, admin.role)
        await db.commit()
        log.info(
            "Created initial admin account %r. Change the password after "
            "first sign-in.",
            settings.BOOTSTRAP_ADMIN_USERNAME,
        )


async def ensure_seed_test_user() -> None:
    """Create a plain-user test account, for quickly trying the app as a
    non-admin without first creating someone through the admin UI.

    Unlike the admin seed above, this checks for the *specific username*
    rather than "is the table empty" — so it still runs (and still does
    nothing) on a database that already has an admin but never got a test
    account, and it never resurrects the account if someone deliberately
    deletes or renames it (its check is "does a user named `test` currently
    exist", and a delete leaves no such row — so it WOULD be recreated on the
    next restart; if that's not what you want, set SEED_TEST_USER=false).
    """
    if not settings.SEED_TEST_USER:
        return

    from app.core.security import hash_password

    async with AsyncSessionLocal() as db:
        existing = await db.scalar(
            select(User).where(User.username == settings.BOOTSTRAP_TEST_USERNAME)
        )
        if existing:
            return

        test_user = User(
            username=settings.BOOTSTRAP_TEST_USERNAME,
            email="",
            full_name="Test User",
            password_hash=hash_password(settings.BOOTSTRAP_TEST_PASSWORD),
            role=Role.USER,
        )
        db.add(test_user)
        await db.flush()
        from app.services import storage
        storage.ensure_user_dir(test_user.id, test_user.username, test_user.role)
        await db.commit()
        log.info("Created test account %r.", settings.BOOTSTRAP_TEST_USERNAME)
