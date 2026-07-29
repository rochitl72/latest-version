#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# RBG Annotation Studio — FULL RESET
#
# Destroys ALL application data and starts over with a single admin:
#
#   * every row in Postgres  (users, projects, images, annotations, audit log)
#   * every file under data/storage  (uploads, annotations, overlays, exports,
#     and orphan_projects)
#
# Afterwards the stack comes back up and seeds exactly one account, taken
# from BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD in .env.
#
# THIS CANNOT BE UNDONE. Run scripts/backup.sh first if you want a copy.
#
# Usage:
#   bash scripts/reset-all.sh
#   FORCE=1 bash scripts/reset-all.sh    # skip the confirmation prompt
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STORAGE_DIR="${STORAGE_PATH:-./data/storage}"
EXPORTS_DIR="${EXPORT_PATH:-./data/exports}"

echo "═══════════════════════════════════════════════════════════"
echo "  FULL RESET — this destroys all users, projects and files"
echo "═══════════════════════════════════════════════════════════"
echo
echo "  Database volume : pgdata (dropped entirely)"
echo "  Storage folder  : $STORAGE_DIR (emptied)"
echo "  Exports folder  : $EXPORTS_DIR (emptied)"
echo

if [[ -f .env ]]; then
  ADMIN_U=$(grep -E '^BOOTSTRAP_ADMIN_USERNAME=' .env | cut -d= -f2- || true)
  ADMIN_P=$(grep -E '^BOOTSTRAP_ADMIN_PASSWORD=' .env | cut -d= -f2- || true)
  echo "  Will reseed admin: '${ADMIN_U:-admin}' with the password set in .env"
  if [[ -z "${ADMIN_P:-}" ]]; then
    echo
    echo "  ERROR: BOOTSTRAP_ADMIN_PASSWORD is empty in .env."
    echo "  Set it before resetting, or you will not be able to sign in."
    exit 1
  fi
else
  echo "  ERROR: no .env file found. Copy .env.example to .env first."
  exit 1
fi
echo

if [[ "${FORCE:-0}" != "1" ]]; then
  read -r -p "Type ERASE to confirm: " CONFIRM
  if [[ "$CONFIRM" != "ERASE" ]]; then
    echo "Aborted. Nothing was changed."
    exit 0
  fi
fi

echo
echo "-- 1/4 Stopping the stack and removing the database volume..."
# `down -v` removes the named volumes declared in docker-compose.yml, which is
# what actually deletes the Postgres data directory. Without -v the old
# database would survive and the admin would NOT be reseeded (bootstrap only
# acts on an empty user table).
docker compose down -v

echo "-- 2/4 Clearing the storage and export folders..."
# Delete the CONTENTS, not the folders themselves: they are bind-mount targets,
# and removing them would make Docker recreate them as root-owned.
if [[ -d "$STORAGE_DIR" ]]; then
  find "$STORAGE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  echo "   cleared $STORAGE_DIR"
fi
if [[ -d "$EXPORTS_DIR" ]]; then
  find "$EXPORTS_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  echo "   cleared $EXPORTS_DIR"
fi

echo "-- 3/4 Rebuilding and starting..."
docker compose up -d --build

echo "-- 4/4 Waiting for the API to come up and seed the admin..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1 \
     || curl -fsS "http://localhost:${WEB_PORT:-8080}/api" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo
echo "-- Verifying there is exactly one account..."
sleep 2
COUNT=$(docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-annoforge}" -d "${POSTGRES_DB:-annoforge}" \
  -tAc "SELECT count(*) FROM users;" 2>/dev/null | tr -d '[:space:]' || echo "?")
WHO=$(docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-annoforge}" -d "${POSTGRES_DB:-annoforge}" \
  -tAc "SELECT username || ' (' || role || ')' FROM users;" 2>/dev/null | tr -d '\r' || echo "?")

echo
echo "═══════════════════════════════════════════════════════════"
if [[ "$COUNT" == "1" ]]; then
  echo "  RESET COMPLETE — 1 account: $WHO"
else
  echo "  RESET ran, but found $COUNT account(s): $WHO"
  echo "  (expected exactly 1 — check 'docker compose logs backend')"
fi
echo "═══════════════════════════════════════════════════════════"
echo
echo "  Sign in at http://localhost:${WEB_PORT:-8080}"
echo "  Username: ${ADMIN_U:-admin}"
echo "  Password: the BOOTSTRAP_ADMIN_PASSWORD value in your .env"
echo
