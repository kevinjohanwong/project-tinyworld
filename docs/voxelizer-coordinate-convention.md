# Voxelizer Input Contract & Coordinate Convention

Standardized so ANY 3D source (open government CityGML/LoD2, OSM footprint-extrude,
scan reconstructions) can target `tools/glb_to_world_payload.py` unchanged. If a
converter emits a GLB meeting this contract, the rest of the pipeline (payload →
world row → client latent interiors → ledger) works as-is. Validated end-to-end by
the UES dead-city run (Jul 2026): 297×334 m tile → 1.14 M shipped blocks + 8.06 M
latent interior cells at 0.5 m.

## 1. Input GLB contract

| Property | Requirement |
|---|---|
| Format | glTF 2.0 binary (`.glb`). Scene-graph node transforms ARE applied (trimesh `scene.graph`); prefer baked/identity matrices. |
| Units | Real meters, scale = 1. |
| Up axis | **+Y = up, gravity-aligned.** No up-axis detection is performed — a Z-up source (CityGML, most GIS) must be rotated −90° about X by the converter. |
| Horizontal frame | ENU, right-handed Y-up: **+X = east, +Z = south** (north = −Z). Matches `export-map-glb.ts` `toClient()`. |
| Origin | `(0,0,0)` = the world's geo anchor at ellipsoid height h = 0. **Y is preserved absolutely** (`vy = round(y/voxel)`); X/Z are re-centered to the mesh bbox center by the voxelizer, so XZ origin only matters as a convention for future tile stitching — keep it at the anchor. |
| Geometry only | Materials, textures, vertex colors are ignored. Meshes need NOT be watertight/manifold — triangles are barycentrically surface-sampled at ~voxel/2 steps. |
| Triangle budget | Hard cap `MAX_TRIANGLES = 220_000` — excess triangles are **silently dropped**. Decimate or tile the input to fit. |
| Tile extent | One tile per run. Reference: ~300–350 m across at 0.5 m voxel ≈ 1.1 M shipped blocks / ~18 MB payload. |

Georeference lives OUTSIDE the GLB: the world row carries anchor lat/lon; the GLB
carries no geo metadata. Convention: GLB origin = that anchor.

## 2. Mode switch — `VOXEL_M` env

- `VOXEL_M=<meters>` (default `0.5`) — **metric mode**, for complete gravity-aligned
  real-meter GLBs (government 3D data, map tiles). Trusts geometry directly: true
  street heights (no plane snap), per-column heightfield solid fill, latent-interior
  emission, no hills/cliffs synthesis.
- `VOXEL_M=auto` — **scan mode**, for COLMAP/OpenMVS reconstructions. Normalizes
  span to `TARGET_DIVS` (690 since 2026-07-11; was 345 — fidelity bump targeting
  ~5cm voxels, 1.5cm floor) and runs the shell-repair machinery (normal
  classification bands, dominant-plane floor snap, footprint fill, rolling hills,
  rim cliffs).
- Open-data / map tiles must ALWAYS run metric. Scan merges must ALWAYS pass
  `VOXEL_M=auto` (a leak here crashed joint-recon merges — fixed Jul 9 in
  `merge_capture_into_world.py`).

## 3. Yaw caveat — `rotate_to_cardinal` (OPEN DECISION for shared Earth)

The voxelizer auto-rotates the whole model about Y so the dominant wall orientation
aligns with grid cardinal axes (wall-normal yaw histogram mod 90°; applied when the
peak is in (1°, 89°); recorded as `meta.inferredFrom.rotated_deg`).
**Consequence: compass north is not preserved in voxel space.** Fine for isolated
worlds; wrong for stitching adjacent geo tiles into one shared Earth. Standardize
before multi-tile: either (a) env-gate rotation to 0° for geo-anchored tiles, or
(b) apply the inverse of `rotated_deg` at placement. Do not leave it implicit.

## 4. Output payload frame

- Voxel indices: `vx = round((x − centerX)/voxel)`, `vy = round(y/voxel)`,
  `vz = round((z − centerZ)/voxel)` where centerX/Z = mesh XZ bbox center.
  `meta.centerX/centerZ` are written as `0` (grid already re-centered).
- `layers`: `{ layerName: base64( little-endian int32 (x,y,z) triples ) }`.
- Latent interiors (metric mode only):
  - `meta.latentCols` = base64 LE int32 **quads `(x, z, y0, y1)`** per building
    column; any in-column cell in `[y0, y1]` absent from the shipped block set is
    latent-solid, materialized on dig by the client.
  - `meta.latentTotal` = exact absent-cell count (conservation ledger carries the
    interior mass analytically). `meta.latentVersion = 1`.
- `meta.voxel` = meters/voxel; `meta.rotated_deg`, `meta.sourceName` for provenance.

## 5. Reference implementations

- **Frame reference (producer)**: `project-tinyworld-voxel-spike/export-map-glb.ts`
  — the ENU merge that defines the client frame. NOTE: its Google 3D Tiles *source*
  is demo-only — Google's terms bar extraction/storage, so it can never ship.
  Open-data converters replace the source but must keep this exact output frame.
- **Consumer**: `project-tinyworld/tools/glb_to_world_payload.py`.
- **Injection**: `tools/old_path_from_capture.py` `update_world_from_payload`
  (worlds row + `world_blocks` payload upsert).
