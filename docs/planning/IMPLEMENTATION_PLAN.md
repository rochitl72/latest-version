# RBG Annotation Studio — Multi-User Implementation Plan

> ⚠️ **HISTORICAL — SUPERSEDED. Not a description of the current system.**
>
> This plan was written for an earlier design and is kept only as a record of how
> the project got here. Since it was written:
>
> * live multi-user co-editing of one image (WebSocket, presence, image locks)
>   was **removed**;
> * many-users-per-project (`project_members`) was replaced by **one assigned
>   user per project**;
> * the one-click desktop launchers were dropped in favour of a **Docker
>   deployment on a server**;
> * ML auto-labelling (SAM / GroundingDINO) was **removed**.
>
> For how the system actually works now, read `../ARCHITECTURE.md` and
> `../DATA_FLOW.md`.


Supersedes the decisions left open in `MULTI_USER_PLAN.md`. This is the agreed
scope for the multi-user, deployment-ready build.

## Build status (2026-07-22)

| Part | Status |
|---|---|
| 1 · Two roles (admin + user) | ✅ Built & tested |
| 2 · Infra hardening (paths, sharding, pool, backups, fail-loud) | ✅ Built |
| 3 · Project membership & allocation | ✅ Built & tested |
| 6 · Frontend role awareness + admin UI | ✅ Built (frontend compiles) |
| 4 · Live co-editing (WebSocket) | ✅ Built |
| 5 · Logs & version history surfaces | ◑ Activity feed built; version panel already existed |

Verified via a full FastAPI TestClient run: admin/user login, role gating,
membership grant/revoke, dashboard admin-only access, and forced password
change all pass. Frontend builds clean with Vite. Alembic migrations are
Postgres-targeted (the SQLite test path uses `create_all`).

**To run after pulling:** `alembic upgrade head` (applies the role-collapse,
`must_change_password`, and `project_members` migrations), then rebuild the
frontend with `scripts/build.sh`.

## Decisions locked in

| Question | Decision |
|---|---|
| **Roles** | **Two roles only: `admin` and `user`.** Everything the old `reviewer` role could do is folded into `admin`. |
| **Hosting** | Single server / VM. One backend process, one Postgres, local disk for images. |
| **Scale target** | Larger team + larger dataset (dozens of users, tens of thousands of images). |
| **Project membership** | Admin assigns which users belong to which project. A project can have one or many members; non-members cannot see or annotate it. |
| **Collaboration** | **True live co-editing** — multiple users annotate the *same image at the same time*, seeing each other's boxes and cursors appear in real time (Google-Docs style). |
| **Data store** | Everything structured — users, sessions/roles, projects, memberships, annotations, logs, version history — lives in **Postgres**. Image *files* live on the server's data disk, referenced by path in Postgres. |
| **Stack** | Postgres (data) + FastAPI/Python (backend, auth, RBAC) + React/JavaScript (frontend). Auth logic stays in Python — see note below. |

> **Note on "handled by Postgres and JavaScript":** all data, including
> accounts, roles and audit logs, already lives in Postgres — that stays. The
> auth *logic* runs in the Python/FastAPI backend and the UI is JavaScript/React.
> Rewriting the backend into Node/JS would discard the entire working
> RBAC + audit + locking layer for zero functional gain, so this plan keeps the
> Python backend. Flag if you specifically need a Node backend and we'll discuss.

---

## Part 1 — Collapse three roles into two (`admin` + `user`)

The code currently has a three-tier ladder (`annotator < reviewer < admin`). We
collapse it to two by giving `admin` everything `reviewer` had.

**Backend changes**
- `models.py` → `Role`: keep `USER` (renamed from `ANNOTATOR`) and `ADMIN`;
  drop `REVIEWER`. `RANK = {user: 1, admin: 2}`.
- `core/security.py` → remove `require_reviewer`; every place that used it now
  uses `require_admin`. `require_annotator` becomes `require_user` (any signed-in
  account).
- Anywhere that checked `user.can_review` (e.g. `annotations.py` ownership,
  approve/reject, dashboards, activity feed) now checks `user.is_admin`.
- Alembic migration: convert existing `reviewer` rows → `admin`, and
  `annotator` rows → `user`. One data migration, reversible.
- Keep the "role re-read from DB on every request" behaviour — deactivating or
  demoting a user still takes effect instantly.

**Resulting permission matrix**

| Action | user | admin |
|---|---|---|
| Create/edit/delete own annotations (on projects they're a member of) | ✅ | ✅ |
| Mark image done (`annotated`) | ✅ | ✅ |
| Edit/delete another user's annotation | ❌ | ✅ |
| Approve / reject / mark-for-review | ❌ | ✅ |
| Upload / delete images | ❌ | ✅ |
| Create projects, labels, versions | ❌ | ✅ |
| Assign users to projects | ❌ | ✅ |
| Create users, change roles, deactivate | ❌ | ✅ |
| View dashboards & full audit log | own work only | ✅ |

---

## Part 2 — Infrastructure hardening (the five fixes)

These are cheap now and painful once real data piles up, so they go first.

1. **Fix storage & export paths.** Move `STORAGE_DIR` and `EXPORT_DIR` off their
   dev defaults (backend folder / server's `~/Downloads`) to a dedicated data
   volume, e.g. `STORAGE_DIR=/var/lib/rbg-studio/storage`,
   `EXPORT_DIR=/var/lib/rbg-studio/exports`. Set them in `.env`; document in
   `.env.example` (the commented options already exist — make them the real
   values and add a deployment note).
2. **Shard the image directory.** Today files go in `storage/project_{id}/{uuid}.ext`
   — already sharded per project, but a single busy project can still pile tens
   of thousands of files in one folder. Add a second level using the UUID prefix:
   `storage/project_{id}/{uuid[:2]}/{uuid}.ext`. Keeps any one directory small
   and fast. Applies to new uploads; a one-shot migration script relocates
   existing files and updates `storage_path` in Postgres.
3. **Bump the Postgres connection pool.** `database.py` is at
   `pool_size=10, max_overflow=20` (sized for <20 users). Raise to something like
   `pool_size=20, max_overflow=40` and make both env-configurable, so we can tune
   without code changes. (If concurrent users climb past what one Postgres
   comfortably serves, put PgBouncer in front — noted, not built now.)
4. **Backup script.** Nightly `pg_dump` of the database + a snapshot/rsync of the
   storage volume, with retention (e.g. keep 14 daily). Ship as a script +
   documented cron entry. This is the safety net for annotations, users, audit
   log, and image files.
5. **Deployment config hardening** (bundled with the above): require `SECRET_KEY`
   to be set in production (fail loudly instead of silently regenerating and
   logging everyone out on restart), and force the bootstrap admin to change the
   default password on first login.

---

## Part 3 — Project membership & allocation

New capability: an admin decides which users can work on which project.

**Schema** — new table `project_members`:
`id · project_id · user_id · added_at · added_by`
(No per-project role — role stays global `admin`/`user`. Membership is simply
"is this user allowed on this project".)

**Backend**
- `projects.py` list endpoint filters to projects the caller is a member of
  (admins see all).
- All project-scoped endpoints (images, annotations, versions, export) gain a
  membership check: a non-member gets 403 even with a valid token.
- New admin-only endpoints: add member, remove member, list members, list
  assignable users.
- Membership changes are written to the audit log.

**Frontend**
- Admin project view gets a "Members" panel: search users, add/remove, see who's
  on the project.
- Non-admins only ever see projects they belong to.

---

## Part 4 — Live co-editing (same image, real time)

The ambitious piece. This *replaces* the current soft-locking model with true
concurrent editing, so it's planned as its own phase that lands last — the app
stays fully usable on soft-locking until this ships.

**Transport**
- Add a WebSocket layer (FastAPI supports it natively) at e.g.
  `/ws/projects/{id}` or `/ws/images/{id}`.
- Each annotation image room broadcasts: annotation created / updated / deleted,
  and presence (who's viewing, live cursor position).

**Sync model**
- Annotations are the shared unit. When user A draws a box, it's persisted to
  Postgres and broadcast to everyone else in that image room, who add it to their
  canvas live.
- Edits carry the annotation id + a revision number; last-write-wins per
  annotation with a revision guard, so two people editing *different* boxes never
  conflict, and two editing the *same* box get a clean resolution instead of a
  lost update.
- Presence (cursors, "3 people here") is ephemeral — broadcast over WebSocket,
  not persisted.

**What changes vs today**
- The `image_locks` table and its enforcement (`assert_can_edit`) are retired for
  annotation, OR repurposed as optional "focus" hints. (Recommend retiring —
  locking and live co-editing are opposite philosophies.)
- Reconnect handling: on reconnect the client re-fetches the image's annotations
  from Postgres (source of truth) and resubscribes.

**Honest cost note:** this phase is roughly as much work as Parts 1–3 and 5
combined, and carries the most risk (real-time sync, reconnects, conflict edge
cases). Everything else is designed to ship and be useful before it starts.

---

## Part 5 — Logs & version history (surface what exists)

Most of this is already written on the backend; the work is exposing it.

**Already built:** `activity_log` (append-only audit trail, written on nearly
every mutation) and `DatasetVersion` (fork/freeze snapshots per project). Both
live in Postgres.

**To do**
- Confirm every mutation path writes an activity row (membership changes, the new
  live edits).
- Frontend: an **activity feed** per project (who did what, when) and a per-user
  drill-down, both admin-visible.
- Frontend: a **version history** panel — list snapshots, see what changed, fork
  / freeze / activate a version. (Backend endpoints largely exist; wire them up.)
- Before/after diff on annotation edits (the audit log already stores
  before/after geometry).

---

## Part 6 — Frontend (the largest functional gap)

The backend RBAC/audit/dashboard/membership layer is real but the React app
surfaces almost none of it. This part builds that surface.

**Session & role awareness**
- After login, read the current user (`/api/auth/me`) and store `role` +
  `id` in app state. Everything below branches on it.

**Role-gated navigation**
- `user`: sees only their projects, the annotation workspace, their own stats.
- `admin`: additionally sees the admin dashboard, user management, project
  members, activity feed, version history, review/approve controls.
- Client-side gating is convenience only — the backend already enforces every
  rule, so a hidden button that's somehow reached still 403s.

**Admin dashboard (project monitoring)** — the headline admin feature
- Per-project progress: % unannotated / in-progress / annotated / approved.
- Per-user contribution table (images completed, annotations drawn, today vs
  all-time).
- Velocity chart + projected completion.
- Review queue: images needing review, bulk approve/reject.
- Powered by the existing `dashboard.py` (513 lines of metrics already written).

**Admin — user management**
- Create users, set role (`user`/`admin`), deactivate, reset password.
- Backed by existing `users.py`.

**Admin — project membership**
- Add/remove users on each project (Part 3).

**Review / approve flow**
- Replace the current ungated "optional" status chip in `ReviewBar.jsx` with a
  proper admin-only approve/reject/needs-review control.

**Live collaboration UI (Part 4)**
- Presence indicators ("3 people annotating"), live cursors, other users'
  annotations appearing in real time.

---

## Suggested sequencing

Each phase leaves the app working and demo-able.

1. **Part 1** — collapse to two roles (small, unblocks everything).
2. **Part 2** — infra hardening (do before real data accumulates).
3. **Part 3** — project membership backend + admin membership UI.
4. **Part 6 (core)** — frontend role awareness, admin dashboard, user
   management, review flow, activity feed, version history. This is where the
   app finally *feels* multi-user.
5. **Part 5** — polish logs/version-history surfaces (overlaps with 6).
6. **Part 4** — live co-editing. Last, because it's the biggest and riskiest,
   and the app is fully useful without it.

---

## Open points to confirm before build

1. **Live co-editing scope** — confirmed you want same-image real-time. Just
   flagging again that it's the schedule risk; if timeline gets tight, the app
   ships fully functional after step 5 with same-project/different-image
   concurrency, and live co-editing can follow.
2. **Backend language** — plan keeps Python/FastAPI. Confirm you're not asking
   for a Node rewrite.
3. **Backup cadence & retention** — nightly + 14 days assumed; adjust if you
   want hourly or longer retention.
4. **Default admin** — keep the existing seed credentials but force a password
   change on first login? (Recommended.)
