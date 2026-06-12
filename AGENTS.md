# Project TinyWorld — Agent Context

Consolidated from design threads (Gemini brainstorm "Project Quantum" Mar 2026 + Zo build sessions Jun 2026). This file is the source of truth for project state. Update it as the project evolves.

## What this is

Persistent, cloud-based AR world sim for iPhone. LiDAR-scan a physical space → it becomes a Minecraft-like voxel "tiny world" (12×12 blocks/sq ft) populated by semi-autonomous AI "Tiny People," under threat from "The Void." Worlds are geo-anchored; connecting two worlds requires physically scanning the path between them ("bridging"). Formerly called **Project Quantum**.

## Key design decisions (settled)

1. **Worlds are data, not processes.** No per-world VMs. Worlds = rows in SQLite (`data/tinyworld.db`), simulated lazily on access (catch-up sim: elapsed time × void rate × weather). Ports to Postgres/Supabase later. See `docs/persistence-and-access.md`.
2. **Geography is the auth layer.** Access via geo gate (GPS within 150 m of anchor) OR a live bridge (integrity > 0). Bridges decay ~8 pts/day unless re-scanned; anchor structures (cairn → lidar_tower) slow decay. No accounts in prototype.
3. **Voxel pipeline = Arnis fork.** https://github.com/louis-e/arnis (Rust, Apache 2.0). Keep `world_editor/`, `block_definitions.rs`, `element_processing/`, `dda-voxelize` (mesh→voxel). Replace OSM input (`retrieve_data.rs`/`osm_parser.rs`) with a LiDAR ingestion module (ARKit mesh export).
4. **Semantics from GPS, geometry from LiDAR.** LiDAR gives shape only; GPS unlocks the semantic layer (OSM landuse + ESA WorldCover + Köppen climate + Open-Meteo weather + date/season) → block palette. v1 accepts raw geometry + biome palette (no surface classifier).
5. **Void follows real time.** Night (8pm–6am local) = aggressive; winter = +25%. Biome sets hostility + creature archetypes. NYC: Soot Crawlers (roads), Girder Shades (walls), Steam Wraiths (waterfront), Concrete Nulls (rare). See `docs/biome-nyc-temperate.md`.
6. **Turn-based action/pause cycle** to absorb cloud latency. User builds = blueprint; Tiny People execute it (delayed). Combat turn-based.
7. **Tiny People**: commandable, not controllable. MBTI-style archetypes; happiness/longevity/independence metrics; voice commands; they talk back as the UI. Pocket dimension: carry them on-device, deploy in new scans; abandoned ones navigate home.

## Current state (Jun 2026)

- **Repo**: https://github.com/kevinjohanwong/project-tinyworld (this folder)
- **Docs**: README, NYC temperate biome spec, persistence/access spec — done
- **Prototype backend**: live on kj.zo.space as API routes (NOT in this repo — see "Live prototype" below)
- **DB**: `data/tinyworld.db` (SQLite v0) — tables: worlds, block_events, bridges, structures, world_blocks. Seeded with 2 test worlds (KJ Apartment @ 40.7128,-74.006; Brooklyn Loft @ 40.6782,-73.9442), 1 bridge with stone_anchor + lidar_tower (decay 8/day → 0.24/day verified)
- **`src/` and `ios/` are empty** — Rust backend and Swift app not started
- **Active focus now**: NPCs ("Tiny Workers") + walk-mode polish. Save/load via SQLite is wired (compact base64).
- **Walk physics (Jun 11)**: Minosoft-inspired. Spawn picks the real groundMap cell nearest centroid + sweeps Y for body clearance (no more independent-median spawn bug). Per-frame stuck-recovery: vertical push-up first, then corner-sample horizontal pushout fallback if ceiling blocks the lift. Diagonal speed normalized (W+D no longer √2× faster). Smooth step-up over ~80ms via dt-lerp when grounded; hard snap on jump landings keeps jumps crisp.
- **Tiny Worker v1 (Jun 11)**: one NPC per world, spawns at floor centroid. Pink cube (~0.7 voxel) with white edge outline + small white indicator cube above head when carrying. State machine: idle → walk → pickup (2.5s) → walk → place (1s) → idle. Paths via A* on `groundMap` (4-conn, step-up ≤ 1). 250ms decision tick; per-frame interp for smooth motion (~500ms/cell — ~10× slower than player on foot). Conservation-respecting — uses `freeSlots` like the player. Only picks up from `SOFT_WORKER_LAYERS` = {grass, dryGrass, leaves, fruit, dirt, snow}; ignores stone/wall/water/trunks. Behavior bias 60% pickup-and-move / 40% wander. Won't eat fruit (player-only).
- **Save/Load wired (Jun 10)**: `/tinyworld` page now has a SAVE/LOAD panel (world dropdown + Load/Save/Save As) backed by the `world_blocks` table. Layers serialize as compact base64-encoded Int32Array binary (~4.4 bytes/coord vs ~13 for JSON arrays). Save snapshots the LIVE edited scene (slotMaps + hiddenMaps + walkable ground), so moved blocks persist. Load rebuilds the full 3D scene from the DB without re-voxelizing (skips the GLB worker). Saved worlds are also loadable from the idle screen. Round-trip verified via API test.
- **Conservation ledger (Jun 11)**: One law for everything: `WORLD + STOCKPILE + BUILT + VOID === baseline`, always. Blocks move between pools, never created/destroyed. **VOID doubles as the world's reservoir** — organic growth draws from it (`spawnBlockInto` auto-logs VOID→WORLD), decay/removal returns to it; this rule is load-bearing, without it the organic lifecycle breaks the invariant within seconds. Fresh scans seed VOID with 2% of scan mass so growth has matter to draw from. Carried blocks (player or worker) live in STOCKPILE; failed worker placements keep the block in hand instead of vanishing. Every move queues a `block_events` row (kind grow/remove/cycle), aggregated client-side and flushed every 15s / on save / on pagehide (sendBeacon). Pools persist in save `meta.ledger`; WORLD is recounted authoritatively (visible+hidden) on every world build. Audit via `window.__tw.ledger()` → `{pools, sum, balanced, worldDrift, stockpileByLayer}`. Worker pickup/placement now routes through the shared `spawnBlockInto`/`removeBlockFrom` helpers + `syncGroundAfterRemove/Place` (no more inlined mutation logic).
- **Local protection field + void creatures (Jun 12, Chunk 3)**: Density ladder per `docs/mass-and-density.md` §9 (`DENSITY` map: bloom-tier 0.25 → loam 1 → stone 4 → metal 16 → densium 64 → core 256). Protection field = coarse 8×8-column cell grid (`protCells`); cell mass = Σ block density, maintained incrementally via hooks in `spawnBlockInto`/`removeBlockFrom` (the only two mutation paths). `protectionAt(vx,vz)` sums nearby cells with gravity falloff `m/(1+dx²+dz²)`. Catch-up rift now opens **deterministically at the lowest-protection perimeter cell** (was random). Void phase from real local time — passive 06–20h / active 20–23h / aggressive 23–06h — with `?void=aggressive|active|off` URL override for testing. **Void creatures**: hovering wraiths (dark octahedral-shard body, magenta eye strip, purple 0x8a2be2 beacon), no pathfinding — drift toward targets. Spawn at weakest perimeter cells (cap: aggressive 3 / active 1 / passive 0 → despawn at dawn). Eat the top block of their cell via `removeBlockFrom(...,"void_creature")` + `syncGroundAfterRemove` — fully ledger-conserving (WORLD→VOID). Eat rate scales with protection *relative to the perimeter median* (weakest ≈ 6s/bite, median ≈ 24s; raw protection values run in the thousands, so never use them un-normalized). Protection > 2.5× median repels creatures back to weak ground. Season multiplier: winter 1.25 / fall 1.1 / summer 0.9. HUD shows void phase + creature count + eaten total. Test hooks: `__tw.protection(vx,vz)`, `__tw.voidInfo()`, `__tw.spawnCreature()`, `__tw.clearCreatures()`, `__tw.cellInfo(vx,vz)`. Gotchas learned the hard way: (a) creature movement must step inside the 1s tick, never per render frame — headless tabs run at ~1 fps; (b) `removeCol` leaves empty Sets in `colMap` ("ghost columns") — any perimeter scan must skip `size === 0` columns or creatures chase cells with nothing to eat; (c) raw protection values run in the thousands — always normalize against the perimeter median before using them in rates. Verified Jun 12: 3 creatures spawn under `?void=aggressive`, bites log `remove|void_creature` block events, ledger stays balanced (drift 0), passive phase culls all creatures.
- **Organic lifecycle (Jun 10)**: Organic blocks (fruit, seed, sapling, plus growth-trunks/leaves) flow through a lifecycle (transacting against the VOID reservoir, see ledger above): leaf → fruit (buds on sunlit leaves, season-gated) → drops → rots after ~22s → seed → germinates on soil → sapling → matures into trunk + leaf above (~90s total cycle). Tick cadence 750ms; rate × seasonGrowth (1.7 summer / 1.2 spring / 0.55 fall / 0.15 winter). Fruit is pickupable (80ms hold) and consumable: holding fruit + `E` deletes the block and increments a `satiation` HUD counter. `tickOrganic` self-heals — newly placed organic blocks get registered, stale entries pruned each tick. State persists via `snapshotLiveLayers()` (walks all mesh slotMaps including hiddenMaps before save) + `playerState.satiation` in `meta`.

## Live prototype (zo.space routes — edit via space tools, not files)

- `POST/GET /api/tinyworld-worlds` — register/list worlds (+distance)
- `GET/POST /api/tinyworld-access` — access decision (geo|bridge|none); bridge + structure building
- `GET /api/tinyworld-weather` — Open-Meteo → seasonal/void modifiers
- `GET /api/tinyworld-state` — world tick: growth/removal/cycle pressures, Tiny People mode
- `/tinyworld` — page route (visualizer/playground)

These read/write `data/tinyworld.db` in this folder.

## Roadmap (next steps, in order)

1. ~~Wire `block_events` into the live sim page~~ — done Jun 11 (conservation ledger)
2. Visible catch-up simulation on world load (apply void loss as perimeter erosion + rift marker, growth as real blocks, recap card)
3. Bridge decay notifications ("your bridge to Brooklyn Loft is at 24%")
4. Framerate: adaptive pixel ratio + FPS counter (deferred — not yet)
5. Rust input module: ARKit mesh (.usdz/.obj) → dda-voxelize → block grid (`src/`)
6. iOS LiDAR capture app: scan → export mesh → POST to backend (`ios/`)
7. Tiny People behavior sim (Rust)

## Conventions

- Design specs live in `docs/` as markdown
- DB is committed for now (prototype data); move to Supabase before any real users
- Biome specs named `biome-<region>-<climate>.md`
