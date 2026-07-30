"""Per-user file storage — the on-disk home for everything a user owns.

Layout (role-split at the top, then project/annotation split per user):

    STORAGE_DIR/
    ├── admin/                                  ← role-based split. A user's
    │   └── {user_id}_{username}/                 folder lives under admin/
    │       ├── project/                           or users/ depending on
    │       │   └── {project_id}_{project-name}/   their CURRENT role. A role
    │       │       └── images/{uuid}.ext          change physically moves the
    │       ├── annotation/                        whole tree (see
    │       │   └── {project_id}_{project-name}/   move_user_role_dir).
    │       │       ├── json/{image_id}.json        ← per-image DB backup
    │       │       ├── overlays/{image_id}_*.png   ← annotation drawn on image
    │       │       ├── coco/annotations_coco.json  ← live COCO export
    │       │       ├── yolo/                       ← live YOLO export
    │       │       │   ├── data.yaml, classes.txt
    │       │       │   └── labels/{split}/{stem}.txt
    │       │       └── logs/activity.log           ← project-scoped action log
    │       └── activity.log                        ← account-wide action log
    │                                                  (login, profile changes —
    │                                                   things with no project)
    └── users/
        └── {user_id}_{username}/                 ← same shape as above

Design rules this module encodes:
  * Only the *paths* are stored in Postgres (images.storage_path,
    images.annotations_path); the bytes live here on disk.
  * A project folder is owned by the project's currently-assigned user, under
    that user's CURRENT role bucket. Reassigning a project or changing a
    user's role both move a subtree and the caller rewrites the stored paths
    in the same DB transaction, so DB and disk stay consistent.
  * These helpers are pure path math + filesystem ops. They never touch the
    database, so callers stay in control of transactions.

Input:  User / Project rows (for ids, names, role) and, for the writers, the
        data to persist. Process: compute the right path and read/write/move
        files.
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

# The two role buckets at the top of the storage tree. Deliberately just the
# two strings the role model uses ("admin" / "user") pluralised for "user" so
# the top-level folder names read naturally: admin/ and users/.
_ROLE_DIRS = {"admin": "admin", "user": "users"}


def _safe(name: str) -> str:
    """Filesystem-safe slug: keep word chars, collapse the rest to underscores."""
    s = re.sub(r"[^\w\s-]", "", name or "", flags=re.UNICODE)
    s = re.sub(r"[-\s]+", "_", s.strip())
    return s or "untitled"


def _role_dir(role: str) -> str:
    return _ROLE_DIRS.get(role, "users")


# ─── Directory layout ────────────────────────────────────────────────
def role_root(role: str) -> Path:
    """STORAGE_DIR/admin or STORAGE_DIR/users, depending on role."""
    return settings.STORAGE_DIR / _role_dir(role)


def user_dir(user_id: int, username: str, role: str) -> Path:
    """The folder that holds everything owned by one user, under their
    current role bucket."""
    return role_root(role) / f"{user_id}_{_safe(username)}"


def ensure_user_dir(user_id: int, username: str, role: str) -> Path:
    """Create (idempotently) a user's home folder. Called on account creation
    and whenever the role bucket needs to exist before a move."""
    d = user_dir(user_id, username, role)
    (d / "project").mkdir(parents=True, exist_ok=True)
    (d / "annotation").mkdir(parents=True, exist_ok=True)
    return d


def project_dir(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> Path:
    """A project's image folder, under its assigned (owner) user."""
    return (
        user_dir(owner_id, owner_username, owner_role)
        / "project"
        / f"{project_id}_{_safe(project_name)}"
    )


def annotation_dir(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> Path:
    """A project's annotation folder (json / overlays / coco / yolo / logs),
    under its assigned (owner) user. Kept as a sibling of project_dir rather
    than nested inside it, so images and annotation artifacts are two clearly
    separate trees per your layout."""
    return (
        user_dir(owner_id, owner_username, owner_role)
        / "annotation"
        / f"{project_id}_{_safe(project_name)}"
    )


def ensure_project_dirs(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> Path:
    """Create the images/ folder and every annotation subfolder for a project."""
    pdir = project_dir(owner_id, owner_username, owner_role, project_id, project_name)
    (pdir / "images").mkdir(parents=True, exist_ok=True)
    adir = annotation_dir(owner_id, owner_username, owner_role, project_id, project_name)
    for sub in ("json", "overlays", "coco", "yolo", "logs"):
        (adir / sub).mkdir(parents=True, exist_ok=True)
    return pdir


def image_target_path(
    owner_id: int,
    owner_username: str,
    owner_role: str,
    project_id: int,
    project_name: str,
    unique_hex: str,
    ext: str,
) -> Path:
    """Where a freshly-uploaded image file should be written.

    Stored directly in the project's images/ folder (no shard subdirectories)
    per the storage-layout requirement: images uploaded by an admin are files
    you can see directly inside project/{project}/images/.
    """
    images = project_dir(owner_id, owner_username, owner_role, project_id, project_name) / "images"
    images.mkdir(parents=True, exist_ok=True)
    return images / f"{unique_hex}{ext}"


def annotations_file_path(
    owner_id: int, owner_username: str, owner_role: str,
    project_id: int, project_name: str, image_id: int,
) -> Path:
    """The per-image annotations.json backup path, under annotation/{proj}/json/."""
    d = annotation_dir(owner_id, owner_username, owner_role, project_id, project_name) / "json"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{image_id}.json"


def overlay_file_path(
    owner_id: int, owner_username: str, owner_role: str,
    project_id: int, project_name: str, image_id: int, image_filename: str,
) -> Path:
    """Where the annotation-drawn-on-image overlay for one image is kept,
    under annotation/{proj}/overlays/. Always PNG regardless of source format,
    since it is a rendered composite, not a copy of the original file."""
    d = annotation_dir(owner_id, owner_username, owner_role, project_id, project_name) / "overlays"
    d.mkdir(parents=True, exist_ok=True)
    stem = Path(image_filename).stem or "image"
    return d / f"{image_id}_{_safe(stem)}.png"


def coco_export_path(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> Path:
    d = annotation_dir(owner_id, owner_username, owner_role, project_id, project_name) / "coco"
    d.mkdir(parents=True, exist_ok=True)
    return d / "annotations_coco.json"


def yolo_dirs(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> tuple[Path, Path]:
    """(yolo root dir, labels dir) under annotation/{proj}/yolo/."""
    root = annotation_dir(owner_id, owner_username, owner_role, project_id, project_name) / "yolo"
    labels = root / "labels"
    labels.mkdir(parents=True, exist_ok=True)
    return root, labels


def project_logs_dir(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> Path:
    d = annotation_dir(owner_id, owner_username, owner_role, project_id, project_name) / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def export_dir(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> Path:
    """A timestamped folder for a generated on-demand export bundle (the
    'save a zip to the server's Downloads' action), kept separate from the
    live coco/ and yolo/ folders above, which always reflect current state.

    Sits at the user root (not inside project/), so an export bundle is never
    mistaken for a project folder by anything that lists project/.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")
    d = (
        user_dir(owner_id, owner_username, owner_role)
        / "exports" / f"{project_id}_{_safe(project_name)}" / stamp
    )
    d.mkdir(parents=True, exist_ok=True)
    return d


# ─── Orphaned data (retained work with no live owner) ────────────────
# NOTE: accounts are deactivated, never deleted — there is no hard-delete
# endpoint, by policy. So nothing currently WRITES here. These helpers are
# kept because the integrity check excludes this folder by name, and because
# a future "archive an account" feature would land exactly here.
def orphan_root() -> Path:
    """Where retained project data with no live owner would be kept, one
    subfolder per former account."""
    return settings.STORAGE_DIR / "orphan_projects"


def orphan_user_dir(user_id: int, username: str) -> Path:
    """The folder holding one deleted user's former projects."""
    return orphan_root() / f"{user_id}_{_safe(username)}"


def move_user_to_orphan(user_id: int, username: str, role: str) -> Path | None:
    """Move a deleted user's whole folder into orphan_projects/.

    Returns the new location, or None if they had nothing on disk. The caller
    rewrites the affected image paths in Postgres in the same transaction, so
    the surviving project rows still point at files that exist.
    """
    src = user_dir(user_id, username, role)
    dst = orphan_user_dir(user_id, username)
    if not src.exists():
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        # A previous deletion of the same id+username. Keep both rather than
        # silently overwriting someone's recoverable data.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        dst = dst.with_name(f"{dst.name}_{stamp}")
    shutil.move(str(src), str(dst))
    log.info("Moved deleted user %s to orphan storage: %s -> %s", username, src, dst)
    return dst


# ─── Deletion ────────────────────────────────────────────────────────
def delete_project_dirs(
    owner_id: int, owner_username: str, owner_role: str, project_id: int, project_name: str
) -> list[str]:
    """Remove BOTH of a project's subtrees (images and annotation artifacts).

    Returns the paths actually removed, for the audit log. Deleting a project
    row used to leave its whole folder behind forever; this is what stops that
    leak. Best-effort per folder: a failure to remove one must not prevent the
    database row from being deleted, or the two would drift further apart.
    """
    removed = []
    for d in (
        project_dir(owner_id, owner_username, owner_role, project_id, project_name),
        annotation_dir(owner_id, owner_username, owner_role, project_id, project_name),
    ):
        if d.exists():
            try:
                shutil.rmtree(d)
                removed.append(str(d))
            except OSError:
                log.exception("Failed removing project folder %s", d)
    return removed


def delete_image_files(
    owner_id: int, owner_username: str, owner_role: str,
    project_id: int, project_name: str,
    image_id: int, image_filename: str, storage_path: str | None,
) -> list[str]:
    """Remove everything on disk belonging to ONE image: the original file,
    its annotations JSON, its overlay PNG, and its YOLO label file.

    Deleting an image used to unlink only the original and leave its
    annotation JSON behind as a permanent orphan — this closes that leak.
    """
    removed = []
    candidates = [Path(storage_path)] if storage_path else []
    candidates.append(
        annotation_dir(owner_id, owner_username, owner_role, project_id, project_name)
        / "json" / f"{image_id}.json"
    )
    stem = Path(image_filename).stem or "image"
    candidates.append(
        annotation_dir(owner_id, owner_username, owner_role, project_id, project_name)
        / "overlays" / f"{image_id}_{_safe(stem)}.png"
    )
    yolo_labels = (
        annotation_dir(owner_id, owner_username, owner_role, project_id, project_name)
        / "yolo" / "labels"
    )
    if yolo_labels.is_dir():
        for split_dir in yolo_labels.iterdir():
            if split_dir.is_dir():
                candidates.append(split_dir / f"{stem}.txt")

    for p in candidates:
        try:
            if p.is_file():
                p.unlink()
                removed.append(str(p))
        except OSError:
            log.exception("Failed removing image file %s", p)
    return removed


# ─── Writers ─────────────────────────────────────────────────────────
def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str))
    tmp.replace(path)  # atomic on the same filesystem


def write_annotations_json(
    path: Path, image_meta: dict, annotations: list[dict]
) -> str:
    """Rewrite one image's annotations.json backup. Returns the path as a string.

    Called after every create/update/delete for the image, so the file always
    mirrors the current DB rows. Whole-file rewrite is fine: an image has at
    most a few dozen annotations.
    """
    payload = {
        "image": image_meta,
        "annotations": annotations,
        "written_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write_json(path, payload)
    return str(path)


def append_activity_log(user_id: int, username: str, role: str, line: str) -> None:
    """Append one human-readable line to a user's account-wide activity.log.
    Best-effort: a logging failure must never break the request it describes."""
    try:
        d = ensure_user_dir(user_id, username, role)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        with (d / "activity.log").open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {line}\n")
    except Exception:
        log.exception("Failed appending activity.log for user %s", username)


def append_project_log(
    owner_id: int, owner_username: str, owner_role: str,
    project_id: int, project_name: str, line: str,
) -> None:
    """Append one line to a project's own log, under annotation/{proj}/logs/.
    Distinct from the user's account-wide activity.log: this is scoped to
    just this project's activity (uploads, annotation edits, review actions)."""
    try:
        d = project_logs_dir(owner_id, owner_username, owner_role, project_id, project_name)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        with (d / "activity.log").open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {line}\n")
    except Exception:
        log.exception("Failed appending project log for project %s", project_id)


# ─── Reassignment (move the files to follow the owner) ────────────────
def move_project_dir(
    old_owner_id: int, old_owner_username: str, old_owner_role: str,
    new_owner_id: int, new_owner_username: str, new_owner_role: str,
    project_id: int, project_name: str,
) -> tuple[Path | None, Path | None]:
    """Move a project's image folder AND its annotation folder from the old
    owner to the new owner.

    Returns (new project dir, new annotation dir) — either may be None if
    there was nothing to move. On the same disk this is a rename (near-
    instant). The caller is responsible for updating the stored paths in
    Postgres afterwards, in the same transaction, so DB and disk stay
    consistent.
    """
    def _move_one(src: Path, dst: Path) -> Path | None:
        if src.resolve() == dst.resolve():
            return dst
        if not src.exists():
            return None
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            shutil.rmtree(dst)
        shutil.move(str(src), str(dst))
        log.info("Moved %s -> %s", src, dst)
        return dst

    old_pdir = project_dir(old_owner_id, old_owner_username, old_owner_role, project_id, project_name)
    new_pdir = project_dir(new_owner_id, new_owner_username, new_owner_role, project_id, project_name)
    old_adir = annotation_dir(old_owner_id, old_owner_username, old_owner_role, project_id, project_name)
    new_adir = annotation_dir(new_owner_id, new_owner_username, new_owner_role, project_id, project_name)

    moved_p = _move_one(old_pdir, new_pdir)
    moved_a = _move_one(old_adir, new_adir)

    if moved_p is None and moved_a is None:
        # Nothing uploaded yet — just make sure the new owner's tree exists.
        ensure_user_dir(new_owner_id, new_owner_username, new_owner_role)
    return moved_p, moved_a


def move_user_role_dir(
    user_id: int, username: str, old_role: str, new_role: str,
) -> Path | None:
    """Move a user's ENTIRE folder (project/, annotation/, activity.log) from
    one role bucket to the other, e.g. users/3_bob -> admin/3_bob after a
    promotion. Returns the new user dir, or None if there was nothing on disk
    to move (a brand new account). The caller rewrites every stored path for
    this user's images/projects in the same DB transaction.
    """
    if old_role == new_role:
        return user_dir(user_id, username, new_role)

    src = user_dir(user_id, username, old_role)
    dst = user_dir(user_id, username, new_role)
    if not src.exists():
        ensure_user_dir(user_id, username, new_role)
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        # Extremely unlikely (same id/username already present in both
        # buckets) — merge safely by removing the empty destination first.
        shutil.rmtree(dst)
    shutil.move(str(src), str(dst))
    log.info("Moved user %s role dir: %s -> %s", username, src, dst)
    return dst
