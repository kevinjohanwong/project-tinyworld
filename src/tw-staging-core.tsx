import { useCallback, useEffect, useRef, useState } from "react";

const THREE_URL = "https://esm.sh/three@0.165.0";
const GLTF_URL = "https://esm.sh/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";
const ORBIT_URL = "https://esm.sh/three@0.165.0/examples/jsm/controls/OrbitControls.js";
const FP_URL = "https://esm.sh/three@0.165.0/examples/jsm/controls/PointerLockControls.js";
const COMPOSER_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js";
const RENDER_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/RenderPass.js";
const SSAO_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/SSAOPass.js";
const BLOOM_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js";
const SHADER_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/ShaderPass.js";

// ─── Outline shader (Sobel on depth + normal) ────────────────────────────
// Voxel-friendly cel outline. One full-screen pass at the end of the
// composer chain. Reads the previous color (tDiffuse), the scene's
// view-space normals (tNormal), and depth (tDepth) from a single prepass
// target. Sobel-style 5-tap sampling on each signal -> edge mask -> mixed
// toward outlineColor. Cheap, no per-mesh setup, plays nicely with
// InstancedMesh. Tune live via __tw.setOutline({...}).
const OUTLINE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: null }, // THREE.Vector2 (px)
    cameraNear: { value: 0.02 },
    cameraFar: { value: 500 },
    thickness: { value: 1.0 },
    depthThreshold: { value: 0.006 },
    normalThreshold: { value: 0.6 },
    outlineColor: { value: null }, // THREE.Color
    outlineMix: { value: 0.4 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float thickness;
    uniform float depthThreshold;
    uniform float normalThreshold;
    uniform vec3 outlineColor;
    uniform float outlineMix;
    varying vec2 vUv;
    float linDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x;
      return (2.0 * cameraNear) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
    }
    void main(){
      vec2 texel = thickness / resolution;
      vec4 color = texture2D(tDiffuse, vUv);
      float dC = linDepth(vUv);
      float dL = linDepth(vUv + vec2(-texel.x, 0.0));
      float dR = linDepth(vUv + vec2( texel.x, 0.0));
      float dU = linDepth(vUv + vec2(0.0,  texel.y));
      float dD = linDepth(vUv + vec2(0.0, -texel.y));
      float depthEdge = (abs(dL - dR) + abs(dU - dD)) / max(dC, 0.0001);
      vec3 nC = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
      vec3 nL = texture2D(tNormal, vUv + vec2(-texel.x, 0.0)).rgb * 2.0 - 1.0;
      vec3 nR = texture2D(tNormal, vUv + vec2( texel.x, 0.0)).rgb * 2.0 - 1.0;
      vec3 nU = texture2D(tNormal, vUv + vec2(0.0,  texel.y)).rgb * 2.0 - 1.0;
      vec3 nD = texture2D(tNormal, vUv + vec2(0.0, -texel.y)).rgb * 2.0 - 1.0;
      float normalEdge = (1.0 - dot(nL, nR)) + (1.0 - dot(nU, nD));
      float dEdge = step(depthThreshold, depthEdge);
      float nEdge = step(normalThreshold, normalEdge);
      float skyMask = step(0.999, texture2D(tDepth, vUv).x);
      float edge = clamp(max(dEdge, nEdge) * (1.0 - skyMask), 0.0, 1.0);
      // Luminance-aware modulation: scenes that are already dark (night) get
      // a lighter touch so outlines don't smother the image. Bright pixels
      // get the full effect for crisp daytime cel-shading.
      float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      float lumGate = smoothstep(0.05, 0.35, lum);
      gl_FragColor = vec4(mix(color.rgb, outlineColor, edge * outlineMix * lumGate), color.a);
    }
  `,
};

const NYC = { lat: 40.7128, lon: -74.006, timezone: "America/New_York" };
const MAX_TRIANGLES = 500_000;
// Fixed metric voxel size: space translates — a 2x bigger scan is a 2x bigger
// world (KJ 2026-07-11). Replaces span/TARGET_DIVS=690 normalization, which
// squeezed every scan into the same world extent regardless of physical size.
const VOXEL_METERS = 0.015;
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
  leaves: 450,
  fruit: 350,
  seed: 400,
  sapling: 600,
  snow: 500,
  grass: 600,
  dryGrass: 600,
  wet: 700,
  dirt: 800,
  trunks: 1500,
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
    const VOXEL_METERS = ${VOXEL_METERS};
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
    const voxel = VOXEL_METERS;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const floorMap = new Map();
    const wall = [];
    const ceiling = [];
    const upSeen = new Set();
    const upVox = [];

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
            const k3 = vx + ',' + vy + ',' + vz;
            if (!upSeen.has(k3)) { upSeen.add(k3); upVox.push([vx, vy, vz]); }
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

    // Snap to dominant floor level: if >=50% of cells share one height,
    // pull cells within 2 voxels of it onto the plane (kills residual ripple).
    const floorHistogram = new Map();
    for (const y of filledFloor.values()) floorHistogram.set(y, (floorHistogram.get(y) || 0) + 1);
    let domY = 0, domCount = 0;
    for (const [y, count] of floorHistogram) if (count > domCount) { domY = y; domCount = count; }
    const hasDomFloor = domCount >= filledFloor.size * 0.5;
    if (hasDomFloor) {
      for (const [k, y] of filledFloor) {
        if (Math.abs(y - domY) <= 2) filledFloor.set(k, domY);
      }
    }

    // ── Rectification pass 1b: furniture extraction ───────────────────────────
    // Up-facing patches well above the dominant floor are furniture tops
    // (tables, chairs, counters), not raised terrain. Pull furniture-sized
    // elevated plateaus out of the floor map, keep them as object slabs, and
    // restore the dominant floor beneath — a table reads as a slab on legs
    // instead of a hill with walls extruded up to meet it.
    const objectVox = [];
    if (hasDomFloor) {
      const plateau = new Set();
      for (const [k, y] of filledFloor) if (y - domY > 3) plateau.add(k);
      const seen = new Set();
      const maxObjectCells = Math.max(64, Math.round(4 / (voxel * voxel))); // ~4 m^2
      for (const start of plateau) {
        if (seen.has(start)) continue;
        const comp = [start];
        seen.add(start);
        for (let i = 0; i < comp.length; i++) {
          const [x, z] = comp[i].split(',').map(Number);
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = (x + dx) + ',' + (z + dz);
            if (plateau.has(nk) && !seen.has(nk)) { seen.add(nk); comp.push(nk); }
          }
        }
        if (comp.length > maxObjectCells) continue; // large platform = real terrain
        for (const k of comp) {
          const y = filledFloor.get(k);
          const [x, z] = k.split(',').map(Number);
          objectVox.push([x, y, z]);
          objectVox.push([x, y - 1, z]);
          filledFloor.set(k, domY);
        }
      }
    }

    // ── Rectification pass 1c: elevated tops (counters, cabinets, tables) ────
    // The floor stream keeps only the LOWEST up-facing sample per column, so
    // any horizontal top above a visible floor — counter over kick space,
    // table over scanned floor, open-shelf top — used to vanish. Re-emit
    // every distinct up-facing voxel that sits >3 voxels above the final
    // floor as a furniture slab (top + one below for thickness); grounding
    // (pass 4) still settles or drops anything unsupported.
    {
      let elevated = 0;
      for (const p of upVox) {
        const fy = filledFloor.get(p[0] + ',' + p[2]);
        if (fy === undefined || p[1] <= fy + 3) continue;
        objectVox.push([p[0], p[1], p[2]]);
        objectVox.push([p[0], p[1] - 1, p[2]]);
        elevated += 1;
      }
      console.log('[voxelizer] elevated tops: ' + elevated + ' up-facing vox re-emitted above floor');
    }

    // ── Rectification pass 2: ceiling plane detection ─────────────────────────
    // Find the dominant ceiling plane BEFORE wall solidification so it can
    // cap wall extrusion. An interior scan cannot see above its own ceiling,
    // so down-facing geometry above the dominant plane is bleed.
    const ceilCols = new Map();
    for (const p of ceiling) {
      const k = p[0] + ',' + p[2];
      let arr = ceilCols.get(k);
      if (!arr) { arr = []; ceilCols.set(k, arr); }
      arr.push(p[1]);
    }
    let domCeilY = 0, domCeilCount = 0;
    {
      const histogram = new Map();
      for (const ys of ceilCols.values()) {
        ys.sort((a, b) => a - b);
        const med = ys[Math.floor(ys.length / 2)];
        histogram.set(med, (histogram.get(med) || 0) + 1);
      }
      // Dominance over a +-1 band, not one exact level: real scans split the
      // vote across two adjacent voxel levels (e.g. 45% at y=116, 31% at 115),
      // which made an exact-level test fail and left the ceiling unflattened.
      for (const [y] of histogram) {
        const s = (histogram.get(y - 1) || 0) + (histogram.get(y) || 0) + (histogram.get(y + 1) || 0);
        if (s > domCeilCount) { domCeilY = y; domCeilCount = s; }
      }
    }
    const snapCeil = domCeilCount >= ceilCols.size * 0.5;
    const hasCeil = snapCeil && ceilCols.size >= filledFloor.size * 0.2;
    if (!hasCeil) {
      // No dominant plane (outdoor scan / sparse ceiling): legacy per-column
      // median collapse. Dominant-plane interior scans keep their RAW ceiling
      // voxels here — pass 3b prunes them to a wall rim + hanging relief
      // instead of snapping them flat (the LiDAR is trusted).
      const flatCeil = [];
      for (const [k, ys] of ceilCols) {
        const [x, z] = k.split(',').map(Number);
        flatCeil.push([x, ys[Math.floor(ys.length / 2)], z]);
      }
      ceiling.length = 0;
      for (const p of flatCeil) ceiling.push(p);
    }

    // ── Rectification pass 3: wall rectification ──────────────────────────────
    // Group wall voxels into (x,z) columns. Sparse columns (<3 samples) are
    // scan noise and are dropped. Short columns are furniture (chair backs,
    // table edges/legs) and keep their raw sampled voxels. A column's top is
    // its own p90 sample (one stray point no longer drags a wall to its
    // height), and when a dominant ceiling plane exists, wall tops within 2
    // voxels of it (or above it) snap exactly onto it — walls meet the
    // ceiling, never pierce it.
    const wallCols = new Map();
    for (const p of wall) {
      const k = p[0] + ',' + p[2];
      let col = wallCols.get(k);
      if (!col) { col = { ys: [], minY: p[1], top: p[1], count: 0 }; wallCols.set(k, col); }
      if (p[1] < col.minY) col.minY = p[1];
      col.ys.push(p[1]);
    }
    for (const col of wallCols.values()) {
      col.ys.sort((a, b) => a - b);
      col.count = col.ys.length;
      col.top = col.ys[Math.min(col.ys.length - 1, Math.floor(col.ys.length * 0.9))];
    }
    const colTops = [];
    for (const col of wallCols.values()) if (col.count >= 3) colTops.push(col.top);
    colTops.sort((a, b) => a - b);
    let archTop = colTops.length ? colTops[Math.floor(colTops.length * 0.9)] : 0;
    if (hasCeil && archTop > domCeilY) archTop = domCeilY;
    const floorRef = hasDomFloor ? domY : (colTops.length ? colTops[0] : 0);
    const wallGateY = floorRef + Math.max(4, Math.round((archTop - floorRef) * 0.6));
    // Architectural columns are SPAN-FILLED, not extruded base-to-top: keep
    // the sampled voxels, bridge only small scan holes (<= WALL_GAP_FILL),
    // and ground bases that hover just above the floor (baseboard shadow).
    // A doorframe edge sampled only near the ceiling no longer grows a
    // phantom floor-to-ceiling pillar, and windows/doorways stay open.
    const WALL_GAP_FILL = 8;
    const solidWall = [];
    const wallSeen = new Set();
    const archWallKeys = new Set();
    for (const [k, col] of wallCols) {
      if (col.count < 3 || col.top < wallGateY) continue;
      archWallKeys.add(k);
      const [x, z] = k.split(',').map(Number);
      let top = col.top;
      if (hasCeil && top >= domCeilY - 2) top = domCeilY;
      const floorY = filledFloor.get(k);
      let prev = null;
      if (floorY !== undefined && col.ys[0] > floorY && col.ys[0] - floorY <= WALL_GAP_FILL + 1) {
        prev = floorY;
      }
      for (const y of col.ys) {
        if (y > top) break;
        if (prev !== null && y <= prev) continue;
        if (prev !== null && y - prev > 1 && y - prev <= WALL_GAP_FILL + 1) {
          for (let g = prev + 1; g < y; g++) {
            solidWall.push([x, g, z]);
            wallSeen.add(x + ',' + g + ',' + z);
          }
        }
        solidWall.push([x, y, z]);
        wallSeen.add(x + ',' + y + ',' + z);
        prev = y;
      }
      if (prev !== null && top > prev && top - prev <= WALL_GAP_FILL + 1) {
        for (let g = prev + 1; g <= top; g++) {
          solidWall.push([x, g, z]);
          wallSeen.add(x + ',' + g + ',' + z);
        }
      }
    }
    let furnitureVox = 0;
    let bleedVox = 0;
    for (const p of wall) {
      const col = wallCols.get(p[0] + ',' + p[2]);
      if (!col || col.count < 3 || col.top >= wallGateY) continue;
      if (hasCeil && p[1] > domCeilY) { bleedVox += 1; continue; }
      const k3 = p[0] + ',' + p[1] + ',' + p[2];
      if (wallSeen.has(k3)) continue;
      wallSeen.add(k3);
      solidWall.push(p);
      furnitureVox += 1;
    }
    for (const p of objectVox) {
      const k3 = p[0] + ',' + p[1] + ',' + p[2];
      if (wallSeen.has(k3)) continue;
      wallSeen.add(k3);
      solidWall.push(p);
    }
    wall.length = 0;
    for (const p of solidWall) wall.push(p);
    console.log('[voxelizer] wall gate y=' + wallGateY + ' archTop=' + archTop + ' floorRef=' + floorRef
      + ' ceil=' + (hasCeil ? 'y=' + domCeilY : 'none')
      + ' | furniture: ' + furnitureVox + ' sampled vox + ' + objectVox.length + ' slab vox, '
      + bleedVox + ' bleed vox above ceiling dropped');

    // ── Rectification pass 3b: partial ceiling (dollhouse rule) ───────────────
    // A scanned interior ceiling voxelizes into an opaque lid that hides the
    // room the world is about — the GLB only looks open in viewers because
    // its inward-facing ceiling is backface-culled. Keep the ceiling only
    // where it carries form: a TORN rim along architectural walls (the
    // enclosure silhouette) plus relief hanging below the dominant plane
    // (beams, lamps, coving). The flat expanse in the middle opens to the
    // sky. Kept voxels stay RAW — no plane snap. A 6-connectivity prune back
    // to the walls guarantees the load-time floater sweep finds no orphans.
    //
    // The rim is deliberately non-uniform (a constant band reads machined):
    // its depth is modulated by low-frequency value noise (~0.2m–1.0m, ~1m
    // tear features so it reads as broken plaster bays, not fuzz) and the
    // inner edge dissolves probabilistically over the last few voxels. All
    // noise is hash-seeded from column coords: re-uploading the same GLB
    // tears the same way.
    if (hasCeil) {
      const RIM_M = 0.5;
      const RIM_CELLS = Math.max(4, Math.round(RIM_M / voxel));
      const RIM_MAX = Math.ceil(RIM_CELLS * 2);
      const FRINGE = Math.max(2, Math.round(0.06 / voxel));
      const h01 = (x, z) => (hash2(x, z) % 1000) / 1000;
      const NOISE_P = RIM_CELLS * 2; // ~1m patches
      const rimNoise = (x, z) => {
        const gx = Math.floor(x / NOISE_P), gz = Math.floor(z / NOISE_P);
        const fx = x / NOISE_P - gx, fz = z / NOISE_P - gz;
        const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
        const a = h01(gx, gz), b = h01(gx + 1, gz), c = h01(gx, gz + 1), e = h01(gx + 1, gz + 1);
        return (a + (b - a) * sx) * (1 - sz) + (c + (e - c) * sx) * sz;
      };
      const localRim = (x, z) => RIM_CELLS * (0.4 + 1.6 * rimNoise(x, z));
      const rimDist = new Map();
      const rimQ = [];
      for (const k of ceilCols.keys()) {
        const ci = k.indexOf(',');
        const x = Number(k.slice(0, ci)), z = Number(k.slice(ci + 1));
        let nearWall = false;
        for (let dx = -1; dx <= 1 && !nearWall; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (archWallKeys.has((x + dx) + ',' + (z + dz))) { nearWall = true; break; }
          }
        }
        if (nearWall) { rimDist.set(k, 0); rimQ.push([x, z]); }
      }
      let head = 0;
      while (head < rimQ.length) {
        const [x, z] = rimQ[head++];
        const d = rimDist.get(x + ',' + z);
        if (d >= RIM_MAX) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = (x + dx) + ',' + (z + dz);
          if (ceilCols.has(nk) && !rimDist.has(nk)) { rimDist.set(nk, d + 1); rimQ.push([x + dx, z + dz]); }
        }
      }
      let rimCols = 0, reliefCols = 0, openedCols = 0;
      const keptCols = new Set();
      for (const [k, ys] of ceilCols) {
        const med = ys[Math.floor(ys.length / 2)];
        const ci = k.indexOf(',');
        const x = Number(k.slice(0, ci)), z = Number(k.slice(ci + 1));
        const d = rimDist.get(k);
        if (d !== undefined) {
          const lr = localRim(x, z);
          if (d <= lr - FRINGE) { keptCols.add(k); rimCols += 1; continue; }
          if (d <= lr) {
            // dissolve fringe: keep-chance falls toward the tear tip
            const t = (lr - d) / FRINGE;
            if (h01(x * 7 + 3, z * 11 + 5) < 0.15 + 0.85 * t) { keptCols.add(k); rimCols += 1; continue; }
          }
        }
        if (med < domCeilY - 2) { keptCols.add(k); reliefCols += 1; }
        else openedCols += 1;
      }
      const keptSet = new Set();
      const kept = [];
      for (const p of ceiling) {
        if (!keptCols.has(p[0] + ',' + p[2])) continue;
        if (p[1] > domCeilY + 1) continue; // bleed above the plane: dropped, not clamped
        const k3 = p[0] + ',' + p[1] + ',' + p[2];
        if (keptSet.has(k3)) continue;
        keptSet.add(k3);
        kept.push(p);
      }
      const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const reached = new Set();
      const q3 = [];
      for (const p of kept) {
        for (const [dx, dy, dz] of D6) {
          if (wallSeen.has((p[0] + dx) + ',' + (p[1] + dy) + ',' + (p[2] + dz))) {
            reached.add(p[0] + ',' + p[1] + ',' + p[2]);
            q3.push(p);
            break;
          }
        }
      }
      head = 0;
      while (head < q3.length) {
        const [x, y, z] = q3[head++];
        for (const [dx, dy, dz] of D6) {
          const nx = x + dx, ny2 = y + dy, nz = z + dz;
          const nk = nx + ',' + ny2 + ',' + nz;
          if (keptSet.has(nk) && !reached.has(nk)) { reached.add(nk); q3.push([nx, ny2, nz]); }
        }
      }
      const prunedVox = kept.length - q3.length;
      ceiling.length = 0;
      for (const p of q3) ceiling.push(p);
      console.log('[voxelizer] partial ceiling: ' + rimCols + ' rim + ' + reliefCols + ' relief cols kept, '
        + openedCols + ' flat cols opened to sky; ' + q3.length + ' vox kept, ' + prunedVox + ' orphan vox pruned');
    }

    // ── Rectification pass 4: grounding ────────────────────────────────────
    // Flood the assembled wall/furniture voxels into connected components
    // (6-connectivity). A component is grounded when it rests on a floor
    // cell or reaches the ceiling sheet (wall columns whose bases were
    // occluded in the scan). Ungrounded islands are hovering scan noise or
    // levitating furniture fragments: tiny specks are dropped, everything
    // else settles straight down until it contacts the floor or another
    // solid — a table falls onto its own legs, debris lands on the floor.
    {
      const ceilSet = new Set();
      for (const p of ceiling) ceilSet.add(p[0] + ',' + p[1] + ',' + p[2]);
      const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const compSeen = new Set();
      const comps = [];
      for (const seed of wall) {
        const k0 = seed[0] + ',' + seed[1] + ',' + seed[2];
        if (compSeen.has(k0)) continue;
        compSeen.add(k0);
        const cells = [seed];
        let grounded = false;
        for (let i = 0; i < cells.length; i++) {
          const [x, y, z] = cells[i];
          const fY = filledFloor.get(x + ',' + z);
          if (fY !== undefined && y <= fY + 1) grounded = true;
          if (hasCeil && y >= domCeilY - 1) grounded = true;
          for (const [dx, dy, dz] of DIRS6) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            const nk = nx + ',' + ny + ',' + nz;
            if (ceilSet.has(nk)) grounded = true;
            if (!wallSeen.has(nk) || compSeen.has(nk)) continue;
            compSeen.add(nk);
            cells.push([nx, ny, nz]);
          }
        }
        comps.push({ cells, grounded, drop: false });
      }
      const minYOf = (c) => { let m = Infinity; for (const p of c.cells) if (p[1] < m) m = p[1]; return m; };
      const loose = comps.filter((c) => !c.grounded).sort((a, b) => minYOf(a) - minYOf(b));
      let settledIslands = 0, settledVox = 0, droppedIslands = 0, droppedVox = 0;
      for (const c of loose) {
        if (c.cells.length <= 3) {
          c.drop = true;
          droppedIslands += 1; droppedVox += c.cells.length;
          for (const [x, y, z] of c.cells) wallSeen.delete(x + ',' + y + ',' + z);
          continue;
        }
        const colLow = new Map();
        for (const [x, y, z] of c.cells) {
          const k = x + ',' + z;
          const cur = colLow.get(k);
          if (cur === undefined || y < cur) colLow.set(k, y);
        }
        let fall = Infinity;
        for (const [k, lowY] of colLow) {
          const ci = k.indexOf(',');
          const x = Number(k.slice(0, ci)), z = Number(k.slice(ci + 1));
          const fY = filledFloor.get(k);
          let land = fY !== undefined ? fY + 1 : -Infinity;
          const scanTo = fY !== undefined ? fY + 1 : lowY - 64;
          for (let y = lowY - 1; y >= scanTo; y--) {
            if (wallSeen.has(x + ',' + y + ',' + z)) { land = y + 1; break; }
          }
          if (land === -Infinity) continue; // no landing in this column — doesn't constrain
          const d = lowY - land;
          if (d < fall) fall = d;
        }
        if (!isFinite(fall)) {
          // hovering entirely outside the floor plate with nothing below: noise
          c.drop = true;
          droppedIslands += 1; droppedVox += c.cells.length;
          for (const [x, y, z] of c.cells) wallSeen.delete(x + ',' + y + ',' + z);
          continue;
        }
        if (fall <= 0) continue;
        for (const [x, y, z] of c.cells) wallSeen.delete(x + ',' + y + ',' + z);
        for (const p of c.cells) { p[1] -= fall; wallSeen.add(p[0] + ',' + p[1] + ',' + p[2]); }
        settledIslands += 1; settledVox += c.cells.length;
      }
      const rebuilt = [];
      for (const c of comps) if (!c.drop) for (const p of c.cells) rebuilt.push(p);
      wall.length = 0;
      for (const p of rebuilt) wall.push(p);
      console.log('[voxelizer] grounding: ' + comps.length + ' components; '
        + settledIslands + ' islands settled (' + settledVox + ' vox), '
        + droppedIslands + ' dropped (' + droppedVox + ' vox)');
    }

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
    // The browser worker is a persistence-first preview only. Regular trees
    // are authored once by tools/glb_to_world_payload.py after upload.

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

    // Dry divots / channels instead of decorative water (KJ Jul 25: "redo the
    // glb voxelizer not to include water — instead have divots and channels,
    // filled temporarily by rain"). The old pass SEEDED concave basins and
    // FLOODED them with water; now we keep the exact same seeding + flood to
    // find the basin footprint, but instead of emitting water we CARVE it —
    // lower each basin column's floor by DIVOT_DEPTH. Because the underside
    // (crust + latent) and surface passes below both read filledFloor, sinking
    // it here makes the whole column dip together into a clean watertight bowl /
    // channel the terrain owns. No water layer is emitted; rain can pool into
    // these lows later. Runs BEFORE the underside pass on purpose.
    const DIVOT_DEPTH = 2;
    const poolTaken = new Set();
    {
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
      let basinCount = 0;
      for (const seed of poolSeeds) {
        if (basinCount >= MAX_WATER) break;
        const queue = [[seed.x, seed.z, 0]];
        const seen = new Set();
        const claimed = [];
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
          claimed.push(k);
          for (const [dx, dz] of neighbors4) queue.push([x + dx, z + dz, dist + 1]);
        }
        if (claimed.length >= 6) {
          basinCount += 1;
          for (const k of claimed) { poolTaken.add(k); filledFloor.set(k, filledFloor.get(k) - DIVOT_DEPTH); }
        }
      }
      console.log('[voxelizer] divots: ' + basinCount + ' basins carved (' + poolTaken.size + ' cols, depth ' + DIVOT_DEPTH + '), water disabled');
    }

    // Underside: inverted-cone mass — deepest at the CENTER, tapering to thin
    // rim, plus chunky hanging "taproots" near the core (Laputa style).
    // Fixed-metric rule: depth scales with island SIZE in meters, not a fixed
    // voxel count (at 1.5cm voxels the old 2–32 vox cone was a <0.5m crust you
    // punched through in seconds). Only a thin crust is EXPLICIT; the deep
    // mass ships as a compact per-column latent span (latentCols quads) that
    // the client renders as fill prisms and materializes into real dirt on
    // dig — millions of interior voxels never touch the payload or VRAM.
    const CRUST = Math.max(2, Math.round(0.03 / voxel));
    const islandDepthM = Math.min(12, Math.max(1.5, floorSpan * voxel * 0.35));
    const NOISE_CELLS = Math.max(4, Math.round(0.5 / voxel)); // ~0.5m silhouette features
    const h01u = (x, z) => (hash2(x * 31 + 17, z * 37 + 23) % 1000) / 1000;
    const undersideNoise = (x, z) => {
      const gx = Math.floor(x / NOISE_CELLS), gz = Math.floor(z / NOISE_CELLS);
      const fx = x / NOISE_CELLS - gx, fz = z / NOISE_CELLS - gz;
      const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
      const a = h01u(gx, gz), b = h01u(gx + 1, gz), c = h01u(gx, gz + 1), e = h01u(gx + 1, gz + 1);
      return (a + (b - a) * sx) * (1 - sz) + (c + (e - c) * sx) * sz;
    };
    const TAP_CELLS = Math.max(8, Math.round(0.36 / voxel)); // taproots stay chunky at fine voxels
    const latentQuads = [];
    let latentTotal = 0;
    for (const [key, floorY] of filledFloor) {
      const parts = key.split(',');
      const x = Number(parts[0]), z = Number(parts[1]);
      const dist = distToEdge.get(key) || 0;
      const t = dist / maxEdgeDist;
      let depthM = 0.05 + Math.pow(t, 1.35) * islandDepthM * (0.75 + 0.5 * undersideNoise(x, z));
      if (t > 0.55) {
        const tgx = Math.floor(x / TAP_CELLS), tgz = Math.floor(z / TAP_CELLS);
        if (((hash2(tgx * 13 + 1, tgz * 17 + 3) % 1000) / 1000) > 0.9) {
          depthM += 0.5 + ((hash2(tgx * 23 + 5, tgz * 29 + 9) % 1000) / 1000) * 1.5;
        }
      }
      const depth = Math.max(CRUST, Math.round(depthM / voxel));
      for (let dy = 1; dy <= Math.min(depth, CRUST); dy++) {
        dirt.push([x, floorY - dy, z]);
      }
      if (depth > CRUST) {
        latentQuads.push(x, z, floorY - depth, floorY - CRUST - 1);
        latentTotal += depth - CRUST;
      }
    }
    console.log('[voxelizer] underside: crust ' + CRUST + ' vox + latent to ' + islandDepthM.toFixed(1)
      + ' m: ' + (latentQuads.length / 4) + ' cols, ' + latentTotal + ' latent cells');

    // (Water pooling removed — basins are carved as divots above.) Divot columns
    // are capped with GRASS like everything else (KJ Jul 25: "should be mostly
    // grass") — they're just grassy hollows. Lakes FORM later, not here: the
    // spring fills a basin and the waterlogging system recedes the submerged
    // grass, so a lake emerges organically where water collects.
    for (const [key, y] of filledFloor.entries()) {
      const [x, z] = key.split(',').map(Number);
      const h = hash2(x, z);
      const isSummerDry = season === 'summer' && (h % 100) < dryGrassPct;
      const isWet = false; // rain puddles disabled — confusing as "WET" layer in mining HUD
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

    // ── Strict tiny-clump prune (KJ 2026-07-19) ────────────────────────────
    // Bake floater removal at UPLOAD, not world load. Any 6-connected solid
    // component with fewer than TINY_CLUMP_MIN (3) voxels is deleted outright,
    // independent of grounding. All structural + ground layers flood together,
    // so a speck RESTING on the floor (neighbour below) is part of the big
    // component and survives — only a clump with NO neighbour on any side goes.
    // trunks/leaves are empty in the preview worker (trees are authored later,
    // server-side), so vegetation is never touched. Mirrors the Python pass
    // tools/glb_to_world_payload.py::prune_tiny_components. After creation,
    // build-stranded blocks are a runtime PHYSICS concern, not this pass.
    {
      const TINY_CLUMP_MIN = 3;
      const STRUCT = ['dirt', 'grass', 'dryGrass', 'snow', 'wet', 'wall', 'ceiling'];
      const solidKeys = new Set();
      for (const name of STRUCT) {
        const layer = rawLayers[name];
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          const p = layer[i];
          solidKeys.add(p[0] + ',' + p[1] + ',' + p[2]);
        }
      }
      const remain = new Set(solidKeys);
      const D6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      const doomed = new Set();
      while (remain.size) {
        const start = remain.values().next().value;
        remain.delete(start);
        const comp = [start];
        const queue = [start];
        for (let qi = 0; qi < queue.length; qi++) {
          const parts = queue[qi].split(',');
          const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
          for (const d of D6) {
            const nk = (x + d[0]) + ',' + (y + d[1]) + ',' + (z + d[2]);
            if (remain.has(nk)) { remain.delete(nk); queue.push(nk); comp.push(nk); }
          }
        }
        if (comp.length < TINY_CLUMP_MIN) for (const k of comp) doomed.add(k);
      }
      if (doomed.size) {
        for (const name of STRUCT) {
          const layer = rawLayers[name];
          if (!layer) continue;
          rawLayers[name] = layer.filter((p) => !doomed.has(p[0] + ',' + p[1] + ',' + p[2]));
        }
        for (const k of doomed) occupied.delete(k);
        console.log('[voxelizer] tiny-clump prune: removed ' + doomed.size + ' isolated voxels (<' + TINY_CLUMP_MIN + '-block components)');
      }
    }

    // (Floater removal moved DOWNSTREAM of the occlusion cull — see the gravity
    // settle pass after the visible/hidden split. The old altitude sweep here ran
    // on the full solid, so it saw wall/ceiling nubs as connected via interior
    // "bridge" voxels the cull then deleted, orphaning them. Running after the cull
    // on the rendered set is the only place true disconnection is visible.)

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

    // ── Gravity settle + connectivity finisher (KJ 2026-07-20) ──────────────
    // Physics, not scan-artifact classification. Runs on the POST-occlusion
    // rendered set (visible ∪ hidden): the interior bridge voxels that made a
    // wall/ceiling nub read as "connected" are already culled here, so real
    // disconnection is finally visible. Model: any loose block — a settleable
    // voxel whose 6-connected component is small and not the main mass — obeys
    // gravity. It falls straight down until it rests on solid, or drops past the
    // lowest solid and LEAVES THE WORLD (deleted; conservation by removal). A
    // connectivity finisher then sweeps anything that landed still-isolated.
    // Generalises to digging/edits — no heuristics about why a block floats.
    // Trees, water, and snow/wet overlays are anchors: never moved or deleted,
    // and they ground whatever lands on them.
    {
      const SETTLEABLE = { dirt: 1, grass: 1, dryGrass: 1, wall: 1, ceiling: 1 };
      const STRUCT_CAP = 1024;
      const D6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

      const layerOf = new Map();
      const tagOf = new Map();
      const addRendered = (obj, tag) => {
        for (const name in obj) {
          const arr = obj[name];
          for (let i = 0; i < arr.length; i += 3) {
            const k = arr[i] + ',' + arr[i + 1] + ',' + arr[i + 2];
            layerOf.set(k, name); tagOf.set(k, tag);
          }
        }
      };
      addRendered(visible, 'visible');
      addRendered(hidden, 'hidden');

      const flood = (has) => {
        const seen = new Set();
        const comps = [];
        for (const start of has.keys ? has.keys() : has) {
          if (seen.has(start)) continue;
          seen.add(start);
          const comp = [start];
          for (let qi = 0; qi < comp.length; qi++) {
            const p = comp[qi].split(',');
            const x = +p[0], y = +p[1], z = +p[2];
            for (const d of D6) {
              const nk = (x + d[0]) + ',' + (y + d[1]) + ',' + (z + d[2]);
              if (has.has(nk) && !seen.has(nk)) { seen.add(nk); comp.push(nk); }
            }
          }
          comps.push(comp);
        }
        comps.sort((a, b) => b.length - a.length);
        return comps;
      };

      const comps = flood(layerOf);
      // Grounded = main mass + any big detached structure (real architecture we
      // must not collapse) + any component holding a non-settleable anchor.
      const grounded = new Set();
      const mainComp = comps[0] || [];
      for (const k of mainComp) grounded.add(k);
      const loose = [];
      for (let ci = 1; ci < comps.length; ci++) {
        const comp = comps[ci];
        let anchored = comp.length > STRUCT_CAP;
        if (!anchored) for (const k of comp) { if (!SETTLEABLE[layerOf.get(k)]) { anchored = true; break; } }
        if (anchored) { for (const k of comp) grounded.add(k); }
        else loose.push(comp);
      }

      let worldFloorY = Infinity;
      for (const k of layerOf.keys()) { const y = +k.split(',')[1]; if (y < worldFloorY) worldFloorY = y; }

      // Gravity: drop each loose voxel bottom-up until it rests or leaves the world.
      const occ = new Set(layerOf.keys());
      const looseVox = [];
      for (const comp of loose) for (const k of comp) looseVox.push(k);
      looseVox.sort((a, b) => (+a.split(',')[1]) - (+b.split(',')[1]));

      const finalLayer = new Map();
      const finalTag = new Map();
      for (const k of grounded) { finalLayer.set(k, layerOf.get(k)); finalTag.set(k, tagOf.get(k)); }

      let voided = 0, landed = 0, fell = 0;
      for (const k of looseVox) {
        const p = k.split(',');
        const x = +p[0], z = +p[2];
        let y = +p[1];
        occ.delete(k);
        while (y - 1 >= worldFloorY && !occ.has(x + ',' + (y - 1) + ',' + z)) y -= 1;
        if (y - 1 < worldFloorY && !occ.has(x + ',' + (y - 1) + ',' + z)) { voided += 1; continue; }
        const nk = x + ',' + y + ',' + z;
        occ.add(nk);
        finalLayer.set(nk, layerOf.get(k));
        finalTag.set(nk, 'visible');
        landed += 1; fell += (+p[1] - y);
      }

      // Finisher: a clump that landed without reconnecting to the main mass goes.
      const comps2 = flood(finalLayer);
      const main2 = comps2[0] || [];
      const keep2 = new Set(main2);
      let sweptIso = 0;
      for (let ci = 1; ci < comps2.length; ci++) {
        const comp = comps2[ci];
        let anchored = comp.length > STRUCT_CAP;
        if (!anchored) for (const k of comp) { if (!SETTLEABLE[finalLayer.get(k)]) { anchored = true; break; } }
        if (anchored) { for (const k of comp) keep2.add(k); }
        else { for (const k of comp) { finalLayer.delete(k); finalTag.delete(k); sweptIso += 1; } }
      }

      // Rebuild visible/hidden from the cleaned + settled solid.
      for (const name in visible) visible[name].length = 0;
      for (const name in hidden) hidden[name].length = 0;
      let vis2 = 0;
      for (const [k, name] of finalLayer) {
        const p = k.split(',');
        const x = +p[0], y = +p[1], z = +p[2];
        if (finalTag.get(k) === 'hidden' && hidden[name]) hidden[name].push(x, y, z);
        else { visible[name].push(x, y, z); vis2 += 1; }
      }
      visibleCount = vis2;

      console.log('[voxelizer] gravity settle: ' + looseVox.length + ' loose vox -> '
        + voided + ' voided, ' + landed + ' landed (avg fall '
        + (landed ? (fell / landed).toFixed(1) : '0') + '), finisher swept '
        + sweptIso + ' isolated; main mass ' + mainComp.length);
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

    const latentColsArr = new Int32Array(latentQuads);
    transfers.push(latentColsArr.buffer);

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
      latentCols: latentColsArr.buffer,
      latentTotal,
      latentLayer: 'dirt',
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

const Joystick = ({ onMove, onStop }: { onMove: (x: number, y: number) => void, onStop: () => void }) => {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const baseRef = useRef<HTMLDivElement>(null);
  const activeTouchId = useRef<number | null>(null);

  const processTouch = (clientX: number, clientY: number) => {
    if (!baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    const max = rect.width / 2;
    const deadZone = max * 0.15;

    if (dist < deadZone) {
      setPos({ x: 0, y: 0 });
      onMove(0, 0);
    } else {
      const clampedDist = Math.min(dist, max);
      const dirX = dx / dist;
      const dirY = dy / dist;
      setPos({ x: dirX * clampedDist, y: dirY * clampedDist });
      const effectiveRadius = max - deadZone;
      const normalized = (clampedDist - deadZone) / effectiveRadius;
      onMove(dirX * normalized, dirY * normalized);
    }
  };

  const stop = useCallback(() => {
    activeTouchId.current = null;
    setPos({ x: 0, y: 0 });
    onMove(0, 0);
    onStop();
  }, [onMove, onStop]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    const handleGlobalEnd = (e: TouchEvent) => {
      if (activeTouchId.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId.current) {
          stopRef.current();
          break;
        }
      }
    };
    const handleVis = () => { if (document.hidden) stopRef.current(); };
    window.addEventListener('touchend', handleGlobalEnd);
    window.addEventListener('touchcancel', handleGlobalEnd);
    document.addEventListener('visibilitychange', handleVis);
    return () => {
      window.removeEventListener('touchend', handleGlobalEnd);
      window.removeEventListener('touchcancel', handleGlobalEnd);
      document.removeEventListener('visibilitychange', handleVis);
    };
  }, []);

  return (
    <div 
      ref={baseRef}
      className="joystick-zone w-28 h-28 rounded-full bg-white/5 border border-white/10 flex items-center justify-center relative touch-none pointer-events-auto"
      onTouchStart={(e) => {
        if (activeTouchId.current !== null) return;
        const touch = e.changedTouches[0];
        activeTouchId.current = touch.identifier;
        processTouch(touch.clientX, touch.clientY);
      }}
      onTouchMove={(e) => {
        if (activeTouchId.current === null) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === activeTouchId.current) {
            processTouch(touch.clientX, touch.clientY);
            break;
          }
        }
      }}
      onTouchEnd={(e) => {
        if (activeTouchId.current === null) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === activeTouchId.current) {
            stop();
            break;
          }
        }
      }}
      onTouchCancel={(e) => {
        if (activeTouchId.current === null) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === activeTouchId.current) {
            stop();
            break;
          }
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div 
        className="w-10 h-10 rounded-full bg-white/20 border border-white/20"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      />
    </div>
  );
};


export {
  THREE_URL, GLTF_URL, ORBIT_URL, FP_URL, COMPOSER_URL, RENDER_PASS_URL, SSAO_PASS_URL, BLOOM_PASS_URL, SHADER_PASS_URL,
  OUTLINE_SHADER, NYC, MAX_TRIANGLES, VOXEL_METERS, MAX_WATER, TERRAIN_DEPTH, BLOCK_SCALE,
  PAL, DENSITY, densityOf, voidPhaseNow, MOVE_MS, WORKER_CODE,
  getMonthSeason, makeWorkerUrl, runWorker,
  normalizeLayerInput, encodeBase64Bytes, decodeBase64Bytes, serializeLayer, deserializeLayer, layersFromPayload, estimateCatchUp,
  Joystick,
};
export type { V3, CarryState, Weather, WorldRecord, SavedLayerPayload };
