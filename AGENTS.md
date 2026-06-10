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

## Live prototype (zo.space routes — edit via space tools, not files)

- `POST/GET /api/tinyworld-worlds` — register/list worlds (+distance)
- `GET/POST /api/tinyworld-access` — access decision (geo|bridge|none); bridge + structure building
- `GET /api/tinyworld-weather` — Open-Meteo → seasonal/void modifiers
- `GET /api/tinyworld-state` — world tick: growth/removal/cycle pressures, Tiny People mode
- `/tinyworld` — page route (visualizer/playground)

These read/write `data/tinyworld.db` in this folder.

## Roadmap (next steps, in order)

1. Wire `block_events` into the live sim page (record grow/remove/cycle)
2. Catch-up simulation on world load (elapsed × void rate × weather multipliers)
3. Bridge decay notifications ("your bridge to Brooklyn Loft is at 24%")
4. Rust input module: ARKit mesh (.usdz/.obj) → dda-voxelize → block grid (`src/`)
5. iOS LiDAR capture app: scan → export mesh → POST to backend (`ios/`)
6. Tiny People behavior sim (Rust)

## Conventions

- Design specs live in `docs/` as markdown
- DB is committed for now (prototype data); move to Supabase before any real users
- Biome specs named `biome-<region>-<climate>.md`
