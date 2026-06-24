# Scan Composition & Tectonics

*Locked Jun 13, 2026 (telegram design session). Supersedes the "worlds as separate islands connected by bridges" model in `AGENTS.md` for the multi-scan composition case. Bridges remain as the access/auth concept; tectonics defines how scan geometry composes into a single unified world.*

## Core model

**Geo-tag is the canonical anchor.** Every scan is anchored to its real-world geo (lat/lon/altitude/heading). Scans are imperfect snapshots of physical space. The world is composed from many scans, not stitched into one perfect mesh.

**One scan per geo region.** Once an area has been scanned, it cannot be scanned again — except in the exceptional cases below. This makes scanning a meaningful, permanent act.

**Overlap classification (locked Jun 14, 2026):**
- **Full overlap** (new scan's center within `FULL_OVERLAP_RADIUS_M` = 50m of an existing scan's center) → **BLOCKED**. You cannot re-scan the same spot. Exceptions below still apply.
- **Partial overlap / seam** (new scan's center is 50m–150m from an existing scan's center, i.e. region edges touch) → **ALLOWED** and flagged as a tectonic event. This is how the world grows.
- **No overlap** (>150m) → ALLOWED, no tectonic event.

**Exceptional cases that allow a re-scan over a full overlap:**
1. The original scanner re-scanning their own space (you own what you captured).
2. Long staleness — the region has been inactive for >6 months and is marked "weathered," eligible for refresh by anyone.
3. In-game cataclysm — rare, dramatic, gated by Void incursion or community vote.

## Seams, not stitches

Scans are not stitched into a perfect single mesh. Each scan is a chunk of geometry anchored at its geo. Where two adjacent scans meet, there is a **seam**. Tectonic events happen ONLY at seams — the interior of any scan is permanent, canonical, and safe to build on.

## Alignment flow (on scan submission)

When a player submits a new scan that is adjacent to existing scanned territory:

1. The system finds candidate seam edges based on geo-proximity.
2. The player is shown an alignment UI: existing world on one side, new scan as a floating ghost.
3. They drag and rotate the new scan into rough position, snapping to doorways and wall planes.
4. The system runs ICP refinement on the overlap region for sub-block alignment.
5. Overlapping/duplicated blocks are deduplicated.
6. The new chunk is committed into the shared voxel grid.

Manual coarse + system-assisted fine alignment. Manual is more reliable than auto-relocalization indoors (ARKit fails on featureless walls and changed lighting), and the manual placement moment feels like a building action — fits the game vibe.

## Tectonic events

A **tectonic event** is the system's reconciliation of conflicting block data when a new scan's seam overlaps with existing world geometry.

- New scan's blocks settle into place.
- Conflicting old blocks are displaced. Some become rubble, some are absorbed into the Void.
- The world visibly shifts — players watching see ground rumble, blocks slide, lighting change.
- Conservation ledger holds: displaced mass flows into the Void pool. `WORLD + STOCKPILE + BUILT + VOID = constant` is preserved.

**Frequency:** instant on scan submission (no batching for v1).
**Visibility:** real-time animated shift for any player present in the affected geo region.
**Chunk size:** a scan IS a chunk. No fixed grid size — chunks are scan-shaped.

## Builds and risk

Builds at the **edge** of a scan are at risk of tectonic events when a neighboring scan arrives. Builds in the **interior** are permanent.

**Player advice (in-game tooltip):**
- Build deep inside your scanned territory if you want permanence.
- Avoid the perimeter unless you're OK with your build being reshaped.
- If you want to extend connected territory, scan adjacent — but expect seams to shift.

No "sacred build" protection rules. The geography itself signals risk. This self-organizes player behavior: frontier zones (high scan activity, churning, dangerous to build) emerge near cities and gathering points; wilderness zones (rarely scanned, stable) form at the edges, where serious long-term builds live. Mirrors real-world real estate: you don't build on a fault line.

## Tectonic risk heatmap

The world map shows a heat-colored overlay of recent tectonic activity. Players can see which zones are likely to shift before committing to a build. Like a flood-zone map.

## Conflict with current AGENTS.md model

`AGENTS.md` #2 currently states "Geography is the auth layer. Access via geo gate (GPS within 150m of anchor) OR a live bridge." Bridges as the access concept survive. What changes:

- **Old**: each scan = its own world (own DB row in `worlds`, separate voxel space, accessed by bridge).
- **New**: each scan = a chunk in a shared geo-anchored world. Bridges still control access (you can only walk into a region whose bridge is alive), but the geometry is unified.

This implies a schema migration: `world_blocks` rows gain a `scan_id` foreign key and a geo bounding box; `worlds` table may collapse into a `scans` table. To be designed when implementation starts.

## Open questions

1. **Seam priority on conflict:** when a new scan claims blocks that the existing world has built upon, who wins? Likely: built blocks freeze the seam at that point (build wins), and the new scan deforms locally. Needs a worked example.
2. **Cross-scan worker AI pathing:** do Tiny Workers naturally path across seams once geometry is unified? Likely yes via the existing A* on `groundMap`, since groundMap will now span chunks.
3. **Geo resolution of the heatmap:** what's the minimum cell size for the risk overlay? Room-sized (~10m) probably right.
4. **Multi-player tectonic visibility:** if KJ is in his apartment and someone scans an adjacent street, does KJ see the seam shift in real time? Server-pushed animation event — yes, but bandwidth implications.
