// Greedy-meshed ground layers (dirt / grass / dryGrass) for the live TinyWorld.
//
// Companion to wall-greedy.ts: the ground trio (+ occlusion-culled hidden dirt)
// is the remaining bulk of every world's instanced cubes — mostly buried faces
// no camera can ever see. One SHARED occupancy grid lets the three layers cull
// faces against each other (a dirt top under a grass block is never drawn),
// and the wall layer is stamped in as a hard occluder so ground faces buried
// behind photogrammetry shell drop out too. Translucent/fadeable neighbours
// (ceiling, leaves, water) and trunks are stamped as AO-only: they darken
// corner AO exactly like the instanced cross-layer bake did, but never cull —
// so the dollhouse ceiling fade can never reveal missing ground faces.
//
// Simulation compatibility mirrors wall-greedy: each layer gets a logic-only
// THREE.Group facade that quacks like an InstancedMesh (slotMap / hiddenMap /
// freeSlots / setMatrixAt / instanceMatrix sink), so picking, void erosion,
// pickup/place, settle, serialization, and the hidden-dirt reveal protocol all
// work unchanged. setColorAt (arid/moisture per-block tint) is honoured by
// baking the tint into vertex colors on chunk remesh; faces with different
// tints never merge, so the dryness gradient stays per-block exact.
//
// Render meshes live in a single renderGroup, chunked CS^3 like the wall.

import { greedyMesh } from "./greedy";
import type { CompiledChunkGeometry, CompiledChunkMap } from "./compiled-world-cache";

const CS = 32;          // chunk edge (voxels)
const PAD = 1;          // grid margin so a block placed one voxel beyond the
                        // original bbox still meshes
const T_DIRT = 1;
const T_GRASS = 2;
const T_DRY = 3;
const T_AO = 6;         // AO-only neighbour (ceiling/trunks/leaves/water)
const T_OCC = 7;        // hard occluder (wall): culls + AO, never emits

const EMIT = (t: number) => t <= 3;
const AO_ONLY = (t: number) => t === T_AO;

export interface GreedyGroundOpts {
  layers: {
    dirt?: Int32Array | null;
    grass?: Int32Array | null;
    dryGrass?: Int32Array | null;
  };
  hiddenDirt?: Int32Array | null;   // occlusion-culled dirt: solid in the grid
                                    // (buried => no faces) so reveals are free
  colors: { dirt: number; grass: number; dryGrass: number };
  occluders?: Array<Int32Array | null | undefined>;   // wall
  aoNeighbors?: Array<Int32Array | null | undefined>; // ceiling/trunks/leaves/water
  voxel: number;
  cxRound: number;
  czRound: number;
  aoAware?: boolean;
  castShadow?: boolean;
  cachedChunks?: CompiledChunkMap;
}

export interface GreedyGround {
  renderGroup: any;
  facades: { dirt: any; grass: any; dryGrass: any };
  flushDirty: (maxChunks?: number) => number;
  setExternalOccluder: (vx: number, vy: number, vz: number, solid: boolean) => void;
  stats: () => { chunks: number; tris: number; voxels: number; hidden: number; dirtyPending: number };
  exportChunks: () => CompiledChunkMap;
}

export function createGreedyGround(THREE: any, opts: GreedyGroundOpts): GreedyGround {
  const { voxel, cxRound, czRound } = opts;
  const aoAware = opts.aoAware ?? true;
  const castShadow = opts.castShadow === true;

  const srcLayers: Array<[Int32Array, number]> = [];
  if (opts.layers.dirt?.length) srcLayers.push([opts.layers.dirt, T_DIRT]);
  if (opts.layers.grass?.length) srcLayers.push([opts.layers.grass, T_GRASS]);
  if (opts.layers.dryGrass?.length) srcLayers.push([opts.layers.dryGrass, T_DRY]);
  const hiddenArr = opts.hiddenDirt?.length ? opts.hiddenDirt : null;

  // ── bounds from the ground layers + hidden dirt only ──────────────────
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const noteBounds = (a: Int32Array) => {
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  };
  for (const [a] of srcLayers) noteBounds(a);
  if (hiddenArr) noteBounds(hiddenArr);
  if (!isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = -1; }
  minX -= PAD; minY -= PAD; minZ -= PAD;
  maxX += PAD; maxY += PAD; maxZ += PAD;
  const dx = Math.max(0, maxX - minX + 1);
  const dy = Math.max(0, maxY - minY + 1);
  const dz = Math.max(0, maxZ - minZ + 1);

  // ── dense occupancy (system RAM; source of truth, never on the GPU).
  //    Net memory drops: this replaces far larger per-instance matrix + AO
  //    attribute buffers the instanced path uploaded for the same voxels. ──
  const grid = new Uint8Array(dx * dy * dz);
  const lidx = (lx: number, ly: number, lz: number) => lx + ly * dx + lz * dx * dy;
  const inGrid = (lx: number, ly: number, lz: number) =>
    lx >= 0 && ly >= 0 && lz >= 0 && lx < dx && ly < dy && lz < dz;

  const nCX = Math.ceil(dx / CS) || 0;
  const nCY = Math.ceil(dy / CS) || 0;
  const nCZ = Math.ceil(dz / CS) || 0;
  const chunkOf = (lx: number, ly: number, lz: number) =>
    ((lx / CS) | 0) + ((ly / CS) | 0) * nCX + ((lz / CS) | 0) * nCX * nCY;
  // per-chunk emittable-cell count: lets the initial sweep + remesh skip
  // chunks that contain only occluders/air.
  const chunkEmit = new Int32Array(Math.max(1, nCX * nCY * nCZ));

  let voxelCount = 0;
  const stamp = (a: Int32Array, t: number, onlyEmpty: boolean) => {
    for (let i = 0; i < a.length; i += 3) {
      const lx = a[i] - minX, ly = a[i + 1] - minY, lz = a[i + 2] - minZ;
      if (!inGrid(lx, ly, lz)) continue;
      const k = lidx(lx, ly, lz);
      const cur = grid[k];
      if (onlyEmpty && cur !== 0) continue;
      if (cur === 0 && t <= 3) { voxelCount++; chunkEmit[chunkOf(lx, ly, lz)]++; }
      grid[k] = t;
    }
  };
  for (const [a, t] of srcLayers) stamp(a, t, false);
  if (hiddenArr) stamp(hiddenArr, T_DIRT, true);
  for (const a of opts.occluders || []) if (a?.length) stamp(a, T_OCC, true);
  for (const a of opts.aoNeighbors || []) if (a?.length) stamp(a, T_AO, true);

  // ── color LUT + arid tint palette ──────────────────────────────────────
  const colorLUT = new Float32Array(8 * 3);
  const setLUT = (t: number, hex: number) => {
    const c = new THREE.Color(hex);
    colorLUT[t * 3] = c.r; colorLUT[t * 3 + 1] = c.g; colorLUT[t * 3 + 2] = c.b;
  };
  setLUT(T_DIRT, opts.colors.dirt);
  setLUT(T_GRASS, opts.colors.grass);
  setLUT(T_DRY, opts.colors.dryGrass);

  // Per-voxel arid tint (rgb multiplier). Interned to small ids so the merge
  // key stays an int compare; dryness is already quantized upstream (1/48
  // steps), so the palette stays tiny.
  const tintByKey = new Map<string, number>();
  const tintIds = new Map<string, number>();
  const tintLUT: number[] = [0, 0, 0]; // id 0 unused
  const chunkTint = new Int32Array(Math.max(1, nCX * nCY * nCZ));
  const internTint = (r: number, g: number, b: number): number => {
    const key = ((r * 4096) | 0) + "," + ((g * 4096) | 0) + "," + ((b * 4096) | 0);
    let id = tintIds.get(key);
    if (id === undefined) {
      id = tintLUT.length / 3;
      tintIds.set(key, id);
      tintLUT.push(r, g, b);
    }
    return id;
  };

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });

  const renderGroup = new THREE.Group();
  renderGroup.scale.setScalar(voxel);
  renderGroup.userData = { layer: "groundGreedyRender", greedyGroundRender: true };

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
          const lx = ox + x, ly = oy + y, lz = oz + z;
          if (!inGrid(lx, ly, lz)) continue;
          const t = grid[lidx(lx, ly, lz)];
          if (t !== 0) vol[(x + 1) + (y + 1) * px + (z + 1) * px * py] = t;
        }
    return vol;
  }

  function meshChunk(cx: number, cy: number, cz: number) {
    const ox = cx * CS, oy = cy * CS, oz = cz * CS;
    const csx = Math.min(CS, dx - ox), csy = Math.min(CS, dy - oy), csz = Math.min(CS, dz - oz);
    const key = cx + "," + cy + "," + cz;
    const existing = chunkMeshes.get(key);
    const ci = cx + cy * nCX + cz * nCX * nCY;
    if (csx <= 0 || csy <= 0 || csz <= 0 || chunkEmit[ci] <= 0) {
      compiledChunks.set(key, null);
      if (existing) { renderGroup.remove(existing); existing.geometry.dispose(); chunkMeshes.delete(key); }
      return;
    }
    let data: CompiledChunkGeometry | null | undefined =
      hydrating && opts.cachedChunks?.has(key) ? opts.cachedChunks.get(key) : undefined;
    if (data === undefined) {
      const vol = extractPadded(ox, oy, oz, csx, csy, csz);
      const extras: any = { aoOnly: AO_ONLY, emit: EMIT };
      if (chunkTint[ci] > 0) {
        extras.tintAt = (vx2: number, vy2: number, vz2: number): number =>
          tintByKey.get((minX + ox + vx2) + "," + (minY + oy + vy2) + "," + (minZ + oz + vz2)) || 0;
        extras.tintLUT = tintLUT;
      }
      const m = greedyMesh(vol, csx + 2, csy + 2, csz + 2, colorLUT, 1, aoAware, extras);
      data = m.positions.length === 0 ? null : {
        positions: m.positions,
        normals: m.normals,
        colors: m.colors,
        indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices),
      };
    }
    compiledChunks.set(key, data);
    if (!data) {
      if (existing) { renderGroup.remove(existing); existing.geometry.dispose(); chunkMeshes.delete(key); }
      return;
    }
    const geo = makeGeometry(data);
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(
        (minX + ox) - cxRound - 0.5,
        (minY + oy) - 0.5,
        (minZ + oz) - czRound - 0.5,
      );
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.userData = { groundChunk: true };
      chunkMeshes.set(key, mesh);
      renderGroup.add(mesh);
    }
  }

  for (let cz = 0; cz < nCZ; cz++)
    for (let cy = 0; cy < nCY; cy++)
      for (let cx = 0; cx < nCX; cx++)
        meshChunk(cx, cy, cz);
  hydrating = false;

  // ── edit plumbing (shared dirty set across the three facades) ──────────
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
    if (!inGrid(lx, ly, lz)) return;
    const k = lidx(lx, ly, lz);
    const cur = grid[k];
    if (cur === val) return;
    const ci = chunkOf(lx, ly, lz);
    const wasEmit = cur >= 1 && cur <= 3, isEmit = val >= 1 && val <= 3;
    if (isEmit && !wasEmit) { voxelCount++; chunkEmit[ci]++; }
    if (wasEmit && !isEmit) { voxelCount--; chunkEmit[ci]--; }
    grid[k] = val;
    markDirty(lx, ly, lz);
  };

  const isZeroScale = (el: ArrayLike<number>) =>
    el[0] === 0 && el[5] === 0 && el[10] === 0;

  // ── InstancedMesh-compatible facades, one per layer ────────────────────
  const makeFacade = (layerName: string, typeId: number, baseColor: number) => {
    const g = new THREE.Group();
    const tokenKey = new Map<number, string>();
    let tokenCounter = 1;
    g.userData = {
      layer: layerName,
      slotMap: new Map<string, any>(),
      hiddenMap: new Map<string, any>(),
      greedyGround: true,
      freeSlots: {
        get length() { return 1; },
        pop() { return tokenCounter++; },
        push() { /* virtual slots */ },
      },
    };
    (g as any).instanceMatrix = { needsUpdate: false };
    (g as any).instanceColor = { needsUpdate: false, setUsage() { /* sink */ } };
    Object.defineProperty(g, "count", { get: () => (g.userData.slotMap as Map<string, any>).size });
    (g as any).material = { color: new THREE.Color(baseColor), transparent: false, opacity: 1, needsUpdate: false };
    const slotToKey = (slot: any): string | undefined =>
      (typeof slot === "number") ? tokenKey.get(slot) : slot;
    (g as any).setMatrixAt = (slot: any, matrix: any) => {
      const el = matrix.elements;
      if (isZeroScale(el)) {
        const key = slotToKey(slot);
        if (key === undefined) return;
        if (typeof slot === "number") tokenKey.delete(slot);
        const p = key.split(",");
        setVoxel(+p[0], +p[1], +p[2], 0);
        tintByKey.delete(key);
      } else {
        const vx = Math.round(el[12] / voxel + cxRound);
        const vy = Math.round(el[13] / voxel);
        const vz = Math.round(el[14] / voxel + czRound);
        if (typeof slot === "number") tokenKey.set(slot, vx + "," + vy + "," + vz);
        setVoxel(vx, vy, vz, typeId);
      }
    };
    // Arid/moisture per-block tint: bake into vertex colors on remesh. The
    // caller computes the multiplier from facade material.color (base layer
    // color), matching the instanced setColorAt semantics exactly.
    (g as any).setColorAt = (slot: any, color: any) => {
      const key = slotToKey(slot);
      if (key === undefined) return;
      const p = key.split(",");
      const lx = +p[0] - minX, ly = +p[1] - minY, lz = +p[2] - minZ;
      if (!inGrid(lx, ly, lz)) return;
      const ci = chunkOf(lx, ly, lz);
      const had = tintByKey.get(key) || 0;
      const white = Math.abs(color.r - 1) < 1e-3 && Math.abs(color.g - 1) < 1e-3 && Math.abs(color.b - 1) < 1e-3;
      if (white) {
        if (!had) return;
        tintByKey.delete(key);
        chunkTint[ci] = Math.max(0, chunkTint[ci] - 1);
      } else {
        const id = internTint(color.r, color.g, color.b);
        if (had === id) return;
        if (!had) chunkTint[ci]++;
        tintByKey.set(key, id);
      }
      markDirty(lx, ly, lz);
    };
    return g;
  };

  const facades = {
    dirt: makeFacade("dirt", T_DIRT, opts.colors.dirt),
    grass: makeFacade("grass", T_GRASS, opts.colors.grass),
    dryGrass: makeFacade("dryGrass", T_DRY, opts.colors.dryGrass),
  };
  for (const [a, t] of srcLayers) {
    const f = t === T_DIRT ? facades.dirt : t === T_GRASS ? facades.grass : facades.dryGrass;
    const sm = f.userData.slotMap as Map<string, any>;
    for (let i = 0; i < a.length; i += 3) {
      const k = a[i] + "," + a[i + 1] + "," + a[i + 2];
      sm.set(k, k);
    }
  }
  if (hiddenArr) {
    const hm = facades.dirt.userData.hiddenMap as Map<string, any>;
    for (let i = 0; i < hiddenArr.length; i += 3) {
      const k = hiddenArr[i] + "," + hiddenArr[i + 1] + "," + hiddenArr[i + 2];
      hm.set(k, k);
    }
  }

  // External occluder sync (wall edits). Never clobbers ground-owned cells.
  const setExternalOccluder = (vx: number, vy: number, vz: number, solid: boolean) => {
    const lx = vx - minX, ly = vy - minY, lz = vz - minZ;
    if (!inGrid(lx, ly, lz)) return;
    const cur = grid[lidx(lx, ly, lz)];
    if (cur >= 1 && cur <= 3) return;      // ground layers own this cell
    setVoxel(vx, vy, vz, solid ? T_OCC : 0);
  };

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
    return {
      chunks: chunkMeshes.size,
      tris,
      voxels: voxelCount,
      hidden: (facades.dirt.userData.hiddenMap as Map<string, any>).size,
      dirtyPending: dirty.size,
    };
  }

  const exportChunks = () => new Map(compiledChunks);

  return { renderGroup, facades, flushDirty, setExternalOccluder, stats, exportChunks };
}
