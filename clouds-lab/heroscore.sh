#!/bin/bash
# heroscore.sh [urlparams] — capture the hero tower + score vs reference
cd /home/workspace/project-tinyworld/clouds-lab
rm -f out/hero.png out/DONE.txt
agent-browser close --all >/dev/null 2>&1; sleep 1
timeout 40 agent-browser open "http://localhost:4599/hero.html?t=$(date +%s)&$1" >/dev/null 2>&1
for i in $(seq 1 30); do [ -f out/DONE.txt ] && break; sleep 1; done
[ -f out/DONE.txt ] || { echo "NO DONE — capture failed"; exit 1; }
python3 score.py
