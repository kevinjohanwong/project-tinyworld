#!/usr/bin/env bash
# Focused re-capture: load a specific world, wait for sentinel GLB, frame it,
# then capture an overview + each component shot with proper framing.
# Every shot is preceded by an explicit frameWorld() / camera placement so the
# scene is actually visible instead of an eye-level ground plane.
set -euo pipefail

BASE="${1:-http://localhost:3099}"
WORLD="${2:-w_mqr26u6z_hj4336}"
OUT="${3:-/home/workspace/project-tinyworld/debug-shots/recap-$(date -u +%Y%m%dT%H%M%SZ)}"
URL="$BASE/tinyworld?debug=1&world=$WORLD"

mkdir -p "$OUT"
echo "OUT=$OUT"
echo "URL=$URL"

agent-browser open "$URL" >/dev/null
agent-browser set viewport 1440 980 >/dev/null || true

# Give the world build + sentinel.glb (844KB via esm.sh GLTFLoader) time to load.
echo "[wait] world build + sentinel load (12s)"
agent-browser wait 12000 >/dev/null || true

# Probe: did the world build, did sentinel load, render error?
agent-browser eval --stdin > "$OUT/state-initial.json" <<'JS' || true
JSON.stringify({
  url: location.href,
  hasHarness: !!window.__tw,
  loopError: !!window.__twLoopError,
  state: window.__tw?.state?.() ?? null,
  sentinel: window.__tw?.sentinelInfo?.() ?? null,
  drone: window.__tw?.droneInfo?.() ?? null,
}, null, 2)
JS

# Frame the world for an overview shot.
agent-browser eval --stdin > "$OUT/frame-overview.json" <<'JS' || true
JSON.stringify(window.__tw?.frameWorld?.() ?? {ok:false, reason:"no harness"})
JS
agent-browser wait 800 >/dev/null || true
agent-browser screenshot "$OUT/A-overview-framed.png" >/dev/null
echo "[shot] A-overview-framed"

# Component: void scout — spawn then frame so the creature is in view.
agent-browser eval --stdin > "$OUT/hook-void.json" <<'JS' || true
const r = { spawned: window.__tw?.spawnCreature?.() ?? null };
r.frame = window.__tw?.frameWorld?.() ?? null;
r.void = window.__tw?.voidInfo?.() ?? null;
JSON.stringify(r)
JS
agent-browser wait 1200 >/dev/null || true
agent-browser screenshot "$OUT/B-void-scout.png" >/dev/null
echo "[shot] B-void-scout"

# Component: sentinel walk mode + drone toggle.
agent-browser eval --stdin > "$OUT/hook-drone.json" <<'JS' || true
const r = {};
r.sentinelBefore = window.__tw?.sentinelInfo?.() ?? null;
r.toggle = window.__tw?.setSentinelMode?.("drone") ?? null;
JSON.stringify(r)
JS
agent-browser wait 1500 >/dev/null || true
agent-browser eval --stdin > "$OUT/state-drone.json" <<'JS' || true
JSON.stringify({ sentinel: window.__tw?.sentinelInfo?.()??null, drone: window.__tw?.droneInfo?.()??null }, null, 2)
JS
agent-browser screenshot "$OUT/C-drone-mode.png" >/dev/null
echo "[shot] C-drone-mode"

# Component: ship + pilot. Build a ship first, then enter pilot.
agent-browser eval --stdin > "$OUT/hook-pilot.json" <<'JS' || true
const r = {};
r.build = window.__tw?.buildShip?.() ?? null;
r.ships = window.__tw?.shipInfo?.() ?? null;
r.enter = window.__tw?.pilot?.enter?.(0) ?? null;
r.active = window.__tw?.pilot?.active?.() ?? null;
JSON.stringify(r)
JS
agent-browser wait 1500 >/dev/null || true
agent-browser screenshot "$OUT/D-pilot.png" >/dev/null
echo "[shot] D-pilot"

# Component: placement settle FX.
agent-browser eval --stdin > "$OUT/hook-settle.json" <<'JS' || true
window.__tw?.pilot?.exit?.(true);
const r = { settle: window.__tw?.settleTest?.() ?? null };
r.frame = window.__tw?.frameWorld?.() ?? null;
JSON.stringify(r)
JS
agent-browser wait 400 >/dev/null || true
agent-browser screenshot "$OUT/E-settle-fx.png" >/dev/null
echo "[shot] E-settle-fx"

agent-browser errors > "$OUT/browser-errors.txt" 2>&1 || true
agent-browser console > "$OUT/browser-console.txt" 2>&1 || true
echo "DONE $OUT"
