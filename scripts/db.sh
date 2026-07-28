#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# db.sh — quick look inside the running database, no SQL to memorise.
#
#   bash scripts/db.sh users        every account
#   bash scripts/db.sh projects     projects and who each is assigned to
#   bash scripts/db.sh images       images with their on-disk paths
#   bash scripts/db.sh paths        DB path vs. the real file — does it exist?
#   bash scripts/db.sh tree         the storage folder tree on disk
#   bash scripts/db.sh activity     the 25 most recent audited actions
#   bash scripts/db.sh counts       one-line summary of every table
#   bash scripts/db.sh watch        live view, refreshes every 2s
#   bash scripts/db.sh psql         drop into an interactive psql shell
#   bash scripts/db.sh sql "..."    run any SQL you like
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

DB="${DB:-rbg-postgres}"
BACKEND="${BACKEND:-rbg-backend}"
PGUSER_="${POSTGRES_USER:-annoforge}"
PGDB_="${POSTGRES_DB:-annoforge}"

q() { docker exec "$DB" psql -U "$PGUSER_" -d "$PGDB_" -c "$1"; }
qt() { docker exec "$DB" psql -U "$PGUSER_" -d "$PGDB_" -tAc "$1"; }

docker ps --format '{{.Names}}' | grep -q "^${DB}$" || {
  echo "The '$DB' container isn't running. Start it with: docker compose up -d"
  exit 1
}

case "${1:-counts}" in

users)
  q "SELECT id, username, full_name, role, status,
            to_char(created_at,'YYYY-MM-DD HH24:MI') AS created,
            to_char(last_login_at,'YYYY-MM-DD HH24:MI') AS last_login
     FROM users ORDER BY id;"
  ;;

projects)
  q "SELECT p.id, p.name, p.task_type,
            u.username AS assigned_to,
            (SELECT count(*) FROM images i WHERE i.project_id = p.id) AS images,
            (SELECT count(*) FROM labels l WHERE l.project_id = p.id) AS labels
     FROM projects p
     LEFT JOIN users u ON u.id = p.assigned_user_id
     ORDER BY p.id;"
  ;;

images)
  q "SELECT i.id, i.project_id, i.status, i.split,
            left(i.filename, 28) AS filename,
            i.storage_path,
            i.annotations_path
     FROM images i ORDER BY i.id;"
  ;;

paths)
  echo "Checking every images.storage_path against the real filesystem…"
  echo
  MISSING=0; FOUND=0
  while IFS='|' read -r id path; do
    [[ -z "$path" ]] && continue
    if docker exec "$BACKEND" test -f "$path"; then
      SIZE=$(docker exec "$BACKEND" stat -c%s "$path" 2>/dev/null)
      printf "  ✅ image %-4s %8s bytes  %s\n" "$id" "$SIZE" "$path"
      FOUND=$((FOUND+1))
    else
      printf "  ❌ image %-4s MISSING ON DISK  %s\n" "$id" "$path"
      MISSING=$((MISSING+1))
    fi
  done < <(qt "SELECT id || '|' || coalesce(storage_path,'') FROM images ORDER BY id;")
  echo
  echo "  $FOUND present, $MISSING missing"
  echo
  echo "Annotation JSON backups (written on the first saved shape):"
  while IFS='|' read -r id path; do
    [[ -z "$path" ]] && continue
    docker exec "$BACKEND" test -f "$path" \
      && echo "  ✅ image $id  $path" \
      || echo "  ❌ image $id  MISSING  $path"
  done < <(qt "SELECT id || '|' || coalesce(annotations_path,'') FROM images
               WHERE annotations_path IS NOT NULL ORDER BY id;")
  ;;

tree)
  echo "STORAGE_DIR tree inside the backend container:"
  docker exec "$BACKEND" sh -c \
    'find /data/storage -maxdepth 6 | sort | sed "s|/data/storage|.|"'
  ;;

activity)
  q "SELECT id, username, action, project_id, image_id,
            to_char(created_at,'MM-DD HH24:MI:SS') AS at
     FROM activity_log ORDER BY id DESC LIMIT 25;"
  ;;

counts)
  q "SELECT 'users' AS table, count(*) FROM users
     UNION ALL SELECT 'projects',     count(*) FROM projects
     UNION ALL SELECT 'labels',       count(*) FROM labels
     UNION ALL SELECT 'images',       count(*) FROM images
     UNION ALL SELECT 'annotations',  count(*) FROM annotations
     UNION ALL SELECT 'versions',     count(*) FROM dataset_versions
     UNION ALL SELECT 'activity_log', count(*) FROM activity_log;"
  ;;

watch)
  # Live view. Ctrl-C to stop.
  while true; do
    clear
    echo "RBG Annotation Studio — live  ($(date '+%H:%M:%S'))   Ctrl-C to stop"
    q "SELECT id, username, role, status FROM users ORDER BY id;" 2>/dev/null
    q "SELECT p.id, p.name, u.username AS assigned_to,
              (SELECT count(*) FROM images i WHERE i.project_id=p.id) AS images
       FROM projects p LEFT JOIN users u ON u.id=p.assigned_user_id
       ORDER BY p.id;" 2>/dev/null
    q "SELECT username, action, project_id, image_id,
              to_char(created_at,'HH24:MI:SS') AS at
       FROM activity_log ORDER BY id DESC LIMIT 8;" 2>/dev/null
    sleep 2
  done
  ;;

psql)
  echo "Interactive psql. Try  \\dt  to list tables,  \\d users  to describe one,  \\q  to quit."
  docker exec -it "$DB" psql -U "$PGUSER_" -d "$PGDB_"
  ;;

sql)
  [[ -n "${2:-}" ]] || { echo "Usage: bash scripts/db.sh sql \"SELECT …\""; exit 1; }
  q "$2"
  ;;

*)
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  ;;
esac
