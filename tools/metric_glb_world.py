#!/usr/bin/env python3
"""
metric_glb_world.py — voxelize a METRIC GLB (gravity-aligned, true meters:
tinyworld-osm-glb / tinyworld-map-glb exports) with the fixed-0.5m dead-city
path and write it into an existing world row.

The client-side upload voxelizer normalizes span/TARGET_DIVS and uses
scan-era rel-height classification — right for scale-ambiguous scans, wrong
for metric city GLBs (squashed scale, roofless shells). This wrapper runs the
same convert() the dead-city CLI path uses (VOXEL_M defaults to 0.5 =>
per-column solid fill + latent interior rule) and overwrites the world's
payload through update_world_from_payload (prior payload backed up first).

Usage: metric_glb_world.py <glb_path> <world_id>
Last stdout line is a single JSON decision object.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from glb_to_world_payload import convert  # noqa: E402
from old_path_from_capture import update_world_from_payload  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "decision": "error", "reason": "usage: metric_glb_world.py <glb> <world_id>"}))
        sys.exit(2)
    glb_path, world_id = sys.argv[1], sys.argv[2]
    try:
        payload, count, meta = convert(glb_path)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(payload, f)
            tmp = Path(f.name)
        result = update_world_from_payload(world_id, tmp, "metric_glb_upload")
        tmp.unlink(missing_ok=True)
        print(json.dumps({
            "ok": True,
            "decision": "metric_voxelized",
            "world_id": world_id,
            "blocks": count,
            "voxel": meta.get("voxel"),
            "latent_total": meta.get("latentTotal", 0),
            "backup": result.get("backup"),
        }))
    except SystemExit as e:
        print(json.dumps({"ok": False, "decision": "error", "reason": f"convert failed: {e}"}))
        sys.exit(1)
    except Exception as e:  # last-line JSON contract for the route's parser
        print(json.dumps({"ok": False, "decision": "error", "reason": str(e)[:500]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
