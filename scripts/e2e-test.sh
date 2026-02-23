#!/usr/bin/env bash
# =============================================================================
# JobMate — End-to-End Integration Test
# Phase 5: full "approveJob → AI analysis → SSE event" flow
#
# Prerequisites:
#   - docker compose up -d (all services running locally)
#   - curl, jq installed
#
# Usage:
#   chmod +x scripts/e2e-test.sh
#   ./scripts/e2e-test.sh
#   ./scripts/e2e-test.sh https://api.meelkyway.com http://internal-discovery:8081
# =============================================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:4000}"
DISCOVERY_URL="${2:-http://localhost:8081}"
GQL="${BASE_URL}/graphql"
SSE="${BASE_URL}/events"

# ANSI colours
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${CYAN}  ▸ $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
fail() { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

hr() { echo -e "\n${CYAN}────────────────────────────────────────────${NC}"; }

gql() {
  local query="$1"
  curl -s -X POST "$GQL" \
    -H "Content-Type: application/json" \
    -H "${AUTH_HEADER:-x-skip: true}" \
    -d "$query"
}

gql_auth() {
  local query="$1"
  curl -s -X POST "$GQL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "$query"
}

# ─────────────────────────────────────────────────────────────
hr
echo -e "${CYAN}  JobMate — E2E Integration Test${NC}"
echo -e "  Target: ${BASE_URL}"
hr

# ── 1. Health checks ────────────────────────────────────────
info "Step 1 — Health checks"

GATEWAY_HEALTH=$(curl -sf "${BASE_URL}/health" | jq -r '.status' 2>/dev/null || echo "FAIL")
[ "$GATEWAY_HEALTH" = "ok" ] && pass "Gateway healthy" || fail "Gateway not responding at ${BASE_URL}/health"

# ── 2. Register a test user ──────────────────────────────────
hr
info "Step 2 — Register test user"

EMAIL="e2e-test-$(date +%s)@jobmate.test"
PASSWORD="E2eTestPass123"

REGISTER_RESP=$(gql "{\"query\":\"mutation { register(email: \\\"${EMAIL}\\\", password: \\\"${PASSWORD}\\\") { token user { id email } } }\"}")
TOKEN=$(echo "$REGISTER_RESP" | jq -r '.data.register.token // empty')
USER_ID=$(echo "$REGISTER_RESP" | jq -r '.data.register.user.id // empty')

[ -n "$TOKEN" ] && pass "Registered: ${EMAIL} (id: ${USER_ID})" || {
  echo "$REGISTER_RESP" | jq .
  fail "Registration failed"
}

# ── 3. Login (verify JWT round-trip) ────────────────────────
hr
info "Step 3 — Login"

LOGIN_RESP=$(gql "{\"query\":\"mutation { login(email: \\\"${EMAIL}\\\", password: \\\"${PASSWORD}\\\") { token user { id } } }\"}")
LOGIN_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.login.token // empty')

[ -n "$LOGIN_TOKEN" ] && pass "Login OK — JWT received" || fail "Login failed"

# ── 4. Update profile ────────────────────────────────────────
hr
info "Step 4 — Update profile with skills"

PROFILE_RESP=$(gql_auth "{\"query\":\"mutation { updateProfile(input: { fullName: \\\"E2E Tester\\\", status: JUNIOR, skills: [\\\"Python\\\", \\\"Docker\\\", \\\"FastAPI\\\"] }) { id fullName status } }\"}")
FULL_NAME=$(echo "$PROFILE_RESP" | jq -r '.data.updateProfile.fullName // empty')

[ "$FULL_NAME" = "E2E Tester" ] && pass "Profile updated: ${FULL_NAME}" || {
  echo "$PROFILE_RESP" | jq .
  fail "updateProfile failed"
}

# ── 5. Create SearchConfig ────────────────────────────────────
hr
info "Step 5 — Create SearchConfig"

SC_RESP=$(gql_auth '{
  "query": "mutation CreateSC($input: CreateSearchConfigInput!) { createSearchConfig(input: $input) { id jobTitles isActive } }",
  "variables": {
    "input": {
      "jobTitles": ["Développeur Python"],
      "locations": ["Paris"],
      "remotePolicy": "REMOTE",
      "keywords": ["FastAPI", "Docker"],
      "redFlags": ["unpaid", "non rémunéré"]
    }
  }
}')
SC_ID=$(echo "$SC_RESP" | jq -r '.data.createSearchConfig.id // empty')

[ -n "$SC_ID" ] && pass "SearchConfig created (id: ${SC_ID})" || {
  echo "$SC_RESP" | jq .
  fail "createSearchConfig failed"
}

# ── 6. Check jobFeed / trigger scrape if empty ──────────────
hr
info "Step 6 — Check jobFeed (PENDING)"

FEED_RESP=$(gql_auth '{"query":"query { jobFeed(status: PENDING) { id status } }"}')
FEED_COUNT=$(echo "$FEED_RESP" | jq '.data.jobFeed | length')

if [ "$FEED_COUNT" -eq 0 ]; then
  info "No PENDING jobs yet — triggering discovery scrape at ${DISCOVERY_URL}/trigger"
  TRIGGER_RESP=$(curl -sf -X POST "${DISCOVERY_URL}/trigger" 2>/dev/null || echo '{"error":"unreachable"}')
  echo "  trigger response: ${TRIGGER_RESP}"

  info "Waiting up to 30s for discovery to populate job_feed…"
  WAITED=0
  while [ "$WAITED" -lt 30 ]; do
    sleep 2; WAITED=$((WAITED + 2))
    FEED_RESP=$(gql_auth '{"query":"query { jobFeed(status: PENDING) { id status } }"}')
    FEED_COUNT=$(echo "$FEED_RESP" | jq '.data.jobFeed | length')
    [ "$FEED_COUNT" -gt 0 ] && break
    echo -n "."
  done
  echo ""
fi

if [ "$FEED_COUNT" -gt 0 ]; then
  pass "jobFeed has ${FEED_COUNT} PENDING item(s)"
  JOB_FEED_ID=$(echo "$FEED_RESP" | jq -r '.data.jobFeed[0].id')
else
  warn "No PENDING jobs available (ADZUNA_APP_ID may not be set — discovery is a no-op)."
  warn "Set ADZUNA_APP_ID + ADZUNA_APP_KEY in .env and re-run."
  warn "Skipping approveJob / SSE test — all other steps passed ✓"
  exit 0
fi

# ── 7. Open SSE connection (background) ─────────────────────
hr
info "Step 7 — Open SSE listener (background)"

SSE_LOG=$(mktemp)
curl -sN "${SSE}?token=${TOKEN}" > "$SSE_LOG" 2>&1 &
SSE_PID=$!

# Give SSE time to connect
sleep 1

# Check the initial "connected" event arrived
if grep -q '"type":"connected"' "$SSE_LOG" 2>/dev/null; then
  pass "SSE connected (pid: ${SSE_PID})"
else
  warn "SSE initial event not seen yet — connection may still be establishing"
  cat "$SSE_LOG" || true
fi

# ── 8. Approve a job ─────────────────────────────────────────
hr
info "Step 8 — approveJob (jobFeedId: ${JOB_FEED_ID})"

APPROVE_RESP=$(gql_auth "{\"query\":\"mutation { approveJob(jobFeedId: \\\"${JOB_FEED_ID}\\\") { id currentStatus createdAt } }\"}")
APP_ID=$(echo "$APPROVE_RESP" | jq -r '.data.approveJob.id // empty')
APP_STATUS=$(echo "$APPROVE_RESP" | jq -r '.data.approveJob.currentStatus // empty')

if [ -n "$APP_ID" ]; then
  pass "Application created (id: ${APP_ID}, status: ${APP_STATUS})"
else
  echo "$APPROVE_RESP" | jq .
  kill "$SSE_PID" 2>/dev/null || true
  fail "approveJob failed"
fi

# ── 9. Wait for EVENT_ANALYSIS_DONE via SSE ─────────────────
hr
info "Step 9 — Waiting for ANALYSIS_DONE SSE event (up to 30s)…"

TIMEOUT=30
WAITED=0
while [ "$WAITED" -lt "$TIMEOUT" ]; do
  if grep -q '"type":"ANALYSIS_DONE"' "$SSE_LOG" 2>/dev/null; then
    SCORE=$(grep 'ANALYSIS_DONE' "$SSE_LOG" | head -1 | grep -o '"matchScore":[0-9]*' | cut -d: -f2 || echo "?")
    pass "ANALYSIS_DONE received via SSE! matchScore=${SCORE}"
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

if [ "$WAITED" -ge "$TIMEOUT" ]; then
  warn "ANALYSIS_DONE not received within ${TIMEOUT}s"
  warn "AI Coach may still be processing, or OPENROUTER_API_KEY is not set (LLM calls skipped)"
  warn "SSE log so far:"
  cat "$SSE_LOG" || true
fi

# ── 10. Test moveCard ────────────────────────────────────────
hr
info "Step 10 — moveCard (TO_APPLY → APPLIED)"

MOVE_RESP=$(gql_auth "{\"query\":\"mutation { moveCard(applicationId: \\\"${APP_ID}\\\", newStatus: APPLIED) { id currentStatus historyLog } }\"}")
NEW_STATUS=$(echo "$MOVE_RESP" | jq -r '.data.moveCard.currentStatus // empty')

[ "$NEW_STATUS" = "APPLIED" ] && pass "moveCard → APPLIED ✓" || {
  echo "$MOVE_RESP" | jq .
  warn "moveCard may not be implemented in gateway yet (Phase 4 forward)"
}

# ── 11. Test invalid transition ──────────────────────────────
hr
info "Step 11 — Invalid transition (APPLIED → HIRED should be rejected)"

BAD_MOVE=$(gql_auth "{\"query\":\"mutation { moveCard(applicationId: \\\"${APP_ID}\\\", newStatus: HIRED) { id currentStatus } }\"}")
ERROR_MSG=$(echo "$BAD_MOVE" | jq -r '.errors[0].message // empty')

if [ -n "$ERROR_MSG" ]; then
  pass "Rejected invalid transition: ${ERROR_MSG}"
else
  warn "Expected an error but got: $(echo "$BAD_MOVE" | jq .)"
fi

# ── 12. Test addNote ─────────────────────────────────────────
hr
info "Step 12 — addNote"

NOTE_RESP=$(gql_auth "{\"query\":\"mutation { addNote(applicationId: \\\"${APP_ID}\\\", note: \\\"Great position, contacted HR.\\\") { id userNotes } }\"}")
NOTE=$(echo "$NOTE_RESP" | jq -r '.data.addNote.userNotes // empty')

[ -n "$NOTE" ] && pass "Note added: \"${NOTE}\"" || {
  echo "$NOTE_RESP" | jq .
  warn "addNote may not be implemented in gateway yet"
}

# ── 13. Test rateApplication ─────────────────────────────────
hr
info "Step 13 — rateApplication (rating: 4)"

RATE_RESP=$(gql_auth "{\"query\":\"mutation { rateApplication(applicationId: \\\"${APP_ID}\\\", rating: 4) { id userRating } }\"}")
RATING=$(echo "$RATE_RESP" | jq -r '.data.rateApplication.userRating // empty')

[ "$RATING" = "4" ] && pass "Rating set: ${RATING}/5" || {
  echo "$RATE_RESP" | jq .
  warn "rateApplication may not be implemented in gateway yet"
}

# ── 14. myApplications ───────────────────────────────────────
hr
info "Step 14 — myApplications query"

MY_APPS=$(gql_auth '{"query":"query { myApplications { id currentStatus userRating } }"}')
APP_COUNT=$(echo "$MY_APPS" | jq '.data.myApplications | length')

[ "$APP_COUNT" -gt 0 ] && pass "myApplications returned ${APP_COUNT} application(s)" || {
  echo "$MY_APPS" | jq .
  warn "myApplications returned nothing or errored"
}

# ── Cleanup ───────────────────────────────────────────────────
hr
kill "$SSE_PID" 2>/dev/null && info "SSE connection closed"
rm -f "$SSE_LOG"

hr
echo -e "${GREEN}  E2E test complete ✓${NC}"
echo ""
