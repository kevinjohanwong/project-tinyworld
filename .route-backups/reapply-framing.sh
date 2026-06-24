#!/usr/bin/env bash
# Reboot-recovery for the tinyworld /tinyworld route.
#
# WHY this exists:
#   The crash fix (`const speed = MOVE_SPEED * dt`), progressive-scan framing,
#   physical FX, Sentinel grounding, the cockpit-view/drone-fix slice, AND the
#   Voxel Robots Sentinel animation loader are
#   durable in the zo backend route file, but a full container reboot
#   re-materializes the route from the backend version store and can drop them.
#   This script re-applies the known-good live route from the latest backup.
#
# WHEN to run: after a full container reboot, if new scans frame into the void,
#   the cockpit HUD / view toggle is missing, the drone fails to render, or the
#   Sentinel reverts to the old animation bundle.
#
# It is idempotent: if the live route already matches, it is a no-op build+restart.

set -euo pipefail

BACKUP="/home/workspace/project-tinyworld/.route-backups/tinyworld-20260624T162545Z-voxel-robots-sentinel-live.tsx"
ROUTE="/__substrate/space/routes/pages/tinyworld.tsx"
SPACE_DIR="/__substrate/space"

[ -f "$BACKUP" ] || { echo "FATAL: backup missing: $BACKUP"; exit 1; }
[ -f "$ROUTE" ]  || { echo "FATAL: route missing: $ROUTE"; exit 1; }

echo "[1/4] Restoring cockpit-view + drone-fix + grounding + framing + Voxel Robots Sentinel route from backup..."
cp "$BACKUP" "$ROUTE"

echo "[2/4] Verifying live markers on disk..."
need=(
  "const speed = MOVE_SPEED \\* dt"
  "frameWorld:"
  "composerRef.current.render()"
  "TINYWORLD DEBUG"
  "droneRig.rotation.set(dronePitch"
  "let sentinelFeetY = 0"
  "thirdPersonRig.sentinelForward = viewModeRef.current"
  "const camLiftFor = ()"
  "eyeGroundY + EYE_HEIGHT + camLiftFor()"
  "PILOT SYNCHRONIZATION"
  "const setSlotTone"
  "MechaGolem_AllAnimExport"
  "AnimationUtils.subclip"
)
for m in "${need[@]}"; do
  grep -q "$m" "$ROUTE" || { echo "FATAL: marker missing after restore: $m"; exit 1; }
done
echo "      all markers present."

echo "[3/4] Building (vite)..."
( cd "$SPACE_DIR" && bun run build )

echo "[4/4] Restarting zo-space server..."
supervisorctl -c /etc/zo/supervisor.conf restart zo-space || \
  supervisorctl restart zo-space

echo
echo "Verifying served bundle has cockpit HUD + framing + render + Voxel Robots Sentinel..."
sleep 2
TW=$(ls -1t "$SPACE_DIR"/dist/assets/tinyworld-*.js 2>/dev/null | grep -v capture | head -1 || true)
if [ -n "$TW" ] && grep -q "PILOT SYNCHRONIZATION" "$TW" && grep -q "frameWorld" "$TW" && grep -q "\\.render(" "$TW" && grep -q "MechaGolem_AllAnimExport" "$TW"; then
  echo "DONE ✅  served bundle $(basename "$TW") contains cockpit HUD + framing + render + Voxel Robots Sentinel."
else
  echo "WARN: could not confirm markers in served bundle; check manually."
fi
