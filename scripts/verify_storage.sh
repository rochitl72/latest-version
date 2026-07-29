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

# Both test accounts are plain users, so they live under the users/ bucket.
# (An admin account would be under admin/ instead — that split is checked in
# step 9 below, by promoting one of them.)
U1_DIR="$STORAGE/users/${U1_ID}_${U1}"
U2_DIR="$STORAGE/users/${U2_ID}_${U2}"
inb "test -d '$U1_DIR/project'"    && ok "folder exists: users/${U1_ID}_${U1}/project" \
                                   || bad "MISSING folder $U1_DIR/project"
inb "test -d '$U1_DIR/annotation'" && ok "folder exists: users/${U1_ID}_${U1}/annotation" \
                                   || bad "MISSING folder $U1_DIR/annotation"
inb "test -d '$U2_DIR/project'"    && ok "folder exists: users/${U2_ID}_${U2}/project" \
                                   || bad "MISSING folder $U2_DIR/project"

# ── 2. project assignment → project dirs ─────────────────────────────
hdr "2. Assigning a project creates its folders under that user"
PROJ=$(curl -s -X POST "$API/api/projects" "${AUTH[@]}" -H 'Content-Type: application/json' \
       -d "{\"name\":\"VerifyProj$STAMP\",\"description\":\"storage check\"}")
PID=$(echo "$PROJ" | jq -r '.id // empty')
PNAME=$(echo "$PROJ" | jq -r '.name')
[[ -n "$PID" ]] && ok "created project id=$PID name=$PNAME" || { bad "project create failed"; exit 1; }

curl -s -X PUT "$API/api/projects/$PID/assignee" "${AUTH[@]}" -H 'Content-Type: application/json' \
     -d "{\"user_id\":$U1_ID}" >/dev/null
P1_DIR="$U1_DIR/project/${PID}_VerifyProj$STAMP"
A1_DIR="$U1_DIR/annotation/${PID}_VerifyProj$STAMP"
inb "test -d '$P1_DIR/images'" && ok "project/{proj}/images created under the assignee" \
                               || bad "MISSING $P1_DIR/images"
for sub in json overlays coco yolo logs; do
  inb "test -d '$A1_DIR/$sub'" && ok "annotation/{proj}/$sub created" \
                               || bad "MISSING $A1_DIR/$sub"
done

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
# The endpoint returns a bare JSON array of the saved images. Handle an object
# wrapper too, so this keeps working if the response shape is ever changed.
IMG_ID=$(echo "$UP" | jq -r '
  if   type == "array"    then .[0].id
  elif has("images")      then .images[0].id
  else .id end // empty' 2>/dev/null)
[[ -n "$IMG_ID" ]] && ok "uploaded image id=$IMG_ID" || { bad "upload failed: $UP"; exit 1; }

DB_PATH=$(sql "SELECT storage_path FROM images WHERE id=$IMG_ID;")
info "images.storage_path = $DB_PATH"
case "$DB_PATH" in
  "$P1_DIR"/images/*) ok "path is under the assignee's project folder" ;;
  *) bad "path is NOT under $P1_DIR/images" ;;
esac
inb "test -f '$DB_PATH'" && ok "the file really exists at that path" || bad "no file at $DB_PATH"
# Images now sit DIRECTLY in images/ — no {xx} shard subdirectory.
echo "$DB_PATH" | grep -qE '/images/[0-9a-f]{32}\.' \
  && ok "stored flat as images/{uuid}.ext" || bad "not in the flat images/{uuid} layout"

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
  "$A1_DIR"/json/*) ok "JSON sits under annotation/{proj}/json/" ;;
  *) bad "JSON is NOT under $A1_DIR/json" ;;
esac
inb "cat '$ANN_PATH'" | jq -e ".annotations[0].id == $ANN_ID" >/dev/null \
  && ok "JSON content matches the Postgres row" || bad "JSON does not contain annotation $ANN_ID"

# The other artifacts written on every annotation save.
inb "ls '$A1_DIR/overlays' | grep -q ." \
  && ok "overlay PNG was rendered into annotation/{proj}/overlays/" \
  || bad "no overlay image in $A1_DIR/overlays"
inb "test -f '$A1_DIR/coco/annotations_coco.json'" \
  && ok "live COCO export written" || bad "MISSING $A1_DIR/coco/annotations_coco.json"
inb "ls '$A1_DIR/yolo/labels' | grep -q ." \
  && ok "live YOLO labels written" || bad "no YOLO labels in $A1_DIR/yolo/labels"
inb "test -f '$A1_DIR/logs/activity.log'" \
  && ok "project-scoped log written" || bad "MISSING $A1_DIR/logs/activity.log"

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
P2_DIR="$U2_DIR/project/${PID}_VerifyProj$STAMP"
A2_DIR="$U2_DIR/annotation/${PID}_VerifyProj$STAMP"

inb "test -d '$P2_DIR/images'" && ok "project folder now exists under the NEW owner" \
                               || bad "MISSING $P2_DIR/images"
inb "test -d '$A2_DIR'" && ok "annotation folder moved to the NEW owner too" \
                        || bad "MISSING $A2_DIR"
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
  "$A2_DIR"/*) ok "annotations_path was rewritten too" ;;
  *) bad "annotations_path still points at the old owner: $NEW_ANN" ;;
esac

# ── 8b. role change → the whole user folder moves between buckets ────
hdr "8b. Promoting a user MOVES their folder from users/ to admin/"
curl -s -X PATCH "$API/api/users/$U2_ID" "${AUTH[@]}" -H 'Content-Type: application/json' \
     -d '{"role":"admin"}' >/dev/null
ADM_DIR="$STORAGE/admin/${U2_ID}_${U2}"
inb "test -d '$ADM_DIR'" && ok "folder moved to admin/${U2_ID}_${U2}" \
                         || bad "MISSING $ADM_DIR after promotion"
inb "test -d '$U2_DIR'" && bad "old users/ folder still exists after promotion" \
                        || ok "old users/ folder is gone"
PROMO_PATH=$(sql "SELECT storage_path FROM images WHERE id=$IMG_ID;")
case "$PROMO_PATH" in
  "$ADM_DIR"/*) ok "Postgres paths were rewritten to admin/" ;;
  *) bad "Postgres still points at users/: $PROMO_PATH" ;;
esac
inb "test -f '$PROMO_PATH'" && ok "the file exists at the admin/ path" \
                            || bad "no file at $PROMO_PATH"
# Put them back so the cleanup below behaves predictably.
curl -s -X PATCH "$API/api/users/$U2_ID" "${AUTH[@]}" -H 'Content-Type: application/json' \
     -d '{"role":"user"}' >/dev/null

# ── 8c. deleting a user orphans their projects, keeps the data ───────
hdr "8c. Deleting a user moves their projects to orphan_projects/"
DEL=$(curl -s -X DELETE "$API/api/users/$U2_ID/permanent" "${AUTH[@]}")
info "delete response: $DEL"
ORPH="$STORAGE/orphan_projects/${U2_ID}_${U2}"
inb "test -d '$ORPH'" && ok "files preserved at orphan_projects/${U2_ID}_${U2}" \
                      || bad "MISSING $ORPH — deleted user's data was lost"
GONE=$(sql "SELECT count(*) FROM users WHERE id=$U2_ID;")
[[ "$GONE" == "0" ]] && ok "user row is gone from Postgres" \
                     || bad "user row still present (count=$GONE)"
ASSIGNEE=$(sql "SELECT coalesce(assigned_user_id::text,'NULL') FROM projects WHERE id=$PID;")
[[ "$ASSIGNEE" == "NULL" ]] && ok "their project survived and is now unassigned" \
                            || bad "project assignee is '$ASSIGNEE', expected NULL"
ORPH_PATH=$(sql "SELECT storage_path FROM images WHERE id=$IMG_ID;")
case "$ORPH_PATH" in
  "$ORPH"/*) ok "image paths were rewritten into orphan storage" ;;
  *) bad "image path was not rewritten: $ORPH_PATH" ;;
esac
inb "test -f '$ORPH_PATH'" && ok "the image file still exists in orphan storage" \
                           || bad "no file at $ORPH_PATH"

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
# U2 was already permanently deleted in step 8c. Remove the rest, and use the
# permanent endpoint so this script does not leave test accounts behind (the
# earlier deactivate-only cleanup was why vtest_* rows accumulated).
hdr "Cleanup"
curl -s -X DELETE "$API/api/projects/$PID" "${AUTH[@]}" >/dev/null && info "deleted test project $PID"
curl -s -X DELETE "$API/api/users/$U1_ID/permanent" "${AUTH[@]}" >/dev/null
info "removed test user $U1"
rm -f "$TMPIMG"
echo
info "NOTE: deleted users' files are preserved under orphan_projects/ —"
info "removing an account must never destroy someone's work."
inb "ls -d '$STORAGE/orphan_projects'/* 2>/dev/null" | sed 's/^/       /'

echo
echo "═════════════════════════════════════════════════════════"
echo "  PASSED: $PASS    FAILED: $FAIL"
echo "═════════════════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] || exit 1
