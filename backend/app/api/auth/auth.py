"""Login, logout, and the current-user endpoint."""
import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import (
    AUTH_COOKIE_NAME,
    authenticate,
    create_access_token,
    current_user,
    hash_password,
    verify_password,
)
from app.db.database import get_db
from app.models import Action, Role, User, utcnow
from app.services import activity

log = logging.getLogger("annoforge.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "UserOut"


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    full_name: str
    role: str
    is_active: bool
    must_change_password: bool = False

    class Config:
        from_attributes = True


TokenResponse.model_rebuild()


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    user = await authenticate(db, payload.username, payload.password)
    if not user:
        # Small delay to blunt brute-force attempts.
        await asyncio.sleep(0.5)
        log.warning("Failed login attempt for username=%r", payload.username)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    # Credentials are correct, but an admin has deactivated this account. Tell
    # the user clearly instead of the generic wrong-password message, and let
    # nobody in — no token, no session.
    if not user.is_active:
        await asyncio.sleep(0.3)
        log.warning("Deactivated account attempted login: %r", payload.username)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is deactivated. Contact your administrator.",
        )

    user.last_login_at = utcnow()
    await activity.record(db, user, Action.LOGIN)
    await db.commit()

    token = create_access_token(user)
    max_age = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60

    # Mirror the token into an httpOnly cookie. The SPA uses the bearer token
    # for API calls; the cookie exists solely so <img> tags can load protected
    # image files, which cannot send an Authorization header.
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        path="/",
    )
    return TokenResponse(
        access_token=token, expires_in=max_age, user=UserOut.model_validate(user)
    )


@router.post("/logout")
async def logout(
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    await activity.record(db, user, Action.LOGOUT, commit=True)
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)):
    return user


@router.post("/change-password")
async def change_password(
    payload: PasswordChange,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Any signed-in user may change their own password."""
    if not verify_password(payload.current_password, user.password_hash):
        await asyncio.sleep(0.5)
        raise HTTPException(400, "Current password is incorrect")
    if len(payload.new_password) < settings.effective_min_password_length:
        raise HTTPException(
            400,
            f"New password must be at least {settings.effective_min_password_length} characters",
        )

    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    await activity.record(db, user, Action.USER_UPDATE, details={"self": "password"})
    await db.commit()
    return {"ok": True}


@router.get("/config")
async def auth_config():
    """Unauthenticated: lets the login screen know whether signup is offered."""
    return {
        "allow_self_registration": settings.ALLOW_SELF_REGISTRATION,
        "auth_enabled": settings.AUTH_ENABLED,
    }


class RegisterRequest(BaseModel):
    username: str
    password: str
    email: str = ""
    full_name: str = ""


@router.post("/register", response_model=UserOut)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Self-service signup. Disabled unless ALLOW_SELF_REGISTRATION is on.

    Self-registered accounts are always plain users; only an admin can grant a
    higher role.
    """
    if not settings.ALLOW_SELF_REGISTRATION:
        raise HTTPException(403, "Self-registration is disabled. Ask an admin for an account.")

    from app.api.auth.users import create_user_row

    user = await create_user_row(
        db,
        username=payload.username,
        password=payload.password,
        email=payload.email,
        full_name=payload.full_name,
        role=Role.USER,
    )
    await activity.record(db, user, Action.USER_CREATE, details={"self_registered": True})
    await db.commit()
    await db.refresh(user)
    return user
