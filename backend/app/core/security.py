"""Password hashing, JWT tokens, and role-based access dependencies.

Uses `bcrypt` directly rather than passlib: passlib 1.7.4 reads
`bcrypt.__about__.__version__`, which was removed in bcrypt 4.1, so the
combination raises at first use. Talking to bcrypt directly avoids that.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.database import get_db
from app.models import Role, User

log = logging.getLogger("annoforge.security")

# bcrypt hashes at most 72 bytes and errors above that.
BCRYPT_MAX_BYTES = 72

# auto_error=False so we can return our own JSON message.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

AUTH_COOKIE_NAME = "rbg_studio_token"

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


# ─── Passwords ───────────────────────────────────────────────────────
def _truncate(password: str) -> bytes:
    """Encode to the longest valid bcrypt input without splitting a character."""
    raw = password.encode("utf-8")
    if len(raw) <= BCRYPT_MAX_BYTES:
        return raw
    return raw[:BCRYPT_MAX_BYTES].decode("utf-8", "ignore").encode("utf-8")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_truncate(password), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_truncate(password), hashed.encode())
    except (ValueError, TypeError):
        return False


# ─── Tokens ──────────────────────────────────────────────────────────
def create_access_token(user: User) -> str:
    """Embed identity and role so most requests need no extra user lookup."""
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def _decode(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
    except JWTError:
        return None


# ─── Authentication ──────────────────────────────────────────────────
async def authenticate(db: AsyncSession, username: str, password: str) -> User | None:
    """Return the user iff the username exists and the password is correct.

    Note: this deliberately does NOT reject a deactivated account — it only
    checks credentials. The login endpoint inspects `user.is_active` afterwards
    so it can show a specific "account deactivated" message rather than the
    generic "incorrect username or password". (Mid-session, `_user_from_token`
    still rejects deactivated users, so deactivation takes effect immediately.)
    """
    res = await db.execute(select(User).where(User.username == username))
    user = res.scalar_one_or_none()
    if not user:
        # Hash anyway so a missing account isn't measurably faster to reject
        # than a wrong password.
        verify_password(password, "$2b$12$" + "." * 53)
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


async def _user_from_token(db: AsyncSession, token: str | None) -> User | None:
    """Resolve a token to a live user row.

    The role is re-read from the database rather than trusted from the token,
    so revoking a role or deactivating an account takes effect immediately
    instead of when the token happens to expire.
    """
    payload = _decode(token)
    if not payload:
        return None
    try:
        user_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        return None
    user = await db.get(User, user_id)
    if not user or not user.is_active:
        return None
    return user


async def current_user(
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Guard for protected routes. Header-bearer tokens only.

    Deliberately ignores the cookie: because mutating endpoints accept no
    ambient credential, a cross-site request cannot act on a user's behalf,
    so no CSRF token is needed.
    """
    if not settings.AUTH_ENABLED:
        res = await db.execute(
            select(User).where(User.role == Role.ADMIN).order_by(User.id)
        )
        dev_user = res.scalars().first()
        if dev_user:
            return dev_user
    user = await _user_from_token(db, token)
    if not user:
        raise CREDENTIALS_ERROR
    return user


async def current_user_or_cookie(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Guard for read-only endpoints the browser loads directly.

    An <img src="..."> cannot carry an Authorization header, so image files
    additionally accept the token from an httpOnly cookie set at login. Only
    safe GET endpoints use this.
    """
    if not settings.AUTH_ENABLED:
        return await current_user(token, db)
    user = await _user_from_token(db, token)
    if not user:
        user = await _user_from_token(db, request.cookies.get(AUTH_COOKIE_NAME))
    if not user:
        raise CREDENTIALS_ERROR
    return user


# ─── Role gates ──────────────────────────────────────────────────────
def require_role(minimum: str):
    """Dependency factory: demand at least `minimum` on the role ladder.

        user < admin

    Use as: `user: User = Depends(require_role(Role.ADMIN))`
    """
    needed = Role.RANK[minimum]

    async def _check(user: User = Depends(current_user)) -> User:
        if Role.RANK.get(user.role, 0) < needed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires the {minimum} role.",
            )
        return user

    return _check


require_user = require_role(Role.USER)
require_admin = require_role(Role.ADMIN)
