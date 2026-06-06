# Project TinyWorld

A persistent, cloud-based augmented reality world simulation for iPhone.

## Concept

Users scan their physical environment with iPhone LiDAR. That scan becomes a living "tiny world" — a scaled-down Minecraft-like voxel space populated by semi-autonomous AI characters called Tiny People, under constant threat from an ambient force called The Void.

Every world is always-on, cloud-hosted, and geographically anchored. Two users can connect their worlds by physically scanning the path between them. Tiny People persist, travel, and die independently — but respond to verbal commands from their user.

## Core Mechanics

- **LiDAR → Voxel World** — iPhone ARKit scan converts real space to a 12×12 block-per-square-foot voxel grid
- **Geographic Biome** — GPS location determines block palette, seasonal behavior, and void hostility (see `docs/`)
- **The Void** — hostile force that consumes undefended scanned land; stronger at night, amplified by winter
- **Tiny People** — semi-autonomous AI characters; commandable but not fully controllable; personality-typed (MBTI-based archetypes); persistent across sessions
- **World Bridging** — users physically scan a path between two locations to create a persistent connection between worlds
- **Pocket Dimension** — Tiny People can be carried on-device and deployed in new scanned environments
- **Turn-based action cycle** — action/pause loop accommodates cloud latency; user plans during pause windows

## Technical Stack (planned)

| Layer | Technology |
|---|---|
| iPhone LiDAR capture | ARKit (Swift) |
| Mesh → voxel conversion | Rust + dda-voxelize |
| World generation engine | Rust (based on Arnis architecture) |
| World persistence | Cloud (always-on virtual machines per world region) |
| Biome / weather data | ESA WorldCover + Open-Meteo API |
| Tiny People AI | Custom behavior simulation (Rust) |
| Client rendering | AR + 3D (TBD) |

## Repository Structure

```
project-tinyworld/
  src/              # Rust backend — world generation, void rules, biome
  ios/              # Swift ARKit app — LiDAR capture, rendering, commands
  docs/             # Design specs and biome definitions
```

## Biomes

- [NYC Temperate](docs/biome-nyc-temperate.md)

## Status

Early design / pre-prototype. Weekend project.

## Attribution

World generation architecture informed by [Arnis](https://github.com/louis-e/arnis) (Apache 2.0).
