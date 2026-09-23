#!/usr/bin/env bash
# Drives a real movement->release edge on the already-embodied Sentinel and
# polls sentinelAnim() to confirm the settle state machine runs:
#   gaitTS goes positive while moving -> on release, settling:true ->
#   eases to a target phase -> stopped:true. Assumes a world is loaded and
#   the Sentinel is embodied (run sentinel-stop-smoke first, or load+embody).
set -u
E() { agent-browser eval "$1"; }

echo "── face forward + press KeyW 5s"
E "window.__tw.look(0); window.__tw.press('KeyW', 5000); 'pressing'"
sleep 2
echo "── mid-press (expect gaitTS > 0):"
E "JSON.stringify(window.__tw.sentinelAnim())"
sleep 4
echo "── post-release poll (expect settling:true then stopped:true):"
for i in 1 2 3 4 5 6 7 8; do
  E "JSON.stringify(window.__tw.sentinelAnim())"
  sleep 1
done
echo "── loopErr:"
E "JSON.stringify({loopErr:!!window.__twLoopError})"
echo "── done"
