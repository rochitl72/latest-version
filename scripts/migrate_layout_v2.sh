#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# RBG Annotation Studio — one-time storage layout migration
#
# Moves every user's files from the old flat layout into the new
# role-split layout (admin/ vs users/, with separate project/ and
# annotation/ subfolders per your storage design), and regenerates
# overlays + COCO/YOLO exports for already-annotated images.
#
# ALWAYS backs up the database and storage folder first — this script
# refuses to proceed if either backup step fails.
#
# Usage:
#   bash scripts/migrate_layout_v2.sh            # Docker deployment
#   MODE=local bash scripts/migrate_layout_v2.sh  # native (no Docker) setup
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
MODE="${MODE:-docker}"

echo "== RBG storage layout migration =="
echo "Mode: $MODE"
echo

# ─── 1. Backups (reuses the existing, already-tested backup.sh) ──────
echo "-- Step 1/2: backing up database + storage folder..."
bash "$ROOT/scripts/backup.sh"
echo

read -r -p "Backup complete. Proceed with the migration? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted. Nothing was changed."
  exit 0
fi

# ─── 2. Run the migration inside the backend's Python environment ────
echo "-- Step 2/2: migrating file layout + rewriting affected paths in Postgres..."
if [[ "$MODE" == "docker" ]]; then
  docker compose -f "$ROOT/docker-compose.yml" cp \
    "$BACKEND/scripts/migrate_layout_v2.py" rbg-backend:/app/scripts/migrate_layout_v2.py
  docker compose -f "$ROOT/docker-compose.yml" exec -T backend \
    python scripts/migrate_layout_v2.py
else
  cd "$BACKEND"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  python scripts/migrate_layout_v2.py
fi

echo
echo "Migration complete. Open the admin System panel to confirm the new"
echo "admin/ and users/ folders look right, then spot-check a project."
