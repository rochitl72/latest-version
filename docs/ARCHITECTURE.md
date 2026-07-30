# RBG Annotation Studio — Architecture Guide

A walkthrough of how the project is put together and how a request flows through
it, written so someone new to the codebase can find their way around.

---

## 1. The big picture

Three moving parts:

```
   Browser (React SPA)                FastAPI backend (Python)          PostgreSQL
 ┌──────────────────────┐   HTTPS   ┌───────────────────────────┐    ┌──────────┐
 │  components + stores  │◀────────▶│  api routers → services   │◀──▶│  tables  │
 │  (annotate, admin…)   │   REST    │  auth · RBAC · access     │    │          │
 └──────────────────────┘           └───────────────────────────┘    └──────────┘
                                              │ files on disk
                                              ▼
        STORAGE_DIR/{admin|users}/{uid}_{name}/project/{pid}_{name}/images/{uuid}.ext
```

- **Structured data** (users, projects, annotations, assignments, audit log,
  dataset versions) lives in **PostgreSQL**.
- **Image files** live on the **server's disk**, referenced by path in the DB.
- The **backend** is Python/FastAPI: it owns authentication, role-based access,
  project access, and all persistence.
- The **frontend** is a React single-page app that talks to the backend over
  **plain REST only**. There is no WebSocket, and no background job queue —
  which is what keeps the deployment down to three containers.

In the supported deployment (`docker-compose.yml`) the frontend is compiled to
static files and served by its own **nginx** container, which reverse-proxies
`/api` and `/health` to the backend, so the browser sees one origin. FastAPI can
alternatively serve the built bundle itself for single-process setups (see
`backend/app/main.py`).

> **Not in this system:** simultaneous editing of one image by two people, and
> ML-assisted auto-labelling. Both existed in an earlier version and were
> removed. Brush-mask and keypoint tools were likewise removed from the
> toolbar; the code that *renders* existing mask/keypoint annotations is
> retained so legacy data still displays and exports.

---

## 2. Backend layout (`backend/app/`)

The backend is organised in layers. A request flows top-to-bottom:

```
main.py                     app assembly: mounts routers, applies the auth guard
│
├── api/                    HTTP endpoints, grouped by domain
│   ├── auth/               login, logout, me, register, change-password (auth.py)
│   │                       admin user management (users.py)
│   ├── workspace/          the core annotation loop
│   │                       projects.py    — projects, labels, assignee
│   │                       images.py      — upload / list / serve image files
│   │                       annotations.py — annotation CRUD + derived artifacts
│   ├── dataset/            everything about the dataset as an output
│   │                       versions.py  — snapshot/fork/freeze
│   │                       splits.py    — train/val/test assignment
│   │                       workflow.py  — image status + review decisions
│   │                       export.py    — COCO / YOLO / folder export
│   └── admin/              admin-only monitoring
│                           dashboard.py — progress metrics
│                           activity.py  — audit-log feed & search
│                           system.py    — read-only DB/disk inspector + CSVs
│
├── core/                   cross-cutting configuration & security
│   ├── config.py           all settings (env-driven); fails loudly in production
│   └── security.py         password hashing, JWT, current_user, role gates
│
├── db/                     database plumbing
│   ├── database.py         async engine + session, create_all safety net
│   └── bootstrap.py        seeds the first admin on an empty database
│
├── models/                 SQLAlchemy ORM models (the schema, in one file)
│   └── models.py           User, Project, Image, Annotation, ActivityLog,
│                           DatasetVersion, Label, Role, Action
│
├── services/               reusable business logic (no HTTP here)
│   ├── membership.py       "may this user access this project?"
│   ├── storage.py          role-split per-user file tree; moves; deletion
│   ├── activity.py         audit-log recorder (called on every mutation)
│   ├── metrics.py          IoU / inter-annotator agreement math
│   └── export/             dataset export formats (COCO, YOLO, overlays, RLE)
│
├── scripts/                maintenance (one-time storage layout migration)
└── alembic/                database migrations (versions/*.py)
```

**Why grouped this way:** each `api/` subpackage is one domain you can reason
about in isolation. Endpoints depend *downward* only — on `core`, `db`,
`models`, and `services` — never sideways on each other (the one exception,
`auth.py` reusing `users.create_user_row`, is within the same subpackage).

---

## 3. How authentication & roles work

This is the part you will touch most, so here it is end to end.

1. **Login** (`api/auth/auth.py` → `/api/auth/login`). The password is checked
   against the bcrypt hash in the `users` table. On success the server issues a
   **JWT** carrying the user id and role, and also sets it as an httpOnly
   cookie — the cookie exists only so `<img>` tags and `<a href>` downloads can
   reach protected files, which cannot send an Authorization header.

2. **Every protected request** carries `Authorization: Bearer <token>`. The
   `current_user` dependency in `core/security.py` decodes the token and then
   **re-reads the user from the database**, so revoking a role or deactivating
   an account takes effect immediately rather than whenever the token expires.

3. **Role gates.** Two roles: `user` and `admin` (`models.Role`).
   `require_admin` is a FastAPI dependency; an endpoint that needs admin
   declares `user: User = Depends(require_admin)`. Everything an earlier
   "reviewer" role could do is folded into `admin`, so `user.can_review` simply
   means "is an admin".

4. **Default-protected routing.** In `main.py` most routers are included with
   `dependencies=[Depends(current_user)]`, so a newly added endpoint is
   authenticated by default — you have to opt *out* deliberately. Three narrow
   exceptions:
   - `images.file_router` uses `current_user_or_cookie`, because `<img src>`
     cannot set headers. Read-only GET.
   - `export.router` and `system.csv_router` are mounted **outside** the
     blanket guard so each endpoint can use its own cookie-capable gate —
     these are opened as `<a href>` downloads. Mounting them inside the
     header-only guard is what previously made CSV downloads fail with
     "Not authenticated".
   - `/api/auth/login`, `/api/auth/config`, `/health` and `/api` are open by
     necessity.

5. **Passwords have no rules.** No minimum length, no complexity, no reuse or
   expiry checks; any string is accepted, including an empty one. This is
   deliberate — account security rests on the admin choosing sensible
   passwords. The only validation is that a username may not be blank.

6. **First-run safety.** On an empty database `db/bootstrap.py` seeds one admin
   from the `BOOTSTRAP_ADMIN_*` settings. In `ENVIRONMENT=production` the app
   refuses to start if `SECRET_KEY` is unset or the built-in default admin
   password is still in use (`core/config.py`).

---

## 4. How project access is gated

Roles say *what* you can do; assignment says *which projects* you can do it in.

- Each project has a single `projects.assigned_user_id` — **one user per
  project**. A user may hold several projects; a project has at most one user.
  (An earlier many-to-many `project_members` table was collapsed into this;
  migration `e5f4d3single5` performs the change.)
- `services/membership.py` answers `is_member()` / `assert_member()`. **Admins
  always pass** — assignment only constrains plain users. The function names
  are unchanged from the multi-member era so every caller kept working.
- Project-scoped endpoints call `assert_member()` before doing anything, so an
  unassigned user gets `403` even with a valid token, and `list_projects`
  filters to the caller's assigned projects.
- A project must have an assigned user **before images can be uploaded**,
  because its files live under that user's folder on disk.

Two rules layer on top of project access:

- **Label classes are admin-only.** Their name and colour appear on every
  annotator's canvas and flow into every export, so they are a project-wide
  decision. Enforced by `require_admin` on the label routes.
- **An approved image is locked.** A plain user cannot edit it, and cannot move
  it back out of `approved` either — leaving that state is itself a review
  decision. Only an admin can reopen or edit approved work.

---

## 5. How per-user file storage works

Only *paths* live in Postgres; the bytes live on disk, under the owning user,
split by that user's current role.

```
STORAGE_DIR/
├── admin/                                   accounts with the admin role
│   └── {user_id}_{username}/
│       ├── project/{project_id}_{name}/
│       │   └── images/{uuid}.ext            original uploads, stored flat
│       ├── annotation/{project_id}_{name}/
│       │   ├── json/{image_id}.json         per-image backup of the DB rows
│       │   ├── overlays/{image_id}_*.png    annotations drawn on the image
│       │   ├── coco/annotations_coco.json   live COCO export
│       │   ├── yolo/                        data.yaml, classes.txt, labels/
│       │   └── logs/activity.log            this project's actions
│       ├── exports/                         generated bundles
│       └── activity.log                     this account's actions
└── users/                                   accounts with the user role
    └── {user_id}_{username}/                  (identical structure)
```

`services/storage.py` is pure path math plus filesystem operations — it never
touches the database, so callers keep control of their transactions.

- `images.storage_path` and `images.annotations_path` hold absolute paths.
- The `annotations` table remains **authoritative**; everything under
  `annotation/` is a mirror that can be rebuilt.
- **Reassigning a project** moves both its `project/` and `annotation/`
  subtrees to the new owner. On one disk that is a rename, not a byte copy.
- **Changing a user's role** moves their entire folder between `admin/` and
  `users/`. If the transaction fails afterwards the move is rolled back, so the
  database and the disk cannot disagree about where a file lives.
- Both operations rewrite the affected `storage_path` / `annotations_path`
  values **in the same transaction** as the move.

### Derived artifacts are written off the request path

Overlays, COCO and YOLO files are refreshed on every annotation change, but not
while the client is waiting. `annotations.py` does the database write plus the
small JSON backup inline, then hands a plain-data payload to a FastAPI
`BackgroundTask`:

```
POST /api/annotations
  ├── INSERT annotations                 ┐
  ├── write annotation/json/{id}.json    ├─ inline, inside the transaction
  ├── set images.annotations_path        ┘
  ├── COMMIT  →  response returns here
  └── background: render overlay PNG, rewrite COCO, write YOLO, append log
```

This matters because the overlay render reads and re-encodes the full image,
and the file writes land on a bind-mounted volume. Doing that inline made a
single annotation save take seconds. Sync background functions run in a
threadpool, so the encode does not block the event loop either.

The consequence to be aware of: the files under `annotation/` may lag the
database by a fraction of a second. Postgres is the source of truth.

---

## 6. Frontend layout (`frontend/src/`)

```
main.jsx                    routes (React Router); gates /admin/* to admins
App.jsx                     app shell: header, role-aware nav, password gate
styles.css                  all styling (CSS variables; light violet theme)
│
├── lib/                    non-UI app plumbing
│   ├── auth.js             token + current-user cache; isAdmin(), login()
│   ├── config.js           resolves the API base URL (same-origin or absolute)
│   └── api/client.js       every REST call, one wrapper function per endpoint
│
├── store/                  Zustand state stores
│   ├── editor.js           in-memory editor state (viewport, tool, annotations)
│   └── history.js          undo/redo commands — and where edits hit the API
│
├── utils/                  pure helpers (geometry, colours, RLE mask encoding)
│
└── components/             UI, grouped by feature
    ├── auth/               LoginPage, ChangePasswordModal
    ├── projects/           ProjectList (+ assignee panel), VersionsPanel
    ├── annotate/           the annotation workspace
    │   ├── AnnotateView.jsx   orchestrates the screen, owns the label panel
    │   ├── canvas/            the Konva drawing surface + editable shapes
    │   └── (ReviewBar, ImageGallerySidebar, tool docks, magnifier…)
    ├── admin/              AdminDashboard, UserManagement, ActivityFeed,
    │                       SystemPanel, ProjectMembersPanel
    ├── home/               MyProgress (a plain user's own numbers)
    └── common/             shared widgets (ApiStatusBanner, ToolTipButton)
```

**Data-flow rule of thumb:** components call `lib/api/client.js` for reads and
go through `store/history.js` for annotation writes, so undo/redo happens
automatically. Role-dependent UI reads `isAdmin()` from `lib/auth.js`; the
backend enforces the same rule regardless, so hiding a button is convenience,
not security.

Two details worth knowing about the canvas, both learned the hard way:

- **Nothing is written to state during a drag.** Writing on `onDragMove` made
  React reassign coordinates onto the node Konva was actively dragging, so the
  shape drifted away from the cursor. Live containment is handled by Konva's
  `dragBoundFunc`; state is written once, on `onDragEnd`.
- **`editor.js` is a module-level singleton** that outlives the annotate
  screen. `setLabels` therefore re-validates the active label against the
  incoming list — without that, opening a second project kept the first
  project's label id and every save failed with `404 Label not found`.

---

## 7. Running & deploying

- **Local dev:** start a Postgres container, run the backend with
  `uvicorn app.main:app --reload` (8000) and Vite with `npm run dev` (5173).
  Vite proxies `/api` to 8000. Full commands in the root README.
- **Deployment:** `docker compose up -d --build` brings up Postgres, the API,
  and nginx serving the built SPA. `backend/entrypoint.sh` waits for the
  database, runs `alembic upgrade head`, then starts uvicorn; the web container
  waits for the API healthcheck before accepting traffic.
- **Storage location:** set `STORAGE_PATH` / `EXPORT_PATH` in the repo-root
  `.env` to put files on a data disk. `STORAGE_DIR` / `EXPORT_DIR` are the
  paths *inside* the container and should be left alone. The root README has a
  full guide, including moving storage on an install that already has data.
- **Migrations:** Alembic is the source of truth and runs automatically on
  container start. `db/database.py` additionally keeps a `create_all` plus
  additive-column safety net so a drifted database is never left un-runnable —
  but for real schema changes, write a migration.
- **HTTPS:** terminate TLS with a reverse proxy on the host pointing at
  `127.0.0.1:${WEB_PORT}`, then set `COOKIE_SECURE=true`.
- **Backups:** `scripts/backup.sh` dumps Postgres *and* archives the file
  storage. Both halves are needed — the database holds only paths.
- **Clean slate:** `scripts/reset-all.sh` destroys all data and reseeds one
  admin. Intended for commissioning a server, not routine use.

`docs/planning/` holds historical plans. They describe the **earlier**
multi-user and desktop-launcher design and no longer match this codebase — read
them as history, not specification.
