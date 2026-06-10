# Persistence + Geo-Gated Access (prototype, June 2026)

## Decision: worlds are data, not processes

No per-world server instances. Every tiny world is rows in a single SQLite database
(`data/tinyworld.db`), simulated lazily on access. This scales to thousands of worlds
at near-zero idle cost and ports cleanly to Postgres/Supabase when the app ships.

## Schema (v0)

- `worlds` — id, name, lat/lon (geo anchor), owner, base_blocks, integrity, created/visited/scanned timestamps
- `block_events` — append-only log per world: kind (grow/remove/cycle), count, source (user/void/tinyperson)
- `bridges` — world_a ↔ world_b links with integrity that decays ~8 pts/day unless re-scanned

## Access model (the "server bridge" concept)

Access to a world is granted by EITHER:

1. **Geo gate** — requester's GPS within 150 m of the world's anchor point
2. **Bridge** — requester is physically at the other end of a live bridge
   (integrity > 0). Bridges are created/reinforced by LiDAR-scanning the path
   between two worlds; unmaintained bridges decay and access lapses.

This makes geography itself the auth layer: you can be *in* a place, or be
*connected to* a place through maintained physical effort. No accounts needed
for the prototype.

## Live endpoints (zo.space)

- `POST /api/tinyworld-worlds` — register a world `{name, lat, lon, baseBlocks}`
- `GET /api/tinyworld-worlds?lat=&lon=` — list worlds + distance from requester
- `GET /api/tinyworld-access?world=&lat=&lon=` — access decision (geo | bridge | none)
- `POST /api/tinyworld-access` — `{action:"bridge", worldA, worldB}` create/reinforce a bridge
- `GET /api/tinyworld-weather` — Open-Meteo live weather → seasonal/void modifiers
- `GET /api/tinyworld-state` — world tick state: growth/removal/cycle pressures, Tiny People mode

## Anchor structures (decay mitigation)

Buildable via `POST /api/tinyworld-access` with `action: "build"`. Cost is paid in blocks
from the target world (bridges are paid by `world_a`). Effects multiply when stacked.

| Type | Cost (blocks) | Decay factor |
|---|---|---|
| `cairn` | 50 | ×0.85 |
| `stone_anchor` | 300 | ×0.60 |
| `iron_anchor` | 1,200 | ×0.30 |
| `lidar_tower` | 3,000 | ×0.05 (near-permanence) |

Verified: baseline bridge decay 8/day → stone anchor 4.8/day → + lidar tower 0.24/day
(~417 days of integrity instead of ~12.5).

Stored in the `structures` table (`target_kind` = world | bridge). Spends are logged as
`block_events` with `source = 'build'`, so the block economy stays auditable.

## Next

- Wire block_events into the page (record grow/remove/cycle from the live sim)
- Catch-up simulation on world load: elapsed × void rate × weather multipliers
- Bridge decay notifications ("your bridge to Brooklyn Loft is at 24%")
