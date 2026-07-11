"""Insert a voxelizer payload JSON as a brand-new world row (worlds + world_blocks)."""
import argparse, json, sqlite3, time
from pathlib import Path

DB_PATH = Path("/home/workspace/project-tinyworld/data/tinyworld.db")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("payload")
    ap.add_argument("world_id")
    ap.add_argument("name")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    args = ap.parse_args()

    payload = json.loads(Path(args.payload).read_text())
    count = int(payload["meta"]["blockCount"])
    resolution = int(payload["meta"]["resolution"])
    now = int(time.time() * 1000)
    payload["meta"]["savedAt"] = now
    payload["meta"].setdefault("inferredFrom", {})["world_id"] = args.world_id

    con = sqlite3.connect(DB_PATH)
    try:
        if con.execute("SELECT 1 FROM worlds WHERE id=?", (args.world_id,)).fetchone():
            raise SystemExit(f"world {args.world_id} already exists — refusing to overwrite")
        con.execute(
            "INSERT INTO worlds (id, name, lat, lon, owner, base_blocks, integrity, created_at, last_visited, last_scanned)"
            " VALUES (?, ?, ?, ?, 'kj', ?, 100, ?, ?, ?)",
            (args.world_id, args.name, args.lat, args.lon, count, now, now, now),
        )
        con.execute(
            "INSERT INTO world_blocks (world_id, payload, block_count, resolution, updated_at) VALUES (?, ?, ?, ?, ?)",
            (args.world_id, json.dumps(payload), count, resolution, now),
        )
        con.commit()
    finally:
        con.close()
    print(json.dumps({"ok": True, "world_id": args.world_id, "blocks": count, "resolution": resolution}))


if __name__ == "__main__":
    main()
