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

## Discovery layer: IP-geo nodes (June 2026)

One central database, but no global world list. A requester's "node" is their
IP-resolved location (server-side, can't be claimed by the client), and worlds
outside the node's perception radius are not returned at all — they don't
exist to you.

Two node tiers in `GET /api/tinyworld-worlds` (precedence: override > gps > ip):

- **GPS tier** — when the client supplies `lat/lon`, perception is human-scale:
  **150 m** base (deliberately equal to the access gate — if you can enter it,
  you can see it; never smaller, or you'd have access to invisible worlds) and
  **5 km** lidar-tower broadcast. IP can't do this — IP geolocation is
  city-level (±5–50 km) — so sub-km perception requires real GPS, which the
  future iOS app will send.
- **IP tier (fallback)** — no coords shared: server reads `x-forwarded-for`,
  resolves via ipwho.is (24 h in-memory cache), filters to **50 km**, lidar
  broadcast **500 km**.
- **GPS = entry gate.** The existing 150 m check in `/api/tinyworld-access` is
  unchanged and remains the actual access decision.

The web prototype page intentionally sends NO coords (its old NYC anchor was a
hardcoded constant, not real GPS — sending it would fake-trigger the 150 m
tier and hide saved worlds). It uses the IP tier and shows a node line on the
idle screen: `node: <city> (ip) · N worlds beyond perception`.

Behavior details:

- Response includes a `node` object (`source: ip | override | unresolved`,
  resolved city, radii) and `hiddenCount` (how many worlds exist beyond
  perception — the client may tease this without revealing them).
- **Fail open**: private/local IPs or lookup failures → `source: "unresolved"`,
  no filtering. Resolved-but-far IPs DO filter (VPNs and coarse carrier geo
  will hide worlds — known prototype tradeoff; `?nodeLat=&nodeLon=` is the
  debug override).
- Verified: NYC worlds hidden from an Ashburn VA datacenter IP; Philly node
  (131 km) sees Brooklyn Loft only when it has a lidar tower; LA sees nothing.

## Vertical anchoring (worlds are volumes, not floor plates)

*Decision (June 2026): no conventional "floors." A world is a contiguous
scanned VOLUME; verticality is just another direction it grows in. Height is
never a key, only a hint — the mesh is the key.*

The voxel grid is already 3D, and **scanning adds blocks, not "land."**
The scan frontier is the entire exposed surface of the volume — any face
with unperceived space behind it. A sweep can extend the volume in any
direction: up a wall, under an overhang, down a stairwell, out along the
ground. Towers, basements, balconies are world geometry, not world
boundaries. "Floor" appears nowhere in the model — it's just what you call
geometry that happens to be flat and parallel to the ground. Costs the same
scan-seconds; rolls the same materials; the protection field, void, and
ledger already operate on the volume.

Why geo can't do this anyway — GPS altitude is noise at building scale
(vertical error 2–3× horizontal, ±10–30 m, worse indoors; a story is ~3 m):

| Signal | Precision | Role |
|---|---|---|
| **ARWorldMap relocalization** | cm, binary "am I in this volume?" | **The decider.** Same anchor + relocalizes against World A's map → you are inside World A, at whatever height. |
| Barometer (CMAltimeter) | ±0.5–1 m *relative*, drifts with weather | `alt_hint` — orders candidates ("~6 m above where you passed the geo gate"). NOT a floor index. |
| GPS altitude | ±10–30 m, ellipsoidal | ignore |

Rules:

1. **One anchor, N volumes.** Worlds at the same lat/lon are disjoint scanned
   volumes (your apartment, the neighbor's, the roof). The geo gate admits you
   to the anchor; relocalization (native) or a picker (web/App Clip) selects
   the volume. No `building_group`, no floor numbering — disjointness itself
   is the only structure.
2. **Connecting scans fuse volumes.** Scan the stairwell from your volume and
   keep going: when the new mesh relocalizes against a volume you have access
   to AND physically connects to it, the volumes become one world — voxel
   volumes union, ledgers/baselines add. This is growth, not bridging.
3. **Bridges are for volumes you DON'T own.** The bridge mechanic survives as
   the *ownership* boundary, not a geometric one: a maintained link to someone
   else's volume (horizontal to the next building, or vertical to the
   neighbor under you — same rule).
4. **Never fuse on geo alone.** Fusion requires the mesh to prove both
   identity (relocalization) and connection (contiguous scan path). Same
   anchor + unconnected mesh = new disjoint volume.

Schema delta (v0 → v0.1): `worlds` gains nullable `alt_hint` REAL (relative
meters, candidate-ordering only); `/api/tinyworld-access` returns the
candidate *set* at a colliding anchor instead of nearest-only. Prototype gap,
noted: `scanNewLand` is misnamed and under-scoped — it should be "scan new
blocks": pick exposed faces anywhere on the volume's surface, not just the
horizontal perimeter. Same fix on the antagonist side: the void should
attack any exposed face (overhangs, undersides, ceilings) the way it
attacks edges today.

## The globe is the void (sparse planet registry)

Is there an "empty globe" waiting to be filled in? **Conceptually yes,
materially no.** A pre-allocated globe would be 510M km² of nothing; instead
the *worlds are data* decision extends planet-wide:

- **The globe is an address space, not a data structure.** Every world row
  already carries its anchor. Add a spatial cell id per row (geohash now —
  computable in SQLite; H3/S2 at Postgres scale) and "the globe" becomes a
  query: *which cells contain scanned mass?* Unscanned Earth costs zero bytes.
- **The globe view is a rendering of that index** — dark planet, glowing
  islands where mesh has been scanned in, bridge threads between them,
  lidar-tower broadcast halos. It composes with the IP-geo discovery layer:
  your node's perception radius decides which islands your globe shows at
  human scale; far worlds render as anonymous glow (`hiddenCount` made
  visual — "something exists there", not what).
- **Lore alignment is exact**: the void is unperceived space, so the
  unscanned planet IS the void — one dark ocean of it. Scanning carves
  islands of perceived existence out of the antagonist. The empty globe
  isn't missing; it's the enemy's territory, and the map shows the war.

Schema delta: `worlds` gains `geocell` TEXT (indexed); a
`GET /api/tinyworld-worlds?globe=1` aggregate returns `{cell, worldCount,
totalMass, hasTower}` per non-empty cell — never world identities, so the
globe view leaks nothing the perception model wouldn't.

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

## Roadmap

1. ~~**Conservation ledger**~~ — done (June 2026): block_events wired, matter
   budget + four pools (WORLD/STOCKPILE/BUILT/VOID), invariant verified.
2. **Visible offline catch-up** — apply voidLoss as real edge erosion at a
   perimeter rift + growth on load, "while you were away" recap card.
3. **Void creatures v1** — night spawner at unlit perimeter, eats edge blocks,
   repelled by structure light radius.
4. **Scan economy + discovery** — scan-charge resource, material rolls on new
   land. Extends the IP-geo discovery layer: world picker surfaces `hiddenCount`
   ("3 worlds beyond your node's perception"), bridges extend visibility to the
   far end's neighborhood, lidar towers already extend broadcast (done).
5. Bridge decay notifications ("your bridge to Brooklyn Loft is at 24%")
