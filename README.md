# Project TinyWorld

A persistent, cloud-based augmented reality world simulation for iPhone.

## Concept

Users scan their physical environment with phone video. The canonical finalizer runs COLMAP/OpenMVS, aligns the resulting GLB to gravity, and converts that GLB into a living voxel "tiny world" populated by semi-autonomous AI characters called Tiny People, under constant threat from an ambient force called The Void.

Every world is always-on, cloud-hosted, and geographically anchored. Two users can connect their worlds by physically scanning the path between them. Tiny People persist, travel, and die independently — but respond to verbal commands from their user.

## Core Mechanics

- **Video → OpenMVS/GLB → Voxel World** — phone video becomes a gravity-aligned GLB, then a voxel grid
- **Geographic Biome** — GPS location determines block palette, seasonal behavior, and void hostility (see `docs/`)
- **The Void** — hostile force that consumes undefended scanned land; stronger at night, amplified by winter
- **Tiny People** — semi-autonomous AI characters; commandable but not fully controllable; personality-typed (MBTI-based archetypes); persistent across sessions
- **Worker knowledge** — personal beliefs, practiced skills, bounded construction experiments, teaching, and a settlement library; inspection—not authority—is the source of truth
- **World Bridging** — users physically scan a path between two locations to create a persistent connection between worlds
- **Pocket Dimension** — Tiny People can be carried on-device and deployed in new scanned environments
- **Turn-based action cycle** — action/pause loop accommodates cloud latency; user plans during pause windows

## Technical Stack (planned)

| Layer | Technology |
|---|---|
| Capture | Phone web video capture |
| Mesh → voxel conversion | COLMAP/OpenMVS aligned GLB + TinyWorld GLB voxelizer |
| World generation engine | TypeScript/Three.js prototype on Zo Space |
| World persistence | Cloud (always-on virtual machines per world region) |
| Biome / weather data | ESA WorldCover + Open-Meteo API |
| Tiny People AI | Custom behavior simulation (Rust) |
| Client rendering | AR + 3D (TBD) |

## Repository Structure

```
project-tinyworld/
  tools/            # OpenMVS/GLB finalizer tools
  src/              # Shared simulation, construction, settlement, tree, and worker-learning modules
  ios/              # Sunset legacy placeholder
  docs/             # Design specs and biome definitions
```

## Biomes

- [NYC Temperate](docs/biome-nyc-temperate.md)

## Worker Simulation

- [Worker knowledge and experimentation](docs/worker-knowledge-and-experimentation.md)
- [Settlement planner](docs/settlement-planner.md)
- [Building reference portfolio](docs/building-reference-portfolio.md)

## Status

Playable Zo Space prototype. Active scan finalizer is OpenMVS/GLB only; the old Depth/RGB-D TSDF path has been removed from the active project.

## Attribution

World generation architecture informed by [Arnis](https://github.com/louis-e/arnis) (Apache 2.0).
