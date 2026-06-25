#!/usr/bin/env python3
"""
Run the old mesh-first reconstruction path for a TinyWorld browser capture.

TinyWorld capture row/file layout:
  project-tinyworld/data/captures/cap_xxx.mp4
  project-tinyworld/data/captures/cap_xxx.imu.json
  project-tinyworld/data/captures/cap_xxx.json

Old path layout expected by project-photogrammetry:
  project-photogrammetry/scans/scan_xxx/scan.mp4
  project-photogrammetry/scans/scan_xxx/telemetry.jsonl
  project-photogrammetry/scans/scan_xxx/meta.json

Pipeline:
  extract_frames.ts -> run_colmap.ts -> run_openmvs.ts -> align_gravity.py
  -> glb_to_world_payload.py -> update TinyWorld world_blocks.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path


TW_ROOT = Path("/home/workspace/project-tinyworld")
PG_ROOT = Path("/home/workspace/project-photogrammetry")
CAPTURE_DIR = TW_ROOT / "data" / "captures"
DB_PATH = TW_ROOT / "data" / "tinyworld.db"
SCAN_ROOT = PG_ROOT / "scans"
GLB_PYTHON = os.environ.get("GLB_PYTHON", "python3")


def run(cmd: list[str], cwd: Path, timeout: int | None = None) -> None:
    print(f"[old-path] $ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=str(cwd), check=True, timeout=timeout)


def prepare_scan(capture_id: str, scan_id: str, reset: bool) -> Path:
    capture_meta_path = CAPTURE_DIR / f"{capture_id}.json"
    if not capture_meta_path.exists():
        raise FileNotFoundError(f"missing capture metadata: {capture_meta_path}")
    meta = json.loads(capture_meta_path.read_text())

    video_path = CAPTURE_DIR / f"{capture_id}.mp4"
    if not video_path.exists():
        raise FileNotFoundError(f"missing capture video: {video_path}")

    scan_dir = SCAN_ROOT / scan_id
    if reset and scan_dir.exists():
        shutil.rmtree(scan_dir)
    scan_dir.mkdir(parents=True, exist_ok=True)

    dst_video = scan_dir / "scan.mp4"
    if not dst_video.exists() or reset:
        shutil.copy2(video_path, dst_video)

    imu_samples = 0
    imu_path = Path(meta.get("imu_path") or CAPTURE_DIR / f"{capture_id}.imu.json")
    if imu_path.exists():
        raw = json.loads(imu_path.read_text())
        samples = raw.get("samples", raw if isinstance(raw, list) else [])
        imu_samples = len(samples)
        (scan_dir / "telemetry.jsonl").write_text("\n".join(json.dumps(s) for s in samples))

    scan_meta = {
        "id": scan_id,
        "label": meta.get("name") or capture_id,
        "captured_at": meta.get("captured_at") or int(time.time() * 1000),
        "duration_ms": meta.get("duration_ms") or 0,
        "recorder_t0_ms": 0,
        "video_file": "scan.mp4",
        "video_mime": meta.get("mime") or "video/mp4",
        "video_bytes": dst_video.stat().st_size,
        "imu_samples": imu_samples,
        "geo": {"lat": meta.get("lat"), "lon": meta.get("lon")}
        if isinstance(meta.get("lat"), (int, float)) and isinstance(meta.get("lon"), (int, float))
        else None,
        "source_capture_id": capture_id,
    }
    (scan_dir / "meta.json").write_text(json.dumps(scan_meta, indent=2))
    return scan_dir


def update_world_from_payload(world_id: str, payload_path: Path, backup_label: str) -> dict:
    payload = json.loads(payload_path.read_text())
    count = int(payload["meta"]["blockCount"])
    resolution = int(payload["meta"]["resolution"])
    now = int(time.time() * 1000)
    payload["meta"]["savedAt"] = now
    payload["meta"].setdefault("inferredFrom", {})["world_id"] = world_id

    backup_dir = TW_ROOT / "data" / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(DB_PATH)
    try:
        row = con.execute(
            "SELECT payload FROM world_blocks WHERE world_id = ?",
            (world_id,),
        ).fetchone()
        backup = None
        if row:
            backup = backup_dir / f"world_blocks_backup_{world_id}_{backup_label}_{int(time.time())}.json"
            backup.write_text(row[0])
            payload["meta"]["inferredFrom"]["previous_payload_backup"] = str(backup)

        con.execute(
            """
            INSERT INTO world_blocks (world_id, payload, block_count, resolution, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(world_id) DO UPDATE SET
              payload = excluded.payload,
              block_count = excluded.block_count,
              resolution = excluded.resolution,
              updated_at = excluded.updated_at
            """,
            (world_id, json.dumps(payload), count, resolution, now),
        )
        con.execute(
            "UPDATE worlds SET base_blocks = ?, last_scanned = ?, last_visited = ? WHERE id = ?",
            (count, now, now, world_id),
        )
        con.commit()
    finally:
        con.close()

    return {
        "world_id": world_id,
        "block_count": count,
        "resolution": resolution,
        "backup": str(backup) if backup else None,
        "payload": str(payload_path),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("capture_id")
    ap.add_argument("--world-id", required=True)
    ap.add_argument("--scan-id")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--fps", default="2")
    ap.add_argument("--matcher", default="sequential", choices=["sequential", "exhaustive"])
    ap.add_argument("--target-divs", default="220")
    ap.add_argument("--skip-texture", action="store_true")
    ap.add_argument("--skip-run", action="store_true", help="only prepare scan folder")
    args = ap.parse_args()

    scan_id = args.scan_id or f"scan_from_{args.capture_id}"
    scan_dir = prepare_scan(args.capture_id, scan_id, args.reset)
    print(f"[old-path] prepared {scan_dir}")
    if args.skip_run:
        return

    run(["bun", "scripts/extract_frames.ts", scan_id, "--fps", args.fps, "--quality", "2"], PG_ROOT)
    run(["bun", "scripts/run_colmap.ts", scan_id, "--matcher", args.matcher], PG_ROOT)

    openmvs_cmd = ["bun", "scripts/run_openmvs.ts", scan_id]
    if args.skip_texture:
        openmvs_cmd.append("--skip-texture")
    run(openmvs_cmd, PG_ROOT)

    run(
        [
            GLB_PYTHON,
            "scripts/align_gravity.py",
            "--scan-dir",
            str(scan_dir),
            "--in",
            str(scan_dir / "openmvs" / "scene_embedded.glb"),
            "--out",
            str(scan_dir / "openmvs" / "scene_aligned.glb"),
        ],
        PG_ROOT,
    )

    payload_path = scan_dir / "openmvs" / "tinyworld_world.json"
    run(
        [
            "env",
            f"TARGET_DIVS={args.target_divs}",
            GLB_PYTHON,
            str(TW_ROOT / "tools" / "glb_to_world_payload.py"),
            str(scan_dir / "openmvs" / "scene_aligned.glb"),
            str(payload_path),
        ],
        TW_ROOT,
    )

    result = update_world_from_payload(args.world_id, payload_path, "pre_openmvs_old_path")
    print(json.dumps({"ok": True, **result}, indent=2))


if __name__ == "__main__":
    main()
