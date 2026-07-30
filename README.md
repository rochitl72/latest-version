# RBG Annotation Studio

![RBG Annotation Studio](docs/assets/screenshot.jpeg)

A self-hosted, multi-user **image annotation platform**. Draw bounding boxes,
polygons and ellipses on images, review the work, and export the labels as
**COCO JSON**, **YOLO**, or a ready-to-train **labelled bundle** (images +
drawn overlays + label files).

**FastAPI** (Python) backend · **React/Vite** frontend · **PostgreSQL** ·
deployed with **Docker Compose**. Install once on a server; the whole team
works in a browser at the same URL.

> Internal project — RBG LABS · COERS (Centre of Excellence for Road Safety),
> Rehabilitation Bioengineering Group, IIT Madras.

---

## Contents

1. [What it does](#what-it-does)
2. [How it is put together](#how-it-is-put-together)
3. [Repository layout](#repository-layout)
4. [Quick start (Docker)](#quick-start-docker)
5. [**Deploying on a server**](#deploying-on-a-server)
6. [**Where files are stored, and how to change it**](#where-files-are-stored-and-how-to-change-it)
7. [Configuration reference](#configuration-reference)
8. [Roles: admin vs user](#roles-admin-vs-user)
9. [Day-to-day use](#day-to-day-use)
10. [Exporting labels](#exporting-labels)
11. [Admin dashboard and System panel](#admin-dashboard-and-system-panel)
12. [Backups](#backups)
13. [Resetting to a clean install](#resetting-to-a-clean-install)
14. [Running from source (development)](#running-from-source-development)
15. [Troubleshooting](#troubleshooting)
16. [Documentation index](#documentation-index)

---

## What it does

- **Annotation tools** — bounding box, polygon, ellipse. Select, pan, zoom,
  move and reshape existing annotations, undo/redo.
- **Two roles** — `admin` (full control) and `user` (annotates only what they
  are assigned).
- **One annotator per project** — an admin creates accounts and assigns each
  project to exactly one user. That user sees only their own projects; admins
  see everything. Reassigning a project moves its files to the new owner and
  rewrites the stored paths in the same transaction.
- **Per-user file storage** — every project's images, annotation backups,
  overlays, exports and logs live under the assigned user's own folder on
  disk, split by role. See
  [Where files are stored](#where-files-are-stored-and-how-to-change-it).
- **Review workflow** — In progress / Done, then an admin decides Needs
  review / Approved / Rejected. An approved image is locked; only an admin can
  reopen it.
- **Live export artifacts** — every annotation change refreshes that image's
  overlay PNG, YOLO label file and the project's COCO file on disk, so an
  export is never stale.
- **Dataset versions and splits** — snapshot a dataset, auto-split
  train/val/test.
- **Full audit log** — every change writes a row to `activity_log`, mirrored
  to plain-text logs on disk (per user and per project).

**Deliberately not included:** simultaneous editing of the same image by two
people, and ML-assisted auto-labelling. Both existed in an earlier version and
were removed to keep the deployment simple and dependency-light.

---

## How it is put together

The browser talks to FastAPI over plain REST — there is no WebSocket and no
background job queue, which keeps the deployment to three containers.

**PostgreSQL is the source of truth** for all structured data: accounts,
projects, assignments, image metadata, annotations and the audit log.
**Image files live on disk**; the database stores only their paths. This split
matters operationally — a full backup needs both halves (see
[Backups](#backups)).

Every request passes the same gates in order:

```
authenticate (JWT) → role check → project access → do the work → write an audit row
```

Annotations are saved the moment you finish a shape; nothing is buffered in the
browser and there is no save button. Heavy derived work — rendering the overlay
image, rewriting COCO/YOLO — runs *after* the response is sent, so drawing stays
responsive.

Diagrams and a full walkthrough live in [`docs/`](#documentation-index).

---

## Repository layout

```
rbg-annotation-studio/
├── backend/                     # FastAPI application
│   ├── app/
│   │   ├── main.py              # entrypoint + router registration
│   │   ├── core/                # config, security (JWT, hashing, role gates)
│   │   ├── db/                  # engine, session, bootstrap/seed
│   │   ├── models/              # SQLAlchemy ORM models (the schema)
│   │   ├── api/                 # HTTP routers, grouped by domain:
│   │   │   ├── auth/            #   login, users
│   │   │   ├── workspace/       #   projects, images, annotations
│   │   │   ├── dataset/         #   versions, splits, workflow, export
│   │   │   └── admin/           #   dashboard, activity feed, system panel
│   │   └── services/            # storage, membership, activity, export, metrics
│   ├── alembic/                 # database migrations
│   ├── scripts/                 # maintenance scripts
│   ├── Dockerfile
│   ├── entrypoint.sh            # wait for DB → alembic upgrade head → uvicorn
│   └── .env.example             # every backend setting, documented
├── frontend/                    # React + Vite single-page app
│   ├── src/
│   │   ├── components/          # UI: annotate/ admin/ auth/ projects/ …
│   │   ├── store/               # Zustand stores (editor state, undo/redo)
│   │   ├── lib/                 # API client, auth, config
│   │   └── utils/               # geometry, colours, mask encoding
│   ├── Dockerfile               # multi-stage build → nginx
│   └── nginx.conf               # serves the SPA, proxies /api and /health
├── docs/                        # architecture, data flow, diagrams
├── scripts/                     # ops helpers — see the table below
├── data/                        # created on first run: storage/ and exports/
├── docker-compose.yml           # full-stack deployment
├── .env.example                 # deployment secrets template
└── README.md
```

| Script | Purpose |
|---|---|
| `scripts/backup.sh` | Dump PostgreSQL + archive the file storage, with retention pruning. |
| `scripts/reset-all.sh` | Destroy all data and reseed a single admin. |
| `scripts/verify_storage.sh` | End-to-end check that files land where they should. |
| `scripts/verify_api.sh` | Permission-matrix test suite. |
| `scripts/db.sh` | Convenience wrapper for common SQL queries. |
| `scripts/migrate_layout_v2.sh` | One-time migration to the current storage layout. |

---

## Quick start (Docker)

Requires **Docker** and **Docker Compose**. This starts PostgreSQL, the API and
the web UI together.

```bash
# 1. get the code
git clone <repository-url>
cd rbg-annotation-studio

# 2. create your secrets file
cp .env.example .env

# 3. generate a signing key and paste it into .env as SECRET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# 4. edit .env — at minimum set SECRET_KEY, BOOTSTRAP_ADMIN_PASSWORD
#    and POSTGRES_PASSWORD
nano .env

# 5. build and start
docker compose up -d --build

# 6. open the app
#    http://localhost:8080        (change the port with WEB_PORT in .env)
```

Sign in with the `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` you
set in `.env`. That account is created only when the database is empty.

```bash
docker compose ps               # are all three services healthy?
docker compose logs -f backend  # follow the API log
docker compose down             # stop, keeping all data
```

---

## Deploying on a server

The Compose stack is the supported production path. Ubuntu 22.04+ shown.

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"      # log out and back in for this to apply
```

### 2. Fetch the code and configure

```bash
git clone <repository-url>
cd rbg-annotation-studio
cp .env.example .env
nano .env
```

For a real deployment you **must** set:

```bash
SECRET_KEY=<python3 -c "import secrets; print(secrets.token_urlsafe(32))">
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<a strong password>
POSTGRES_PASSWORD=<a strong database password>
SEED_TEST_USER=false
WEB_PORT=8080
COOKIE_SECURE=true                   # once you serve over HTTPS
```

The backend runs with `ENVIRONMENT=production`, which **refuses to start** if
`SECRET_KEY` is missing or the admin password is left at the built-in default.
That guard is deliberate — it fails loudly at boot rather than quietly shipping
a known password.

### 3. Decide where files will be stored

Do this **before** the first launch, while there is no data to migrate. See the
next section.

### 4. Launch

```bash
docker compose up -d --build
docker compose ps
```

On start the backend waits for PostgreSQL, applies migrations
(`alembic upgrade head`), then serves the API. The web container waits for the
API healthcheck before accepting traffic, so the first page load never fails.

The app is now at `http://<server-ip>:8080`.

### 5. Put HTTPS in front

Terminate TLS with a reverse proxy on the host and point it at
`127.0.0.1:${WEB_PORT}`. Minimal Caddy example:

```
studio.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `COOKIE_SECURE=true` in `.env` and re-run `docker compose up -d`, so
the authentication cookie is only ever sent over HTTPS.

### 6. Updating a deployed instance

```bash
cd rbg-annotation-studio
git pull
docker compose up -d --build      # the schema migrates itself on boot
```

---

## Where files are stored, and how to change it

**This is the section to read before deploying on a server.** Uploaded images
are the bulk of the data and they belong on a proper data disk, not on the
system volume.

### The two halves

| Data | Lives in | Why |
|---|---|---|
| Images, annotation backups, overlays, exports, logs | A **host folder**, bind-mounted into the container. Default `./data/` next to `docker-compose.yml`. | So you can browse, `rsync` and back it up with ordinary tools, no `docker exec` needed. |
| The PostgreSQL database | A **Docker named volume** (`pgdata`). | Postgres requires exact ownership on its data directory and performs many small synchronous writes. Both behave badly on a bind mount. Back it up with `pg_dump` — the only restorable method anyway. |

### On-disk layout

Files are organised by role, then by user, then split into images and
annotation artifacts:

```
<storage root>/
├── admin/                                   ← accounts with the admin role
│   └── {user_id}_{username}/
│       ├── project/
│       │   └── {project_id}_{project_name}/
│       │       └── images/{uuid}.jpg        ← the uploaded originals
│       ├── annotation/
│       │   └── {project_id}_{project_name}/
│       │       ├── json/{image_id}.json     ← per-image annotation backup
│       │       ├── overlays/{image_id}_*.png ← annotations drawn on the image
│       │       ├── coco/annotations_coco.json
│       │       ├── yolo/                     ← data.yaml, classes.txt, labels/
│       │       └── logs/activity.log         ← this project's actions
│       ├── exports/                          ← generated bundles
│       └── activity.log                      ← this account's actions
└── users/                                   ← accounts with the user role
    └── {user_id}_{username}/                  (same structure)
```

A user's folder moves between `admin/` and `users/` automatically if their role
changes, and every affected path in the database is rewritten in the same
transaction.

### Two different settings — do not confuse them

| Variable | Set in | Meaning |
|---|---|---|
| `STORAGE_PATH` | repo-root `.env` | The **host** folder. **This is the one you change.** |
| `EXPORT_PATH` | repo-root `.env` | The **host** folder for generated export bundles. |
| `STORAGE_DIR` | `backend/Dockerfile` | The path **inside** the container (`/data/storage`). Leave it alone. |
| `EXPORT_DIR` | `backend/Dockerfile` | The path inside the container (`/data/exports`). Leave it alone. |

The bind mount in `docker-compose.yml` connects them:

```yaml
- ${STORAGE_PATH:-./data/storage}:/data/storage
- ${EXPORT_PATH:-./data/exports}:/data/exports
```

The application only ever sees the container path. Changing `STORAGE_PATH`
changes which physical disk sits behind it.

### Pointing storage at a data disk

**On a fresh install, before any data exists:**

```bash
# 1. create the directories on the data disk
sudo mkdir -p /mnt/data/rbg-studio/storage
sudo mkdir -p /mnt/data/rbg-studio/exports

# 2. let the container write to them. The backend runs as root inside the
#    container by default, so this is normally sufficient:
sudo chown -R 1000:1000 /mnt/data/rbg-studio
sudo chmod -R 755 /mnt/data/rbg-studio

# 3. point the deployment at them
cd rbg-annotation-studio
nano .env
```

Add to `.env`:

```bash
STORAGE_PATH=/mnt/data/rbg-studio/storage
EXPORT_PATH=/mnt/data/rbg-studio/exports
```

Then start:

```bash
docker compose up -d --build
```

Use **absolute paths**. A relative path is resolved against the directory
containing `docker-compose.yml`, which is rarely what you want on a server.

### Moving storage on an install that already has data

Stop the stack first — copying files while the API is writing risks a
half-copied image.

```bash
# 1. stop
cd rbg-annotation-studio
docker compose down

# 2. back up first, always
bash scripts/backup.sh

# 3. copy, preserving permissions and timestamps
sudo mkdir -p /mnt/data/rbg-studio
sudo rsync -aH --info=progress2 ./data/storage/ /mnt/data/rbg-studio/storage/
sudo rsync -aH --info=progress2 ./data/exports/ /mnt/data/rbg-studio/exports/

# 4. repoint .env
nano .env        # set STORAGE_PATH and EXPORT_PATH as above

# 5. start again
docker compose up -d
```

**Important:** the database stores **absolute paths** to image files
(`images.storage_path`). If you move the storage folder, those paths still
point at the old location and images will not load. Because the container path
(`/data/storage`) is unchanged by a bind-mount move, this is normally fine —
the paths stored in the database are container paths, not host paths. Verify
after moving:

```bash
# Should report no missing files:
docker compose exec backend python -c "
from pathlib import Path
import asyncio
from sqlalchemy import select
from app.db.database import AsyncSessionLocal
from app.models import Image
async def main():
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(Image.id, Image.storage_path))).all()
        missing = [i for i, p in rows if p and not Path(p).is_file()]
        print(f'{len(rows)} images, {len(missing)} missing')
        if missing: print('missing ids:', missing[:20])
asyncio.run(main())"
```

Or use the built-in check: sign in as an admin and open
**System → Maintenance → database vs disk**, which reports missing files and
unreferenced ones.

### Sizing guidance

Each annotated image is stored twice: the original, plus a rendered overlay with
the annotations drawn on it. The overlay is written as **PNG**, which is
lossless — so for photographic input it comes out *larger* than the compressed
original. Measured on real aerial imagery, an 11 MB JPEG produced a 40 MB PNG
overlay.

**Budget roughly 3× the size of your raw image set**, plus room for export
bundles. On a set where every image gets annotated, expect:

| | share |
|---|---|
| original uploads | ~1× |
| overlay PNGs | ~1.5–2× |
| JSON, COCO, YOLO, logs | negligible |

If storage becomes a constraint, the overlay format is the thing to change —
writing overlays as JPEG instead of PNG would cut total usage by roughly half,
at the cost of some fidelity in the drawn lines. Overlays are regenerated from
the database on every annotation change, so switching format is safe: existing
files are replaced as images are edited, and nothing is lost if they are deleted.

### Using external storage (NFS, SAN)

Mount it on the host first, then point `STORAGE_PATH` at the mount point. The
application only performs ordinary file operations, so any POSIX filesystem
works. Two cautions:

- Ensure the mount is available at boot, before Docker starts, or the container
  will create an empty directory over the mount point.
- Do **not** put the PostgreSQL volume on NFS.

---

## Configuration reference

Every backend setting is documented in `backend/.env.example`; deployment
secrets are in the repo-root `.env.example`.

| Setting | Meaning |
|---|---|
| `SECRET_KEY` | Signs login tokens. **Required in production.** Changing it logs everyone out. |
| `ENVIRONMENT` | `development` or `production` (enables the fail-loud guards). |
| `BOOTSTRAP_ADMIN_USERNAME` / `_PASSWORD` | The first admin, seeded only when the database is empty. |
| `SEED_TEST_USER` | Seeds a demo user. Keep `false` in production. |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | Database credentials, shared by both containers. |
| `DATABASE_URL` | Full connection URL. Leave blank to build one from the `POSTGRES_*` values. |
| `STORAGE_PATH` / `EXPORT_PATH` | Host folders for files — see the section above. |
| `WEB_PORT` | Host port for the web UI. Default `8080`. |
| `DB_PORT` | Host port for PostgreSQL, published on loopback only. Default `5432`. |
| `COOKIE_SECURE` | Set `true` when served over HTTPS. |
| `MAX_UPLOAD_MB` | Per-file upload cap. Default `50`. |
| `MAX_FILES_PER_UPLOAD` | Files accepted in one request. Default `500`. |

**Passwords have no complexity rules** — no minimum length, no character
requirements, no expiry. Any string is accepted, including an empty one.
Account security rests on the admin choosing sensible passwords.

**Database port exposure.** PostgreSQL is published as
`127.0.0.1:${DB_PORT}:5432` — reachable from the server itself (for `psql` or a
GUI client over an SSH tunnel) but **not** from the network. Keep the
`127.0.0.1:` prefix, or remove the `ports:` block entirely; the backend reaches
the database over the internal Docker network regardless.

---

## Roles: admin vs user

| Capability | admin | user |
|---|:--:|:--:|
| Create and manage accounts | yes | — |
| Create and delete projects | yes | — |
| Upload images | yes | — |
| Assign a project to a user | yes | — |
| Create / recolour / delete label classes | yes | — |
| Draw and edit annotations | yes (anyone's) | yes (own, on assigned projects) |
| Mark In progress / Done | yes | yes |
| Approve / Reject / Needs review | yes | — |
| Reopen an approved image | yes | — |
| Edit an approved image | yes | — |
| Dataset versions and splits | yes | — |
| Export labels | yes | yes (assigned projects) |
| Team dashboard, activity log, System panel | yes | — |

A user reaches a project only after an admin assigns it, and a project has
exactly one assigned user at a time.

**Label classes are admin-only** because their name and colour appear on every
annotator's canvas and flow into every export — they are a project-wide
decision, not a personal preference.

**Accounts are never deleted.** An admin deactivates them instead, which blocks
sign-in while keeping their past annotations attributed. The last active admin
cannot be demoted or deactivated, so the system can never be locked out.

---

## Day-to-day use

**Admin setup:**

1. Create a project.
2. Assign it to a user. *A project must have an assigned user before images can
   be uploaded, because its files live under that user's folder.*
3. Upload images.
4. Add label classes in the right-hand panel — type a name, pick a colour,
   press `+`.

**Annotating:**

| Key | Tool |
|---|---|
| `V` | Select — move and reshape existing annotations |
| `B` | Bounding box |
| `P` | Polygon — click points, click the first point again to close |
| `E` | Ellipse |
| `H` | Pan (or hold Space with any tool) |
| `Ctrl/Cmd + Z` | Undo · `Ctrl/Cmd + Shift + Z` redo |
| `[` `]` | Previous / next image |

Annotations save the instant a shape is finished. The image status changes to
**In progress** on its own with the first shape — nothing to press.

**Review cycle:** the annotator presses **Done** when an image is finished,
which puts it in the admin's review queue. The admin then chooses **Approved**,
**Rejected** or **Needs review**. An approved image is locked to the annotator;
only an admin can reopen or edit it.

---

## Exporting labels

An admin, or the project's assigned user, can download labels from the project
header:

- **Labelled zip** — original images, overlay copies with the labels drawn on,
  YOLO `.txt` files, one COCO JSON, `classes.txt` and `manifest.json`.
- **COCO JSON** — standard COCO schema, supports polygon and RLE masks.
- **YOLO zip** — images plus YOLO labels and `data.yaml`, split into
  train/val/test.

Export works at any time; the review workflow is optional.

Live copies of the COCO and YOLO files are also kept on disk under each
project's `annotation/` folder and refreshed on every annotation change, so
they can be collected directly from the server without using the UI.

---

## Admin dashboard and System panel

**Dashboard** — progress measured in **images**, not annotation count (the
number of shapes per image varies with content, so it says nothing about
completion). Shows images done out of total, a status breakdown, daily
throughput, and per-project and per-person progress. Filter by project and by
time range.

**System panel** (`System` in the navigation) — a read-only operational view:

- database size, engine version and per-table row counts
- disk usage per user, with a live file tree
- each user's database records alongside their files
- a **database vs disk** consistency check, reporting images whose file is
  missing and files nothing references
- CSV downloads of images, annotations, users and the activity log

Password hashes are never exposed by this panel, and there is no facility for
running arbitrary SQL.

---

## Backups

**Both halves must be backed up** — the database alone is not enough, because
it holds only paths, not image bytes.

```bash
bash scripts/backup.sh
```

This writes a timestamped folder containing `db.dump` (a `pg_dump` custom-format
archive) and `storage.tar.gz`, then prunes anything older than the retention
window.

Schedule it nightly with cron:

```bash
15 2 * * *  /path/to/rbg-annotation-studio/scripts/backup.sh >> /var/log/rbg-backup.log 2>&1
```

Restore the database with:

```bash
pg_restore --clean --if-exists -h <host> -U <user> -d <database> db.dump
```

Restore files by extracting `storage.tar.gz` over the storage directory.

Copying the PostgreSQL data directory while the server is running does **not**
produce a restorable backup. Use `pg_dump`.

---

## Resetting to a clean install

Destroys all data and reseeds a single admin from `.env`. Intended for
commissioning a server, not for routine use.

```bash
bash scripts/reset-all.sh
```

It asks for confirmation, drops the database volume, empties the storage and
export folders, rebuilds, and verifies exactly one account exists. Take a backup
first if there is anything worth keeping — this cannot be undone.

---

## Running from source (development)

For working on the code with hot reload. PostgreSQL is still required.

```bash
# 1. a throwaway database
docker run --name rbg-dev-pg -e POSTGRES_USER=annoforge \
  -e POSTGRES_PASSWORD=annoforge -e POSTGRES_DB=annoforge \
  -p 5432:5432 -d postgres:16-alpine

# 2. backend (terminal 2)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cat > .env <<'EOF'
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=annoforge
POSTGRES_PASSWORD=annoforge
POSTGRES_DB=annoforge
SECRET_KEY=dev-secret-not-for-production
EOF
uvicorn app.main:app --reload --port 8000

# 3. frontend (terminal 3)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to the backend, so
everything is same-origin.

Requires **Python 3.11 or 3.12** — 3.13 lacks prebuilt wheels for some
dependencies. Node.js 18+ LTS.

In development, files are written under `backend/storage/`.

There is a one-time setup helper: `bash scripts/setup-local.sh`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Backend will not start, complains about `SECRET_KEY` | Not set in `.env`. Generate one and rebuild. |
| Port 5432 already in use | A PostgreSQL instance is already running on the host. Stop it, or change `DB_PORT` in `.env`. |
| Images do not load after moving storage | Paths in the database point elsewhere. Run the System panel's database-vs-disk check. |
| "Assign a user to this project before uploading" | A project's files live under its assigned user's folder, so it needs an assignee first. |
| A user cannot add a label class | Correct — label classes are admin-only. |
| A user cannot edit an approved image | Correct — approved images are locked. An admin must reopen it. |
| Uploads rejected | Check `MAX_UPLOAD_MB` and `MAX_FILES_PER_UPLOAD`, and that the file is a real image in an allowed format. |
| Changes not visible after a rebuild | Hard-refresh the browser to clear cached assets. |

Useful commands:

```bash
docker compose logs -f backend      # API logs
docker compose ps                   # health of each service
bash scripts/db.sh counts           # row counts
bash scripts/verify_storage.sh      # end-to-end storage check
```

---

## Documentation index

| File | Covers |
|---|---|
| `docs/diagrams/backend_flow.mermaid` | Request-flow diagram. Current. |
| `docs/diagrams/db_er.mermaid` | Database entity-relationship model. |
| `backend/.env.example` | Every backend setting, documented inline. |
| `.env.example` | Deployment secrets template. |
| `backend/app/README.md` | Backend folder map. |
| `frontend/src/README.md` | Frontend folder map. |
| `docs/ARCHITECTURE.md` | End-to-end system walkthrough. **Partly out of date** — describes the earlier storage layout. This README is authoritative on storage. |
| `docs/DATA_FLOW.md` | Every action mapped to where it is stored. **Partly out of date** — predates the current storage layout and the removal of the brush and keypoint tools. |
| `docs/planning/` | Historical design notes. **Superseded** — they describe an earlier design, not the current application. |

---

*RBG LABS · COERS — Rehabilitation Bioengineering Group, IIT Madras.*
