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
              STORAGE_DIR/users/{uid}_{name}/projects/{pid}_{name}/images/{xx}/{uuid}.ext
```

- **Structured data** (users, projects, annotations, assignments, audit log,
  dataset versions) lives in **PostgreSQL**.
- **Image files** live on the **server's disk**, referenced by path in the DB.
- The **backend** is Python/FastAPI: it owns authentication, role-based access,
  project access, and all persistence.
- The **frontend** is a React single-page app that talks to the backend over
  **plain REST only**. There is no WebSocket.

In the supported deployment (`docker-compose.yml`) the frontend is compiled to
static files and served by its own **nginx** container, which reverse-proxies
`/api` and `/health` to the backend — so the browser sees one origin. FastAPI can
alternatively serve the built bundle itself for single-process setups (see
`backend/app/main.py`).

> **Not in this system:** simultaneous editing of one image by two people, and
> ML-assisted auto-labelling. Both existed in an earlier version of the project
> and were removed. See the archive repo referenced in the root README.

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
│   │                       projects.py  — projects, labels, assignee
│   │                       images.py    — upload / list / serve image files
│   │                       annotations.py — annotation CRUD (+ ownership rules)
│   ├── dataset/            everything about the dataset as an output
│   │                       versions.py  — snapshot/fork/freeze
│   │                       splits.py    — train/val/test assignment
│   │                       workflow.py  — image status + review decisions
│   │                       export.py    — COCO / YOLO / folder export
│   └── admin/              admin-only monitoring
│                           dashboard.py — progress / velocity / quality metrics
│                           activity.py  — audit-log feed & search
│
├── core/                   cross-cutting configuration & security
│   ├── config.py           all settings (env-driven); fails loudly in production
│   └── security.py         password hashing, JWT, current_user, require_role gates
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
│   ├── storage.py          per-user file tree; annotation/log backups; moves
│   ├── activity.py         audit-log recorder (record() called on every mutation)
│   ├── metrics.py          IoU / inter-annotator agreement math
│   └── export/             dataset export formats (COCO, YOLO, overlays, RLE)
│
└── alembic/                database migrations (versions/*.py)
```

**Why grouped this way:** each `api/` subpackage is one domain you can reason
about in isolation. Endpoints depend *downward* only — on `core`, `db`,
`models`, and `services` — never sideways on each other (the one exception,
`auth.py` reusing `users.create_user_row`, is within the same subpackage).

---

## 3. How authentication & roles work

This is the part you'll touch most, so here it is end to end.

1. **Login** (`api/auth/auth.py` → `/api/auth/login`). The password is checked
   against the bcrypt hash in the `users` table (`core/security.authenticate`).
   On success the server issues a **JWT** carrying the user id and role, and
   also sets it as an httpOnly cookie (the cookie exists only so `<img>` tags
   and `<a href>` downloads can reach protected files, which can't send an
   Authorization header).

2. **Every protected request** carries `Authorization: Bearer <token>`. The
   `current_user` dependency in `core/security.py` decodes the token and then
   **re-reads the user from the database** — so revoking a role or deactivating
   an account takes effect immediately, not whenever the token expires.

3. **Role gates.** There are two roles: `user` and `admin` (`models.Role`).
   `require_admin` / `require_user` are FastAPI dependencies produced by
   `require_role()`. An endpoint that needs admin simply declares
   `user: User = Depends(require_admin)`. Everything an earlier "reviewer" role
   could do is now folded into `admin`; `user.can_review` means "is admin".

4. **Default-protected routing.** In `main.py`, every router is included with
   `dependencies=[Depends(current_user)]`, so a newly added endpoint is
   authenticated by default — you have to opt *out* deliberately. There are two
   deliberate exceptions, both narrow:
   - `images.file_router` and the export router use `current_user_or_cookie`,
     which also accepts the httpOnly cookie, because `<img src>` and `<a href>`
     downloads cannot set headers. Both are read-only GETs.
   - `/api/auth/login`, `/api/auth/config`, `/health` and `/api` are open by
     necessity.

5. **First-run safety.** On an empty database `db/bootstrap.py` seeds one admin
   from the `BOOTSTRAP_ADMIN_*` settings and flags it `must_change_password`, so
   the UI forces a password change on first sign-in. In `ENVIRONMENT=production`
   the app refuses to start if `SECRET_KEY` is unset or the default admin
   password is still in use (`core/config.py`).

---

## 4. How project access is gated

Roles say *what* you can do; assignment says *which projects* you can do it in.

- Each project has a single `projects.assigned_user_id` — **one user per
  project**. (An earlier many-to-many `project_members` table was collapsed into
  this; migration `e5f4d3single5` performs the change.)
- `services/membership.py` answers `is_member()` / `assert_member()`. **Admins
  always pass** — assignment only constrains plain users. The function names are
  unchanged from the multi-member era so every caller kept working.
- Project-scoped endpoints call `assert_member()` before doing anything, so an
  unassigned user gets `403` even with a valid token, and `list_projects` filters
  to the caller's assigned projects. An admin sets the assignee from the project
  panel (`GET/PUT /api/projects/{id}/assignee`).
- A project must have an assigned user **before images can be uploaded**, because
  its files live under that user's folder on disk.

---

## 5. How per-user file storage works

Only *paths* live in Postgres; the bytes live on disk, under the owning user.

```
STORAGE_DIR/users/{user_id}_{username}/
├── projects/{project_id}_{project_name}/
│   ├── images/{xx}/{uuid}.ext        original uploads, sharded by the first two
│   │                                 hex chars so no directory grows huge
│   ├── annotations/{image_id}.json   per-image backup, rewritten on every edit
│   └── exports/{timestamp}/          generated bundles
└── activity.log                      plain-text mirror of that user's actions
```

`services/storage.py` is pure path math plus filesystem operations — it never
touches the database, so callers keep control of their transactions.

- `images.storage_path` and `images.annotations_path` hold the absolute paths.
- The annotations table remains **authoritative**; the JSON file is a
  continuously-synced backup so dashboards and exports stay fast.
- **Reassigning a project moves its whole folder** to the new owner
  (`move_project_dir`) — on one disk that's a rename, not a byte copy. The caller
  updates the stored paths in the same transaction so DB and disk stay in step.

---

## 6. Frontend layout (`frontend/src/`)

```
main.jsx                    routes (React Router); gates /admin/* to admins
App.jsx                     app shell: header, role-aware nav, password-change gate
styles.css                  all styling (CSS variables; light "vivid" theme)
│
├── lib/                    non-UI app plumbing
│   ├── auth.js             token + current-user cache; isAdmin(), login(), logout()
│   ├── config.js           resolves the API base URL (same-origin, or absolute)
│   └── api/client.js       every REST call, one wrapper function per endpoint
│
├── store/                  Zustand state stores
│   ├── editor.js           in-memory editor state (viewport, tool, annotations…)
│   └── history.js          undo/redo commands — and where edits hit the API
│
├── utils/                  pure helpers (geometry, colours, RLE mask encoding)
│
└── components/             UI, grouped by feature
    ├── auth/               LoginPage, ChangePasswordModal
    ├── projects/           ProjectList (+ admin assignee panel), VersionsPanel
    ├── annotate/           the annotation workspace
    │   ├── AnnotateView.jsx    orchestrates the screen
    │   ├── canvas/            the Konva drawing surface + editable shapes
    │   └── (ReviewBar, ImageGallerySidebar, tool docks, magnifier…)
    ├── admin/              AdminDashboard, UserManagement, ActivityFeed,
    │                       ProjectMembersPanel (sets the single assignee)
    ├── home/               MyProgress (a plain user's own numbers)
    └── common/             shared widgets (ApiStatusBanner, ToolTipButton)
```

**Data-flow rule of thumb:** components call `lib/api/client.js` for reads and
call through `store/history.js` for annotation writes (so undo/redo happens
automatically). Role-dependent UI reads `isAdmin()` from `lib/auth.js`; the
backend enforces the same rule regardless, so hiding a button is convenience,
not security.

---

## 7. Running & deploying

- **Local dev:** start a Postgres container, run the backend with
  `uvicorn app.main:app --reload` (8000), and the Vite dev server with
  `npm run dev` (5173). Vite proxies `/api` to 8000. Full commands in the root
  README.
- **Deployment:** `docker compose up -d --build` brings up Postgres, the API,
  and nginx serving the built SPA. `backend/entrypoint.sh` waits for the
  database, runs `alembic upgrade head`, then starts uvicorn; the web container
  waits for the API's healthcheck before accepting traffic.
- **Migrations:** Alembic is the source of truth and runs automatically on
  container start. `db/database.py` additionally keeps a `create_all` +
  additive-column safety net so a database that drifted is never left
  un-runnable — but for real schema changes, write a migration.
- **HTTPS:** terminate TLS with a reverse proxy on the host (Caddy or nginx)
  pointing at `127.0.0.1:${WEB_PORT}`, then set `COOKIE_SECURE=true`. See the
  root README.
- **Backups:** `scripts/backup.sh` dumps Postgres and archives the image volume
  (schedule it nightly with cron). See `backend/.env.example` for all settings.

`docs/planning/` holds the historical plans. They describe the **earlier**
multi-user and desktop-launcher design and no longer match this codebase — read
them as history, not specification.
