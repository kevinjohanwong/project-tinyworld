import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const THREE_URL = "https://esm.sh/three@0.165.0";
const GLTF_URL = "https://esm.sh/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";
const ORBIT_URL = "https://esm.sh/three@0.165.0/examples/jsm/controls/OrbitControls.js";
const FP_URL = "https://esm.sh/three@0.165.0/examples/jsm/controls/PointerLockControls.js";

const NYC = { lat: 40.7128, lon: -74.006, timezone: "America/New_York" };
const MAX_TRIANGLES = 220_000;
const TARGET_DIVS = 345;
const MAX_TREES = 160;
const MAX_WATER = 10;
const TERRAIN_DEPTH = 5;
const BLOCK_SCALE = 1;

const PAL = {
  bg: 0x07070f,
  grass: 0x4f8f3a,
  dryGrass: 0x9aa04b,
  dirt: 0x5c4327,
  wall: 0x9a8c7c,
  ceiling: 0xd8ccbc,
  water: 0x3aa6e0,
  trunk: 0x3a2510,
  leaf: 0x2d6b1f,
  snow: 0xeef5ff,
  wet: 0x6a7079,
  fruit: 0xd24a4a,
  seed: 0xc9b27a,
  sapling: 0x5fb84a,
};

// ─── Mass & density ladder (docs/mass-and-density.md §9) ────────────────────
// Tier 0 bloom 0.25 · Tier 1 loam 1 · Tier 2 stone 4 · Tier 3 metal 16 ·
// Tier 4 densium 64 · Tier 5 core 256. Existing scan layers map onto tiers.
const DENSITY: Record<string, number> = {
  leaves: 0.25, fruit: 0.25, seed: 0.25, sapling: 0.25, grass: 0.25, dryGrass: 0.25,
  dirt: 1, snow: 1, wet: 1, water: 1, trunks: 1,
  wall: 4, ceiling: 4, block: 4, ground: 1, stone: 4,
  metal: 16, densium: 64, core: 256,
};
const densityOf = (layer: string) => DENSITY[layer] ?? 1;

// Void phase follows real local time; ?void=aggressive|active|off overrides for testing.
function voidPhaseNow(): "passive" | "active" | "aggressive" {
  if (typeof window !== "undefined") {
    const ov = new URLSearchParams(window.location.search).get("void");
    if (ov === "aggressive" || ov === "1") return "aggressive";
    if (ov === "active") return "active";
    if (ov === "off") return "passive";
  }
  const h = new Date().getHours();
  if (h >= 23 || h < 6) return "aggressive";
  if (h >= 20) return "active";
  return "passive";
}

const MOVE_MS: Record<string, number> = {
  leaves: 120,
  fruit: 80,
  seed: 100,
  sapling: 220,
  snow: 200,
  grass: 280,
  dryGrass: 280,
  wet: 360,
  dirt: 550,
  trunks: 1300,
  wall: 3500,
  ceiling: 3500,
  water: Number.POSITIVE_INFINITY,
};

type V3 = [number, number, number];

type CarryState = {
  mesh: any;
  instanceId: number;
  layer: string;
  hardMs: number;
  sourceMatrix: any;
  sourceX: number;
  sourceY: number;
  sourceZ: number;
  sourceSlot: number;
};

type Weather = {
  ok: boolean;
  season: string;
  localTime: string;
  current: { temperature: number | null; precipitation: number | null; snowfall: number | null; weathercode: number | null; label: string };
  modifiers: { snowLayers: number; rain: boolean; stormBonus: number; effectiveRate: number; dryGrassPct: number; iceNearWater: boolean; isRaining: boolean };
};

const WORKER_CODE = String.raw`
self.onmessage = async (event) => {
  const { buffer, weather } = event.data;
  try {
    const THREE = await import('${THREE_URL}');
    const { GLTFLoader } = await import('${GLTF_URL}');

    const MAX_TRIANGLES = ${MAX_TRIANGLES};
    const TARGET_DIVS = ${TARGET_DIVS};
    const MAX_TREES = ${MAX_TREES};
    const MAX_WATER = ${MAX_WATER};
    const TERRAIN_DEPTH = ${TERRAIN_DEPTH};

    const hash2 = (x, z) => (Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0;
    const getSeason = (month) => {
      if (month === 12 || month <= 2) return 'winter';
      if (month <= 5) return 'spring';
      if (month <= 8) return 'summer';
      return 'fall';
    };
    const season = (weather && weather.season) || getSeason(new Date().getMonth() + 1);
    const rain = !!(weather && weather.modifiers && (weather.modifiers.isRaining || weather.modifiers.rain));
    const snowLayers = (weather && weather.modifiers && weather.modifiers.snowLayers) || (season === 'winter' ? 1 : 0);
    const dryGrassPct = (weather && weather.modifiers && weather.modifiers.dryGrassPct) || (season === 'summer' ? 20 : 0);

    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, '', resolve, reject);
    });
    gltf.scene.updateMatrixWorld(true);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const triangles = [];
    const verts = [];

    gltf.scene.traverse((node) => {
      if (!node.isMesh || triangles.length >= MAX_TRIANGLES) return;
      const geom = node.geometry.clone();
      geom.applyMatrix4(node.matrixWorld);
      const pos = geom.getAttribute('position');
      const idx = geom.getIndex();
      const triCount = idx ? idx.count / 3 : Math.floor(pos.count / 3);
      for (let i = 0; i < triCount && triangles.length < MAX_TRIANGLES; i++) {
        const ai = idx ? idx.getX(i * 3) : i * 3;
        const bi = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
        const ci = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
        const a = [pos.getX(ai), pos.getY(ai), pos.getZ(ai)];
        const b = [pos.getX(bi), pos.getY(bi), pos.getZ(bi)];
        const c = [pos.getX(ci), pos.getY(ci), pos.getZ(ci)];
        triangles.push([a, b, c]);
        for (const p of [a, b, c]) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
          minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
        }
      }
      geom.dispose();
    });

    const angleHist = new Float32Array(90);
    for (const tri of triangles) {
      const a = tri[0], b = tri[1], c = tri[2];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const horiz = Math.hypot(nx, nz) / len;
      if (horiz > 0.85) {
        let deg = Math.atan2(nz, nx) * 180 / Math.PI;
        deg = ((deg % 90) + 90) % 90;
        const area = len / 2;
        angleHist[Math.round(deg) % 90] += area;
      }
    }
    let bestDeg = 0, bestScore = -1;
    for (let d = 0; d < 90; d++) {
      let s = 0;
      for (let o = -2; o <= 2; o++) s += angleHist[(d + o + 90) % 90];
      if (s > bestScore) { bestScore = s; bestDeg = d; }
    }
    const rot = -bestDeg * Math.PI / 180;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    if (bestDeg > 1 && bestDeg < 89) {
      for (const tri of triangles) {
        for (const p of tri) {
          const x = p[0], z = p[2];
          p[0] = x * cosR - z * sinR;
          p[2] = x * sinR + z * cosR;
        }
      }
      minX = Infinity; maxX = -Infinity; minZ = Infinity; maxZ = -Infinity;
      for (const tri of triangles) {
        for (const p of tri) {
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[2] < minZ) minZ = p[2];
          if (p[2] > maxZ) maxZ = p[2];
        }
      }
    }

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const voxel = Math.max(span / TARGET_DIVS, 0.025);
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const floorMap = new Map();
    const wall = [];
    const ceiling = [];

    for (const tri of triangles) {
      const a = tri[0], b = tri[1], c = tri[2];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx2 = c[0] - a[0], vy2 = c[1] - a[1], vz2 = c[2] - a[2];
      let nx = uy * vz2 - uz * vy2;
      let ny = uz * vx2 - ux * vz2;
      let nz = ux * vy2 - uy * vx2;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      ny = ny / nlen;
      const avgY = (a[1] + b[1] + c[1]) / 3;
      const rel = (avgY - minY) / Math.max(1, maxY - minY);
      const upFacing = Math.abs(ny) >= 0.55 && rel < 0.6;
      const downFacing = Math.abs(ny) >= 0.55 && rel >= 0.6;
      const e1 = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const e2 = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const steps = Math.min(120, Math.max(4, Math.ceil(Math.max(e1, e2) / (voxel * 0.5))));
      for (let su = 0; su <= steps; su++) {
        for (let sv = 0; sv <= steps - su; sv++) {
          const u = su / steps;
          const v = sv / steps;
          const w = 1 - u - v;
          const x = a[0] * u + b[0] * v + c[0] * w;
          const y = a[1] * u + b[1] * v + c[1] * w;
          const z = a[2] * u + b[2] * v + c[2] * w;
          const vx = Math.round(x / voxel);
          const vy = Math.round(y / voxel);
          const vz = Math.round(z / voxel);
          if (upFacing) {
            const key = vx + ',' + vz;
            const prev = floorMap.get(key);
            if (prev === undefined || vy < prev) floorMap.set(key, vy);
          } else if (downFacing) {
            ceiling.push([vx, vy, vz]);
          } else {
            wall.push([vx, vy, vz]);
          }
        }
      }
    }

    const filledFloor = new Map(floorMap);
    for (let pass = 0; pass < 2; pass++) {
      const additions = [];
      for (const [key, y] of filledFloor.entries()) {
        const [x, z] = key.split(',').map(Number);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = (x + dx) + ',' + (z + dz);
          if (filledFloor.has(nk)) continue;
          let sum = 0, count = 0;
          for (const [adx, adz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ny = filledFloor.get((x + dx + adx) + ',' + (z + dz + adz));
            if (ny !== undefined) { sum += ny; count += 1; }
          }
          additions.push([nk, count ? Math.round(sum / count) : y]);
        }
      }
      for (const [k, y] of additions) filledFloor.set(k, y);
    }

    // ── Rectification pass 1: floor median smoothing ──────────────────────────
    // Real floors are flat; scan noise creates bumps. Two passes of a 3x3
    // median filter flattens noise while preserving genuine height steps.
    for (let pass = 0; pass < 2; pass++) {
      const smoothed = new Map();
      for (const [key, y] of filledFloor.entries()) {
        const [x, z] = key.split(',').map(Number);
        const samples = [y];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dz) continue;
            const ny = filledFloor.get((x + dx) + ',' + (z + dz));
            if (ny !== undefined) samples.push(ny);
          }
        }
        samples.sort((a, b) => a - b);
        smoothed.set(key, samples[Math.floor(samples.length / 2)]);
      }
      for (const [k, y] of smoothed) filledFloor.set(k, y);
    }

    // Snap to dominant floor level: if >=60% of cells share one height,
    // pull cells within 2 voxels of it onto the plane (kills residual ripple).
    {
      const histogram = new Map();
      for (const y of filledFloor.values()) histogram.set(y, (histogram.get(y) || 0) + 1);
      let domY = 0, domCount = 0;
      for (const [y, count] of histogram) if (count > domCount) { domY = y; domCount = count; }
      if (domCount >= filledFloor.size * 0.5) {
        for (const [k, y] of filledFloor) {
          if (Math.abs(y - domY) <= 2) filledFloor.set(k, domY);
        }
      }
    }

    // ── Rectification pass 2: wall solidification ─────────────────────────────
    // Group wall voxels into (x,z) columns. Columns with enough samples become
    // solid vertical walls from their base to their top; sparse columns are
    // scan noise and are dropped entirely.
    const wallCols = new Map();
    for (const p of wall) {
      const k = p[0] + ',' + p[2];
      let col = wallCols.get(k);
      if (!col) { col = { minY: p[1], maxY: p[1], count: 0 }; wallCols.set(k, col); }
      if (p[1] < col.minY) col.minY = p[1];
      if (p[1] > col.maxY) col.maxY = p[1];
      col.count += 1;
    }
    const solidWall = [];
    for (const [k, col] of wallCols) {
      if (col.count < 3) continue;
      const [x, z] = k.split(',').map(Number);
      let base = col.minY;
      const floorY = filledFloor.get(k);
      if (floorY !== undefined && floorY < base) base = floorY + 1;
      for (let y = base; y <= col.maxY; y++) solidWall.push([x, y, z]);
    }
    wall.length = 0;
    for (const p of solidWall) wall.push(p);

    // ── Rectification pass 3: ceiling flattening ──────────────────────────────
    // Collapse ceiling noise to one clean voxel per column at the median height.
    const ceilCols = new Map();
    for (const p of ceiling) {
      const k = p[0] + ',' + p[2];
      let arr = ceilCols.get(k);
      if (!arr) { arr = []; ceilCols.set(k, arr); }
      arr.push(p[1]);
    }
    const flatCeil = [];
    {
      const histogram = new Map();
      for (const ys of ceilCols.values()) {
        ys.sort((a, b) => a - b);
        const med = ys[Math.floor(ys.length / 2)];
        histogram.set(med, (histogram.get(med) || 0) + 1);
      }
      let domY = 0, domCount = 0;
      for (const [y, count] of histogram) if (count > domCount) { domY = y; domCount = count; }
      const snapCeil = domCount >= ceilCols.size * 0.5;
      for (const [k, ys] of ceilCols) {
        const [x, z] = k.split(',').map(Number);
        const med = ys[Math.floor(ys.length / 2)];
        const y = snapCeil && Math.abs(med - domY) <= 2 ? domY : med;
        flatCeil.push([x, y, z]);
      }
    }
    ceiling.length = 0;
    for (const p of flatCeil) ceiling.push(p);

    const grass = [];
    const dryGrass = [];
    const dirt = [];
    const snow = [];
    const water = [];
    const trunks = [];
    const leaves = [];
    const wetOverlay = [];

    const neighbors4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const openSides = new Map();
    for (const key of filledFloor.keys()) {
      const [x, z] = key.split(",").map(Number);
      let count = 0;
      for (const [dx, dz] of neighbors4) {
        if (!filledFloor.has((x + dx) + "," + (z + dz))) count += 1;
      }
      openSides.set(key, count);
    }

    let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
    for (const key of filledFloor.keys()) {
      const [x, z] = key.split(',').map(Number);
      if (x < fx0) fx0 = x;
      if (x > fx1) fx1 = x;
      if (z < fz0) fz0 = z;
      if (z > fz1) fz1 = z;
    }
    const floorSpan = Math.max(fx1 - fx0, fz1 - fz0) || 1;
    const minTreeSpacing = Math.max(3, Math.floor(floorSpan / 26));
    const treeCandidates = [];
    for (const [key, y] of filledFloor.entries()) {
      const [x, z] = key.split(',').map(Number);
      const h = hash2(x, z);
      if ((h % 1000) < Math.round(((season === 'spring' ? 0.22 : season === 'summer' ? 0.16 : 0.1) * 1000))) {
        treeCandidates.push({ x, z, y, h });
      }
    }
    treeCandidates.sort((a, b) => (a.h % 9973) - (b.h % 9973));
    const treeOccupied = new Set();
    const chosenTrees = [];
    for (const cand of treeCandidates) {
      if (chosenTrees.length >= MAX_TREES) break;
      const gx = Math.floor(cand.x / minTreeSpacing);
      const gz = Math.floor(cand.z / minTreeSpacing);
      const cellKey = gx + ',' + gz;
      if (treeOccupied.has(cellKey)) continue;
      treeOccupied.add(cellKey);
      chosenTrees.push(cand);
    }
    for (const t of chosenTrees) {
      const height = 3 + (t.h % 4);
      for (let i = 1; i <= height; i++) trunks.push([t.x, t.y + i, t.z]);
      const canopy = 2 + (t.h % 2);
      for (let dx = -canopy; dx <= canopy; dx++) {
        for (let dz = -canopy; dz <= canopy; dz++) {
          if (dx * dx + dz * dz <= canopy * canopy + 1) leaves.push([t.x + dx, t.y + height, t.z + dz]);
        }
      }
    }

    const distToEdge = new Map();
    {
      const queue = [];
      for (const key of filledFloor.keys()) {
        const parts = key.split(',');
        const x = Number(parts[0]), z = Number(parts[1]);
        let isEdge = false;
        for (const d of neighbors4) {
          if (!filledFloor.has((x + d[0]) + ',' + (z + d[1]))) { isEdge = true; break; }
        }
        if (isEdge) { distToEdge.set(key, 0); queue.push([x, z]); }
      }
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        const dHere = distToEdge.get(cur[0] + ',' + cur[1]);
        for (const d of neighbors4) {
          const nk = (cur[0] + d[0]) + ',' + (cur[1] + d[1]);
          if (filledFloor.has(nk) && !distToEdge.has(nk)) {
            distToEdge.set(nk, dHere + 1);
            queue.push([cur[0] + d[0], cur[1] + d[1]]);
          }
        }
      }
    }
    let maxEdgeDist = 1;
    for (const v of distToEdge.values()) if (v > maxEdgeDist) maxEdgeDist = v;

    // Underside: inverted-cone mass — deepest at the CENTER, tapering to thin rim,
    // plus deep hanging "taproots" near the core (Laputa style)
    for (const [key, floorY] of filledFloor) {
      const parts = key.split(',');
      const x = Number(parts[0]), z = Number(parts[1]);
      const dist = distToEdge.get(key) || 0;
      const t = dist / maxEdgeDist;
      const h01 = (hash2(x * 3 + 7, z * 5 + 11) % 1000) / 1000;
      let depth = 2 + Math.round(Math.pow(t, 1.35) * 26) + Math.floor(h01 * 4);
      if (t > 0.55 && ((hash2(x * 13 + 1, z * 17 + 3) % 1000) / 1000) > 0.86) {
        depth += 8 + Math.floor(((hash2(x * 23 + 5, z * 29 + 9) % 1000) / 1000) * 16);
      }
      for (let dy = 1; dy <= depth; dy++) {
        dirt.push([x, floorY - dy, z]);
      }
    }

    // Organic water pooling: seed a few basins and flood out irregularly.
    // Pools are CARVED INTO the floor (sunken), not stacked on top.
    const poolSeeds = [];
    for (const [key, y] of filledFloor.entries()) {
      const [x, z] = key.split(',').map(Number);
      const h = hash2(x, z);
      const exposed = openSides.get(key) ?? 4;
      const basinChance = rain ? 0.12 : 0.07;
      if (exposed <= 2 && (h % 1000) / 1000 < basinChance) {
        poolSeeds.push({ x, y, z, h, r: 5 + (h % 5) });
      }
    }
    poolSeeds.sort((a, b) => (a.h % 7919) - (b.h % 7919));
    const poolTaken = new Set();
    let poolCount = 0;
    for (const seed of poolSeeds) {
      if (poolCount >= MAX_WATER) break;
      const queue = [[seed.x, seed.z, 0]];
      const seen = new Set();
      let cells = 0;
      while (queue.length) {
        const [x, z, dist] = queue.shift();
        const k = x + ',' + z;
        if (seen.has(k) || dist > seed.r) continue;
        seen.add(k);
        if (!filledFloor.has(k)) continue;
        if (poolTaken.has(k)) continue;
        const localH = hash2(x, z);
        const expose = openSides.get(k) ?? 4;
        const keepChance = Math.max(0.45, 1.05 - dist * 0.08 - expose * 0.05 + (localH % 10) * 0.01);
        if (dist > 0 && (localH % 1000) / 1000 > keepChance) continue;
        poolTaken.add(k);
        cells += 1;
        const y = filledFloor.get(k);
        water.push([x, y, z]);
        water.push([x, y - 1, z]);
        if (dist <= 2) water.push([x, y - 2, z]);
        for (const [dx, dz] of neighbors4) queue.push([x + dx, z + dz, dist + 1]);
      }
      if (cells >= 6) poolCount += 1;
      else { for (const k of seen) poolTaken.delete(k); }
    }

    for (const [key, y] of filledFloor.entries()) {
      const [x, z] = key.split(',').map(Number);
      if (poolTaken.has(x + ',' + z)) continue;
      const h = hash2(x, z);
      const isSummerDry = season === 'summer' && (h % 100) < dryGrassPct;
      const isWet = rain && (h % 100) < 35;
      if (season === 'winter') {
        for (let i = 0; i < snowLayers; i++) snow.push([x, y + 1 + i, z]);
      } else if (isWet) {
        wetOverlay.push([x, y + 1, z]);
      }
      (isSummerDry ? dryGrass : grass).push([x, y, z]);
    }

    const rawLayers = { water, dirt, grass, dryGrass, snow, wet: wetOverlay, trunks, leaves, wall, ceiling };
    const occupied = new Set();
    const seenPerLayer = {};
    for (const [name, layer] of Object.entries(rawLayers)) {
      const seen = new Set();
      const deduped = [];
      for (let i = 0; i < layer.length; i++) {
        const p = layer[i];
        const k = p[0] + ',' + p[1] + ',' + p[2];
        if (seen.has(k) || occupied.has(k)) continue;
        seen.add(k);
        occupied.add(k);
        deduped.push(p);
      }
      rawLayers[name] = deduped;
    }

    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const visible = { dirt: [], grass: [], dryGrass: [], snow: [], wet: [], trunks: [], leaves: [], water: [], wall: [], ceiling: [] };
    const hidden = { dirt: [] };
    let visibleCount = 0;
    for (const [name, layer] of Object.entries(rawLayers)) {
      for (let i = 0; i < layer.length; i++) {
        const p = layer[i];
        let exposed = false;
        for (let j = 0; j < dirs.length; j++) {
          const d = dirs[j];
          if (!occupied.has((p[0] + d[0]) + ',' + (p[1] + d[1]) + ',' + (p[2] + d[2]))) { exposed = true; break; }
        }
        if (exposed) {
          visible[name].push(p[0], p[1], p[2]);
          visibleCount += 1;
        } else if (hidden[name]) {
          hidden[name].push(p[0], p[1], p[2]);
        }
      }
    }

    const transfers = [];
    const buffers = {};
    for (const [name, arr] of Object.entries(visible)) {
      const typed = new Int32Array(arr);
      buffers[name] = typed.buffer;
      transfers.push(typed.buffer);
    }
    for (const [name, arr] of Object.entries(hidden)) {
      const typed = new Int32Array(arr);
      buffers['hidden_' + name] = typed.buffer;
      transfers.push(typed.buffer);
    }

    // Ground-height lookup for walking: top floor Y at each (x,z) column.
    const groundArr = new Int32Array(filledFloor.size * 3);
    {
      let i = 0;
      for (const [key, y] of filledFloor.entries()) {
        const [x, z] = key.split(',').map(Number);
        groundArr[i++] = x;
        groundArr[i++] = z;
        groundArr[i++] = y;
      }
    }
    buffers.ground = groundArr.buffer;
    transfers.push(groundArr.buffer);

    self.postMessage({
      ok: true,
      voxel,
      span,
      centerX,
      centerZ,
      visibleCount,
      weatherSeason: season,
      labels: {
        grass: season,
      },
      layers: buffers,
    }, transfers);
  } catch (error) {
    self.postMessage({ ok: false, error: String(error && error.message ? error.message : error) });
  }
};
`;

function getMonthSeason(month: number) {
  if (month === 12 || month <= 2) return "winter";
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  return "fall";
}

function makeWorkerUrl() {
  return URL.createObjectURL(new Blob([WORKER_CODE], { type: "text/javascript" }));
}

function runWorker(workerUrl: string, buffer: ArrayBuffer, weather: Weather | null) {
  return new Promise<any>((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    worker.onmessage = (e) => {
      const data = e.data;
      worker.terminate();
      if (data?.ok) resolve(data);
      else reject(new Error(data?.error || "worker failed"));
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err.error || err.message || new Error("worker error"));
    };
    worker.postMessage({ buffer, weather }, [buffer]);
  });
}

type WorldRecord = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  base_blocks?: number;
  integrity?: number;
  created_at?: number;
  last_visited?: number;
  last_scanned?: number;
  hasSavedBlocks?: boolean;
  savedBlockCount?: number;
  savedResolution?: number;
  distanceMeters?: number | null;
};

type SavedLayerPayload = {
  layers?: Record<string, unknown>;
  meta?: {
    voxel?: number;
    span?: number;
    centerX?: number;
    centerZ?: number;
    sourceName?: string;
    capturedAt?: number;
    savedAt?: number;
    anchorLat?: number;
    anchorLon?: number;
    weatherSeason?: string;
  };
};

function normalizeLayerInput(layer: unknown) {
  if (layer instanceof Int32Array) return layer;
  if (ArrayBuffer.isView(layer)) return new Int32Array(layer.buffer.slice(layer.byteOffset, layer.byteOffset + layer.byteLength));
  if (layer instanceof ArrayBuffer) return new Int32Array(layer);
  if (Array.isArray(layer)) return new Int32Array(layer.map((value) => Number(value) || 0));
  if (layer && typeof layer === "object") return new Int32Array(Object.values(layer as Record<string, unknown>).map((value) => Number(value) || 0));
  return new Int32Array(0);
}

function encodeBase64Bytes(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64Bytes(text: string) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function serializeLayer(layer: Int32Array) {
  return encodeBase64Bytes(new Uint8Array(layer.buffer.slice(layer.byteOffset, layer.byteOffset + layer.byteLength)));
}

function deserializeLayer(value: unknown) {
  if (typeof value === "string") {
    const bytes = decodeBase64Bytes(value);
    const length = Math.floor(bytes.byteLength / 4);
    return new Int32Array(bytes.buffer, 0, length);
  }
  return normalizeLayerInput(value);
}

function layersFromPayload(payload: SavedLayerPayload | null | undefined) {
  const layers = payload?.layers ?? {};
  return Object.fromEntries(Object.entries(layers).map(([name, layer]) => [name, deserializeLayer(layer)]));
}

function estimateCatchUp(world: WorldRecord | null | undefined, state: any, blockCount: number, savedAt?: number) {
  const baseline = world?.last_visited ?? savedAt ?? world?.last_scanned ?? Date.now();
  const elapsedMs = Math.max(0, Date.now() - baseline);
  const elapsedHours = elapsedMs / 3_600_000;
  const terrain = state?.terrain ?? {};
  const weather = state?.weather ?? {};
  const removePressure = typeof terrain.removePressure === "number" ? terrain.removePressure : 0.25;
  const growthPressure = typeof terrain.growthPressure === "number" ? terrain.growthPressure : 0.25;
  const cyclePressure = typeof terrain.cyclePressure === "number" ? terrain.cyclePressure : 0.25;
  const weatherBonus = weather?.modifiers?.isRaining ? 1.15 : 1;
  const voidLoss = Math.max(0, Math.round(blockCount * elapsedHours * removePressure * 0.0025 * weatherBonus));
  const growth = Math.max(0, Math.round(blockCount * elapsedHours * growthPressure * 0.0017));
  const cycles = Math.max(0, Math.round(elapsedHours * cyclePressure * 4));
  const net = growth - voidLoss;
  return { elapsedHours, voidLoss, growth, cycles, net };
}

export default function TinyWorld() {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const orbitRef = useRef<any>(null);
  const fpRef = useRef<any>(null);
  const rafRef = useRef<number>(0);
  const keysRef = useRef<Record<string, boolean>>({});
  const enterWalkRef = useRef<() => void>(() => {});
  const workerUrlRef = useRef<string>("");
  const groundRef = useRef<{ map: Map<string, number>; voxel: number; cx: number; cz: number } | null>(null);
  const velocityYRef = useRef(0);
  const carryRef = useRef<CarryState | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const meshesRef = useRef<any[]>([]);
  const worldDataRef = useRef<{ layers: Record<string, Int32Array>; meta: Record<string, unknown>; blockCount: number; resolution: number } | null>(null);
  const savedWorldRef = useRef<{ id: string; name: string } | null>(null);

  const [phase, setPhase] = useState<"idle" | "loading" | "building" | "ready">("idle");
  const [blocks, setBlocks] = useState(0);
  const [walking, setWalking] = useState(false);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [xray, setXray] = useState(true);
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [loadNote, setLoadNote] = useState("");
  const [sessionNote, setSessionNote] = useState("");
  const [anchor, setAnchor] = useState({ lat: NYC.lat, lon: NYC.lon });
  const [nodeInfo, setNodeInfo] = useState<{ source: string; city: string | null; hiddenCount: number } | null>(null);
  const [moves, setMoves] = useState(0);
  const [carryLayer, setCarryLayer] = useState<string | null>(null);
  const [satiation, setSatiation] = useState(0);
  const satiationRef = useRef(0);
  const [catchUpInfo, setCatchUpInfo] = useState<any>(null);
  const riftMarkersRef = useRef<any[]>([]);

  // ─── Conservation ledger ──────────────────────────────────────────────
  // Single law: world + stockpile + built + void === baseline, always.
  // Blocks are never created or destroyed — they move between pools. VOID
  // doubles as the world's reservoir: organic growth draws from it, decay
  // returns to it. Every move is queued as a block_event and flushed in
  // batches to /api/tinyworld-worlds {action:"logEvents"}.
  type LedgerPool = "world" | "stockpile" | "built" | "void";
  const ledgerRef = useRef({ world: 0, stockpile: 0, built: 0, void: 0, baseline: 0 });
  const stockpileByLayerRef = useRef<Record<string, number>>({});
  const pendingEventsRef = useRef<Map<string, number>>(new Map());
  const lastLedgerUiRef = useRef(0);
  const [ledger, setLedger] = useState({ world: 0, stockpile: 0, built: 0, void: 0, baseline: 0 });
  const [voidUi, setVoidUi] = useState({ phase: "passive", creatures: 0, eaten: 0 });
  const [scanUi, setScanUi] = useState({ charge: 1, scans: 0 });
  const [shipUi, setShipUi] = useState({ count: 0, flying: 0 });
  const [bombUi, setBombUi] = useState({ slugs: 0, bombs: 0, detonations: 0 });

  const queueBlockEvent = useCallback((kind: string, count: number, source: string) => {
    const key = kind + "|" + source;
    pendingEventsRef.current.set(key, (pendingEventsRef.current.get(key) || 0) + count);
  }, []);

  const ledgerMove = useCallback((from: LedgerPool, to: LedgerPool, n: number, source: string, layer?: string) => {
    if (n <= 0 || from === to) return;
    const L = ledgerRef.current as any;
    L[from] -= n;
    L[to] += n;
    if (layer) {
      const sp = stockpileByLayerRef.current;
      if (to === "stockpile") sp[layer] = (sp[layer] || 0) + n;
      else if (from === "stockpile") sp[layer] = Math.max(0, (sp[layer] || 0) - n);
    }
    const kind = from === "world" && to === "void" ? "remove" : from === "void" && to === "world" ? "grow" : "cycle";
    queueBlockEvent(kind, n, source);
    const nowMs = Date.now();
    if (nowMs - lastLedgerUiRef.current > 300) {
      lastLedgerUiRef.current = nowMs;
      setLedger({ ...ledgerRef.current });
    }
  }, [queueBlockEvent]);

  const flushBlockEvents = useCallback((useBeacon = false) => {
    const worldId = savedWorldRef.current?.id;
    const pend = pendingEventsRef.current;
    if (!worldId || pend.size === 0) return;
    const events = Array.from(pend.entries()).map(([key, count]) => {
      const [kind, source] = key.split("|");
      return { kind, count, source };
    });
    pend.clear();
    const body = JSON.stringify({ action: "logEvents", worldId, events });
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/tinyworld-worlds", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/tinyworld-worlds", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      flushBlockEvents();
      setLedger({ ...ledgerRef.current });
    }, 15000);
    const onHide = () => flushBlockEvents(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", onHide);
    };
  }, [flushBlockEvents]);

  const xrayRef = useRef(true);
  const fadeMeshesRef = useRef<{ ceiling?: any; wallUpper?: any }>({});

  if (!workerUrlRef.current) workerUrlRef.current = makeWorkerUrl();
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (!alive) return;
          setAnchor({ lat: position.coords.latitude, lon: position.coords.longitude });
        },
        () => {
          if (!alive) return;
          setAnchor({ lat: NYC.lat, lon: NYC.lon });
        },
        { enableHighAccuracy: false, timeout: 3500, maximumAge: 300000 },
      );
    }
    return () => {
      alive = false;
    };
  }, []);

  const fetchWorlds = useCallback(async () => {
    const res = await fetch(`/api/tinyworld-worlds`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.worlds)) {
      if (data.node) setNodeInfo({ source: data.node.source, city: data.node.city, hiddenCount: data.hiddenCount ?? 0 });
      setWorlds(data.worlds);
      setSelectedWorldId((current) => current || data.worlds.find((world: WorldRecord) => world.hasSavedBlocks)?.id || data.worlds[0]?.id || "");
      return data.worlds as WorldRecord[];
    }
    setWorlds([]);
    setSelectedWorldId("");
    return [] as WorldRecord[];
  }, []);

  useEffect(() => {
    fetchWorlds().catch(() => undefined);
  }, [fetchWorlds]);

  const fetchWeather = useCallback(async () => {
    const params = new URLSearchParams({ lat: String(NYC.lat), lon: String(NYC.lon), timezone: NYC.timezone });
    const res = await fetch(`/api/tinyworld-weather?${params.toString()}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (data?.ok) setWeather(data);
    return data?.ok ? data : null;
  }, []);

  const saveWorldBlocks = useCallback(async (worldId: string, layers: Record<string, Int32Array>, meta: Record<string, unknown>, blockCount: number, resolution: number) => {
    const serializableLayers = Object.fromEntries(Object.entries(layers).map(([name, layer]) => [name, serializeLayer(layer)]));
    const response = await fetch("/api/tinyworld-worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "saveBlocks", worldId, layers: serializableLayers, meta: { ...meta, savedAt: Date.now() }, blockCount, resolution }),
    });
    const data = await response.json();
    if (!data?.ok) throw new Error(data?.error || "Unable to save world blocks");
    return data;
  }, []);

  const createWorldRecord = useCallback(async (name: string) => {
    const response = await fetch("/api/tinyworld-worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name, lat: anchor.lat, lon: anchor.lon, baseBlocks: 0 }),
    });
    const data = await response.json();
    if (!data?.ok || !data?.world?.id) throw new Error(data?.error || "Unable to create world record");
    return data.world as WorldRecord;
  }, [anchor.lat, anchor.lon]);

  const persistWorldMeta = useCallback((worldId: string, name: string) => {
    savedWorldRef.current = { id: worldId, name };
    setSelectedWorldId(worldId);
  }, []);

  const loadSavedBlocks = useCallback(async (worldId: string) => {
    const response = await fetch(`/api/tinyworld-worlds?id=${encodeURIComponent(worldId)}&blocks=1`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`load failed (${response.status})`);
    const payload = await response.json();
    if (!payload?.layers) throw new Error("missing block payload");
    return payload as SavedLayerPayload & { layers: Record<string, unknown>; meta?: Record<string, unknown> };
  }, []);

  const snapshotLiveLayers = useCallback(() => {
    if (!worldDataRef.current) return;
    const buckets: Record<string, number[]> = {};
    for (const m of meshesRef.current) {
      const layer = m.userData?.layer as string | undefined;
      if (!layer) continue;
      const slotMap = m.userData.slotMap as Map<string, number> | undefined;
      if (slotMap && slotMap.size > 0) {
        if (!buckets[layer]) buckets[layer] = [];
        for (const k of slotMap.keys()) {
          const parts = k.split(",");
          buckets[layer].push(+parts[0], +parts[1], +parts[2]);
        }
      }
      const hiddenMap = m.userData.hiddenMap as Map<string, number> | undefined;
      if (hiddenMap && hiddenMap.size > 0) {
        const hk = `hidden_${layer}`;
        if (!buckets[hk]) buckets[hk] = [];
        for (const k of hiddenMap.keys()) {
          const parts = k.split(",");
          buckets[hk].push(+parts[0], +parts[1], +parts[2]);
        }
      }
    }
    const newLayers: Record<string, Int32Array> = {};
    let total = 0;
    for (const [k, v] of Object.entries(buckets)) {
      newLayers[k] = new Int32Array(v);
      if (!k.startsWith("hidden_")) total += Math.floor(v.length / 3);
    }
    worldDataRef.current.layers = newLayers;
    worldDataRef.current.blockCount = total;
  }, []);

  const saveCurrentWorld = useCallback(async (worldId: string, worldName: string) => {
    const data = worldDataRef.current;
    if (!data) throw new Error("nothing to save yet — scan or load a world first");
    snapshotLiveLayers();
    const playerState = { satiation: satiationRef.current };
    const ledgerState = {
      void: ledgerRef.current.void,
      built: ledgerRef.current.built,
      stockpile: ledgerRef.current.stockpile,
    };
    const meta = { ...data.meta, worldName, blockCount: data.blockCount, resolution: data.resolution, playerState, ledger: ledgerState };
    const saved = await saveWorldBlocks(worldId, data.layers, meta, data.blockCount, data.resolution);
    persistWorldMeta(worldId, worldName);
    flushBlockEvents();
    setLoadNote(`saved ${(saved.blockCount ?? data.blockCount).toLocaleString()} blocks (${Math.round((saved.bytes ?? 0) / 1024)} KB)`);
    return saved;
  }, [persistWorldMeta, saveWorldBlocks, snapshotLiveLayers, flushBlockEvents]);

  const saveAsCurrentWorld = useCallback(async () => {
    const fallbackName = `TinyWorld ${new Date().toLocaleDateString()}`;
    const suggested = savedWorldRef.current?.name || fallbackName;
    const name = (typeof window !== "undefined" ? window.prompt("Name for the new world:", suggested) : suggested)?.trim();
    if (!name) return;
    const target = await createWorldRecord(name);
    await saveCurrentWorld(target.id, name);
    await fetchWorlds();
    setSelectedWorldId(target.id);
  }, [createWorldRecord, fetchWorlds, saveCurrentWorld]);

  const loadWorldToScene = useCallback(async (worldId: string) => {
    const saved = await loadSavedBlocks(worldId);
    const layers = layersFromPayload(saved);
    const meta = (saved.meta || {}) as Record<string, any>;
    const data = {
      layers,
      meta,
      blockCount: typeof meta.blockCount === "number" ? meta.blockCount : Object.entries(layers).reduce((sum, [name, layer]) => (name.startsWith("hidden_") || name === "ground" ? sum : sum + Math.floor(layer.length / 3)), 0),
      resolution: typeof meta.resolution === "number" ? meta.resolution : 0,
    };
    worldDataRef.current = data;
    return data;
  }, [loadSavedBlocks]);

  const buildWorld = useCallback(async (source: File | { layers: Record<string, Int32Array>; meta: Record<string, unknown>; blockCount: number; resolution: number }) => {
    cancelAnimationFrame(rafRef.current);
    rendererRef.current?.dispose?.();
    rendererRef.current = null;
    if (mountRef.current) mountRef.current.innerHTML = "";
    setWalking(false);
    setMoves(0);
    meshesRef.current = [];
    riftMarkersRef.current.forEach(m => m.parent?.remove(m));
    riftMarkersRef.current = [];
    groundRef.current = null;
    velocityYRef.current = 0;
    setPhase("loading");

    const [THREE, orbitMod, fpMod, weatherData] = await Promise.all([
      import(THREE_URL),
      import(ORBIT_URL),
      import(FP_URL),
      fetchWeather(),
    ]);
    const gltfMod = await import(GLTF_URL);
    const { GLTFLoader } = gltfMod as any;
    const { OrbitControls } = orbitMod as any;
    const { PointerLockControls } = fpMod as any;

    let result: any;
    if (source instanceof File) {
      const ab = await source.arrayBuffer();
      result = await runWorker(workerUrlRef.current, ab, weatherData);
    } else {
      const m = (source.meta ?? {}) as Record<string, any>;
      result = {
        voxel: Number(m.voxel) || 0.05,
        span: Number(m.span) || 10,
        centerX: Number(m.centerX) || 0,
        centerZ: Number(m.centerZ) || 0,
        visibleCount: source.blockCount,
        weatherSeason: m.weatherSeason,
        layers: source.layers,
      };
    }

    setPhase("building");
    await new Promise((r) => setTimeout(r, 25));

    const voxel = result.voxel as number;
    const span = result.span as number;
    const centerX = result.centerX as number;
    const centerZ = result.centerZ as number;
    const layers = result.layers as Record<string, ArrayBuffer | Int32Array>;
    const totalBlocks = result.visibleCount as number;
    const season = (weatherData?.season as string) || (result.weatherSeason as string) || getMonthSeason(new Date().getMonth() + 1);
    worldDataRef.current = source instanceof File
      ? {
          layers: Object.fromEntries(Object.entries(layers).map(([name, value]) => [name, normalizeLayerInput(value)])),
          meta: {
            voxel,
            span,
            centerX,
            centerZ,
            sourceName: source.name,
            capturedAt: Date.now(),
            anchorLat: anchor.lat,
            anchorLon: anchor.lon,
            weatherSeason: season,
          },
          blockCount: totalBlocks,
          resolution: voxel,
        }
      : source;
    const restoredPlayerState = ((worldDataRef.current?.meta as any)?.playerState) || {};
    satiationRef.current = typeof restoredPlayerState.satiation === "number" ? restoredPlayerState.satiation : 0;
    setSatiation(satiationRef.current);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAL.bg);
    scene.fog = new THREE.FogExp2(PAL.bg, 0.012);

    const W = innerWidth;
    const H = innerHeight;
    const camera = new THREE.PerspectiveCamera(65, W / H, 0.02, 500);
    camera.position.set(span * 0.9, span * 0.55, span * 0.9);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = false;
    rendererRef.current = renderer;
    mountRef.current!.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x9aa8bc, 0.9));
    const hemi = new THREE.HemisphereLight(0xbdd4ff, 0x8a6f50, 2.4);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(season === "winter" ? 0xc8d8ff : 0xfff0dd, 3.4);
    sun.position.set(10, 18, 8);
    sun.castShadow = true;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x23304f, 0.8);
    fill.position.set(-8, 4, -10);
    scene.add(fill);
    const under = new THREE.DirectionalLight(0x9a7a55, 1.6);
    under.position.set(4, -14, 6);
    scene.add(under);

    const box = new THREE.BoxGeometry(voxel * BLOCK_SCALE, voxel * BLOCK_SCALE, voxel * BLOCK_SCALE);
    const dummy = new THREE.Object3D();
    let currentBlocks = 0;
    const cxRound = Math.round(centerX / voxel);
    const czRound = Math.round(centerZ / voxel);

    const hlGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(voxel * 1.02, voxel * 1.02, voxel * 1.02));
    const hlMat = new THREE.LineBasicMaterial({ color: 0xffeb6a, transparent: true, opacity: 0.8 });
    const highlight = new THREE.LineSegments(hlGeo, hlMat);
    highlight.visible = false;
    scene.add(highlight);

    const ghostMat = new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
    const ghostMesh = new THREE.Mesh(box, ghostMat);
    ghostMesh.visible = false;
    scene.add(ghostMesh);

    const REACH = voxel * 15;
    const toolGroup = new THREE.Group();
    toolGroup.position.set(0.6 * REACH, -voxel * 3.5, -REACH * 0.8);
    const toolCore = new THREE.Mesh(
      new THREE.OctahedronGeometry(voxel * 0.3),
      new THREE.MeshBasicMaterial({ color: 0xe0d6ff })
    );
    const toolEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(voxel * 0.45)),
      new THREE.LineBasicMaterial({ color: 0x8a6bff, transparent: true, opacity: 0.8 })
    );
    toolGroup.add(toolCore);
    toolGroup.add(toolEdges);
    camera.add(toolGroup);

    const tetherGeo = new THREE.BufferGeometry();
    tetherGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const tetherMat = new THREE.LineBasicMaterial({ color: 0x8a6bff, transparent: true, opacity: 0, depthTest: false, linewidth: 2 });
    const tetherLine = new THREE.Line(tetherGeo, tetherMat);
    tetherLine.visible = false;
    scene.add(tetherLine);

    const tetherInnerGeo = new THREE.BufferGeometry();
    tetherInnerGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const tetherInnerMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false });
    const tetherInnerLine = new THREE.Line(tetherInnerGeo, tetherInnerMat);
    tetherInnerLine.visible = false;
    scene.add(tetherInnerLine);

    let ring = document.getElementById("charge-ring");
    if (!ring) {
      ring = document.createElement("div");
      ring.id = "charge-ring";
      Object.assign(ring.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        width: "32px",
        height: "32px",
        marginTop: "-16px",
        marginLeft: "-16px",
        borderRadius: "50%",
        background: "conic-gradient(rgba(255,255,255,0.9) var(--p, 0%), transparent 0)",
        mask: "radial-gradient(transparent 12px, black 13px)",
        WebkitMask: "radial-gradient(transparent 12px, black 13px)",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.15s ease",
        zIndex: "9999"
      });
      document.body.appendChild(ring);
    }

    const marchRay = () => {
      const start = camera.position;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      
      let x = Math.floor(start.x / voxel);
      let y = Math.floor(start.y / voxel);
      let z = Math.floor(start.z / voxel);
      
      const stepX = Math.sign(dir.x);
      const stepY = Math.sign(dir.y);
      const stepZ = Math.sign(dir.z);
      
      const tDeltaX = stepX !== 0 ? Math.abs(voxel / dir.x) : Infinity;
      const tDeltaY = stepY !== 0 ? Math.abs(voxel / dir.y) : Infinity;
      const tDeltaZ = stepZ !== 0 ? Math.abs(voxel / dir.z) : Infinity;
      
      let tMaxX = stepX !== 0 ? (stepX > 0 ? (x + 1) * voxel - start.x : start.x - x * voxel) / Math.abs(dir.x) : Infinity;
      let tMaxY = stepY !== 0 ? (stepY > 0 ? (y + 1) * voxel - start.y : start.y - y * voxel) / Math.abs(dir.y) : Infinity;
      let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? (z + 1) * voxel - start.z : start.z - z * voxel) / Math.abs(dir.z) : Infinity;
      
      let dist = 0;
      while (dist < REACH) {
        if (tMaxX < tMaxY) {
          if (tMaxX < tMaxZ) { x += stepX; dist = tMaxX; tMaxX += tDeltaX; }
          else { z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; }
        } else {
          if (tMaxY < tMaxZ) { y += stepY; dist = tMaxY; tMaxY += tDeltaY; }
          else { z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; }
        }
        
        const vx = x + cxRound;
        const vy = y;
        const vz = z + czRound;
        
        const col = colMap.get(vx + "," + vz);
        if (col && col.has(vy)) {
          for (const m of meshesRef.current) {
            const slotMap = m.userData?.slotMap as Map<string, number>;
            if (slotMap && slotMap.has(vx + "," + vy + "," + vz)) {
              return { vx, vy, vz, mesh: m, slot: slotMap.get(vx + "," + vy + "," + vz)! };
            }
          }
        }
      }
      return null;
    };

    // Column-top map: (vx,vz) → Set<vy>. Tracks every block's vertical position
    // per column so placement can snap to top-of-stack (gravity).
    const colMap = new Map<string, Set<number>>();
    const addCol = (vx: number, vy: number, vz: number) => {
      const k = vx + "," + vz;
      let s = colMap.get(k);
      if (!s) { s = new Set(); colMap.set(k, s); }
      s.add(vy);
    };
    const removeCol = (vx: number, vy: number, vz: number) => {
      colMap.get(vx + "," + vz)?.delete(vy);
    };
    const colTop = (vx: number, vz: number): number | null => {
      const s = colMap.get(vx + "," + vz);
      if (!s || s.size === 0) return null;
      let top = -Infinity;
      for (const y of s) if (y > top) top = y;
      return top;
    };

    // Placement-aware top lookup: falls back to the walkable ground map for
    // occlusion-culled interior floor cells that have no rendered block in
    // colMap. Without this, aiming at certain floor spots silently fails.
    const topAt = (vx: number, vz: number): number | null => {
      const t = colTop(vx, vz);
      if (t !== null) return t;
      const g = groundRef.current?.map.get(vx + "," + vz);
      return g === undefined ? null : g;
    };

    const addLayer = (buffer: ArrayBuffer | Int32Array | undefined, color: number, opacity = 1, layerName = "block", hiddenBuf?: ArrayBuffer | Int32Array) => {
      if (!buffer) return null;
      const arr = buffer instanceof Int32Array ? buffer : new Int32Array(buffer);
      const hiddenArr = hiddenBuf ? (hiddenBuf instanceof Int32Array ? hiddenBuf : new Int32Array(hiddenBuf)) : new Int32Array(0);
      if (!arr.length && !hiddenArr.length) return null;
      currentBlocks += arr.length / 3;
      const totalCap = (arr.length + hiddenArr.length) / 3;
      const material = new THREE.MeshPhongMaterial({ color, shininess: opacity < 1 ? 70 : 18, transparent: opacity < 1, opacity });
      const mesh = new THREE.InstancedMesh(box, material, totalCap);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData = { layer: layerName, freeSlots: [] as number[], slotMap: new Map<string, number>(), hiddenMap: new Map<string, number>() };
      for (let i = 0, j = 0; i < arr.length; i += 3, j++) {
        const x = arr[i];
        const y = arr[i + 1];
        const z = arr[i + 2];
        dummy.position.set((x - cxRound) * voxel, y * voxel, (z - czRound) * voxel);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(j, dummy.matrix);
        (mesh.userData.slotMap as Map<string, number>).set(x + "," + y + "," + z, j);
        addCol(x, y, z);
      }
      // Stash hidden positions in spare slots with zero-scale matrices — ready to reveal.
      const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
      const visCount = arr.length / 3;
      for (let i = 0, j = visCount; i < hiddenArr.length; i += 3, j++) {
        const x = hiddenArr[i];
        const y = hiddenArr[i + 1];
        const z = hiddenArr[i + 2];
        mesh.setMatrixAt(j, zeroM);
        (mesh.userData.hiddenMap as Map<string, number>).set(x + "," + y + "," + z, j);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      meshesRef.current.push(mesh);
      return mesh;
    };

    addLayer(layers.dirt, PAL.dirt, 1, "dirt", (layers as any).hidden_dirt);
    addLayer(layers.grass, season === "fall" ? 0x7a6a2f : PAL.grass, 1, "grass");
    addLayer(layers.dryGrass, PAL.dryGrass, 1, "dryGrass");
    addLayer(layers.snow, PAL.snow, 1, "snow");
    addLayer(layers.wet, PAL.wet, 0.85, "wet");
    addLayer(layers.trunks, PAL.trunk, 1, "trunks");
    addLayer(layers.leaves, season === "fall" ? 0x9a5b1f : PAL.leaf, 0.95, "leaves");
    addLayer(layers.water, PAL.water, 0.78, "water");

    const wallArr = layers.wall ? new Int32Array(layers.wall) : new Int32Array(0);
    let wallMinY = Infinity, wallMaxY = -Infinity;
    for (let i = 1; i < wallArr.length; i += 3) {
      if (wallArr[i] < wallMinY) wallMinY = wallArr[i];
      if (wallArr[i] > wallMaxY) wallMaxY = wallArr[i];
    }
    const wallCutY = wallMinY + (wallMaxY - wallMinY) * 0.45;
    const lower: number[] = [];
    const upper: number[] = [];
    for (let i = 0; i < wallArr.length; i += 3) {
      (wallArr[i + 1] <= wallCutY ? lower : upper).push(wallArr[i], wallArr[i + 1], wallArr[i + 2]);
    }
    addLayer(new Int32Array(lower), PAL.wall, 1, "wall");
    const wallUpperMesh = addLayer(new Int32Array(upper), PAL.wall, 1, "wall");
    const ceilingMesh = addLayer(layers.ceiling, PAL.ceiling, 1, "ceiling");
    if (wallUpperMesh) { wallUpperMesh.material.transparent = true; wallUpperMesh.material.depthWrite = false; }
    if (ceilingMesh) { ceilingMesh.material.transparent = true; ceilingMesh.material.depthWrite = false; }
    fadeMeshesRef.current = { ceiling: ceilingMesh, wallUpper: wallUpperMesh };

    // ─── Organic lifecycle scaffolding ─────────────────────────────────────
    // Fruit / seed / sapling break conservation by design: fruit is eaten
    // (deleted), saplings mature into trunks with new leaves (created). Each
    // lifecycle layer gets its own InstancedMesh with pre-allocated free slots
    // so spawn/despawn is cheap. growthTrunks / growthLeaves are extra meshes
    // sharing the "trunks" / "leaves" layer labels so MOVE_MS + pickup just
    // work via slotMap lookup.
    const leafCountStart = layers.leaves ? new Int32Array(layers.leaves).length / 3 : 0;
    const trunkCountStart = layers.trunks ? new Int32Array(layers.trunks).length / 3 : 0;
    const makeGrowable = (color: number, capacity: number, layerName: string, opacity = 1, customGeo?: any) => {
      const cap = Math.max(64, capacity);
      const material = new THREE.MeshPhongMaterial({ color, shininess: 60, transparent: opacity < 1, opacity });
      const mesh = new THREE.InstancedMesh(customGeo || box, material, cap);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData = {
        layer: layerName,
        freeSlots: [] as number[],
        slotMap: new Map<string, number>(),
        hiddenMap: new Map<string, number>(),
        growable: true,
      };
      const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) {
        mesh.setMatrixAt(i, zeroM);
        (mesh.userData.freeSlots as number[]).push(i);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      meshesRef.current.push(mesh);
      return mesh;
    };
    
    // Use smaller geometries for organics to prevent z-fighting / flickering.
    const fruitGeo = new THREE.BoxGeometry(voxel * 0.45, voxel * 0.45, voxel * 0.45);
    const seedGeo = new THREE.BoxGeometry(voxel * 0.25, voxel * 0.25, voxel * 0.25);
    const saplingGeo = new THREE.BoxGeometry(voxel * 0.65, voxel * 0.65, voxel * 0.65);
    
    const fruitMesh = makeGrowable(PAL.fruit, Math.max(200, Math.floor(leafCountStart * 0.6)), "fruit", 1, fruitGeo);
    const seedMesh = makeGrowable(PAL.seed, Math.max(160, Math.floor(leafCountStart * 0.35)), "seed", 1, seedGeo);
    const saplingMesh = makeGrowable(PAL.sapling, Math.max(96, Math.floor(leafCountStart * 0.15)), "sapling", 1, saplingGeo);
    const growthTrunkMesh = makeGrowable(PAL.trunk, Math.max(96, Math.floor(trunkCountStart * 0.6) || 96), "trunks");
    const growthLeafMesh = makeGrowable(season === "fall" ? 0x9a5b1f : PAL.leaf, Math.max(160, Math.floor(leafCountStart * 0.5)), "leaves", 0.95);

    // Universal spawn/despawn helpers — work for ANY mesh that has the
    // freeSlots + slotMap userData shape (original or growable). They keep
    // colMap consistent so raycast/pickup/walk all stay in sync.
    const spawnBlockInto = (mesh: any, vx: number, vy: number, vz: number, source = "sim"): boolean => {
      if (!mesh) return false;
      const free = mesh.userData.freeSlots as number[];
      if (!free || free.length === 0) return false;
      const colSet = colMap.get(vx + "," + vz);
      if (colSet && colSet.has(vy)) return false;
      const slot = free.pop()!;
      dummy.position.set((vx - cxRound) * voxel, vy * voxel, (vz - czRound) * voxel);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.userData.slotMap as Map<string, number>).set(vx + "," + vy + "," + vz, slot);
      addCol(vx, vy, vz);
      ledgerMove("void", "world", 1, source);
      protAdd(vx, vz, mesh.userData.layer, 1);
      return true;
    };
    const removeBlockFrom = (mesh: any, vx: number, vy: number, vz: number, source = "sim"): boolean => {
      if (!mesh) return false;
      const slotMap = mesh.userData.slotMap as Map<string, number>;
      const k = vx + "," + vy + "," + vz;
      const slot = slotMap.get(k);
      if (slot === undefined) return false;
      const zeroM2 = new THREE.Matrix4().makeScale(0, 0, 0);
      mesh.setMatrixAt(slot, zeroM2);
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.userData.freeSlots as number[]).push(slot);
      slotMap.delete(k);
      removeCol(vx, vy, vz);
      ledgerMove("world", "void", 1, source);
      protAdd(vx, vz, mesh.userData.layer, -1);
      return true;
    };

    // ─── Local protection field (Chunk 3 — mass-and-density.md §3) ────────
    // Coarse 2D cell grid (P_CELL × P_CELL columns). Each cell holds the
    // summed density-mass of every block in its columns. Protection at a
    // column = Σ nearby cellMass / (1 + d²) — gravity-style falloff. The
    // void only sees mass: pressure anywhere = base / local protection.
    const P_CELL = 8;
    const protCells = new Map<string, number>();
    const protAdd = (vx: number, vz: number, layer: string, sign: number) => {
      const ck = Math.floor(vx / P_CELL) + "," + Math.floor(vz / P_CELL);
      protCells.set(ck, (protCells.get(ck) || 0) + sign * densityOf(layer));
    };
    const protectionAt = (vx: number, vz: number): number => {
      const cx = Math.floor(vx / P_CELL), cz = Math.floor(vz / P_CELL);
      let p = 0;
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          const m = protCells.get((cx + dx) + "," + (cz + dz));
          if (m) p += m / (1 + dx * dx + dz * dz);
        }
      }
      return p;
    };
    // Seed the field from everything the scan placed (visible + hidden/x-ray).
    for (const m of meshesRef.current) {
      const layer = m.userData?.layer || "block";
      const sm = m.userData?.slotMap as Map<string, number> | undefined;
      if (sm) for (const k of sm.keys()) { const c = k.split(","); protAdd(+c[0], +c[2], layer, 1); }
      const hm = m.userData?.hiddenMap as Map<string, number> | undefined;
      if (hm) for (const k of hm.keys()) { const c = k.split(","); protAdd(+c[0], +c[2], layer, 1); }
    }
    console.log("[tinyworld] protection field seeded:", protCells.size, "cells");

    // ─── Organic lifecycle state + tick ────────────────────────────────────
    // organicLife: pos-key → { kind, since, onTree? }. Only mid-lifecycle
    // blocks live here; original-scan leaves are sampled randomly per tick
    // to seed new fruit. Seeded from existing fruit/seed/sapling layers on
    // load so saved worlds resume gracefully (clock resets, not aged).
    type OrganicEntry = { kind: "fruit" | "seed" | "sapling"; since: number; onTree?: boolean };
    const organicLife = new Map<string, OrganicEntry>();
    let lastOrganicTick = 0;
    const ORGANIC_TICK_MS = 750;
    const FRUIT_DROP_MS = 18000;
    const FRUIT_ROT_MS = 22000;
    const SEED_GERMINATE_MS = 16000;
    const SAPLING_GROW_MS = 35000;
    const seasonGrowth = season === "summer" ? 1.7 : season === "spring" ? 1.2 : season === "fall" ? 0.55 : 0.15;

    // If we loaded from a saved world, the payload may carry fruit/seed/
    // sapling layers. Pour them into the growable meshes before the
    // lifecycle scan picks them up.
    const populateFromSaved = (mesh: any, key: string) => {
      const buf = (layers as any)[key];
      if (!buf) return;
      const arr = buf instanceof Int32Array ? buf : new Int32Array(buf);
      for (let i = 0; i < arr.length; i += 3) {
        spawnBlockInto(mesh, arr[i], arr[i + 1], arr[i + 2]);
      }
    };
    populateFromSaved(fruitMesh, "fruit");
    populateFromSaved(seedMesh, "seed");
    populateFromSaved(saplingMesh, "sapling");

    const seedOrganicFromMesh = (mesh: any, kind: "fruit" | "seed" | "sapling", nowMs: number) => {
      const slotMap = mesh?.userData?.slotMap as Map<string, number> | undefined;
      if (!slotMap) return;
      for (const k of slotMap.keys()) {
        if (!organicLife.has(k)) organicLife.set(k, { kind, since: nowMs, onTree: kind === "fruit" ? false : undefined });
      }
    };
    seedOrganicFromMesh(fruitMesh, "fruit", performance.now());
    seedOrganicFromMesh(seedMesh, "seed", performance.now());
    seedOrganicFromMesh(saplingMesh, "sapling", performance.now());

    const isSoilAt = (vx: number, vy: number, vz: number): boolean => {
      const below = colMap.get(vx + "," + vz);
      return !!below && below.has(vy - 1);
    };
    const isSunlit = (vx: number, vy: number, vz: number): boolean => {
      const col = colMap.get(vx + "," + vz);
      if (!col) return true;
      for (let i = 1; i <= 6; i++) if (col.has(vy + i)) return false;
      return true;
    };
    const findFreeAdjacentAbove = (vx: number, vy: number, vz: number): { x: number; y: number; z: number } | null => {
      const col = colMap.get(vx + "," + vz);
      if (!col || !col.has(vy + 1)) return { x: vx, y: vy + 1, z: vz };
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = vx + d[0], az = vz + d[1];
        const top = colTop(ax, az);
        if (top === null) continue;
        const acol = colMap.get(ax + "," + az);
        if (!acol || !acol.has(top + 1)) return { x: ax, y: top + 1, z: az };
      }
      return null;
    };
    const findGroundBelow = (vx: number, vy: number, vz: number): number | null => {
      const col = colMap.get(vx + "," + vz);
      if (!col) return null;
      let best: number | null = null;
      for (const y of col) {
        if (y < vy && (best === null || y > best)) best = y;
      }
      return best;
    };

    const tickOrganic = (nowMs: number) => {
      if (nowMs - lastOrganicTick < ORGANIC_TICK_MS) return;
      lastOrganicTick = nowMs;

      // Resilience pass: discover newly-placed organic blocks (e.g. user
      // picked a fruit and dropped it on dirt), and prune entries whose
      // block no longer exists (picked up + eaten, or carried away).
      seedOrganicFromMesh(fruitMesh, "fruit", nowMs);
      seedOrganicFromMesh(seedMesh, "seed", nowMs);
      seedOrganicFromMesh(saplingMesh, "sapling", nowMs);
      for (const [k, e] of organicLife) {
        const m = e.kind === "fruit" ? fruitMesh : e.kind === "seed" ? seedMesh : saplingMesh;
        if (!(m.userData.slotMap as Map<string, number>).has(k)) organicLife.delete(k);
      }

      if (seasonGrowth <= 0) return;

      // Phase 1: bud new fruit on a random sample of leaves.
      const leavesAll = meshesRef.current.filter((m) => m.userData?.layer === "leaves");
      const leafKeyPool: string[] = [];
      for (const m of leavesAll) {
        for (const k of (m.userData.slotMap as Map<string, number>).keys()) leafKeyPool.push(k);
      }
      const sampleSize = Math.min(40, leafKeyPool.length);
      const budProb = 0.04 * seasonGrowth;
      for (let i = 0; i < sampleSize; i++) {
        if (Math.random() > budProb) continue;
        const k = leafKeyPool[Math.floor(Math.random() * leafKeyPool.length)];
        if (!k) continue;
        const parts = k.split(",");
        const lx = +parts[0], ly = +parts[1], lz = +parts[2];
        if (!isSunlit(lx, ly, lz)) continue;
        const slot = findFreeAdjacentAbove(lx, ly, lz);
        if (!slot) continue;
        if (spawnBlockInto(fruitMesh, slot.x, slot.y, slot.z)) {
          organicLife.set(slot.x + "," + slot.y + "," + slot.z, { kind: "fruit", since: nowMs, onTree: true });
        }
      }

      // Phase 2: advance lifecycle entries. Collect transitions first to
      // avoid mutating the Map while iterating it.
      const transitions: Array<{ k: string; action: "drop" | "rot" | "germinate" | "mature" }> = [];
      for (const [k, e] of organicLife.entries()) {
        const age = nowMs - e.since;
        if (e.kind === "fruit") {
          if (e.onTree && age > FRUIT_DROP_MS) transitions.push({ k, action: "drop" });
          else if (!e.onTree && age > FRUIT_ROT_MS) transitions.push({ k, action: "rot" });
        } else if (e.kind === "seed" && age > SEED_GERMINATE_MS) {
          transitions.push({ k, action: "germinate" });
        } else if (e.kind === "sapling" && age > SAPLING_GROW_MS) {
          transitions.push({ k, action: "mature" });
        }
      }
      for (const t of transitions) {
        const parts = t.k.split(",");
        const vx = +parts[0], vy = +parts[1], vz = +parts[2];
        if (t.action === "drop") {
          const groundY = findGroundBelow(vx, vy, vz);
          if (groundY === null) continue;
          const ny = groundY + 1;
          if (ny >= vy) {
            // Already resting on something — flip onTree off, reset timer.
            const e = organicLife.get(t.k);
            if (e) organicLife.set(t.k, { ...e, onTree: false, since: nowMs });
            continue;
          }
          if (colMap.get(vx + "," + vz)?.has(ny)) continue;
          if (removeBlockFrom(fruitMesh, vx, vy, vz)) {
            if (spawnBlockInto(fruitMesh, vx, ny, vz)) {
              organicLife.delete(t.k);
              organicLife.set(vx + "," + ny + "," + vz, { kind: "fruit", since: nowMs, onTree: false });
            } else {
              organicLife.delete(t.k);
            }
          }
        } else if (t.action === "rot") {
          if (removeBlockFrom(fruitMesh, vx, vy, vz)) {
            if (spawnBlockInto(seedMesh, vx, vy, vz)) {
              organicLife.set(t.k, { kind: "seed", since: nowMs });
            } else {
              organicLife.delete(t.k);
            }
          }
        } else if (t.action === "germinate") {
          if (!isSoilAt(vx, vy, vz)) {
            // Not on soil — reset timer so it tries again later.
            const e = organicLife.get(t.k);
            if (e) organicLife.set(t.k, { ...e, since: nowMs - SEED_GERMINATE_MS + 4000 });
            continue;
          }
          if (removeBlockFrom(seedMesh, vx, vy, vz)) {
            if (spawnBlockInto(saplingMesh, vx, vy, vz)) {
              organicLife.set(t.k, { kind: "sapling", since: nowMs });
            } else {
              organicLife.delete(t.k);
            }
          }
        } else if (t.action === "mature") {
          if (!removeBlockFrom(saplingMesh, vx, vy, vz)) continue;
          organicLife.delete(t.k);
          if (!spawnBlockInto(growthTrunkMesh, vx, vy, vz)) continue;
          // Update walkable ground if sapling-spot was a floor.
          if (groundRef.current) {
            const gKey = vx + "," + vz;
            const gCurr = groundRef.current.map.get(gKey);
            if (gCurr === undefined || vy > gCurr) groundRef.current.map.set(gKey, vy);
          }
          const above = vy + 1;
          if (!colMap.get(vx + "," + vz)?.has(above)) {
            spawnBlockInto(growthLeafMesh, vx, above, vz);
          }
        }
      }
    };

    // ─── Offline Catch-up Simulation ───────────────────────────────────────
    let catchUpSummary: { voidLoss: number; growth: number; elapsedHours: number; rift: {x:number, y:number, z:number} | null } | null = null;
    
    if (!(source instanceof File)) {
      const savedAt = source.meta?.savedAt as number | undefined;
      // Debug override: append ?catchup=12 to test a 12-hour offline window
      const isDebugCatchup = typeof window !== "undefined" && window.location.search.includes("catchup=");
      const debugHours = isDebugCatchup ? parseFloat(new URLSearchParams(window.location.search).get("catchup") || "12") : 0;
      const effectiveSavedAt = isDebugCatchup ? Date.now() - debugHours * 3600 * 1000 : savedAt;
      
      if (effectiveSavedAt) {
        const est = estimateCatchUp(savedWorldRef.current, { terrain: {}, weather: weatherData }, source.blockCount, effectiveSavedAt);
        let actualVoidLoss = 0;
        let riftPos = null;

        if (est.voidLoss > 0) {
          const perim = [];
          for (const k of colMap.keys()) {
            const [vx, vz] = k.split(",").map(Number);
            let isPerim = false;
            for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
              if (!colMap.has((vx + dx) + "," + (vz + dz))) {
                isPerim = true;
                break;
              }
            }
            if (isPerim) perim.push({ vx, vz });
          }
          if (perim.length > 0) {
            // Rift opens at the weakest point: lowest local protection on the
            // perimeter (mass-and-density.md — deterministic, not random).
            let rift = perim[0];
            let worstProt = Infinity;
            const stride = Math.max(1, Math.floor(perim.length / 600));
            for (let i = 0; i < perim.length; i += stride) {
              const p = protectionAt(perim[i].vx, perim[i].vz);
              if (p < worstProt) { worstProt = p; rift = perim[i]; }
            }
            const rtop = colTop(rift.vx, rift.vz) ?? 0;
            riftPos = { x: rift.vx, y: rtop, z: rift.vz };
            
            const queue = [{vx: rift.vx, vz: rift.vz, dist: 0}];
            const seen = new Set<string>();
            seen.add(rift.vx + "," + rift.vz);
            let head = 0;
            
            while (head < queue.length && actualVoidLoss < est.voidLoss) {
              const curr = queue[head++];
              const k = curr.vx + "," + curr.vz;
              const colSet = colMap.get(k);
              if (colSet && colSet.size > 0) {
                let top = -Infinity;
                for (const y of colSet) if (y > top) top = y;
                
                const slotKey = curr.vx + "," + top + "," + curr.vz;
                let foundMesh = null;
                for (const m of meshesRef.current) {
                  if (m.userData?.slotMap?.has(slotKey)) {
                    foundMesh = m;
                    break;
                  }
                }
                if (foundMesh) {
                  if (removeBlockFrom(foundMesh, curr.vx, top, curr.vz, "void_catchup")) {
                    actualVoidLoss++;
                    if (actualVoidLoss < est.voidLoss) queue.push(curr);
                  }
                }
              }
              
              if (actualVoidLoss < est.voidLoss) {
                for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                  const nx = curr.vx + dx, nz = curr.vz + dz;
                  const nk = nx + "," + nz;
                  if (!seen.has(nk) && colMap.has(nk)) {
                    seen.add(nk);
                    queue.push({vx: nx, vz: nz, dist: curr.dist + 1});
                  }
                }
              }
            }
          }
        }
        
        if (est.cycles > 0) {
          const baseNow = performance.now();
          const loops = Math.min(30, est.cycles);
          for (let i = 0; i < loops; i++) {
            tickOrganic(baseNow + i * ORGANIC_TICK_MS + 100);
          }
        }
        
        if (est.elapsedHours > 0.05 && (actualVoidLoss > 0 || est.growth > 0)) {
          catchUpSummary = { voidLoss: actualVoidLoss, growth: est.growth, elapsedHours: est.elapsedHours, rift: riftPos };
        }
      }
    }

    if (catchUpSummary?.rift) {
      const { x, y, z } = catchUpSummary.rift;
      const riftGroup = new THREE.Group();
      riftGroup.position.set((x - cxRound) * voxel, (y + 1.5) * voxel, (z - czRound) * voxel);
      
      const riftOuter = new THREE.Mesh(
        new THREE.OctahedronGeometry(voxel * 1.2),
        new THREE.MeshBasicMaterial({ color: 0x8a2be2, wireframe: true, transparent: true, opacity: 0.6 })
      );
      const riftInner = new THREE.Mesh(
        new THREE.OctahedronGeometry(voxel * 0.5),
        new THREE.MeshBasicMaterial({ color: 0xff00ff })
      );
      riftGroup.add(riftOuter);
      riftGroup.add(riftInner);
      
      scene.add(riftGroup);
      riftMarkersRef.current.push(riftGroup);
      console.log("[tinyworld] Rift spawned at", x, y, z, "ate", catchUpSummary.voidLoss);
    }

    const grid = new THREE.GridHelper(span * 3, 80, 0x151528, 0x10101f);
    grid.position.y = -voxel * (TERRAIN_DEPTH + 1.2);
    scene.add(grid);

    // Build ground-height lookup for walk grounding.
    const groundBuf = layers.ground as unknown as ArrayBuffer | Int32Array | undefined;
    const groundMap = new Map<string, number>();
    if (groundBuf) {
      const g = groundBuf instanceof Int32Array ? groundBuf : new Int32Array(groundBuf);
      for (let i = 0; i < g.length; i += 3) {
        const x = g[i], z = g[i + 1], y = g[i + 2];
        const k = x + "," + z;
        const prev = groundMap.get(k);
        if (prev === undefined || y > prev) groundMap.set(k, y);
      }
    }
    if (groundMap.size === 0 && colMap.size > 0) {
      // Saved worlds don't persist the voxelizer's ground layer — rebuild a
      // walkable floor map from the block columns (visible + occlusion-culled
      // hidden blocks): the top of the LOWEST contiguous solid run per column.
      // That captures floors and objects resting on them while excluding
      // ceilings, which have an air gap below.
      const colYs = new Map<string, number[]>();
      for (const [k, set] of colMap) {
        colYs.set(k, Array.from(set));
      }
      for (const m of meshesRef.current) {
        const hiddenMap = m.userData?.hiddenMap as Map<string, number> | undefined;
        if (!hiddenMap) continue;
        for (const key of hiddenMap.keys()) {
          const p = key.split(",");
          const k = p[0] + "," + p[2];
          let ys = colYs.get(k);
          if (!ys) { ys = []; colYs.set(k, ys); }
          ys.push(+p[1]);
        }
      }
      for (const [k, ys] of colYs) {
        ys.sort((a, b) => a - b);
        let top = ys[0];
        for (let i = 1; i < ys.length; i++) {
          if (ys[i] <= top + 1) top = Math.max(top, ys[i]);
          else break;
        }
        groundMap.set(k, top);
      }
      console.log("[tinyworld] rebuilt ground map from columns:", groundMap.size, "cells");
    }
    groundRef.current = { map: groundMap, voxel, cx: cxRound, cz: czRound };

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.07;
    orbit.target.set(0, 0, 0);
    orbit.update();
    orbitRef.current = orbit;
    (window as any).__tw = { camera, orbit };

    const fp = new PointerLockControls(camera, renderer.domElement);
    fpRef.current = fp;
    fp.addEventListener("lock", () => {
      setWalking(true);
      orbit.enabled = false;
    });
    fp.addEventListener("unlock", () => {
      setWalking(false);
      orbit.enabled = true;
    });

    enterWalkRef.current = () => {
      // Spawn at the walkable cell nearest the floor centroid that has body
      // clearance. Independent medians could land on (mx, mz) that isn't in
      // groundMap (returning 0 from sampleGround → stuck in floor geometry).
      // Minosoft pattern: pre-snap to a position where the player AABB has
      // zero collisions BEFORE the first physics tick.
      let sx = 0, sz = 0, sy = EYE_HEIGHT;
      const ground = groundRef.current;
      if (ground && ground.map.size > 0) {
        let sumX = 0, sumZ = 0, n = 0;
        for (const k of ground.map.keys()) {
          const [vx, vz] = k.split(",").map(Number);
          sumX += vx; sumZ += vz; n++;
        }
        const cx = sumX / n, cz = sumZ / n;
        let bestD2 = Infinity;
        let bestSpawn: { sx: number; sz: number; sy: number } | null = null;
        for (const k of ground.map.keys()) {
          const [vx, vz] = k.split(",").map(Number);
          const dx = vx - cx, dz = vz - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= bestD2) continue;
          const wx = (vx - ground.cx) * ground.voxel;
          const wz = (vz - ground.cz) * ground.voxel;
          const clearY = findSafeSpawnY(wx, wz);
          if (clearY === null) continue;
          bestD2 = d2;
          bestSpawn = { sx: wx, sz: wz, sy: clearY };
        }
        if (bestSpawn) { 
          sx = bestSpawn.sx; sz = bestSpawn.sz; sy = bestSpawn.sy; 
        } else {
          // Fallback: spawn in the sky above the centroid if the room is too cramped.
          sx = 0; sz = 0; sy = EYE_HEIGHT + voxel * 20;
        }
      }
      camera.position.set(sx, sy, sz);
      velocityYRef.current = 0;
      
      // Fallback: if PointerLock doesn't fire the lock event natively, force the UI state.
      setWalking(true);
      orbit.enabled = false;
      try {
        fp.lock();
      } catch (e) {
        console.warn("Pointer lock failed:", e);
      }
    };

    // Player physics scaled to voxel size — you're tiny-world sized, not human sized.
    const EYE_HEIGHT = voxel * 3.5;
    const MOVE_SPEED = voxel * 8;
    const JUMP_VELOCITY = voxel * 18;
    const GRAVITY = voxel * 55;

    // Sample ground height at world (x, z) — returns world Y of floor top.
    // footWY (optional): current foot height — columns whose top is more than
    // ~1.15 voxels above the feet are ignored, so tall neighbors (walls,
    // stacks) can't yank the sample upward while walking on top of objects.
    // radius (optional, world units): how far around (wx, wz) to consider
    // columns — pass the body radius so only columns the body actually
    // overlaps can support it.
    const sampleGround = (wx: number, wz: number, footWY?: number, radius = 0): number => {
      const ground = groundRef.current;
      if (!ground || ground.map.size === 0) return 0;
      const v = ground.voxel;
      const minVX = Math.round((wx - radius) / v) + ground.cx;
      const maxVX = Math.round((wx + radius) / v) + ground.cx;
      const minVZ = Math.round((wz - radius) / v) + ground.cz;
      const maxVZ = Math.round((wz + radius) / v) + ground.cz;
      let best: number | null = null;
      let bestAny: number | null = null;
      for (let vx = minVX; vx <= maxVX; vx++) {
        for (let vz = minVZ; vz <= maxVZ; vz++) {
          const y = ground.map.get(vx + "," + vz);
          if (y === undefined) continue;
          if (bestAny === null || y > bestAny) bestAny = y;
          if (footWY !== undefined && (y + 1) * v > footWY + v * 1.15) continue;
          if (best === null || y > best) best = y;
        }
      }
      if (best === null && bestAny === null) {
        // Nothing under the body at all — fall back to the 3x3 neighborhood
        // max so we never return 0 over scanned terrain.
        const cvx = Math.round(wx / v) + ground.cx;
        const cvz = Math.round(wz / v) + ground.cz;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const y = ground.map.get((cvx + dx) + "," + (cvz + dz));
            if (y === undefined) continue;
            if (bestAny === null || y > bestAny) bestAny = y;
          }
        }
      }
      const pick = best !== null ? best : bestAny;
      if (pick === null) return 0;
      return (pick + 1) * v;
    };

    // Horizontal collision against solid blocks in colMap. Tests the player
    // body envelope (vertical cylinder, radius playerR, height EYE_HEIGHT)
    // for any block overlap above the step-up tolerance — blocks at the
    // foot voxel + 1 are forgiven so single-voxel ledges remain climbable
    // via the ground snap, but anything chest-high or above blocks movement.
    const playerR = voxel * 0.35;
    const isBlockedAt = (wx: number, wz: number): boolean => {
      const footY = camera.position.y - EYE_HEIGHT;
      const stepUpY = footY + voxel * 1.1;
      const headY = camera.position.y - voxel * 0.05;
      const lowVy = Math.round(stepUpY / voxel);
      const highVy = Math.round(headY / voxel);
      if (lowVy > highVy) return false;
      const minVX = Math.round((wx - playerR) / voxel) + cxRound;
      const maxVX = Math.round((wx + playerR) / voxel) + cxRound;
      const minVZ = Math.round((wz - playerR) / voxel) + czRound;
      const maxVZ = Math.round((wz + playerR) / voxel) + czRound;
      for (let vx = minVX; vx <= maxVX; vx++) {
        for (let vz = minVZ; vz <= maxVZ; vz++) {
          const col = colMap.get(vx + "," + vz);
          if (!col) continue;
          for (let vy = lowVy; vy <= highVy; vy++) {
            if (col.has(vy)) return true;
          }
        }
      }
      return false;
    };

    // Same cylinder test as isBlockedAt but at an arbitrary world Y — used by
    // spawn clearance sweep + per-frame stuck-recovery.
    const bodyBlockedAtY = (wx: number, wy: number, wz: number): boolean => {
      const footY = wy - EYE_HEIGHT;
      const stepUpY = footY + voxel * 1.1;
      const headY = wy - voxel * 0.05;
      const lowVy = Math.round(stepUpY / voxel);
      const highVy = Math.round(headY / voxel);
      if (lowVy > highVy) return false;
      const minVX = Math.round((wx - playerR) / voxel) + cxRound;
      const maxVX = Math.round((wx + playerR) / voxel) + cxRound;
      const minVZ = Math.round((wz - playerR) / voxel) + czRound;
      const maxVZ = Math.round((wz + playerR) / voxel) + czRound;
      for (let vx = minVX; vx <= maxVX; vx++) {
        for (let vz = minVZ; vz <= maxVZ; vz++) {
          const col = colMap.get(vx + "," + vz);
          if (!col) continue;
          for (let vy = lowVy; vy <= highVy; vy++) {
            if (col.has(vy)) return true;
          }
        }
      }
      return false;
    };

    // Sweep upward from groundY+EYE_HEIGHT until the body cylinder fits. Used
    // by spawn to avoid placing the camera inside ceilings/walls/interior fill.
    const findSafeSpawnY = (wx: number, wz: number): number | null => {
      const gy = sampleGround(wx, wz);
      for (let step = 0; step < 24; step++) {
        const tryY = gy + EYE_HEIGHT + step * voxel * 0.5;
        if (!bodyBlockedAtY(wx, tryY, wz)) return tryY;
      }
      return null;
    };

    // ─── Tiny Worker v1: AI NPC that paths via A* and moves soft blocks ─────
    // One character per world. Picks up grass/dirt/leaves/fruit/snow/dryGrass
    // from somewhere within ~30 voxels, walks them to a random walkable cell,
    // places them. Slow tick (~250ms) for decisions/cell-step. Per-frame
    // render lerp for smooth motion. Conservation-respecting — uses the same
    // freeSlots mechanism as the player so block counts stay consistent.
    const SOFT_WORKER_LAYERS = new Set(["grass", "dryGrass", "leaves", "fruit", "dirt", "snow"]);

    // Keep the walkable ground map consistent after agent block mutations.
    const syncGroundAfterRemove = (vx: number, vy: number, vz: number, layer: string) => {
      if (!groundRef.current || !SOFT_WORKER_LAYERS.has(layer)) return;
      const gKey = vx + "," + vz;
      const gCurr = groundRef.current.map.get(gKey);
      if (gCurr !== undefined && gCurr === vy) {
        const nt = colTop(vx, vz);
        if (nt !== null) groundRef.current.map.set(gKey, nt);
        else groundRef.current.map.delete(gKey);
      }
    };
    const syncGroundAfterPlace = (vx: number, vy: number, vz: number, layer: string) => {
      if (!groundRef.current || !SOFT_WORKER_LAYERS.has(layer)) return;
      const gKey = vx + "," + vz;
      const gCurr = groundRef.current.map.get(gKey);
      if (gCurr === undefined || vy > gCurr) groundRef.current.map.set(gKey, vy);
    };
    const aStarOnGround = (sx: number, sz: number, gx: number, gz: number, maxIter = 1500): Array<[number, number]> | null => {
      const ground = groundRef.current;
      if (!ground) return null;
      const startKey = sx + "," + sz;
      const goalKey = gx + "," + gz;
      if (!ground.map.has(startKey) || !ground.map.has(goalKey)) return null;
      const gScore = new Map<string, number>();
      const parent = new Map<string, string | null>();
      const open = new Set<string>();
      const h = (x: number, z: number) => Math.abs(x - gx) + Math.abs(z - gz);
      gScore.set(startKey, 0);
      parent.set(startKey, null);
      open.add(startKey);
      let iters = 0;
      while (open.size > 0 && iters++ < maxIter) {
        let bestKey: string | null = null;
        let bestF = Infinity;
        for (const k of open) {
          const cs = k.split(",");
          const g = gScore.get(k)!;
          const f = g + h(+cs[0], +cs[1]);
          if (f < bestF) { bestF = f; bestKey = k; }
        }
        if (!bestKey) return null;
        if (bestKey === goalKey) {
          const path: Array<[number, number]> = [];
          let k: string | null = bestKey;
          while (k) {
            const cs = k.split(",");
            path.push([+cs[0], +cs[1]]);
            k = parent.get(k) ?? null;
          }
          path.reverse();
          return path;
        }
        open.delete(bestKey);
        const cs = bestKey.split(",");
        const cx = +cs[0], cz = +cs[1];
        const cY = ground.map.get(bestKey)!;
        const curG = gScore.get(bestKey)!;
        const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dz] of dirs) {
          const nx = cx + dx, nz = cz + dz;
          const nk = nx + "," + nz;
          const nY = ground.map.get(nk);
          if (nY === undefined) continue;
          if (Math.abs(nY - cY) > 1) continue; // step-up of 1 max, no jumping walls
          const tg = curG + 1;
          if (tg < (gScore.get(nk) ?? Infinity)) {
            gScore.set(nk, tg);
            parent.set(nk, bestKey);
            open.add(nk);
          }
        }
      }
      return null;
    };
    const findSoftBlockNearW = (vx: number, vz: number, r: number) => {
      const cands: Array<{ vx: number; vy: number; vz: number; mesh: any; slot: number; d2: number }> = [];
      for (const [colKey, ySet] of colMap) {
        const cs = colKey.split(",");
        const cx = +cs[0], cz = +cs[1];
        const dx = cx - vx, dz = cz - vz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r) continue;
        let top = -Infinity;
        for (const y of ySet) if (y > top) top = y;
        if (!isFinite(top)) continue;
        const k = cx + "," + top + "," + cz;
        for (const m of meshesRef.current) {
          const slot = (m.userData?.slotMap as Map<string, number> | undefined)?.get(k);
          if (slot !== undefined && SOFT_WORKER_LAYERS.has(m.userData.layer)) {
            cands.push({ vx: cx, vy: top, vz: cz, mesh: m, slot, d2 });
            break;
          }
        }
      }
      if (!cands.length) return null;
      // Pick a random one from the closest third — feels less robotic than
      // always choosing the nearest.
      cands.sort((a, b) => a.d2 - b.d2);
      const slice = cands.slice(0, Math.max(1, Math.ceil(cands.length / 3)));
      return slice[Math.floor(Math.random() * slice.length)];
    };
    const findAdjacentWalkableW = (vx: number, vz: number): [number, number] | null => {
      const ground = groundRef.current;
      if (!ground) return null;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const k = (vx + dx) + "," + (vz + dz);
        if (ground.map.has(k)) return [vx + dx, vz + dz];
      }
      return null;
    };
    const randomGroundCellNearW = (vx: number, vz: number, r: number): [number, number] | null => {
      const ground = groundRef.current;
      if (!ground) return null;
      const cands: Array<[number, number]> = [];
      for (const k of ground.map.keys()) {
        const cs = k.split(",");
        const x = +cs[0], z = +cs[1];
        if (Math.abs(x - vx) > r || Math.abs(z - vz) > r) continue;
        if (x === vx && z === vz) continue;
        cands.push([x, z]);
      }
      if (!cands.length) return null;
      return cands[Math.floor(Math.random() * cands.length)];
    };

    // ─── LLM-driven planning ────────────────────────────────────────────────
    // When idle, a worker fetches a small build plan from /api/tinyworld-plan
    // (Gemini 2.5 Flash-Lite). The plan is a list of primitive shapes which
    // we expand to a sorted target-block list. Worker then executes each
    // target: pickup matching layer → A* walk → place. Plan re-fetched
    // whenever the current one finishes or fails.
    type PlanTarget = { vx: number; vz: number; layer: string; localY: number; done: boolean };
    type WorkerPlan = { name: string; rationale: string; targets: PlanTarget[] };

    const expandPrimitive = (step: any): Array<{ vx: number; vz: number; layer: string; localY: number }> => {
      const layer = String(step?.layer ?? "");
      const out: Array<{ vx: number; vz: number; layer: string; localY: number }> = [];
      if (!layer || !SOFT_WORKER_LAYERS.has(layer)) return out;
      const p = step?.kind ?? step?.primitive;
      if (p === "column") {
        const h = Math.max(1, Math.min(6, Number(step.height) || 1));
        const vx = Number(step.vx), vz = Number(step.vz);
        if (!Number.isFinite(vx) || !Number.isFinite(vz)) return out;
        for (let y = 0; y < h; y++) out.push({ vx, vz, layer, localY: y });
      } else if (p === "wall") {
        const from = step.from, to = step.to;
        if (!Array.isArray(from) || !Array.isArray(to)) return out;
        const fx = Number(from[0]), fz = Number(from[1]);
        const tx = Number(to[0]), tz = Number(to[1]);
        if (![fx, fz, tx, tz].every(Number.isFinite)) return out;
        const h = Math.max(1, Math.min(4, Number(step.height) || 1));
        const dx = Math.abs(tx - fx), dz = Math.abs(tz - fz);
        const sx = fx < tx ? 1 : -1, sz = fz < tz ? 1 : -1;
        let err = dx - dz, x = fx, z = fz;
        for (let safety = 0; safety < 30; safety++) {
          for (let y = 0; y < h; y++) out.push({ vx: x, vz: z, layer, localY: y });
          if (x === tx && z === tz) break;
          const e2 = 2 * err;
          if (e2 > -dz) { err -= dz; x += sx; }
          if (e2 < dx) { err += dx; z += sz; }
        }
      } else if (p === "floor") {
        const from = step.from, to = step.to;
        if (!Array.isArray(from) || !Array.isArray(to)) return out;
        const fx = Number(from[0]), fz = Number(from[1]);
        const tx = Number(to[0]), tz = Number(to[1]);
        if (![fx, fz, tx, tz].every(Number.isFinite)) return out;
        const x0 = Math.min(fx, tx), x1 = Math.max(fx, tx);
        const z0 = Math.min(fz, tz), z1 = Math.max(fz, tz);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 30) return out;
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++)
          out.push({ vx: x, vz: z, layer, localY: 0 });
      } else if (p === "pile") {
        const r = Math.max(1, Math.min(3, Number(step.radius) || 1));
        const vx = Number(step.vx), vz = Number(step.vz);
        if (!Number.isFinite(vx) || !Number.isFinite(vz)) return out;
        for (let dx = -r + 1; dx < r; dx++) for (let dz = -r + 1; dz < r; dz++) {
          const dist = Math.abs(dx) + Math.abs(dz);
          if (dist >= r) continue;
          const h = r - dist;
          for (let y = 0; y < h; y++) out.push({ vx: vx + dx, vz: vz + dz, layer, localY: y });
        }
      }
      return out;
    };

    const findSourceBlockForLayer = (vx: number, vz: number, layer: string) => {
      let best: { vx: number; vy: number; vz: number; mesh: any; slot: number; d2: number } | null = null;
      for (const m of meshesRef.current) {
        if (m.userData?.layer !== layer) continue;
        const slotMap = m.userData?.slotMap as Map<string, number> | undefined;
        if (!slotMap) continue;
        for (const k of slotMap.keys()) {
          const cs = k.split(",");
          const cx = +cs[0], cy = +cs[1], cz = +cs[2];
          const dx = cx - vx, dz = cz - vz;
          const d2 = dx * dx + dz * dz;
          if (best && d2 >= best.d2) continue;
          // Must be the top of its column — workers don't dig through.
          const colSet = colMap.get(cx + "," + cz);
          if (!colSet) continue;
          let top = -Infinity;
          for (const y of colSet) if (y > top) top = y;
          if (top !== cy) continue;
          best = { vx: cx, vy: cy, vz: cz, mesh: m, slot: slotMap.get(k)!, d2 };
        }
      }
      return best;
    };

    const adjacentOrSelfWalkable = (vx: number, vz: number): [number, number] | null => {
      const ground = groundRef.current;
      if (!ground) return null;
      // Prefer adjacent, fall back to standing on the target column itself.
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[0,0]]) {
        const k = (vx + dx) + "," + (vz + dz);
        if (ground.map.has(k)) return [vx + dx, vz + dz];
      }
      return null;
    };

    const computeVisionFor = (vx: number, vz: number, R = 25) => {
      const resources: Record<string, number> = {};
      for (const layer of SOFT_WORKER_LAYERS) resources[layer] = 0;
      for (const m of meshesRef.current) {
        const layer = m.userData?.layer;
        if (!SOFT_WORKER_LAYERS.has(layer)) continue;
        const slotMap = m.userData?.slotMap as Map<string, number> | undefined;
        if (!slotMap) continue;
        for (const k of slotMap.keys()) {
          const cs = k.split(",");
          const x = +cs[0], z = +cs[2];
          const dx = x - vx, dz = z - vz;
          if (dx * dx + dz * dz > R * R) continue;
          resources[layer] = (resources[layer] || 0) + 1;
        }
      }
      const walkable: Array<[number, number]> = [];
      const ground = groundRef.current;
      if (ground) {
        for (const k of ground.map.keys()) {
          const cs = k.split(",");
          const x = +cs[0], z = +cs[1];
          const dx = x - vx, dz = z - vz;
          if (dx * dx + dz * dz <= R * R) walkable.push([x, z]);
        }
      }
      return { resources, walkable };
    };

    const fetchWorkerPlan = async (vx: number, vz: number): Promise<WorkerPlan | null> => {
      try {
        const vision = computeVisionFor(vx, vz, 25);
        const r = await fetch("/api/tinyworld-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ worker: { vx, vz }, vision }),
        });
        const data = await r.json();
        if (!data?.ok || !Array.isArray(data?.plan?.steps)) return null;
        const targets: PlanTarget[] = [];
        for (const step of data.plan.steps) {
          for (const b of expandPrimitive(step)) {
            targets.push({ ...b, done: false });
          }
        }
        if (targets.length === 0) return null;
        targets.sort((a, b) => a.localY - b.localY || a.vx - b.vx || a.vz - b.vz);
        if (targets.length > 60) targets.length = 60;
        return {
          name: String(data.plan.name || "untitled"),
          rationale: String(data.plan.rationale || ""),
          targets,
        };
      } catch {
        return null;
      }
    };

    type WorkerState = {
      vx: number; vz: number;
      targetVX: number; targetVZ: number;
      worldX: number; worldY: number; worldZ: number;
      moveStartMs: number; moveEndMs: number;
      path: Array<[number, number]>;
      pathIdx: number;
      mode: "idle" | "walking" | "pickingUp" | "placing" | "planning";
      modeStartMs: number;
      carrying: { mesh: any; color: any; layer: string } | null;
      pickupTarget: { vx: number; vy: number; vz: number; mesh: any; slot: number } | null;
      placeTarget: { vx: number; vz: number; planTargetRef?: PlanTarget } | null;
      group: any;
      carriedMesh: any;
      plan: WorkerPlan | null;
      planRequested: boolean;
      lastPlanFailMs: number;
    };
    const workers: WorkerState[] = [];
    // Spawn 1 worker on a real floor cell near the centroid.
    {
      const ground = groundRef.current;
      let spawn: [number, number] | null = null;
      if (ground && ground.map.size > 0) {
        let sumX = 0, sumZ = 0, n = 0;
        for (const k of ground.map.keys()) {
          const cs = k.split(",");
          sumX += +cs[0]; sumZ += +cs[1]; n++;
        }
        const cx = sumX / n, cz = sumZ / n;
        let bestD2 = Infinity;
        for (const k of ground.map.keys()) {
          const cs = k.split(",");
          const x = +cs[0], z = +cs[1];
          const dx = x - cx, dz = z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; spawn = [x, z]; }
        }
      }
      if (spawn) {
        const group = new THREE.Group();
        
        // Voxel Tech-Scavenger Humanoid
        const matBody = new THREE.MeshPhongMaterial({ color: 0x2a2a30, shininess: 10 }); // lint cloak / gritty armor
        const matSkin = new THREE.MeshPhongMaterial({ color: 0xe0cda9, shininess: 20 });
        const matVisor = new THREE.MeshBasicMaterial({ color: 0x00ffcc }); // Neon pop
        
        const headGroup = new THREE.Group();
        headGroup.position.y = voxel * 0.65;
        const headBox = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.45, voxel * 0.45, voxel * 0.45), matSkin);
        const visor = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.47, voxel * 0.15, voxel * 0.1), matVisor);
        visor.position.set(0, 0, voxel * 0.23);
        headGroup.add(headBox);
        headGroup.add(visor);
        
        const torsoGroup = new THREE.Group();
        torsoGroup.position.y = voxel * 0.1;
        const torso = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.5, voxel * 0.6, voxel * 0.35), matBody);
        
        const legGeo = new THREE.BoxGeometry(voxel * 0.18, voxel * 0.4, voxel * 0.18);
        const legL = new THREE.Mesh(legGeo, matBody);
        legL.position.set(voxel * -0.12, -voxel * 0.5, 0);
        const legR = new THREE.Mesh(legGeo, matBody);
        legR.position.set(voxel * 0.12, -voxel * 0.5, 0);
        
        const armGeo = new THREE.BoxGeometry(voxel * 0.15, voxel * 0.45, voxel * 0.15);
        const armL = new THREE.Mesh(armGeo, matBody);
        armL.position.set(voxel * -0.35, 0, 0);
        const armR = new THREE.Mesh(armGeo, matBody);
        armR.position.set(voxel * 0.35, 0, 0);
        
        torsoGroup.add(torso);
        torsoGroup.add(legL);
        torsoGroup.add(legR);
        torsoGroup.add(armL);
        torsoGroup.add(armR);

        group.add(headGroup);
        group.add(torsoGroup);

        const carried = new THREE.Mesh(
          new THREE.BoxGeometry(voxel * 0.45, voxel * 0.45, voxel * 0.45),
          new THREE.MeshPhongMaterial({ color: 0xffffff }),
        );
        carried.position.set(0, voxel * 1.15, 0);
        carried.visible = false;
        group.add(carried);

        // Locator beacon — thin neon beam so the tiny worker is findable in
        // large scans (fits the Hades/Transistor neon-accent aesthetic).
        const beacon = new THREE.Mesh(
          new THREE.CylinderGeometry(voxel * 0.08, voxel * 0.08, voxel * 40, 6, 1, true),
          new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.3, depthWrite: false }),
        );
        beacon.position.y = voxel * 20;
        group.add(beacon);

        console.log("[tinyworld] worker spawned at cell", spawn[0], spawn[1]);
        
        scene.add(group);
        workers.push({
          vx: spawn[0], vz: spawn[1],
          targetVX: spawn[0], targetVZ: spawn[1],
          worldX: 0, worldY: 0, worldZ: 0,
          moveStartMs: 0, moveEndMs: 0,
          path: [], pathIdx: 0,
          mode: "idle",
          modeStartMs: performance.now(),
          carrying: null, pickupTarget: null, placeTarget: null,
          group, carriedMesh: carried,
          plan: null,
          planRequested: false,
          lastPlanFailMs: 0,
        });
      }
    }
    let lastWorkerTickMs = 0;
    // Slower than v1 — workers now feel deliberate. Cell move 2500ms,
    // pickup 8000ms, place 4000ms. LLM call latency (~1s) is invisible
    // at these timings.
    const W_CELL_MS = 2500;
    const W_PICK_MS = 8000;
    const W_PLACE_MS = 4000;
    const W_PLAN_BACKOFF_MS = 6000;
    const tickWorkers = (now: number) => {
      for (const w of workers) {
        if (w.mode === "idle") {
          // No plan yet — request one (async).
          if (!w.plan) {
            if (!w.planRequested && now - w.lastPlanFailMs > W_PLAN_BACKOFF_MS) {
              w.planRequested = true;
              w.mode = "planning";
              w.modeStartMs = now;
              fetchWorkerPlan(w.vx, w.vz).then((plan) => {
                w.planRequested = false;
                if (plan) {
                  w.plan = plan;
                } else {
                  w.lastPlanFailMs = performance.now();
                }
                if (w.mode === "planning") {
                  w.mode = "idle";
                  w.modeStartMs = performance.now();
                }
              }).catch(() => {
                w.planRequested = false;
                w.lastPlanFailMs = performance.now();
                if (w.mode === "planning") w.mode = "idle";
              });
            }
            continue;
          }
          // Has a plan — find next undone target.
          const next = w.plan.targets.find((t) => !t.done);
          if (!next) {
            w.plan = null;
            continue;
          }
          // If carrying the wrong layer, drop it here first.
          if (w.carrying && w.carrying.layer !== next.layer) {
            w.placeTarget = { vx: w.vx, vz: w.vz };
            w.mode = "placing";
            w.modeStartMs = now;
            continue;
          }
          if (w.carrying && w.carrying.layer === next.layer) {
            // Walk to target column and place.
            const dest = adjacentOrSelfWalkable(next.vx, next.vz);
            if (!dest) { next.done = true; continue; }
            const path = aStarOnGround(w.vx, w.vz, dest[0], dest[1]);
            if (path && path.length >= 1) {
              w.path = path;
              w.pathIdx = 0;
              w.placeTarget = { vx: next.vx, vz: next.vz, planTargetRef: next };
              w.pickupTarget = null;
              w.mode = "walking";
              w.moveEndMs = now;
            } else {
              next.done = true;
            }
          } else {
            // Need to pick up the right layer first.
            const src = findSourceBlockForLayer(w.vx, w.vz, next.layer);
            if (!src) { next.done = true; continue; }
            const dest = adjacentOrSelfWalkable(src.vx, src.vz);
            if (!dest) { next.done = true; continue; }
            const path = aStarOnGround(w.vx, w.vz, dest[0], dest[1]);
            if (path && path.length >= 1) {
              w.path = path;
              w.pathIdx = 0;
              w.pickupTarget = src;
              w.placeTarget = null;
              w.mode = "walking";
              w.moveEndMs = now;
            } else {
              next.done = true;
            }
          }
        } else if (w.mode === "planning") {
          // Awaiting fetch — handled in promise resolver above.
          continue;
        } else if (w.mode === "walking") {
          if (now < w.moveEndMs) continue;
          if (w.pathIdx + 1 < w.path.length) {
            w.pathIdx++;
            w.vx = w.path[w.pathIdx][0];
            w.vz = w.path[w.pathIdx][1];
            if (w.pathIdx + 1 < w.path.length) {
              w.targetVX = w.path[w.pathIdx + 1][0];
              w.targetVZ = w.path[w.pathIdx + 1][1];
              w.moveStartMs = now;
              w.moveEndMs = now + W_CELL_MS;
            } else {
              w.targetVX = w.vx;
              w.targetVZ = w.vz;
              w.moveStartMs = now;
              w.moveEndMs = now;
            }
          } else {
            if (w.pickupTarget) {
              w.mode = "pickingUp";
              w.modeStartMs = now;
            } else if (w.placeTarget) {
              w.mode = "placing";
              w.modeStartMs = now;
            } else {
              w.mode = "idle";
              w.modeStartMs = now;
            }
          }
        } else if (w.mode === "pickingUp") {
          if (now - w.modeStartMs < W_PICK_MS) continue;
          const t = w.pickupTarget!;
          if (removeBlockFrom(t.mesh, t.vx, t.vy, t.vz, "tinyperson")) {
            syncGroundAfterRemove(t.vx, t.vy, t.vz, t.mesh.userData.layer);
            ledgerMove("void", "stockpile", 1, "tinyperson", t.mesh.userData.layer);
            w.carrying = { mesh: t.mesh, color: t.mesh.material.color.clone(), layer: t.mesh.userData.layer };
            if (w.carriedMesh) {
              (w.carriedMesh.material as any).color.copy(w.carrying.color);
              w.carriedMesh.visible = true;
            }
          }
          w.pickupTarget = null;
          w.mode = "idle";
          w.modeStartMs = now;
        } else if (w.mode === "placing") {
          if (now - w.modeStartMs < W_PLACE_MS) continue;
          let placed = false;
          if (w.carrying && w.placeTarget) {
            const top = colTop(w.placeTarget.vx, w.placeTarget.vz)
              ?? (groundRef.current?.map.get(w.placeTarget.vx + "," + w.placeTarget.vz) ?? null);
            if (top !== null) {
              const placeVy = top + 1;
              if (spawnBlockInto(w.carrying.mesh, w.placeTarget.vx, placeVy, w.placeTarget.vz, "tinyperson")) {
                syncGroundAfterPlace(w.placeTarget.vx, placeVy, w.placeTarget.vz, w.carrying.layer);
                ledgerMove("stockpile", "void", 1, "tinyperson", w.carrying.layer);
                placed = true;
              }
            }
          }
          if (placed && w.placeTarget?.planTargetRef) {
            w.placeTarget.planTargetRef.done = true;
          }
          // On failure keep carrying — the block stays in the stockpile
          // instead of silently vanishing like it used to.
          if (placed) {
            w.carrying = null;
            if (w.carriedMesh) w.carriedMesh.visible = false;
          }
          w.placeTarget = null;
          w.mode = "idle";
          w.modeStartMs = now;
        }
      }
    };
    const renderWorkers = (now: number) => {
      for (const w of workers) {
        let wx: number, wz: number;
        const isWalking = w.mode === "walking" && w.moveEndMs > w.moveStartMs;
        if (isWalking) {
          const t = Math.max(0, Math.min(1, (now - w.moveStartMs) / (w.moveEndMs - w.moveStartMs)));
          const fromX = (w.vx - cxRound) * voxel;
          const fromZ = (w.vz - czRound) * voxel;
          const toX = (w.targetVX - cxRound) * voxel;
          const toZ = (w.targetVZ - czRound) * voxel;
          wx = fromX + (toX - fromX) * t;
          wz = fromZ + (toZ - fromZ) * t;
        } else {
          wx = (w.vx - cxRound) * voxel;
          wz = (w.vz - czRound) * voxel;
        }
        const gy = sampleGround(wx, wz);
        w.worldX = wx; w.worldY = gy + voxel * 0.45; w.worldZ = wz;
        
        // Bobbing is handled per limb now, so the root stays anchored
        w.group.position.set(wx, w.worldY, wz);
        
        // Character Animation
        const headGroup = w.group.children[0];
        const visor = headGroup.children[1];
        const torsoGroup = w.group.children[1];
        const legL = torsoGroup.children[1];
        const legR = torsoGroup.children[2];
        const armL = torsoGroup.children[3];
        const armR = torsoGroup.children[4];

        if (isWalking) {
          const speed = 0.015;
          armL.rotation.x = Math.sin(now * speed) * 0.9;
          armR.rotation.x = -Math.sin(now * speed) * 0.9;
          legL.rotation.x = -Math.sin(now * speed) * 0.9;
          legR.rotation.x = Math.sin(now * speed) * 0.9;
          torsoGroup.rotation.y = Math.sin(now * speed) * 0.15;
          torsoGroup.position.y = voxel * 0.1 + Math.abs(Math.sin(now * speed)) * voxel * 0.08;
          headGroup.rotation.x = 0;
          visor.material.color.setHex(0x00ffcc); // Bright cyan
        } else {
          armL.rotation.x = Math.sin(now * 0.002) * 0.1;
          armR.rotation.x = -Math.sin(now * 0.002) * 0.1;
          legL.rotation.x = 0;
          legR.rotation.x = 0;
          torsoGroup.rotation.y = 0;
          torsoGroup.position.y = voxel * 0.1;
          
          // Melancholic idle: head looks down slightly
          headGroup.rotation.x = Math.sin(now * 0.001) * 0.1 - 0.15;
          
          // Pulse visor (breathing)
          const pulse = 0.4 + Math.sin(now * 0.003) * 0.4;
          const r = Math.floor(0x00 * pulse);
          const g = Math.floor(0xcc * pulse);
          const b = Math.floor(0xaa * pulse);
          visor.material.color.setRGB(r/255, g/255, b/255);
        }

        // Face the direction of travel (snap, not lerp — they're tiny).
        if (w.mode === "walking" && (w.targetVX !== w.vx || w.targetVZ !== w.vz)) {
          w.group.rotation.y = Math.atan2(w.targetVX - w.vx, w.targetVZ - w.vz);
        }
      }
    };

    type ChargeState = { startMs: number; mesh: any; idx: number; hardMs: number; vx: number; vy: number; vz: number; color: any };
    type Carry = { mesh: any; originVX: number; originVY: number; originVZ: number; color: any; hardMs: number; layer: string };
    let chargeState: ChargeState | null = null;
    let carryState: Carry | null = null;

    const getPlacementTarget = () => {
      const hit = marchRay();
      let vx: number;
      let vz: number;
      if (hit) {
        vx = hit.vx;
        vz = hit.vz;
      } else {
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const target = camera.position.clone().addScaledVector(forward, REACH * 0.6);
        vx = Math.round(target.x / voxel) + cxRound;
        vz = Math.round(target.z / voxel) + czRound;
      }
      const top = topAt(vx, vz);
      if (top === null) return null;
      return {
        vx,
        vy: top + 1,
        vz,
        world: new THREE.Vector3((vx - cxRound) * voxel, (top + 1) * voxel, (vz - czRound) * voxel),
      };
    };

    const arcPoints = (start: any, end: any, height: number) => {
      const pts: number[] = [];
      const segs = 16;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        pts.push(
          start.x + (end.x - start.x) * t,
          start.y + (end.y - start.y) * t + Math.sin(Math.PI * t) * height,
          start.z + (end.z - start.z) * t,
        );
      }
      return pts;
    };

    const tryPickup = () => {
      if (!fp.isLocked || carryState || chargeState) return;
      const hit = marchRay();
      if (!hit) return;
      const mesh = hit.mesh;
      const layer = (mesh.userData?.layer as string) || "block";
      const hardMs = MOVE_MS[layer] ?? 500;
      if (!isFinite(hardMs)) return; // water, etc.
      chargeState = { startMs: performance.now(), mesh, idx: hit.slot, hardMs, vx: hit.vx, vy: hit.vy, vz: hit.vz, color: mesh.material.color.clone() };
    };

    const completePickup = () => {
      if (!chargeState) return;
      const { mesh, idx, vx, vy, vz, color, hardMs } = chargeState;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      mesh.setMatrixAt(idx, zero);
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.userData.freeSlots as number[]).push(idx);
      (mesh.userData.slotMap as Map<string, number>).delete(vx + "," + vy + "," + vz);
      removeCol(vx, vy, vz);
      protAdd(vx, vz, mesh.userData.layer as string, -1);
      // Reveal any neighbor block that was hidden (occlusion-culled interior dirt etc.).
      tryRevealHidden(vx, vy, vz);
      // If we picked the top floor block in this column, lower the walkable ground.
      const layer = mesh.userData.layer as string;
      if (groundRef.current && (layer === "grass" || layer === "dryGrass" || layer === "snow" || layer === "wet" || layer === "dirt")) {
        const gKey = vx + "," + vz;
        const gCurr = groundRef.current.map.get(gKey);
        if (gCurr !== undefined && gCurr === vy) {
          const newTop = colTop(vx, vz);
          if (newTop !== null) groundRef.current.map.set(gKey, newTop);
          else groundRef.current.map.delete(gKey);
        }
      }
      carryState = { mesh, originVX: vx, originVY: vy, originVZ: vz, color, hardMs, layer };
      ledgerMove("world", "stockpile", 1, "user", layer);
      chargeState = null;
      ghostMesh.visible = false;
      setCarryLayer(layer);
      settleWaterNear(vx, vy, vz);
    };

    // Reveal previously hidden (occlusion-culled) blocks adjacent to a freshly
    // emptied cell. Walks the 6 face-neighbors of (vx, vy, vz); any neighbor
    // that's parked in a hiddenMap gets its matrix rewritten + registered.
    const tryRevealHidden = (vx: number, vy: number, vz: number) => {
      const ds = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      for (const m of meshesRef.current) {
        const hiddenMap = m.userData?.hiddenMap as Map<string, number> | undefined;
        if (!hiddenMap || hiddenMap.size === 0) continue;
        const slotMap = m.userData.slotMap as Map<string, number>;
        let changed = false;
        for (let i = 0; i < ds.length; i++) {
          const nx = vx + ds[i][0], ny = vy + ds[i][1], nz = vz + ds[i][2];
          const k = nx + "," + ny + "," + nz;
          const slot = hiddenMap.get(k);
          if (slot === undefined) continue;
          dummy.position.set((nx - cxRound) * voxel, ny * voxel, (nz - czRound) * voxel);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          m.setMatrixAt(slot, dummy.matrix);
          slotMap.set(k, slot);
          hiddenMap.delete(k);
          addCol(nx, ny, nz);
          changed = true;
          if (groundRef.current && m.userData.layer === "dirt") {
            const gKey = nx + "," + nz;
            const gCurr = groundRef.current.map.get(gKey);
            if (gCurr === undefined || ny > gCurr) groundRef.current.map.set(gKey, ny);
          }
        }
        if (changed) m.instanceMatrix.needsUpdate = true;
      }
    };

    const cancelCharge = () => { chargeState = null; if (ring) ring.style.opacity = "0"; };

    const placeAt = (vx: number, vy: number, vz: number) => {
      if (!carryState) return;
      const freeSlots = carryState.mesh.userData.freeSlots as number[];
      if (!freeSlots.length) return false;
      const top = topAt(vx, vz);
      if (top === null) return false;
      const snappedY = top + 1;
      const slot = freeSlots.pop()!;
      dummy.position.set((vx - cxRound) * voxel, snappedY * voxel, (vz - czRound) * voxel);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      carryState.mesh.setMatrixAt(slot, dummy.matrix);
      carryState.mesh.instanceMatrix.needsUpdate = true;
      (carryState.mesh.userData.slotMap as Map<string, number>).set(vx + "," + snappedY + "," + vz, slot);
      addCol(vx, snappedY, vz);
      protAdd(vx, vz, carryState.layer, 1);
      ledgerMove("stockpile", "world", 1, "user", carryState.layer);
      // If we placed a floor-ish block within step range, raise walkable ground.
      if (groundRef.current && (carryState.layer === "grass" || carryState.layer === "dryGrass" || carryState.layer === "snow" || carryState.layer === "wet" || carryState.layer === "dirt")) {
        const gKey = vx + "," + vz;
        const gCurr = groundRef.current.map.get(gKey);
        if (gCurr === undefined || snappedY > gCurr) groundRef.current.map.set(gKey, snappedY);
      }
      return true;
    };

    // ─── Water flow (settle on edit, conservation-respecting) ───────────────
    // After any land block is moved, redistribute nearby water to fill the
    // lowest reachable cells in its connected region. Total water count is
    // preserved — water only re-pours into newly-opened space, draining from
    // higher cells. Bounded by a radius + cell cap so cost stays trivial.
    const settleWaterNear = (epx: number, epy: number, epz: number) => {
      const waterMesh = meshesRef.current.find((m: any) => m.userData?.layer === "water");
      if (!waterMesh) return;
      const slotMap = waterMesh.userData.slotMap as Map<string, number>;
      const freeSlots = waterMesh.userData.freeSlots as number[];
      if (slotMap.size === 0) return;

      const R = 8;
      const MAX_CELLS = 384;
      const reachable = new Set<string>();
      const cells: number[][] = [];
      const queue: number[][] = [];

      // Seed BFS from any water cells within radius R of the edit point.
      for (const k of slotMap.keys()) {
        const parts = k.split(",");
        const x = +parts[0], y = +parts[1], z = +parts[2];
        if (Math.abs(x - epx) <= R && Math.abs(y - epy) <= R && Math.abs(z - epz) <= R) {
          reachable.add(k);
          cells.push([x, y, z]);
          queue.push([x, y, z]);
        }
      }
      if (queue.length === 0) return;

      const dirs = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]];
      let head = 0;
      while (head < queue.length && reachable.size < MAX_CELLS) {
        const p = queue[head++];
        if (Math.abs(p[0] - epx) > R || Math.abs(p[1] - epy) > R || Math.abs(p[2] - epz) > R) continue;
        for (let d = 0; d < dirs.length; d++) {
          const nx = p[0] + dirs[d][0], ny = p[1] + dirs[d][1], nz = p[2] + dirs[d][2];
          const k = nx + "," + ny + "," + nz;
          if (reachable.has(k)) continue;
          const colSet = colMap.get(nx + "," + nz);
          const isWater = slotMap.has(k);
          const blocked = colSet && colSet.has(ny) && !isWater;
          if (blocked) continue;
          reachable.add(k);
          cells.push([nx, ny, nz]);
          queue.push([nx, ny, nz]);
        }
      }

      // Count current water volume in the reachable region.
      let V = 0;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (slotMap.has(c[0] + "," + c[1] + "," + c[2])) V++;
      }
      if (V === 0) return;

      // Sort reachable cells by Y ascending; lowest V become water.
      cells.sort((a, b) => {
        if (a[1] !== b[1]) return a[1] - b[1];
        if (a[0] !== b[0]) return a[0] - b[0];
        return a[2] - b[2];
      });
      const newWater = new Set<string>();
      for (let i = 0; i < V; i++) {
        const c = cells[i];
        newWater.add(c[0] + "," + c[1] + "," + c[2]);
      }

      // Diff against current water in region.
      const toRemove: string[] = [];
      const toAdd: string[] = [];
      for (const k of reachable) {
        const isCurrent = slotMap.has(k);
        const isFuture = newWater.has(k);
        if (isCurrent && !isFuture) toRemove.push(k);
        else if (!isCurrent && isFuture) toAdd.push(k);
      }
      if (toRemove.length === 0 && toAdd.length === 0) return;

      const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      for (const k of toRemove) {
        const slot = slotMap.get(k)!;
        waterMesh.setMatrixAt(slot, zeroMat);
        freeSlots.push(slot);
        slotMap.delete(k);
        const parts = k.split(",");
        colMap.get(parts[0] + "," + parts[2])?.delete(+parts[1]);
      }
      for (const k of toAdd) {
        const slot = freeSlots.pop();
        if (slot === undefined) break;
        const parts = k.split(",");
        const x = +parts[0], y = +parts[1], z = +parts[2];
        dummy.position.set((x - cxRound) * voxel, y * voxel, (z - czRound) * voxel);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        waterMesh.setMatrixAt(slot, dummy.matrix);
        slotMap.set(k, slot);
        let s = colMap.get(x + "," + z);
        if (!s) { s = new Set<number>(); colMap.set(x + "," + z, s); }
        s.add(y);
      }
      waterMesh.instanceMatrix.needsUpdate = true;
    };

    const tryPlace = () => {
      if (!carryState || !fp.isLocked) return;
      const target = getPlacementTarget();
      if (!target) return;
      if (placeAt(target.vx, target.vy, target.vz)) {
        carryState = null;
        ghostMesh.visible = false;
        setCarryLayer(null);
        setMoves((m) => m + 1);
        settleWaterNear(target.vx, target.vy, target.vz);
      }
    };

    const returnCarry = () => {
      if (!carryState) return;
      placeAt(carryState.originVX, carryState.originVY, carryState.originVZ);
      carryState = null;
      ghostMesh.visible = false;
      setCarryLayer(null);
    };

    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
    renderer.domElement.addEventListener("mousedown", (ev: MouseEvent) => {
      if (!fp.isLocked) return;
      if (ev.button === 2) { returnCarry(); return; }
      if (ev.button !== 0) return;
      if (carryState) tryPlace();
      else tryPickup();
    });
    renderer.domElement.addEventListener("mouseup", (ev: MouseEvent) => {
      if (ev.button === 0 && chargeState) cancelCharge();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.code] = true;
      if (e.code === "KeyF" && !fp.isLocked) enterWalkRef.current();
      if (e.code === "Escape" && fp.isLocked) fp.unlock();
      if (e.code === "KeyG" && fp.isLocked) returnCarry();
      if (e.code === "Space" && fp.isLocked && Math.abs(velocityYRef.current) < 0.01) {
        velocityYRef.current = JUMP_VELOCITY;
      }
      if (e.code === "KeyE" && fp.isLocked && carryState && carryState.layer === "fruit") {
        // Eat: carried fruit is consumed — STOCKPILE → VOID, satiation up.
        carryState = null;
        ghostMesh.visible = false;
        setCarryLayer(null);
        satiationRef.current += 1;
        setSatiation(satiationRef.current);
        ledgerMove("stockpile", "void", 1, "user", "fruit");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.code] = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // ─── Conservation ledger init ─────────────────────────────────────────
    // Authoritative recount once the world is fully built: WORLD = every
    // visible + occlusion-hidden block. Saved pools (void/built/stockpile)
    // restore from meta; fresh scans seed a small void reserve so organic
    // growth has matter to draw from. Overwrites any moves queued during
    // build (populateFromSaved etc.) so nothing double-counts.
    {
      let totalWorld = 0;
      for (const m of meshesRef.current) {
        totalWorld += ((m.userData?.slotMap as Map<string, number>)?.size || 0) + ((m.userData?.hiddenMap as Map<string, number>)?.size || 0);
      }
      const savedLedger = (((worldDataRef.current?.meta as any)?.ledger) || {}) as Record<string, unknown>;
      const hasSaved = typeof savedLedger.void === "number";
      const vPool = hasSaved ? (savedLedger.void as number) : Math.round(totalWorld * 0.02);
      const bPool = typeof savedLedger.built === "number" ? (savedLedger.built as number) : 0;
      const sPool = typeof savedLedger.stockpile === "number" ? (savedLedger.stockpile as number) : 0;
      ledgerRef.current = { world: totalWorld, stockpile: sPool, built: bPool, void: vPool, baseline: totalWorld + sPool + bPool + vPool };
      stockpileByLayerRef.current = {};
      pendingEventsRef.current.clear();
      setLedger({ ...ledgerRef.current });
    }

    // ─── Void creatures (Chunk 3): night wraiths that erode weak edges ─────
    // No pathfinding — they hover and drift toward targets. Spawn at the
    // lowest-protection perimeter cells during active/aggressive void phases
    // (caps: aggressive 3, active 1, passive 0 → despawn at dawn). They eat
    // the top block of their cell via removeBlockFrom(...,"void_creature"),
    // so every bite is ledger-conserving (world → void). Eat rate slows with
    // local protection; strong protection repels them back to weak ground.
    type VoidCreature = {
      vx: number; vz: number;
      tx: number; tz: number;
      group: any;
      lastEatMs: number;
      eaten: number;
      bobPhase: number;
    };
    const voidCreatures: VoidCreature[] = [];
    let voidEatenTotal = 0;
    let lastVoidTickMs = 0;
    let lastVoidUiMs = 0;
    const __seasonName = String((weatherData as any)?.season || "").toLowerCase();
    const VOID_SEASON_MULT = __seasonName.includes("winter") ? 1.25 : (__seasonName.includes("fall") || __seasonName.includes("autumn")) ? 1.1 : __seasonName.includes("summer") ? 0.9 : 1;

    let voidPerimCache: { picks: Array<{ vx: number; vz: number; p: number }>; median: number; at: number } = { picks: [], median: 1, at: -Infinity };
    const weakestPerimeter = (n: number, now = performance.now()) => {
      if (now - voidPerimCache.at > 5000 || voidPerimCache.picks.length < n) {
        const perim: Array<{ vx: number; vz: number }> = [];
        // removeCol can leave empty Sets behind in colMap ("ghost columns") —
        // skip them or creatures chase cells with nothing left to eat.
        const hasBlocks = (key: string) => {
          const s = colMap.get(key);
          return !!s && s.size > 0;
        };
        for (const k of colMap.keys()) {
          if (!hasBlocks(k)) continue;
          const parts = k.split(",");
          const vx = +parts[0], vz = +parts[1];
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!hasBlocks((vx + dx) + "," + (vz + dz))) { perim.push({ vx, vz }); break; }
          }
        }
        const scored: Array<{ vx: number; vz: number; p: number }> = [];
        const stride = Math.max(1, Math.floor(perim.length / 400));
        for (let i = 0; i < perim.length; i += stride) {
          scored.push({ vx: perim[i].vx, vz: perim[i].vz, p: protectionAt(perim[i].vx, perim[i].vz) });
        }
        scored.sort((a, b) => a.p - b.p);
        const median = scored.length > 0 ? scored[Math.floor(scored.length / 2)].p : 1;
        voidPerimCache = { picks: scored.slice(0, Math.max(n, 6)), median, at: now };
      }
      return voidPerimCache;
    };

    const makeVoidBody = () => {
      const group = new THREE.Group();
      const matVoid = new THREE.MeshPhongMaterial({ color: 0x12081f, shininess: 40, transparent: true, opacity: 0.92 });
      const matEye = new THREE.MeshBasicMaterial({ color: 0xff00ff });
      const body = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.6, voxel * 0.8, voxel * 0.6), matVoid);
      body.rotation.y = Math.PI / 4;
      const eye = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.65, voxel * 0.08, voxel * 0.08), matEye);
      eye.position.y = voxel * 0.18;
      const shardGeo = new THREE.OctahedronGeometry(voxel * 0.16);
      for (let i = 0; i < 3; i++) {
        const shard = new THREE.Mesh(shardGeo, new THREE.MeshBasicMaterial({ color: 0x8a2be2, transparent: true, opacity: 0.7 }));
        shard.position.set(Math.cos(i * 2.1) * voxel * 0.55, voxel * (0.1 + 0.25 * i), Math.sin(i * 2.1) * voxel * 0.55);
        group.add(shard);
      }
      const vBeacon = new THREE.Mesh(
        new THREE.CylinderGeometry(voxel * 0.06, voxel * 0.06, voxel * 30, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x8a2be2, transparent: true, opacity: 0.25, depthWrite: false }),
      );
      vBeacon.position.y = voxel * 15;
      group.add(body);
      group.add(eye);
      group.add(vBeacon);
      return group;
    };

    const spawnVoidCreature = (vx: number, vz: number) => {
      const group = makeVoidBody();
      scene.add(group);
      const c: VoidCreature = { vx, vz, tx: vx, tz: vz, group, lastEatMs: performance.now(), eaten: 0, bobPhase: Math.random() * Math.PI * 2 };
      voidCreatures.push(c);
      console.log("[tinyworld] void creature spawned at", vx, vz);
      return c;
    };
    const despawnVoidCreature = (c: VoidCreature) => {
      scene.remove(c.group);
      const i = voidCreatures.indexOf(c);
      if (i >= 0) voidCreatures.splice(i, 1);
    };

    const VOID_TICK_MS = 1000;
    const VOID_EAT_BASE_MS = 6000;
    const tickVoidCreatures = (now: number) => {
      const phase = voidPhaseNow();
      const cap = phase === "aggressive" ? 3 : phase === "active" ? 1 : 0;
      while (voidCreatures.length > cap) despawnVoidCreature(voidCreatures[voidCreatures.length - 1]);
      if (cap > 0) {
        const { picks, median } = weakestPerimeter(cap, now);
        if (voidCreatures.length < cap && picks.length > 0) {
          const pick = picks[voidCreatures.length % picks.length];
          spawnVoidCreature(pick.vx, pick.vz);
        }
        const repelThreshold = Math.max(0.5, median * 2.5);
        for (const c of voidCreatures) {
          // Frame-rate independent drift: step toward target each 1s tick
          // (render fps can be 1 in headless tabs — never move per-frame).
          const ddx = c.tx - c.vx, ddz = c.tz - c.vz;
          const dist = Math.hypot(ddx, ddz);
          if (dist > 0.01) {
            const step = Math.min(dist, 2.0);
            c.vx += (ddx / dist) * step;
            c.vz += (ddz / dist) * step;
          }
          // Armed bombs are concentrated mass — creatures hunt them (§9.4
          // bait), and a bite strikes the slug, which Returns. Detonation can
          // dissipate creatures mid-iteration, so bail out of this tick.
          const nearBomb = bombs.find((b) => Math.hypot(b.vx - c.vx, b.vz - c.vz) < 14);
          if (nearBomb) {
            if (Math.hypot(nearBomb.vx - c.vx, nearBomb.vz - c.vz) < 1.3) {
              detonate(nearBomb, new Set());
              break;
            }
            c.tx = nearBomb.vx;
            c.tz = nearBomb.vz;
          }
          const cx = Math.round(c.vx), cz = Math.round(c.vz);
          const prot = protectionAt(cx, cz);
          if (prot > repelThreshold && picks.length > 0) {
            const pick = picks[Math.floor(Math.random() * picks.length)];
            c.tx = pick.vx;
            c.tz = pick.vz;
          } else if (Math.hypot(c.tx - c.vx, c.tz - c.vz) < 0.4) {
            // Protection slows eating relative to the perimeter median, so the
            // absolute magnitude of the field doesn't matter — weakest cells
            // get bitten every ~6s, median-protected cells every ~24s.
            const relProt = median > 0 ? prot / median : 1;
            const eatMs = (VOID_EAT_BASE_MS * (1 + 3 * relProt)) / VOID_SEASON_MULT;
            if (now - c.lastEatMs > eatMs) {
              let ate = false;
              const vtop = colTop(cx, cz);
              if (vtop !== null) {
                const slotKey = cx + "," + vtop + "," + cz;
                for (const m of meshesRef.current) {
                  if (m.userData?.slotMap?.has(slotKey)) {
                    if (removeBlockFrom(m, cx, vtop, cz, "void_creature")) {
                      syncGroundAfterRemove(cx, vtop, cz, m.userData.layer);
                      c.eaten += 1;
                      voidEatenTotal += 1;
                      ate = true;
                    }
                    break;
                  }
                }
              }
              // Always reset the timer; a failed bite (hidden/exhausted column)
              // retargets instead of stalling forever.
              c.lastEatMs = now;
              if (!ate && picks.length > 0) {
                const pick = picks[Math.floor(Math.random() * picks.length)];
                c.tx = pick.vx;
                c.tz = pick.vz;
              }
            }
          }
        }
      }
      if (now - lastVoidUiMs > 1000) {
        lastVoidUiMs = now;
        setVoidUi({ phase, creatures: voidCreatures.length, eaten: voidEatenTotal });
      }
    };

    const renderVoidCreatures = (now: number) => {
      for (const c of voidCreatures) {
        const cx = Math.round(c.vx), cz = Math.round(c.vz);
        const vtop = colTop(cx, cz);
        const hoverY = ((vtop ?? 0) + 2.1) * voxel + Math.sin(now * 0.0022 + c.bobPhase) * voxel * 0.35;
        c.group.position.set((c.vx - cxRound) * voxel, hoverY, (c.vz - czRound) * voxel);
        c.group.rotation.y = now * 0.0009 + c.bobPhase;
      }
    };

    // ─── Scan economy + press (Chunk 4) ─────────────────────────────────────
    // Scanning new land is the ONLY legitimate baseline increase — fresh
    // matter enters the conservation ledger via a `scan` block_event.
    // Material rolls are mostly raw loam/stone; rare pure metal veins and
    // very rare core blocks (docs/mass-and-density.md §9.3). The press
    // compresses 4 stockpiled blocks of a tier into 1 of the next
    // (4×d → 1×4d): mass conserved exactly, block COUNT drops by 3, so the
    // block-count baseline drops with it via a `compress` event.
    const scanDirtMesh = makeGrowable(PAL.dirt, 3072, "dirt");
    const scanGrassMesh = makeGrowable(PAL.grass, 1536, "grass");
    const stoneMesh = makeGrowable(0x6e7178, 1024, "stone");
    const metalMesh = makeGrowable(0x9fb4c0, 384, "metal");
    const densiumMesh = makeGrowable(0x4b2e6f, 96, "densium");
    const coreScanMesh = makeGrowable(0xffd75e, 16, "core");
    const blockGrades = new Map<string, "raw" | "worked" | "pure">();

    // Restore saved scan-economy layers — snapshotLiveLayers persists them
    // under their layer names but buildWorld's addLayer calls only rebuild
    // the original scan layers. spawnBlockInto drains VOID, and these blocks
    // were already part of the saved baseline, so compensate exactly like
    // scanNewLand does (void refund + baseline raise).
    {
      let restored = 0;
      const restoreMap: Array<[string, any]> = [["stone", stoneMesh], ["metal", metalMesh], ["densium", densiumMesh], ["core", coreScanMesh]];
      for (const [layerName, mesh] of restoreMap) {
        const rawArr = (layers as any)[layerName];
        if (!rawArr || !mesh) continue;
        const a = rawArr instanceof Int32Array ? rawArr : new Int32Array(rawArr);
        for (let i = 0; i < a.length; i += 3) {
          if (spawnBlockInto(mesh, a[i], a[i + 1], a[i + 2], "scan_restore")) restored++;
        }
      }
      if (restored > 0) {
        const L = ledgerRef.current as any;
        L.void += restored;
        L.baseline += restored;
        setLedger({ ...L });
        console.log("[tinyworld] restored", restored, "scan-economy blocks from save");
      }
    }

    const SCAN_REGEN_MS = 600000;
    const SCAN_CHARGE_CAP = 3;
    let scanCharge = (() => {
      if (typeof window === "undefined") return 1;
      const ov = new URLSearchParams(window.location.search).get("scancharge");
      return ov !== null ? Math.max(0, Math.min(99, parseInt(ov, 10) || 0)) : 1;
    })();
    let scanCount = 0;
    let lastChargeRegenMs = performance.now();
    let lastScanTickMs = 0;
    let lastScanUiSent = -1;
    const tickScan = (now: number) => {
      if (scanCharge < SCAN_CHARGE_CAP && now - lastChargeRegenMs > SCAN_REGEN_MS) {
        scanCharge += 1;
        lastChargeRegenMs = now;
      }
      if (scanCharge !== lastScanUiSent) {
        lastScanUiSent = scanCharge;
        setScanUi({ charge: scanCharge, scans: scanCount });
      }
    };

    const scanNewLand = () => {
      if (scanCharge < 1) return { ok: false, reason: "no scan charge" };
      const colHasBlocks = (key: string) => {
        const s = colMap.get(key);
        return !!s && s.size > 0;
      };
      // Anchor on a random perimeter column with an open side. Prefer true
      // outer edges: probe outward — interior notches (1-cell holes also have
      // "open sides") produce cramped patches, so they're only a fallback.
      const keys = Array.from(colMap.keys());
      let anchor: { x: number; z: number } | null = null;
      let dir: [number, number] = [1, 0];
      let fallback: { a: { x: number; z: number }; d: [number, number] } | null = null;
      for (let tries = 0; tries < 300 && !anchor; tries++) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        if (!colHasBlocks(k)) continue;
        const parts = k.split(",");
        const x = +parts[0], z = +parts[1];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (colHasBlocks((x + dx) + "," + (z + dz))) continue;
          let freeOut = 0;
          for (let probe = 1; probe <= 5; probe++) {
            if (!colHasBlocks((x + dx * probe) + "," + (z + dz * probe))) freeOut++;
          }
          if (freeOut >= 4) {
            anchor = { x, z };
            dir = [dx, dz];
          } else if (!fallback) {
            fallback = { a: { x, z }, d: [dx, dz] };
          }
          break;
        }
      }
      if (!anchor && fallback) {
        anchor = fallback.a;
        dir = fallback.d;
      }
      if (!anchor) return { ok: false, reason: "no open edge found" };
      const baseY = colTop(anchor.x, anchor.z) ?? 0;
      const perp: [number, number] = [-dir[1], dir[0]];
      const D = 8 + Math.floor(Math.random() * 4);
      const HALF_W = 5 + Math.floor(Math.random() * 2);
      // Collect target cells with gentle height noise.
      const cells: Array<{ x: number; z: number; h: number }> = [];
      for (let out = 1; out <= D; out++) {
        for (let lat = -HALF_W; lat <= HALF_W; lat++) {
          if (Math.abs(lat) === HALF_W && Math.random() < 0.5) continue;
          const x = anchor.x + dir[0] * out + perp[0] * lat;
          const z = anchor.z + dir[1] * out + perp[1] * lat;
          if (colHasBlocks(x + "," + z)) continue;
          const h = baseY + (Math.random() < 0.22 ? (Math.random() < 0.5 ? -1 : 1) : 0);
          cells.push({ x, z, h });
        }
      }
      if (cells.length === 0) return { ok: false, reason: "edge had no room" };
      // Material rolls: rare pure-metal vein, very rare core find.
      const veinCells = new Set<number>();
      if (Math.random() < 0.18) {
        const veinSize = 4 + Math.floor(Math.random() * 4);
        const start = Math.floor(Math.random() * cells.length);
        for (let i = 0; i < veinSize; i++) veinCells.add((start + i) % cells.length);
      }
      const coreIdx = Math.random() < 0.03 ? Math.floor(Math.random() * cells.length) : -1;
      let added = 0;
      let veinBlocks = 0;
      let coreFound = false;
      for (let i = 0; i < cells.length; i++) {
        const { x, z, h } = cells[i];
        let deepMesh = stoneMesh;
        if (i === coreIdx) deepMesh = coreScanMesh;
        else if (veinCells.has(i)) deepMesh = metalMesh;
        if (deepMesh && spawnBlockInto(deepMesh, x, h - 2, z, "scan")) {
          added++;
          if (deepMesh === metalMesh) {
            blockGrades.set(x + "," + (h - 2) + "," + z, "pure");
            veinBlocks++;
          } else if (deepMesh === coreScanMesh) {
            coreFound = true;
          }
        }
        if (spawnBlockInto(scanDirtMesh, x, h - 1, z, "scan")) added++;
        const topMesh = Math.random() < 0.5 ? scanGrassMesh : scanDirtMesh;
        const topLayer = topMesh === scanGrassMesh ? "grass" : "dirt";
        if (topMesh && spawnBlockInto(topMesh, x, h, z, "scan")) {
          added++;
          syncGroundAfterPlace(x, h, z, topLayer);
        }
      }
      if (added === 0) return { ok: false, reason: "no blocks spawned (capacity?)" };
      // spawnBlockInto moved `added` from VOID→WORLD; scans mint NEW matter,
      // so refund the reservoir and raise the baseline — the one legit way.
      const L = ledgerRef.current as any;
      L.void += added;
      L.baseline += added;
      queueBlockEvent("scan", added, "scan_land");
      setLedger({ ...L });
      scanCharge -= 1;
      scanCount += 1;
      setScanUi({ charge: scanCharge, scans: scanCount });
      console.log("[tinyworld] scanned new land:", added, "blocks at", anchor.x, anchor.z, veinBlocks ? "(pure metal vein ×" + veinBlocks + ")" : "", coreFound ? "(CORE FOUND)" : "");
      return { ok: true, added, anchor, veinBlocks, coreFound };
    };

    const PRESS_LADDER: Record<string, string> = { dirt: "stone", stone: "metal", metal: "densium", densium: "core" };
    const pressCompress = (layer: string) => {
      const next = PRESS_LADDER[layer];
      if (!next) return { ok: false, reason: layer + " is not compressible" };
      const sp = stockpileByLayerRef.current;
      const have = sp[layer] || 0;
      if (have < 4) return { ok: false, reason: "need 4 stockpiled " + layer + ", have " + have };
      sp[layer] = have - 4;
      sp[next] = (sp[next] || 0) + 1;
      const L = ledgerRef.current as any;
      L.stockpile -= 3;
      L.baseline -= 3;
      queueBlockEvent("compress", 3, "press_" + layer);
      setLedger({ ...L });
      console.log("[tinyworld] press: 4×" + layer + " → 1×" + next);
      return { ok: true, from: layer, to: next, stockpile: { ...sp } };
    };

    // ─── Keel core ships (Chunk 5) ──────────────────────────────────────────
    // A keel is a core taught to move (docs/mass-and-density.md §8). Building
    // a ship binds 1 core + 8 stone hull from STOCKPILE into BUILT. Flight
    // burns hull mass into the void (1 block per 6 cells — flight feeds the
    // void), so every expedition has a real bill. Out of fuel = stranded.
    // The pilot is autopilot for now (stands in for a Tiny Person pilot).
    type Ship = {
      x: number; z: number;
      tx: number; tz: number;
      flying: boolean;
      fuel: number;
      cellsSinceBurn: number;
      group: any;
    };
    const ships: Ship[] = [];
    const SHIP_HULL_STONE = 8;
    const SHIP_SPEED = 1.5;
    const SHIP_CELLS_PER_BURN = 6;

    const makeShipBody = () => {
      const group = new THREE.Group();
      const matHull = new THREE.MeshPhongMaterial({ color: 0x3b3f4a, shininess: 30 });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(voxel * 2.2, voxel * 0.3, voxel * 1.4), matHull);
      const prow = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.6, voxel * 0.25, voxel * 0.8), matHull);
      prow.position.set(voxel * 1.3, 0, 0);
      const keel = new THREE.Mesh(
        new THREE.OctahedronGeometry(voxel * 0.5),
        new THREE.MeshBasicMaterial({ color: 0xffd75e }),
      );
      keel.position.y = -voxel * 0.45;
      const sBeacon = new THREE.Mesh(
        new THREE.CylinderGeometry(voxel * 0.07, voxel * 0.07, voxel * 35, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.28, depthWrite: false }),
      );
      sBeacon.position.y = voxel * 17;
      group.add(deck); group.add(prow); group.add(keel); group.add(sBeacon);
      return group;
    };

    const buildShip = (vx?: number, vz?: number) => {
      const sp = stockpileByLayerRef.current;
      if ((sp.core || 0) < 1) return { ok: false, reason: "need 1 stockpiled core (press summit or scan find)" };
      if ((sp.stone || 0) < SHIP_HULL_STONE) return { ok: false, reason: "need " + SHIP_HULL_STONE + " stockpiled stone for hull, have " + (sp.stone || 0) };
      ledgerMove("stockpile", "built", 1, "ship_build", "core");
      ledgerMove("stockpile", "built", SHIP_HULL_STONE, "ship_build", "stone");
      const x = typeof vx === "number" ? vx : cxRound;
      const z = typeof vz === "number" ? vz : czRound;
      const group = makeShipBody();
      scene.add(group);
      const ship: Ship = { x, z, tx: x, tz: z, flying: false, fuel: SHIP_HULL_STONE, cellsSinceBurn: 0, group };
      ships.push(ship);
      setShipUi({ count: ships.length, flying: ships.filter((s) => s.flying).length });
      console.log("[tinyworld] ship built at", x, z);
      return { ok: true, ship: { x, z, fuel: ship.fuel } };
    };

    const flyShip = (tx: number, tz: number, idx = 0) => {
      const ship = ships[idx];
      if (!ship) return { ok: false, reason: "no ship " + idx };
      if (ship.fuel < 1) return { ok: false, reason: "stranded — no hull mass left to burn" };
      ship.tx = tx;
      ship.tz = tz;
      ship.flying = true;
      setShipUi({ count: ships.length, flying: ships.filter((s) => s.flying).length });
      return { ok: true, eta: Math.ceil(Math.hypot(tx - ship.x, tz - ship.z) / SHIP_SPEED) + "s" };
    };

    const scrapShip = (idx = 0) => {
      const ship = ships[idx];
      if (!ship) return { ok: false, reason: "no ship " + idx };
      ledgerMove("built", "stockpile", 1, "ship_scrap", "core");
      if (ship.fuel > 0) ledgerMove("built", "stockpile", ship.fuel, "ship_scrap", "stone");
      scene.remove(ship.group);
      ships.splice(idx, 1);
      setShipUi({ count: ships.length, flying: ships.filter((s) => s.flying).length });
      return { ok: true, recovered: { core: 1, stone: ship.fuel } };
    };

    let lastShipTickMs = 0;
    const tickShips = (now: number) => {
      let uiDirty = false;
      for (const ship of ships) {
        if (!ship.flying) continue;
        const dx = ship.tx - ship.x, dz = ship.tz - ship.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.5) {
          ship.flying = false;
          uiDirty = true;
          console.log("[tinyworld] ship arrived at", Math.round(ship.x), Math.round(ship.z));
          continue;
        }
        const step = Math.min(dist, SHIP_SPEED);
        ship.x += (dx / dist) * step;
        ship.z += (dz / dist) * step;
        ship.cellsSinceBurn += step;
        if (ship.cellsSinceBurn >= SHIP_CELLS_PER_BURN) {
          ship.cellsSinceBurn -= SHIP_CELLS_PER_BURN;
          ship.fuel -= 1;
          ledgerMove("built", "void", 1, "ship_burn");
          if (ship.fuel < 1) {
            ship.flying = false;
            uiDirty = true;
            console.log("[tinyworld] ship stranded at", Math.round(ship.x), Math.round(ship.z), "— hull burned out");
          }
        }
      }
      if (uiDirty) setShipUi({ count: ships.length, flying: ships.filter((s) => s.flying).length });
    };

    const renderShips = (now: number) => {
      for (const ship of ships) {
        const cx = Math.round(ship.x), cz = Math.round(ship.z);
        const stop = colTop(cx, cz);
        const hoverY = ((stop ?? 0) + 4) * voxel + Math.sin(now * 0.0015) * voxel * 0.25;
        ship.group.position.set((ship.x - cxRound) * voxel, hoverY, (ship.z - czRound) * voxel);
        if (ship.flying) {
          ship.group.rotation.y = Math.atan2(-(ship.tz - ship.z), ship.tx - ship.x);
        }
      }
    };

    // ─── The Return — unstable slugs and bombs (Chunk 5b, §9.4) ───────────
    // The press accepts raw matter; the imperfections store strain. A slug is
    // press math with the output flagged unstable instead of stockpiled.
    // Detonation cascades the slug back down the ladder — 4 raw blocks rain
    // out per slug, the exact inverse of the compress that made it, so the
    // baseline returns to where it started. The shockwave reuses the
    // protection law (force = strain/(1+d²) ≥ density) to shake top blocks
    // loose as net-zero rescatter: nothing destroyed, everything disordered.
    // Creatures in radius dissipate (their bound mass returns void → world),
    // and bombs inside a blast also Return — chains.
    type Bomb = { vx: number; vz: number; size: number; tier: string; group: any };
    const bombs: Bomb[] = [];
    let detonationsTotal = 0;
    const DOWN_LADDER: Record<string, string> = { stone: "dirt", metal: "stone", densium: "metal", core: "densium" };

    const meshWithRoom = (layerName: string) => {
      for (const m of meshesRef.current) {
        if (m.userData?.layer === layerName && (m.userData?.freeSlots?.length || 0) > 0) return m;
      }
      return null;
    };

    const updateBombUi = () => {
      let slugCount = 0;
      const sp = stockpileByLayerRef.current as any;
      for (const k in sp) if (k.startsWith("slug_")) slugCount += sp[k];
      setBombUi({ slugs: slugCount, bombs: bombs.length, detonations: detonationsTotal });
    };

    const makeSlug = (layer: string) => {
      const next = PRESS_LADDER[layer];
      if (!next) return { ok: false, reason: layer + " is not compressible" };
      const sp = stockpileByLayerRef.current as any;
      const have = sp[layer] || 0;
      if (have < 4) return { ok: false, reason: "need 4 stockpiled " + layer + ", have " + have };
      sp[layer] = have - 4;
      sp["slug_" + next] = (sp["slug_" + next] || 0) + 1;
      const L = ledgerRef.current as any;
      L.stockpile -= 3;
      L.baseline -= 3;
      queueBlockEvent("compress", 3, "slug_" + layer);
      setLedger({ ...L });
      updateBombUi();
      console.log("[tinyworld] slug pressed: 4×" + layer + " → 1 unstable " + next);
      return { ok: true, slug: next, slugs: sp["slug_" + next] };
    };

    const makeBombBody = (size: number) => {
      const group = new THREE.Group();
      const matSlug = new THREE.MeshPhongMaterial({ color: 0x1a1126, shininess: 60 });
      const matFuse = new THREE.MeshBasicMaterial({ color: 0xffb02e });
      const side = size >= 27 ? 3 : size >= 8 ? 2 : 1;
      const s = voxel * 0.4;
      for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) for (let z = 0; z < side; z++) {
        const cube = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), matSlug);
        cube.position.set((x - (side - 1) / 2) * s * 1.1, y * s * 1.1, (z - (side - 1) / 2) * s * 1.1);
        group.add(cube);
      }
      const fuse = new THREE.Mesh(new THREE.OctahedronGeometry(voxel * 0.18), matFuse);
      fuse.position.y = side * s * 1.1 + voxel * 0.2;
      group.add(fuse);
      return group;
    };

    const placeBomb = (vx: number, vz: number, size: number, tier = "stone") => {
      if (size !== 1 && size !== 8 && size !== 27) return { ok: false, reason: "size must be 1, 8 or 27" };
      const sp = stockpileByLayerRef.current as any;
      const have = sp["slug_" + tier] || 0;
      if (have < size) return { ok: false, reason: "need " + size + " " + tier + " slugs, have " + have };
      sp["slug_" + tier] = have - size;
      // slug_ keys live outside ledgerMove's per-layer bookkeeping, so move
      // the aggregate only.
      ledgerMove("stockpile", "built", size, "bomb_place");
      const group = makeBombBody(size);
      const top = colTop(Math.round(vx), Math.round(vz));
      group.position.set((vx - cxRound) * voxel, ((top ?? 0) + 1.4) * voxel, (vz - czRound) * voxel);
      scene.add(group);
      bombs.push({ vx, vz, size, tier, group });
      updateBombUi();
      return { ok: true, vx, vz, size, tier, strain: size };
    };

    const detonate = (bomb: Bomb, visited: Set<Bomb>): any => {
      if (visited.has(bomb)) return null;
      visited.add(bomb);
      const bi = bombs.indexOf(bomb);
      if (bi < 0) return null;
      bombs.splice(bi, 1);
      scene.remove(bomb.group);
      const { vx, vz, size, tier } = bomb;
      const L = ledgerRef.current as any;
      const strain = size;
      const rMax = 2 + Math.cbrt(size);

      // 1. Decompression — each slug cascades a tier down: 4 raw blocks out.
      // built → void for the slugs, then spawn 4×size (void → world each);
      // mint the +3×size count difference exactly like scanNewLand, which
      // cancels the −3/slug the press took when the slug was made.
      const down = DOWN_LADDER[tier] || "dirt";
      ledgerMove("built", "void", size, "detonate");
      let spawnedRaw = 0;
      const want = size * 4;
      for (let attempt = 0; attempt < want * 12 && spawnedRaw < want; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = 1 + Math.random() * rMax;
        const sx = Math.round(vx + Math.cos(ang) * rad);
        const sz = Math.round(vz + Math.sin(ang) * rad);
        const sy = (colTop(sx, sz) ?? -1) + 1;
        const m = meshWithRoom(down);
        if (!m) break;
        if (spawnBlockInto(m, sx, sy, sz, "detonate")) {
          syncGroundAfterPlace(sx, sy, sz, down);
          spawnedRaw++;
        }
      }
      const mint = Math.max(0, spawnedRaw - size);
      if (mint > 0) {
        L.void += mint;
        L.baseline += mint;
        queueBlockEvent("detonate", mint, "bomb_" + tier);
      }

      // 2. Shockwave — crack the top block of every column where incident
      // force ≥ its density; remove + rescatter just outside the radius
      // (world→void then void→world: net-zero, disorder not destruction).
      const blastR = Math.ceil(Math.sqrt(Math.max(0, strain / 0.25 - 1)));
      let cracked = 0;
      for (let dx = -blastR; dx <= blastR; dx++) {
        for (let dz = -blastR; dz <= blastR; dz++) {
          const force = strain / (1 + dx * dx + dz * dz);
          const bx = Math.round(vx) + dx, bz = Math.round(vz) + dz;
          const btop = colTop(bx, bz);
          if (btop === null) continue;
          const bkey = bx + "," + btop + "," + bz;
          let bmesh: any = null;
          for (const m of meshesRef.current) if (m.userData?.slotMap?.has(bkey)) { bmesh = m; break; }
          if (!bmesh) continue;
          const blayer = bmesh.userData.layer as string;
          if (force < densityOf(blayer)) continue;
          if (removeBlockFrom(bmesh, bx, btop, bz, "detonate")) {
            syncGroundAfterRemove(bx, btop, bz, blayer);
            for (let a = 0; a < 10; a++) {
              const ang = Math.random() * Math.PI * 2;
              const rad = blastR + 1 + Math.random() * 3;
              const sx = Math.round(vx + Math.cos(ang) * rad);
              const sz = Math.round(vz + Math.sin(ang) * rad);
              const sy = (colTop(sx, sz) ?? -1) + 1;
              const m2 = meshWithRoom(blayer) || bmesh;
              if (spawnBlockInto(m2, sx, sy, sz, "detonate")) {
                syncGroundAfterPlace(sx, sy, sz, blayer);
                cracked++;
                break;
              }
            }
          }
        }
      }

      // 3. The Return un-makes the void's only ordered things — creatures in
      // radius dissipate, their bound stolen mass scattering back void→world.
      let dissipated = 0, massReturned = 0;
      for (const c of [...voidCreatures]) {
        if (Math.hypot(c.vx - vx, c.vz - vz) > blastR + 2) continue;
        for (let g = 0; g < c.eaten; g++) {
          for (let a = 0; a < 8; a++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = 1 + Math.random() * rMax;
            const sx = Math.round(c.vx + Math.cos(ang) * rad);
            const sz = Math.round(c.vz + Math.sin(ang) * rad);
            const sy = (colTop(sx, sz) ?? -1) + 1;
            const m = meshWithRoom("dirt");
            if (m && spawnBlockInto(m, sx, sy, sz, "detonate")) {
              syncGroundAfterPlace(sx, sy, sz, "dirt");
              massReturned++;
              break;
            }
          }
        }
        despawnVoidCreature(c);
        dissipated++;
      }

      // 4. Chain reactions — slugs inside a blast also Return.
      let chained = 0;
      for (const other of [...bombs]) {
        if (visited.has(other)) continue;
        const od2 = (other.vx - vx) ** 2 + (other.vz - vz) ** 2;
        if (strain / (1 + od2) >= 1) {
          if (detonate(other, visited)) chained++;
        }
      }

      detonationsTotal++;
      setLedger({ ...L });
      updateBombUi();
      console.log("[tinyworld] RETURN: " + size + "-slug " + tier + " bomb — " + spawnedRaw + " raw " + down + " out, " + cracked + " cracked, " + dissipated + " creatures dissipated, " + chained + " chained");
      return { ok: true, size, tier, raw: spawnedRaw, cracked, dissipated, massReturned, chained };
    };

    // ─── Debug / test harness (window.__tw) ──────────────────────────────
    // Lets headless tests (and curious humans) inspect game state, measure
    // walk jitter, teleport, and simulate input without pointer lock.
    // Add ?debug=1 to the URL for an on-screen overlay.
    const __twSim = { walk: false };
    const __twSamples: Array<{ x: number; y: number; z: number }> = [];
    let __twFps = 0;
    let __twFpsCount = 0;
    let __twFpsLast = performance.now();
    const __twDebugEl = (() => {
      if (!location.search.includes("debug=1")) return null;
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,0.72);color:#00ffcc;font:11px monospace;padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre";
      document.body.appendChild(el);
      return el;
    })();
    const __twFrame = (now: number) => {
      __twFpsCount += 1;
      if (now - __twFpsLast >= 1000) {
        __twFps = __twFpsCount;
        __twFpsCount = 0;
        __twFpsLast = now;
      }
      __twSamples.push({ x: camera.position.x, y: camera.position.y, z: camera.position.z });
      if (__twSamples.length > 240) __twSamples.shift();
      if (__twDebugEl && (frameCount % 15) === 0) {
        const w0 = workers[0];
        __twDebugEl.textContent =
          "fps " + __twFps +
          " | cam " + camera.position.x.toFixed(2) + "," + camera.position.y.toFixed(2) + "," + camera.position.z.toFixed(2) +
          " | jitter " + (window as any).__tw.jitter().toFixed(4) +
          (w0 ? "\nworker " + w0.vx + "," + w0.vz + " " + w0.mode + (w0.plan ? " plan:" + w0.plan.name : "") : "\nworker: none");
      }
    };
    (window as any).__tw = {
      state: () => ({
        voxel,
        locked: fp.isLocked,
        fps: __twFps,
        cam: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        ground: sampleGround(camera.position.x, camera.position.z),
        blocks: colMap.size,
        workers: workers.map((w) => ({
          vx: w.vx, vz: w.vz, mode: w.mode,
          plan: w.plan ? w.plan.name : null,
          world: { x: w.worldX, y: w.worldY, z: w.worldZ },
          distFromCam: Math.hypot(w.worldX - camera.position.x, w.worldZ - camera.position.z),
        })),
      }),
      // Mean |Δy| per moving frame, in voxel units. Smooth walking ≈ < 0.02;
      // visible jitter shows up as > 0.1.
      jitter: () => {
        let sum = 0, n = 0;
        for (let i = 1; i < __twSamples.length; i++) {
          const a = __twSamples[i - 1], b = __twSamples[i];
          const horiz = Math.hypot(b.x - a.x, b.z - a.z);
          if (horiz < voxel * 0.01) continue;
          // Skip teleport-sized discontinuities — they're not walk jitter.
          if (horiz > voxel * 2 || Math.abs(b.y - a.y) > voxel * 3) continue;
          sum += Math.abs(b.y - a.y);
          n += 1;
        }
        return n === 0 ? 0 : sum / n / voxel;
      },
      teleport: (vx: number, vz: number) => {
        const wx = (vx - cxRound) * voxel;
        const wz = (vz - czRound) * voxel;
        const y = findSafeSpawnY(wx, wz);
        camera.position.set(wx, y === null ? sampleGround(wx, wz) + EYE_HEIGHT : y, wz);
        velocityYRef.current = 0;
        __twSamples.length = 0;
        return (window as any).__tw.state().cam;
      },
      gotoWorker: () => {
        const w = workers[0];
        if (!w) return null;
        return (window as any).__tw.teleport(w.vx + 3, w.vz + 3);
      },
      simWalk: (on: boolean) => { __twSim.walk = on; },
      press: (code: string, ms = 1000) => {
        keysRef.current[code] = true;
        setTimeout(() => { keysRef.current[code] = false; }, ms);
      },
      look: (yaw: number, pitch = 0) => {
        camera.rotation.set(pitch, yaw, 0, "YXZ");
      },
      ledger: () => {
        let actualWorld = 0;
        for (const m of meshesRef.current) {
          actualWorld += ((m.userData?.slotMap as Map<string, number>)?.size || 0) + ((m.userData?.hiddenMap as Map<string, number>)?.size || 0);
        }
        const L = ledgerRef.current;
        const sum = L.world + L.stockpile + L.built + L.void;
        return {
          ...L,
          sum,
          balanced: sum === L.baseline,
          actualWorld,
          worldDrift: actualWorld - L.world,
          stockpileByLayer: { ...stockpileByLayerRef.current },
          pendingEvents: Array.from(pendingEventsRef.current.entries()),
        };
      },
      protection: (vx: number, vz: number) => protectionAt(vx, vz),
      voidInfo: () => ({
        phase: voidPhaseNow(),
        seasonMult: VOID_SEASON_MULT,
        eatenTotal: voidEatenTotal,
        perimMedian: weakestPerimeter(1).median,
        creatures: voidCreatures.map((c) => ({ vx: c.vx, vz: c.vz, tx: c.tx, tz: c.tz, eaten: c.eaten })),
      }),
      spawnCreature: (vx?: number, vz?: number) => {
        if (typeof vx === "number" && typeof vz === "number") { spawnVoidCreature(vx, vz); return true; }
        const { picks } = weakestPerimeter(1);
        if (picks.length === 0) return false;
        spawnVoidCreature(picks[0].vx, picks[0].vz);
        return true;
      },
      clearCreatures: () => { while (voidCreatures.length > 0) despawnVoidCreature(voidCreatures[0]); },
      cellInfo: (vx: number, vz: number) => {
        const colSet = colMap.get(vx + "," + vz);
        const ys = colSet ? Array.from(colSet).sort((a: any, b: any) => a - b) : [];
        const top = ys.length > 0 ? ys[ys.length - 1] : null;
        const k = top !== null ? vx + "," + top + "," + vz : null;
        const inSlot: string[] = [];
        const inHidden: string[] = [];
        if (k !== null) {
          for (const m of meshesRef.current) {
            if ((m.userData?.slotMap as Map<string, number>)?.has(k)) inSlot.push(m.userData.layer);
            if ((m.userData?.hiddenMap as Map<string, number>)?.has(k)) inHidden.push(m.userData.layer);
          }
        }
        return { colYs: ys, top, inSlot, inHidden, prot: protectionAt(vx, vz) };
      },
      scan: () => scanNewLand(),
      scanInfo: () => ({ charge: scanCharge, cap: SCAN_CHARGE_CAP, scans: scanCount, regenMs: SCAN_REGEN_MS }),
      press: (layer: string) => pressCompress(layer),
      grade: (vx: number, vy: number, vz: number) => blockGrades.get(vx + "," + vy + "," + vz) || "raw",
      stock: (layer: string, n = 4) => {
        let moved = 0;
        for (const m of meshesRef.current) {
          if (m.userData?.layer !== layer) continue;
          const slotKeys = Array.from((m.userData.slotMap as Map<string, number>).keys());
          for (const k of slotKeys) {
            if (moved >= n) break;
            const parts = k.split(",");
            const sx = +parts[0], sy = +parts[1], sz = +parts[2];
            if (removeBlockFrom(m, sx, sy, sz, "tw_stock")) {
              ledgerMove("void", "stockpile", 1, "tw_stock", layer);
              syncGroundAfterRemove(sx, sy, sz, layer);
              moved++;
            }
          }
          if (moved >= n) break;
        }
        return { moved, stockpile: { ...stockpileByLayerRef.current } };
      },
      buildShip: (vx?: number, vz?: number) => buildShip(vx, vz),
      flyShip: (tx: number, tz: number, idx = 0) => flyShip(tx, tz, idx),
      scrapShip: (idx = 0) => scrapShip(idx),
      shipInfo: () => ships.map((s) => ({ x: s.x, z: s.z, tx: s.tx, tz: s.tz, flying: s.flying, fuel: s.fuel })),
      makeSlug: (layer: string) => makeSlug(layer),
      placeBomb: (vx: number, vz: number, size = 1, tier = "stone") => placeBomb(vx, vz, size, tier),
      detonate: (idx = 0) => (bombs[idx] ? detonate(bombs[idx], new Set()) : { ok: false, reason: "no bomb " + idx }),
      bombInfo: () => ({
        bombs: bombs.map((b) => ({ vx: b.vx, vz: b.vz, size: b.size, tier: b.tier })),
        slugs: Object.fromEntries(Object.entries(stockpileByLayerRef.current as any).filter(([k]) => k.startsWith("slug_"))),
        detonations: detonationsTotal,
      }),
    };

    let prev = performance.now();
    let frameCount = 0;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      frameCount += 1;
      const now = performance.now();
      tickOrganic(now);
      if (now - lastWorkerTickMs > 100) {
        tickWorkers(now);
        lastWorkerTickMs = now;
      }
      renderWorkers(now);
      if (now - lastVoidTickMs > VOID_TICK_MS) {
        tickVoidCreatures(now);
        lastVoidTickMs = now;
      }
      renderVoidCreatures(now);
      if (now - lastScanTickMs > 1000) {
        tickScan(now);
        lastScanTickMs = now;
      }
      if (now - lastShipTickMs > 1000) {
        tickShips(now);
        lastShipTickMs = now;
      }
      renderShips(now);
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;
      __twFrame(now);

      const tTime = now * 0.001;
      for (const marker of riftMarkersRef.current) {
        marker.rotation.y = tTime * 1.5;
        marker.rotation.x = tTime * 0.8;
        marker.children[0].rotation.z = tTime * -2.0;
        marker.children[0].scale.setScalar(1 + Math.sin(tTime * 4) * 0.2);
      }

      if (fp.isLocked || __twSim.walk) {
        const speed = MOVE_SPEED * dt;
        const oldX = camera.position.x;
        const oldZ = camera.position.z;
        const wasStuck = bodyBlockedAtY(oldX, camera.position.y, oldZ);
        // Diagonal speed normalization: W+D shouldn't be √2× faster than W.
        let inF = 0, inR = 0;
        if (keysRef.current["KeyW"]) inF += 1;
        if (keysRef.current["KeyS"]) inF -= 1;
        if (keysRef.current["KeyD"]) inR += 1;
        if (keysRef.current["KeyA"]) inR -= 1;
        const inLen = Math.hypot(inF, inR);
        if (inLen > 0) {
          fp.moveForward((inF / inLen) * speed);
          fp.moveRight((inR / inLen) * speed);
        }
        const newX = camera.position.x;
        const newZ = camera.position.z;
        if (!wasStuck) {
          if (isBlockedAt(newX, oldZ)) camera.position.x = oldX;
          if (isBlockedAt(camera.position.x, newZ)) camera.position.z = oldZ;
        }
        let recoveringFromStuck = false;
        if (wasStuck) {
          // Vertical push-up first (works for open scans with overhead clearance).
          for (let s = 0; s < 32 && bodyBlockedAtY(camera.position.x, camera.position.y, camera.position.z); s++) {
            camera.position.y += voxel * 0.5;
          }
          // Ceiling overhead? Minosoft corner-sample horizontal pushout: probe
          // 4 cardinal directions, pick the closest empty cell.
          if (bodyBlockedAtY(camera.position.x, camera.position.y, camera.position.z)) {
            const dirs: Array<[number, number]> = [[1,0],[-1,0],[0,1],[0,-1]];
            let bestX = camera.position.x, bestZ = camera.position.z, bestStep = Infinity;
            for (const [dx, dz] of dirs) {
              for (let s = 1; s <= 12; s++) {
                const tx = camera.position.x + dx * s * voxel * 0.5;
                const tz = camera.position.z + dz * s * voxel * 0.5;
                if (!bodyBlockedAtY(tx, camera.position.y, tz)) {
                  if (s < bestStep) { bestStep = s; bestX = tx; bestZ = tz; }
                  break;
                }
              }
            }
            camera.position.x = bestX;
            camera.position.z = bestZ;
          }
          velocityYRef.current = 0;
          recoveringFromStuck = true;
        }
        const groundY = sampleGround(camera.position.x, camera.position.z, camera.position.y - EYE_HEIGHT, playerR);
        const eye = groundY + EYE_HEIGHT;
        if (!recoveringFromStuck) {
          if (velocityYRef.current > 0 || camera.position.y > eye + voxel * 0.05) {
            // Airborne — full gravity, hard snap on landing (keeps jumps crisp).
            velocityYRef.current -= GRAVITY * dt;
            camera.position.y += velocityYRef.current * dt;
            if (camera.position.y < eye) {
              camera.position.y = eye;
              velocityYRef.current = 0;
            }
          } else {
            // Grounded — smooth step-up over ~80ms so 1-voxel ledges glide
            // instead of teleporting the camera.
            const lerp = Math.min(1, dt * 14);
            camera.position.y += (eye - camera.position.y) * lerp;
            if (Math.abs(eye - camera.position.y) < voxel * 0.02) {
              camera.position.y = eye;
            }
            velocityYRef.current = 0;
          }
        }

        // Progress ring (charging).
        if (chargeState) {
          const elapsed = now - chargeState.startMs;
          const pct = Math.min(1, elapsed / chargeState.hardMs);
          if (ring) {
            ring.style.setProperty("--p", String(pct * 100));
            ring.style.opacity = "1";
          }
          if (pct >= 1) completePickup();
        } else if (ring && ring.style.opacity !== "0") {
          ring.style.opacity = "0";
        }

        // Hover highlight (only when not carrying — ghost preview handles carry).
        // Throttled to every 3rd frame; uses the DDA grid march (cheap).
        if (!carryState) {
          if ((frameCount % 3) === 0) {
            const hit = marchRay();
            if (hit) {
              highlight.position.set((hit.vx - cxRound) * voxel, hit.vy * voxel, (hit.vz - czRound) * voxel);
              const lyr = (hit.mesh.userData?.layer as string) || "block";
              const hardness = MOVE_MS[lyr] ?? 500;
              if (!isFinite(hardness)) hlMat.color.setHex(0xe06868);
              else if (hardness >= 2500) hlMat.color.setHex(0x8a6bff);   // stone — heavy violet
              else if (hardness >= 1000) hlMat.color.setHex(0xa6b8ff);   // wood — light blue
              else hlMat.color.setHex(0xffeb6a);                          // soft — yellow
              highlight.visible = true;
            } else {
              highlight.visible = false;
            }
          }
        } else if (highlight.visible) {
          highlight.visible = false;
        }

        // Ghost preview — ONLY while carrying a block (shows landing spot).
        // No ghost is shown before pickup; the hover highlight covers that.
        if (carryState) {
          if ((frameCount % 2) === 0) {
            const hit = marchRay();
            let gvx: number, gvz: number;
            if (hit) {
              gvx = hit.vx;
              gvz = hit.vz;
            } else {
              const forward = new THREE.Vector3();
              camera.getWorldDirection(forward);
              const target = camera.position.clone().addScaledVector(forward, REACH * 0.6);
              gvx = Math.round(target.x / voxel) + cxRound;
              gvz = Math.round(target.z / voxel) + czRound;
            }
            const gtop = topAt(gvx, gvz);
            if (gtop !== null) {
              ghostMesh.position.set((gvx - cxRound) * voxel, (gtop + 1) * voxel, (gvz - czRound) * voxel);
              ghostMesh.visible = true;
            } else {
              ghostMesh.visible = false;
            }
          }
        } else if (ghostMesh.visible) {
          ghostMesh.visible = false;
        }
      } else {
        orbit.update();
        if (ring.style.opacity !== "0") ring.style.opacity = "0";
        if (ghostMesh.visible) ghostMesh.visible = false;
      }

      // ─── Tool rune bob + tether update ────────────────────────────────────
      {
        const t = performance.now() * 0.002;
        toolGroup.position.y = -voxel * 3.5 + Math.sin(t) * voxel * 0.18;
        toolGroup.rotation.y = 0.45 + Math.sin(t * 0.7) * 0.1;
        toolCore.scale.setScalar(1 + Math.sin(t * 1.8) * 0.12);

        let endPos: { x: number; y: number; z: number } | null = null;
        let opacity = 0;
        if (carryState) {
          endPos = { x: ghostMesh.position.x, y: ghostMesh.position.y, z: ghostMesh.position.z };
          opacity = 0.9;
        } else if (chargeState) {
          endPos = {
            x: (chargeState.vx - cxRound) * voxel,
            y: chargeState.vy * voxel,
            z: (chargeState.vz - czRound) * voxel,
          };
          const pct = Math.min(1, (performance.now() - chargeState.startMs) / chargeState.hardMs);
          opacity = pct * 0.9;
        }
        if (endPos && fp.isLocked) {
          const tw = new THREE.Vector3();
          toolCore.getWorldPosition(tw);
          const pos = tetherGeo.getAttribute("position") as THREE.BufferAttribute;
          pos.setXYZ(0, tw.x, tw.y, tw.z);
          pos.setXYZ(1, endPos.x, endPos.y, endPos.z);
          pos.needsUpdate = true;
          tetherMat.opacity = opacity;
          tetherLine.visible = true;

          const posIn = tetherInnerGeo.getAttribute("position") as THREE.BufferAttribute;
          posIn.setXYZ(0, tw.x, tw.y, tw.z);
          posIn.setXYZ(1, endPos.x, endPos.y, endPos.z);
          posIn.needsUpdate = true;
          // Bright inner pulses to read as living void-energy.
          const pulse = 0.55 + Math.sin(performance.now() * 0.012) * 0.25;
          tetherInnerMat.opacity = opacity * pulse;
          tetherInnerLine.visible = true;
        } else {
          tetherLine.visible = false;
          tetherInnerLine.visible = false;
        }
      }

      const fade = fadeMeshesRef.current;
      if (fade.ceiling || fade.wallUpper) {
        let targetOpacity = 1;
        if (!fp.isLocked && xrayRef.current) {
          const dx = camera.position.x - orbit.target.x;
          const dy = camera.position.y - orbit.target.y;
          const dz = camera.position.z - orbit.target.z;
          const horiz = Math.hypot(dx, dz) || 0.0001;
          const elevation = Math.atan2(dy, horiz);
          const t = Math.min(1, Math.max(0, elevation / (Math.PI * 0.28)));
          targetOpacity = 1 - t * 0.85;
        }
        const lerp = (m: any) => {
          if (!m) return;
          m.material.opacity += (targetOpacity - m.material.opacity) * 0.12;
          // depthWrite is disabled permanently above to prevent flickering z-sorting bugs
        };
        lerp(fade.ceiling);
        lerp(fade.wallUpper);
      }

      renderer.render(scene, camera);
    };
    loop();

    setBlocks(currentBlocks);
    setCatchUpInfo(catchUpSummary);
    setPhase("ready");
  }, [anchor.lat, anchor.lon, fetchWeather]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.name.toLowerCase().endsWith(".glb")) buildWorld(file);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) buildWorld(file);
  };

  const toggleXray = useCallback(() => {
    setXray((v) => {
      xrayRef.current = !v;
      return !v;
    });
  }, []);

  const onLoadSelected = useCallback(async (overrideId?: string) => {
    const worldId = overrideId || selectedWorldId || worlds.find((w) => w.hasSavedBlocks)?.id || "";
    if (!worldId) {
      setLoadNote("no saved world selected");
      return;
    }
    try {
      setLoadNote("loading…");
      const saved = await loadWorldToScene(worldId);
      const world = worlds.find((w) => w.id === worldId) || null;
      persistWorldMeta(worldId, world?.name || String(saved.meta?.worldName ?? saved.meta?.sourceName ?? "TinyWorld save"));
      await buildWorld(saved);
      setLoadNote(`loaded ${saved.blockCount.toLocaleString()} blocks from ${world?.name ?? "saved world"}`);
    } catch (error) {
      setLoadNote(error instanceof Error ? error.message : String(error));
    }
  }, [buildWorld, loadWorldToScene, persistWorldMeta, selectedWorldId, worlds]);

  const onSaveSelected = useCallback(async () => {
    const worldId = selectedWorldId || worlds.find((w) => w.hasSavedBlocks)?.id || "";
    if (!worldId) {
      setLoadNote("no world selected — use Save As");
      return;
    }
    try {
      setLoadNote("saving…");
      const world = worlds.find((w) => w.id === worldId) || null;
      await saveCurrentWorld(worldId, world?.name || savedWorldRef.current?.name || "TinyWorld save");
      await fetchWorlds();
    } catch (error) {
      setLoadNote(error instanceof Error ? error.message : String(error));
    }
  }, [fetchWorlds, saveCurrentWorld, selectedWorldId, worlds]);

  const onSaveAsSelected = useCallback(async () => {
    try {
      await saveAsCurrentWorld();
    } catch (error) {
      setLoadNote(error instanceof Error ? error.message : String(error));
    }
  }, [saveAsCurrentWorld]);

  const ui = useMemo(() => ({
    root: { width: "100vw", height: "100vh", background: "#07070f", position: "relative", overflow: "hidden", fontFamily: "'SF Mono', monospace" } as React.CSSProperties,
    mount: { width: "100%", height: "100%" } as React.CSSProperties,
    center: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 } as React.CSSProperties,
    title: { fontSize: 40, fontWeight: 900, color: "#fff", letterSpacing: 3, margin: 0 } as React.CSSProperties,
    label: { fontSize: 10, color: "#1a1a30", letterSpacing: 6, textTransform: "uppercase", margin: 0 } as React.CSSProperties,
    sub: { fontSize: 10, color: "#1a1a30", margin: 0 } as React.CSSProperties,
    dropzone: { border: "1px dashed #141426", borderRadius: 12, padding: "32px 52px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.01)" } as React.CSSProperties,
    droptext: { color: "#252540", fontSize: 11, margin: 0 } as React.CSSProperties,
    fileBtn: { padding: "7px 18px", background: "#0c0c1c", border: "1px solid #1c1c36", borderRadius: 6, color: "#4444aa", cursor: "pointer", fontSize: 11 } as React.CSSProperties,
    hint: { color: "#0e0e1e", fontSize: 10, margin: 0 } as React.CSSProperties,
    status: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, pointerEvents: "none" } as React.CSSProperties,
    tag: { color: "#4444aa", fontSize: 13, margin: 0 } as React.CSSProperties,
    tagSub: { color: "#1a1a30", fontSize: 10, margin: 0 } as React.CSSProperties,
    hud: { position: "absolute", bottom: 20, left: 20, background: "rgba(7,7,15,0.9)", padding: "12px 16px", borderRadius: 8, backdropFilter: "blur(12px)", pointerEvents: "none" } as React.CSSProperties,
    hudTitle: { color: "#fff", fontSize: 11, fontWeight: 700, letterSpacing: 2, margin: "0 0 6px" } as React.CSSProperties,
    hudStat: { color: "#4444aa", fontSize: 10, margin: 0 } as React.CSSProperties,
    hudNote: { color: "#1a1a30", fontSize: 9, margin: "4px 0 0" } as React.CSSProperties,
    walkBtn: { position: "absolute", bottom: 20, right: 20, padding: "9px 22px", background: "rgba(7,7,15,0.9)", border: "1px solid #2a2a5a", borderRadius: 6, color: "#8888ff", cursor: "pointer", fontSize: 12, letterSpacing: 1, backdropFilter: "blur(12px)" } as React.CSSProperties,
    cutBtn: { position: "absolute", bottom: 64, right: 20, padding: "9px 22px", background: "rgba(7,7,15,0.9)", border: "1px solid #2a2a5a", borderRadius: 6, color: "#88ddaa", cursor: "pointer", fontSize: 12, letterSpacing: 1, backdropFilter: "blur(12px)" } as React.CSSProperties,
    savePanel: { position: "absolute", top: 20, left: 20, background: "rgba(7,7,15,0.92)", border: "1px solid #2a2a5a", borderRadius: 10, padding: "12px 14px", backdropFilter: "blur(12px)", color: "#d6d6ff", maxWidth: 300 } as React.CSSProperties,
    saveSelect: { width: 260, marginBottom: 8, background: "#0c0c1c", color: "#d6d6ff", border: "1px solid #2a2a5a", borderRadius: 6, padding: "8px 10px", fontSize: 11 } as React.CSSProperties,
    saveRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 } as React.CSSProperties,
    saveBtn: { padding: "7px 12px", background: "#11112b", border: "1px solid #3a3a78", borderRadius: 6, color: "#9cb0ff", cursor: "pointer", fontSize: 11 } as React.CSSProperties,
    saveMeta: { fontSize: 10, color: "#7d7db8", margin: "4px 0 0" } as React.CSSProperties,
    worldList: { display: "flex", flexDirection: "column", gap: 6, alignItems: "center", marginTop: 4 } as React.CSSProperties,
    worldBtn: { padding: "8px 18px", background: "#0c0c1c", border: "1px solid #1c1c36", borderRadius: 6, color: "#6a6ad0", cursor: "pointer", fontSize: 11 } as React.CSSProperties,
    crosshair: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", pointerEvents: "none", color: "rgba(255,255,255,0.55)", fontSize: 22, lineHeight: 1, userSelect: "none" } as React.CSSProperties,
    fpHud: { position: "absolute", bottom: 20, left: 20, background: "rgba(7,7,15,0.9)", padding: "12px 16px", borderRadius: 8, backdropFilter: "blur(12px)", pointerEvents: "none" } as React.CSSProperties,
  }), []);

  return (
    <div style={ui.root} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div ref={mountRef} style={ui.mount} />
      {catchUpInfo && (
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          background: "rgba(10, 5, 20, 0.95)", border: "1px solid #8a2be2", borderRadius: 12,
          padding: "24px 32px", color: "#fff", zIndex: 10000, backdropFilter: "blur(12px)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)", textAlign: "center", maxWidth: 400
        }}>
          <h2 style={{ margin: "0 0 16px", color: "#ff88ff", fontSize: 18, letterSpacing: 1 }}>While you were away...</h2>
          <p style={{ margin: "8px 0", fontSize: 13, color: "#d6d6ff", lineHeight: 1.5 }}>
            Time passed: <strong>{Math.round(catchUpInfo.elapsedHours * 10) / 10} hours</strong>
          </p>
          {catchUpInfo.voidLoss > 0 && (
            <p style={{ margin: "8px 0", fontSize: 13, color: "#ffaa88", lineHeight: 1.5 }}>
              The void consumed <strong>{catchUpInfo.voidLoss.toLocaleString()} blocks</strong>.
            </p>
          )}
          {catchUpInfo.growth > 0 && (
            <p style={{ margin: "8px 0", fontSize: 13, color: "#88ffaa", lineHeight: 1.5 }}>
              Your world grew organically.
            </p>
          )}
          <button 
            style={{ ...ui.saveBtn, marginTop: 20, padding: "10px 24px", fontSize: 13, background: "#8a2be2", color: "#fff", border: "none", cursor: "pointer" }}
            onClick={() => setCatchUpInfo(null)}
          >
            Acknowledge
          </button>
        </div>
      )}
      {phase === "idle" && (
        <div style={ui.center}>
          <p style={ui.label}>Project</p>
          <h1 style={ui.title}>TinyWorld</h1>
          <p style={ui.sub}>NYC Temperate · weather + terrain + trees</p>
          <div style={ui.dropzone}>
            <p style={ui.droptext}>Drop .GLB scan here</p>
            <span style={{ color: "#111120", fontSize: 10 }}>or</span>
            <label style={ui.fileBtn}>
              Choose file
              <input type="file" accept=".glb" onChange={onFile} style={{ display: "none" }} />
            </label>
          </div>
          {nodeInfo && nodeInfo.source !== "unresolved" ? (
            <p style={{ ...ui.sub, opacity: 0.65 }}>
              node: {nodeInfo.city ?? "unknown"} ({nodeInfo.source})
              {nodeInfo.hiddenCount > 0
                ? ` · ${nodeInfo.hiddenCount} world${nodeInfo.hiddenCount === 1 ? "" : "s"} beyond perception`
                : ""}
            </p>
          ) : null}
          {worlds.some((w) => w.hasSavedBlocks) && (
            <div style={ui.worldList}>
              <p style={ui.sub}>or load a saved world</p>
              {worlds.filter((w) => w.hasSavedBlocks).map((world) => (
                <button key={world.id} style={ui.worldBtn} onClick={() => { setSelectedWorldId(world.id); onLoadSelected(world.id); }}>
                  {world.name} · {(world.savedBlockCount ?? 0).toLocaleString()} blocks
                </button>
              ))}
              {loadNote ? <p style={ui.sub}>{loadNote}</p> : null}
            </div>
          )}
          <p style={ui.hint}>Scaniverse (iPhone) → Export GLB → drop here</p>
        </div>
      )}
      {(phase === "loading" || phase === "building") && (
        <div style={ui.status}>
          <p style={ui.tag}>{phase === "loading" ? "Fetching weather…" : "Building tiny world…"}</p>
          <p style={ui.tagSub}>{phase === "loading" ? "loading Open-Meteo + biome rules" : "worker voxelization + occlusion culling"}</p>
        </div>
      )}
      {phase === "ready" && !walking && (
        <>
          <div style={ui.savePanel}>
            <p style={ui.hudTitle}>SAVE / LOAD</p>
            <select value={selectedWorldId} onChange={(e) => setSelectedWorldId(e.target.value)} style={ui.saveSelect}>
              <option value="">Select world…</option>
              {worlds.map((world) => (
                <option key={world.id} value={world.id}>
                  {world.name}{world.hasSavedBlocks ? ` · ${(world.savedBlockCount ?? 0).toLocaleString()} blocks` : ""}
                </option>
              ))}
            </select>
            <div style={ui.saveRow}>
              <button style={ui.saveBtn} onClick={() => onLoadSelected()}>Load</button>
              <button style={ui.saveBtn} onClick={onSaveSelected}>Save</button>
              <button style={ui.saveBtn} onClick={onSaveAsSelected}>Save As</button>
            </div>
            <p style={ui.saveMeta}>{loadNote || "compact base64 blocks · SQLite-backed"}</p>
          </div>
          <div style={ui.hud}>
            <p style={ui.hudTitle}>TINYWORLD</p>
            <p style={ui.hudStat}>
              {blocks.toLocaleString()} visible blocks
              {moves ? `  ·  ${moves} moved` : ""}
              {satiation ? `  ·  satiation ${satiation}` : ""}
            </p>
            <p style={ui.hudStat}>
              W {ledger.world.toLocaleString()} · S {ledger.stockpile} · B {ledger.built} · V {ledger.void.toLocaleString()}
            </p>
            <p style={ui.hudStat}>
              void {voidUi.phase}
              {voidUi.creatures ? `  ·  ${voidUi.creatures} creature${voidUi.creatures > 1 ? "s" : ""}` : ""}
              {voidUi.eaten ? `  ·  ${voidUi.eaten} eaten` : ""}
            </p>
            <p style={ui.hudStat}>
              scan charge {scanUi.charge}/3
              {scanUi.scans ? `  ·  ${scanUi.scans} scanned` : ""}
              {"  "}
              <button style={ui.saveBtn} onClick={() => (window as any).__tw?.scan?.()}>SCAN ◈</button>
            </p>
            {shipUi.count > 0 && (
              <p style={ui.hudStat}>
                ships {shipUi.count}
                {shipUi.flying ? `  ·  ${shipUi.flying} in flight` : ""}
              </p>
            )}
            {(bombUi.slugs > 0 || bombUi.bombs > 0 || bombUi.detonations > 0) && (
              <p style={ui.hudStat}>
                slugs {bombUi.slugs}
                {bombUi.bombs ? `  ·  ${bombUi.bombs} armed` : ""}
                {bombUi.detonations ? `  ·  ${bombUi.detonations} returned` : ""}
              </p>
            )}
            <p style={ui.hudNote}>
              {weather?.season ?? "NYC"} · {weather?.current?.label ?? "weather offline"}
              {typeof weather?.current?.temperature === "number" ? `  ·  ${Math.round(weather.current.temperature)}°C` : ""}
            </p>
          </div>
          <button style={ui.walkBtn} onClick={() => enterWalkRef.current()}>Walk · F</button>
          <button style={ui.cutBtn} onClick={toggleXray}>
            {xray ? "X-ray: AUTO" : "X-ray: OFF"}
          </button>
        </>
      )}
      {walking && (
        <>
          <div style={ui.crosshair}>＋</div>
          <div style={ui.fpHud}>
            <p style={ui.hudTitle}>WALK MODE</p>
            <p style={ui.hudStat}>
              HOLD to pick up · CLICK to place · RIGHT-CLICK / G to return
              {carryLayer === "fruit" ? "  ·  E to eat" : ""}
            </p>
            <p style={ui.hudNote}>
              WASD · mouse look · SPACE jump · ESC exit
              {carryLayer ? `  ·  holding ${carryLayer}` : ""}
              {moves ? `  ·  ${moves} moved` : ""}
              {satiation ? `  ·  satiation ${satiation}` : ""}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
