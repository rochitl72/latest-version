"""Per-user file storage — the on-disk home for everything a user owns.

Layout (strict per-user; each project's files live under the user assigned to
that project):

    STORAGE_DIR/
    └── users/
        └── {user_id}_{username}/                 ← created when the account is
            ├── projects/                            created (ensure_user_dir)
            │   └── {project_id}_{project-name}/
            │       ├── images/{xx}/{uuid}.ext       ← original uploads
            │       ├── annotations/{image_id}.json  ← per-image backup
            │       └── exports/{timestamp}/         ← generated bundles
            └── activity.log                         ← plain-text action mirror

Design rules this module encodes:
  * Only the *paths* are stored in Postgres (images.storage_path,
    images.annotations_path); the bytes live here on disk.
  * A project folder is owned by the project's currently-assigned user. On
    reassignment the whole subtree is moved (see move_project_dir), so the
    owner folder always matches reality.
  * These helpers are pure path math + filesystem ops. They never touch the
    database, so callers stay in control of transactions.

Input:  User / Project rows (for ids and names) and, for the writers, the data
        to persist. Process: compute the right path and read/write/move files.
Output: the absolute paths that callers store back into Postgres.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import settings

log = logging.getLogger("annoforge.storage")


def _safe(name: str) -> str:
    """Filesystem-safe slug: keep word chars, collapse the rest to underscores."""
    s = re.sub(r"[^\w\s-]", "", name or "", flags=re.UNICODE)
    s = re.sub(r"[-\s]+", "_", s.strip())
    return s or "untitled"


# ─── Directory layout ────────────────────────────────────────────────
def users_root() -> Path:
    return settings.STORAGE_DIR / "users"


def user_dir(user_id: int, username: str) -> Path:
    """The folder that holds everything owned by one user."""
    return users_root() / f"{user_id}_{_safe(username)}"


def ensure_user_dir(user_id: int, username: str) -> Path:
    """Create (idempotently) a user's home folder. Called on account creation."""
    d = user_dir(user_id, username)
    (d / "projects").mkdir(parents=True, exist_ok=True)
    return d


def project_dir(owner_id: int, owner_username: str, project_id: int, project_name: str) -> Path:
    """A project's folder, under its assigned (owner) user."""
    return (
        user_dir(owner_id, owner_username)
        / "projects"
        / f"{project_id}_{_safe(project_name)}"
    )


def ensure_project_dirs(
    owner_id: int, owner_username: str, project_id: int, project_name: str
) -> Path:
    """Create the images/ and annotations/ subfolders for a project."""
    pdir = project_dir(owner_id, owner_username, project_id, project_name)
    (pdir / "images").mkdir(parents=True, exist_ok=True)
    (pdir / "annotations").mkdir(parents=True, exist_ok=True)
    return pdir


def image_target_path(
    owner_id: int,
    owner_username: str,
    project_id: int,
    project_name: str,
    unique_hex: str,
    ext: str,
) -> Path:
    """Where a freshly-uploaded image file should be written.

    Sharded by the first two hex chars of its UUID so no single directory grows
    to tens of thousands of entries (slow on most filesystems).
    """
    images = project_dir(owner_id, owner_username, project_id, project_name) / "images"
    shard = images / unique_hex[:2]
    shard.mkdir(parents=True, exist_ok=True)
    return shard / f"{unique_hex}{ext}"


def annotations_file_path(
    owner_id: int, owner_username: str, project_id: int, project_name: str, image_id: int
) -> Path:
    """The per-image annotations.json backup path."""
    anns = project_dir(owner_id, owner_username, project_id, project_name) / "annotations"
    anns.mkdir(parents=True, exist_ok=True)
    return anns / f"{image_id}.json"


def export_dir(
    owner_id: int, owner_username: str, project_id: int, project_name: str
) -> Path:
    """A timestamped folder for a generated export bundle."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")
    d = project_dir(owner_id, owner_username, project_id, project_name) / "exports" / stamp
    d.mkdir(parents=True, exist_ok=True)
    return d


# ─── Writers ─────────────────────────────────────────────────────────
def write_annotations_json(
    path: Path, image_meta: dict, annotations: list[dict]
) -> str:
    """Rewrite one image's annotations.json backup. Returns the path as a string.

    Called after every create/update/delete for the image, so the file always
    mirrors the current DB rows. Whole-file rewrite is fine: an image has at
    most a few dozen annotations.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "image": image_meta,
        "annotations": annotations,
        "written_at": datetime.now(timezone.utc).isoformat(),
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str))
    tmp.replace(path)  # atomic on the same filesystem
    return str(path)


def append_activity_log(user_id: int, username: str, line: str) -> None:
    """Append one human-readable line to a user's activity.log. Best-effort:
    a logging failure must never break the request it describes."""
    try:
        d = ensure_user_dir(user_id, username)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        with (d / "activity.log").open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {line}\n")
    except Exception:
        log.exception("Failed appending activity.log for user %s", username)


# ─── Reassignment (Option A: move the files to follow the owner) ─────
def move_project_dir(
    old_owner_id: int,
    old_owner_username: str,
    new_owner_id: int,
    new_owner_username: str,
    project_id: int,
    project_name: str,
) -> Path | None:
    """Move a project's whole folder from the old owner to the new owner.

    Returns the new project directory, or None if there was nothing to move.
    On the same disk this is a rename (near-instant, no byte copy). The caller
    is responsible for updating the stored paths in Postgres afterwards, in the
    same transaction, so DB and disk stay consistent.
    """
    src = project_dir(old_owner_id, old_owner_username, project_id, project_name)
    dst = project_dir(new_owner_id, new_owner_username, project_id, project_name)
    if src.resolve() == dst.resolve():
        return dst
    if not src.exists():
        # Nothing uploaded yet — just make sure the new owner's tree exists.
        ensure_user_dir(new_owner_id, new_owner_username)
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        # Extremely unlikely (same project id under two owners) — merge safely.
        shutil.rmtree(dst)
    shutil.move(str(src), str(dst))
    log.info("Moved project %s files: %s -> %s", project_id, src, dst)
    return dst
