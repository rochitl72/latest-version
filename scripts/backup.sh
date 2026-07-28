#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# RBG Annotation Studio — backup
#
# Backs up BOTH halves of the system:
#   1. PostgreSQL  — users, projects, annotations, audit log, versions
#   2. Image files — the uploaded originals on the storage volume
#
# Losing either one loses real work, so both are captured every run.
#
# Usage:
#   bash scripts/backup.sh
#
# Schedule it nightly with cron (run `crontab -e` and add):
#   15 2 * * *  /path/to/annoforge/scripts/backup.sh >> /var/log/rbg-backup.log 2>&1
#
# Configure via environment (or the backend/.env values):
#   POSTGRES_USER  POSTGRES_PASSWORD  POSTGRES_HOST  POSTGRES_PORT  POSTGRES_DB
#   STORAGE_PATH   where uploaded images live   (default: ./data/storage for
#                  the Docker setup, backend/storage when run from source)
#   BACKUP_DIR     where backups are written    (default: ./backups)
#   RETENTION_DAYS how many days to keep        (default: 14)
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"

# ─── Load backend/.env if present, so we share one config ────────────
if [[ -f "$BACKEND/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BACKEND/.env"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-annoforge}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-annoforge}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-annoforge}"
# Where the uploaded images actually are. The two supported setups put them in
# different places, so pick whichever exists rather than guessing:
#   Docker  -> ./data/storage      (bind-mounted, set by STORAGE_PATH)
#   native  -> backend/storage     (the app's default when run from source)
# An explicit STORAGE_DIR or STORAGE_PATH always wins.
if [[ -n "${STORAGE_DIR:-}" ]]; then
  :
elif [[ -n "${STORAGE_PATH:-}" ]]; then
  STORAGE_DIR="$STORAGE_PATH"
elif [[ -d "$ROOT/data/storage" ]]; then
  STORAGE_DIR="$ROOT/data/storage"
else
  STORAGE_DIR="$BACKEND/storage"
fi
# Resolve a relative STORAGE_PATH (e.g. "./data/storage") against the repo root.
[[ "$STORAGE_DIR" = /* ]] || STORAGE_DIR="$ROOT/${STORAGE_DIR#./}"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

STAMP="$(date +%Y%m%d_%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

echo "[$(date)] Backup starting → $DEST"

# ─── 1. Database ─────────────────────────────────────────────────────
if ! command -v pg_dump >/dev/null; then
  echo "  ERROR: pg_dump not found. Install the postgresql-client package."
  exit 1
fi

echo "  Dumping database '$POSTGRES_DB' ..."
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" \
  --username="$POSTGRES_USER" --format=custom \
  --file="$DEST/db.dump" "$POSTGRES_DB"
echo "  Database dump: $(du -h "$DEST/db.dump" | cut -f1)"

# ─── 2. Image files ──────────────────────────────────────────────────
if [[ -d "$STORAGE_DIR" ]]; then
  echo "  Archiving image storage ($STORAGE_DIR) ..."
  tar -czf "$DEST/storage.tar.gz" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
  echo "  Storage archive: $(du -h "$DEST/storage.tar.gz" | cut -f1)"
else
  echo "  WARNING: STORAGE_DIR '$STORAGE_DIR' does not exist — skipping image backup."
fi

# ─── 3. Prune old backups ────────────────────────────────────────────
echo "  Pruning backups older than $RETENTION_DAYS days ..."
find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mtime +"$RETENTION_DAYS" \
  -exec rm -rf {} + 2>/dev/null || true

echo "[$(date)] Backup complete."
echo ""
echo "Restore the database with:"
echo "  PGPASSWORD=... pg_restore --clean --if-exists -h HOST -U USER -d $POSTGRES_DB $DEST/db.dump"
echo "Restore images by extracting storage.tar.gz over the storage volume."
