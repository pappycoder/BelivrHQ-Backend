#!/usr/bin/env bash
# Updates BelivrHQ GitHub Project board — marks completed backend tasks as Done.
# Requires: gh CLI authenticated with read:project,project scopes
# Run: bash scripts/update-project-board.sh
#
# IMPORTANT: Replace PVTI_NEW_* placeholder IDs with actual IDs from your
# GitHub Project board. Find them via:
#   gh api graphql -f 'query="{ organization(login:"pappycoder") { projectV2(number:2) { items(first:100) { nodes { id title } } } } }"'
# Then copy the `id` field for each task title.

set -euo pipefail

PROJECT_ID="PVT_kwDOEiqVYc4BdWCP"
STATUS_FIELD_ID="PVTSSF_lADOEiqVYc4BdWCPzhX4OdM"
DONE_OPTION_ID="98236657"
BATCH_SIZE=5

declare -a ITEM_IDS=(
  # ── Phase 0 (In progress → Done) ──────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRKI"  # #3  Supabase module
  "PVTI_lADOEiqVYc4BdWCPzgywRLQ"  # #4  Database migrations
  "PVTI_lADOEiqVYc4BdWCPzgywRMM"  # #5  RLS policies
  "PVTI_lADOEiqVYc4BdWCPzgywRM8"  # #6  Auth guard
  "PVTI_lADOEiqVYc4BdWCPzgywROU"  # #7  RBAC
  "PVTI_lADOEiqVYc4BdWCPzgywRP4"  # #8  Exception filter + interceptor
  "PVTI_lADOEiqVYc4BdWCPzgywRQ4"  # #9  Logging + audit
  "PVTI_lADOEiqVYc4BdWCPzgywRSI"  # #10 Dockerfile
  "PVTI_lADOEiqVYc4BdWCPzgywRTs"  # #11 CI/CD
  # ── Phase 1 (Todo → Done) — Auth ──────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRU0"  # #12 Church registration
  # ── Phase 1 — Members ─────────────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRWs"  # #14 Members CRUD
  "PVTI_lADOEiqVYc4BdWCPzgywRX4"  # #15 Members API endpoints
  "PVTI_lADOEiqVYc4BdWCPzgywRY4"  # #16 Members search/pagination
  "PVTI_lADOEiqVYc4BdWCPzgywRZ8"  # #17 CSV bulk import
  "PVTI_lADOEiqVYc4BdWCPzgywRa4"  # #18 QR code generation
  "PVTI_lADOEiqVYc4BdWCPzgywRcM"  # #19 Family management
  # ── Phase 1 — Attendance ──────────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRdM"  # #20 Services CRUD
  "PVTI_lADOEiqVYc4BdWCPzgywReQ"  # #21 Attendance recording
  "PVTI_lADOEiqVYc4BdWCPzgywRfQ"  # #22 Attendance summary/trends
  "PVTI_lADOEiqVYc4BdWCPzgywRgE"  # #23 Visitor attendance
  # ── Phase 1 — Giving ─────────────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRg4"  # #24 Giving categories
  "PVTI_lADOEiqVYc4BdWCPzgywRh0"  # #25 Paystack initialization
  "PVTI_lADOEiqVYc4BdWCPzgywRjA"  # #26 Paystack webhook
  "PVTI_lADOEiqVYc4BdWCPzgywRkE"  # #27 Cash giving
  "PVTI_lADOEiqVYc4BdWCPzgywRlU"  # #28 Giving summary report
  "PVTI_lADOEiqVYc4BdWCPzgywRnA"  # #29 PDF receipt generation
  # ── Phase 1 — WhatsApp ────────────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRos"  # #30 360dialog webhook
  "PVTI_lADOEiqVYc4BdWCPzgywRqE"  # #31 Command router
  "PVTI_lADOEiqVYc4BdWCPzgywRrQ"  # #32 CHECKIN command
  "PVTI_lADOEiqVYc4BdWCPzgywRsQ"  # #33 GIVE command
  "PVTI_lADOEiqVYc4BdWCPzgywRto"  # #34 HELP command
  "PVTI_lADOEiqVYc4BdWCPzgywRuQ"  # #35 Message logging
  # ── Phase 1 — Events ──────────────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRwM"  # #37 Event CRUD
  "PVTI_lADOEiqVYc4BdWCPzgywRxU"  # #38 Free event registration
  # ── Phase 1 — Media/Sermons ───────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRyI"  # #39 Sermon upload
  "PVTI_lADOEiqVYc4BdWCPzgywRyo"  # #40 Sermon listing/search
  # ── Phase 2 (Todo → Done) ─────────────────────────────────────────
  "PVTI_lADOEiqVYc4BdWCPzgywRzc"  # #41 Flutterwave integration
  "PVTI_lADOEiqVYc4BdWCPzgywR0Y"  # #42 Payment processor failover

  # ── Phase 4 — Sprint Day 3 (Todo → Done) ──────────────────────────
  # TODO: Replace PVTI_NEW_* with actual IDs from your project board
  "PVTI_NEW_NOTIFICATIONS_MODULE"   # NotificationsModule (4 endpoints, 8 tests, @Global)
  "PVTI_NEW_SYNC_MODULE"            # SyncModule (3 endpoints, 7 tests, idempotency + conflict resolution)
  "PVTI_NEW_NOTIFICATION_WIRING"    # NotificationsService wired into Giving/Members/Events/Broadcast/Scoring

  # ── Phase 4 — Sprint Day 4 (Todo → Done) ──────────────────────────
  # TODO: Replace PVTI_NEW_* with actual IDs from your project board
  "PVTI_NEW_ROLE_GUARDS"            # Role guards fixed (admin 18, pastoral 11, analytics 6, members 6 endpoints)
  "PVTI_NEW_REPORTS_MODULE"         # ReportsModule (4 endpoints: financial, attendance, members, CSV export)
  "PVTI_NEW_WEBHOOKS_MODULE"        # WebhooksModule (5 endpoints + BullMQ processor + HMAC-SHA256 delivery)
  "PVTI_NEW_SWAGGER_CLEANUP"        # Swagger: 64 bare @ApiProperty() calls eliminated across 6 DTO files
  "PVTI_NEW_QUEUE_HARDENING"        # DLQ queue + @OnQueueFailed (nightly-jobs) + @OnQueueCompleted (recurring-giving)
  "PVTI_NEW_LINT_CLEANUP"           # 8 any types in delete-data.ts fixed
  "PVTI_NEW_TESTS_SPRINT4"          # 20 new tests (reports: 7, webhooks: 10, DLQ: 3)
  "PVTI_NEW_WIRING_FIXES"           # Health check: all 8 queues monitored, WebhooksModule graceful shutdown
)

TOTAL=${#ITEM_IDS[@]}
SUCCESS=0
FAILED=0

echo "Updating $TOTAL items on BelivrHQ GitHub Project board..."

for ((i=0; i<TOTAL; i+=BATCH_SIZE)); do
  MUTATION=""
  for ((j=0; j<BATCH_SIZE && i+j<TOTAL; j++)); do
    IDX=$((i+j))
    ITEM_ID="${ITEM_IDS[$IDX]}"
    MUTATION+="
      a${j}: updateProjectV2ItemFieldValue(
        input: {
          projectId: \"$PROJECT_ID\"
          itemId: \"$ITEM_ID\"
          fieldId: \"$STATUS_FIELD_ID\"
          value: { singleSelectOptionId: \"$DONE_OPTION_ID\" }
        }
      ) { projectV2Item { id } }"
  done

  QUERY="mutation { $MUTATION }"

  RESP=$(gh api graphql -f "query=$QUERY" 2>&1) || true

  if echo "$RESP" | grep -q '"errors"'; then
    ERR_MSG=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['errors'][0].get('message','unknown')[:100])" 2>/dev/null || echo "$RESP" | head -1)
    echo "  ✗ Batch starting at $((i+1))/$TOTAL failed: $ERR_MSG"
    FAILED=$((FAILED + BATCH_SIZE))
  else
    BATCH_COUNT=$((BATCH_SIZE < TOTAL-i ? BATCH_SIZE : TOTAL-i))
    SUCCESS=$((SUCCESS + BATCH_COUNT))
    echo "  ✓ Items $((i+1))-$((i+BATCH_COUNT))/$TOTAL updated"
  fi

  sleep 0.3
done

echo ""
echo "Complete: $SUCCESS succeeded, $FAILED failed out of $TOTAL"
echo ""
echo "Note: $TOTAL items marked. 38 from previous runs + 11 new (sprint day 3-4)."
echo "Replace PVTI_NEW_* placeholders with actual project board item IDs before running."
