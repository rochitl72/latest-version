# RBG Annotation Studio — Data Flow & Storage Reference

Where every action goes, what it writes, and what it triggers — for **users**
and **admins** separately. Read this alongside the two diagrams in
`diagrams/backend_flow.mermaid` and `diagrams/db_er.mermaid`.

---

## 1. The two stores of truth

| What | Where it lives | Notes |
|---|---|---|
| Accounts, roles, project assignment, projects, labels, versions, **image metadata**, **annotations**, audit log | **PostgreSQL** | Everything structured and queryable. |
| The actual **image files**, **annotation backups**, **overlays**, **COCO/YOLO files**, **export bundles** and **plain-text logs** | **Server disk** (`STORAGE_DIR`, `EXPORT_DIR`) | The DB only stores the *path*. |

On-disk layout, split by the owner's current role:

```
STORAGE_DIR/{admin|users}/{uid}_{name}/
├── project/{pid}_{name}/images/{uuid}.ext
├── annotation/{pid}_{name}/{json,overlays,coco,yolo,logs}/
├── exports/
└── activity.log
```

So a single "save an annotation" writes a row to Postgres **and** refreshes
several files; an "upload images" writes rows to Postgres **and** files to disk.

The annotations **table is authoritative**. Everything under `annotation/` is a
mirror that could be rebuilt from the database.

> There is **no WebSocket** and no ephemeral presence state. Every interaction
> is a plain REST request.

---

## 2. How a request is gated (every request passes through this)

1. **Authentication** — `core/security.current_user` decodes the JWT, then
   **re-reads the user from `users`** so a demotion or deactivation applies
   instantly. Read-only file and download endpoints use
   `current_user_or_cookie`, which also accepts the httpOnly login cookie
   because `<img src>` and `<a href>` cannot set headers.
2. **Role gate** — endpoints that need admin declare `require_admin`. Under two
   roles, `user.can_review` simply means "is an admin".
3. **Project-access gate** — project-scoped endpoints call
   `services/membership.assert_member`. A plain user must be the project's
   `assigned_user_id`; **admins bypass this** and can reach every project.
4. **The work** — the router reads/writes Postgres, and disk for files.
5. **Audit** — almost every mutation calls `services/activity.record`, which
   appends one row to `activity_log` **in the same transaction** as the change,
   and mirrors a human-readable line to the acting user's `activity.log` on
   disk. Logging is best-effort: a disk failure there never fails the request
   it describes.

---

## 3. Client-side path for an annotation

Drawing tools never call the API directly. They funnel through one choke point:

```
canvas tool → history store command → REST /api/annotations → Postgres
                                                            → annotation/json/{id}.json
                                    → editor store (instant on-screen update)
                                                            ↓ (background)
                                       overlay PNG · COCO · YOLO · project log
```

- **bbox, polygon and ellipse** are created in `AnnotationCanvas` and edited by
  the `Editable*` components; each edit is a `makeUpdateGeometryCmd`.
- Every command records an **undo** snapshot, so `Ctrl/Cmd+Z` reverses it.
  Geometry lives in the `annotations.geometry` JSONB column.
- Mask (RLE) and keypoint geometry still *renders* if present from an earlier
  version, but neither tool can create new annotations — both were removed from
  the toolbar.

An in-progress polygon — points clicked but not yet closed — exists only in
browser memory. Everything else is saved the instant a shape is completed;
there is no save button.

---

## 4. USER actions — end to end

A "user" is a plain annotator. They only see projects assigned to them.

| Action | Endpoint (method) | Gate | Postgres change | Disk | Audit |
|---|---|---|---|---|---|
| Log in | `/api/auth/login` (POST) | password | `UPDATE users.last_login_at` | — | `login`; issues JWT + cookie |
| Change own password | `/api/auth/change-password` (POST) | signed-in | `UPDATE users.password_hash` | — | `user.update` |
| See "My progress" | `/api/users/me/stats` (GET) | signed-in | reads only | — | — |
| List my projects | `/api/projects` (GET) | assignee filter | reads `projects.assigned_user_id` | — | — |
| Open a project's images | `/api/projects/{id}/images` (GET) | assignee | reads (auto-creates a `dataset_versions` row if none) | — | — |
| View an image | `/api/projects/{id}/images/{iid}/file` (GET) | assignee (cookie ok) | reads | reads file | — |
| List label classes | `/api/projects/{id}/labels` (GET) | assignee | reads | — | — |
| List annotations | `/api/images/{iid}/annotations` (GET) | assignee | reads | — | — |
| **Draw** a shape | `/api/annotations` (POST) | assignee; blocked if image `approved` | `INSERT annotations`; flips `images.status` to `in_progress` on the first shape | writes `annotation/json/{iid}.json`; **then in the background** overlay PNG, COCO, YOLO, project log | `annotation.create` |
| **Edit** an annotation | `/api/annotations/{id}` (PATCH) | assignee; own only; not approved | `UPDATE annotations.geometry/label_id/updated_by` | same as above | `annotation.update` (before/after) |
| **Delete** an annotation | `/api/annotations/{id}` (DELETE) | assignee; own only; not approved | `DELETE annotations` | rewrites backups; removes the overlay if it was the last shape | `annotation.delete` |
| Mark In progress / Done | `/api/images/status` (PATCH) | assignee; non-review statuses only; **blocked if currently `approved`** | `UPDATE images.status`; clears `reviewed_by/at/note` if leaving a review state | — | `image.status_change` |
| Export their project's labels | `/api/projects/{id}/export/*` (GET) | assignee (cookie ok) | reads only | streams a bundle | — |
| View **own** activity | `/api/activity/users/{self}` (GET) | self only | reads `activity_log` | — | — |

What a user **cannot** do (returns 403): create projects, upload or delete
images, create/recolour/delete label classes, create versions, split datasets,
approve/reject/needs-review, **reopen an approved image**, manage users, touch a
project they are not assigned to, or view team dashboards and the System panel.

---

## 5. ADMIN actions — end to end

An admin can do everything a user can, plus the following, and bypasses the
project-access gate entirely.

| Action | Endpoint (method) | Postgres change | Disk | Audit |
|---|---|---|---|---|
| Create a user | `/api/users` (POST) | `INSERT users` | creates `{admin|users}/{id}_{name}/` with `project/` and `annotation/` | `user.create` |
| Change role | `/api/users/{id}` (PATCH) | `UPDATE users.role` (last-admin guard) | **moves the whole user folder** between `admin/` and `users/`; rewrites stored paths in the same transaction, rolled back if the commit fails | `user.update` |
| Deactivate / reactivate | `/api/users/{id}` (PATCH / DELETE) | `UPDATE users.status` — the row is never dropped | — | `user.deactivate` |
| Create a project | `/api/projects` (POST) | `INSERT projects` + `INSERT dataset_versions (v1)` + `UPDATE active_version_id` | — | `project.create` |
| Delete a project | `/api/projects/{id}` (DELETE) | `DELETE projects` (cascades images, labels, versions, annotations) | **removes both the `project/` and `annotation/` subtrees** | `project.delete` (records removed paths) |
| Add a label class | `/api/projects/{id}/labels` (POST) | `INSERT labels` (name + colour) | — | `label.create` |
| Delete a label class | `/api/projects/{id}/labels/{lid}` (DELETE) | `DELETE labels` (cascades its annotations) | — | `label.delete` |
| **Assign a project** | `/api/projects/{id}/assignee` (GET / PUT) | `UPDATE projects.assigned_user_id` | **moves the project's `project/` and `annotation/` folders** to the new owner; rewrites paths in the same transaction | `project.assign` / `project.unassign` |
| **Upload images** | `/api/projects/{id}/images/upload` (POST) | `INSERT images` (+ version if none) | writes files to the assignee's `project/{pid}_{name}/images/{uuid}.ext` | `image.upload` |
| Delete an image | `/api/projects/{id}/images/{iid}` (DELETE) | `DELETE images` (cascades annotations) | removes the original **and** its annotation JSON, overlay and YOLO label file | `image.delete` (records removed paths) |
| Approve / reject / needs-review | `/api/images/status` (PATCH), `/api/images/bulk-status` (POST) | `UPDATE images.status, reviewed_by, reviewed_at, review_note` | — | `review.approve` / `reject` / `request` |
| Reopen an approved image | `/api/images/status` (PATCH) | `UPDATE images.status`; clears `reviewed_by/at/note` | — | `image.status_change` |
| Create a dataset version | `/api/projects/{id}/versions` (POST) | `INSERT dataset_versions` + copies image/annotation rows + `UPDATE active_version_id` | — | `version.create` |
| Activate a version | `/api/projects/{id}/versions/{vid}/activate` (POST) | `UPDATE projects.active_version_id` | — | — |
| Split / auto-split | `/api/images/split` (PATCH), `/api/projects/auto-split` (POST) | `UPDATE images.split` | — | — |
| Export COCO / YOLO / labelled zip | `/api/projects/{id}/export/{coco,yolo,labeled-zip}` (GET) | reads only | streams a bundle to the browser | — |
| Export to the server's disk | `/api/projects/{id}/export/downloads` (POST) | reads only | **writes** a bundle under `EXPORT_DIR` | `export` |
| Team dashboard | `/api/dashboard/*` (GET) | reads `images`, `annotations`, `activity_log` | — | — |
| Activity feed + CSV | `/api/activity`, `/api/activity/export.csv` (GET) | reads `activity_log` | — | — |
| System panel | `/api/system/{overview,storage,user/{id},integrity}` (GET) | reads counts and sizes | walks the storage tree | — |
| System CSV exports | `/api/system/export/{images,annotations,users,activity}.csv` (GET) | reads only | — | — |

The System panel is strictly read-only. `password_hash` is never selected,
never serialised and never exported, the database URL is reported with its
password redacted, and there is no arbitrary-SQL endpoint.

---

## 6. Cascade & ownership rules (what deletes take with them)

- Delete a **project** → its images, labels, dataset_versions and (through
  images) annotations are removed by `ON DELETE CASCADE`, **and** both its
  on-disk subtrees are deleted.
- Delete an **image** → its annotations cascade away, and the original file,
  annotation JSON, overlay and YOLO label are all removed.
- Delete a **label** → annotations using it cascade away.
- **Users are never deleted.** An admin deactivates them
  (`users.status = 'deactivated'`), which blocks sign-in while keeping their
  authored annotations attributed. The last active admin cannot be demoted or
  deactivated. The foreign keys still declare `ON DELETE SET NULL` on
  `created_by` / `reviewed_by` / `assigned_user_id` as a defensive measure.
- A plain user may only edit or delete annotations where `created_by` is
  themselves; an admin may edit or delete anyone's.
- An image with status `approved` is frozen to a plain user — they can neither
  edit it nor move it out of `approved`. Only an admin can reopen or edit it.

---

## 7. Quick "where is it stored?" cheat-sheet

- **My password / role / status / login time** → `users`.
- **Which projects I can see** → `projects.assigned_user_id` (admins: all).
- **A shape I drew** → `annotations` (geometry JSONB), mirrored to
  `annotation/{pid}_{name}/json/{image_id}.json`.
- **What my annotations look like drawn on the image** →
  `annotation/{pid}_{name}/overlays/{image_id}_*.png`.
- **Ready-to-use COCO / YOLO for a project** →
  `annotation/{pid}_{name}/coco/` and `/yolo/`, refreshed on every change.
- **The image itself** → disk under its owner's `project/` folder; only the
  path and status live in `images`.
- **"Who did what, when"** → `activity_log` (one row per mutation), mirrored to
  the user's `activity.log` and to each project's
  `annotation/{pid}_{name}/logs/activity.log`.
- **Train/val/test split, review status** → columns on `images`.
- **A frozen dataset snapshot** → `dataset_versions` plus copied image and
  annotation rows.
