#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# setup-local.sh — one-time setup to run WITHOUT Docker (macOS).
#
# Installs nothing behind your back except Python packages inside a local
# virtualenv. It checks prerequisites, creates the database, writes
# backend/.env if missing, and applies the migrations.
#
#   bash scripts/setup-local.sh
#
# Afterwards, run the app with two terminals — see the summary it prints.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PGDB="${POSTGRES_DB:-annoforge}"
PGUSER_="${POSTGRES_USER:-annoforge}"
PGPASS="${POSTGRES_PASSWORD:-annoforge}"

say()  { echo; echo "── $1 ─────────────────────────────────────"; }
die()  { echo; echo "❌ $1"; exit 1; }

# ── 1. Python 3.11 or 3.12 ───────────────────────────────────────────
say "1. Python"
PY=""
for c in python3.12 python3.11 python3; do
  command -v "$c" >/dev/null || continue
  V=$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  case "$V" in
    3.11|3.12) PY="$c"; break ;;
    *) LAST="$c ($V)" ;;
  esac
done
if [[ -z "$PY" ]]; then
  echo "   Found: ${LAST:-none}"
  echo
  echo "   This project needs Python 3.11 or 3.12."
  echo "   3.13 does NOT work: numpy 1.26.4, asyncpg 0.29 and psycopg2-binary"
  echo "   2.9.9 publish no arm64 wheels for it and fail to build."
  echo
  die "Install one:   brew install python@3.12"
fi
echo "   ✅ using $PY ($("$PY" -c 'import sys; print(sys.version.split()[0])'))"

# ── 2. PostgreSQL ────────────────────────────────────────────────────
say "2. PostgreSQL"
command -v psql >/dev/null || die "psql not found. Install:   brew install postgresql@16 && brew services start postgresql@16"
pg_isready -q 2>/dev/null || die "PostgreSQL is not accepting connections. Start it:   brew services start postgresql@16"
echo "   ✅ PostgreSQL is running"

if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$PGDB"; then
  echo "   ✅ database '$PGDB' already exists"
else
  echo "   creating role and database '$PGDB' …"
  psql -d postgres -v ON_ERROR_STOP=1 <<SQL || die "Could not create the database. Create it by hand, then re-run."
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PGUSER_') THEN
    CREATE ROLE $PGUSER_ LOGIN PASSWORD '$PGPASS';
  END IF;
END \$\$;
SQL
  createdb -O "$PGUSER_" "$PGDB"
  echo "   ✅ created database '$PGDB' owned by '$PGUSER_'"
fi

# ── 3. Backend virtualenv ────────────────────────────────────────────
say "3. Backend dependencies"
cd "$ROOT/backend"
[[ -d .venv ]] || "$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
echo "   installing requirements (a minute or two the first time) …"
pip install --quiet -r requirements.txt
echo "   ✅ installed into backend/.venv"

# ── 4. backend/.env ──────────────────────────────────────────────────
say "4. Configuration"
if [[ -f .env ]]; then
  echo "   ✅ backend/.env already exists — leaving it alone"
else
  SECRET=$("$PY" -c 'import secrets; print(secrets.token_urlsafe(32))')
  cat > .env <<ENV
# Written by scripts/setup-local.sh — safe to edit.
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=$PGUSER_
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=$PGDB

ENVIRONMENT=development
SECRET_KEY=$SECRET

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=demo123
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
SEED_TEST_USER=false
ENV
  echo "   ✅ wrote backend/.env (admin / demo123, with a generated SECRET_KEY)"
fi

# ── 5. Migrations ────────────────────────────────────────────────────
say "5. Database schema"
alembic upgrade head
echo "   ✅ migrations applied"

# ── 6. Frontend ──────────────────────────────────────────────────────
say "6. Frontend dependencies"
command -v node >/dev/null || die "node not found. Install:   brew install node"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 18 )) || die "Node 18+ required, found $(node -v)."
cd "$ROOT/frontend"
npm install --silent --no-fund --no-audit
echo "   ✅ node_modules ready ($(node -v))"

# ── Done ─────────────────────────────────────────────────────────────
cat <<DONE

═══════════════════════════════════════════════════════════════════
 Setup complete. Start the app with TWO terminals:

   Terminal 1 — API
     cd $ROOT/backend
     source .venv/bin/activate
     uvicorn app.main:app --reload --port 8000

   Terminal 2 — web UI
     cd $ROOT/frontend
     npm run dev

   Then open  http://localhost:5173     (sign in: admin / demo123)

 Uploaded images land in a real folder you can open in Finder:
     $ROOT/backend/storage/

 Note: run uvicorn from the backend/ directory — it reads backend/.env
 relative to the current working directory.
═══════════════════════════════════════════════════════════════════
DONE
