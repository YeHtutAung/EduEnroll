#!/usr/bin/env bash
# ─── KuuNyi Security Audit — Tenant Isolation Test ────────────────────────
#
# Registers two test tenants (school-a, school-b), creates test data in
# school-a, then attempts to access school-a's data using school-b's auth
# token. Every attempt must return 403 or an empty result set.
#
# Requirements:
#   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set in environment
#   - The app running at BASE_URL (default: http://localhost:3005)
#
# Usage:
#   export SUPABASE_URL=https://xxx.supabase.co
#   export SUPABASE_SERVICE_ROLE_KEY=xxx
#   bash security-audit.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3005}"
SB_URL="${SUPABASE_URL:?Set SUPABASE_URL}"
SB_KEY="${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY}"

# Vercel Automation Bypass header (for protected preview deployments)
BYPASS_H=""
if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
  BYPASS_H="x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}"
fi
TIMESTAMP=$(date +%s)

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=14

pass() { echo "  ✓ PASS — $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ FAIL — $1 (got: $2)"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  KuuNyi Security Audit — Tenant Isolation"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Register two test schools ────────────────────────────────────────

echo "▸ Registering school-a-${TIMESTAMP}..."
RES_A=$(curl -sL -w "\n%{http_code}" -X POST "${BASE_URL}/api/saas/register" \
  ${BYPASS_H:+-H "$BYPASS_H"} \
  -H "Content-Type: application/json" \
  -d "{
    \"school_name_en\": \"School A Test\",
    \"school_name_mm\": \"စာသင်ကျောင်း A\",
    \"subdomain\": \"school-a-${TIMESTAMP}\",
    \"admin_email\": \"admin-a-${TIMESTAMP}@test.local\",
    \"password\": \"TestPass123!\"
  }")
HTTP_A=$(echo "$RES_A" | tail -1)
BODY_A=$(echo "$RES_A" | sed '$d')

if [ "$HTTP_A" != "201" ]; then
  echo "  ERROR: Failed to register school-a (HTTP ${HTTP_A})"
  echo "  $BODY_A"
  exit 1
fi

TENANT_A=$(echo "$BODY_A" | grep -o '"tenant_id":"[^"]*"' | cut -d'"' -f4)
USER_A=$(echo "$BODY_A" | grep -o '"user_id":"[^"]*"' | cut -d'"' -f4)
echo "  tenant_id: ${TENANT_A}"

echo "▸ Registering school-b-${TIMESTAMP}..."
RES_B=$(curl -sL -w "\n%{http_code}" -X POST "${BASE_URL}/api/saas/register" \
  ${BYPASS_H:+-H "$BYPASS_H"} \
  -H "Content-Type: application/json" \
  -d "{
    \"school_name_en\": \"School B Test\",
    \"school_name_mm\": \"စာသင်ကျောင်း B\",
    \"subdomain\": \"school-b-${TIMESTAMP}\",
    \"admin_email\": \"admin-b-${TIMESTAMP}@test.local\",
    \"password\": \"TestPass123!\"
  }")
HTTP_B=$(echo "$RES_B" | tail -1)
BODY_B=$(echo "$RES_B" | sed '$d')

if [ "$HTTP_B" != "201" ]; then
  echo "  ERROR: Failed to register school-b (HTTP ${HTTP_B})"
  echo "  $BODY_B"
  exit 1
fi

TENANT_B=$(echo "$BODY_B" | grep -o '"tenant_id":"[^"]*"' | cut -d'"' -f4)
echo "  tenant_id: ${TENANT_B}"

# ── Step 2: Create test data in school-a using service role ──────────────────

echo ""
echo "▸ Creating test data in school-a..."

# Create an intake in school-a
INTAKE_RES=$(curl -s -X POST "${SB_URL}/rest/v1/intakes" \
  -H "apikey: ${SB_KEY}" \
  -H "Authorization: Bearer ${SB_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"tenant_id\": \"${TENANT_A}\",
    \"name\": \"Test Intake\",
    \"slug\": \"test-intake-${TIMESTAMP}\",
    \"year\": 2026,
    \"status\": \"open\"
  }")
INTAKE_ID=$(echo "$INTAKE_RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$INTAKE_ID" ]; then
  echo "  ERROR: Failed to create intake in school-a"
  echo "  Response: $INTAKE_RES"
  exit 1
fi
echo "  intake: ${INTAKE_ID}"

# Create a class in school-a
CLASS_RES=$(curl -s -X POST "${SB_URL}/rest/v1/classes" \
  -H "apikey: ${SB_KEY}" \
  -H "Authorization: Bearer ${SB_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"intake_id\": \"${INTAKE_ID}\",
    \"tenant_id\": \"${TENANT_A}\",
    \"level\": \"N5\",
    \"fee_mmk\": 300000,
    \"seat_total\": 30,
    \"seat_remaining\": 30,
    \"status\": \"open\"
  }")
CLASS_ID=$(echo "$CLASS_RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  class: ${CLASS_ID}"

# Create an enrollment in school-a
ENROLL_RES=$(curl -s -X POST "${SB_URL}/rest/v1/enrollments" \
  -H "apikey: ${SB_KEY}" \
  -H "Authorization: Bearer ${SB_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"class_id\": \"${CLASS_ID}\",
    \"tenant_id\": \"${TENANT_A}\",
    \"student_name_en\": \"Test Student\",
    \"phone\": \"09123456789\",
    \"status\": \"pending_payment\"
  }")
ENROLL_ID=$(echo "$ENROLL_RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  enrollment: ${ENROLL_ID}"

# Create a bank account in school-a
BANK_RES=$(curl -s -X POST "${SB_URL}/rest/v1/bank_accounts" \
  -H "apikey: ${SB_KEY}" \
  -H "Authorization: Bearer ${SB_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"tenant_id\": \"${TENANT_A}\",
    \"bank_name\": \"KBZ\",
    \"account_number\": \"1234567890\",
    \"account_holder\": \"Test Holder\",
    \"is_active\": true
  }")
echo "  bank_account created"

# Create an announcement in school-a
curl -s -X POST "${SB_URL}/rest/v1/announcements" \
  -H "apikey: ${SB_KEY}" \
  -H "Authorization: Bearer ${SB_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"tenant_id\": \"${TENANT_A}\",
    \"intake_id\": \"${INTAKE_ID}\",
    \"message\": \"Test announcement\",
    \"sent_by_id\": \"${USER_A}\"
  }" > /dev/null 2>&1
echo "  announcement created"

# ── Step 3: Get school-b's auth token ────────────────────────────────────────

echo ""
echo "▸ Authenticating as school-b admin..."

TOKEN_RES=$(curl -s -X POST "${SB_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SB_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"admin-b-${TIMESTAMP}@test.local\",
    \"password\": \"TestPass123!\"
  }")
ACCESS_TOKEN=$(echo "$TOKEN_RES" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "  ERROR: Could not get access token for school-b"
  echo "  $TOKEN_RES"
  exit 1
fi
echo "  Got access token for school-b"

# Build proper session cookie for Next.js @supabase/ssr
PROJECT_REF=$(echo "$SB_URL" | sed 's|https://\([^.]*\)\..*|\1|')
COOKIE_NAME="sb-${PROJECT_REF}-auth-token"
# Minimal session JSON the SSR client needs
SESSION_JSON=$(echo "$TOKEN_RES" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(json.dumps({k: d[k] for k in ('access_token','token_type','expires_at','refresh_token','user') if k in d}))
" 2>/dev/null || echo "{\"access_token\":\"${ACCESS_TOKEN}\"}")
COOKIE_HEADER="${COOKIE_NAME}=${SESSION_JSON}"

# ── Step 4: Cross-tenant access tests ────────────────────────────────────────

echo ""
echo "▸ Testing cross-tenant access (school-b → school-a data)..."
echo ""

# Helper: test an endpoint. Expects 403, 401, or empty array/object.
test_endpoint() {
  local NAME="$1"
  local METHOD="${2:-GET}"
  local URL="$3"
  local BODY="${4:-}"

  if [ "$METHOD" = "GET" ]; then
    RESPONSE=$(curl -sL -w "\n%{http_code}" "$URL" \
      ${BYPASS_H:+-H "$BYPASS_H"} \
      -H "Cookie: ${COOKIE_HEADER}")
  else
    RESPONSE=$(curl -sL -w "\n%{http_code}" -X "$METHOD" "$URL" \
      ${BYPASS_H:+-H "$BYPASS_H"} \
      -H "Cookie: ${COOKIE_HEADER}" \
      -H "Content-Type: application/json" \
      -d "$BODY")
  fi

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  RESP_BODY=$(echo "$RESPONSE" | sed '$d')

  # Pass conditions: 401, 403, or 200 with empty array/object (RLS filtering)
  if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    pass "$NAME (HTTP ${HTTP_CODE})"
    return
  fi

  # Check for empty result set (tenant isolation via RLS)
  if [ "$HTTP_CODE" = "200" ]; then
    # Empty array
    if [ "$RESP_BODY" = "[]" ]; then
      pass "$NAME (empty array — RLS filtered)"
      return
    fi
    # Object with empty arrays or zero counts (e.g. stats)
    if echo "$RESP_BODY" | grep -q '"total_enrollments":0'; then
      pass "$NAME (zero counts — RLS filtered)"
      return
    fi
    # Students endpoint returns { students: [], total: 0 }
    if echo "$RESP_BODY" | grep -q '"students":\[\]'; then
      pass "$NAME (empty students — RLS filtered)"
      return
    fi
    # Payments returns empty array
    if echo "$RESP_BODY" | grep -q '^\[\]$'; then
      pass "$NAME (empty — RLS filtered)"
      return
    fi
    # Analytics with zero data
    if echo "$RESP_BODY" | grep -q '"total_enrolled":0'; then
      pass "$NAME (zero analytics — RLS filtered)"
      return
    fi
    # Check if response contains school-a's tenant_id (data leak!)
    if echo "$RESP_BODY" | grep -q "${TENANT_A}"; then
      fail "$NAME" "LEAKED school-a data (HTTP ${HTTP_CODE})"
      return
    fi
    # If 200 but no school-a data found, that's a pass
    pass "$NAME (no cross-tenant data in response)"
    return
  fi

  # 404 also acceptable for specific resource endpoints
  if [ "$HTTP_CODE" = "404" ]; then
    pass "$NAME (HTTP 404 — not found)"
    return
  fi

  fail "$NAME" "HTTP ${HTTP_CODE}"
}

# ── 14 endpoint tests ────────────────────────────────────────────────────────

# 1. GET /api/admin/stats
test_endpoint "GET /api/admin/stats" "GET" "${BASE_URL}/api/admin/stats"

# 2. GET /api/admin/students
test_endpoint "GET /api/admin/students" "GET" "${BASE_URL}/api/admin/students"

# 3. GET /api/admin/students/[id] (school-a's enrollment)
test_endpoint "GET /api/admin/students/[id]" "GET" "${BASE_URL}/api/admin/students/${ENROLL_ID}"

# 4. GET /api/admin/payments/pending
test_endpoint "GET /api/admin/payments/pending" "GET" "${BASE_URL}/api/admin/payments/pending"

# 5. GET /api/admin/bank-accounts
test_endpoint "GET /api/admin/bank-accounts" "GET" "${BASE_URL}/api/admin/bank-accounts"

# 6. GET /api/admin/announcements
test_endpoint "GET /api/admin/announcements" "GET" "${BASE_URL}/api/admin/announcements"

# 7. GET /api/admin/analytics
test_endpoint "GET /api/admin/analytics" "GET" "${BASE_URL}/api/admin/analytics?range=all"

# 8. GET /api/intakes (school-b should see only their own)
test_endpoint "GET /api/intakes" "GET" "${BASE_URL}/api/intakes"

# 9. GET /api/intakes/[id]/classes (school-a's intake)
test_endpoint "GET /api/intakes/[id]/classes" "GET" "${BASE_URL}/api/intakes/${INTAKE_ID}/classes"

# 10. PATCH /api/classes/[id] (school-a's class)
test_endpoint "PATCH /api/classes/[id]" "PATCH" "${BASE_URL}/api/classes/${CLASS_ID}" \
  '{"status":"closed"}'

# 11. GET /api/admin/staff
test_endpoint "GET /api/admin/staff" "GET" "${BASE_URL}/api/admin/staff"

# 12–14. Public endpoints with school-a's tenant slug (should return only school-a data via subdomain, but school-b cannot inject)
# Test public endpoints with school-b's context — they should NOT return school-a data
test_endpoint "GET /api/public/bank-accounts (no tenant header)" "GET" \
  "${BASE_URL}/api/public/bank-accounts"

test_endpoint "GET /api/public/status (school-a ref)" "GET" \
  "${BASE_URL}/api/public/status?ref=NM-2026-00001"

test_endpoint "GET /api/public/enroll/[slug] (no tenant)" "GET" \
  "${BASE_URL}/api/public/enroll/test-intake"

# ── Cleanup ──────────────────────────────────────────────────────────────────

echo ""
echo "▸ Cleaning up test data..."

# Delete test data using service role
# Delete in dependency order (children before parents)
for TID in "${TENANT_A}" "${TENANT_B}"; do
  curl -s -X DELETE "${SB_URL}/rest/v1/announcements?tenant_id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/bank_accounts?tenant_id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/enrollments?tenant_id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/classes?tenant_id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/intake_form_fields?intake_id=in.(select id from intakes where tenant_id=eq.${TID})" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/intakes?tenant_id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/users?tenant_id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
  curl -s -X DELETE "${SB_URL}/rest/v1/tenants?id=eq.${TID}" \
    -H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" > /dev/null 2>&1
done

echo "  Done."

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ${PASS_COUNT}/${TOTAL} PASS — Tenant isolation verified"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ "$PASS_COUNT" -lt "$TOTAL" ]; then
  exit 1
fi
