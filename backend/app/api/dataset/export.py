"""Export annotations + labeled images to COCO JSON / YOLO / labeled-zip formats.

Anyone who can *see* a project can also download its labeled data: an admin
(any project), or a plain user who is a member of that specific project. This
mirrors what they can already view in the annotate UI — export just packages
it up. Non-members are still blocked with 403.

Auth note: every endpoint here is a GET (or POST) opened directly by the
browser as `<a href>` / `fetch` downloads, some of which can't carry an
Authorization header. They authenticate with `current_user_or_cookie`, which
also accepts the httpOnly login cookie (the same mechanism image `<img>` tags
use). Project access is then checked explicitly via `services.membership`.
"""
import io
import shutil
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.security import current_user_or_cookie
from app.db.database import get_db
from app.models import Project, Image, Label, User
from app.services import membership
from app.services.export.export_formats import coco_segmentation, yolo_seg_line
from app.services.export.export_folder import export_labeled_to_folder, _safe_dir_name

router = APIRouter(prefix="/api/projects/{project_id}/export", tags=["export"])


async def _require_project_access(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user_or_cookie),
) -> User:
    """Admin, or a member of this specific project. 403s everyone else."""
    await membership.assert_member(db, project_id, user)
    return user


def _require_admin_user(user: User = Depends(current_user_or_cookie)) -> User:
    """Admin-only gate, still used for the server-disk "Save to Downloads" action
    (that one writes into the server's own filesystem, which is an admin/ops
    action rather than a data-download any member should trigger)."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Saving to the server's Downloads folder requires the admin role.",
        )
    return user


@router.get("/coco")
async def export_coco(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_project_access),
):
    """COCO JSON with RLE masks for brush/SAM instances + polygon/bbox support."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    labels_res = await db.execute(select(Label).where(Label.project_id == project_id))
    labels = labels_res.scalars().all()
    label_id_to_coco_id = {lbl.id: idx + 1 for idx, lbl in enumerate(labels)}

    q = select(Image).where(Image.project_id == project_id)
    if project.active_version_id:
        q = q.where(Image.version_id == project.active_version_id)
    imgs_res = await db.execute(q.options(selectinload(Image.annotations)))
    images = imgs_res.scalars().all()

    coco = {
        "info": {"description": f"RBG export: {project.name}", "version": "1.0"},
        "licenses": [],
        "images": [],
        "annotations": [],
        "categories": [
            {"id": label_id_to_coco_id[lbl.id], "name": lbl.name, "supercategory": "object"}
            for lbl in labels
        ],
    }

    ann_id = 1
    for img in images:
        coco["images"].append({
            "id": img.id,
            "file_name": img.filename,
            "width": img.width,
            "height": img.height,
        })
        for ann in img.annotations:
            if ann.label_id not in label_id_to_coco_id:
                continue
            try:
                seg, bbox, area = coco_segmentation(ann, img)
            except ValueError:
                continue

            coco["annotations"].append({
                "id": ann_id,
                "image_id": img.id,
                "category_id": label_id_to_coco_id[ann.label_id],
                "segmentation": seg,
                "area": area,
                "bbox": bbox,
                "iscrowd": 0,
            })
            ann_id += 1

    return coco


@router.get("/yolo")
async def export_yolo(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_project_access),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    labels_res = await db.execute(
        select(Label).where(Label.project_id == project_id).order_by(Label.id)
    )
    labels = labels_res.scalars().all()
    label_id_to_idx = {lbl.id: idx for idx, lbl in enumerate(labels)}

    q = select(Image).where(Image.project_id == project_id)
    if project.active_version_id:
        q = q.where(Image.version_id == project.active_version_id)
    imgs_res = await db.execute(q.options(selectinload(Image.annotations)))
    images = imgs_res.scalars().all()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        data_yaml = (
            f"path: ./\n"
            f"train: images/train\n"
            f"val: images/val\n"
            f"test: images/test\n\n"
            f"nc: {len(labels)}\n"
            f"names: {[lbl.name for lbl in labels]}\n"
        )
        zf.writestr("data.yaml", data_yaml)

        for img in images:
            split = img.split if img.split in ("train", "val", "test") else "train"
            lines = []
            for ann in img.annotations:
                if ann.label_id not in label_id_to_idx:
                    continue
                line = yolo_seg_line(ann, label_id_to_idx[ann.label_id], img.width, img.height)
                if line:
                    lines.append(line)

            stem = Path(img.filename).stem
            zf.writestr(f"labels/{split}/{stem}.txt", "\n".join(lines))
            img_path = Path(img.storage_path)
            if img_path.exists():
                zf.write(img_path, f"images/{split}/{img.filename}")

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{project.name}-yolo.zip"'},
    )


@router.get("/labeled-zip")
async def export_labeled_zip(
    project_id: int,
    only_annotated: bool = Query(True),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_project_access),
):
    """Stream a single zip with everything: original images, an overlay copy
    of each image with its boxes/masks/polygons drawn on top, YOLO .txt labels,
    one COCO annotations_coco.json, classes.txt, and a manifest.json.

    This is the "download my labeled images and labels" button for both roles.
    Unlike /downloads (below), which writes into the *server's* filesystem,
    this builds the same bundle in a throwaway temp dir and streams the zip
    bytes back as the HTTP response, so it lands in whoever clicked it's own
    browser Downloads folder — admin or plain member alike.
    """
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    tmp_root = Path(tempfile.mkdtemp(prefix="rbg_export_"))
    out_dir = tmp_root / _safe_dir_name(project.name)
    try:
        try:
            await export_labeled_to_folder(
                db, project, out_dir, only_annotated=only_annotated
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

        zip_path = out_dir.parent / f"{out_dir.name}.zip"
        data = zip_path.read_bytes()
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{project.name}_labeled.zip"'
        },
    )


@router.post("/downloads")
async def export_to_downloads(
    project_id: int,
    only_annotated: bool = Query(True),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_require_admin_user),
):
    """Write labeled images + labels into ~/Downloads/<project>_labeled/."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    folder_name = f"{_safe_dir_name(project.name)}_labeled"
    out_dir = settings.EXPORT_DIR / folder_name
    try:
        result = await export_labeled_to_folder(
            db, project, out_dir, only_annotated=only_annotated
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return {
        "ok": True,
        "project": project.name,
        **result,
    }
