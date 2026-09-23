#!/usr/bin/env python3
"""Finalize an uploaded scan only after the complete payload is validated."""
import base64
import json
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from plant_world_trees import plant_trees

TW_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = TW_ROOT / "data" / "tinyworld.db"
REQUIRED_LAYERS = (
    "dirt",
    "hidden_dirt",
    "grass",
    "dryGrass",
    "trunks",
    "leaves",
    "water",
    "wall",
    "ceiling",
)


def layer_count(encoded: object) -> int:
    if not isinstance(encoded, str):
        raise ValueError("layer is missing or not base64")
    if not encoded:
        return 0
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) % 12:
        raise ValueError("layer byte length is not divisible by an xyz triple")
    return len(raw) // 12


def latent_column_count(encoded: object) -> int:
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("latentCols is missing")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) % 16:
        raise ValueError("latentCols byte length is not divisible by an int32 quad")
    return len(raw) // 16


def validate_payload(payload: dict, require_finalization: bool = True) -> dict:
    errors = []
    layers = payload.get("layers") if isinstance(payload, dict) else None
    meta = payload.get("meta") if isinstance(payload, dict) else None
    if not isinstance(layers, dict):
        return {"ok": False, "errors": ["layers object is missing"]}
    if not isinstance(meta, dict):
        return {"ok": False, "errors": ["meta object is missing"]}

    counts = {}
    for name, encoded in layers.items():
        try:
            counts[name] = layer_count(encoded)
        except ValueError as exc:
            errors.append(f"{name}: {exc}")
    for name in REQUIRED_LAYERS:
        if name not in counts:
            errors.append(f"required layer missing: {name}")

    try:
        latent_cols = latent_column_count(meta.get("latentCols"))
    except ValueError as exc:
        latent_cols = 0
        errors.append(f"latent ground: {exc}")
    latent_total = meta.get("latentTotal")
    if not isinstance(latent_total, int) or latent_total <= 0:
        errors.append("latent ground: latentTotal must be a positive integer")

    latent_ground = meta.get("latentGround")
    if require_finalization:
        if not isinstance(latent_ground, dict):
            errors.append("latent ground metadata is missing")
        else:
            if latent_ground.get("version", 0) < 1:
                errors.append("latent ground metadata version is missing")
            if latent_ground.get("layer") != meta.get("latentLayer", "dirt"):
                errors.append("latent ground layer does not match latentLayer")
            if latent_ground.get("cells") != latent_total:
                errors.append("latent ground cell count does not match latentTotal")
            if latent_ground.get("columns") != latent_cols:
                errors.append("latent ground column count does not match latentCols")
            if latent_ground.get("validated") is not True:
                errors.append("latent ground has not been validated")

    water_count = counts.get("water", 0)
    water_support = meta.get("waterSupport")
    if require_finalization:
        if not isinstance(water_support, dict):
            errors.append("water-support metadata is missing")
        else:
            if water_support.get("version", 0) < 1:
                errors.append("water-support metadata version is missing")
            if water_support.get("mode") != "latent-aware":
                errors.append("water-support mode is not latent-aware")
            if water_support.get("waterCells") != water_count:
                errors.append("water-support waterCells does not match the water layer")
            if water_support.get("latentGroundRequired") is not True:
                errors.append("water-support metadata does not require latent ground")
            if water_support.get("validated") is not True:
                errors.append("water-support metadata has not been validated")

    visible_count = sum(v for k, v in counts.items() if not k.startswith("hidden_"))
    hidden_count = sum(v for k, v in counts.items() if k.startswith("hidden_"))
    payload_count = sum(counts.values())
    block_counts = meta.get("blockCounts")
    if require_finalization:
        if not isinstance(meta.get("finalizedLayers"), list):
            errors.append("finalizedLayers is missing")
        elif not set(REQUIRED_LAYERS).issubset(set(meta["finalizedLayers"])):
            errors.append("finalizedLayers does not include every required layer")
        if not isinstance(block_counts, dict):
            errors.append("blockCounts is missing")
        else:
            expected = {
                "visible": visible_count,
                "hidden": hidden_count,
                "payload": payload_count,
                "latent": latent_total if isinstance(latent_total, int) else 0,
                "totalWithLatent": payload_count + (latent_total if isinstance(latent_total, int) else 0),
            }
            for key, value in expected.items():
                if block_counts.get(key) != value:
                    errors.append(f"blockCounts.{key} does not match the payload")
            if block_counts.get("layers") != counts:
                errors.append("blockCounts.layers does not match the payload")
        if meta.get("finalizedBlockCount") != visible_count:
            errors.append("finalizedBlockCount does not match visible layers")
        if meta.get("canonicalFinalization", {}).get("status") != "ready":
            errors.append("canonical finalization is not ready")

    return {
        "ok": not errors,
        "errors": errors,
        "layerCounts": counts,
        "visibleCount": visible_count,
        "hiddenCount": hidden_count,
        "payloadCount": payload_count,
        "latentColumns": latent_cols,
        "latentTotal": latent_total if isinstance(latent_total, int) else 0,
    }


def read_world(world_id: str):
    con = sqlite3.connect(DB_PATH)
    try:
        row = con.execute(
            "SELECT payload, block_count, resolution, updated_at FROM world_blocks WHERE world_id = ?",
            (world_id,),
        ).fetchone()
        if not row:
            raise ValueError(f"no world_blocks payload for {world_id}")
        return json.loads(row[0]), row[1], row[2], row[3]
    finally:
        con.close()


def write_world(world_id: str, payload: dict, block_count: int, resolution: int):
    now = int(time.time() * 1000)
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute(
            "UPDATE world_blocks SET payload = ?, block_count = ?, resolution = ?, updated_at = ? WHERE world_id = ?",
            (json.dumps(payload, separators=(",", ":")), block_count, resolution, now, world_id),
        )
        con.execute("UPDATE worlds SET base_blocks = ?, last_scanned = ?, last_visited = ? WHERE id = ?", [
            block_count, now, now, world_id,
        ])
        con.commit()
    finally:
        con.close()


def restore_world(world_id: str, payload: dict, block_count: int, resolution: int, updated_at: int):
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute(
            "UPDATE world_blocks SET payload = ?, block_count = ?, resolution = ?, updated_at = ? WHERE world_id = ?",
            (json.dumps(payload, separators=(",", ":")), block_count, resolution, updated_at, world_id),
        )
        con.execute("UPDATE worlds SET base_blocks = ? WHERE id = ?", [block_count, world_id])
        con.commit()
    finally:
        con.close()


def finalize_payload(payload: dict) -> dict:
    meta = payload.setdefault("meta", {})
    preflight = validate_payload(payload, require_finalization=False)
    if not preflight["ok"]:
        raise ValueError("preflight validation failed: " + "; ".join(preflight["errors"][:8]))

    counts = preflight["layerCounts"]
    visible_count = preflight["visibleCount"]
    hidden_count = preflight["hiddenCount"]
    payload_count = preflight["payloadCount"]
    latent_total = preflight["latentTotal"]
    meta["finalizedLayers"] = sorted(counts)
    meta["finalizedLayerVersion"] = 1
    meta["blockCounts"] = {
        "layers": counts,
        "visible": visible_count,
        "hidden": hidden_count,
        "payload": payload_count,
        "latent": latent_total,
        "totalWithLatent": payload_count + latent_total,
    }
    meta["finalizedBlockCount"] = visible_count
    meta["blockCount"] = visible_count
    meta["latentGround"] = {
        "version": 1,
        "layer": meta.get("latentLayer", "dirt"),
        "cells": latent_total,
        "columns": preflight["latentColumns"],
        "validated": True,
    }
    meta["waterSupport"] = {
        "version": 1,
        "mode": "latent-aware",
        "waterCells": counts.get("water", 0),
        "latentGroundRequired": True,
        "validated": True,
    }
    meta["canonicalFinalization"] = {
        "version": 1,
        "status": "ready",
        "completedAt": int(time.time() * 1000),
        "pipeline": "scan-upload-v2",
    }
    validation = validate_payload(payload, require_finalization=True)
    if not validation["ok"]:
        raise ValueError("final validation failed: " + "; ".join(validation["errors"][:8]))
    return validation


def main() -> None:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "decision": "error", "reason": "usage: canonical_glb_world.py <glb> <world_id>"}))
        raise SystemExit(2)
    world_id = sys.argv[2]
    original = None
    try:
        original = read_world(world_id)
        result = plant_trees(world_id)
        payload, _old_count, resolution, _updated_at = read_world(world_id)
        validation = finalize_payload(payload)
        write_world(world_id, payload, validation["visibleCount"], resolution)
        print(json.dumps({
            "ok": True,
            "decision": "canonical_voxelized",
            "finalized": True,
            "world_id": world_id,
            "blocks": validation["visibleCount"],
            "payload_blocks": validation["payloadCount"],
            "latent_cells": validation["latentTotal"],
            "water_cells": validation["layerCounts"].get("water", 0),
            "trees": result.get("trees", 0),
            "shrubs": result.get("shrubs", 0),
            "added_blocks": result.get("added", 0),
            "tree_model": "environmental-nyc-v1",
            "backup": result.get("backup"),
            "validation": {
                "ok": validation["ok"],
                "required_layers": list(REQUIRED_LAYERS),
                "finalized_layers": payload["meta"]["finalizedLayers"],
                "block_counts": payload["meta"]["blockCounts"],
                "latent_ground": payload["meta"]["latentGround"],
                "water_support": payload["meta"]["waterSupport"],
                "canonical_finalization": payload["meta"]["canonicalFinalization"],
            },
        }))
    except BaseException as e:
        if original is not None:
            try:
                restore_world(world_id, *original)
            except BaseException as restore_error:
                print(json.dumps({"ok": False, "decision": "error", "reason": f"{e}; restore failed: {restore_error}"}))
                raise SystemExit(1)
        print(json.dumps({
            "ok": False,
            "decision": "canonical_rejected",
            "finalized": False,
            "world_id": world_id,
            "reason": str(e)[:1000],
        }))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
