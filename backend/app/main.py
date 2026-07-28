"""AnnoForge — FastAPI entry point."""
import logging
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.security import current_user, current_user_or_cookie
from app.db.database import init_db
# Routers are grouped into domain subpackages under app/api. Importing the
# modules (rather than the router objects) keeps the include_router calls below
# readable — each `module.router` is its FastAPI router.
from app.api.auth import auth, users
from app.api.workspace import projects, images, annotations
from app.api.dataset import versions, splits, workflow, export
from app.api.admin import dashboard, activity, system

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("annoforge")


def _safe_db_url() -> str:
    """Connection string with any password redacted, safe for logs."""
    url = settings.DATABASE_URL
    if "@" in url and "//" in url:
        scheme, rest = url.split("//", 1)
        creds, host = rest.rsplit("@", 1)
        user = creds.split(":", 1)[0]
        return f"{scheme}//{user}:***@{host}"
    return url


def _warn_about_insecure_config() -> None:
    """Make unsafe-for-network defaults impossible to miss in the logs."""
    if not settings.AUTH_ENABLED:
        log.warning(
            "AUTH_ENABLED=false — every API endpoint is open. "
            "Never run this way on a shared network."
        )
    elif settings.using_default_credentials:
        log.warning(
            "The bootstrap admin still uses the built-in default password. "
            "Sign in and change it, or set BOOTSTRAP_ADMIN_PASSWORD."
        )
    if settings.secret_key_was_generated:
        log.warning(
            "SECRET_KEY not set — generated a random one. Logins will not "
            "survive a restart. Set it explicitly in production."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting RBG Annotation Studio ...")
    await init_db()
    log.info(f"Storage dir: {settings.STORAGE_DIR}")
    # Never log the password embedded in the connection string.
    log.info(f"DB: {_safe_db_url()}")
    _warn_about_insecure_config()
    yield
    log.info("Shutting down.")


app = FastAPI(
    title="RBG Annotation Studio",
    description="Local-first professional annotation platform.",
    version="0.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# /api/auth/login and /api/auth/config must stay open — the rest of auth
# guards itself per-endpoint.
app.include_router(auth.router)

# Applying the guard here (rather than per-endpoint) means a newly added route
# is protected by default; you have to opt out deliberately.
protected = [
    projects.router,
    images.router,
    annotations.router,
    splits.router,
    versions.router,
    workflow.router,
    users.router,
    activity.router,
    dashboard.router,
    system.router,
]
for router in protected:
    app.include_router(router, dependencies=[Depends(current_user)])

# Image bytes: same protection, but also accepts the httpOnly cookie so the
# browser can load them via <img src>. Read-only, so no CSRF surface.
app.include_router(
    images.file_router, dependencies=[Depends(current_user_or_cookie)]
)

# Export: NOT header-only guarded here — its COCO/YOLO GETs are opened as plain
# `<a href>` downloads that can't send an Authorization header, so each endpoint
# authenticates itself with the cookie-capable admin gate (see export.py).
app.include_router(export.router)


@app.get("/api")
async def api_root():
    return {"name": "RBG Annotation Studio", "version": "0.3.0", "status": "ok"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


# ─── Serve the built frontend (optional single-process mode) ───────
# The supported deployment (docker-compose) serves the frontend from its own
# nginx container, so this block does nothing there — /frontend/dist is absent
# inside the backend image and nginx owns the static files.
#
# It exists for the simpler case of running everything from one process on one
# port with no separate web server: build the frontend with
# `cd frontend && npm run build` (which writes frontend/dist), then start this
# app from the repo root. If that folder exists, we serve it here.
# In development the folder is absent — run `npm run dev` on 5173 instead.
FRONTEND_DIST = settings.BASE_DIR.parent / "frontend" / "dist"

if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Return index.html for client-side routes (deep links, refresh)."""
        # Unknown API paths must 404 as JSON, not silently return the app HTML.
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")

        candidate = (FRONTEND_DIST / full_path).resolve()
        # Serve real files (favicon, logo) but never escape the dist folder.
        if (
            full_path
            and candidate.is_file()
            and FRONTEND_DIST.resolve() in candidate.parents
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")

    log.info(f"Serving built frontend from {FRONTEND_DIST}")
else:
    @app.get("/")
    async def root():
        return {
            "name": "RBG Annotation Studio",
            "version": "0.3.0",
            "status": "ok",
            "note": (
                "API is up. No frontend bundle is served from this process — "
                "that is normal for the docker-compose deployment, where nginx "
                "serves the UI. For single-process mode run "
                "'cd frontend && npm run build' first; for development run "
                "'npm run dev' on port 5173."
            ),
        }
