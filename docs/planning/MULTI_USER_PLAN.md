# Multi-user collaboration + Postgres — implementation plan

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


Draft for review. Decision points are marked **[CHOOSE]** — nothing gets built
until those are settled.

---

## 1. Where the code stands today

| Area | Current state |
|---|---|
| Database | SQLite via `aiosqlite`, 2 projects · 11 images · 8 annotations |
| Migrations | Hand-rolled `db/migrate.py` — a list of `ALTER TABLE` statements wrapped in `except: pass`. Alembic is in `requirements.txt` but completely unused (no `alembic.ini`, no `versions/`) |
| Users | **No users table.** One hardcoded account, validated against env vars |
| Auth | JWT issued at `/api/auth/login`; token carries only a username |
| Annotations | No author — nothing records *who* drew a box |
| Image status | 6 states (`unannotated → in_progress → annotated → needs_review → approved/rejected`) — **any caller can set any state**, including `approved` |
| Versions | `DatasetVersion` table already exists with fork/freeze semantics — reusable as-is |
| Audit | None |

Two things worth calling out before we start:

- **`migrate.py` has to go.** `ALTER TABLE ... except: pass` is a SQLite-ism
  that silently swallows real errors. Postgres is the right moment to replace
  it with proper Alembic migrations.
- **`approved` / `rejected` are already reachable by anyone.** The role split
  the team lead wants is a genuine security fix, not just organisation.

---

## 2. Schema changes

### New tables

**`users`** — identity and login
`id · username · email · password_hash · full_name · role · is_active · created_at · last_login_at`

**`project_members`** — who can see which project, and as what
`id · project_id · user_id · role · added_at · added_by`
*(only needed if we go with per-project roles — see decision B)*

**`activity_log`** — the audit trail
`id · user_id · project_id · image_id · annotation_id · action · details (JSONB) · created_at`

Actions recorded: `login`, `image.upload`, `annotation.create`, `annotation.update`,
`annotation.delete`, `image.status_change`, `review.approve`, `review.reject`,
`version.create`, `user.create`, `user.role_change`.

`details` stores before/after values, so "who changed this box and what did it
look like before" is answerable. JSONB rather than JSON so it stays queryable.

**`image_locks`** — soft check-out (only if decision A picks locking)
`image_id · user_id · acquired_at · expires_at`

### Changed tables

- **`annotations`** — add `created_by`, `updated_by` (FK → users)
- **`images`** — add `assigned_to`, `reviewed_by`, `reviewed_at`, `review_note`
- **`projects`** — add `created_by`
- All timestamps move to **timezone-aware** (`TIMESTAMPTZ`). Today they use
  `datetime.utcnow`, which is naive *and* deprecated in Python 3.12+. With
  several users in potentially different timezones this stops being cosmetic.
- All `JSON` columns become **`JSONB`** — indexable, and Postgres's native form.

---

## 3. Postgres migration

- `aiosqlite` → **`asyncpg`**; `DATABASE_URL` becomes a real connection string
  in `.env` (already wired for env config).
- Replace `db/migrate.py` + `create_all()` with **Alembic**, with an initial
  migration capturing the current schema and a second adding multi-user tables.
- **Data migration:** a one-shot script copying the existing SQLite rows across.
  At 11 images and 8 annotations this is quick and low-risk. Existing
  annotations get attributed to a designated first admin account.
- Docker Compose for local Postgres is optional — happy to add it or leave
  Postgres externally managed.

---

## 4. Decision points

### [CHOOSE] A — How do two people edit the same image?

This is the biggest fork in the plan, and the hardest part of the whole build.

| Option | How it feels | Build cost |
|---|---|---|
| **A1. Soft locking** | Opening an image checks it out. Others see "Priya is annotating this" and get read-only until she leaves or the lock expires. No conflicts possible. | **Low** — a table, a heartbeat, some UI |
| **A2. Optimistic concurrency** | Everyone edits freely. Each annotation carries a revision; a stale save is rejected with "this box changed underneath you — reload". | **Medium** — revision checks, conflict UI |
| **A3. Live collaborative** | True Google Docs: WebSockets, live cursors, shapes appearing as others draw them. | **High** — WebSocket layer, presence, real-time sync, reconnect handling |

My read: **A1 is the honest recommendation** for annotation work. Google Docs
needs live co-editing because people write prose in the same paragraph;
annotators almost never need to draw on the *same image* simultaneously — they
need to not overwrite each other and to see who did what. A1 delivers that in a
fraction of the time. A3 is genuinely impressive in a demo, and is roughly the
same build cost as everything else on this page combined.

A2 is the middle path if you want simultaneous editing without the WebSocket
machinery.

### [CHOOSE] B — Role model

| Option | Roles | Notes |
|---|---|---|
| **B1. Two global roles** | `admin`, `annotator` | Simplest. A user is the same everywhere |
| **B2. Three global roles** | `admin`, `reviewer`, `annotator` | Separates "approves work" from "manages users and projects" |
| **B3. Per-project roles** | Same roles, assigned per project | A user can be reviewer on one project, annotator on another. Needs `project_members` |

Permission split as requested, either way:

| Action | Annotator | Reviewer | Admin |
|---|---|---|---|
| Create / edit / delete own annotations | ✅ | ✅ | ✅ |
| Mark image `annotated` (done) | ✅ | ✅ | ✅ |
| Delete *another user's* annotation | ❌ | ✅ | ✅ |
| Approve / reject / mark for review | ❌ | ✅ | ✅ |
| Upload / delete images | ❌ | ❌ | ✅ |
| Create projects, labels, versions | ❌ | ❌ | ✅ |
| Create users, change roles | ❌ | ❌ | ✅ |
| View dashboards and audit log | own stats only | team | team |

### [CHOOSE] C — Admin monitoring & visualisation

This is the part you asked me to brainstorm. Grouped into four coherent
bundles; pick any combination.

**C1 · Progress & velocity dashboard**
- Project completion ring: % unannotated / in progress / annotated / approved
- Per-user contribution table — images completed, annotations drawn, today vs week vs all-time
- Velocity chart: images completed per day, per user, with a trend line
- Projected completion date from current throughput
- Burndown: images remaining over time

**C2 · Quality & agreement metrics**
- Rejection rate per annotator — the single best quality signal you have
- Rework rate: how often someone's images bounce back from review
- Average annotations per image per user, against the project average — surfaces under-labelling
- Time-per-image distribution — spots both rushing and stalling
- **Inter-annotator agreement**: when two people annotate the same image, compare via IoU. This is the metric that justifies "multiple users on one image", and it's a strong thing to show a hackathon panel
- Label distribution per user vs project average — catches systematic bias

**C3 · Activity feed & audit**
- Live "who did what, when" feed on the admin dashboard
- Per-user drill-down: full chronological action history
- Filter/search the audit log by user, date range, action, image
- Before/after diff on any annotation edit
- CSV export of the log

**C4 · Assignment & workload**
- Assign images or batches to specific annotators
- Per-user workload view — assigned vs completed
- Review queue with a "needs review" backlog count
- Bulk approve / reject from the queue
- Rejection reasons that route back to the annotator
- Live presence: who is in the project right now

If you want a single recommendation: **C1 + C3** is the strongest core — progress
plus accountability, and C3 is nearly free once `activity_log` exists since the
data is already being written. **C2's inter-annotator agreement** is the most
technically impressive item on this page. **C4** is the most *operationally*
useful if several people will really work in parallel.

### [CHOOSE] D — Existing data

| Option | Result |
|---|---|
| **D1. Migrate** | Copy the 2 projects / 11 images / 8 annotations into Postgres, attributed to the first admin |
| **D2. Fresh start** | Empty Postgres. Existing SQLite file kept as a backup |

---

## 5. Suggested phasing

Each phase leaves the app working and demo-able.

**Phase 1 — Postgres + users** *(foundation, nothing user-visible)*
Alembic setup · Postgres swap · `users` table · registration/login against the
DB · JWT carries `user_id` + `role` · data migration.

**Phase 2 — Roles + permissions**
Role dependencies on the routers · approve/reject restricted · annotation
ownership (`created_by`) · admin user-management screen.

**Phase 3 — Audit log**
`activity_log` written on every mutation · activity feed · per-user history.

**Phase 4 — Concurrency** *(whichever of A1/A2/A3 you pick)*

**Phase 5 — Admin dashboards** *(whichever of C1–C4 you pick)*

Phases 1–3 are largely independent of the choices above, so I can start on
Phase 1 the moment B and D are settled — A and C only bind at phases 4 and 5.

---

## 6. Risks worth naming upfront

- **Postgres is a hard dependency.** Today the app runs from a single file with
  zero setup. After this, every developer and the deployment target need a
  running Postgres. Worth confirming the team lead wants that trade — it is the
  right call for multi-user, but it does end the "double-click and it runs"
  property.
- **A3 (live collaboration) is the schedule risk.** If it's wanted, it should
  start early and I'd want to descope elsewhere.
- **The current `.venv` and `annoforge.db` are local artifacts.** Multi-user
  means the database becomes shared infrastructure — someone needs to own
  backups.
