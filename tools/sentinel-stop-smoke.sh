#!/usr/bin/env bash
# Smoke test for the phase-matched Sentinel stop (settle) logic in staging.
# Validates: anim harness wired, WalkSlow action present, freeze-at-phase works,
# settle state machine reachable (settling->stopped) on a movement release edge,
# and the frame loop never throws (__twLoopError stays false).
#
# Usage: ./sentinel-stop-smoke.sh [base-url]   (default http://localhost:3099)
set -u
BASE="${1:-http://localhost:3099}"
E() { agent-browser eval "$1"; }

echo "── open staging (debug)"
agent-browser open "$BASE/tinyworld-staging?debug=1" || exit 1
sleep 5

echo "── loop-error after boot"
E "JSON.stringify({loopErr: !!window.__twLoopError, hasTw: !!window.__tw, hasAnim: !!(window.__tw && window.__tw.sentinelAnim)})"

echo "── load first saved world (best-effort)"
agent-browser click "button" || echo "(no world button — continuing avatar-only)"
sleep 10

echo "── embody as third-person Sentinel"
E "JSON.stringify(window.__tw.setPilotMode ? window.__tw.setPilotMode('third') : 'no setPilotMode')"
sleep 6

echo "── baseline anim state (Sentinel GLB should be loaded)"
E "JSON.stringify(window.__tw.sentinelAnim ? window.__tw.sentinelAnim() : 'no sentinelAnim')"

echo "── freeze at phase 0.25"
E "JSON.stringify(window.__tw.sentinelFreezeAt ? window.__tw.sentinelFreezeAt(0.25) : 'no freeze')"
sleep 1
E "JSON.stringify(window.__tw.sentinelAnim())"

echo "── freeze at phase 0.75"
E "JSON.stringify(window.__tw.sentinelFreezeAt(0.75))"
sleep 1
E "JSON.stringify(window.__tw.sentinelAnim())"

echo "── drive movement (KeyW 4s) — watch gaitTS go positive"
E "window.__tw.look(0); window.__tw.press('KeyW', 4000); 'pressing'"
sleep 2
echo "   (mid-press)"; E "JSON.stringify(window.__tw.sentinelAnim())"
sleep 3
echo "   (post-release) poll for settle:"
for i in 1 2 3 4 5 6; do
  E "JSON.stringify(window.__tw.sentinelAnim())"
  sleep 1
done

echo "── final loop-error check"
E "JSON.stringify({loopErr: !!window.__twLoopError})"
echo "── done"
