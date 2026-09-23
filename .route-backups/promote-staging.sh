#!/usr/bin/env bash
# ── "Invite to main" ────────────────────────────────────────────────────────
# Promote the /tinyworld-staging route to production /tinyworld.
#
# WORKFLOW (KJ's staging model):
#   1. Edits land in routes/pages/tinyworld-staging.tsx  (served at /tinyworld-staging)
#   2. KJ tests /tinyworld-staging on his phone.
#   3. On approval, KJ runs THIS script to push staging -> production /tinyworld.
#
# This is the consequential, public-facing step — run it only when KJ has
# approved the staged build. It is reversible: a timestamped snapshot of the
# previous live route is saved first (see the rollback line printed at the end).
#
# DURABILITY CAVEAT: this promotes on DISK (survives `supervisorctl restart`,
# served immediately). It does NOT write the zo backend version store, so a full
# CONTAINER REBOOT can still re-materialize an older route. After a reboot, run
# reapply-framing.sh to restore. (Re-pointing reapply-framing.sh's baseline at a
# promoted snapshot is a manual follow-up — its marker list is tuned per-branch.)
set -euo pipefail

PAGES="/__substrate/space/routes/pages"
STAGING="$PAGES/tinyworld-staging.tsx"
LIVE="$PAGES/tinyworld.tsx"
SPACE_DIR="/__substrate/space"
BK_DIR="/home/workspace/project-tinyworld/.route-backups"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

[ -f "$STAGING" ] || { echo "FATAL: staging route missing: $STAGING"; exit 1; }
[ -f "$LIVE" ]    || { echo "FATAL: live route missing: $LIVE"; exit 1; }

if diff -q "$STAGING" "$LIVE" >/dev/null 2>&1; then
  echo "No diff between staging and live — nothing to promote."
  exit 0
fi

echo "[1/5] Snapshotting current live route (rollback point)..."
PRE="$BK_DIR/tinyworld-${TS}-pre-promote-live.tsx"
cp "$LIVE" "$PRE"

echo "[2/5] Promoting staging -> live..."
cp "$STAGING" "$LIVE"
cp "$LIVE" "$BK_DIR/tinyworld-${TS}-PROMOTED-from-staging.tsx"

echo "[3/5] Building (vite)..."
( cd "$SPACE_DIR" && bun run build )

echo "[4/5] Restarting zo-space server..."
supervisorctl -s http://127.0.0.1:29001 restart zo-space || \
  supervisorctl restart zo-space

echo "[5/5] Verifying served production bundle..."
sleep 2
TW=$(ls -1t "$SPACE_DIR"/dist/assets/tinyworld-*.js 2>/dev/null | grep -v -e staging -e capture | head -1 || true)
if [ -n "$TW" ] && grep -q "3rd Person" "$TW"; then
  echo "DONE ✅  /tinyworld now serves the promoted route ($(basename "$TW"))."
else
  echo "WARN: could not confirm '3rd Person' marker in served bundle; check manually."
fi

echo
echo "ROLLBACK if needed:"
echo "  cp '$PRE' '$LIVE' && ( cd '$SPACE_DIR' && bun run build ) && supervisorctl -s http://127.0.0.1:29001 restart zo-space"
