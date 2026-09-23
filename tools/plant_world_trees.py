#!/usr/bin/env python3
"""Plant environmental trees INTO an existing client-voxelized world payload.

Scan uploads are voxelized in-browser (colored surface voxels, authoritative —
KJ 2026-07-14: server re-voxelization turned a scan into solid grey columns).
This post-pass only ADDS vegetation (trunks/leaves/grass/fruit) + tree records;
it never re-voxelizes or removes existing blocks.
"""
import base64
import json
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from glb_to_world_payload import decorate_vegetation, b64_i32

TW_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = TW_ROOT / "data" / "tinyworld.db"

SURFACE_LAYERS = ("grass", "dryGrass", "dirt", "snow", "wet")
STRUCTURE_LAYERS = ("wall", "ceiling")
# 'ground' stores (x,z,y) walkable-column memos, not blocks.
NON_BLOCK_LAYERS = ("ground",)
# Regular trees stay out of this radius (voxels) around the super tree so the
# landmark reads differentiated (KJ 2026-07-14: "should not have trees too
# near it").
SUPER_TREE_CLEAR_R = 30


def dec_i32(b64s):
    raw = base64.b64decode(b64s or "")
    return np.frombuffer(raw, dtype="<i4").reshape(-1, 3)


def derive_planting_inputs(layers_b64):
    """floor / occupied / wall_cols exactly as the planting pass sees them."""
    decoded = {}
    for name, b in layers_b64.items():
        if name in NON_BLOCK_LAYERS:
            continue
        arr = dec_i32(b)
        if len(arr):
            decoded[name] = arr

    occupied = set()
    for arr in decoded.values():
        occupied.update(map(tuple, arr.tolist()))

    surf_top = {}
    for name in SURFACE_LAYERS:
        arr = decoded.get(name)
        if arr is None:
            continue
        for x, y, z in arr.tolist():
            k = (x, z)
            if k not in surf_top or y > surf_top[k]:
                surf_top[k] = y

    # Scan geometry (walls, objects, overhangs) above the walkable surface
    # marks the column as unplantable — trees only grow on open floor.
    wall_cols = set()
    for name in STRUCTURE_LAYERS:
        arr = decoded.get(name)
        if arr is None:
            continue
        for x, y, z in arr.tolist():
            k = (x, z)
            t = surf_top.get(k)
            if t is None or y > t:
                wall_cols.add(k)

    floor = {k: y for k, y in surf_top.items() if k not in wall_cols}
    return floor, occupied, wall_cols


def super_tree_avoid(meta):
    st = (meta.get("superTree") or {}).get("origin")
    if not st:
        return None
    sx, sz = int(st["x"]), int(st["z"])
    r2 = SUPER_TREE_CLEAR_R * SUPER_TREE_CLEAR_R
    return lambda x, z: (x - sx) ** 2 + (z - sz) ** 2 < r2


def plant_trees(world_id: str) -> dict:
    con = sqlite3.connect(DB_PATH)
    try:
        row = con.execute(
            "SELECT payload, resolution FROM world_blocks WHERE world_id = ?",
            (world_id,),
        ).fetchone()
        if not row:
            raise SystemExit(f"no world_blocks payload for {world_id}")
        payload = json.loads(row[0])
        layers_b64 = payload.get("layers") or {}
        meta = payload.setdefault("meta", {})

        existing_records = meta.get("treeRecords") or []
        if meta.get("treesUpgraded") and existing_records:
            return {"world_id": world_id, "skipped": "trees already planted",
                    "trees": len(existing_records),
                    "blocks": int(meta.get("blockCount") or 0)}

        floor, occupied, wall_cols = derive_planting_inputs(layers_b64)

        added = defaultdict(list)
        stats = decorate_vegetation(added, floor, occupied, wall_cols,
                                    avoid_tree=super_tree_avoid(meta))

        added_count = 0
        for name, pts in added.items():
            if not pts:
                continue
            added_count += len(pts)
            prev = dec_i32(layers_b64.get(name, ""))
            merged = np.concatenate([prev.reshape(-1), np.array(pts, dtype="<i4").reshape(-1)])
            layers_b64[name] = base64.b64encode(merged.astype("<i4").tobytes()).decode()

        now = int(time.time() * 1000)
        meta["treesUpgraded"] = True
        meta["treeUpgradeVersion"] = 3
        meta["treeRecords"] = stats.get("treeRecords", [])
        meta["vegetation"] = {k: v for k, v in stats.items() if k != "treeRecords"}
        meta["blockCount"] = int(meta.get("blockCount") or 0) + added_count
        meta["savedAt"] = now
        payload["layers"] = layers_b64

        backup_dir = TW_ROOT / "data" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"world_blocks_backup_{world_id}_plant_trees_{int(time.time())}.json"
        backup.write_text(row[0])

        con.execute(
            "UPDATE world_blocks SET payload = ?, block_count = ?, updated_at = ? WHERE world_id = ?",
            (json.dumps(payload), meta["blockCount"], now, world_id),
        )
        con.commit()
        return {"world_id": world_id, "blocks": meta["blockCount"], "added": added_count,
                "trees": stats.get("trees", 0), "shrubs": stats.get("shrubs", 0),
                "ground": stats.get("ground", 0), "backup": str(backup)}
    finally:
        con.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "reason": "usage: plant_world_trees.py <world_id>"}))
        raise SystemExit(2)
    print(json.dumps({"ok": True, **plant_trees(sys.argv[1])}))
