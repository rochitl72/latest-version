"""One-time migration: old flat per-user layout -> new role-split layout.

Old:  STORAGE_DIR/users/{id}_{name}/projects/{proj}/images/{xx}/{uuid}.ext
                                              /annotations/{image_id}.json
New:  STORAGE_DIR/{admin|users}/{id}_{name}/project/{proj}/images/{uuid}.ext
                                            /annotation/{proj}/json/{image_id}.json
                                            /annotation/{proj}/overlays/*.png
                                            /annotation/{proj}/coco/annotations_coco.json
                                            /annotation/{proj}/yolo/...
                                            /annotation/{proj}/logs/activity.log

What this script does, per user:
  1. Moves every image file out of its old {xx}/ shard directory into the
     project's new flat images/ folder, and rewrites Image.storage_path.
  2. Moves each image's annotations.json backup into annotation/{proj}/json/.
  3. Regenerates the overlay PNG, per-image YOLO .txt, and the project's live
     COCO export for every already-annotated image, so existing data doesn't
     have to wait for its next edit to get the new artifacts.
  4. If the account is an admin, all of the above lands directly under
     admin/{id}_{name}/... instead of users/{id}_{name}/... (the storage
     helpers already resolve the right bucket from the user's current role),
     which is what actually performs the admin/users split.
  5. Cleans up now-empty old shard/project/user directories as it goes.

Safe to re-run: every step skips work whose target already exists.

Run it INSIDE the backend container/venv, after backing up the database and
storage folder (see scripts/migrate_layout_v2.sh at the repo root, which does
both automatically):

    docker compose exec backend python scripts/migrate_layout_v2.py
"""
import asyncio
import json
import logging
import shutil
import sys
from pathlib import Path

# Make `app.*` importable regardless of the current working directory this
# script is launched from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.db.database import AsyncSessionLocal  # noqa: E402
from app.models import Annotation, Image, Label, Project, User  # noqa: E402
from app.services import storage  # noqa: E402
from app.services.export.export_formats import coco_segmentation, yolo_seg_line  # noqa: E402
from app.services.export.export_overlay import render_overlay  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("migrate_layout_v2")

# The OLD layout had no role split — every account's folder, admin or not,
# lived under this one root.
OLD_USERS_ROOT = settings.STORAGE_DIR / "users"


def _safe(name: str) -> str:
    return storage._safe(name)


def _old_project_dir(user: User, project: Project) -> Path:
    return (
        OLD_USERS_ROOT / f"{user.id}_{_safe(user.username)}"
        / "projects" / f"{project.id}_{_safe(project.name)}"
    )


async def _migrate_images(db, user: User, project: Project) -> list[Image]:
    """Flatten this project's image files into the new images/ folder
    (dropping the old 2-char shard subdirectories) and rewrite storage_path."""
    new_images_dir = storage.project_dir(
        user.id, user.username, user.role, project.id, project.name
    ) / "images"
    new_images_dir.mkdir(parents=True, exist_ok=True)

    imgs = (
        await db.execute(select(Image).where(Image.project_id == project.id))
    ).scalars().all()

    for img in imgs:
        old_path = Path(img.storage_path) if img.storage_path else None
        if old_path and old_path.is_file():
            new_path = new_images_dir / old_path.name
            if old_path.resolve() != new_path.resolve():
                if not new_path.exists():
                    shutil.move(str(old_path), str(new_path))
                    log.info("    image %s -> %s", old_path.name, new_path)
                img.storage_path = str(new_path)

    # Prune now-empty shard directories (images/{xx}/) left behind.
    old_images_dir = _old_project_dir(user, project) / "images"
    if old_images_dir.exists():
        for shard in old_images_dir.iterdir():
            try:
                if shard.is_dir() and not any(shard.iterdir()):
                    shard.rmdir()
            except OSError:
                pass

    return list(imgs)


async def _migrate_annotation_backups(db, user: User, project: Project, images: list[Image]) -> None:
    old_ann_dir = _old_project_dir(user, project) / "annotations"
    for img in images:
        new_path = storage.annotations_file_path(
            user.id, user.username, user.role, project.id, project.name, img.id,
        )
        old_path = old_ann_dir / f"{img.id}.json"
        if old_path.is_file() and not new_path.exists():
            shutil.move(str(old_path), str(new_path))
            img.annotations_path = str(new_path)
        elif new_path.is_file() and img.annotations_path != str(new_path):
            img.annotations_path = str(new_path)


async def _regenerate_artifacts(db, user: User, project: Project, images: list[Image]) -> None:
    """Build overlays + per-image YOLO files + the project's live COCO export
    for every already-annotated image."""
    labels = (
        await db.execute(select(Label).where(Label.project_id == project.id).order_by(Label.id))
    ).scalars().all()
    labels_by_id = {l.id: l for l in labels}
    label_id_to_idx = {l.id: idx for idx, l in enumerate(labels)}
    label_id_to_coco = {l.id: idx + 1 for idx, l in enumerate(labels)}

    coco = {
        "info": {"description": f"RBG export: {project.name}", "version": "1.0"},
        "licenses": [], "images": [], "annotations": [],
        "categories": [
            {"id": label_id_to_coco[l.id], "name": l.name, "supercategory": "object"}
            for l in labels
        ],
    }
    yolo_root, yolo_labels_root = storage.yolo_dirs(
        user.id, user.username, user.role, project.id, project.name
    )

    any_annotated = False
    for img in images:
        anns = (
            await db.execute(
                select(Annotation).where(Annotation.image_id == img.id).order_by(Annotation.id)
            )
        ).scalars().all()
        if not anns:
            continue
        any_annotated = True

        src = Path(img.storage_path)
        overlay_path = storage.overlay_file_path(
            user.id, user.username, user.role, project.id, project.name, img.id, img.filename,
        )
        if src.is_file():
            try:
                render_overlay(src, anns, labels_by_id, overlay_path, img.width, img.height)
            except Exception:
                log.exception("    overlay failed for image %s", img.id)

        split = img.split if img.split in ("train", "val", "test") else "train"
        split_dir = yolo_labels_root / split
        split_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(img.filename).stem
        lines = []
        for a in anns:
            if a.label_id not in label_id_to_idx:
                continue
            line = yolo_seg_line(a, label_id_to_idx[a.label_id], img.width, img.height)
            if line:
                lines.append(line)
        (split_dir / f"{stem}.txt").write_text("\n".join(lines))

        coco["images"].append({
            "id": img.id, "file_name": img.filename, "width": img.width, "height": img.height,
        })
        for a in anns:
            if a.label_id not in label_id_to_coco:
                continue
            try:
                seg, bbox, area = coco_segmentation(a, img)
            except ValueError:
                continue
            coco["annotations"].append({
                "id": a.id, "image_id": img.id,
                "category_id": label_id_to_coco[a.label_id],
                "segmentation": seg, "area": area, "bbox": bbox, "iscrowd": 0,
            })

    if not any_annotated:
        return

    (yolo_root / "classes.txt").write_text(
        "\n".join(l.name for l in labels) + ("\n" if labels else "")
    )
    (yolo_root / "data.yaml").write_text(
        "train: labels/train\nval: labels/val\ntest: labels/test\n\n"
        f"nc: {len(labels)}\nnames: {[l.name for l in labels]}\n"
    )
    coco_path = storage.coco_export_path(
        user.id, user.username, user.role, project.id, project.name
    )
    coco_path.write_text(json.dumps(coco, indent=2, default=str))
    log.info("    regenerated overlays/yolo/coco for %d annotated image(s)",
              sum(1 for i in coco["images"]))


def _cleanup_old_dirs(user: User) -> None:
    old_user_dir = OLD_USERS_ROOT / f"{user.id}_{_safe(user.username)}"
    # For a PLAIN user the old and new user folders are the same path
    # (storage/users/{id}_{name}) — only the inner layout changed. Never
    # remove it in that case, or we would delete the folder we just built.
    new_user_dir = storage.user_dir(user.id, user.username, user.role)
    same_dir = old_user_dir.resolve() == new_user_dir.resolve()
    old_projects_dir = old_user_dir / "projects"
    if old_projects_dir.exists():
        for p in sorted(old_projects_dir.rglob("*"), reverse=True):
            try:
                if p.is_dir() and not any(p.iterdir()):
                    p.rmdir()
            except OSError:
                pass
        try:
            if not any(old_projects_dir.iterdir()):
                old_projects_dir.rmdir()
        except OSError:
            pass
    if same_dir:
        return
    try:
        if old_user_dir.exists() and not any(old_user_dir.iterdir()):
            old_user_dir.rmdir()
    except OSError:
        pass


async def main() -> None:
    log.info("Storage root: %s", settings.STORAGE_DIR)
    if not OLD_USERS_ROOT.exists():
        log.info("No old users/ folder at %s — nothing to migrate.", OLD_USERS_ROOT)
        return

    async with AsyncSessionLocal() as db:
        users = (await db.execute(select(User).order_by(User.id))).scalars().all()
        for user in users:
            log.info("User %s %r (role=%s)", user.id, user.username, user.role)
            storage.ensure_user_dir(user.id, user.username, user.role)

            # The account-wide activity.log sat at the user root in the old
            # layout too — move it if it hasn't already been moved (this is
            # what performs the admin/users bucket move for that file).
            old_user_dir = OLD_USERS_ROOT / f"{user.id}_{_safe(user.username)}"
            new_user_dir = storage.user_dir(user.id, user.username, user.role)
            old_log = old_user_dir / "activity.log"
            new_log = new_user_dir / "activity.log"
            if old_log.is_file() and not new_log.exists():
                shutil.move(str(old_log), str(new_log))

            projects = (
                await db.execute(select(Project).where(Project.assigned_user_id == user.id))
            ).scalars().all()

            for project in projects:
                log.info("  project %s %r", project.id, project.name)
                storage.ensure_project_dirs(
                    user.id, user.username, user.role, project.id, project.name
                )
                images = await _migrate_images(db, user, project)
                await _migrate_annotation_backups(db, user, project, images)
                await _regenerate_artifacts(db, user, project, images)
                await db.flush()

            _cleanup_old_dirs(user)

        await db.commit()

    try:
        if OLD_USERS_ROOT.exists() and not any(OLD_USERS_ROOT.iterdir()):
            OLD_USERS_ROOT.rmdir()
            log.info("Removed empty old root %s", OLD_USERS_ROOT)
    except OSError:
        pass

    log.info("Migration complete.")


if __name__ == "__main__":
    asyncio.run(main())
