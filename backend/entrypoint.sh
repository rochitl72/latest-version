#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Backend container entrypoint.
#
# Runs Alembic migrations, then starts the API. Doing it here (rather than
# relying on the app's create_all fallback) means the migration chain is the
# single source of truth for the schema and is exercised on every deploy — so
# it can't silently rot while the fallback quietly papers over the difference.
#
# `alembic upgrade head` is idempotent: on an already-current database it is a
# no-op, so restarts are safe.
# ─────────────────────────────────────────────────────────────────────
set -e

echo "[entrypoint] Waiting for the database ..."
# Compose already gates us on pg_isready, but a managed/external database may
# still be a moment behind. Retry briefly rather than crash-looping.
ATTEMPTS=0
until python -c "
import asyncio, sys
from sqlalchemy.ext.asyncio import create_async_engine
from app.core.config import settings

async def check():
    engine = create_async_engine(settings.DATABASE_URL)
    try:
        async with engine.connect():
            pass
    finally:
        await engine.dispose()

try:
    asyncio.run(check())
except Exception as exc:
    print(exc, file=sys.stderr)
    sys.exit(1)
" 2>/dev/null; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 30 ]; then
    echo "[entrypoint] Database unreachable after 30 attempts. Giving up." >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] Database is reachable."

echo "[entrypoint] Applying migrations (alembic upgrade head) ..."
alembic upgrade head
echo "[entrypoint] Migrations applied."

echo "[entrypoint] Starting API ..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
