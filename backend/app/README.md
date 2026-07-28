# Backend source map (`backend/app/`)

Layered FastAPI app. Requests flow: **api → services → models → db**, with
`core` (config + security) available to all layers. Endpoints never import each
other across domains.

| Folder | What lives here |
|---|---|
| `main.py` | App assembly. Mounts every router and applies the `current_user` guard by default, so new endpoints are authenticated unless they opt out. |
| `api/auth/` | `auth.py` (login, logout, `/me`, register, change-password) and `users.py` (admin user management). |
| `api/workspace/` | The core annotation loop: `projects.py` (projects, labels, **single-user assignment**), `images.py` (upload/list/serve files), `annotations.py` (annotation CRUD + ownership rules + JSON backup). |
| `api/dataset/` | The dataset as an output: `versions.py` (snapshots), `splits.py` (train/val/test), `workflow.py` (image status + admin review decisions), `export.py` (COCO/YOLO/folder). |
| `api/admin/` | `dashboard.py` (progress/velocity/quality/workload metrics) and `activity.py` (audit-log feed). Admin-only. |
| `core/` | `config.py` (all env settings; fails loudly in production) and `security.py` (bcrypt, JWT, `current_user`, `require_role`). |
| `db/` | `database.py` (async engine/session) and `bootstrap.py` (seeds the first admin + creates their storage folder). |
| `models/` | `models.py` — the whole schema (User w/ `status`, Project w/ `assigned_user_id`, Image, Annotation, ActivityLog, DatasetVersion) plus the `Role` and `Action` constants. |
| `services/` | Reusable logic with no HTTP: `membership.py` (assignee/admin access checks), `storage.py` (per-user file tree, annotation/log backups, reassignment moves), `activity.py` (audit recorder), `metrics.py` (IoU), and `export/` (format writers). |

For the full narrative — auth, roles, and project access end to end — see
`../../docs/ARCHITECTURE.md`.
