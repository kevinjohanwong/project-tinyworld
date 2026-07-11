#!/usr/bin/env python3
"""
merge_capture_into_world.py — non-destructive joint-reconstruction merge.

Locked principle: Replace is banned; merge at most. GPS only nominates,
geometry decides. A new capture may be merged INTO an existing world only if
both scans' frames co-register into ONE shared COLMAP model (proof of real
shared geometry). Otherwise the merge is DECLINED and the caller must place
the new capture as a SEPARATE world — the old world is never overwritten by a
non-overlapping scan (Greene St incident, 2026-07-01).

Flow:
  1. Resolve the OLD world's source capture(s) from pending_captures.
  2. Ensure frames exist for OLD + NEW captures (prepare+extract if missing).
  3. Build a joint frames/ dir (a_* = old scan, b_* = new scan) and run COLMAP
     with the exhaustive matcher so old<->new pairs can actually match.
  4. GATE ("geometry decides"): inspect every sparse sub-model; find one where
     BOTH scans registered >= thresholds. None -> decision=separate_world,
     exit 0 WITHOUT touching the old world.
  5. OpenMVS on that joint model -> GLB -> gravity-align -> voxelize.
  6. GUARD ("old coverage never dropped"): merged block_count must be >=
     --min-retain * old block_count, else decision=coverage_regression and the
     old world is left untouched.
  7. Write merged payload into the OLD world_id (prior payload is backed up
     first by update_world_from_payload), or to --dry-write <file> instead of
     the DB for offline inspection.

Last stdout line is a single JSON object describing the decision.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from old_path_from_capture import (  # noqa: E402
    CAPTURE_DIR,
    DB_PATH,
    GLB_PYTHON,
    PG_ROOT,
    SCAN_ROOT,
    TW_ROOT,
    prepare_scan,
    run,
    update_world_from_payload,
)


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def db_ro() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def source_captures_for_world(world_id: str) -> list[str]:
    con = db_ro()
    try:
        rows = con.execute(
            "SELECT id FROM pending_captures WHERE world_id = ? AND status = 'processed' ORDER BY captured_at",
            (world_id,),
        ).fetchall()
        return [r["id"] for r in rows]
    finally:
        con.close()


def world_block_count(world_id: str) -> int | None:
    con = db_ro()
    try:
        row = con.execute(
            "SELECT block_count FROM world_blocks WHERE world_id = ?", (world_id,)
        ).fetchone()
        return int(row["block_count"]) if row else None
    finally:
        con.close()


def ensure_frames(capture_id: str, fps: str) -> Path:
    """Return the frames/ dir for a capture, extracting if needed."""
    scan_id = f"scan_from_{capture_id}"
    frames = SCAN_ROOT / scan_id / "frames"
    if frames.is_dir() and any(frames.glob("*.jpg")):
        return frames
    prepare_scan(capture_id, scan_id, reset=False)
    run(["bun", "scripts/extract_frames.ts", scan_id, "--fps", fps, "--quality", "2"], PG_ROOT)
    if not frames.is_dir() or not any(frames.glob("*.jpg")):
        raise RuntimeError(f"frame extraction produced no frames for {capture_id}")
    return frames


def _joint_imu_frames(src_dir: Path, prefix: str) -> list[dict]:
    """Source scan's frames.json entries re-keyed to the joint a*/b_ names."""
    fj = src_dir.parent / "frames.json"
    if not fj.exists():
        return []
    out = []
    for fr in json.loads(fj.read_text()).get("frames", []):
        fr = dict(fr)
        fr["file"] = f"{prefix}{fr['file']}"
        out.append(fr)
    return out


def build_joint_frames(merge_scan_id: str, old_frames: list[Path], new_frames: Path, reset: bool) -> Path:
    merge_dir = SCAN_ROOT / merge_scan_id
    frames_dir = merge_dir / "frames"
    if reset and merge_dir.exists():
        shutil.rmtree(merge_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    counts = {"a": 0, "b": 0}
    joint_imu: list[dict] = []
    for i, src_dir in enumerate(old_frames):
        for f in sorted(src_dir.glob("*.jpg")):
            dst = frames_dir / f"a{i}_{f.name}"
            if not dst.exists():
                shutil.copy2(f, dst)
            counts["a"] += 1
        joint_imu += _joint_imu_frames(src_dir, f"a{i}_")
    for f in sorted(new_frames.glob("*.jpg")):
        dst = frames_dir / f"b_{f.name}"
        if not dst.exists():
            shutil.copy2(f, dst)
        counts["b"] += 1
    joint_imu += _joint_imu_frames(new_frames, "b_")
    # align_gravity.py reads <scan_dir>/frames.json and pairs IMU gravity to
    # registered COLMAP images BY FILENAME — without the re-keyed joint copy it
    # crashes (FileNotFoundError) after the expensive reconstruction.
    (merge_dir / "frames.json").write_text(json.dumps({"frames": joint_imu}))
    n_grav = sum(1 for fr in joint_imu if fr.get("imu", {}).get("accel_grav"))
    print(f"[merge] joint frames: {counts['a']} old (a*) + {counts['b']} new (b_) -> {frames_dir}", flush=True)
    print(f"[merge] joint frames.json: {len(joint_imu)} entries, {n_grav} with IMU gravity", flush=True)
    return frames_dir


def registered_names(model_dir: Path) -> list[str]:
    """Registered image names in one COLMAP sub-model (via TXT export)."""
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            ["colmap", "model_converter", "--input_path", str(model_dir),
             "--output_path", td, "--output_type", "TXT"],
            check=True, capture_output=True,
        )
        names = []
        for line in (Path(td) / "images.txt").read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            tok = line.split()
            if tok and tok[-1].lower().endswith((".jpg", ".jpeg", ".png")):
                names.append(tok[-1])
        return names


def gate_geometry(sparse_dir: Path, n_old: int, n_new: int, min_frames: int, min_frac: float) -> dict:
    """Find a sub-model where BOTH scans co-registered. GPS nominated; this decides."""
    models = []
    for sub in sorted(p for p in sparse_dir.iterdir() if p.is_dir() and p.name.isdigit()):
        if not (sub / "images.bin").exists():
            continue
        names = registered_names(sub)
        a = sum(1 for n in names if n.startswith("a"))
        b = sum(1 for n in names if n.startswith("b_"))
        models.append({"model": int(sub.name), "registered": len(names), "old_frames": a, "new_frames": b})
    need_a = max(min_frames, int(min_frac * n_old))
    need_b = max(min_frames, int(min_frac * n_new))
    shared = [m for m in models if m["old_frames"] >= need_a and m["new_frames"] >= need_b]
    best = max(shared, key=lambda m: m["registered"]) if shared else None
    return {
        "models": models,
        "required": {"old_frames": need_a, "new_frames": need_b},
        "shared_model": best,
        "co_registered": best is not None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("new_capture_id")
    ap.add_argument("--into-world-id", required=True)
    ap.add_argument("--fps", default="2")
    ap.add_argument("--target-divs", default="690", help="voxelizer divisions; keep >= old world's resolution so merge never coarsens old detail")
    ap.add_argument("--min-cross-frames", type=int, default=8)
    ap.add_argument("--min-cross-frac", type=float, default=0.15)
    ap.add_argument("--min-retain", type=float, default=0.75, help="merged blocks must be >= this fraction of old blocks")
    ap.add_argument("--gate-only", action="store_true", help="stop after the co-registration gate")
    ap.add_argument("--dry-write", help="write merged payload to this file instead of the DB")
    ap.add_argument("--skip-texture", action="store_true")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    world_id = args.into_world_id
    old_caps = source_captures_for_world(world_id)
    old_caps = [c for c in old_caps if c != args.new_capture_id]
    if not old_caps:
        emit({"ok": False, "decision": "separate_world",
              "reason": f"world {world_id} has no processed source captures on disk; nothing to co-register against"})
        return

    old_blocks = world_block_count(world_id)

    old_frame_dirs = [ensure_frames(c, args.fps) for c in old_caps]
    new_frames = ensure_frames(args.new_capture_id, args.fps)
    n_old = sum(len(list(d.glob("*.jpg"))) for d in old_frame_dirs)
    n_new = len(list(new_frames.glob("*.jpg")))

    merge_scan_id = f"scan_merge_{world_id}_{args.new_capture_id}"
    build_joint_frames(merge_scan_id, old_frame_dirs, new_frames, args.reset)
    scan_dir = SCAN_ROOT / merge_scan_id

    # meta.json so downstream scripts (align_gravity) have scan context.
    (scan_dir / "meta.json").write_text(json.dumps({
        "id": merge_scan_id, "label": f"merge {args.new_capture_id} into {world_id}",
        "captured_at": int(time.time() * 1000), "duration_ms": 0,
        "video_file": None, "imu_samples": 0,
        "merge": {"into_world_id": world_id, "old_captures": old_caps, "new_capture": args.new_capture_id},
    }, indent=2))

    # Exhaustive matcher is REQUIRED: sequential only matches temporal neighbours
    # and would never test old<->new frame pairs.
    run(["bun", "scripts/run_colmap.ts", merge_scan_id, "--matcher", "exhaustive", "--reset"], PG_ROOT)

    gate = gate_geometry(scan_dir / "colmap" / "sparse", n_old, n_new,
                         args.min_cross_frames, args.min_cross_frac)
    print(f"[merge] gate: {json.dumps(gate)}", flush=True)

    if not gate["co_registered"]:
        emit({"ok": True, "decision": "separate_world", "world_id": world_id,
              "new_capture_id": args.new_capture_id, "gate": gate,
              "reason": "no shared geometry: scans did not co-register into one model; old world untouched"})
        return
    if args.gate_only:
        emit({"ok": True, "decision": "merge_candidate_confirmed", "world_id": world_id,
              "new_capture_id": args.new_capture_id, "gate": gate})
        return

    model_idx = gate["shared_model"]["model"]
    openmvs_cmd = ["bun", "scripts/run_openmvs.ts", merge_scan_id, "--model", str(model_idx)]
    if args.skip_texture:
        openmvs_cmd.append("--skip-texture")
    run(openmvs_cmd, PG_ROOT)

    # run_openmvs only writes scene_embedded.glb when texturing runs; with
    # --skip-texture the final artifact is scene.glb.
    glb_in = scan_dir / "openmvs" / "scene_embedded.glb"
    if not glb_in.exists():
        glb_in = scan_dir / "openmvs" / "scene.glb"

    run([GLB_PYTHON, "scripts/align_gravity.py",
         "--scan-dir", str(scan_dir),
         "--in", str(glb_in),
         "--out", str(scan_dir / "openmvs" / "scene_aligned.glb")], PG_ROOT)

    payload_path = scan_dir / "openmvs" / "tinyworld_world.json"
    # VOXEL_M=auto: scan reconstructions are NOT metric — keep span/TARGET_DIVS
    # normalization here, not the map path's fixed 0.5m default.
    run(["env", f"TARGET_DIVS={args.target_divs}", "VOXEL_M=auto", GLB_PYTHON,
         str(TW_ROOT / "tools" / "glb_to_world_payload.py"),
         str(scan_dir / "openmvs" / "scene_aligned.glb"), str(payload_path)], TW_ROOT)

    merged = json.loads(payload_path.read_text())
    merged_blocks = int(merged["meta"]["blockCount"])
    if old_blocks and merged_blocks < args.min_retain * old_blocks:
        emit({"ok": True, "decision": "coverage_regression", "world_id": world_id,
              "new_capture_id": args.new_capture_id, "gate": gate,
              "old_blocks": old_blocks, "merged_blocks": merged_blocks,
              "payload": str(payload_path),
              "reason": f"merged reconstruction collapsed ({merged_blocks} < {args.min_retain} * {old_blocks}); old world untouched"})
        return

    merged["meta"].setdefault("inferredFrom", {})["merge"] = {
        "into_world_id": world_id, "old_captures": old_caps,
        "new_capture": args.new_capture_id, "gate": gate["shared_model"],
        "old_blocks": old_blocks,
    }
    payload_path.write_text(json.dumps(merged))

    if args.dry_write:
        Path(args.dry_write).write_text(json.dumps(merged))
        emit({"ok": True, "decision": "merged_dry", "world_id": world_id,
              "new_capture_id": args.new_capture_id, "gate": gate,
              "old_blocks": old_blocks, "merged_blocks": merged_blocks,
              "dry_write": args.dry_write})
        return

    result = update_world_from_payload(world_id, payload_path, "pre_merge")
    emit({"ok": True, "decision": "merged", "new_capture_id": args.new_capture_id,
          "gate": gate, "old_blocks": old_blocks, **result})


if __name__ == "__main__":
    main()
