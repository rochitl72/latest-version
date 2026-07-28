#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# verify_api.sh — permission matrix + business-logic edge cases.
#
# Complements verify_storage.sh (which proves the on-disk layout). This one
# hammers the API with the permutations that matter:
#
#   A. Auth              — no token, bad token, deactivated account
#   B. Project access    — admin vs assigned user vs unassigned user
#   C. Upload rules      — unassigned project, bad extension, admin-only
#   D. Export rules      — empty project, non-member, assigned user allowed
#   E. Annotation rules  — ownership, approved-image freeze
#   F. Review rules      — plain user cannot set review statuses
#   G. Admin safety      — last admin, self-deactivation, duplicates
#   H. Assignment rules  — cannot assign to an admin or a deactivated user
#
# Every check asserts an exact HTTP status, so a silent behaviour change fails
# loudly instead of drifting.
#
# Usage:
#     ADMIN_PASS='demo123' bash scripts/verify_api.sh
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

API="${API:-http://localhost:8080}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"

PASS=0; FAIL=0
hdr()  { echo; echo "── $1 ──────────────────────────────────────"; }
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

[[ -n "$ADMIN_PASS" ]] || { echo "Set ADMIN_PASS. e.g. ADMIN_PASS='demo123' bash $0"; exit 1; }
command -v jq >/dev/null || { echo "needs jq:  brew install jq"; exit 1; }

login() { # username password -> token on stdout
  curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r '.access_token // empty'
}

# status <expected> <label> <curl args...>
status() {
  local want="$1" label="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [[ "$got" == "$want" ]]; then ok "$label  [$got]"
  else bad "$label  expected $want, got $got"; fi
}

STAMP=$(date +%s)
AU="apitest_assigned_$STAMP"     # the project's assigned user
OU="apitest_other_$STAMP"        # a user with no access to it
DU="apitest_dead_$STAMP"         # a user we deactivate
PW="apitest12345"

hdr "Setup"
TOK=$(login "$ADMIN_USER" "$ADMIN_PASS")
[[ -n "$TOK" ]] && ok "admin signed in" || { bad "admin login failed"; exit 1; }
A=(-H "Authorization: Bearer $TOK")
J=(-H 'Content-Type: application/json')

mkuser() { curl -s -X POST "$API/api/users" "${A[@]}" "${J[@]}" \
             -d "{\"username\":\"$1\",\"password\":\"$PW\",\"role\":\"${2:-user}\"}" | jq -r '.id // empty'; }
AU_ID=$(mkuser "$AU");  OU_ID=$(mkuser "$OU");  DU_ID=$(mkuser "$DU")
[[ -n "$AU_ID" && -n "$OU_ID" && -n "$DU_ID" ]] && ok "created 3 test users" || { bad "user creation failed"; exit 1; }

PID=$(curl -s -X POST "$API/api/projects" "${A[@]}" "${J[@]}" \
        -d "{\"name\":\"ApiTest$STAMP\"}" | jq -r '.id // empty')
[[ -n "$PID" ]] && ok "created project $PID (deliberately UNASSIGNED for now)" || { bad "project failed"; exit 1; }

IMG=/tmp/apitest_$STAMP.png
python3 -c "
import zlib,struct
def c(t,d):
    b=t+d
    return struct.pack('>I',len(d))+b+struct.pack('>I',zlib.crc32(b)&0xffffffff)
raw=b'\x00'+b'\xff\x00\x00'*8
open('$IMG','wb').write(b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',8,1,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))"
BADF=/tmp/apitest_$STAMP.txt; echo "not an image" > "$BADF"

# ── A. Authentication ────────────────────────────────────────────────
hdr "A. Authentication"
status 401 "no token is rejected"        "$API/api/projects"
status 401 "garbage token is rejected"   "$API/api/projects" -H "Authorization: Bearer not.a.real.token"
status 200 "/health is public"           "$API/health"
status 200 "valid token works"           "$API/api/projects" "${A[@]}"

curl -s -X DELETE "$API/api/users/$DU_ID" "${A[@]}" >/dev/null   # DELETE = deactivate
DTOK=$(login "$DU" "$PW")
[[ -z "$DTOK" ]] && ok "deactivated user cannot log in" || bad "deactivated user still got a token"

# ── C. Upload rules (the bug you hit) ────────────────────────────────
hdr "C. Upload rules"
status 409 "upload to an UNASSIGNED project is refused" \
  -X POST "$API/api/projects/$PID/images/upload" "${A[@]}" -F "files=@$IMG"
echo "     ↳ this is what made the Upload button do nothing before the fix"

# ── D. Export on an empty project ────────────────────────────────────
hdr "D. Export rules on an EMPTY project"
status 400 "labeled-zip refuses when nothing is annotated" \
  "$API/api/projects/$PID/export/labeled-zip" "${A[@]}"
COCO=$(curl -s "$API/api/projects/$PID/export/coco" "${A[@]}")
N=$(echo "$COCO" | jq -r '.images | length')
[[ "$N" == "0" ]] && ok "COCO returns valid-but-empty (0 images) — UI now hides this" \
                  || bad "COCO returned $N images on an empty project"

# ── H. Assignment rules ──────────────────────────────────────────────
hdr "H. Assignment rules"
ADMIN_ID=$(curl -s "$API/api/users" "${A[@]}" | jq -r ".[] | select(.username==\"$ADMIN_USER\") | .id")
status 400 "cannot assign a project to an ADMIN" \
  -X PUT "$API/api/projects/$PID/assignee" "${A[@]}" "${J[@]}" -d "{\"user_id\":$ADMIN_ID}"
status 404 "cannot assign to a DEACTIVATED user" \
  -X PUT "$API/api/projects/$PID/assignee" "${A[@]}" "${J[@]}" -d "{\"user_id\":$DU_ID}"
status 200 "can assign to an active plain user" \
  -X PUT "$API/api/projects/$PID/assignee" "${A[@]}" "${J[@]}" -d "{\"user_id\":$AU_ID}"

# now uploads should work
UP=$(curl -s -X POST "$API/api/projects/$PID/images/upload" "${A[@]}" -F "files=@$IMG")
IID=$(echo "$UP" | jq -r 'if type=="array" then .[0].id else .images[0].id end // empty')
[[ -n "$IID" ]] && ok "upload succeeds once a user is assigned (image $IID)" || bad "upload still failing: $UP"

REJ=$(curl -s -X POST "$API/api/projects/$PID/images/upload" "${A[@]}" -F "files=@$BADF" | jq -r 'length')
[[ "$REJ" == "0" ]] && ok "a .txt file is silently skipped (extension allowlist)" \
                    || bad "non-image was accepted"

# ── B. Project access matrix ─────────────────────────────────────────
hdr "B. Project access: assigned vs unassigned user"
ATOK=$(login "$AU" "$PW"); AA=(-H "Authorization: Bearer $ATOK")
OTOK=$(login "$OU" "$PW"); OA=(-H "Authorization: Bearer $OTOK")

status 200 "assigned user CAN list the project's images"   "$API/api/projects/$PID/images" "${AA[@]}"
status 403 "unassigned user CANNOT list them"              "$API/api/projects/$PID/images" "${OA[@]}"
AN=$(curl -s "$API/api/projects" "${AA[@]}" | jq -r "[.[] | select(.id==$PID)] | length")
ON=$(curl -s "$API/api/projects" "${OA[@]}" | jq -r "[.[] | select(.id==$PID)] | length")
[[ "$AN" == "1" ]] && ok "project appears in the assigned user's list"   || bad "assigned user cannot see it"
[[ "$ON" == "0" ]] && ok "project hidden from the unassigned user's list" || bad "leaked to a non-member"

status 403 "plain user cannot upload"       -X POST "$API/api/projects/$PID/images/upload" "${AA[@]}" -F "files=@$IMG"
status 403 "plain user cannot delete it"    -X DELETE "$API/api/projects/$PID" "${AA[@]}"
status 403 "plain user cannot list users"   "$API/api/users" "${AA[@]}"
status 403 "plain user cannot see dashboard" "$API/api/dashboard/overview" "${AA[@]}"
status 200 "assigned user CAN export"       "$API/api/projects/$PID/export/coco" "${AA[@]}"
status 403 "unassigned user CANNOT export"  "$API/api/projects/$PID/export/coco" "${OA[@]}"

# ── E. Annotation ownership + approved freeze ────────────────────────
hdr "E. Annotation rules"
LID=$(curl -s -X POST "$API/api/projects/$PID/labels" "${A[@]}" "${J[@]}" \
        -d '{"name":"apilabel","color":"#0f0"}' | jq -r '.id // empty')
mkann() { curl -s -X POST "$API/api/annotations" "$@" "${J[@]}" \
            -d "{\"image_id\":$IID,\"label_id\":$LID,\"type\":\"bbox\",\"geometry\":{\"x\":1,\"y\":1,\"w\":2,\"h\":2}}" \
          | jq -r '.id // empty'; }
UANN=$(mkann "${AA[@]}")          # created by the assigned user
[[ -n "$UANN" ]] && ok "assigned user can create an annotation ($UANN)" || bad "user could not annotate"
AANN=$(mkann "${A[@]}")           # created by the admin
status 403 "plain user cannot edit the ADMIN's annotation" \
  -X PATCH "$API/api/annotations/$AANN" "${AA[@]}" "${J[@]}" -d '{"geometry":{"x":9,"y":9,"w":1,"h":1}}'
status 200 "plain user CAN edit their own" \
  -X PATCH "$API/api/annotations/$UANN" "${AA[@]}" "${J[@]}" -d '{"geometry":{"x":3,"y":3,"w":2,"h":2}}'
status 200 "admin can edit anyone's" \
  -X PATCH "$API/api/annotations/$UANN" "${A[@]}" "${J[@]}" -d '{"geometry":{"x":4,"y":4,"w":2,"h":2}}'

# ── F. Review rules ──────────────────────────────────────────────────
hdr "F. Review rules"
status 403 "plain user cannot APPROVE an image" \
  -X PATCH "$API/api/images/status" "${AA[@]}" "${J[@]}" -d "{\"image_id\":$IID,\"status\":\"approved\"}"
status 200 "plain user CAN mark it in_progress" \
  -X PATCH "$API/api/images/status" "${AA[@]}" "${J[@]}" -d "{\"image_id\":$IID,\"status\":\"in_progress\"}"
status 200 "admin can approve" \
  -X PATCH "$API/api/images/status" "${A[@]}" "${J[@]}" -d "{\"image_id\":$IID,\"status\":\"approved\"}"
status 403 "an APPROVED image is frozen to the plain user" \
  -X PATCH "$API/api/annotations/$UANN" "${AA[@]}" "${J[@]}" -d '{"geometry":{"x":7,"y":7,"w":1,"h":1}}'
status 200 "…but an admin may still edit it" \
  -X PATCH "$API/api/annotations/$UANN" "${A[@]}" "${J[@]}" -d '{"geometry":{"x":8,"y":8,"w":1,"h":1}}'

# ── G. Admin safety rails ────────────────────────────────────────────
hdr "G. Admin safety rails"
status 409 "duplicate username refused" \
  -X POST "$API/api/users" "${A[@]}" "${J[@]}" -d "{\"username\":\"$AU\",\"password\":\"$PW\",\"role\":\"user\"}"
# Password policy is length-only and configurable via MIN_PASSWORD_LENGTH,
# which defaults to 1. So a 1-char password is valid and only an empty one is
# refused. If you raise MIN_PASSWORD_LENGTH, flip these two expectations.
status 200 "1-char password accepted (MIN_PASSWORD_LENGTH=1)" \
  -X POST "$API/api/users" "${A[@]}" "${J[@]}" -d "{\"username\":\"shortpw_$STAMP\",\"password\":\"a\",\"role\":\"user\"}"
status 400 "empty password still refused" \
  -X POST "$API/api/users" "${A[@]}" "${J[@]}" -d "{\"username\":\"emptypw_$STAMP\",\"password\":\"\",\"role\":\"user\"}"
status 400 "invalid role refused" \
  -X POST "$API/api/users" "${A[@]}" "${J[@]}" -d "{\"username\":\"role_$STAMP\",\"password\":\"$PW\",\"role\":\"superuser\"}"
status 400 "admin cannot deactivate THEMSELVES" \
  -X DELETE "$API/api/users/$ADMIN_ID" "${A[@]}"
NADMIN=$(curl -s "$API/api/users" "${A[@]}" | jq -r '[.[] | select(.role=="admin" and .status=="active")] | length')
if [[ "$NADMIN" == "1" ]]; then
  status 400 "the LAST admin cannot be demoted" \
    -X PATCH "$API/api/users/$ADMIN_ID" "${A[@]}" "${J[@]}" -d '{"role":"user"}'
else
  ok "skipped last-admin demotion check ($NADMIN active admins exist)"
fi

# ── Cascades ─────────────────────────────────────────────────────────
hdr "Cascades"
BEFORE=$(curl -s "$API/api/images/$IID/annotations" "${A[@]}" | jq -r 'length')
curl -s -X DELETE "$API/api/projects/$PID/labels/$LID" "${A[@]}" >/dev/null
AFTER=$(curl -s "$API/api/images/$IID/annotations" "${A[@]}" | jq -r 'length')
[[ "$BEFORE" -gt 0 && "$AFTER" == "0" ]] \
  && ok "deleting a label cascades its annotations ($BEFORE → $AFTER)" \
  || bad "label delete cascade wrong ($BEFORE → $AFTER)"

# ── Cleanup ──────────────────────────────────────────────────────────
hdr "Cleanup"
curl -s -X DELETE "$API/api/projects/$PID" "${A[@]}" >/dev/null
for id in "$AU_ID" "$OU_ID"; do curl -s -X DELETE "$API/api/users/$id" "${A[@]}" >/dev/null; done
# The password-policy checks above create an extra account; deactivate it too.
SHORT_ID=$(curl -s "$API/api/users" "${A[@]}" | jq -r ".[] | select(.username==\"shortpw_$STAMP\") | .id")
[[ -n "$SHORT_ID" ]] && curl -s -X DELETE "$API/api/users/$SHORT_ID" "${A[@]}" >/dev/null
rm -f "$IMG" "$BADF"
echo "  test project deleted; test users deactivated"

echo
echo "═════════════════════════════════════════"
echo "  PASSED: $PASS    FAILED: $FAIL"
echo "═════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] || exit 1
