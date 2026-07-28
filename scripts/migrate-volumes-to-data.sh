#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# migrate-volumes-to-data.sh — one-off move of existing uploads out of the
# old Docker named volumes and into the ./data/ bind-mounted folders.
#
# Run this ONCE, if you used the stack before images and exports became bind
# mounts. Without it the app starts with an empty ./data/ and your previously
# uploaded images look like they vanished — they are still safe in the old
# volumes, just no longer mounted.
#
#   bash scripts/migrate-volumes-to-data.sh
#
# Copies, never moves: the old volumes are left untouched so you can re-run
# this or fall back. Delete them yourself once you are satisfied.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PROJECT="$(basename "$ROOT")"

say() { echo; echo "── $1 ──────────────────────────────────────"; }

say "1. Looking for the old named volumes"
FOUND=0
for name in storage exports; do
  VOL="${PROJECT}_${name}"
  if docker volume inspect "$VOL" >/dev/null 2>&1; then
    echo "   found: $VOL"
    FOUND=1
  else
    echo "   absent: $VOL (nothing to migrate)"
  fi
done
if [[ "$FOUND" == "0" ]]; then
  echo
  echo "No old volumes exist — nothing to do. You are already on ./data/."
  exit 0
fi

say "2. Stopping the stack so nothing writes mid-copy"
docker compose down

say "3. Copying volume contents into ./data/"
mkdir -p data/storage data/exports
for name in storage exports; do
  VOL="${PROJECT}_${name}"
  docker volume inspect "$VOL" >/dev/null 2>&1 || continue
  echo "   $VOL  ->  ./data/$name"
  # A throwaway alpine container mounts both the old volume and the new host
  # folder, then copies across. `.` inside /from copies hidden entries too.
  docker run --rm \
    -v "${VOL}:/from:ro" \
    -v "$ROOT/data/$name:/to" \
    alpine sh -c 'cd /from && cp -a . /to/ 2>/dev/null || true'
done

say "4. What landed in ./data/"
find data -maxdepth 5 | sort | head -40
echo
echo "   files: $(find data -type f | wc -l | tr -d ' ')"
echo "   size : $(du -sh data | cut -f1)"

say "5. Restarting"
docker compose up -d

cat <<DONE

═══════════════════════════════════════════════════════════════════
 Done. Verify the app still sees every image:

     bash scripts/db.sh paths

 Every row should say ✅. If so, the old volumes are redundant and you
 can reclaim the space:

     docker volume rm ${PROJECT}_storage ${PROJECT}_exports

 Leave them until you have checked — this script only copied.
═══════════════════════════════════════════════════════════════════
DONE
