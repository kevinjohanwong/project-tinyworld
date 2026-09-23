#!/usr/bin/env bash
# TinyWorld route guard. Container reboots re-materialize the generated
# /api/tinyworld-capture + /api/tinyworld-infer route files from the backend
# version store, which holds STALE pre-merge code (observed 2026-07-01 and
# again 2026-07-02 15:00 — the merge-at-most pipeline silently reverted).
# This loop watches for the marker symbols and reapplies the verified-good
# routes (disk + .routes.json + zo-space restart) whenever they vanish.
# Runs under the user supervisord so it survives reboots.
set -u

DISK_CAPTURE="/__substrate/space/routes/api/api-tinyworld-capture.ts"
DISK_INFER="/__substrate/space/routes/api/api-tinyworld-infer.ts"
DISK_CAPTURE_PAGE="/__substrate/space/routes/pages/tinyworld-capture.tsx"
REAPPLY="/home/workspace/project-tinyworld/.route-backups/reapply-merge-routes.sh"

echo "[route-guard] started $(date -u +%FT%TZ)"
while true; do
  stale=""
  grep -qF "runMergeAttempt" "$DISK_INFER" 2>/dev/null || stale="infer"
  grep -qF "sweepOrphanedInferring" "$DISK_INFER" 2>/dev/null || stale="infer"
  grep -qF "notifyScanResult" "$DISK_INFER" 2>/dev/null || stale="infer"
  grep -qF "merge_candidate_world_id" "$DISK_CAPTURE" 2>/dev/null || stale="${stale:+$stale+}capture"
  grep -qF "COACH_ROT_DEG_S" "$DISK_CAPTURE_PAGE" 2>/dev/null || stale="${stale:+$stale+}page"
  grep -qF "const SCAN_BANK_START_S = 45" "$DISK_CAPTURE_PAGE" 2>/dev/null || stale="${stale:+$stale+}page"
  if [ -n "$stale" ]; then
    echo "[route-guard] $(date -u +%FT%TZ) stale routes detected ($stale) — reapplying"
    bash "$REAPPLY" && echo "[route-guard] reapply OK" || echo "[route-guard] reapply FAILED"
    sleep 60
  fi
  sleep 120
done
