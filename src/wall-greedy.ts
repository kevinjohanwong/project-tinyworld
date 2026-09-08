// Greedy-meshed wall layer for the live TinyWorld.
//
// The wall is the photogrammetry shell — ~70% of every world's blocks and the
// sole driver of the iOS GPU-VRAM crash (each wall voxel was a full instanced
// cube + per-vertex AO buffers). Greedy meshing merges coplanar faces and drops
// interior faces entirely, collapsing hundreds of thousands of cubes into a few
// hundred K triangles with no per-instance buffers.
//
// To avoid re-plumbing the simulation (which mutates the world through a
// `slotMap` + `setMatrixAt` protocol on InstancedMeshes — see picking, void
// erosion, player pickup/place, serialization), this returns a THREE.Group that
// *quacks* like an InstancedMesh:
//   - userData.slotMap        Map<"x,y,z", slot>  — membership + serialize
//   - userData.freeSlots      synthetic infinite slot pool (placement)
//   - userData.hiddenMap      empty (greedy culls interior faces for free)
//   - setMatrixAt(slot, m)    decodes the voxel from the matrix (place) or the
//                             slot key (break) and queues a single-chunk remesh
//   - instanceMatrix          { needsUpdate } no-op sink
//   - material                { color } for charge-pickup ghost tint
// Every existing call site therefore works unchanged; the only new per-frame
// cost is flushDirty(), which re-meshes chunks touched by edits.
//
// Chunked from the start so view-dependent residency ("load only when seen")
// for future world-stitching can layer on by gating which chunks are meshed.

import { greedyMesh } from "./greedy";
import type { CompiledChunkGeometry, CompiledChunkMap } from "./compiled-world-cache";

const CS = 32;          // chunk edge (voxels)
const WALL_TYPE = 1;    // single material id in the color LUT
const PAD = 1;          // grid margin so a wall block placed one voxel beyond
                        // the original bbox still meshes (rare but real)

export interface GreedyWallOpts {
  wall: Int32Array;     // stride-3 absolute voxel coords [x,y,z, ...]
  voxel: number;        // world units per voxel (BLOCK_SCALE)
  cxRound: number;      // world X centering offset (voxels)
  czRound: number;      // world Z centering offset (voxels)
  color: number;        // PAL.wall hex
  castShadow?: boolean;
  aoStrength?: number;  // baked-AO contrast (0 = flat/no seam lines, 1 = full)
  aoAware?: boolean;    // merge faces only when 4-corner AO matches → kills the
                        // AO-interpolation crease lines (~+73% tris on scan walls).
  onEdit?: (vx: number, vy: number, vz: number, solid: boolean) => void;
                        // notifies the ground greedy grid so its wall occluders
                        // stay in sync (dug wall must reveal buried ground faces).
  cachedChunks?: CompiledChunkMap;
}

export interface GreedyWall {
  group: any;                         // THREE.Group, pushed to meshesRef + scene
  flushDirty: (maxChunks?: number) => number;
  setAO: (strength: number) => void;  // re-mesh every chunk at a new AO contrast
  stats: () => { chunks: number; tris: number; voxels: number };
  exportChunks: () => CompiledChunkMap;
}

export function createGreedyWall(THREE: any, opts: GreedyWallOpts): GreedyWall {
  const { wall, voxel, cxRound, czRound, color } = opts;
  const castShadow = opts.castShadow !== false;
  // Reverted to full baked AO (original look). Softening it made the seam lines
  // WORSE, which means they aren't AO — they're chunk-boundary lighting/normal
  // seams that the AO gradient was partly masking. Real fix lives elsewhere.
  let aoStrength = opts.aoStrength ?? 1;
  const aoAware = opts.aoAware ?? false;

  // ── bounds (PAD-expanded) ─────────────────────────────────────────────
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < wall.length; i += 3) {
    const x = wall[i], y = wall[i + 1], z = wall[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = -1; }
  minX -= PAD; minY -= PAD; minZ -= PAD;
  maxX += PAD; maxY += PAD; maxZ += PAD;
  const dx = Math.max(0, maxX - minX + 1);
  const dy = Math.max(0, maxY - minY + 1);
  const dz = Math.max(0, maxZ - minZ + 1);

  // ── dense occupancy (system RAM; source of truth, never on the GPU) ────
  const grid = new Uint8Array(dx * dy * dz);
  const lidx = (lx: number, ly: number, lz: number) => lx + ly * dx + lz * dx * dy;
  const localGet = (lx: number, ly: number, lz: number): number =>
    (lx < 0 || ly < 0 || lz < 0 || lx >= dx || ly >= dy || lz >= dz) ? 0 : grid[lidx(lx, ly, lz)];
  let voxelCount = 0;
  for (let i = 0; i < wall.length; i += 3) {
    const lx = wall[i] - minX, ly = wall[i + 1] - minY, lz = wall[i + 2] - minZ;
    const k = lidx(lx, ly, lz);
    if (grid[k] === 0) voxelCount++;
    grid[k] = WALL_TYPE;
  }

  // ── color LUT (AO baked into vertex color = wallColor * ao) ────────────
  const colorLUT = new Float32Array(8 * 3);
  const c = new THREE.Color(color);
  colorLUT[WALL_TYPE * 3] = c.r;
  colorLUT[WALL_TYPE * 3 + 1] = c.g;
  colorLUT[WALL_TYPE * 3 + 2] = c.b;

  // vertexColors carry the tinted+AO color, so material.color stays white.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });

  // ── group: scale = voxel; baseline position 0 so the reverse-depth effect
  //    (sets group.position.y each frame) behaves exactly like an InstancedMesh.
  const group = new THREE.Group();
  group.scale.setScalar(voxel);

  const nCX = Math.ceil(dx / CS) || 0;
  const nCY = Math.ceil(dy / CS) || 0;
  const nCZ = Math.ceil(dz / CS) || 0;
  const chunkMeshes = new Map<string, any>();
  const compiledChunks: CompiledChunkMap = new Map();
  let hydrating = true;

  function makeGeometry(data: CompiledChunkGeometry) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  function extractPadded(ox: number, oy: number, oz: number, csx: number, csy: number, csz: number): Uint16Array {
    const px = csx + 2, py = csy + 2, pz = csz + 2;
    const vol = new Uint16Array(px * py * pz);
    for (let z = -1; z <= csz; z++)
      for (let y = -1; y <= csy; y++)
        for (let x = -1; x <= csx; x++) {
          const t = localGet(ox + x, oy + y, oz + z);
          if (t !== 0) vol[(x + 1) + (y + 1) * px + (z + 1) * px * py] = t;
        }
    return vol;
  }

  function meshChunk(cx: number, cy: number, cz: number) {
    const ox = cx * CS, oy = cy * CS, oz = cz * CS;
    const csx = Math.min(CS, dx - ox), csy = Math.min(CS, dy - oy), csz = Math.min(CS, dz - oz);
    const key = cx + "," + cy + "," + cz;
    const existing = chunkMeshes.get(key);
    if (csx <= 0 || csy <= 0 || csz <= 0) {
      compiledChunks.set(key, null);
      if (existing) { group.remove(existing); existing.geometry.dispose(); chunkMeshes.delete(key); }
      return;
    }
    let data: CompiledChunkGeometry | null | undefined =
      hydrating && opts.cachedChunks?.has(key) ? opts.cachedChunks.get(key) : undefined;
    if (data === undefined) {
      const vol = extractPadded(ox, oy, oz, csx, csy, csz);
      const m = greedyMesh(vol, csx + 2, csy + 2, csz + 2, colorLUT, aoStrength, aoAware);
      data = m.positions.length === 0 ? null : {
        positions: m.positions,
        normals: m.normals,
        colors: m.colors,
        indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices),
      };
    }
    compiledChunks.set(key, data);
    if (!data) {
      if (existing) { group.remove(existing); existing.geometry.dispose(); chunkMeshes.delete(key); }
      return;
    }
    const geo = makeGeometry(data);
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, material);
      // child coords are in voxel units (group scale handles *voxel). Bake the
      // -0.5 voxel centering + cxRound/czRound here, NOT in group.position
      // (which the reverse-depth effect owns).
      mesh.position.set(
        (minX + ox) - cxRound - 0.5,
        (minY + oy) - 0.5,
        (minZ + oz) - czRound - 0.5,
      );
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.userData = { wallChunk: true };
      chunkMeshes.set(key, mesh);
      group.add(mesh);
    }
  }

  // ── initial build (synchronous; strictly lighter than the instanced path
  //    it replaces, which baked per-vertex AO for every cube) ──────────────
  for (let cz = 0; cz < nCZ; cz++)
    for (let cy = 0; cy < nCY; cy++)
      for (let cx = 0; cx < nCX; cx++)
        meshChunk(cx, cy, cz);
  hydrating = false;

  // ── edit plumbing ─────────────────────────────────────────────────────
  const dirty = new Set<string>();
  const markDirty = (lx: number, ly: number, lz: number) => {
    const cx = Math.floor(lx / CS), cy = Math.floor(ly / CS), cz = Math.floor(lz / CS);
    const add = (a: number, b: number, d: number) => {
      if (a < 0 || b < 0 || d < 0 || a >= nCX || b >= nCY || d >= nCZ) return;
      dirty.add(a + "," + b + "," + d);
    };
    // A voxel on a chunk face changes the neighbour chunk's padding ring --
    // including EDGE/CORNER diagonals (the padded extract samples the full
    // one-cell halo, so a corner voxel touches up to 8 chunks). Cartesian
    // product over the per-axis offsets covers all of them.
    const xo = lx % CS === 0 ? -1 : lx % CS === CS - 1 ? 1 : 0;
    const yo = ly % CS === 0 ? -1 : ly % CS === CS - 1 ? 1 : 0;
    const zo = lz % CS === 0 ? -1 : lz % CS === CS - 1 ? 1 : 0;
    for (const ax of xo ? [0, xo] : [0])
      for (const ay of yo ? [0, yo] : [0])
        for (const az of zo ? [0, zo] : [0]) add(cx + ax, cy + ay, cz + az);
  };
  const setVoxel = (vx: number, vy: number, vz: number, val: number) => {
    const lx = vx - minX, ly = vy - minY, lz = vz - minZ;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= dx || ly >= dy || lz >= dz) return; // outside PAD-expanded grid
    const k = lidx(lx, ly, lz);
    if (grid[k] === val) return;
    grid[k] = val;
    markDirty(lx, ly, lz);
  };

  // placed-voxel slot tokens → key, so a later break (which only knows the slot)
  // can recover the voxel. Initial voxels store their own key as the slot.
  const tokenKey = new Map<number, string>();
  let tokenCounter = 1;

  const isZeroScale = (el: ArrayLike<number>) =>
    el[0] === 0 && el[5] === 0 && el[10] === 0;

  // ── InstancedMesh-compatible shims ────────────────────────────────────
  group.userData = {
    layer: "wall",
    slotMap: new Map<string, any>(),
    hiddenMap: new Map<string, number>(),
    freeSlots: {
      get length() { return 1; },        // always "has a free slot"
      pop() { return tokenCounter++; },  // unique placement token
      push() { /* virtual slots — nothing to reclaim */ },
    },
    greedyWall: true,
  };
  for (let i = 0; i < wall.length; i += 3) {
    const k = wall[i] + "," + wall[i + 1] + "," + wall[i + 2];
    group.userData.slotMap.set(k, k); // slot === key for initial voxels
  }

  (group as any).instanceMatrix = { needsUpdate: false };
  (group as any).material = { color: new THREE.Color(color) }; // charge-ghost tint only
  (group as any).setMatrixAt = (slot: any, matrix: any) => {
    const el = matrix.elements;
    if (isZeroScale(el)) {
      // break: recover voxel from the slot (token → key, or key directly)
      const key = (typeof slot === "number") ? tokenKey.get(slot) : slot;
      if (key === undefined) return;
      if (typeof slot === "number") tokenKey.delete(slot);
      const p = key.split(",");
      setVoxel(+p[0], +p[1], +p[2], 0);
      opts.onEdit?.(+p[0], +p[1], +p[2], false);
    } else {
      // place: decode the voxel from the matrix translation
      const vx = Math.round(el[12] / voxel + cxRound);
      const vy = Math.round(el[13] / voxel);
      const vz = Math.round(el[14] / voxel + czRound);
      if (typeof slot === "number") tokenKey.set(slot, vx + "," + vy + "," + vz);
      setVoxel(vx, vy, vz, WALL_TYPE);
      opts.onEdit?.(vx, vy, vz, true);
    }
  };

  // Re-mesh every chunk at a new AO contrast (live A/B from the debug harness).
  function setAO(strength: number) {
    aoStrength = strength;
    for (let cz = 0; cz < nCZ; cz++)
      for (let cy = 0; cy < nCY; cy++)
        for (let cx = 0; cx < nCX; cx++)
          meshChunk(cx, cy, cz);
  }

  function flushDirty(maxChunks = Infinity) {
    if (dirty.size === 0) return 0;
    let n = 0;
    for (const k of dirty) {
      const p = k.split(",");
      meshChunk(+p[0], +p[1], +p[2]);
      dirty.delete(k);
      if (++n >= maxChunks) break;
    }
    return n;
  }

  function stats() {
    let tris = 0;
    for (const m of chunkMeshes.values()) {
      const idx = m.geometry.getIndex();
      if (idx) tris += idx.count / 3;
    }
    return { chunks: chunkMeshes.size, tris, voxels: voxelCount };
  }

  const exportChunks = () => new Map(compiledChunks);

  return { group, flushDirty, setAO, stats, exportChunks };
}
