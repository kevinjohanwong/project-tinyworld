#!/bin/bash
# cap.sh <passlabel> — reload lab, capture 4 TODs, build ref-vs-ours montage
cd /home/workspace/project-tinyworld/clouds-lab
LABEL="${1:-pass}"
REF=../references/clouds/time-of-day
agent-browser close --all >/dev/null 2>&1; sleep 1
rm -f out/voxel-*.png out/DONE.txt
timeout 35 agent-browser open "http://localhost:4599/voxel.html?t=$(date +%s)" >/dev/null 2>&1
for i in $(seq 1 30); do [ -f out/DONE.txt ] && break; sleep 1; done
[ -f out/DONE.txt ] || { echo "NO DONE — capture failed"; ls out/; exit 1; }
declare -A RM=( [day]=day-ghibli-2.jpg [dusk]=dusk-botw-1.jpg [dawn]=dawn-sky-1.jpg [night]=night-genshin-1.jpg )
for tod in day dusk dawn night; do
  convert "$REF/${RM[$tod]}" -resize 560x315^ -gravity center -extent 560x315 /tmp/r-$tod.png
  convert out/voxel-$tod.png -resize 560x315^ -gravity center -extent 560x315 /tmp/o-$tod.png
  convert /tmp/r-$tod.png /tmp/o-$tod.png +append -gravity northwest \
    -fill '#0f0' -pointsize 20 -annotate +8+4 "REF $tod" \
    -fill '#ff0' -pointsize 20 -annotate +568+4 "OURS $tod" /tmp/row-$tod.png
done
OUT="/tmp/cmp-$LABEL.png"
convert /tmp/row-day.png /tmp/row-dusk.png /tmp/row-dawn.png /tmp/row-night.png -append \
  -bordercolor '#000' -border 4 "$OUT"
echo "built $OUT"
