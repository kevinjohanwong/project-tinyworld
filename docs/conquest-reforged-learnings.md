# Conquest Reforged — teardown learnings for TinyWorld (Aug 4, 2026)

Source: ConquestReforged-forge-1.20.1-1.6.2.jar (Modrinth, 230MB), inspected non-code
assets only. **License: All Rights Reserved** — patterns are fair to learn from; code,
models, and textures must NOT be copied. The mod's Java source is not public (the GitHub
org only hosts issue templates + a resource-pack shell repo).

## The headline number
**18,115 block variants are generated from only ~360 shape templates.**
95,382 model JSONs exist, but nearly all are one-line texture rebindings of a shared
parent template. The entire "6000+ blocks" reputation is a **shape × material
multiplication**, not bespoke content:

- ~360 geometry templates (`assets/conquest/models/block/templates/`)
- × material palette (granite, plaster, planks, copper …, incl. weathering states)
- × 4 yaw rotations (blockstate `y: 90/180/270` + `uvlock` — no unique meshes)
- × up to 4 thickness states (`layer=1..4` → 2/4/6/8-px-thick model variants)

## Shape vocabulary, ranked by their actual usage (blockstate suffix counts)
slab 5818 · corner 1531 · quarter 1375 · stairs 944 · half 776 · pillar 720 ·
arch 686 · wall 628 · capital 459 · window 404 · balustrade 377 · sphere 305 ·
arrowslit 291 · layer 124 …

Key insight: **the top ~6 shapes (≈80% of all variants) are axis-aligned box subsets**
of the unit cell — vertical slab = a 2–8px wall panel, quarter = a post, corner = an
L. Almost no non-axis-aligned geometry exists; arches and "spheres" are the exceptions.
Their detailed look does NOT come from arbitrary angles.

## Mechanisms worth stealing (as patterns)
1. **Sub-voxel shapes instead of finer voxels.** Detail comes from a fixed library of
   partial-cell shapes instanced per material — not from subdividing the grid. Memory
   cost ≈ 0 vs 8× from halving voxel size. Directly relevant to the CivicVoxel "finer
   voxels for pro feel" desire: Conquest proves shape vocabulary ≥ resolution.
2. **State model:** `facing(4) × layer(4)` = 16 placements per shape family sharing 4
   meshes. Rotation is a transform, never duplicated geometry.
3. **Connection-aware auto-shapes.** Beams/branches ship in `n / ne / ns / nse / nsew`
   connectivity variants and auto-select by neighbors (fence/pipe logic). 462 small
   Java behavior classes (Arch, Balustrade, BeamHorizontal…) define placement rules
   per shape *family*; geometry stays data-driven JSON.
4. **"Sphere" = chamfered box (7 axis-aligned elements).** Their rounding trick — a
   low-poly chamfer blob, no curves. Rounded reads come from chamfer + shading.
   Relevant to voxel clouds/trees.
5. **Layer/thickness blocks** (snow-style, 4 heights) blend terrain, paths, and
   surfaces sub-voxel without breaking the grid.
6. **Material variation sells it as much as shape**: weathering series (copper
   oxidation stages, cracked/mossy/wet variants) multiply the palette cheaply.
7. **Palette taxonomy**: 36 curated group files ordered by *building workflow*
   (cobble→masonry→columns→mosaics→plaster→timber→roofing→carpentry→windows→
   furniture…), each a flat ordered block list. Good template for any build-mode UI.

## What we could NOT inspect
The placement/selection UX (radial palette GUI, "grid-ignoring" free-placement magic
in 1.5+) lives in compiled Java — noted class names only, no decompilation.

## Where the artifacts live
Conversation workspace `conquest/` (jar + unpacked assets) — scratch, not committed.
