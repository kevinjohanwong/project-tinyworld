# Tinyworld Ownership Map

Use this before changing Tinyworld. The goal is to stop unrelated systems from being edited together inside the large live routes.

## Working Protocol

1. Name one zone before editing.
2. Read only that zone's notes and code first.
3. Back up touched live routes with the zone in the filename.
4. Edit only files/blocks owned by that zone.
5. If a fix requires another zone, stop and make it a separate pass.
6. Verify with the zone's test path.
7. Update this map or `AGENTS.md` only with stable decisions, not scratch notes.

## Zones

### 1. Scan Pipeline

Owns capture, reconstruction, voxel payload generation, and saved-world creation.

Files/routes:
- `/__substrate/space/routes/pages/tinyworld-capture.tsx`
- `/__substrate/space/routes/api/api-tinyworld-capture.ts`
- `/__substrate/space/routes/api/api-tinyworld-infer.ts`
- `tools/old_path_from_capture.py`
- `tools/glb_to_world_payload.py`
- `project-photogrammetry/scripts/extract_frames.ts`
- `project-photogrammetry/scripts/run_colmap.ts`
- `project-photogrammetry/scripts/run_openmvs.ts`
- `project-photogrammetry/scripts/align_gravity.py`

Does not own:
- runtime terrain cleanup in the game route
- Sentinel/drone controls
- villager simulation

Verify:
- run old-good-video A/B when checking pipeline regression
- inspect COLMAP registered images, sparse points, OpenMVS dense points, mesh triangles
- load generated world in staging only after reconstruction stats are sane

Hard constraints:
- Depth/RGB-D/TSDF is removed and must not be restored as fallback/debug.
- Good capture motion matters more than duration: translated sidestep/arc beats pivoting.

### 2. Terrain Rendering

Owns how saved voxel layers become visible/collidable world geometry.

Files/routes:
- `/__substrate/space/routes/pages/tinyworld.tsx`
- `/__substrate/space/routes/pages/tinyworld-staging.tsx`
- terrain/layer sections: `addLayer`, `colMap`, `groundMap`, hole-fill, bush-cull, vegetation decorator runtime handling

Does not own:
- COLMAP/OpenMVS reconstruction settings
- GLB converter mesh sampling unless explicitly doing Scan Pipeline work
- player/Sentinel movement logic

Verify:
- load representative saved worlds with `?debug=1`
- check console counters for hole-fill/bush-cull
- screenshot ground-level and mode views
- confirm `window.__twLoopError === false`

Hard constraints:
- Do not delete load-bearing layers wholesale.
- Prefer additive fill over destructive cleanup.
- Keep tree preservation and walkability separate decisions.

### 3. Player, Sentinel, Drone

Owns piloting, collision, camera, Sentinel/drone rendering, animation, and gait.

Files/routes:
- `/__substrate/space/routes/pages/tinyworld.tsx`
- `/__substrate/space/routes/pages/tinyworld-staging.tsx`
- `/sentinel.glb` asset path and route assets when swapping the Sentinel model
- control/camera sections: walk loop, drone loop, `renderSentinel`, `tickSentinel`, chase camera, cockpit/third/drone view modes

Does not own:
- scan pipeline
- terrain generation except collision queries it consumes
- villager AI

Verify:
- `agent-browser` local staging view
- `__tw.setPilotMode("cockpit"|"third"|"drone")`
- screenshots for GLB visibility/framing
- keyboard movement for crash checks
- device check for motion feel

Hard constraints:
- Keep cockpit/drone unchanged when a request is scoped to 3RD.
- Animation feel and travel speed must be tuned together.
- Camera should follow the mech in 3RD; it should not pull the mech.

### 4. Characters and Villagers

Owns Tiny People, workers, GOAP planning, Gemini planner calls, and character behavior.

Files/routes:
- `/__substrate/space/routes/pages/tinyworld.tsx`
- `/__substrate/space/routes/pages/tinyworld-staging.tsx`
- `/__substrate/space/routes/api/api-tinyworld-plan.ts`
- docs: `docs/tiny-people.md`

Does not own:
- Sentinel/drone piloting
- scan reconstruction
- terrain cleanup except as walkability input

Verify:
- worker state/debug hooks
- planner API responses
- no new Gemini failures beyond known transient 503s
- ledger balance after pickup/place/build actions

Hard constraints:
- Tiny People are commandable, not directly controllable.
- Worker actions must preserve the conservation ledger.

### 5. Geo, Access, Persistence

Owns world discovery, GPS gates, DB schema, save/load, bridges, and route-level access logic.

Files/routes:
- `/__substrate/space/routes/api/api-tinyworld-worlds.ts`
- `/__substrate/space/routes/api/api-tinyworld-access.ts`
- `/__substrate/space/routes/api/api-tinyworld-scan.ts`
- `data/tinyworld.db`
- docs: `docs/persistence-and-access.md`, `docs/scan-composition-and-tectonics.md`

Does not own:
- reconstruction quality
- visual terrain cleanup
- control/camera behavior

Verify:
- DB backup before any write
- API smoke tests for world list/access/save/load
- saved-world round trip

Hard constraints:
- Back up `data/tinyworld.db` before schema/data mutations.
- Do not delete historical bad worlds unless KJ explicitly asks.

### 6. Game Systems

Owns void, ledger, stockpile, press, ships, bombs, scan-seconds, growth, and decay.

Files/routes:
- `/__substrate/space/routes/pages/tinyworld.tsx`
- `/__substrate/space/routes/pages/tinyworld-staging.tsx`
- docs: `docs/mass-and-density.md`, `docs/scan-economy.md`, `docs/biome-nyc-temperate.md`

Does not own:
- capture/reconstruction
- Sentinel camera/gait unless the game-system change explicitly affects piloting cost/behavior
- villager planning except as a consumer of game actions

Verify:
- `__tw.ledger()`
- system-specific debug hooks
- save/load persistence
- mass conservation before/after actions

Hard constraints:
- `WORLD + STOCKPILE + BUILT + VOID === baseline`.
- Stockpile must stay physically visible, not a hidden inventory.

## Cross-Zone Change Rules

Use a separate pass when a task crosses zone boundaries. Example splits:

- "Improve scan quality and remove bushes" means first Scan Pipeline diagnostics, then Terrain Rendering cleanup.
- "Sentinel clips because terrain is noisy" means first identify whether collision data is wrong (Terrain) or body/camera placement is wrong (Player/Sentinel/Drone).
- "New capture created a bad world" means first Scan Pipeline stats, not converter or runtime terrain edits.

## Backup Naming

For live Space route files:

```bash
/__substrate/space/.route-backups/<route>.<UTC timestamp>.<zone-slug>.<short-change>.tsx
```

Examples:

- `tinyworld-staging.20260626T180000Z.player-sentinel.chase-tune.tsx`
- `tinyworld-capture.20260626T180000Z.scan-pipeline.sensor-coach.tsx`

## Headless Testing

Use local Space for agent-side verification:

```bash
agent-browser open 'http://localhost:3099/tinyworld-staging?world=<world_id>&debug=1'
agent-browser eval 'JSON.stringify({ready:!!window.__tw, loopError:!!window.__twLoopError, state:window.__tw?.state?.()})'
agent-browser screenshot /tmp/tinyworld-check.png
```

Headless is good for load, render, screenshots, terrain counters, and crash checks. It is weak for high-fidelity motion feel; KJ's device remains the final check for piloting feel.
