#!/usr/bin/env bash
# TinyWorld visual debug capture.
#
# Opens /tinyworld?debug=1, optionally clicks the first saved-world button,
# triggers a debug hook when the scene harness exists, and saves screenshots
# plus a JSON state probe. This is meant for the change-build-load-run-
# screenshot-verify loop, not for gameplay QA.
#
# Usage:
#   tools/debug-screenshot.sh [base-url] [output-dir]
#
# Examples:
#   tools/debug-screenshot.sh
#   tools/debug-screenshot.sh http://localhost:3099 /tmp/tw-debug
#
# Env:
#   TW_LOAD_FIRST=1        click the first saved-world button before probing
#   TW_HOOK=settle         settle | drone | void | opening | pilot | frame | none
#   TW_WAIT_MS=8000        wait after optional load/hook before final capture

set -euo pipefail

BASE="${1:-http://localhost:3099}"
OUT="${2:-/home/workspace/project-tinyworld/debug-shots/$(date -u +%Y%m%dT%H%M%SZ)}"
LOAD_FIRST="${TW_LOAD_FIRST:-0}"
HOOK="${TW_HOOK:-settle}"
WAIT_MS="${TW_WAIT_MS:-8000}"
URL="$BASE/tinyworld?debug=1"

mkdir -p "$OUT"

echo "[1/6] Opening $URL"
agent-browser open "$URL" >/dev/null
agent-browser set viewport 1440 980 >/dev/null || true
agent-browser wait 2500 >/dev/null || true
agent-browser screenshot "$OUT/01-open.png" >/dev/null

if [ "$LOAD_FIRST" = "1" ]; then
  echo "[2/6] Attempting to load first saved world"
  agent-browser click "button" >/dev/null || true
  agent-browser wait "$WAIT_MS" >/dev/null || true
else
  echo "[2/6] Skipping saved-world click (TW_LOAD_FIRST=0)"
fi

echo "[3/6] Capturing pre-hook state"
agent-browser screenshot "$OUT/02-before-hook.png" >/dev/null
cat > "$OUT/state-before.json" <<'JSON'
{}
JSON
agent-browser eval --stdin > "$OUT/state-before.json" <<'JS' || true
JSON.stringify({
  url: location.href,
  hasHarness: !!window.__tw,
  hasDebugPanel: !!document.querySelector("[data-tw-debug-panel]"),
  loopError: !!window.__twLoopError,
  state: window.__tw?.state?.() ?? null,
  fx: window.__tw?.fxInfo?.() ?? null,
  sentinel: window.__tw?.sentinelInfo?.() ?? null,
  drone: window.__tw?.droneInfo?.() ?? null,
})
JS

echo "[4/6] Triggering hook: $HOOK"
agent-browser eval --stdin > "$OUT/hook-result.json" <<JS || true
const hook = "$HOOK";
let result = null;
if (!window.__tw) {
  result = { ok: false, reason: "window.__tw not initialized; load/build a world first" };
} else if (hook === "settle") {
  result = window.__tw.settleTest?.();
} else if (hook === "drone") {
  const mode = window.__tw.droneInfo?.()?.mode === "drone" ? "large" : "drone";
  result = window.__tw.setSentinelMode?.(mode);
} else if (hook === "void") {
  result = window.__tw.spawnCreature?.();
} else if (hook === "opening") {
  result = window.__tw.orb?.play?.();
} else if (hook === "pilot") {
  result = window.__tw.pilot?.enter?.(0);
} else if (hook === "frame") {
  result = window.__tw.frameWorld?.();
} else if (hook === "none") {
  result = { ok: true, skipped: true };
} else {
  result = { ok: false, reason: "unknown hook", hook };
}
JSON.stringify(result ?? null);
JS

agent-browser wait "$WAIT_MS" >/dev/null || true

echo "[5/6] Capturing post-hook state"
agent-browser screenshot "$OUT/03-after-hook.png" >/dev/null
agent-browser eval --stdin > "$OUT/state-after.json" <<'JS' || true
JSON.stringify({
  url: location.href,
  hasHarness: !!window.__tw,
  hasDebugPanel: !!document.querySelector("[data-tw-debug-panel]"),
  loopError: !!window.__twLoopError,
  state: window.__tw?.state?.() ?? null,
  fx: window.__tw?.fxInfo?.() ?? null,
  sentinel: window.__tw?.sentinelInfo?.() ?? null,
  drone: window.__tw?.droneInfo?.() ?? null,
})
JS

echo "[6/6] Capturing browser errors"
agent-browser errors > "$OUT/browser-errors.txt" 2>&1 || true
agent-browser console > "$OUT/browser-console.txt" 2>&1 || true

echo "DONE $OUT"
