"""System & Storage inspector — admin-only, read-only.

Answers the questions that otherwise require shelling into the containers:
where is the database, how big is it, what is on disk for each user, and does
the database still agree with the filesystem.

Deliberate boundaries:
  * Everything here is READ-ONLY. Nothing in this module writes or deletes.
  * `password_hash` is never selected, never serialised, never exported. An
    admin session should not be able to walk away with every user's hash.
  * The database connection string is reported with its password redacted.
  * There is no arbitrary-SQL endpoint. Running attacker-supplied SQL over
    HTTP would be remote code execution against the database; `psql` exists
    for that, behind server access.

Split by cost, because the overview panel is polled every few seconds:
  /overview   cheap  — counts and sizes only
  /storage    medium — walks the per-user tree one level deep
  /integrity  costly — stats every file; on demand only, never polled
"""
import csv
import io
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import current_user_or_cookie, require_admin
from app.db.database import get_db
from app.models import (
    ActivityLog, Annotation, DatasetVersion, Image, Label, Project, User,
)
from app.services import storage

router = APIRouter(prefix="/api/system", tags=["system"])

# CSV downloads live on a SEPARATE router. main.py mounts the router above with
# a header-only `current_user` guard, which rejects a request that carries only
# the login cookie — and a <a href> download cannot send an Authorization
# header. This router is mounted without that guard so each endpoint can use
# its own cookie-capable admin gate, exactly like the export routes.
csv_router = APIRouter(prefix="/api/system", tags=["system"])


def _admin_or_cookie(user: User = Depends(current_user_or_cookie)) -> User:
    """Admin gate that also accepts the login cookie.

    The CSV endpoints are opened as plain `<a href>` downloads, which cannot
    carry an Authorization header — same reason the export routes do this.
    """
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required.",
        )
    return user


def _redacted_db_url() -> str:
    """Connection string with the password replaced. Never return the raw URL."""
    url = settings.DATABASE_URL
    if "@" in url and "//" in url:
        scheme, rest = url.split("//", 1)
        creds, host = rest.rsplit("@", 1)
        username = creds.split(":", 1)[0]
        return f"{scheme}//{username}:••••••@{host}"
    return url


def _dir_size(path: Path) -> tuple[int, int]:
    """(total bytes, file count) under a directory. Missing dir → (0, 0)."""
    total = 0
    count = 0
    if not path.exists():
        return 0, 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
                count += 1
            except OSError:
                pass
    return total, count


# Files the operating system scatters around that are not ours and are not
# evidence of anything. macOS writes .DS_Store into every folder Finder opens,
# which otherwise dominates the orphan list and makes a real leak invisible.
_OS_JUNK = {".DS_Store", "Thumbs.db", "desktop.ini", ".localized"}


def _is_os_junk(p: Path) -> bool:
    return p.name in _OS_JUNK or p.name.startswith("._")


def _human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ─── Overview (polled) ───────────────────────────────────────────────
@router.get("/overview")
async def system_overview(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Headline database + storage facts. Cheap enough to poll every few seconds."""
    version = (await db.execute(text("SELECT version()"))).scalar() or ""
    # Short form: "PostgreSQL 16.14 on aarch64-..." → "PostgreSQL 16.14"
    short_version = " ".join(version.split()[:2]) if version else "unknown"

    db_bytes = (
        await db.execute(text("SELECT pg_database_size(current_database())"))
    ).scalar() or 0

    counts = {}
    for name, model in (
        ("users", User),
        ("projects", Project),
        ("labels", Label),
        ("images", Image),
        ("annotations", Annotation),
        ("dataset_versions", DatasetVersion),
        ("activity_log", ActivityLog),
    ):
        counts[name] = await db.scalar(select(func.count()).select_from(model)) or 0

    storage_bytes, storage_files = _dir_size(settings.STORAGE_DIR)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database": {
            "engine": short_version,
            "url": _redacted_db_url(),
            "size_bytes": db_bytes,
            "size_human": _human(db_bytes),
            "reachable": True,
            "table_counts": counts,
        },
        "storage": {
            "root": str(settings.STORAGE_DIR),
            "export_root": str(settings.EXPORT_DIR),
            "size_bytes": storage_bytes,
            "size_human": _human(storage_bytes),
            "file_count": storage_files,
        },
        "environment": {
            "environment": settings.ENVIRONMENT,
            "auth_enabled": settings.AUTH_ENABLED,
            "seed_test_user": settings.SEED_TEST_USER,
            "allow_self_registration": settings.ALLOW_SELF_REGISTRATION,
            "cookie_secure": settings.COOKIE_SECURE,
            "max_upload_mb": settings.MAX_UPLOAD_MB,
        },
    }


# ─── Per-user storage ────────────────────────────────────────────────
@router.get("/storage")
async def system_storage(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """What each user owns on disk, mirroring the folder layout."""
    # Named columns, not whole User rows — same reason as the CSV queries:
    # password_hash should never be fetched by an endpoint that has no use
    # for it.
    users = (
        await db.execute(
            select(User.id, User.username, User.role, User.status).order_by(User.id)
        )
    ).all()

    out = []
    for u in users:
        udir = storage.user_dir(u.id, u.username)
        size, files = _dir_size(udir)

        projects = (
            await db.execute(
                select(Project).where(Project.assigned_user_id == u.id).order_by(Project.id)
            )
        ).scalars().all()

        proj_rows = []
        for p in projects:
            pdir = storage.project_dir(u.id, u.username, p.id, p.name)
            psize, pfiles = _dir_size(pdir)
            n_images = await db.scalar(
                select(func.count()).select_from(Image).where(Image.project_id == p.id)
            ) or 0
            proj_rows.append({
                "id": p.id,
                "name": p.name,
                "folder": pdir.name,
                "path": str(pdir),
                "exists": pdir.exists(),
                "images": n_images,
                "size_bytes": psize,
                "size_human": _human(psize),
                "file_count": pfiles,
            })

        out.append({
            "user_id": u.id,
            "username": u.username,
            "role": u.role,
            "status": u.status,
            "folder": udir.name,
            "path": str(udir),
            "exists": udir.exists(),
            "has_activity_log": (udir / "activity.log").exists(),
            "size_bytes": size,
            "size_human": _human(size),
            "file_count": files,
            "projects": proj_rows,
        })

    return {"users": out, "root": str(storage.users_root())}


# ─── Integrity (on demand — walks the filesystem) ────────────────────
@router.get("/integrity")
async def system_integrity(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Does the database still agree with the disk?

    Three failure modes, all of which happen silently in normal operation:
      * a row points at a file that is gone     → the image will not load
      * a file exists that no row references    → wasted disk, grows forever
      * annotations_path set but the file is gone

    Deleting an image currently leaves its annotations JSON behind, and
    deleting a project leaves its whole folder, so orphans accumulate. This
    endpoint is what makes that visible.
    """
    images = (await db.execute(select(Image).order_by(Image.id))).scalars().all()

    missing_images = []
    missing_annotations = []
    referenced: set[str] = set()

    for img in images:
        if img.storage_path:
            referenced.add(str(Path(img.storage_path)))
            if not Path(img.storage_path).is_file():
                missing_images.append({
                    "image_id": img.id,
                    "filename": img.filename,
                    "project_id": img.project_id,
                    "path": img.storage_path,
                })
        if img.annotations_path:
            referenced.add(str(Path(img.annotations_path)))
            if not Path(img.annotations_path).is_file():
                missing_annotations.append({
                    "image_id": img.id,
                    "path": img.annotations_path,
                })

    # Files on disk that nothing in the database points at. activity.log and
    # export bundles are expected to be unreferenced, so they are excluded.
    orphans = []
    orphan_bytes = 0
    root = settings.STORAGE_DIR
    if root.exists():
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if p.name == "activity.log":
                continue
            if _is_os_junk(p):
                continue
            if "exports" in p.parts:
                continue
            if str(p) not in referenced:
                try:
                    size = p.stat().st_size
                except OSError:
                    size = 0
                orphan_bytes += size
                if len(orphans) < 200:  # cap the payload
                    orphans.append({
                        "path": str(p),
                        "size_bytes": size,
                        "size_human": _human(size),
                    })

    ok = not missing_images and not missing_annotations and not orphans
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ok": ok,
        "checked_images": len(images),
        "missing_files": missing_images,
        "missing_annotation_files": missing_annotations,
        "orphan_files": orphans,
        "orphan_count": len(orphans),
        "orphan_bytes": orphan_bytes,
        "orphan_human": _human(orphan_bytes),
        "orphans_truncated": len(orphans) >= 200,
    }


# ─── CSV exports ─────────────────────────────────────────────────────
def _csv_response(rows, header, filename):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@csv_router.get("/export/images.csv")
async def export_images_csv(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_admin_or_cookie),
):
    """Every image with its on-disk paths, plus owning project and user."""
    # Explicit columns, not whole entities. `select(..., User)` would load every
    # User column — including password_hash — into memory even though the CSV
    # never writes it. Naming the columns keeps the hash out of the process
    # entirely, so a future edit to the row builder cannot accidentally emit it.
    q = (
        select(
            Image.id, Image.filename, Image.width, Image.height,
            Image.status, Image.split, Image.storage_path,
            Image.annotations_path, Image.created_at,
            Project.id, Project.name, User.username,
        )
        .join(Project, Image.project_id == Project.id)
        .outerjoin(User, Project.assigned_user_id == User.id)
        .order_by(Image.id)
    )
    rows = []
    for (iid, fname, w, h, st, split, spath, apath, created,
         pid, pname, owner) in (await db.execute(q)).all():
        rows.append([
            iid, fname, w, h, st, split,
            pid, pname, owner or "",
            spath or "", apath or "",
            created.isoformat() if created else "",
        ])
    return _csv_response(
        rows,
        ["image_id", "filename", "width", "height", "status", "split",
         "project_id", "project_name", "assigned_user",
         "storage_path", "annotations_path", "created_at"],
        "rbg_images.csv",
    )


@csv_router.get("/export/users.csv")
async def export_users_csv(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_admin_or_cookie),
):
    """Accounts. password_hash is deliberately NOT included."""
    # Named columns only — password_hash is never even fetched.
    q = select(
        User.id, User.username, User.full_name, User.email,
        User.role, User.status, User.created_at, User.last_login_at,
    ).order_by(User.id)
    rows = [
        [uid, uname, full, email, role, status_,
         created.isoformat() if created else "",
         last.isoformat() if last else ""]
        for (uid, uname, full, email, role, status_, created, last)
        in (await db.execute(q)).all()
    ]
    return _csv_response(
        rows,
        ["user_id", "username", "full_name", "email", "role", "status",
         "created_at", "last_login_at"],
        "rbg_users.csv",
    )


@csv_router.get("/export/annotations.csv")
async def export_annotations_csv(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_admin_or_cookie),
):
    """Every annotation, with its label and author. Geometry as JSON text."""
    import json as _json

    q = (
        select(
            Annotation.id, Annotation.image_id, Annotation.type,
            Annotation.geometry, Annotation.created_by, Annotation.source,
            Annotation.created_at, Label.name, Image.filename, Image.project_id,
        )
        .join(Label, Annotation.label_id == Label.id)
        .join(Image, Annotation.image_id == Image.id)
        .order_by(Annotation.id)
    )
    rows = []
    for (aid, iid, atype, geom, by, src, created, lname, fname, pid) in (
        await db.execute(q)
    ).all():
        rows.append([
            aid, iid, fname, pid, lname, atype,
            _json.dumps(geom, separators=(",", ":")),
            by or "", src,
            created.isoformat() if created else "",
        ])
    return _csv_response(
        rows,
        ["annotation_id", "image_id", "filename", "project_id", "label",
         "type", "geometry", "created_by_user_id", "source", "created_at"],
        "rbg_annotations.csv",
    )


@csv_router.get("/export/activity.csv")
async def export_activity_csv(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_admin_or_cookie),
):
    """The full audit trail."""
    import json as _json

    rows_q = (
        await db.execute(select(ActivityLog).order_by(ActivityLog.id))
    ).scalars().all()
    rows = [
        [
            r.id, r.created_at.isoformat() if r.created_at else "",
            r.username, r.action, r.project_id or "", r.image_id or "",
            r.annotation_id or "",
            _json.dumps(r.details, separators=(",", ":")) if r.details else "",
        ]
        for r in rows_q
    ]
    return _csv_response(
        rows,
        ["id", "created_at", "username", "action", "project_id", "image_id",
         "annotation_id", "details"],
        "rbg_activity.csv",
    )


# ─── Per-user detail: live file tree + that user's database rows ─────
def _build_tree(root: Path, max_depth: int = 6, budget: int = 400) -> dict:
    """Nested {name, type, children|size} for a folder, as it is right now.

    Read fresh on every request, so it reflects the real filesystem rather than
    anything cached. Depth and entry count are capped so a project with tens of
    thousands of shards cannot produce an unbounded response.
    """
    counter = {"n": 0}

    def walk(path: Path, depth: int) -> dict:
        node = {"name": path.name, "type": "dir", "children": []}
        if depth >= max_depth or counter["n"] >= budget:
            node["truncated"] = True
            return node
        try:
            entries = sorted(
                path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())
            )
        except OSError:
            node["children"] = []
            return node
        for child in entries:
            if _is_os_junk(child):
                continue
            if counter["n"] >= budget:
                node["truncated"] = True
                break
            counter["n"] += 1
            if child.is_dir():
                node["children"].append(walk(child, depth + 1))
            else:
                try:
                    size = child.stat().st_size
                except OSError:
                    size = 0
                node["children"].append({
                    "name": child.name,
                    "type": "file",
                    "size_bytes": size,
                    "size_human": _human(size),
                })
        return node

    if not root.exists():
        return {"name": root.name, "type": "dir", "children": [], "missing": True}
    return walk(root, 0)


@router.get("/user/{user_id}")
async def system_user_detail(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Everything about one user: their folder tree, and their rows in Postgres.

    This is the "pick a person and see exactly what they own" view — the disk
    side and the database side of the same account, together.
    """
    row = (
        await db.execute(
            select(
                User.id, User.username, User.full_name, User.email, User.role,
                User.status, User.created_at, User.last_login_at,
            ).where(User.id == user_id)
        )
    ).first()
    if not row:
        raise HTTPException(404, "User not found")

    uid, uname, full, email, role, status_, created, last_login = row
    udir = storage.user_dir(uid, uname)
    size, files = _dir_size(udir)

    # ── Projects assigned to them, with per-project image counts ──
    projects = (
        await db.execute(
            select(Project.id, Project.name, Project.task_type, Project.created_at)
            .where(Project.assigned_user_id == uid)
            .order_by(Project.id)
        )
    ).all()

    proj_out = []
    for pid, pname, ptask, pcreated in projects:
        pdir = storage.project_dir(uid, uname, pid, pname)
        psize, pfiles = _dir_size(pdir)
        imgs = (
            await db.execute(
                select(
                    Image.id, Image.filename, Image.status, Image.split,
                    Image.width, Image.height, Image.storage_path,
                    Image.annotations_path,
                )
                .where(Image.project_id == pid)
                .order_by(Image.id)
            )
        ).all()
        img_out = []
        for iid, fname, istatus, isplit, iw, ih, spath, apath in imgs:
            n_ann = await db.scalar(
                select(func.count()).select_from(Annotation)
                .where(Annotation.image_id == iid)
            ) or 0
            img_out.append({
                "id": iid, "filename": fname, "status": istatus, "split": isplit,
                "width": iw, "height": ih,
                "storage_path": spath, "annotations_path": apath,
                "file_exists": bool(spath) and Path(spath).is_file(),
                "annotations": n_ann,
            })
        proj_out.append({
            "id": pid, "name": pname, "task_type": ptask,
            "created_at": pcreated.isoformat() if pcreated else None,
            "folder": pdir.name, "path": str(pdir), "exists": pdir.exists(),
            "size_human": _human(psize), "file_count": pfiles,
            "images": img_out,
        })

    # ── What they have authored, and their recent actions ──
    n_annotations = await db.scalar(
        select(func.count()).select_from(Annotation)
        .where(Annotation.created_by == uid)
    ) or 0

    recent = (
        await db.execute(
            select(
                ActivityLog.id, ActivityLog.action, ActivityLog.project_id,
                ActivityLog.image_id, ActivityLog.created_at,
            )
            .where(ActivityLog.user_id == uid)
            .order_by(ActivityLog.id.desc())
            .limit(25)
        )
    ).all()

    log_path = udir / "activity.log"
    log_tail = []
    if log_path.is_file():
        try:
            log_tail = log_path.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()[-25:]
        except OSError:
            pass

    return {
        "user": {
            "id": uid, "username": uname, "full_name": full, "email": email,
            "role": role, "status": status_,
            "created_at": created.isoformat() if created else None,
            "last_login_at": last_login.isoformat() if last_login else None,
        },
        "storage": {
            "folder": udir.name,
            "path": str(udir),
            "exists": udir.exists(),
            "size_human": _human(size),
            "file_count": files,
            "tree": _build_tree(udir),
        },
        "database": {
            "projects": proj_out,
            "annotations_authored": n_annotations,
            "recent_activity": [
                {
                    "id": r[0], "action": r[1], "project_id": r[2],
                    "image_id": r[3],
                    "at": r[4].isoformat() if r[4] else None,
                }
                for r in recent
            ],
        },
        "activity_log_tail": log_tail,
    }
