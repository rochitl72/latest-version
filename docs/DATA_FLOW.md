# RBG Annotation Studio — Data Flow & Storage Reference

Where every action goes, what it writes, and what it triggers — for **users**
and **admins** separately. Read this alongside the two diagrams in
`diagrams/backend_flow.mermaid` and `diagrams/db_er.mermaid`.

---

## 1. The two stores of truth

| What | Where it lives | Notes |
|---|---|---|
| Accounts, roles, project assignment, projects, labels, versions, **image metadata**, **annotations**, audit log | **PostgreSQL** | Everything structured and queryable. |
| The actual **image files**, **annotation JSON backups** and **export bundles** | **Server disk** (`STORAGE_DIR`, `EXPORT_DIR`) | The DB only stores the *path*. Layout: `storage/users/{uid}_{name}/projects/{pid}_{name}/…` |

So a single "save an annotation" writes a row to Postgres **and** rewrites that
image's JSON backup; an "upload images" writes rows to Postgres **and** files to
disk.

The annotations **table is authoritative**. The JSON file next to the images is a
continuously-synced backup (rewritten in full on every create/update/delete for
that image) so dashboards and exports can stay fast on the database.

> There is **no WebSocket** and no ephemeral presence state. Every interaction is
> a plain REST request.

---

## 2. How a request is gated (every request passes through this)

1. **Authentication** — `core/security.current_user` decodes the JWT, then
   **re-reads the user from `users`** so a demotion/deactivation applies
   instantly. Read-only file/download endpoints use `current_user_or_cookie`,
   which also accepts the httpOnly login cookie because `<img src>` and
   `<a href>` cannot set headers.
2. **Role gate** — endpoints that need admin declare `require_admin`. Under two
   roles, `user.can_review` simply means "is admin".
3. **Project-access gate** — project-scoped endpoints call
   `services/membership.assert_member`. A plain user must be the project's
   `assigned_user_id`; **admins bypass this** and can reach every project.
4. **The work** — the router reads/writes Postgres (and disk for files).
5. **Audit** — almost every mutation calls `services/activity.record`, appending
   one row to `activity_log` **in the same transaction** as the change, and
   mirroring a human-readable line to the user's `activity.log` on disk.

---

## 3. Client-side path for an annotation (bbox · polygon · keypoint · mask)

Drawing tools never call the API directly. They funnel through one choke point:

```
canvas tool → history store command → REST /api/annotations → Postgres
                                                            → annotations/{id}.json backup
                                    → editor store (instant on-screen update)
```

- **bbox / polygon / keypoint** are created in `AnnotationCanvas` and edited by
  the `Editable*` components; each edit is a `makeUpdateGeometryCmd`.
- **mask (brush)** is painted in `BrushOverlay`; on mouse-up it becomes
  `makeCreateCmd` (new mask) or `makeUpdateGeometryCmd` / `makeDeleteCmd`
  (growing, erasing, or clearing the selected mask).
- Every command records an **undo** snapshot, so `⌘Z` reverses it. Geometry is
  stored in the `annotations.geometry` JSONB column — coordinates for vector
  shapes, RLE for masks.

---

## 4. USER actions — end to end

A "user" is a plain annotator. They only see projects assigned to them.

| Action | Endpoint (method) | Gate | Postgres change | Disk | Audit |
|---|---|---|---|---|---|
| Log in | `/api/auth/login` (POST) | password | `UPDATE users.last_login_at` | — | `login`; issues JWT + cookie |
| Change own password | `/api/auth/change-password` (POST) | signed-in | `UPDATE users.password_hash`, clears `must_change_password` | — | `user.update` |
| See "My progress" | `/api/users/me/stats` (GET) | signed-in | reads only | — | — |
| List my projects | `/api/projects` (GET) | assignee filter | reads `projects.assigned_user_id` | — | — |
| Open a project's images | `/api/projects/{id}/images` (GET) | assignee | reads (auto-creates a `dataset_versions` row if none) | — | — |
| View an image | `/api/projects/{id}/images/{iid}/file` (GET) | assignee (cookie ok) | reads | reads file | — |
| List annotations | `/api/images/{iid}/annotations` (GET) | assignee | reads | — | — |
| **Draw** a bbox/polygon/keypoint/mask | `/api/annotations` (POST) | assignee; blocked if image `approved` | `INSERT annotations` (`created_by`,`updated_by`); may `UPDATE images.status → in_progress` | rewrites `annotations/{iid}.json` | `annotation.create` |
| **Edit** an annotation | `/api/annotations/{id}` (PATCH) | assignee; own only (admin any); not approved | `UPDATE annotations.geometry/label_id/updated_by` | rewrites backup | `annotation.update` (before/after) |
| **Delete** an annotation | `/api/annotations/{id}` (DELETE) | assignee; own only; not approved | `DELETE annotations` | rewrites backup | `annotation.delete` |
| Mark image In progress / Done | `/api/images/status` (PATCH) | assignee; non-review status only | `UPDATE images.status` | — | `image.status_change` |
| View **own** activity | `/api/activity/users/{self}` (GET) | self only | reads `activity_log` | — | — |

What a user **cannot** do (returns 403): create projects, upload/delete images,
create labels/versions, split datasets, approve/reject, manage users, touch a
project they aren't assigned to, or view team dashboards. They **can** export
their own assigned project's labels.

---

## 5. ADMIN actions — end to end

An "admin" can do everything a user can, plus the following. Admins bypass the
project-access gate entirely.

| Action | Endpoint (method) | Postgres change | Disk | Audit |
|---|---|---|---|---|
| Create a user | `/api/users` (POST) | `INSERT users` | creates `users/{id}_{name}/projects/` | `user.create` |
| Change role / deactivate / reset password | `/api/users/{id}` (PATCH / DELETE) | `UPDATE users` (last-admin guard; DELETE deactivates, never drops the row) | — | `user.update` / `user.deactivate` |
| Create a project | `/api/projects` (POST) | `INSERT projects` + `INSERT dataset_versions (v1)` + `UPDATE projects.active_version_id` | — | `project.create` |
| Delete a project | `/api/projects/{id}` (DELETE) | `DELETE projects` (cascades images, labels, versions, annotations) | orphaned files remain unless pruned | `project.delete` |
| Add / remove a label class | `/api/projects/{id}/labels` (POST / DELETE) | `INSERT` / `DELETE labels` (cascades annotations of that label) | — | `label.create` / `label.delete` |
| **Assign a project to a user** | `/api/projects/{id}/assignee` (GET / PUT) | `UPDATE projects.assigned_user_id` | **moves the whole project folder** to the new owner; rewrites stored paths in the same transaction | `project.assign` / `project.unassign` |
| **Upload images** | `/api/projects/{id}/images/upload` (POST) | `INSERT images` (+ version if none) | **writes files** to the assigned user's `projects/{pid}_{name}/images/{xx}/{uuid}.ext` | `image.upload` |
| Delete an image | `/api/projects/{id}/images/{iid}` (DELETE) | `DELETE images` | `unlink` file | `image.delete` |
| Approve / reject / needs-review | `/api/images/status`, `/api/images/bulk-status` | `UPDATE images.status, reviewed_by, reviewed_at, review_note` | — | `review.approve` / `reject` / `request` |
| Create a dataset version (snapshot) | `/api/projects/{id}/versions` (POST) | `INSERT dataset_versions` + copies images & annotations + `UPDATE active_version_id` | — | `version.create` |
| Activate a version | `/api/projects/{id}/versions/{vid}/activate` (POST) | `UPDATE projects.active_version_id` | — | — |
| Split / auto-split train·val·test | `/api/images/split`, `/api/projects/auto-split` | `UPDATE images.split` | — | — |
| Export COCO / YOLO / labeled zip | `/api/projects/{id}/export/{coco,yolo,labeled-zip}` (GET) | reads only | streams a bundle to the browser | — |
| Export to the server's disk | `/api/projects/{id}/export/downloads` (POST) | reads only | **writes** a bundle under `EXPORT_DIR` | `export` |
| Team dashboard (overview, velocity, contributors, quality, review queue, workload) | `/api/dashboard/*` (GET) | reads `images`, `annotations`, `activity_log` | — | — |
| Activity feed + CSV | `/api/activity`, `/api/activity/export.csv` | reads `activity_log` | — | — |

**Note on per-image assignment:** an earlier version let an admin assign
individual images to annotators (`images.assigned_to`) and soft-lock an image
while someone edited it (`image_locks`). Both were removed when the model moved
to one assigned user per project — migration `e5f4d3single5` drops them.

---

## 6. Cascade & ownership rules (what deletes take with them)

- Delete a **project** → its images, labels, dataset_versions, and (through
  images) annotations are all removed (`ON DELETE CASCADE`). Image files on disk
  are **not** auto-deleted.
- Delete an **image** → its annotations cascade away; the file is unlinked.
- Delete a **label** → annotations using it cascade away.
- Delete a **user** → the app *deactivates* instead of hard-deleting (sets
  `users.status = 'deactivated'`), so their authored annotations keep a valid
  `created_by`. If a user row were ever removed, `created_by` / `reviewed_by` /
  `assigned_user_id` are set null (`ON DELETE SET NULL`).
- A plain user may only edit/delete annotations where `created_by` is
  themselves; an admin may edit/delete anyone's.
- An image with status `approved` is frozen to everyone but an admin.

---

## 7. Quick "where is it stored?" cheat-sheet

- **My password / role / status / login time** → `users`.
- **Which projects I can see** → `projects.assigned_user_id` (admins: all).
- **A box/polygon/mask I drew** → `annotations` (geometry JSONB), plus a mirror
  in that image's `annotations/{image_id}.json`.
- **The image itself** → disk under its owner's folder; only the path + status
  live in `images`.
- **"Who did what, when"** → `activity_log` (one row per mutation), mirrored to
  `users/{uid}_{name}/activity.log`.
- **Train/val/test split, review status** → columns on `images`.
- **A frozen dataset snapshot** → `dataset_versions` (+ copied image/annotation rows).
