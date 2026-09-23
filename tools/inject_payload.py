#!/usr/bin/env python3
"""Inject a converter payload JSON into world_blocks for a world id.
Backs up the current payload to data/backups first. Payload-only DB write:
no client rebuild/restart needed (API reads the DB live).
Usage: python3 inject_payload.py <world_id> <payload.json> <tag>"""
import json, sqlite3, sys, time
from pathlib import Path

wid, src, tag = sys.argv[1], sys.argv[2], sys.argv[3]
root = Path(__file__).resolve().parent.parent
db = sqlite3.connect(root / 'data' / 'tinyworld.db')

old = db.execute("SELECT payload FROM world_blocks WHERE world_id=?", (wid,)).fetchone()
if old:
    bak = root / 'data' / 'backups' / f"world_blocks_backup_{wid}_{tag}_{int(time.time())}.json"
    bak.write_text(old[0])
    print('backup:', bak, len(old[0]), 'bytes')

payload = json.loads(Path(src).read_text())
count = int(payload['meta']['blockCount'])
res = int(payload['meta'].get('resolution', 300))
now = int(time.time() * 1000)
db.execute("UPDATE world_blocks SET payload=?, block_count=?, resolution=?, updated_at=? WHERE world_id=?",
           (json.dumps(payload), count, res, now, wid))
db.execute("UPDATE worlds SET base_blocks=? WHERE id=?", (count, wid))
db.commit()
r = db.execute("SELECT block_count, resolution, length(payload) FROM world_blocks WHERE world_id=?", (wid,)).fetchone()
print('injected:', wid, 'blocks:', r[0], 'res:', r[1], 'payload_bytes:', r[2])
