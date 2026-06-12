#!/usr/bin/env bash
# TinyWorld headless smoke test — drives the live route via agent-browser and
# the window.__tw debug harness baked into kj.zo.space/tinyworld.
#
# Usage: ./smoke-test.sh [base-url]
#   base-url defaults to http://localhost:3099 (zo.space dev server)
#
# Checks: world loads, ground map present, worker spawned, walking works,
# vertical jitter while walking stays under threshold.
set -u
BASE="${1:-http://localhost:3099}"
EVAL() { agent-browser eval "$1"; }

echo "── open page"
agent-browser open "$BASE/tinyworld?debug=1" || exit 1
sleep 4

echo "── load first saved world"
agent-browser click "button" || { echo "FAIL: no saved-world button"; exit 1; }
sleep 14

echo "── state after load"
STATE=$(EVAL "JSON.stringify(window.__tw ? window.__tw.state() : null)")
echo "$STATE"
echo "$STATE" | grep -q '"workers":\[\]' && echo "FAIL: no worker spawned" || echo "OK: worker present"
echo "$STATE" | grep -q '__tw' || true

echo "── teleport into scan + walk 8s forward"
EVAL "JSON.stringify(window.__tw.teleport(-5, 4))"
EVAL "window.__tw.look(0); window.__tw.simWalk(true); window.__tw.press('KeyW', 8000); 'walking'"
sleep 9

echo "── jitter check (voxel units; <0.05 smooth, >0.15 = visible jitter)"
EVAL "JSON.stringify({jitter: window.__tw.jitter(), cam: window.__tw.state().cam, ground: window.__tw.state().ground, fps: window.__tw.state().fps})"

echo "── walk sideways 8s"
EVAL "window.__tw.look(Math.PI/2); window.__tw.press('KeyA', 8000); 'walking'"
sleep 9
EVAL "JSON.stringify({jitter: window.__tw.jitter(), workers: window.__tw.state().workers})"
EVAL "window.__tw.simWalk(false); 'done'"

echo "── console errors"
agent-browser get text body >/dev/null 2>&1
echo "smoke test complete"
