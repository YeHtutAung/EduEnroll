#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# KuuNyi — API Test Suite
# ═══════════════════════════════════════════════════════════════
#
# Tests every public + admin endpoint.
# Requires: curl, jq
#
# Usage:
#   BASE_URL=http://localhost:3005 \
#   SUPABASE_URL=https://xxxx.supabase.co \
#   SUPABASE_ANON_KEY=eyJ... \
#   TEST_EMAIL=admin@nihonmoment.com \
#   TEST_PASSWORD=yourpassword \
#   bash api-tests.sh
#
# All env vars are optional — defaults shown above except passwords.
# Admin endpoint tests are skipped if auth credentials are not set.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:3005}"
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
TEST_EMAIL="${TEST_EMAIL:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"
TIMESTAMP=$(date +%s)

# ── Counters ────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
SKIP_ADMIN=0  # Set to 1 if auth setup fails

# Shared state populated during tests
INTAKE_ID=""
INTAKE_SLUG=""
TENANT_SUBDOMAIN=""
CLASS_N5_ID=""; CLASS_N4_ID=""; CLASS_N3_ID=""; CLASS_N2_ID=""; CLASS_N1_ID=""
ENROLLMENT_REF=""
CART_ENROLLMENT_REF=""
MMQR_ENROLLMENT_REF=""
MMQR_ORDER_ID=""

# Auth cookie header — populated by login()
AUTH_H=()
# Tenant slug header — populated after login()
TENANT_H=()
# Access token for direct Supabase queries
ACCESS_TOKEN=""

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

# Vercel Automation Bypass header (for protected preview deployments)
BYPASS_H=()
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  BYPASS_H=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

# HTTP helpers — output body and status; non-2xx returns body + writes status to stderr
# -L follows redirects (Vercel returns 308 for trailing slash / HTTPS)
_curl_check() {
  local RESP STATUS
  RESP=$(curl -sL -w "\n%{http_code}" "${@}")
  STATUS=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  if [[ "$STATUS" -ge 200 && "$STATUS" -lt 300 ]]; then
    echo "$BODY"
  else
    echo "  [DEBUG] HTTP ${STATUS}: $(echo "$BODY" | head -c 200)" >&2
    return 1
  fi
}
pub_get()    { _curl_check "${BYPASS_H[@]}" "${TENANT_H[@]}" "$BASE_URL$1"; }
pub_post()   { _curl_check "${BYPASS_H[@]}" "${TENANT_H[@]}" -X POST  -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
admin_get()  { _curl_check "${BYPASS_H[@]}" "${AUTH_H[@]}" "$BASE_URL$1"; }
admin_post() { _curl_check "${BYPASS_H[@]}" "${AUTH_H[@]}" -X POST  -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
admin_patch(){ _curl_check "${BYPASS_H[@]}" "${AUTH_H[@]}" -X PATCH -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
admin_del()  { _curl_check "${BYPASS_H[@]}" "${AUTH_H[@]}" -X DELETE "$BASE_URL$1"; }

# Return HTTP status code only (-L follows redirects)
http_code() { curl -sL "${BYPASS_H[@]}" -o /dev/null -w "%{http_code}" "${@}"; }
# HTTP status code with tenant header
http_code_pub() { curl -sL "${BYPASS_H[@]}" "${TENANT_H[@]}" -o /dev/null -w "%{http_code}" "${@}"; }

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
  ACCESS_TOKEN=$(echo "$AUTH_RESP" | jq -r '.access_token // empty')
  if [[ -z "$ACCESS_TOKEN" ]]; then
    echo -e "  ${RED}✗ FAIL${RESET}  Auth response missing access_token."
    echo    "          Response: $(echo "$AUTH_RESP" | head -c 200)"
    SKIP_ADMIN=1
    return
  fi

  # Derive the Supabase project ref from the URL
  local PROJECT_REF
  PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://\([^.]*\)\..*|\1|')

  # Use Bearer token auth for API requests (supported by requireAuth)
  # Send both Authorization and x-supabase-auth (Vercel may strip Authorization)
  # Use x-supabase-auth instead of Authorization to avoid Vercel Deployment
  # Protection intercepting the header and returning an HTML challenge page.
  AUTH_H=(-H "x-supabase-auth: Bearer ${ACCESS_TOKEN}")

  echo -e "  ${GREEN}✓${RESET} Logged in as ${TEST_EMAIL} (project: ${PROJECT_REF})"

  # Fetch tenant subdomain for public endpoint tests
  local TENANT_RESP
  TENANT_RESP=$(curl -sf "${SUPABASE_URL}/rest/v1/tenants?select=subdomain" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" 2>/dev/null) || TENANT_RESP="[]"

  TENANT_SUBDOMAIN=$(echo "$TENANT_RESP" | jq -r '.[0].subdomain // empty')
  if [[ -n "$TENANT_SUBDOMAIN" ]]; then
    TENANT_H=(-H "x-tenant-slug: ${TENANT_SUBDOMAIN}")
    echo -e "  ${GREEN}✓${RESET} Tenant subdomain: ${TENANT_SUBDOMAIN}"
  else
    echo -e "  ${YELLOW}!${RESET} Could not resolve tenant subdomain — public tests may fail"
    TENANT_H=()
  fi

  SKIP_ADMIN=0
}

# ═══════════════════════════════════════════════════════════════
# TEST SECTIONS
# ═══════════════════════════════════════════════════════════════

# ── 1. Intakes ──────────────────────────────────────────────────
test_intakes() {
  header "Intakes"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "POST /api/intakes (auth required)"; return; fi

  # Create intake with unique name — slug = first_word + "-" + year
  local INTAKE_NAME="CI${TIMESTAMP}"
  local RESP
  RESP=$(admin_post "/api/intakes" \
    "{\"name\":\"${INTAKE_NAME}\",\"year\":2026,\"status\":\"draft\"}") || RESP=""

  if echo "$RESP" | jq -e '.id' &>/dev/null; then
    INTAKE_ID=$(echo "$RESP" | jq -r '.id')
    INTAKE_SLUG=$(echo "$RESP" | jq -r '.slug // empty')
    pass "POST /api/intakes — created (id: ${INTAKE_ID:0:8}…, slug: ${INTAKE_SLUG})"
  else
    fail "POST /api/intakes — unexpected response" "$RESP"
    return
  fi

  # Open the intake so public enrollment can see it
  RESP=$(admin_patch "/api/intakes/${INTAKE_ID}" '{"status":"open"}' ) || RESP=""
  if echo "$RESP" | jq -e '.status == "open"' &>/dev/null; then
    pass "PATCH /api/intakes/${INTAKE_ID:0:8}… — status set to open"
  else
    fail "PATCH /api/intakes/${INTAKE_ID:0:8}… — could not open intake" "$RESP"
  fi

  # List intakes
  RESP=$(admin_get "/api/intakes") || RESP="[]"
  if echo "$RESP" | jq -e 'type == "array"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq 'length')
    pass "GET /api/intakes — returned ${COUNT} intake(s)"
  else
    fail "GET /api/intakes — unexpected response" "$RESP"
  fi

  # Validation: empty name should 400
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

  declare -A FEES=([N5]=300000 [N4]=350000 [N3]=400000 [N2]=450000 [N1]=500000)
  local -A CLASS_IDS

  for LEVEL in N5 N4 N3 N2 N1; do
    local FEE="${FEES[$LEVEL]}"
    local RESP
    RESP=$(admin_post "/api/intakes/${INTAKE_ID}/classes" \
      "{\"level\":\"${LEVEL}\",\"fee_mmk\":${FEE},\"seat_total\":30,\"status\":\"open\"}" \
      ) || RESP=""

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

  CLASS_N5_ID="${CLASS_IDS[N5]:-}"
  CLASS_N4_ID="${CLASS_IDS[N4]:-}"
  CLASS_N3_ID="${CLASS_IDS[N3]:-}"
  CLASS_N2_ID="${CLASS_IDS[N2]:-}"
  CLASS_N1_ID="${CLASS_IDS[N1]:-}"

  # List classes for the intake
  local RESP
  RESP=$(admin_get "/api/intakes/${INTAKE_ID}/classes") || RESP="[]"
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

  if [[ -z "$INTAKE_SLUG" ]]; then
    skip "GET /api/public/enroll/[slug] — no intake slug available"
    return
  fi

  local RESP
  RESP=$(pub_get "/api/public/enroll/${INTAKE_SLUG}" ) || RESP=""

  if echo "$RESP" | jq -e '.intake.status == "open"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq '.classes | length')
    pass "GET /api/public/enroll/${INTAKE_SLUG} — intake open, ${COUNT} class(es) listed"

    # Confirm N3 class is present with the right fee
    local N3_FEE; N3_FEE=$(echo "$RESP" | jq '.classes[] | select(.level=="N3") | .fee_mmk')
    if [[ "$N3_FEE" == "400000" ]]; then
      pass "GET /api/public/enroll/${INTAKE_SLUG} — N3 fee correct (400,000 MMK)"
    else
      fail "GET /api/public/enroll/${INTAKE_SLUG} — N3 fee unexpected: ${N3_FEE}"
    fi

    # Verify response has labels object
    if echo "$RESP" | jq -e '.labels.intake' &>/dev/null; then
      pass "GET /api/public/enroll/${INTAKE_SLUG} — labels object present"
    else
      fail "GET /api/public/enroll/${INTAKE_SLUG} — missing labels object"
    fi

    # Use the class_id from the public response
    local PUB_N3_ID; PUB_N3_ID=$(echo "$RESP" | jq -r '.classes[] | select(.level=="N3") | .id // empty')
    if [[ -n "$PUB_N3_ID" && -z "$CLASS_N3_ID" ]]; then
      CLASS_N3_ID="$PUB_N3_ID"
    fi
  else
    fail "GET /api/public/enroll/${INTAKE_SLUG} — unexpected response" "$RESP"
  fi

  # 404 on a non-existent slug (valid format, no matching intake)
  local CODE; CODE=$(http_code_pub "$BASE_URL/api/public/enroll/nonexistent-slug-${TIMESTAMP}")
  if [[ "$CODE" == "404" ]]; then
    pass "GET /api/public/enroll/nonexistent-slug — 404 for non-existent intake"
  else
    fail "GET /api/public/enroll/nonexistent-slug — expected 404, got ${CODE}"
  fi
}

# ── 4. Submit Enrollment ────────────────────────────────────────
test_submit_enrollment() {
  header "Submit Enrollment — Ko Aung (N3)"

  if [[ -z "$CLASS_N3_ID" ]]; then
    skip "POST /api/public/enroll — no N3 class_id available"
    return
  fi

  # New body format: class_id + form_data object
  local BODY
  BODY=$(jq -n \
    --arg class_id "$CLASS_N3_ID" \
    '{class_id: $class_id, form_data: {name_en: "Ko Aung", name_mm: "ကိုအောင်", nrc: "12/OuKaMa(N)123456", phone: "09123456789", email: "ko.aung@example.com"}}')

  local RESP
  RESP=$(pub_post "/api/public/enroll" "$BODY" ) || RESP=""

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

  # Validation: missing class_id should 400
  local CODE
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"form_data":{"name_en":"Test"}}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/enroll — 400 when class_id is missing"
  else
    fail "POST /api/public/enroll — expected 400 for missing class_id, got ${CODE}"
  fi

  # Validation: invalid class_id UUID should 400
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"class_id":"not-a-uuid"}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/enroll — 400 on invalid class_id UUID"
  else
    fail "POST /api/public/enroll — expected 400 for invalid UUID, got ${CODE}"
  fi

  # Non-existent class_id should 404
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"class_id":"00000000-0000-0000-0000-000000000000"}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "404" ]]; then
    pass "POST /api/public/enroll — 404 on non-existent class"
  else
    fail "POST /api/public/enroll — expected 404 for non-existent class, got ${CODE}"
  fi
}

# ── 4b. Submit Cart Enrollment (multi-ticket) ─────────────────
test_submit_cart_enrollment() {
  header "Submit Cart Enrollment — Ma Aye (N5 ×2, N4 ×1)"

  if [[ -z "$CLASS_N5_ID" || -z "$CLASS_N4_ID" ]]; then
    skip "POST /api/public/enroll (cart) — no N5/N4 class_id available"
    return
  fi

  # Cart body with items array
  local BODY
  BODY=$(jq -n \
    --arg n5_id "$CLASS_N5_ID" \
    --arg n4_id "$CLASS_N4_ID" \
    '{items: [{class_id: $n5_id, quantity: 2}, {class_id: $n4_id, quantity: 1}], form_data: {name_en: "Ma Aye", phone: "09987654321", email: "ma.aye@example.com"}}')

  local RESP
  RESP=$(pub_post "/api/public/enroll" "$BODY" ) || RESP=""

  if echo "$RESP" | jq -e '.enrollment_ref' &>/dev/null; then
    CART_ENROLLMENT_REF=$(echo "$RESP" | jq -r '.enrollment_ref')
    local TOTAL_FEE; TOTAL_FEE=$(echo "$RESP" | jq '.total_fee_mmk')
    local QTY; QTY=$(echo "$RESP" | jq '.quantity')
    local ITEMS_COUNT; ITEMS_COUNT=$(echo "$RESP" | jq '.items | length')
    pass "POST /api/public/enroll (cart) — ref=${CART_ENROLLMENT_REF}, total=${TOTAL_FEE}, qty=${QTY}"

    # Verify items breakdown returned
    if [[ "$ITEMS_COUNT" == "2" ]]; then
      pass "POST /api/public/enroll (cart) — items array has 2 entries"
    else
      fail "POST /api/public/enroll (cart) — expected 2 items, got ${ITEMS_COUNT}"
    fi

    # Verify total fee = N5*2 + N4*1 = 300000*2 + 350000*1 = 950000
    if [[ "$TOTAL_FEE" == "950000" ]]; then
      pass "POST /api/public/enroll (cart) — total fee correct (950,000 MMK)"
    else
      fail "POST /api/public/enroll (cart) — expected total 950000, got ${TOTAL_FEE}"
    fi

    # Verify quantity = 3
    if [[ "$QTY" == "3" ]]; then
      pass "POST /api/public/enroll (cart) — total quantity correct (3)"
    else
      fail "POST /api/public/enroll (cart) — expected quantity 3, got ${QTY}"
    fi

    # Payment instructions should be present
    if echo "$RESP" | jq -e '.payment.instructions_en' &>/dev/null; then
      pass "POST /api/public/enroll (cart) — payment instructions returned"
    else
      fail "POST /api/public/enroll (cart) — missing payment instructions"
    fi
  else
    fail "POST /api/public/enroll (cart) — enrollment failed" "$RESP"
    return
  fi

  # Validation: empty items array should 400
  local CODE
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"items":[], "form_data":{"name_en":"Test"}}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/enroll (cart) — 400 on empty items array"
  else
    fail "POST /api/public/enroll (cart) — expected 400 for empty items, got ${CODE}"
  fi

  # Validation: items with invalid class_id should 400
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"items":[{"class_id":"not-a-uuid","quantity":1}]}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/enroll (cart) — 400 on invalid item class_id"
  else
    fail "POST /api/public/enroll (cart) — expected 400 for invalid item UUID, got ${CODE}"
  fi

  # Non-existent class in cart should 404
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"items":[{"class_id":"00000000-0000-0000-0000-000000000000","quantity":1}]}' \
    "$BASE_URL/api/public/enroll")
  if [[ "$CODE" == "404" ]]; then
    pass "POST /api/public/enroll (cart) — 404 on non-existent class in cart"
  else
    fail "POST /api/public/enroll (cart) — expected 404, got ${CODE}"
  fi
}

# ── 4c. Cart Enrollment Status ─────────────────────────────────
test_cart_enrollment_status() {
  header "Cart Enrollment Status Check"

  if [[ -z "$CART_ENROLLMENT_REF" ]]; then
    skip "GET /api/public/status (cart) — no cart enrollment_ref available"
    return
  fi

  local RESP
  RESP=$(pub_get "/api/public/status?ref=${CART_ENROLLMENT_REF}" ) || RESP=""

  if echo "$RESP" | jq -e '.enrollment_ref' &>/dev/null; then
    local STATUS; STATUS=$(echo "$RESP" | jq -r '.status')
    pass "GET /api/public/status (cart) — status: ${STATUS}"

    # Should have items array
    local ITEMS_COUNT; ITEMS_COUNT=$(echo "$RESP" | jq '.items | length // 0')
    if [[ "$ITEMS_COUNT" == "2" ]]; then
      pass "GET /api/public/status (cart) — items array has 2 entries"
    else
      fail "GET /api/public/status (cart) — expected 2 items, got ${ITEMS_COUNT}" "$RESP"
    fi

    # class_level should be comma-separated for cart
    local CLASS_LEVEL; CLASS_LEVEL=$(echo "$RESP" | jq -r '.class_level // ""')
    if [[ -n "$CLASS_LEVEL" && "$CLASS_LEVEL" == *","* ]]; then
      pass "GET /api/public/status (cart) — class_level is multi-value: ${CLASS_LEVEL}"
    else
      fail "GET /api/public/status (cart) — expected comma-separated class_level, got: ${CLASS_LEVEL}"
    fi

    # fee_mmk should be cart total (950000)
    local FEE; FEE=$(echo "$RESP" | jq '.fee_mmk // 0')
    if [[ "$FEE" == "950000" ]]; then
      pass "GET /api/public/status (cart) — fee_mmk is cart total (950,000)"
    else
      fail "GET /api/public/status (cart) — expected fee 950000, got ${FEE}"
    fi
  else
    fail "GET /api/public/status (cart) — unexpected response" "$RESP"
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
  RESP=$(pub_get "/api/public/status?ref=${ENROLLMENT_REF}" ) || RESP=""

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
  local CODE; CODE=$(http_code_pub "$BASE_URL/api/public/status")
  if [[ "$CODE" == "400" ]]; then
    pass "GET /api/public/status — 400 when ref is missing"
  else
    fail "GET /api/public/status — expected 400 for missing ref, got ${CODE}"
  fi

  # 404 on unknown ref
  CODE=$(http_code_pub "$BASE_URL/api/public/status?ref=NM-9999-99999")
  if [[ "$CODE" == "404" ]]; then
    pass "GET /api/public/status — 404 for unknown ref"
  else
    fail "GET /api/public/status — expected 404 for bad ref, got ${CODE}"
  fi
}

# ── 5b. Receipt Upload (single enrollment) ────────────────────
test_receipt_upload() {
  header "Receipt Upload — Single Enrollment"

  if [[ -z "$ENROLLMENT_REF" ]]; then
    skip "POST /api/public/payments/upload (single) — no enrollment_ref available"
    return
  fi

  # Create a tiny valid PNG (1x1 pixel) for testing
  local TMPIMG
  TMPIMG=$(mktemp /tmp/test_receipt_XXXXXX.png)
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$TMPIMG"

  # Test: successful upload for single enrollment
  local RESP STATUS
  RESP=$(curl -sL -w "\n%{http_code}" "${BYPASS_H[@]}" "${TENANT_H[@]}" \
    -X POST "$BASE_URL/api/public/payments/upload" \
    -F "enrollment_ref=${ENROLLMENT_REF}" \
    -F "proof_image=@${TMPIMG};type=image/png")
  STATUS=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [[ "$STATUS" == "201" ]]; then
    pass "POST /api/public/payments/upload (single) — 201 created"

    if echo "$BODY" | jq -e '.amount_mmk' &>/dev/null; then
      local AMT; AMT=$(echo "$BODY" | jq '.amount_mmk')
      pass "POST /api/public/payments/upload (single) — amount_mmk=${AMT}"
    else
      fail "POST /api/public/payments/upload (single) — missing amount_mmk" "$BODY"
    fi

    if echo "$BODY" | jq -e '.payment_id' &>/dev/null; then
      pass "POST /api/public/payments/upload (single) — payment_id returned"
    else
      fail "POST /api/public/payments/upload (single) — missing payment_id" "$BODY"
    fi
  else
    fail "POST /api/public/payments/upload (single) — expected 201, got ${STATUS}" "$BODY"
  fi

  # Test: missing enrollment_ref should 400
  local CODE
  CODE=$(curl -sL "${BYPASS_H[@]}" "${TENANT_H[@]}" -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL/api/public/payments/upload" \
    -F "proof_image=@${TMPIMG};type=image/png")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/payments/upload — 400 on missing enrollment_ref"
  else
    fail "POST /api/public/payments/upload — expected 400 for missing ref, got ${CODE}"
  fi

  # Test: unknown ref should 404
  CODE=$(curl -sL "${BYPASS_H[@]}" "${TENANT_H[@]}" -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL/api/public/payments/upload" \
    -F "enrollment_ref=NM-9999-99999" \
    -F "proof_image=@${TMPIMG};type=image/png")
  if [[ "$CODE" == "404" ]]; then
    pass "POST /api/public/payments/upload — 404 on unknown enrollment_ref"
  else
    fail "POST /api/public/payments/upload — expected 404, got ${CODE}"
  fi

  # Test: re-upload for already submitted should 409
  CODE=$(curl -sL "${BYPASS_H[@]}" "${TENANT_H[@]}" -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL/api/public/payments/upload" \
    -F "enrollment_ref=${ENROLLMENT_REF}" \
    -F "proof_image=@${TMPIMG};type=image/png")
  if [[ "$CODE" == "409" ]]; then
    pass "POST /api/public/payments/upload — 409 on duplicate upload (already submitted)"
  else
    fail "POST /api/public/payments/upload — expected 409 for duplicate, got ${CODE}"
  fi

  rm -f "$TMPIMG"
}

# ── 5c. Receipt Upload (cart enrollment) ──────────────────────
test_cart_receipt_upload() {
  header "Receipt Upload — Cart Enrollment"

  if [[ -z "$CART_ENROLLMENT_REF" ]]; then
    skip "POST /api/public/payments/upload (cart) — no cart enrollment_ref available"
    return
  fi

  # Create a tiny valid PNG for testing
  local TMPIMG
  TMPIMG=$(mktemp /tmp/test_receipt_XXXXXX.png)
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$TMPIMG"

  # Test: successful upload for cart enrollment (class_id=NULL)
  local RESP STATUS
  RESP=$(curl -sL -w "\n%{http_code}" "${BYPASS_H[@]}" "${TENANT_H[@]}" \
    -X POST "$BASE_URL/api/public/payments/upload" \
    -F "enrollment_ref=${CART_ENROLLMENT_REF}" \
    -F "proof_image=@${TMPIMG};type=image/png")
  STATUS=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [[ "$STATUS" == "201" ]]; then
    pass "POST /api/public/payments/upload (cart) — 201 created"

    # Cart total should be 950000 (N5×2 + N4×1 = 600000 + 350000)
    local AMT; AMT=$(echo "$BODY" | jq '.amount_mmk')
    if [[ "$AMT" == "950000" ]]; then
      pass "POST /api/public/payments/upload (cart) — amount_mmk=950000 (correct cart total)"
    else
      fail "POST /api/public/payments/upload (cart) — expected 950000, got ${AMT}"
    fi

    if echo "$BODY" | jq -e '.payment_id' &>/dev/null; then
      pass "POST /api/public/payments/upload (cart) — payment_id returned"
    else
      fail "POST /api/public/payments/upload (cart) — missing payment_id" "$BODY"
    fi
  else
    fail "POST /api/public/payments/upload (cart) — expected 201, got ${STATUS}" "$BODY"
  fi

  rm -f "$TMPIMG"
}

# ── 5d. MMQR Payment Flow ──────────────────────────────────────
test_mmqr_payment() {
  header "MMQR Payment Flow"

  # Need a fresh enrollment in pending_payment status for MMQR tests
  if [[ -z "$CLASS_N2_ID" ]]; then
    skip "MMQR — no N2 class_id available"
    return
  fi

  # Create a dedicated enrollment for MMQR testing
  local BODY
  BODY=$(jq -n \
    --arg class_id "$CLASS_N2_ID" \
    '{class_id: $class_id, form_data: {name_en: "U Maung", name_mm: "ဦးမောင်", nrc: "12/OuKaMa(N)999888", phone: "09111222333", email: "u.maung@example.com"}}')

  local RESP
  RESP=$(pub_post "/api/public/enroll" "$BODY") || RESP=""

  if echo "$RESP" | jq -e '.enrollment_ref' &>/dev/null; then
    MMQR_ENROLLMENT_REF=$(echo "$RESP" | jq -r '.enrollment_ref')
    pass "POST /api/public/enroll — MMQR test enrollment created (ref=${MMQR_ENROLLMENT_REF})"
  else
    fail "POST /api/public/enroll — failed to create MMQR test enrollment" "$RESP"
    return
  fi

  # ── Test 1: Create MMQR payment with valid enrollment ─────
  RESP=$(pub_post "/api/public/payments/mmqr" \
    "{\"enrollmentRef\":\"${MMQR_ENROLLMENT_REF}\"}") || RESP=""

  if echo "$RESP" | jq -e '.orderId' &>/dev/null; then
    MMQR_ORDER_ID=$(echo "$RESP" | jq -r '.orderId')
    local QR; QR=$(echo "$RESP" | jq -r '.qr // empty')
    local AMT; AMT=$(echo "$RESP" | jq '.amount')
    pass "POST /api/public/payments/mmqr — QR generated (orderId=${MMQR_ORDER_ID:0:20}…)"

    # QR string should be present (EMVCo format)
    if [[ -n "$QR" ]]; then
      pass "POST /api/public/payments/mmqr — QR payload present (${#QR} chars)"
    else
      fail "POST /api/public/payments/mmqr — QR payload is empty"
    fi

    # Amount should match N2 fee (450000)
    if [[ "$AMT" == "450000" ]]; then
      pass "POST /api/public/payments/mmqr — amount correct (450,000 MMK)"
    else
      fail "POST /api/public/payments/mmqr — expected amount 450000, got ${AMT}"
    fi
  else
    fail "POST /api/public/payments/mmqr — failed to create payment" "$RESP"
    # Don't return — continue with other tests that don't depend on orderId
  fi

  # ── Test 2: Invalid enrollmentRef should 404 ──────────────
  local CODE
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{"enrollmentRef":"NM-0000-99999"}' \
    "$BASE_URL/api/public/payments/mmqr")
  if [[ "$CODE" == "404" ]]; then
    pass "POST /api/public/payments/mmqr — 404 on non-existent enrollment"
  else
    fail "POST /api/public/payments/mmqr — expected 404 for bad ref, got ${CODE}"
  fi

  # ── Test 3: Missing enrollmentRef should 400 ──────────────
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -d '{}' \
    "$BASE_URL/api/public/payments/mmqr")
  if [[ "$CODE" == "400" ]]; then
    pass "POST /api/public/payments/mmqr — 400 on missing enrollmentRef"
  else
    fail "POST /api/public/payments/mmqr — expected 400 for missing ref, got ${CODE}"
  fi

  # ── Test 4: Poll status — should be PENDING ──────────────
  if [[ -n "$MMQR_ORDER_ID" ]]; then
    RESP=$(pub_get "/api/public/payments/mmqr/status?ref=${MMQR_ORDER_ID}") || RESP=""

    local STATUS; STATUS=$(echo "$RESP" | jq -r '.mmqr_status // empty')
    if [[ "$STATUS" == "PENDING" ]]; then
      pass "GET /api/public/payments/mmqr/status — status is PENDING"
    else
      fail "GET /api/public/payments/mmqr/status — expected PENDING, got ${STATUS}" "$RESP"
    fi
  else
    skip "GET /api/public/payments/mmqr/status — no orderId available"
  fi

  # ── Test 5: Poll status with unknown ref — returns PENDING (fallback) ──
  RESP=$(pub_get "/api/public/payments/mmqr/status?ref=KNY-unknown-ref-999") || RESP=""
  local UNK_STATUS; UNK_STATUS=$(echo "$RESP" | jq -r '.mmqr_status // empty')
  if [[ "$UNK_STATUS" == "PENDING" ]]; then
    pass "GET /api/public/payments/mmqr/status — PENDING fallback for unknown ref"
  else
    fail "GET /api/public/payments/mmqr/status — expected PENDING fallback, got ${UNK_STATUS}"
  fi

  # ── Test 6: Poll status with missing ref — should 400 ────
  CODE=$(http_code_pub "$BASE_URL/api/public/payments/mmqr/status")
  if [[ "$CODE" == "400" ]]; then
    pass "GET /api/public/payments/mmqr/status — 400 on missing ref param"
  else
    fail "GET /api/public/payments/mmqr/status — expected 400, got ${CODE}"
  fi

  # ── Test 7: Webhook with invalid signature — should 403 ──
  CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
    -H "x-mmpay-signature: invalidsignature" \
    -H "x-mmpay-nonce: 1234567890" \
    -d '{"orderId":"fake","status":"SUCCESS"}' \
    "$BASE_URL/api/public/payments/mmqr/webhook")
  if [[ "$CODE" == "403" ]]; then
    pass "POST /api/public/payments/mmqr/webhook — 403 on invalid signature"
  else
    fail "POST /api/public/payments/mmqr/webhook — expected 403, got ${CODE}"
  fi

  # ── Test 8: Non-pending enrollment should 409 ─────────────
  # The MMQR_ENROLLMENT_REF enrollment now has a payment record, so creating
  # another MMQR payment should still work (status is still pending_payment).
  # But ENROLLMENT_REF (Ko Aung's) was receipt-uploaded → pending_verification.
  # We test 409 using ENROLLMENT_REF if it exists and was already uploaded.
  if [[ -n "$ENROLLMENT_REF" ]]; then
    # First verify its status changed (receipt was uploaded in earlier test)
    local STATUS_RESP
    STATUS_RESP=$(pub_get "/api/public/status?ref=${ENROLLMENT_REF}") || STATUS_RESP=""
    local ENROLL_STATUS; ENROLL_STATUS=$(echo "$STATUS_RESP" | jq -r '.status // empty')

    if [[ "$ENROLL_STATUS" != "pending_payment" && "$ENROLL_STATUS" != "partial_payment" ]]; then
      CODE=$(http_code_pub -X POST -H "Content-Type: application/json" \
        -d "{\"enrollmentRef\":\"${ENROLLMENT_REF}\"}" \
        "$BASE_URL/api/public/payments/mmqr")
      if [[ "$CODE" == "409" ]]; then
        pass "POST /api/public/payments/mmqr — 409 on non-pending enrollment"
      else
        fail "POST /api/public/payments/mmqr — expected 409 for non-pending, got ${CODE}"
      fi
    else
      skip "POST /api/public/payments/mmqr — 409 test: enrollment still pending_payment"
    fi
  else
    skip "POST /api/public/payments/mmqr — 409 test: no ENROLLMENT_REF available"
  fi
}

# ── 6. Admin Stats ──────────────────────────────────────────────
test_admin_stats() {
  header "Admin Stats"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "GET /api/admin/stats (auth required)"; return; fi

  local RESP
  RESP=$(admin_get "/api/admin/stats" ) || RESP=""

  if echo "$RESP" | jq -e 'has("total_enrollments")' &>/dev/null; then
    local TOTAL; TOTAL=$(echo "$RESP" | jq '.total_enrollments')
    local PENDING; PENDING=$(echo "$RESP" | jq '.pending_payment_count')
    local CONFIRMED; CONFIRMED=$(echo "$RESP" | jq '.confirmed_count')
    pass "GET /api/admin/stats — total=${TOTAL}, pending=${PENDING}, confirmed=${CONFIRMED}"

    # seats_by_class should be an array
    if echo "$RESP" | jq -e '.seats_by_class | type == "array"' &>/dev/null; then
      local CLASSES_COUNT; CLASSES_COUNT=$(echo "$RESP" | jq '.seats_by_class | length')
      pass "GET /api/admin/stats — seats_by_class has ${CLASSES_COUNT} entry/entries"
    else
      fail "GET /api/admin/stats — seats_by_class missing or invalid"
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
  RESP=$(admin_get "/api/admin/students" ) || RESP=""

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
  RESP=$(admin_get "/api/admin/students?status=pending_payment" ) || RESP=""
  if echo "$RESP" | jq -e '.data' &>/dev/null; then
    local STATUSES_OK; STATUSES_OK=$(echo "$RESP" | jq '[.data[].status] | all(. == "pending_payment")')
    if [[ "$STATUSES_OK" == "true" || $(echo "$RESP" | jq '.data | length') == "0" ]]; then
      pass "GET /api/admin/students?status=pending_payment — filter works"
    else
      fail "GET /api/admin/students — status filter returned wrong statuses"
    fi
  fi

  # Filter by class_level (now TEXT, not enum)
  RESP=$(admin_get "/api/admin/students?class_level=N3" ) || RESP=""
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
    RESP=$(admin_get "/api/admin/students?search=Ko+Aung" ) || RESP=""
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
  RESP=$(admin_get "/api/admin/students?page_size=2" ) || RESP=""
  local PS; PS=$(echo "$RESP" | jq '.pagination.page_size')
  if [[ "$PS" == "2" ]]; then
    pass "GET /api/admin/students?page_size=2 — pagination.page_size=2 correct"
  else
    fail "GET /api/admin/students — expected page_size=2, got ${PS}"
  fi
}

# ── 8. Admin Pending Payments ───────────────────────────────────
test_admin_pending_payments() {
  header "Admin Pending Payments"

  if [[ $SKIP_ADMIN -eq 1 ]]; then skip "GET /api/admin/payments/pending (auth required)"; return; fi

  local RESP
  RESP=$(admin_get "/api/admin/payments/pending" ) || RESP=""

  if echo "$RESP" | jq -e 'type == "array"' &>/dev/null; then
    local COUNT; COUNT=$(echo "$RESP" | jq 'length')
    pass "GET /api/admin/payments/pending — returned ${COUNT} pending payment(s)"
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

  # List
  local RESP
  RESP=$(admin_get "/api/admin/bank-accounts" ) || RESP=""

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
    ) || RESP=""

  local TEST_ACCOUNT_ID=""
  if echo "$RESP" | jq -e '.id' &>/dev/null; then
    TEST_ACCOUNT_ID=$(echo "$RESP" | jq -r '.id')
    pass "POST /api/admin/bank-accounts — CB account created (id: ${TEST_ACCOUNT_ID:0:8}…)"
  else
    fail "POST /api/admin/bank-accounts — creation failed" "$RESP"
    return
  fi

  # PATCH: toggle is_active to false
  RESP=$(admin_patch "/api/admin/bank-accounts/${TEST_ACCOUNT_ID}" '{"is_active":false}' ) || RESP=""
  if echo "$RESP" | jq -e '.is_active == false' &>/dev/null; then
    pass "PATCH /api/admin/bank-accounts/{id} — is_active toggled to false"
  else
    fail "PATCH /api/admin/bank-accounts/{id} — toggle failed" "$RESP"
  fi

  # PATCH: update account_holder
  RESP=$(admin_patch "/api/admin/bank-accounts/${TEST_ACCOUNT_ID}" \
    '{"account_holder":"Updated Holder"}' ) || RESP=""
  if echo "$RESP" | jq -e '.account_holder == "Updated Holder"' &>/dev/null; then
    pass "PATCH /api/admin/bank-accounts/{id} — account_holder updated"
  else
    fail "PATCH /api/admin/bank-accounts/{id} — account_holder update failed" "$RESP"
  fi

  # POST: invalid bank_name should 400
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
      pass "GET ${EP} — 401 without auth"
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
  echo "║          KuuNyi — API Test Suite                    ║"
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
  test_submit_cart_enrollment
  test_enrollment_status
  test_cart_enrollment_status
  test_receipt_upload
  test_cart_receipt_upload
  test_mmqr_payment
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
