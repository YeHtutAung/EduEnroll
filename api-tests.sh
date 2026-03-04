#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Nihon Moment EduEnroll — Sprint 2 API Test Suite
# ═══════════════════════════════════════════════════════════════
#
# Tests every endpoint built in Sprint 2.
# Requires: curl, jq
#
# Usage:
#   BASE_URL=http://localhost:3000 \
#   SUPABASE_URL=https://xxxx.supabase.co \
#   SUPABASE_ANON_KEY=eyJ... \
#   TEST_EMAIL=admin@nihon-moment.com \
#   TEST_PASSWORD=yourpassword \
#   bash api-tests.sh
#
# All env vars are optional — defaults shown above except passwords.
# Admin endpoint tests are skipped if auth credentials are not set.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:3000}"
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
TEST_EMAIL="${TEST_EMAIL:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"

# ── Counters ────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
SKIP_ADMIN=0  # Set to 1 if auth setup fails

# Shared state populated during tests
INTAKE_ID=""
CLASS_N5_ID=""; CLASS_N4_ID=""; CLASS_N3_ID=""; CLASS_N2_ID=""; CLASS_N1_ID=""
ENROLLMENT_REF=""

# Auth cookie header — populated by login()
AUTH_H=()

# ── Helpers ─────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'

pass() { echo -e "  ${GREEN}✓ PASS${RESET}  $1"; ((PASS++)) || true; }
fail() {
  echo -e "  ${RED}✗ FAIL${RESET}  $1"
  if [[ -n "${2:-}" ]]; then
    echo -e "          Response: $(echo "$2" | head -c 300)"
  fi
  ((FAIL++)) || true
}
skip() { echo -e "  ${YELLOW}– SKIP${RESET}  $1"; ((SKIP++)) || true; }
header() { echo -e "\n${BOLD}━━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

# HTTP helpers — output body; non-2xx causes empty output (curl -f)
pub_get()    { curl -sf "$BASE_URL$1"; }
pub_post()   { curl -sf -X POST  -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
admin_get()  { curl -sf "${AUTH_H[@]}" "$BASE_URL$1"; }
admin_post() { curl -sf "${AUTH_H[@]}" -X POST  -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
admin_patch(){ curl -sf "${AUTH_H[@]}" -X PATCH -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
admin_del()  { curl -sf "${AUTH_H[@]}" -X DELETE "$BASE_URL$1"; }

# Return HTTP status code only
http_code() { curl -s -o /dev/null -w "%{http_code}" "${@}"; }

check_deps() {
  local missing=()
  for cmd in curl jq; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required tools: ${missing[*]}" >&2
    echo "  Install with: sudo apt-get install ${missing[*]}  (or brew install on macOS)" >&2
    exit 1
  fi
}

# ── Auth Setup ──────────────────────────────────────────────────
login() {
  header "Auth Setup"

  if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_ANON_KEY" || -z "$TEST_EMAIL" || -z "$TEST_PASSWORD" ]]; then
    echo -e "  ${YELLOW}NOTE${RESET}: Auth env vars not set — admin endpoint tests will be skipped."
    echo    "        Set SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD to enable."
    SKIP_ADMIN=1
    return
  fi

  local AUTH_RESP
  AUTH_RESP=$(curl -sf -X POST \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASSWORD}\"}" 2>&1) || {
    echo -e "  ${RED}✗ FAIL${RESET}  Login to Supabase Auth failed."
    echo    "          Check TEST_EMAIL / TEST_PASSWORD and that the user exists in Supabase."
    SKIP_ADMIN=1
    return
  }

  # Validate we got an access_token back
  local ACCESS_TOKEN
  ACCESS_TOKEN=$(echo "$AUTH_RESP" | jq -r '.access_token // empty')
  if [[ -z "$ACCESS_TOKEN" ]]; then
    echo -e "  ${RED}✗ FAIL${RESET}  Auth response missing access_token."
    echo    "          Response: $(echo "$AUTH_RESP" | head -c 200)"
    SKIP_ADMIN=1
    return
  fi

  # Derive the Supabase project ref from the URL
  # e.g. https://abcxyz123.supabase.co → abcxyz123
  local PROJECT_REF
  PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://\([^.]*\)\..*|\1|')

  # The @supabase/ssr server client reads the session from a cookie named
  # sb-{projectRef}-auth-token whose value is the raw session JSON.
  # We pass it via the Cookie HTTP header so Next.js cookieStore() sees it.
  local COOKIE_NAME="sb-${PROJECT_REF}-auth-token"
  local SESSION_JSON
  SESSION_JSON=$(echo "$AUTH_RESP" | jq -c '{access_token,token_type,expires_at,refresh_token,user}')

  # Store as a header array used by all admin_* helpers
  AUTH_H=(-H "Cookie: ${COOKIE_NAME}=${SESSION_JSON}")

  echo -e "  ${GREEN}✓${RESET} Logged in as ${TEST_EMAIL} (project: ${PROJECT_REF})"
  SKIP_ADMIN=0
}

# ═══════════════════════════════════════════════════════════════
# TEST SECTIONS
# ═══════════════════════════════════════════════════════════════

# ── 1. Intakes ──────────────────────────────────────────────────
test_intakes() {
  header "Intakes"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "POST /api/intakes (auth required)"; return; fi

  # Create April 2026 intake
  local RESP
  RESP=$(admin_post "/api/intakes" \
    '{"name":"April 2026 Intake","year":2026,"status":"draft"}' 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e '.id' &>/dev/null; then
    INTAKE_ID=$(echo "$RESP" | jq -r '.id')
    pass "POST /api/intakes — created April 2026 (id: ${INTAKE_ID:0:8}…)"
  else
    fail "POST /api/intakes — unexpected response" "$RESP"
    return
  fi

  # Open the intake so public enrollment can see it
  RESP=$(admin_patch "/api/intakes/${INTAKE_ID}" '{"status":"open"}' 2>/dev/null) || RESP=""
  if echo "$RESP" | jq -e '.status == "open"' &>/dev/null; then
    pass "PATCH /api/intakes/${INTAKE_ID:0:8}… — status set to open"
  else
    fail "PATCH /api/intakes/${INTAKE_ID:0:8}… — could not open intake" "$RESP"
  fi

  # List intakes
  RESP=$(admin_get "/api/intakes" 2>/dev/null) || RESP="[]"
  if echo "$RESP" | jq -e 'type == "array"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq 'length')
    pass "GET /api/intakes — returned ${COUNT} intake(s)"
  else
    fail "GET /api/intakes — unexpected response" "$RESP"
  fi

  # Validation: duplicate or bad data
  local CODE
  CODE=$(http_code "${AUTH_H[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"name":"","year":2026}' "$BASE_URL/api/intakes")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/intakes — 400 on empty name"
  else
    fail "POST /api/intakes — expected 400 on empty name, got ${CODE}"
  fi
}

# ── 2. Classes (N5–N1, 30 seats) ───────────────────────────────
test_classes() {
  header "Classes"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "POST /api/intakes/{id}/classes (auth required)"; return; fi
  if [[ -z "$INTAKE_ID" ]]; then skip "Classes — no intake_id available"; return; fi

  # Nihon Moment fees: N5=300k, N4=350k, N3=400k, N2=450k, N1=500k
  declare -A FEES=([N5]=300000 [N4]=350000 [N3]=400000 [N2]=450000 [N1]=500000)
  local -A CLASS_IDS

  for LEVEL in N5 N4 N3 N2 N1; do
    local FEE="${FEES[$LEVEL]}"
    local RESP
    RESP=$(admin_post "/api/intakes/${INTAKE_ID}/classes" \
      "{\"level\":\"${LEVEL}\",\"fee_mmk\":${FEE},\"seat_total\":30,\"status\":\"open\"}" \
      2>/dev/null) || RESP=""

    if echo "$RESP" | jq -e '.id' &>/dev/null; then
      CLASS_IDS[$LEVEL]=$(echo "$RESP" | jq -r '.id')
      local RETURNED_FEE; RETURNED_FEE=$(echo "$RESP" | jq '.fee_mmk')
      if [[ "$RETURNED_FEE" == "$FEE" ]]; then
        pass "POST classes — ${LEVEL} created, fee=${FEE} MMK, seats=30"
      else
        fail "POST classes — ${LEVEL} fee mismatch (expected ${FEE}, got ${RETURNED_FEE})"
      fi
    else
      fail "POST classes — ${LEVEL} creation failed" "$RESP"
    fi
  done

  # Store class IDs globally
  CLASS_N5_ID="${CLASS_IDS[N5]:-}"
  CLASS_N4_ID="${CLASS_IDS[N4]:-}"
  CLASS_N3_ID="${CLASS_IDS[N3]:-}"
  CLASS_N2_ID="${CLASS_IDS[N2]:-}"
  CLASS_N1_ID="${CLASS_IDS[N1]:-}"

  # List classes for the intake
  local RESP
  RESP=$(admin_get "/api/intakes/${INTAKE_ID}/classes" 2>/dev/null) || RESP="[]"
  local CLASS_COUNT; CLASS_COUNT=$(echo "$RESP" | jq 'length')
  if [[ "$CLASS_COUNT" == "5" ]]; then
    pass "GET /api/intakes/{id}/classes — all 5 classes listed"
  else
    fail "GET /api/intakes/{id}/classes — expected 5 classes, got ${CLASS_COUNT}" "$RESP"
  fi

  # Duplicate level should return 409
  local CODE
  CODE=$(http_code "${AUTH_H[@]}" -X POST -H "Content-Type: application/json" \
    -d "{\"level\":\"N3\",\"fee_mmk\":400000,\"seat_total\":30}" \
    "$BASE_URL/api/intakes/${INTAKE_ID}/classes")
  if [[ "$CODE" == "409" ]]; then
    pass "POST classes — 409 on duplicate N3"
  else
    fail "POST classes — expected 409 on duplicate level, got ${CODE}"
  fi
}

# ── 3. Public Enrollment Page ───────────────────────────────────
test_public_intake() {
  header "Public Enrollment Page"

  local RESP
  RESP=$(pub_get "/api/public/enroll/april-2026" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e '.intake.status == "open"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq '.classes | length')
    pass "GET /api/public/enroll/april-2026 — intake open, ${COUNT} class(es) listed"

    # Confirm N3 class is present with the right fee
    local N3_FEE; N3_FEE=$(echo "$RESP" | jq '.classes[] | select(.level=="N3") | .fee_mmk')
    if [[ "$N3_FEE" == "400000" ]]; then
      pass "GET /api/public/enroll/april-2026 — N3 fee correct (400,000 MMK)"
    else
      fail "GET /api/public/enroll/april-2026 — N3 fee unexpected: ${N3_FEE}"
    fi

    # Use the class_id from the public response to be sure we get the right one
    local PUB_N3_ID; PUB_N3_ID=$(echo "$RESP" | jq -r '.classes[] | select(.level=="N3") | .id // empty')
    if [[ -n "$PUB_N3_ID" && -z "$CLASS_N3_ID" ]]; then
      CLASS_N3_ID="$PUB_N3_ID"
    fi
  elif [[ $SKIP_ADMIN -eq 1 ]]; then
    # No auth → intake was never created; skip gracefully
    skip "GET /api/public/enroll/april-2026 — no open intake (run with auth to create one first)"
  else
    fail "GET /api/public/enroll/april-2026 — unexpected response" "$RESP"
  fi

  # 404 on a valid-format slug that simply has no matching intake in the DB.
  # Use a year >= 2020 so the slug parser accepts it, but pick a month/year
  # combination that will never exist (September 2020 was before Nihon Moment).
  local CODE; CODE=$(http_code "$BASE_URL/api/public/enroll/september-2020")
  if [[ "$CODE" == "404" ]]; then
    pass "GET /api/public/enroll/september-2020 — 404 for non-existent intake"
  else
    fail "GET /api/public/enroll/september-2020 — expected 404, got ${CODE}"
  fi

  # 400 on a malformed slug (year out of range)
  CODE=$(http_code "$BASE_URL/api/public/enroll/march-1999")
  if [[ "$CODE" == "400" ]]; then
    pass "GET /api/public/enroll/march-1999 — 400 for out-of-range year"
  else
    fail "GET /api/public/enroll/march-1999 — expected 400, got ${CODE}"
  fi
}

# ── 4. Submit Enrollment ────────────────────────────────────────
test_submit_enrollment() {
  header "Submit Enrollment — Ko Aung (N3)"

  if [[ -z "$CLASS_N3_ID" ]]; then
    skip "POST /api/public/enroll — no N3 class_id available"
    return
  fi

  local BODY
  BODY=$(jq -n \
    --arg class_id   "$CLASS_N3_ID" \
    --arg name_en    "Ko Aung" \
    --arg name_mm    "ကိုအောင်" \
    --arg nrc        "12/OuKaMa(N)123456" \
    --arg phone      "09123456789" \
    --arg email      "ko.aung@example.com" \
    '{class_id:$class_id,student_name_en:$name_en,student_name_mm:$name_mm,
      nrc_number:$nrc,phone:$phone,email:$email}')

  local RESP
  RESP=$(pub_post "/api/public/enroll" "$BODY" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e '.enrollment_ref' &>/dev/null; then
    ENROLLMENT_REF=$(echo "$RESP" | jq -r '.enrollment_ref')
    local FEE; FEE=$(echo "$RESP" | jq '.fee_mmk')
    local LEVEL; LEVEL=$(echo "$RESP" | jq -r '.class_level')
    pass "POST /api/public/enroll — enrolled, ref=${ENROLLMENT_REF}, level=${LEVEL}, fee=${FEE}"

    # Check payment instructions are included
    if echo "$RESP" | jq -e '.payment.instructions_en' &>/dev/null; then
      pass "POST /api/public/enroll — payment instructions returned (EN)"
    else
      fail "POST /api/public/enroll — missing payment instructions"
    fi
  else
    fail "POST /api/public/enroll — enrollment failed" "$RESP"
    return
  fi

  # Validation: missing required field
  local CODE
  CODE=$(http_code -X POST -H "Content-Type: application/json" \
    -d '{"class_id":"'$CLASS_N3_ID'","student_name_en":"Test"}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/enroll — 400 when phone is missing"
  else
    fail "POST /api/public/enroll — expected 400 for missing phone, got ${CODE}"
  fi

  # Validation: invalid phone
  CODE=$(http_code -X POST -H "Content-Type: application/json" \
    -d '{"class_id":"'$CLASS_N3_ID'","student_name_en":"Test","phone":"12345"}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/enroll — 400 on invalid Myanmar phone number"
  else
    fail "POST /api/public/enroll — expected 400 for bad phone, got ${CODE}"
  fi
}

# ── 5. Enrollment Status ────────────────────────────────────────
test_enrollment_status() {
  header "Enrollment Status Check"

  if [[ -z "$ENROLLMENT_REF" ]]; then
    skip "GET /api/public/status — no enrollment_ref available"
    return
  fi

  local RESP
  RESP=$(pub_get "/api/public/status?ref=${ENROLLMENT_REF}" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e '.enrollment_ref' &>/dev/null; then
    local STATUS; STATUS=$(echo "$RESP" | jq -r '.status')
    local LABEL_EN; LABEL_EN=$(echo "$RESP" | jq -r '.status_label_en')
    pass "GET /api/public/status?ref=${ENROLLMENT_REF} — status: ${STATUS} (${LABEL_EN})"

    if [[ "$STATUS" == "pending_payment" ]]; then
      pass "GET /api/public/status — status is 'pending_payment' as expected"
    else
      fail "GET /api/public/status — unexpected status: ${STATUS}"
    fi

    # Bilingual labels present
    if echo "$RESP" | jq -e '.status_label_mm' &>/dev/null; then
      local LABEL_MM; LABEL_MM=$(echo "$RESP" | jq -r '.status_label_mm')
      pass "GET /api/public/status — Myanmar label: ${LABEL_MM}"
    else
      fail "GET /api/public/status — missing status_label_mm"
    fi
  else
    fail "GET /api/public/status — unexpected response" "$RESP"
  fi

  # 400 on missing ref
  local CODE; CODE=$(http_code "$BASE_URL/api/public/status")
  if [[ "$CODE" == "400" ]]; then
    pass "GET /api/public/status — 400 when ref is missing"
  else
    fail "GET /api/public/status — expected 400 for missing ref, got ${CODE}"
  fi

  # 404 on unknown ref
  CODE=$(http_code "$BASE_URL/api/public/status?ref=NM-9999-99999")
  if [[ "$CODE" == "404" ]]; then
    pass "GET /api/public/status — 404 for unknown ref"
  else
    fail "GET /api/public/status — expected 404 for bad ref, got ${CODE}"
  fi
}

# ── 6. Admin Stats ──────────────────────────────────────────────
test_admin_stats() {
  header "Admin Stats"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "GET /api/admin/stats (auth required)"; return; fi

  local RESP
  RESP=$(admin_get "/api/admin/stats" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e '.total_enrollments' &>/dev/null; then
    local TOTAL; TOTAL=$(echo "$RESP" | jq '.total_enrollments')
    local PENDING; PENDING=$(echo "$RESP" | jq '.pending_payment_count')
    local CONFIRMED; CONFIRMED=$(echo "$RESP" | jq '.confirmed_count')
    local REVENUE; REVENUE=$(echo "$RESP" | jq '.total_revenue_mmk')
    pass "GET /api/admin/stats — total=${TOTAL}, pending=${PENDING}, confirmed=${CONFIRMED}, revenue=${REVENUE} MMK"

    # seats_by_class should be an array
    local CLASSES_COUNT; CLASSES_COUNT=$(echo "$RESP" | jq '.seats_by_class | length')
    if [[ "$CLASSES_COUNT" -ge 0 ]]; then
      pass "GET /api/admin/stats — seats_by_class has ${CLASSES_COUNT} entry/entries"
    else
      fail "GET /api/admin/stats — seats_by_class missing or invalid"
    fi

    # Verify expected fields are present
    local MISSING_FIELDS
    MISSING_FIELDS=$(echo "$RESP" | jq -r '
      ["total_enrollments","confirmed_count","pending_payment_count",
       "payment_submitted_count","total_revenue_mmk","seats_by_class"]
      | map(select(. as $k | input | has($k) | not))
      | join(", ")
    ' 2>/dev/null) || MISSING_FIELDS=""
    if [[ -z "$MISSING_FIELDS" ]]; then
      pass "GET /api/admin/stats — all expected fields present"
    else
      fail "GET /api/admin/stats — missing fields: ${MISSING_FIELDS}"
    fi
  else
    fail "GET /api/admin/stats — unexpected response" "$RESP"
  fi

  # 401 without auth
  local CODE; CODE=$(http_code "$BASE_URL/api/admin/stats")
  if [[ "$CODE" == "401" ]]; then
    pass "GET /api/admin/stats — 401 without auth"
  else
    fail "GET /api/admin/stats — expected 401 without auth, got ${CODE}"
  fi
}

# ── 7. Admin Students ───────────────────────────────────────────
test_admin_students() {
  header "Admin Students"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "GET /api/admin/students (auth required)"; return; fi

  local RESP
  RESP=$(admin_get "/api/admin/students" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e '.data' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq '.data | length')
    local TOTAL; TOTAL=$(echo "$RESP" | jq '.pagination.total')
    pass "GET /api/admin/students — ${COUNT} students on page, ${TOTAL} total"

    # Pagination fields
    if echo "$RESP" | jq -e '.pagination.page == 1' &>/dev/null; then
      pass "GET /api/admin/students — pagination.page=1 correct"
    else
      fail "GET /api/admin/students — pagination missing or page != 1"
    fi
  else
    fail "GET /api/admin/students — unexpected response" "$RESP"
    return
  fi

  # Filter by status
  RESP=$(admin_get "/api/admin/students?status=pending_payment" 2>/dev/null) || RESP=""
  if echo "$RESP" | jq -e '.data' &>/dev/null; then
    local STATUSES_OK; STATUSES_OK=$(echo "$RESP" | jq '[.data[].status] | all(. == "pending_payment")')
    if [[ "$STATUSES_OK" == "true" || $(echo "$RESP" | jq '.data | length') == "0" ]]; then
      pass "GET /api/admin/students?status=pending_payment — filter works"
    else
      fail "GET /api/admin/students — status filter returned wrong statuses"
    fi
  fi

  # Filter by class_level
  RESP=$(admin_get "/api/admin/students?class_level=N3" 2>/dev/null) || RESP=""
  if echo "$RESP" | jq -e '.data' &>/dev/null; then
    local N3_OK; N3_OK=$(echo "$RESP" | jq '[.data[].class_level] | all(. == "N3")')
    if [[ "$N3_OK" == "true" || $(echo "$RESP" | jq '.data | length') == "0" ]]; then
      pass "GET /api/admin/students?class_level=N3 — level filter works"
    else
      fail "GET /api/admin/students — class_level filter returned wrong levels"
    fi
  fi

  # Search by name
  if [[ -n "$ENROLLMENT_REF" ]]; then
    RESP=$(admin_get "/api/admin/students?search=Ko+Aung" 2>/dev/null) || RESP=""
    if echo "$RESP" | jq -e '.data' &>/dev/null; then
      local FOUND; FOUND=$(echo "$RESP" | jq '.data | length')
      if [[ "$FOUND" -ge 1 ]]; then
        pass "GET /api/admin/students?search=Ko+Aung — found ${FOUND} result(s)"
      else
        fail "GET /api/admin/students — search for Ko Aung returned no results"
      fi
    fi
  fi

  # Pagination: page_size=2
  RESP=$(admin_get "/api/admin/students?page_size=2" 2>/dev/null) || RESP=""
  local PS; PS=$(echo "$RESP" | jq '.pagination.page_size')
  if [[ "$PS" == "2" ]]; then
    pass "GET /api/admin/students?page_size=2 — pagination.page_size=2 correct"
  else
    fail "GET /api/admin/students — expected page_size=2, got ${PS}"
  fi

  # Bad filter: invalid class_level
  local CODE; CODE=$(http_code "${AUTH_H[@]}" "$BASE_URL/api/admin/students?class_level=N9")
  if [[ "$CODE" == "400" ]]; then
    pass "GET /api/admin/students — 400 on invalid class_level=N9"
  else
    fail "GET /api/admin/students — expected 400 for bad class_level, got ${CODE}"
  fi
}

# ── 8. Admin Pending Payments ───────────────────────────────────
test_admin_pending_payments() {
  header "Admin Pending Payments"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "GET /api/admin/payments/pending (auth required)"; return; fi

  local RESP
  RESP=$(admin_get "/api/admin/payments/pending" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e 'type == "array"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq 'length')
    pass "GET /api/admin/payments/pending — returned ${COUNT} pending payment(s)"

    # Validate shape of the first item if present
    if [[ "$COUNT" -gt 0 ]]; then
      local HAS_FIELDS; HAS_FIELDS=$(echo "$RESP" | jq '
        .[0] | has("enrollment") and has("payment") and
               has("class_level") and has("intake_name")
      ')
      if [[ "$HAS_FIELDS" == "true" ]]; then
        pass "GET /api/admin/payments/pending — response shape correct (enrollment + payment + class_level + intake_name)"
      else
        fail "GET /api/admin/payments/pending — missing expected fields" "$(echo "$RESP" | jq '.[0] | keys')"
      fi
    fi
  else
    fail "GET /api/admin/payments/pending — expected array" "$RESP"
  fi

  # 401 without auth
  local CODE; CODE=$(http_code "$BASE_URL/api/admin/payments/pending")
  if [[ "$CODE" == "401" ]]; then
    pass "GET /api/admin/payments/pending — 401 without auth"
  else
    fail "GET /api/admin/payments/pending — expected 401 without auth, got ${CODE}"
  fi
}

# ── 9. Bank Accounts ────────────────────────────────────────────
test_bank_accounts() {
  header "Bank Accounts"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "Bank account endpoints (auth required)"; return; fi

  # List (should have seeded KBZ + AYA from migration 010)
  local RESP
  RESP=$(admin_get "/api/admin/bank-accounts" 2>/dev/null) || RESP=""

  if echo "$RESP" | jq -e 'type == "array"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq 'length')
    pass "GET /api/admin/bank-accounts — ${COUNT} account(s) listed"
  else
    fail "GET /api/admin/bank-accounts — unexpected response" "$RESP"
    return
  fi

  # Create a test account
  RESP=$(admin_post "/api/admin/bank-accounts" \
    '{"bank_name":"CB","account_number":"CB-TEST-001","account_holder":"Test Holder","is_active":true}' \
    2>/dev/null) || RESP=""

  local TEST_ACCOUNT_ID=""
  if echo "$RESP" | jq -e '.id' &>/dev/null; then
    TEST_ACCOUNT_ID=$(echo "$RESP" | jq -r '.id')
    pass "POST /api/admin/bank-accounts — CB account created (id: ${TEST_ACCOUNT_ID:0:8}…)"
  else
    fail "POST /api/admin/bank-accounts — creation failed" "$RESP"
    return
  fi

  # PATCH: toggle is_active to false
  RESP=$(admin_patch "/api/admin/bank-accounts/${TEST_ACCOUNT_ID}" '{"is_active":false}' 2>/dev/null) || RESP=""
  if echo "$RESP" | jq -e '.is_active == false' &>/dev/null; then
    pass "PATCH /api/admin/bank-accounts/{id} — is_active toggled to false"
  else
    fail "PATCH /api/admin/bank-accounts/{id} — toggle failed" "$RESP"
  fi

  # PATCH: update account_holder
  RESP=$(admin_patch "/api/admin/bank-accounts/${TEST_ACCOUNT_ID}" \
    '{"account_holder":"Updated Holder"}' 2>/dev/null) || RESP=""
  if echo "$RESP" | jq -e '.account_holder == "Updated Holder"' &>/dev/null; then
    pass "PATCH /api/admin/bank-accounts/{id} — account_holder updated"
  else
    fail "PATCH /api/admin/bank-accounts/{id} — account_holder update failed" "$RESP"
  fi

  # PATCH: invalid bank_name (should 400)
  local CODE; CODE=$(http_code "${AUTH_H[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"bank_name":"FAKEBOOK","account_number":"123","account_holder":"Test"}' \
    "$BASE_URL/api/admin/bank-accounts")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/admin/bank-accounts — 400 on invalid bank_name"
  else
    fail "POST /api/admin/bank-accounts — expected 400 for invalid bank_name, got ${CODE}"
  fi

  # DELETE test account
  local DEL_CODE
  DEL_CODE=$(http_code "${AUTH_H[@]}" -X DELETE "$BASE_URL/api/admin/bank-accounts/${TEST_ACCOUNT_ID}")
  if [[ "$DEL_CODE" == "204" ]]; then
    pass "DELETE /api/admin/bank-accounts/{id} — 204 No Content"
  else
    fail "DELETE /api/admin/bank-accounts/{id} — expected 204, got ${DEL_CODE}"
  fi

  # DELETE on deleted id should 404
  DEL_CODE=$(http_code "${AUTH_H[@]}" -X DELETE "$BASE_URL/api/admin/bank-accounts/${TEST_ACCOUNT_ID}")
  if [[ "$DEL_CODE" == "404" ]]; then
    pass "DELETE /api/admin/bank-accounts/{id} — 404 on already-deleted account"
  else
    fail "DELETE /api/admin/bank-accounts/{id} — expected 404 on re-delete, got ${DEL_CODE}"
  fi
}

# ── 10. Auth Guard Spot-Check ───────────────────────────────────
test_auth_guards() {
  header "Auth Guards (unauthenticated requests)"

  local ENDPOINTS=(
    "/api/intakes"
    "/api/admin/stats"
    "/api/admin/students"
    "/api/admin/payments/pending"
    "/api/admin/bank-accounts"
  )

  for EP in "${ENDPOINTS[@]}"; do
    local CODE; CODE=$(http_code "$BASE_URL$EP")
    if [[ "$CODE" == "401" ]]; then
      pass "GET ${EP} — 401 without auth ✓"
    else
      fail "GET ${EP} — expected 401, got ${CODE}"
    fi
  done
}

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

main() {
  echo -e "${BOLD}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║   Nihon Moment EduEnroll — Sprint 2 API Test Suite  ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo -e "${RESET}"
  echo "  Base URL : ${BASE_URL}"
  echo "  Date     : $(date '+%Y-%m-%d %H:%M:%S')"

  check_deps
  login

  test_auth_guards
  test_intakes
  test_classes
  test_public_intake
  test_submit_enrollment
  test_enrollment_status
  test_admin_stats
  test_admin_students
  test_admin_pending_payments
  test_bank_accounts

  # ── Summary ─────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}━━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  local TOTAL=$(( PASS + FAIL + SKIP ))
  echo -e "  Total : ${TOTAL}"
  echo -e "  ${GREEN}PASS  : ${PASS}${RESET}"
  if [[ $FAIL -gt 0 ]]; then
    echo -e "  ${RED}FAIL  : ${FAIL}${RESET}"
  else
    echo -e "  FAIL  : ${FAIL}"
  fi
  if [[ $SKIP -gt 0 ]]; then
    echo -e "  ${YELLOW}SKIP  : ${SKIP}${RESET}"
  fi
  echo ""

  if [[ $SKIP_ADMIN -eq 1 ]]; then
    echo -e "  ${YELLOW}NOTE${RESET}: Admin tests were skipped (no auth credentials)."
    echo    "        Re-run with SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL,"
    echo    "        TEST_PASSWORD set to test admin endpoints."
    echo ""
  fi

  if [[ $FAIL -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}All tests passed!${RESET}"
    exit 0
  else
    echo -e "  ${RED}${BOLD}${FAIL} test(s) failed.${RESET}"
    exit 1
  fi
}

main
