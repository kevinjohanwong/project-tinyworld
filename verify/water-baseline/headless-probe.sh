#!/usr/bin/env bash
# Headless sanity probe (SwiftShader): open the debug world, wait, dump report + errors.
OUT=/home/workspace/project-tinyworld/verify/water-baseline/headless.log
exec > "$OUT" 2>&1
agent-browser close --all >/dev/null 2>&1
agent-browser open "http://127.0.0.1:3099/tinyworld-staging?debugWorld=1&tod=day&debug=1" || { echo OPEN_FAILED; exit 1; }
agent-browser set viewport 1280 720
for i in $(seq 1 150); do
  sleep 2
  R=$(agent-browser eval "JSON.stringify(!!window.__twPWater && window.__twPWater.report().count>0)" 2>/dev/null)
  [ "$R" = "true" ] && { echo "water at $((i*2))s"; break; }
done
sleep 20
echo "=== REPORT"; agent-browser eval "JSON.stringify(window.__twPWater ? (({simK,count,warmupLeft,fall,hifi,report}) => ({simK,count,warmupLeft,fall,curtains:hifi&&hifi.curtains,ledger:report}))(window.__twPWater.report()) : {none:true, err:String(window.__twPWaterError||'')})"
echo "=== ERRORS"; agent-browser errors 2>&1 | head -30
echo "=== CONSOLE (pwater/curtain/three)"; agent-browser console 2>&1 | grep -iE "pwater|curtain|THREE|error|warn" | head -20
echo DONE
