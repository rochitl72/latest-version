#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# verify_storage.sh — prove the per-user storage contract actually holds.
#
# Drives the real HTTP API end to end, then inspects both the disk and
# PostgreSQL to confirm each rule:
#
#   1. Creating a user creates their folder immediately
#   2. Assigning a project creates images/ and annotations/ under THAT user
#   3. An uploaded image lands under the assigned user's project folder
#   4. images.storage_path in Postgres points at that exact file
#   5. An annotation is written to Postgres AND mirrored to annotations/{id}.json
#   6. images.annotations_path points at that exact file
#   7. Actions are mirrored to the acting user's activity.log
#   8. Reassigning a project MOVES the files and rewrites the DB paths
#   9. Postgres stores paths only — no image bytes in any column
#
# Usage (against the docker compose stack):
#     bash scripts/verify_storage.sh
#
# Override if your setup differs:
#     API=http://localhost:8080 ADMIN_USER=admin ADMIN_PASS=... \
#     BACKEND=rbg-backend DB=rbg-postgres bash scripts/verify_storage.sh
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

API="${API:-http://localhost:8080}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"
BACKEND="${BACKEND:-rbg-backend}"      # backend container name
DB="${DB:-rbg-postgres}"               # postgres container name
PGUSER_="${POSTGRES_USER:-annoforge}"
PGDB_="${POSTGRES_DB:-annoforge}"
STORAGE="${STORAGE:-/data/storage}"    # STORAGE_DIR inside the backend container

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info() { echo "     $1"; }
hdr()  { echo; echo "── $1 ─────────────────────────────────────────"; }

# Run a command inside the backend container (where STORAGE_DIR lives).
inb() { docker exec "$BACKEND" sh -c "$1" 2>/dev/null; }
# Run SQL, return a bare value.
sql() { docker exec "$DB" psql -U "$PGUSER_" -d "$PGDB_" -tAc "$1" 2>/dev/null; }

if [[ -z "$ADMIN_PASS" ]]; then
  echo "Set ADMIN_PASS to your BOOTSTRAP_ADMIN_PASSWORD from .env:"
  echo "    ADMIN_PASS='yourpassword' bash scripts/verify_storage.sh"
  exit 1
fi

command -v jq >/dev/null || { echo "This script needs jq:  brew install jq"; exit 1; }

hdr "0. Preflight"
docker ps --format '{{.Names}}' | grep -q "^${BACKEND}$" \
  && ok "backend container '$BACKEND' is running" \
  || { bad "backend container '$BACKEND' not running"; exit 1; }
docker ps --format '{{.Names}}' | grep -q "^${DB}$" \
  && ok "database container '$DB' is running" \
  || { bad "database container '$DB' not running"; exit 1; }

TOKEN=$(curl -s -X POST "$API/api/auth/login" \
          -H 'Content-Type: application/json' \
          -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
        | jq -r '.access_token // empty')
[[ -n "$TOKEN" ]] && ok "signed in as '$ADMIN_USER'" \
                  || { bad "login failed — check ADMIN_PASS and $API"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")

STAMP=$(date +%s)
U1="vtest_a_$STAMP"
U2="vtest_b_$STAMP"

# ── 1. user creation → folder ────────────────────────────────────────
hdr "1. Creating a user creates their folder"
U1_ID=$(curl -s -X POST "$API/api/users" "${AUTH[@]}" -H 'Content-Type: application/json' \
        -d "{\"username\":\"$U1\",\"password\":\"verify12345\",\"role\":\"user\"}" | jq -r '.id // empty')
U2_ID=$(curl -s -X POST "$API/api/users" "${AUTH[@]}" -H 'Content-Type: application/json' \
        -d "{\"username\":\"$U2\",\"password\":\"verify12345\",\"role\":\"user\"}" | jq -r '.id // empty')
[[ -n "$U1_ID" && -n "$U2_ID" ]] && ok "created users $U1 (id=$U1_ID) and $U2 (id=$U2_ID)" \
                                 || { bad "could not create users"; exit 1; }

U1_DIR="$STORAGE/users/${U1_ID}_${U1}"
U2_DIR="$STORAGE/users/${U2_ID}_${U2}"
inb "test -d '$U1_DIR/projects'" && ok "folder exists: users/${U1_ID}_${U1}/projects" \
                                 || bad "MISSING folder $U1_DIR/projects"
inb "test -d '$U2_DIR/projects'" && ok "folder exists: users/${U2_ID}_${U2}/projects" \
                                 || bad "MISSING folder $U2_DIR/projects"

# ── 2. project assignment → project dirs ─────────────────────────────
hdr "2. Assigning a project creates its folders under that user"
PROJ=$(curl -s -X POST "$API/api/projects" "${AUTH[@]}" -H 'Content-Type: application/json' \
       -d "{\"name\":\"VerifyProj$STAMP\",\"description\":\"storage check\"}")
PID=$(echo "$PROJ" | jq -r '.id // empty')
PNAME=$(echo "$PROJ" | jq -r '.name')
[[ -n "$PID" ]] && ok "created project id=$PID name=$PNAME" || { bad "project create failed"; exit 1; }

curl -s -X PUT "$API/api/projects/$PID/assignee" "${AUTH[@]}" -H 'Content-Type: application/json' \
     -d "{\"user_id\":$U1_ID}" >/dev/null
P1_DIR="$U1_DIR/projects/${PID}_VerifyProj$STAMP"
inb "test -d '$P1_DIR/images'"      && ok "images/ created under the assignee"      || bad "MISSING $P1_DIR/images"
inb "test -d '$P1_DIR/annotations'" && ok "annotations/ created under the assignee" || bad "MISSING $P1_DIR/annotations"

# ── 3+4. upload → file on disk, path in Postgres ─────────────────────
hdr "3+4. Uploaded image lands under the assignee; Postgres stores the path"
TMPIMG="/tmp/verify_$STAMP.png"
python3 -c "
import zlib,struct
def chunk(t,d):
    c=t+d
    return struct.pack('>I',len(d))+c+struct.pack('>I',zlib.crc32(c)&0xffffffff)
raw=b'\x00'+b'\xff\x00\x00'*8
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
open('$TMPIMG','wb').write(png)"
UP=$(curl -s -X POST "$API/api/projects/$PID/images/upload" "${AUTH[@]}" -F "files=@$TMPIMG")
IMG_ID=$(echo "$UP" | jq -r '(.images // .)[0].id // empty')
[[ -n "$IMG_ID" ]] && ok "uploaded image id=$IMG_ID" || { bad "upload failed: $UP"; exit 1; }

DB_PATH=$(sql "SELECT storage_path FROM images WHERE id=$IMG_ID;")
info "images.storage_path = $DB_PATH"
case "$DB_PATH" in
  "$P1_DIR"/images/*) ok "path is under the assignee's project folder" ;;
  *) bad "path is NOT under $P1_DIR/images" ;;
esac
inb "test -f '$DB_PATH'" && ok "the file really exists at that path" || bad "no file at $DB_PATH"
echo "$DB_PATH" | grep -qE '/images/[0-9a-f]{2}/[0-9a-f]{32}\.' \
  && ok "sharded as images/{xx}/{uuid}.ext" || bad "not in the sharded {xx}/{uuid} layout"

# ── 5+6. annotation → Postgres AND json mirror ───────────────────────
hdr "5+6. Annotation goes to Postgres AND is mirrored to annotations/{id}.json"
LBL=$(curl -s -X POST "$API/api/projects/$PID/labels" "${AUTH[@]}" -H 'Content-Type: application/json' \
      -d '{"name":"verifylabel","color":"#ff0000"}' | jq -r '.id // empty')
ANN=$(curl -s -X POST "$API/api/annotations" "${AUTH[@]}" -H 'Content-Type: application/json' \
      -d "{\"image_id\":$IMG_ID,\"label_id\":$LBL,\"type\":\"bbox\",\"geometry\":{\"x\":1,\"y\":2,\"w\":3,\"h\":4}}")
ANN_ID=$(echo "$ANN" | jq -r '.id // empty')
[[ -n "$ANN_ID" ]] && ok "created annotation id=$ANN_ID" || bad "annotation create failed: $ANN"

DBCOUNT=$(sql "SELECT count(*) FROM annotations WHERE image_id=$IMG_ID;")
[[ "$DBCOUNT" == "1" ]] && ok "annotation row IS in Postgres (fast retrieval path)" \
                        || bad "expected 1 annotation row in Postgres, got '$DBCOUNT'"

ANN_PATH=$(sql "SELECT annotations_path FROM images WHERE id=$IMG_ID;")
info "images.annotations_path = $ANN_PATH"
[[ -n "$ANN_PATH" ]] && ok "annotations_path is set" || bad "annotations_path is NULL"
inb "test -f '$ANN_PATH'" && ok "the JSON backup exists on disk" || bad "no JSON backup at $ANN_PATH"
case "$ANN_PATH" in
  "$P1_DIR"/annotations/*) ok "JSON sits under the assignee's annotations/ folder" ;;
  *) bad "JSON is NOT under $P1_DIR/annotations" ;;
esac
inb "cat '$ANN_PATH'" | jq -e ".annotations[0].id == $ANN_ID" >/dev/null \
  && ok "JSON content matches the Postgres row" || bad "JSON does not contain annotation $ANN_ID"

# ── 7. activity.log ──────────────────────────────────────────────────
hdr "7. Actions are mirrored to the acting user's activity.log"
ADMIN_ID=$(sql "SELECT id FROM users WHERE username='$ADMIN_USER';")
ADMIN_LOG="$STORAGE/users/${ADMIN_ID}_${ADMIN_USER}/activity.log"
inb "test -f '$ADMIN_LOG'" && ok "activity.log exists for the acting user" \
                           || bad "no activity.log at $ADMIN_LOG"
inb "grep -q 'annotation.create' '$ADMIN_LOG'" && ok "it recorded annotation.create" \
                                               || bad "annotation.create not found in the log"
info "last 3 lines:"
inb "tail -3 '$ADMIN_LOG'" | sed 's/^/       /'

# ── 8. reassign → files move, DB paths rewritten ─────────────────────
hdr "8. Reassigning the project MOVES the files and rewrites the DB paths"
curl -s -X PUT "$API/api/projects/$PID/assignee" "${AUTH[@]}" -H 'Content-Type: application/json' \
     -d "{\"user_id\":$U2_ID}" >/dev/null
P2_DIR="$U2_DIR/projects/${PID}_VerifyProj$STAMP"

inb "test -d '$P2_DIR/images'" && ok "folder now exists under the NEW owner" \
                               || bad "MISSING $P2_DIR/images"
inb "test -d '$P1_DIR'" && bad "old owner's project folder still exists (should have moved)" \
                        || ok "old owner's project folder is gone"

NEW_PATH=$(sql "SELECT storage_path FROM images WHERE id=$IMG_ID;")
info "images.storage_path is now = $NEW_PATH"
case "$NEW_PATH" in
  "$P2_DIR"/*) ok "Postgres path was rewritten to the new owner" ;;
  *) bad "Postgres still points at the OLD path — DB and disk are now inconsistent" ;;
esac
inb "test -f '$NEW_PATH'" && ok "the file exists at the new path" || bad "no file at $NEW_PATH"

NEW_ANN=$(sql "SELECT annotations_path FROM images WHERE id=$IMG_ID;")
case "$NEW_ANN" in
  "$P2_DIR"/*) ok "annotations_path was rewritten too" ;;
  *) bad "annotations_path still points at the old owner: $NEW_ANN" ;;
esac

# ── 9. Postgres holds paths, not bytes ───────────────────────────────
hdr "9. Postgres stores paths only — never image bytes"
BYTEA=$(sql "SELECT count(*) FROM information_schema.columns
             WHERE table_name IN ('images','annotations')
               AND data_type IN ('bytea','blob');")
[[ "$BYTEA" == "0" ]] && ok "no bytea/blob columns on images or annotations" \
                      || bad "found $BYTEA binary column(s) — bytes may be in the DB"
GEOM=$(sql "SELECT data_type FROM information_schema.columns
            WHERE table_name='annotations' AND column_name='geometry';")
info "annotations.geometry is '$GEOM' (jsonb = indexable, correct)"

# ── cleanup ──────────────────────────────────────────────────────────
hdr "Cleanup"
curl -s -X DELETE "$API/api/projects/$PID" "${AUTH[@]}" >/dev/null && info "deleted test project $PID"
curl -s -X DELETE "$API/api/users/$U1_ID" "${AUTH[@]}" >/dev/null
curl -s -X DELETE "$API/api/users/$U2_ID" "${AUTH[@]}" >/dev/null
info "deactivated test users (accounts are never hard-deleted by design)"
rm -f "$TMPIMG"
echo
info "NOTE: the test users' folders are intentionally left on disk —"
info "deactivation must never destroy someone's work."
inb "ls -d '$U1_DIR' '$U2_DIR'" | sed 's/^/       /'

echo
echo "═════════════════════════════════════════════════════════"
echo "  PASSED: $PASS    FAILED: $FAIL"
echo "═════════════════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] || exit 1
