import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { 
  Wind, Sun, CloudRain, Moon, Zap, Heart, Compass, 
  Box, Ship, Bomb, Hammer, Cpu, Crosshair, X, 
  ArrowUpCircle, Info, Save, FolderOpen, Play, 
  Eye, EyeOff, Thermometer, Clock, Camera, Maximize2, Minimize2,
  Mic, MicOff
} from "lucide-react";

const THREE_URL = "https://esm.sh/three@0.165.0";
const GLTF_URL = "https://esm.sh/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";
const ORBIT_URL = "https://esm.sh/three@0.165.0/examples/jsm/controls/OrbitControls.js";
const FP_URL = "https://esm.sh/three@0.165.0/examples/jsm/controls/PointerLockControls.js";
const COMPOSER_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js";
const RENDER_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/RenderPass.js";
const SSAO_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/SSAOPass.js";
const BLOOM_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js";
const SHADER_PASS_URL = "https://esm.sh/three@0.165.0/examples/jsm/postprocessing/ShaderPass.js";

// âââ Outline shader (Sobel on depth + normal) ââââââââââââââââââââââââââââ
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

// âââ Mass & density ladder (docs/mass-and-density.md Â§9) ââââââââââââââââââââ
// Tier 0 bloom 0.25 Â· Tier 1 loam 1 Â· Tier 2 stone 4 Â· Tier 3 metal 16 Â·
// Tier 4 densium 64 Â· Tier 5 core 256. Existing scan layers map onto tiers.
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

    // ââ Rectification pass 1: floor median smoothing ââââââââââââââââââââââââââ
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

    // ââ Rectification pass 2: wall solidification âââââââââââââââââââââââââââââ
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

    // ââ Rectification pass 3: ceiling flattening ââââââââââââââââââââââââââââââ
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

    // Underside: inverted-cone mass â deepest at the CENTER, tapering to thin rim,
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
      const isWet = false; // rain puddles disabled â confusing as "WET" layer in mining HUD
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

export default function TinyWorld() {
  const mountRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  const rendererRef = useRef<any>(null);
  const serverWorkersRef = useRef<any[]>([]);
  const composerRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const orbitRef = useRef<any>(null);
  const fpRef = useRef<any>(null);
  const rafRef = useRef<number>(0);
  const keysRef = useRef<Record<string, boolean>>({});
  const enterWalkRef = useRef<() => void>(() => {});
  const workerUrlRef = useRef<string>("");
  const groundRef = useRef<{ map: Map<string, number>; voxel: number; cx: number; cz: number; minY: number } | null>(null);
  const velocityYRef = useRef(0);
  const carryRef = useRef<CarryState | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const meshesRef = useRef<any[]>([]);
  const worldDataRef = useRef<{ layers: Record<string, Int32Array>; meta: Record<string, unknown>; blockCount: number; resolution: number } | null>(null);
  const savedWorldRef = useRef<{ id: string; name: string } | null>(null);

  // âââ Fullscreen toggle (video-player style) ââââââââââââââââââââââââââââââ
  // Native Fullscreen API silently fails in cross-origin / unprivileged
  // iframes (e.g. when this page is embedded without allow="fullscreen").
  // Video players solve this by always applying a CSS pseudo-fullscreen
  // class to a wrapper element, then attempting native FS on top as a
  // bonus. We do the same: CSS always succeeds, native may.
  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    const doc: any = document;
    const inNative = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
    const inPseudo = root.classList.contains("tw-fs");
    if (inNative || inPseudo) {
      try {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (exit && inNative) await exit.call(doc);
      } catch { /* ignore */ }
      root.classList.remove("tw-fs");
      setIsFs(false);
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      return;
    }
    root.classList.add("tw-fs");
    setIsFs(true);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    try {
      const el: any = root;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
      if (req) await req.call(el);
      const so: any = (window as any).screen?.orientation;
      if (so && typeof so.lock === "function") {
        so.lock("landscape").catch(() => undefined);
      }
    } catch { /* iframe without allow="fullscreen" â CSS path already applied */ }
  }, []);

  useEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.textContent = ".tw-fs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;background:#07070f!important;}html,body{background:#07070f!important;margin:0!important;padding:0!important;overscroll-behavior:none!important;}html,body{overflow:hidden;}";
    document.head.appendChild(styleEl);
    const onFsChange = () => {
      const doc: any = document;
      const native = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      if (!native && rootRef.current?.classList.contains("tw-fs")) {
        rootRef.current.classList.remove("tw-fs");
        setIsFs(false);
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      } else {
        setIsFs(native || !!rootRef.current?.classList.contains("tw-fs"));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const doc: any = document;
      if (doc.fullscreenElement || doc.webkitFullscreenElement) return;
      if (rootRef.current?.classList.contains("tw-fs")) {
        rootRef.current.classList.remove("tw-fs");
        setIsFs(false);
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      window.removeEventListener("keydown", onKey);
      try { document.head.removeChild(styleEl); } catch { /* already gone */ }
    };
  }, []);

  const [phase, setPhase] = useState<"idle" | "loading" | "building" | "ready">("idle");
  const [blocks, setBlocks] = useState(0);
  const [walking, setWalking] = useState(false);
  const [walkDebug, setWalkDebug] = useState<any>(null);
  const walkDebugUrlEnabledRef = useRef(false);
  if (typeof window !== "undefined" && !walkDebugUrlEnabledRef.current) {
    walkDebugUrlEnabledRef.current = new URLSearchParams(window.location.search).get("walkdebug") === "1";
  }
  const [weather, setWeather] = useState<Weather | null>(null);
  const [xray, setXray] = useState(true);
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [loadNote, setLoadNote] = useState("");
  const [sessionNote, setSessionNote] = useState("");
  const [anchor, setAnchor] = useState({ lat: NYC.lat, lon: NYC.lon });
  const anchorRef = useRef(anchor);
  useEffect(() => { anchorRef.current = anchor; }, [anchor.lat, anchor.lon]);
  const [nodeInfo, setNodeInfo] = useState<{ source: string; city: string | null; hiddenCount: number } | null>(null);
  const [moves, setMoves] = useState(0);
  const [carryLayer, setCarryLayer] = useState<string | null>(null);
  const [satiation, setSatiation] = useState(0);
  const satiationRef = useRef(0);
  const [catchUpInfo, setCatchUpInfo] = useState<any>(null);
  const riftMarkersRef = useRef<any[]>([]);

  // âââ Conservation ledger ââââââââââââââââââââââââââââââââââââââââââââââ
  // Single law: world + stockpile + built + void === baseline, always.
  // Blocks are never created or destroyed â they move between pools. VOID
  // doubles as the world's reservoir: organic growth draws from it, decay
  // returns to it. Every move is queued as a block_event and flushed in
  // batches to /api/tinyworld-worlds {action:"logEvents"}.
  type LedgerPool = "world" | "stockpile" | "built" | "void";
  const ledgerRef = useRef({ world: 0, stockpile: 0, built: 0, void: 0, baseline: 0 });
  const stockpileByLayerRef = useRef<Record<string, number>>({});
  // Refinement grades (docs/scan-economy.md): every stockpiled block has a
  // grade. Density is what the void sees; grade is what the press wants.
  type Grade = "raw" | "worked" | "pure";
  const stockGradesRef = useRef<Record<string, { raw: number; worked: number; pure: number }>>({});
  const blockGradesRef = useRef<Map<string, Grade>>(new Map());
  const scanSecondsRef = useRef(12);
  const pressPersistRef = useRef<{ built: boolean; vx: number; vz: number } | null>(null);
  const builtStructuresRef = useRef<Array<{ type: string; vx: number; vz: number; layer: string; topY: number; footprint: Array<{ dx: number; dz: number }>; builtMs: number }>>([]);
  const pendingEventsRef = useRef<Map<string, number>>(new Map());
  const lastLedgerUiRef = useRef(0);
  const [ledger, setLedger] = useState({ world: 0, stockpile: 0, built: 0, void: 0, baseline: 0 });
  const [voidUi, setVoidUi] = useState({ phase: "passive", creatures: 0, eaten: 0 });
  const [scanUi, setScanUi] = useState({ charge: 1, scans: 0 });
  const [pressUi, setPressUi] = useState({ built: false, queued: 0, refined: 0 });
  const [shipUi, setShipUi] = useState({ count: 0, flying: 0 });
  const [bombUi, setBombUi] = useState({ slugs: 0, bombs: 0, detonations: 0 });
  const [workerUi, setWorkerUi] = useState<{ name: string; mode: string; plan: string | null; error: string | null } | null>(null);
  const [targetMode, setTargetMode] = useState<null | "placeBomb" | "flyShip">(null);
  const targetModeRef = useRef<null | "placeBomb" | "flyShip">(null);
  targetModeRef.current = targetMode;
  const [showSave, setShowSave] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState<string>("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  // Temporary diagnostic panel: lets us flip each subsystem on/off in the UI
  // to pin down the cause of the screen-stable horizontal band.
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagState, setDiagState] = useState({
    ssao: true, bloom: true, outline: true, env: true, hemi: true, fog: true, under: true,
  });
  const flipDiag = (key: keyof typeof diagState) => {
    const next = !diagState[key];
    const tw = (window as any).__tw;
    if (tw?.diagBand) tw.diagBand({ [key]: next });
    setDiagState((s) => ({ ...s, [key]: next }));
  };
  const [isMobile, setIsMobile] = useState(false);
  const joystickRef = useRef({ x: 0, y: 0, active: false });
  const lookJoystickRef = useRef({ x: 0, y: 0, active: false });
  const touchLookRef = useRef({ id: -1, lastX: 0, lastY: 0, active: false });
  const mobileActionsRef = useRef({ jump: false, action: false, eat: false, droneAscend: false, droneDescend: false });
  const walkingRef = useRef(false);
  const isMobileRef = useRef(false);
  const targetLookRef = useRef({ x: 0, y: 0 });
  // Sentinel mode: "large" = MechGolem body, 4x4x4 bulk block ops.
  // "drone" = camera detaches into a free-flying drone, 1x1x1 precision ops.
  const sentinelModeRef = useRef<"large" | "drone">("large");
  const [sentinelMode, setSentinelMode] = useState<"large" | "drone">("large");
  useEffect(() => { sentinelModeRef.current = sentinelMode; }, [sentinelMode]);

  useEffect(() => {
    const checkMobile = () => {
      const mobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      setIsMobile(mobile);
      isMobileRef.current = mobile;
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const queueBlockEvent = useCallback((kind: string, count: number, source: string) => {
    const key = kind + "|" + source;
    pendingEventsRef.current.set(key, (pendingEventsRef.current.get(key) || 0) + count);
  }, []);

  const gradePool = useCallback((layer: string) => {
    const g = stockGradesRef.current;
    if (!g[layer]) g[layer] = { raw: 0, worked: 0, pure: 0 };
    return g[layer];
  }, []);
  // Lowest grade available for a layer (what placement consumes first â
  // refined matter is saved for the press unless explicitly requested).
  const lowestGrade = useCallback((layer: string): Grade => {
    const p = gradePool(layer);
    return p.raw > 0 ? "raw" : p.worked > 0 ? "worked" : p.pure > 0 ? "pure" : "raw";
  }, [gradePool]);

  const ledgerMove = useCallback((from: LedgerPool, to: LedgerPool, n: number, source: string, layer?: string, grade?: Grade) => {
    if (n <= 0 || from === to) return;
    const L = ledgerRef.current as any;
    L[from] -= n;
    L[to] += n;
    if (layer) {
      const sp = stockpileByLayerRef.current;
      if (to === "stockpile") {
        sp[layer] = (sp[layer] || 0) + n;
        gradePool(layer)[grade || "raw"] += n;
      } else if (from === "stockpile") {
        sp[layer] = Math.max(0, (sp[layer] || 0) - n);
        const p = gradePool(layer);
        for (let i = 0; i < n; i++) {
          const g = grade && p[grade] > 0 ? grade : lowestGrade(layer);
          p[g] = Math.max(0, p[g] - 1);
        }
      }
    }
    const kind = from === "world" && to === "void" ? "remove" : from === "void" && to === "world" ? "grow" : "cycle";
    if (kind === "grow" && source === "sim") {
      // Bloom feeds the scanner: only ORGANIC growth charges the scan bank
      // (docs/scan-economy.md). Scans/purges/placements also move voidâworld
      // but must not refund themselves.
      scanSecondsRef.current = Math.min(60, scanSecondsRef.current + 0.02 * n);
    }
    queueBlockEvent(kind, n, source);
    const nowMs = Date.now();
    if (nowMs - lastLedgerUiRef.current > 300) {
      lastLedgerUiRef.current = nowMs;
      setLedger({ ...ledgerRef.current });
    }
  }, [queueBlockEvent, gradePool, lowestGrade]);

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

  // Web Speech API â voice command goal-injection for villagers. Each
  // utterance overwrites every worker's goal and clears their plan so the
  // next planner tick picks up the new instruction. Browser support is
  // strongest on Safari/Chrome; silently no-ops where unavailable.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setVoiceError("not supported on this browser"); return; }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev: any) => {
      try {
        const last = ev.results[ev.results.length - 1];
        const transcript = (last?.[0]?.transcript || "").trim();
        if (!transcript) return;
        setVoiceTranscript(transcript);
        const n = (window as any).__tw?.setGoal?.(transcript);
        if (typeof n === "number") console.log("[voice] goal sent to", n, "workers:", transcript);
      } catch (e) { console.warn("[voice] result parse failed", e); }
    };
    rec.onerror = (ev: any) => {
      if (ev?.error === "no-speech" || ev?.error === "aborted") return;
      setVoiceError(ev?.error || "recognition error");
    };
    rec.onend = () => {
      // Continuous mode: restart if the user hasn't toggled off.
      if (recognitionRef.current?.shouldListen) {
        try { rec.start(); } catch {}
      } else {
        setVoiceListening(false);
      }
    };
    recognitionRef.current = rec;
    return () => {
      try { rec.stop(); } catch {}
      recognitionRef.current = null;
    };
  }, []);

  const toggleVoice = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (voiceListening) {
      rec.shouldListen = false;
      try { rec.stop(); } catch {}
      setVoiceListening(false);
    } else {
      setVoiceError(null);
      rec.shouldListen = true;
      try { rec.start(); setVoiceListening(true); }
      catch (e) { setVoiceError("could not start"); }
    }
  }, [voiceListening]);

  useEffect(() => {
    let active = true;
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      const params = new URLSearchParams(window.location.search);
      const respectOverride = params.get("nodeLat") && params.get("nodeLon");
      const noGps = params.get("nogps") === "1";
      if (respectOverride || noGps) {
        // Skip the browser prompt entirely when an override is forcing the node.
        if (!respectOverride) setAnchor({ lat: NYC.lat, lon: NYC.lon });
        return () => { active = false; };
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (!active) return;
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          setAnchor({ lat, lon });
          // Re-fetch the worlds list with real GPS coords so the API reports
          // nodeSource="gps" and the auto-load gate downstream can fire.
          fetchWorldsRef.current?.({ lat, lon }).catch(() => undefined);
        },
        () => {
          if (!active) return;
          setAnchor({ lat: NYC.lat, lon: NYC.lon });
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
      );
    }
    return () => {
      active = false;
    };
  }, []);

  const fetchWorldsRef = useRef<((gps?: { lat: number; lon: number }) => Promise<WorldRecord[]>) | null>(null);

  const fetchWorlds = useCallback(async (gps?: { lat: number; lon: number }) => {
    // Forward nodeLat/nodeLon URL params so the debug override seen by
    // the API also routes the picker â useful on VPN/coarse-geo carriers
    // and for testing from a non-NYC IP.
    const u = new URL("/api/tinyworld-worlds", window.location.origin);
    const here = new URLSearchParams(window.location.search);
    const nLat = here.get("nodeLat");
    const nLon = here.get("nodeLon");
    if (nLat) u.searchParams.set("nodeLat", nLat);
    if (nLon) u.searchParams.set("nodeLon", nLon);
    // Browser GPS â lat/lon query params; API resolves these as nodeSource="gps".
    if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)) {
      u.searchParams.set("lat", String(gps.lat));
      u.searchParams.set("lon", String(gps.lon));
    }
    const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.worlds)) {
      if (data.node) setNodeInfo({ source: data.node.source, city: data.node.city, hiddenCount: data.hiddenCount ?? 0 });
      // GLB upload is the MVP capture path. Whitelist only worlds whose name
      // matches a known GLB-import pattern; everything else (pre-seeded test
      // worlds, old geometric scans) is hidden. Override with ?showGeometric=1.
      const _showAll = !!new URLSearchParams(window.location.search).get("showGeometric");
      const _glbPattern = /^(Scaniverse|Polycam|GLB Upload|LiDAR Scan)/i;
      const _glbOnly = _showAll ? data.worlds : data.worlds.filter((w: WorldRecord) => _glbPattern.test(w.name || ""));
      setWorlds(_glbOnly);
      setSelectedWorldId((current) => current || _glbOnly.find((world: WorldRecord) => world.hasSavedBlocks)?.id || _glbOnly[0]?.id || "");
      return _glbOnly as WorldRecord[];
    }
    setWorlds([]);
    setSelectedWorldId("");
    return [] as WorldRecord[];
  }, []);

  useEffect(() => {
    fetchWorldsRef.current = fetchWorlds;
  }, [fetchWorlds]);

  useEffect(() => {
    fetchWorlds().catch(() => undefined);
  }, [fetchWorlds]);

  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (autoLoadRef.current) return;
    if (typeof window === "undefined") return;
    const wid = new URLSearchParams(window.location.search).get("world");
    if (!wid) return;
    autoLoadRef.current = true;
    setSelectedWorldId(wid);
    setLoadNote("loading captured worldâ¦");
    // Defer so the scene refs settle before the build call.
    const t = setTimeout(() => {
      onLoadSelected(wid).catch((e) => {
        setLoadNote(`load failed: ${e?.message || e}`);
        autoLoadRef.current = false;
      });
    }, 50);
    return () => clearTimeout(t);
  }, []);

  // Auto-load most-recent saved world at GPS tier: requires the browser to
  // have shared real coordinates so we know we're physically at the save.
  // Bypass with ?noauto=1.
  useEffect(() => {
    if (autoLoadRef.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("noauto") === "1") return;
    if (params.get("world")) return;
    if (phase !== "idle") return;
    if (!nodeInfo || nodeInfo.source !== "gps") return;
    const savedWorlds = worlds.filter((w) => w.hasSavedBlocks);
    if (savedWorlds.length === 0) return;
    // Prefer the most recently visited save in this geo bucket.
    const best = savedWorlds.slice().sort((a: any, b: any) =>
      (b.last_visited ?? b.last_scanned ?? 0) - (a.last_visited ?? a.last_scanned ?? 0)
    )[0];
    if (!best) return;
    autoLoadRef.current = true;
    setSelectedWorldId(best.id);
    setLoadNote(`auto-loading ${best.name} (saved here)`);
    const t = setTimeout(() => {
      onLoadSelected(best.id).catch((e) => {
        setLoadNote(`auto-load failed: ${e?.message || e}`);
        autoLoadRef.current = false;
      });
    }, 50);
    return () => clearTimeout(t);
  }, [worlds, nodeInfo, phase]);

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
    if (!data) throw new Error("nothing to save yet â scan or load a world first");
    snapshotLiveLayers();
    const playerState = { satiation: satiationRef.current };
    const ledgerState = {
      void: ledgerRef.current.void,
      built: ledgerRef.current.built,
      stockpile: ledgerRef.current.stockpile,
    };
    const chunk4State = {
      scanSeconds: Math.round(scanSecondsRef.current * 100) / 100,
      stockpileByLayer: { ...stockpileByLayerRef.current },
      stockGrades: JSON.parse(JSON.stringify(stockGradesRef.current)),
      blockGrades: Array.from(blockGradesRef.current.entries()).filter(([, g]) => g !== "raw"),
      press: pressPersistRef.current,
    };
    const meta = { ...data.meta, worldName, blockCount: data.blockCount, resolution: data.resolution, playerState, ledger: ledgerState, chunk4: chunk4State };
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

    const [THREE, orbitMod, fpMod, composerMod, renderPassMod, ssaoPassMod, bloomPassMod, shaderPassMod, weatherData] = await Promise.all([
      import(THREE_URL),
      import(ORBIT_URL),
      import(FP_URL),
      import(COMPOSER_URL),
      import(RENDER_PASS_URL),
      import(SSAO_PASS_URL),
      import(BLOOM_PASS_URL),
      import(SHADER_PASS_URL),
      fetchWeather(),
    ]);
    const gltfMod = await import(GLTF_URL);
    const { GLTFLoader } = gltfMod as any;
    const { OrbitControls } = orbitMod as any;
    const { PointerLockControls } = fpMod as any;
    const { EffectComposer } = composerMod as any;
    const { RenderPass } = renderPassMod as any;
    const { SSAOPass } = ssaoPassMod as any;
    const { UnrealBloomPass } = bloomPassMod as any;
    const { ShaderPass } = shaderPassMod as any;

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

    // ââ Ambient lighting system: 8-keyframe TOD palette (Project-Gaia inspired).
    // Continuous lerp by hour+minute so dawn/dusk get proper transition tones
    // instead of snapping. Each keyframe is spaced 3h apart, wrapping 21â00.
    const KEYFRAMES = [
      // 0 â midnight (00:00) â moonlit cloudy night, lifted blacks
      { bg: 0x101424, fog: 0x141a2c, fogD: 0.0, sun: 0xb8c8ff, sunI: 1.20, hemiS: 0x4a5890, hemiG: 0x1a1830, hemiI: 1.35, amb: 0x6a78a0, ambI: 0.95, rim: 0xff5fbd, rimI: 1.00 },
      // 1 â predawn (03:00) â moonlight warming toward cobalt
      { bg: 0x141828, fog: 0x181c30, fogD: 0.0, sun: 0x9ab0e0, sunI: 1.40, hemiS: 0x5a6898, hemiG: 0x1c1a30, hemiI: 1.50, amb: 0x6878a8, ambI: 1.00, rim: 0xc060e0, rimI: 1.00 },
      // 2 â dawn (06:00) â warm violet/peach horizon, sky still cool
      { bg: 0x4a5078, fog: 0x2a2440, fogD: 0.016, sun: 0xffb878, sunI: 2.00, hemiS: 0xffc8a0, hemiG: 0x3a2540, hemiI: 1.80, amb: 0xc8c0d8, ambI: 1.45, rim: 0x9c6fff, rimI: 0.90 },
      // 3 â golden morning (09:00) â bright sky blue, warm sun
      { bg: 0x7aa8d8, fog: 0x202c4a, fogD: 0.013, sun: 0xffd89a, sunI: 2.80, hemiS: 0xeed8b8, hemiG: 0x6a4a3a, hemiI: 2.05, amb: 0xccd0e0, ambI: 1.65, rim: 0xb0d0ff, rimI: 0.75 },
      // 4 â midday (12:00) â bright clear sky
      { bg: 0x88b8e8, fog: 0x0e1430, fogD: 0.010, sun: 0xfff0dd, sunI: 3.00, hemiS: 0xbdd4ff, hemiG: 0x8a6f50, hemiI: 2.20, amb: 0xcdd8e8, ambI: 1.75, rim: 0xb0d0ff, rimI: 0.70 },
      // 5 â golden afternoon (15:00) â sky cooling, sun warmer
      { bg: 0x7a98c8, fog: 0x281a30, fogD: 0.013, sun: 0xffc890, sunI: 2.80, hemiS: 0xf5c8a0, hemiG: 0x7a4830, hemiI: 2.05, amb: 0xc8c0c8, ambI: 1.60, rim: 0xc080ff, rimI: 0.85 },
      // 6 â dusk (18:00) â coral sun, magenta sky bleeding to deep purple
      { bg: 0x5a4068, fog: 0x251030, fogD: 0.016, sun: 0xff8866, sunI: 2.40, hemiS: 0xff9d8f, hemiG: 0x4a1a3f, hemiI: 1.85, amb: 0xc098b8, ambI: 1.40, rim: 0x9c5fff, rimI: 1.00 },
      // 7 â twilight (21:00) â purple wash with first hint of moon
      { bg: 0x141430, fog: 0x1a1830, fogD: 0.0, sun: 0xa888d0, sunI: 1.30, hemiS: 0x7a5a90, hemiG: 0x281a3a, hemiI: 1.40, amb: 0x9070b0, ambI: 1.05, rim: 0xff5fbd, rimI: 1.05 },
    ];
    const _lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
    const _lerpHex = (a: number, b: number, t: number) => {
      const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
      const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
      return (Math.round(_lerpN(ar, br, t)) << 16) | (Math.round(_lerpN(ag, bg, t)) << 8) | Math.round(_lerpN(ab, bb, t));
    };
    // ââ Real-world solar geometry. NOAA-approximation sunrise/solar-noon/sunset
    // for (lat, lon, date), so the TOD palette tracks the actual sun instead of
    // a fixed 24h schedule. Winter nights compress the day band, summer expands
    // it â TOD now respects season + latitude.
    function _solarTimes(t: number, lat: number, lon: number) {
      const J2K = Date.UTC(2000, 0, 1, 12);
      const n = (t - J2K) / 86400000;
      const Jstar = n - lon / 360;
      const D2R = Math.PI / 180;
      const M = (357.5291 + 0.98560028 * Jstar) * D2R;
      const C = (1.9148 * Math.sin(M) + 0.0200 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * D2R;
      const lam = M + C + (180 + 102.9372) * D2R;
      const Jt = Jstar + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * lam);
      const dec = Math.asin(Math.sin(lam) * Math.sin(23.44 * D2R));
      const latR = lat * D2R;
      const cosH = (Math.sin(-0.83 * D2R) - Math.sin(latR) * Math.sin(dec)) / (Math.cos(latR) * Math.cos(dec));
      const solarNoon = J2K + Jt * 86400000;
      if (cosH > 1) return { sunrise: NaN, sunset: NaN, solarNoon, polarNight: true, polarDay: false };
      if (cosH < -1) return { sunrise: NaN, sunset: NaN, solarNoon, polarNight: false, polarDay: true };
      const H = Math.acos(cosH) / (2 * Math.PI);
      return {
        sunrise: solarNoon - H * 86400000,
        sunset: solarNoon + H * 86400000,
        solarNoon,
        polarNight: false,
        polarDay: false,
      };
    }
    // Map real epoch ms â virtual TOD hour: solar midnight â 0/24, sunrise â 6,
    // solar noon â 12, sunset â 18. Piecewise-linear so the palette lerp lands
    // on dawn/dusk keyframes at the actual sun crossings.
    function _solarVirtualHour(t: number, lat: number, lon: number): number {
      const today = _solarTimes(t, lat, lon);
      if (today.polarDay) return 12;
      if (today.polarNight) return 0;
      const { sunrise, sunset, solarNoon } = today;
      const midPrev = solarNoon - 12 * 3600 * 1000;
      const midNext = solarNoon + 12 * 3600 * 1000;
      if (t < sunrise) return ((t - midPrev) / (sunrise - midPrev)) * 6;
      if (t < solarNoon) return 6 + ((t - sunrise) / (solarNoon - sunrise)) * 6;
      if (t < sunset) return 12 + ((t - solarNoon) / (sunset - solarNoon)) * 6;
      return 18 + ((t - sunset) / (midNext - sunset)) * 6;
    }
    // NOAA-approximation solar altitude + azimuth for (t, lat, lon). Returns
    // alt in radians above horizon (negative when sun is below), az in radians
    // from true north going clockwise. Used to position the directional sun
    // light so shadows track the actual sky position.
    function _solarPosition(t: number, lat: number, lon: number) {
      const J2K = Date.UTC(2000, 0, 1, 12);
      const n = (t - J2K) / 86400000;
      const D2R = Math.PI / 180;
      const L = (280.460 + 0.9856474 * n) * D2R;
      const g = (357.528 + 0.9856003 * n) * D2R;
      const lambda = L + (1.915 * D2R) * Math.sin(g) + (0.020 * D2R) * Math.sin(2 * g);
      const eps = (23.439 - 0.0000004 * n) * D2R;
      const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
      const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
      const GMST = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
      const LMST = (GMST * 15 + lon) * D2R;
      const ha = LMST - ra;
      const latR = lat * D2R;
      const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
      const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
      const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(latR)) / Math.max(1e-9, Math.cos(alt) * Math.cos(latR));
      let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
      if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
      return { alt, az };
    }
    // Direction vector (Three.js +X east, +Y up, -Z north) from solar
    // alt/az. Altitude is clamped to a minimum 8Â° above horizon so shadows
    // keep casting from above even when the sun has set â at night the TOD
    // palette dims sunI naturally, so the shadow contribution fades on its own.
    function _solarDirection(t: number, lat: number, lon: number) {
      const { alt, az } = _solarPosition(t, lat, lon);
      const clamped = Math.max(alt, 8 * Math.PI / 180);
      const cosA = Math.cos(clamped);
      return {
        x: cosA * Math.sin(az),
        y: Math.sin(clamped),
        z: -cosA * Math.cos(az),
      };
    }
    function paletteAt(hour24: number) {
      const kf = ((hour24 % 24) / 3);
      const a = Math.floor(kf) % 8;
      const b = (a + 1) % 8;
      const t = kf - Math.floor(kf);
      const A = KEYFRAMES[a], B = KEYFRAMES[b];
      return {
        bg: _lerpHex(A.bg, B.bg, t), fog: _lerpHex(A.fog, B.fog, t), fogD: _lerpN(A.fogD, B.fogD, t),
        sun: _lerpHex(A.sun, B.sun, t), sunI: _lerpN(A.sunI, B.sunI, t),
        hemiS: _lerpHex(A.hemiS, B.hemiS, t), hemiG: _lerpHex(A.hemiG, B.hemiG, t), hemiI: _lerpN(A.hemiI, B.hemiI, t),
        amb: _lerpHex(A.amb, B.amb, t), ambI: _lerpN(A.ambI, B.ambI, t),
        rim: _lerpHex(A.rim, B.rim, t), rimI: _lerpN(A.rimI, B.rimI, t),
      };
    }
    const _todToHour: Record<string, number> = { night: 0, dawn: 6, day: 12, dusk: 18 };
    const _todOv = (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tod") : null);
    const _hourNow = (_todOv && _todOv in _todToHour)
      ? _todToHour[_todOv]
      : _solarVirtualHour(Date.now(), anchor.lat, anchor.lon);
    const tod: "dawn" | "day" | "dusk" | "night" =
      _todOv && ["dawn","day","dusk","night"].includes(_todOv) ? (_todOv as any) :
      (_hourNow < 6 ? "night" : _hourNow < 9 ? "dawn" : _hourNow < 17 ? "day" : _hourNow < 20 ? "dusk" : "night");
    const tp = paletteAt(_hourNow);

    scene.background = new THREE.Color(tp.bg);
    scene.fog = null;

    const W = innerWidth;
    const H = innerHeight;
    const camera = new THREE.PerspectiveCamera(65, W / H, 0.02, 500);
    camera.position.set(span * 0.9, span * 0.55, span * 0.9);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setSize(W, H);
    // Hard voxel shadows (MagicaVoxel-style). BasicShadowMap = no PCF
    // filtering, so shadow edges align pixel-perfectly with voxel faces.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    rendererRef.current = renderer;
    mountRef.current!.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const ssaoPass = new SSAOPass(scene, camera, W, H);
    ssaoPass.kernelRadius = 24;
    ssaoPass.minDistance = 0.0008;
    ssaoPass.maxDistance = 0.04;
    composer.addPass(ssaoPass);

    const bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), 0.45, 0.5, 0.78);
    composer.addPass(bloomPass);

    // âââ Outline prepass + shader pass âââââââââââââââââââââââââââââââââââ
    // Render the scene each frame with MeshNormalMaterial as overrideMaterial
    // into normalTarget; its DepthTexture captures depth at the same time.
    // The outline ShaderPass then Sobel-samples both signals.
    //
    // Target is sized to the renderer's actual drawing buffer (pixel-ratio
    // aware) so its texels line up 1:1 with the composer's diffuse target â
    // mismatched grids cause zigzag fringing on silhouettes.
    //
    // Depth uses 32-bit UnsignedInt. 16-bit was producing visible horizontal
    // banding on far surfaces (e.g. cliff faces) because non-linear depth
    // distribution over a 0.02â500 frustum left almost no precision past ~50
    // units, and Sobel reads quantization steps as edges.
    const dbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    const normalTarget = new THREE.WebGLRenderTarget(dbSize.x, dbSize.y, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.UnsignedByteType,
    });
    normalTarget.depthTexture = new THREE.DepthTexture(dbSize.x, dbSize.y);
    normalTarget.depthTexture.type = THREE.UnsignedIntType;
    const normalMaterial = new THREE.MeshNormalMaterial();
    const outlinePass = new ShaderPass(OUTLINE_SHADER);
    outlinePass.uniforms.tNormal.value = normalTarget.texture;
    outlinePass.uniforms.tDepth.value = normalTarget.depthTexture;
    outlinePass.uniforms.resolution.value = new THREE.Vector2(dbSize.x, dbSize.y);
    outlinePass.uniforms.cameraNear.value = camera.near;
    outlinePass.uniforms.cameraFar.value = camera.far;
    outlinePass.uniforms.outlineColor.value = new THREE.Color(0x0a0a14);
    composer.addPass(outlinePass);

    // Live-tunable outline state. __tw.setOutline merges into this.
    // Default OFF â user A/B'd the band-diagnostic panel and prefers the
    // scene without the outline pass. Re-enable with __tw.setOutline({enabled:true}).
    const outlineState = { enabled: false };
    (window as any).__twOutline = {
      state: outlineState,
      pass: outlinePass,
      target: normalTarget,
      material: normalMaterial,
    };

    composerRef.current = composer;

    scene.add(new THREE.AmbientLight(tp.amb, tp.ambI));
    const hemi = new THREE.HemisphereLight(tp.hemiS, tp.hemiG, tp.hemiI);
    hemi.intensity = 0;
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(season === "winter" ? 0xc8d8ff : tp.sun, tp.sunI);
    // Initial sun direction from real solar geometry at the load-time anchor.
    {
      const d = _solarDirection(Date.now(), anchor.lat, anchor.lon);
      const r = span * 3;
      sun.position.set(d.x * r, d.y * r, d.z * r);
    }
    sun.castShadow = true;
    // Orthographic shadow frustum sized to the world. Tight bounds keep the
    // 2048Â² shadow map's texel density high so each voxel face gets a few
    // texels of shadow detail rather than blurry stair-steps.
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -span * 1.4;
    sun.shadow.camera.right = span * 1.4;
    sun.shadow.camera.top = span * 1.4;
    sun.shadow.camera.bottom = -span * 1.4;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = span * 6;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x23304f, 0.6);
    fill.position.set(-8, 4, -10);
    scene.add(fill);
    const under = new THREE.DirectionalLight(0x9a7a55, 1.2);
    under.position.set(4, -14, 6);
    under.intensity = 0;
    scene.add(under);
    // Rim light â low-angle counter-key, pops voxel silhouettes against the fog band.
    const rim = new THREE.DirectionalLight(tp.rim, tp.rimI);
    rim.position.set(-6, 6, 14);
    scene.add(rim);

    // Image-based lighting (PMREM) disabled by default â the env-map horizon
    // contributed to the screen-stable band the user diagnosed away. Re-enable
    // by running __tw.diagBand({ env: true }) in the console.
    // (PMREM env block intentionally skipped.)

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

    const REACH = voxel * 4;
    const TOOL_VISUAL_DIST = voxel * 15;
    const toolGroup = new THREE.Group();
    toolGroup.position.set(0.6 * TOOL_VISUAL_DIST, -voxel * 3.5, -TOOL_VISUAL_DIST * 0.8);
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
        width: "56px",
        height: "56px",
        marginTop: "-28px",
        marginLeft: "-28px",
        borderRadius: "50%",
        background: "conic-gradient(rgba(255,180,60,1) var(--p, 0%), rgba(255,255,255,0.08) 0)",
        mask: "radial-gradient(transparent 22px, black 23px)",
        WebkitMask: "radial-gradient(transparent 22px, black 23px)",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.15s ease",
        zIndex: "9999"
      });
      document.body.appendChild(ring);
    }

    let miningPill = document.getElementById("mining-pill");
    if (!miningPill) {
      miningPill = document.createElement("div");
      miningPill.id = "mining-pill";
      Object.assign(miningPill.style, {
        position: "fixed",
        left: "50%",
        top: "calc(50% + 44px)",
        transform: "translateX(-50%)",
        padding: "4px 10px",
        background: "rgba(255,180,60,0.18)",
        border: "1px solid rgba(255,180,60,0.7)",
        color: "rgba(255,220,150,1)",
        font: "600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
        letterSpacing: "0.08em",
        borderRadius: "999px",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.12s ease",
        zIndex: "9999",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      });
      miningPill.textContent = "MINING";
      document.body.appendChild(miningPill);
    }
    let lastChargeEndMs = 0;

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
      // Track the axis we just stepped along â that's the face we entered through.
      // Normal points back toward the camera: opposite of step on that axis.
      let lastAxis: "x" | "y" | "z" = "y";
      let lastStep = 0;
      while (dist < REACH) {
        if (tMaxX < tMaxY) {
          if (tMaxX < tMaxZ) { x += stepX; dist = tMaxX; tMaxX += tDeltaX; lastAxis = "x"; lastStep = stepX; }
          else { z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; lastAxis = "z"; lastStep = stepZ; }
        } else {
          if (tMaxY < tMaxZ) { y += stepY; dist = tMaxY; tMaxY += tDeltaY; lastAxis = "y"; lastStep = stepY; }
          else { z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; lastAxis = "z"; lastStep = stepZ; }
        }
        
        const vx = x + cxRound;
        const vy = y;
        const vz = z + czRound;
        
        const col = colMap.get(vx + "," + vz);
        if (col && col.has(vy)) {
          for (const m of meshesRef.current) {
            const slotMap = m.userData?.slotMap as Map<string, number>;
            if (slotMap && slotMap.has(vx + "," + vy + "," + vz)) {
              const nx = lastAxis === "x" ? -lastStep : 0;
              const ny = lastAxis === "y" ? -lastStep : 0;
              const nz = lastAxis === "z" ? -lastStep : 0;
              return { vx, vy, vz, mesh: m, slot: slotMap.get(vx + "," + vy + "," + vz)!, nx, ny, nz };
            }
          }
        }
      }
      return null;
    };

    // Column-top map: (vx,vz) â Set<vy>. Tracks every block's vertical position
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

    // 3D frontier helpers: the scannable/attackable surface is the whole
    // exposed boundary of the volume â a block is frontier if ANY of its 6
    // faces has an empty neighbor (up, down, under overhangs included).
    // "Floor" is never a primitive, just emergent flat geometry.
    const hasBlockAt = (vx: number, vy: number, vz: number): boolean => {
      const s = colMap.get(vx + "," + vz);
      return !!s && s.has(vy);
    };
    const FACE_DIRS: Array<[number, number, number]> = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    const exposureAt = (vx: number, vy: number, vz: number): number => {
      let n = 0;
      for (const d of FACE_DIRS) if (!hasBlockAt(vx + d[0], vy + d[1], vz + d[2])) n++;
      return n;
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

    // âââ 3D frontier (persistence-and-access.md â worlds are volumes) ââââââ
    // The frontier is ANY exposed face of the scanned volume: up, down,
    // sideways, under overhangs. "Floor" is emergent flat geometry, never a
    // primitive. Scanning claims empty cells adjacent to the frontier; the
    // void attacks exposed faces â both use these helpers.
    const solidAt = (vx: number, vy: number, vz: number): boolean => {
      const s = colMap.get(vx + "," + vz);
      return !!s && s.has(vy);
    };
    // Exposed block ys within one column (any of the 6 faces open).
    const exposedYsInColumn = (vx: number, vz: number): number[] => {
      const s = colMap.get(vx + "," + vz);
      if (!s || s.size === 0) return [];
      const out: number[] = [];
      for (const y of s) {
        for (const [dx, dy, dz] of FACE_DIRS) {
          if (!solidAt(vx + dx, y + dy, vz + dz)) { out.push(y); break; }
        }
      }
      return out;
    };
    // Sample exposed faces across the whole volume surface via random columns.
    // freeOut counts empty cells probing outward along the face normal, so
    // callers can prefer faces with open space beyond them.
    const sampleFrontierFaces = (tries = 300) => {
      const keys = Array.from(colMap.keys());
      const faces: Array<{ x: number; y: number; z: number; d: [number, number, number]; freeOut: number }> = [];
      for (let t = 0; t < tries && keys.length > 0; t++) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        const s = colMap.get(k);
        if (!s || s.size === 0) continue;
        const parts = k.split(",");
        const x = +parts[0], z = +parts[1];
        const ys = Array.from(s);
        const y = ys[Math.floor(Math.random() * ys.length)] as number;
        for (const d of FACE_DIRS) {
          if (solidAt(x + d[0], y + d[1], z + d[2])) continue;
          let freeOut = 0;
          for (let p = 1; p <= 5; p++) {
            if (!solidAt(x + d[0] * p, y + d[1] * p, z + d[2] * p)) freeOut++;
          }
          faces.push({ x, y, z, d, freeOut });
        }
      }
      return faces;
    };

    const addLayer = (buffer: ArrayBuffer | Int32Array | undefined, color: number, opacity = 1, layerName = "block", hiddenBuf?: ArrayBuffer | Int32Array) => {
      if (!buffer) return null;
      const arr = buffer instanceof Int32Array ? buffer : new Int32Array(buffer);
      const hiddenArr = hiddenBuf ? (hiddenBuf instanceof Int32Array ? hiddenBuf : new Int32Array(hiddenBuf)) : new Int32Array(0);
      if (!arr.length && !hiddenArr.length) return null;
      currentBlocks += arr.length / 3;
      const totalCap = (arr.length + hiddenArr.length) / 3;
      let material: any;
      if (layerName === "leaves") {
        // Lambert variant (Project-Gaia learning): per-vertex shading reads
        // as painterly on organic clumped geometry. Lit, but no env reflection.
        material = new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity });
      } else {
        const stdMat = new THREE.MeshStandardMaterial({ color, roughness: opacity < 1 ? 0.35 : 0.88, metalness: 0.02, transparent: opacity < 1, opacity });
        if (layerName === "water") {
          // Schlick fresnel modulates ALPHA (not reflectance): water becomes
          // opaque at grazing angles, transparent looking straight down.
          stdMat.onBeforeCompile = (shader: any) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              "#include <output_fragment>",
              `float _dotNV = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
               float _fresnel = exp2((-5.55473 * _dotNV - 6.98316) * _dotNV);
               #include <output_fragment>
               gl_FragColor.a = mix(gl_FragColor.a, 1.0, _fresnel);`
            );
          };
        }
        material = stdMat;
      }

      // ââ Cross-layer global occupancy (Project-Gaia #1 v2) ââ
      // Single Set rebuilt once before any addLayer call, covers visible +
      // hidden blocks across every terrain layer. AO baking inside addLayer
      // reads from this so corners between e.g. dirt and wall darken correctly.
      const _globalOcc = new Set<string>();
      const _aoLayerKeys = ["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling","hidden_dirt","fruit","seed","sapling"];
      for (const _k of _aoLayerKeys) {
        const _buf = (layers as any)[_k];
        if (!_buf) continue;
        const _a = _buf instanceof Int32Array ? _buf : new Int32Array(_buf);
        for (let i = 0; i < _a.length; i += 3) _globalOcc.add(_a[i] + "," + _a[i+1] + "," + _a[i+2]);
      }

      // ââ Per-vertex corner AO bake helper (Minecraft-style) ââ
      // Aplied per face per vertex. Each cube vertex sees 3 neighbor voxels:
      // two edge-side neighbors and one corner neighbor. Returns 24 floats
      // (6 faces * 4 vertices) in 0..1, where 0 is fully occluded.
      const FACE_NORMS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      const FACE_TANGENT_AXES: ("x"|"y"|"z")[][] = [["y","z"],["y","z"],["x","z"],["x","z"],["x","y"],["x","y"]];
      const _occHas = (x: number, y: number, z: number) => _globalOcc.has(x + "," + y + "," + z);
      function _computeVertexAOs(vx: number, vy: number, vz: number, out: Float32Array) {
        for (let f = 0; f < 6; f++) {
          const n = FACE_NORMS[f];
          const ax = FACE_TANGENT_AXES[f];
          for (let v = 0; v < 4; v++) {
            const u1 = (v & 1) ? 1 : -1;
            const u2 = (v & 2) ? 1 : -1;
            let s1dx = 0, s1dy = 0, s1dz = 0;
            let s2dx = 0, s2dy = 0, s2dz = 0;
            if (ax[0] === "x") s1dx = u1; else if (ax[0] === "y") s1dy = u1; else s1dz = u1;
            if (ax[1] === "x") s2dx = u2; else if (ax[1] === "y") s2dy = u2; else s2dz = u2;
            const side1 = _occHas(vx + n[0] + s1dx, vy + n[1] + s1dy, vz + n[2] + s1dz) ? 1 : 0;
            const side2 = _occHas(vx + n[0] + s2dx, vy + n[1] + s2dy, vz + n[2] + s2dz) ? 1 : 0;
            const corner = _occHas(vx + n[0] + s1dx + s2dx, vy + n[1] + s1dy + s2dy, vz + n[2] + s1dz + s2dz) ? 1 : 0;
            const ao = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner);
            out[f * 4 + v] = ao / 3;
          }
        }
      }
      // Pre-bake per-vertex aoIdx attribute on a cube geometry (which face+vertex
      // each of the 24 cube vertices belongs to). Computed from box.normal/position
      // so it's robust to Three.js's internal vertex order.
      function _bakeAOIdxAttr(geo: any) {
        const pos = geo.attributes.position, nor = geo.attributes.normal;
        const idxArr = new Float32Array(pos.count);
        for (let i = 0; i < pos.count; i++) {
          const nx = Math.round(nor.getX(i)), ny = Math.round(nor.getY(i)), nz = Math.round(nor.getZ(i));
          let face = 0;
          if (nx === 1) face = 0; else if (nx === -1) face = 1;
          else if (ny === 1) face = 2; else if (ny === -1) face = 3;
          else if (nz === 1) face = 4; else face = 5;
          const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
          let v: number;
          if (face === 0 || face === 1) v = ((py >= 0 ? 1 : 0) | (pz >= 0 ? 2 : 0));
          else if (face === 2 || face === 3) v = ((px >= 0 ? 1 : 0) | (pz >= 0 ? 2 : 0));
          else v = ((px >= 0 ? 1 : 0) | (py >= 0 ? 2 : 0));
          idxArr[i] = face * 4 + v;
        }
        geo.setAttribute("aoIdx", new THREE.BufferAttribute(idxArr, 1));
      }

      // ââ Per-vertex baked AO (Project-Gaia #1 v2: corner-vertex Minecraft style) ââ
      // Computes side1/side2/corner occupancy per face-vertex across ALL layers
      // (cross-layer occupancy via _globalOcc). 6 vec4 InstancedBufferAttributes
      // carry the 24 per-vertex AO values; the vertex shader picks the right
      // one via the baked aoIdx attribute. Result: smooth corner-darkening
      // bands across faces, the canonical Minecraft AO look.
      const _aoTmp = new Float32Array(24);
      const _aoF: Float32Array[] = [];
      for (let f = 0; f < 6; f++) _aoF.push(new Float32Array(totalCap * 4));
      let _aoIdx2 = 0;
      const _writeAOPerVertex = (x: number, y: number, z: number) => {
        _computeVertexAOs(x, y, z, _aoTmp);
        for (let f = 0; f < 6; f++) {
          const off = _aoIdx2 * 4;
          _aoF[f][off + 0] = _aoTmp[f * 4 + 0];
          _aoF[f][off + 1] = _aoTmp[f * 4 + 1];
          _aoF[f][off + 2] = _aoTmp[f * 4 + 2];
          _aoF[f][off + 3] = _aoTmp[f * 4 + 3];
        }
        _aoIdx2++;
      };
      for (let i = 0; i < arr.length; i += 3) _writeAOPerVertex(arr[i], arr[i + 1], arr[i + 2]);
      for (let i = 0; i < hiddenArr.length; i += 3) _writeAOPerVertex(hiddenArr[i], hiddenArr[i + 1], hiddenArr[i + 2]);

      const _aoGeo = box.clone();
      _bakeAOIdxAttr(_aoGeo);
      for (let f = 0; f < 6; f++) {
        _aoGeo.setAttribute("aoF" + f, new THREE.InstancedBufferAttribute(_aoF[f], 4));
      }

      if (layerName !== "water") {
        const _prevCompile = material.onBeforeCompile;
        material.onBeforeCompile = (shader: any) => {
          if (_prevCompile) _prevCompile.call(material, shader);
          shader.vertexShader =
            "attribute vec4 aoF0;\nattribute vec4 aoF1;\nattribute vec4 aoF2;\nattribute vec4 aoF3;\nattribute vec4 aoF4;\nattribute vec4 aoF5;\nattribute float aoIdx;\nvarying float vAoPerVert;\n"
            + shader.vertexShader.replace(
              "#include <begin_vertex>",
              `int _ai = int(aoIdx + 0.5);
               int _face = _ai / 4;
               int _vert = _ai - _face * 4;
               vec4 _fAo;
               if (_face == 0) _fAo = aoF0;
               else if (_face == 1) _fAo = aoF1;
               else if (_face == 2) _fAo = aoF2;
               else if (_face == 3) _fAo = aoF3;
               else if (_face == 4) _fAo = aoF4;
               else _fAo = aoF5;
               vAoPerVert = _fAo[_vert];
               #include <begin_vertex>`
            );
          shader.fragmentShader =
            "varying float vAoPerVert;\n"
            + shader.fragmentShader.replace(
              "#include <output_fragment>",
              "gl_FragColor.rgb *= mix(0.45, 1.0, vAoPerVert);\n#include <output_fragment>"
            );
        };
      }

      const mesh = new THREE.InstancedMesh(_aoGeo, material, totalCap);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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
      // Stash hidden positions in spare slots with zero-scale matrices â ready to reveal.
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
    if (wallUpperMesh) { wallUpperMesh.material.transparent = false; wallUpperMesh.material.depthWrite = true; wallUpperMesh.material.opacity = 1; }
    if (ceilingMesh) { ceilingMesh.material.transparent = false; ceilingMesh.material.depthWrite = true; ceilingMesh.material.opacity = 1; }
    fadeMeshesRef.current = { ceiling: ceilingMesh, wallUpper: wallUpperMesh };

    // âââ Organic lifecycle scaffolding âââââââââââââââââââââââââââââââââââââ
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
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.04, transparent: opacity < 1, opacity });
      const mesh = new THREE.InstancedMesh(customGeo || box, material, cap);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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

    // Universal spawn/despawn helpers â work for ANY mesh that has the
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
      blockGradesRef.current.delete(k);
      removeCol(vx, vy, vz);
      ledgerMove("world", "void", 1, source);
      protAdd(vx, vz, mesh.userData.layer, -1);
      return true;
    };

    // âââ Local protection field (Chunk 3 â mass-and-density.md Â§3) ââââââââ
    // Coarse 2D cell grid (P_CELL Ã P_CELL columns). Each cell holds the
    // summed density-mass of every block in its columns. Protection at a
    // column = Î£ nearby cellMass / (1 + dÂ²) â gravity-style falloff. The
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

    // âââ Organic lifecycle state + tick ââââââââââââââââââââââââââââââââââââ
    // organicLife: pos-key â { kind, since, onTree? }. Only mid-lifecycle
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
            // Already resting on something â flip onTree off, reset timer.
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
            // Not on soil â reset timer so it tries again later.
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

    // âââ Offline Catch-up Simulation âââââââââââââââââââââââââââââââââââââââ
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
          // weakestFrontier is declared later in this effect and is not yet
          // initialized when catch-up runs at load â inline the frontier pick.
          const perim: Array<{ vx: number; vz: number }> = [];
          for (const k of colMap.keys()) {
            const cs = colMap.get(k);
            if (!cs || cs.size === 0) continue;
            const parts = k.split(",");
            const vx = +parts[0], vz = +parts[1];
            let open = false;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const ncs = colMap.get((vx + dx) + "," + (vz + dz));
              if (!ncs || ncs.size === 0) { open = true; break; }
            }
            if (!open) {
              let yMin = Infinity, yMax = -Infinity;
              for (const y of cs) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
              if (cs.size < yMax - yMin + 1) open = true;
            }
            if (open) perim.push({ vx, vz });
          }
          let rift: { vx: number; vy: number; vz: number } | null = null;
          let worstP = Infinity;
          const rStride = Math.max(1, Math.floor(perim.length / 600));
          for (let i = 0; i < perim.length; i += rStride) {
            const { vx, vz } = perim[i];
            let maxExp = 1, bestY = 0, first = true;
            const cs = colMap.get(vx + "," + vz);
            if (cs) for (const y of cs) {
              const e = exposureAt(vx, y, vz);
              if (first || e > maxExp || (e === maxExp && y > bestY)) { maxExp = Math.max(e, 1); bestY = y; first = false; }
            }
            const p = protectionAt(vx, vz) / (1 + 0.5 * (maxExp - 1));
            if (p < worstP) { worstP = p; rift = { vx, vy: bestY, vz }; }
          }
          if (rift) {
            riftPos = { x: rift.vx, y: rift.vy, z: rift.vz };
            
            const queue = [{vx: rift.vx, vy: rift.vy, vz: rift.vz, dist: 0}];
            const seen = new Set<string>();
            seen.add(rift.vx + "," + rift.vy + "," + rift.vz);
            let head = 0;
            
            while (head < queue.length && actualVoidLoss < est.voidLoss) {
              const curr = queue[head++];
              let foundMesh = null;
              for (const m of meshesRef.current) {
                if (m.userData?.slotMap?.has(curr.vx + "," + curr.vy + "," + curr.vz)) {
                  foundMesh = m;
                  break;
                }
              }
              if (foundMesh) {
                if (removeBlockFrom(foundMesh, curr.vx, curr.vy, curr.vz, "void_catchup")) {
                  actualVoidLoss++;
                  if (actualVoidLoss < est.voidLoss) queue.push(curr);
                }
              }
              
              if (actualVoidLoss < est.voidLoss) {
                for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                  const nx = curr.vx + dx, ny = curr.vy + dy, nz = curr.vz + dz;
                  const nk = nx + "," + ny + "," + nz;
                  if (!seen.has(nk)) {
                    const s = colMap.get(nx + "," + nz);
                    if (s && s.has(ny)) {
                      seen.add(nk);
                      queue.push({vx: nx, vy: ny, vz: nz, dist: curr.dist + 1});
                    }
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
      riftGroup.position.set((x - cxRound) * voxel, y * voxel, (z - czRound) * voxel);
      
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
      // Saved worlds don't persist the voxelizer's ground layer â rebuild a
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
    let groundMinY = Infinity;
    for (const y of groundMap.values()) {
      if (y < groundMinY) groundMinY = y;
    }
    if (!isFinite(groundMinY)) groundMinY = 0;
    groundRef.current = { map: groundMap, voxel, cx: cxRound, cz: czRound, minY: groundMinY };

    // Seam visualization: mark outer-perimeter top blocks with a subtle void-tint
    // so players can see where their scanned territory ends. Foundation for the
    // tectonic-risk overlay: these are the cells where new adjacent scans will
    // cause seam reconciliation. Top-of-column only, so the world reads as a
    // ring of glowing edge from above rather than a wrapped halo on every face.
    const perimeterTopCells: Array<{ vx: number; vz: number; vy: number }> = [];
    for (const [k, cs] of colMap) {
      if (!cs || cs.size === 0) continue;
      const [vx, vz] = k.split(",").map(Number);
      let onEdge = false;
      for (const nb of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ncs = colMap.get((vx + nb[0]) + "," + (vz + nb[1]));
        if (!ncs || ncs.size === 0) { onEdge = true; break; }
      }
      if (!onEdge) continue;
      const vy = groundMap.get(k);
      if (vy === undefined) continue;
      perimeterTopCells.push({ vx, vz, vy });
    }
    if (perimeterTopCells.length > 0) {
      const seamMat = new THREE.MeshPhongMaterial({ color: 0x8a2be2, emissive: 0x4a1080, emissiveIntensity: 0.35, transparent: true, opacity: 0.28, shininess: 8, depthWrite: false });
      const seamMesh = new THREE.InstancedMesh(box, seamMat, perimeterTopCells.length);
      seamMesh.renderOrder = 2;
      for (let i = 0; i < perimeterTopCells.length; i++) {
        const cell = perimeterTopCells[i];
        dummy.position.set((cell.vx - cxRound) * voxel, cell.vy * voxel, (cell.vz - czRound) * voxel);
        dummy.scale.set(1.05, 1.05, 1.05);
        dummy.updateMatrix();
        seamMesh.setMatrixAt(i, dummy.matrix);
      }
      dummy.scale.set(1, 1, 1);
      seamMesh.instanceMatrix.needsUpdate = true;
      seamMesh.userData.isSeamOverlay = true;
      scene.add(seamMesh);
      (window as any).__tw = { ...((window as any).__tw || {}), seamMesh, perimeterCount: perimeterTopCells.length };
      console.log("[tinyworld] seam visualization:", perimeterTopCells.length, "perimeter top cells");
    }

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
      walkingRef.current = true;
      orbit.enabled = false;
    });
    fp.addEventListener("unlock", () => {
      if (isMobileRef.current) return;
      setWalking(false);
      walkingRef.current = false;
      orbit.enabled = true;
    });

    enterWalkRef.current = () => {
      let sx = 0, sz = 0, sy = EYE_HEIGHT;
      const ground = groundRef.current;
      let placed = false;
      let path: string = "default-origin";

      if (!placed && ground && ground.map.size > 0) {
        let sumX = 0, sumZ = 0, n = 0;
        for (const k of ground.map.keys()) {
          const [vx, vz] = k.split(",").map(Number);
          sumX += vx; sumZ += vz; n++;
        }
        const cx = sumX / n, cz = sumZ / n;
        let bestD2 = Infinity;
        let bestSpawn: { sx: number; sz: number; sy: number } | null = null;
        let lowestY = Infinity;
        let lowestPos: { wx: number; wz: number; gy: number } | null = null;
        for (const [k, vy] of ground.map) {
          const [vx, vz] = k.split(",").map(Number);
          const wx = (vx - ground.cx) * ground.voxel;
          const wz = (vz - ground.cz) * ground.voxel;
          if (vy < lowestY) {
            lowestY = vy;
            lowestPos = { wx, wz, gy: (vy + 1) * ground.voxel };
          }
          const dx = vx - cx, dz = vz - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= bestD2) continue;
          const clearY = findSafeSpawnY(wx, wz);
          if (clearY === null) continue;
          bestD2 = d2;
          bestSpawn = { sx: wx, sz: wz, sy: clearY };
        }
        if (bestSpawn) {
          sx = bestSpawn.sx; sz = bestSpawn.sz; sy = bestSpawn.sy;
          placed = true;
          path = "centroid-clear";
        } else if (lowestPos) {
          sx = lowestPos.wx;
          sz = lowestPos.wz;
          sy = lowestPos.gy + EYE_HEIGHT;
          placed = true;
          path = "lowest-floor";
        }
      }

      if (!placed && workers.length > 0 && ground) {
        const w = workers[0];
        const wx = w.worldX;
        const wz = w.worldZ;
        sx = wx;
        sz = wz;
        const surfaceY = sampleGround(wx, wz, undefined, playerR);
        sy = (surfaceY > 0 ? surfaceY : w.worldY) + EYE_HEIGHT;
        placed = true;
        path = "worker-fallback";
      }
      const prevCam = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      camera.position.set(sx, sy, sz);
      velocityYRef.current = 0;
      camera.rotation.set(0, 0, 0);
      // Look toward the world centroid (or origin) rather than -z, so the
      // first frame in walk mode actually shows the loft instead of the void.
      let lookX = 0, lookZ = 0;
      if (ground && ground.map.size > 0) {
        let sumX = 0, sumZ = 0, n = 0;
        for (const k of ground.map.keys()) {
          const [vx, vz] = k.split(",").map(Number);
          sumX += vx; sumZ += vz; n++;
        }
        const cvx = sumX / n, cvz = sumZ / n;
        lookX = (cvx - ground.cx) * ground.voxel;
        lookZ = (cvz - ground.cz) * ground.voxel;
      }
      const dx = lookX - sx, dz = lookZ - sz;
      if (dx * dx + dz * dz > 0.0001) {
        camera.lookAt(lookX, sy, lookZ);
      } else {
        camera.lookAt(sx, sy, sz - 1);
      }

      targetLookRef.current = { x: camera.rotation.x, y: camera.rotation.y };

      (window as any).__twWalkDebug = {
        path,
        placed,
        spawn: { sx, sy, sz },
        prevCam,
        camAfter: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        workers: workers.length,
        groundSize: ground ? ground.map.size : 0,
        isMobile: isMobileRef.current,
        voxel,
        eyeH: EYE_HEIGHT,
        sampledSurfaceY: ground ? sampleGround(sx, sz, undefined, playerR) : null,
        ts: Date.now(),
      };
      setWalkDebug((window as any).__twWalkDebug);

      setWalking(true);
      walkingRef.current = true;
      orbit.enabled = false;
      if (!isMobileRef.current) {
        try { fp.lock(); } catch (e) { console.warn("Pointer lock failed:", e); }
      }
    };

    // Player physics scaled to voxel size â you're tiny-world sized, not human sized.
    const EYE_HEIGHT = voxel * 3.5;
    // Walk mode lifts the camera by this much so the player looks out from
    // ~sentinel eye-level (sentinel â 13.5v tall, eyes â 11.5v above feet,
    // so lift â 11.5 â EYE_HEIGHT). Sentinel feet still anchor to the
    // actual ground; only the camera's Y target is raised.
    const WALK_CAMERA_LIFT = voxel * 8;
    const MOVE_SPEED = voxel * 8;
    const JUMP_VELOCITY = voxel * 18;
    const GRAVITY = voxel * 55;

    // Sample ground height at world (x, z) â returns world Y of floor top.
    // footWY (optional): current foot height â columns whose top is more than
    // ~1.15 voxels above the feet are ignored, so tall neighbors (walls,
    // stacks) can't yank the sample upward while walking on top of objects.
    // radius (optional, world units): how far around (wx, wz) to consider
    // columns â pass the body radius so only columns the body actually
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
          if (footWY !== undefined && (y + 1) * v > footWY + v * 1.6) continue;
          if (best === null || y > best) best = y;
        }
      }
      if (best === null && bestAny === null) {
        // Nothing under the body at all â fall back to the 3x3 neighborhood
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
    // for any block overlap above the step-up tolerance â blocks at the
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

    // Same cylinder test as isBlockedAt but at an arbitrary world Y â used by
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

    // âââ Tiny Worker v1: AI NPC that paths via A* and moves soft blocks âââââ
    // One character per world. Picks up grass/dirt/leaves/fruit/snow/dryGrass
    // from somewhere within ~30 voxels, walks them to a random walkable cell,
    // places them. Slow tick (~250ms) for decisions/cell-step. Per-frame
    // render lerp for smooth motion. Conservation-respecting â uses the same
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

    // 3D A* pathfinding. Finds a path across any walkable block (block with empty space above it).
    // Can step up/down by 1 voxel.
    const aStarOnGround = (sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, maxIter = 1500): Array<[number, number, number]> | null => {
      const startKey = sx + "," + sy + "," + sz;
      const goalKey = gx + "," + gy + "," + gz;
      const gScore = new Map<string, number>();
      const parent = new Map<string, string | null>();
      const open = new Set<string>();
      const h = (x: number, y: number, z: number) => Math.abs(x - gx) + Math.abs(y - gy) + Math.abs(z - gz);
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
          const f = g + h(+cs[0], +cs[1], +cs[2]);
          if (f < bestF) { bestF = f; bestKey = k; }
        }
        if (!bestKey) return null;
        if (bestKey === goalKey) {
          const path: Array<[number, number, number]> = [];
          let k: string | null = bestKey;
          while (k) {
            const cs = k.split(",");
            path.push([+cs[0], +cs[1], +cs[2]]);
            k = parent.get(k) ?? null;
          }
          path.reverse();
          return path;
        }
        open.delete(bestKey);
        const cs = bestKey.split(",");
        const cx = +cs[0], cy = +cs[1], cz = +cs[2];
        const curG = gScore.get(bestKey)!;
        const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dz] of dirs) {
          const nx = cx + dx, nz = cz + dz;
          const ncol = colMap.get(nx + "," + nz);
          if (!ncol) continue;
          // Look for walkable heights near cy
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (!ncol.has(ny)) continue;
            // Must have air above it to walk on
            if (ncol.has(ny + 1) || ncol.has(ny + 2)) continue;
            const nk = nx + "," + ny + "," + nz;
            const tg = curG + 1 + Math.abs(dy); // Stepping up/down costs a bit more
            if (tg < (gScore.get(nk) ?? Infinity)) {
              gScore.set(nk, tg);
              parent.set(nk, bestKey);
              open.add(nk);
            }
          }
        }
      }
      return null;
    };
    const findSourceBlockForLayer = (vx: number, vy: number, vz: number, layer: string, r = 30) => {
      const cands: Array<{ vx: number; vy: number; vz: number; mesh: any; slot: number; d2: number }> = [];
      for (const [colKey, ySet] of colMap) {
        const cs = colKey.split(",");
        const cx = +cs[0], cz = +cs[1];
        const dx = cx - vx, dz = cz - vz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r) continue;
        // Check all heights in the column
        for (const y of ySet) {
          if (Math.abs(y - vy) > r) continue;
          const k = cx + "," + y + "," + cz;
          for (const m of meshesRef.current) {
            const slot = (m.userData?.slotMap as Map<string, number> | undefined)?.get(k);
            if (slot !== undefined && m.userData.layer === layer) {
              // Soft block must be exposed on top to pick it up easily
              if (!ySet.has(y + 1)) {
                cands.push({ vx: cx, vy: y, vz: cz, mesh: m, slot, d2: d2 + (y - vy) * (y - vy) });
              }
              break;
            }
          }
        }
      }
      if (!cands.length) return null;
      cands.sort((a, b) => a.d2 - b.d2);
      const slice = cands.slice(0, Math.max(1, Math.ceil(cands.length / 3)));
      return slice[Math.floor(Math.random() * slice.length)];
    };

    const findAdjacentWalkableW = (vx: number, vy: number, vz: number): [number, number, number] | null => {
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[0,0]]) {
        const nx = vx + dx;
        const nz = vz + dz;
        const col = colMap.get(nx + "," + nz);
        if (!col) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = vy + dy;
          if (col.has(ny) && !col.has(ny + 1) && !col.has(ny + 2)) {
            return [nx, ny, nz];
          }
        }
      }
      return null;
    };

    const randomGroundCellNearW = (vx: number, vy: number, vz: number, r: number): [number, number, number] | null => {
      const cands: Array<[number, number, number]> = [];
      for (const [colKey, ySet] of colMap) {
        const cs = colKey.split(",");
        const x = +cs[0], z = +cs[1];
        if (Math.abs(x - vx) > r || Math.abs(z - vz) > r) continue;
        if (x === vx && z === vz) continue;
        for (const y of ySet) {
          if (Math.abs(y - vy) > r) continue;
          if (!ySet.has(y + 1) && !ySet.has(y + 2)) {
            cands.push([x, y, z]);
          }
        }
      }
      if (!cands.length) return null;
      return cands[Math.floor(Math.random() * cands.length)];
    };

    // âââ LLM-driven planning ââââââââââââââââââââââââââââââââââââââââââââââââ
    // When idle, a worker fetches a small build plan from /api/tinyworld-plan
    // (Gemini 2.5 Flash-Lite). The plan is a list of primitive shapes which
    // we expand to a sorted target-block list. Worker then executes each
    // target: pickup matching layer â A* walk â place. Plan re-fetched
    // whenever the current one finishes or fails.
    type PlanTarget = { vx: number; vz: number; layer: string; localY: number; done: boolean };
    type WorkerPlan = { name: string; rationale: string; actions: GoapAction[] };

    const computeVisionFor = (vx: number, vy: number, vz: number, R = 25) => {
      const resources: Record<string, number> = {};
      for (const layer of SOFT_WORKER_LAYERS) resources[layer] = 0;
      for (const m of meshesRef.current) {
        const layer = m.userData?.layer;
        if (!SOFT_WORKER_LAYERS.has(layer)) continue;
        const slotMap = m.userData?.slotMap as Map<string, number> | undefined;
        if (!slotMap) continue;
        for (const k of slotMap.keys()) {
          const cs = k.split(",");
          const x = +cs[0], y = +cs[1], z = +cs[2];
          const dx = x - vx, dy = y - vy, dz = z - vz;
          if (dx * dx + dy * dy + dz * dz > R * R) continue;
          resources[layer] = (resources[layer] || 0) + 1;
        }
      }
      const walkable: Array<[number, number, number]> = [];
      for (const [colKey, ySet] of colMap) {
        const cs = colKey.split(",");
        const x = +cs[0], z = +cs[1];
        for (const y of ySet) {
          if (!ySet.has(y + 1)) {
            const dx = x - vx, dy = y - vy, dz = z - vz;
            if (dx * dx + dy * dy + dz * dz <= R * R) walkable.push([x, y, z]);
          }
        }
      }
      const stockpile = { ...stockpileByLayerRef.current };
      const structures: any[] = [];
      if (pressPersistRef.current?.built) {
        structures.push({ type: "press", vx: pressPersistRef.current.vx, vz: pressPersistRef.current.vz });
      }
      const recent = builtStructuresRef.current.slice(-8);
      for (const s of recent) {
        structures.push({
          type: s.type,
          vx: s.vx,
          vz: s.vz,
          layer: s.layer,
          topY: s.topY,
          footprint: s.footprint,
        });
      }
      return { resources, walkable, stockpile, structures };
    };

    type GoapAction = { action: "PickUp" | "Place" | "MoveTo" | "Interact" | "Mine" | "Build"; layer?: string; target?: string; vx?: number; vz?: number; structure?: "pillar" | "wall" | "hut" | "arch" | "cap" | "tower" | "ring"; blueprint?: Array<{ dx: number; dy: number; dz: number }>; done?: boolean };

    const fetchWorkerPlan = async (w: WorkerState, opts: { stuck?: boolean } = {}): Promise<WorkerPlan | null> => {
      try {
        const vision = computeVisionFor(w.vx, w.vy, w.vz, 25);
        const body: any = { 
          worker: { vx: w.vx, vy: w.vy, vz: w.vz, holding: w.carrying?.layer || null, name: w.name, archetype: w.archetype, goal: w.goal }, 
          vision 
        };
        if (opts.stuck) {
          body.stuck = true;
          const neighborHeights: Record<string, number | null> = {};
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
            const key = `${dx},${dz}`;
            const top = colTop(w.vx + dx, w.vz + dz);
            neighborHeights[key] = top;
          }
          body.stuckContext = {
            position: { vx: w.vx, vy: w.vy, vz: w.vz },
            currentColumnTop: colTop(w.vx, w.vz),
            cardinalNeighborTops: neighborHeights,
            note: "No cardinal neighbor has a column top within Â±1 of my elevation. I need to descend.",
          };
        }
        const r = await fetch("/api/tinyworld-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!data?.ok || !Array.isArray(data?.plan?.actions)) {
          console.warn("[tinyworld] worker plan rejected:", r.status, data?.error || data);
          (w as any).lastPlanError = data?.error || ("http " + r.status);
          return null;
        }
        (w as any).lastPlanError = null;
        return {
          name: String(data.plan.name || "untitled"),
          rationale: String(data.plan.rationale || ""),
          actions: data.plan.actions.map((a: any) => ({ ...a, done: false })),
        };
      } catch (err) {
        console.warn("[tinyworld] worker plan fetch failed:", err);
        (w as any).lastPlanError = String(err);
        return null;
      }
    };

    type WorkerState = {
      id: string;
      vx: number; vy: number; vz: number;
      targetVX: number; targetVY: number; targetVZ: number;
      worldX: number; worldY: number; worldZ: number;
      moveStartMs: number; moveEndMs: number;
      path: number[][]; pathIdx: number;
      mode: "idle" | "walking" | "picking" | "placing" | "mining" | "stuck";
      modeStartMs: number;
      carrying: { mesh: any; color: any; layer: string } | null;
      pickupTarget: { vx: number; vy: number; vz: number; mesh: any; slot: number } | null;
      placeTarget: { vx: number; vy: number; vz: number; mesh: any; slot: number } | null;
      group: any;
      carriedMesh: any;
      plan: any | null;
      planRequested: boolean;
      lastPlanFailMs: number;
    };
    const workers: WorkerState[] = [];

    // Build the visual mesh group for a worker. Style is read at construction
    // time from __tw.workerStyle. The "tars" style is a feature flag for the
    // monolith-slab worker (Interstellar TARS-inspired). Stashes refs on
    // group.userData so the animation block can find the parts cleanly
    // without indexing children by position.
    const buildWorkerVisual = (style: "humanoid" | "tars" | "ghibli") => {
      const group = new THREE.Group();
      let carried: any;
      if (style === "ghibli") {
        // High-resolution voxel chibi character (~2 voxels tall).
        // Based on the provided reference image: brown bob hair, white/red/blue jacket,
        // dark skirt, high red socks, pink shoes.
        const u = voxel / 16;                            // sub-voxel unit
        const feetY = -voxel * 1.1;                      // matches per-frame root offset

        // Materials: bodyMat is white so per-instance colors come through
        // directly. eyeMat is emissive for the eyes.
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
        const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xaa4444, emissiveIntensity: 1.0, roughness: 1, metalness: 0 });
        const cubeGeo = new THREE.BoxGeometry(u, u, u);

        // ââ Palette ââ
        const SKIN       = 0xffeedd;
        const SKIN_SHADE = 0xe5c7a8;
        const SHIRT      = 0xffffff;
        const J_WHITE    = 0xe8e8e8;
        const J_RED      = 0xd96655;
        const J_BLUE     = 0x5588cc;
        const SKIRT      = 0x2b2b2b;
        const SOCKS      = 0xba4a4a;
        const SHOES      = 0xe899aa;
        const HAIR       = 0x4a3b32;
        const HAIR_HI    = 0x5a4a40;
        const LIP        = 0xcc7766;

        type CubeDef = { x: number; y: number; z: number; color: number };
        const rootC: CubeDef[] = [];
        const eyeC:  CubeDef[] = [];
        const armLC: CubeDef[] = [];
        const armRC: CubeDef[] = [];
        const legLC: CubeDef[] = [];
        const legRC: CubeDef[] = [];

        // Fill a half-open rectangular region with sub-voxel cubes (no dedupe;
        // later writes paint over earlier writes via add order, which is what
        // gives us the cheek/lip/belt overlay details).
        const fill = (
          arr: CubeDef[], color: number,
          x0: number, x1: number, y0: number, y1: number, z0: number, z1: number
        ) => {
          for (let x = x0; x < x1; x++)
            for (let y = y0; y < y1; y++)
              for (let z = z0; z < z1; z++) arr.push({ x, y, z, color });
        };

        // ââ BODY (sub-voxel coords; y=0 is feet bottom, +z = forward) ââ
        // Skirt (hip block)
        fill(rootC, SKIRT, -4, 5, 8, 13, -3, 4);

        // Torso / shirt
        fill(rootC, SHIRT, -3, 4, 13, 20, -2, 3);
        // Jacket sides (white)
        fill(rootC, J_WHITE, -4, -3, 13, 20, -3, 4);
        fill(rootC, J_WHITE,  4,  5, 13, 20, -3, 4);
        // Jacket back
        fill(rootC, J_WHITE, -3, 4, 13, 20, -3, -2);
        
        // Collar / hoodie (grey/white)
        fill(rootC, J_WHITE, -4, 5, 19, 22, -3, -1);
        fill(rootC, J_WHITE, -4, 5, 19, 21, 3, 4);
        fill(rootC, J_WHITE, -4, -3, 19, 21, -1, 3);
        fill(rootC, J_WHITE, 4, 5, 19, 21, -1, 3);

        // Neck
        fill(rootC, SKIN, -1, 2, 20, 21, -1, 2);

        // Head â 10w Ã 9h Ã 8d
        fill(rootC, SKIN, -5, 5, 21, 30, -3, 5);
        // Cheek/jaw shading on lower head sides
        fill(rootC, SKIN_SHADE, -5, 5, 21, 23, 3, 5);
        // Small lip dot
        fill(rootC, LIP, 0, 1, 22, 23, 4, 5);

        // ââ HAIR (layered bob cut) ââ
        // Top cap
        fill(rootC, HAIR, -6, 7, 30, 33, -4, 5);
        fill(rootC, HAIR_HI, -4, 5, 31, 33, -2, 3);
        // Back wall behind head
        fill(rootC, HAIR, -6, 7, 21, 30, -4, -3);
        // Side walls outside head
        fill(rootC, HAIR, -7, -5, 22, 30, -3, 4);
        fill(rootC, HAIR,  5,  7, 22, 30, -3, 4);
        // Bangs (front cap above eyes)
        fill(rootC, HAIR, -5, 6, 27, 30, 5, 6);
        // Side-swept bang locks hanging down past the eyes
        fill(rootC, HAIR, -6, -4, 23, 27, 5, 6);
        fill(rootC, HAIR,  4,  6, 23, 27, 5, 6);

        // ââ EYES (separate emissive mesh) ââ
        fill(eyeC, 0xaa4444, -3, -1, 24, 26, 5, 6);
        fill(eyeC, 0xaa4444,  1,  3, 24, 26, 5, 6);

        // ââ ARMS (pivots at shoulders; cubes in pivot-local coords) ââ
        // L arm pivot will sit at x=-5u, R at x=+5u
        // Jacket Shoulder (Red)
        fill(armLC, J_RED, -2, 2, -3, 1, -2, 3);
        fill(armRC, J_RED, -2, 2, -3, 1, -2, 3);
        // Mid sleeve (White)
        fill(armLC, J_WHITE, -2, 2, -6, -3, -2, 3);
        fill(armRC, J_WHITE, -2, 2, -6, -3, -2, 3);
        // Lower sleeve (Blue)
        fill(armLC, J_BLUE, -2, 2, -9, -6, -2, 3);
        fill(armRC, J_BLUE, -2, 2, -9, -6, -2, 3);
        // Hands (Skin) poking out
        fill(armLC, SKIN, -1, 1, -11, -9, -1, 2);
        fill(armRC, SKIN, -1, 1, -11, -9, -1, 2);

        // ââ LEGS (pivots at hips; cubes in pivot-local coords) ââ
        // Hip pivot will sit at y = feetY + 10u
        // Upper leg (bare skin)
        fill(legLC, SKIN, -1, 2, -2, 0, -1, 2);
        fill(legRC, SKIN, -1, 2, -2, 0, -1, 2);
        // High socks (red)
        fill(legLC, SOCKS, -1.5, 2.5, -8, -2, -1.5, 2.5);
        fill(legRC, SOCKS, -1.5, 2.5, -8, -2, -1.5, 2.5);
        // Shoes (pink)
        fill(legLC, SHOES, -2, 3, -10, -8, -2, 3);
        fill(legRC, SHOES, -2, 3, -10, -8, -2, 3);
        // Shoe tip
        fill(legLC, 0xdd7788, -2, 3, -10, -9, 2, 4);
        fill(legRC, 0xdd7788, -2, 3, -10, -9, 2, 4);

        // Helper: add a CubeDef[] to a parent as one InstancedMesh.
        const tmpMat = new THREE.Matrix4();
        const tmpCol = new THREE.Color();
        const addInst = (parent: THREE.Object3D, cubes: CubeDef[], material: THREE.Material) => {
          if (cubes.length === 0) return null;
          const mesh = new THREE.InstancedMesh(cubeGeo, material, cubes.length);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cubes.length * 3), 3);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          for (let i = 0; i < cubes.length; i++) {
            const cb = cubes[i];
            tmpMat.makeTranslation((cb.x + 0.5) * u, (cb.y + 0.5) * u, (cb.z + 0.5) * u);
            mesh.setMatrixAt(i, tmpMat);
            tmpCol.setHex(cb.color);
            mesh.setColorAt(i, tmpCol);
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          parent.add(mesh);
          return mesh;
        };

        // Static body: wrap in a sub-group shifted by feetY so cube y=0 lands
        // at the worker's foot plane.
        const bodyGroup = new THREE.Group();
        bodyGroup.position.set(0, feetY, 0);
        group.add(bodyGroup);
        addInst(bodyGroup, rootC, bodyMat);
        addInst(bodyGroup, eyeC, eyeMat);

        // Limb pivots (positioned in worker-local space, NOT sub-group)
        const armPivotL = new THREE.Group();
        const armPivotR = new THREE.Group();
        armPivotL.position.set(-5 * u, feetY + 18 * u, 0);
        armPivotR.position.set( 5 * u, feetY + 18 * u, 0);
        group.add(armPivotL);
        group.add(armPivotR);
        addInst(armPivotL, armLC, bodyMat);
        addInst(armPivotR, armRC, bodyMat);

        const legPivotL = new THREE.Group();
        const legPivotR = new THREE.Group();
        legPivotL.position.set(-2 * u, feetY + 10 * u, 0);
        legPivotR.position.set( 2 * u, feetY + 10 * u, 0);
        group.add(legPivotL);
        group.add(legPivotR);
        addInst(legPivotL, legLC, bodyMat);
        addInst(legPivotR, legRC, bodyMat);

        // Carried block (held above head when active)
        carried = new THREE.Mesh(
          new THREE.BoxGeometry(voxel * 0.5, voxel * 0.5, voxel * 0.5),
          new THREE.MeshPhongMaterial({ color: 0xffffff }),
        );
        carried.position.set(0, feetY + voxel * 2.7, 0);
        carried.castShadow = true;
        carried.visible = false;
        group.add(carried);

        group.userData = {
          style: "ghibli",
          carriedMesh: carried,
          chibi: { armL: armPivotL, armR: armPivotR, legL: legPivotL, legR: legPivotR },
        };
      } else if (style === "tars") {
        const matBody = new THREE.MeshPhongMaterial({ color: 0x2a2a2a, shininess: 5 });
        const matScreen = new THREE.MeshBasicMaterial({ color: 0x00ffff });
        const slabW = voxel * 0.15;
        const slabH = voxel * 1.4;
        const slabD = voxel * 0.35;
        const gap = voxel * 0.02;
        const stride = slabW + gap;
        const footOffset = -voxel * 0.6;
        const makeSlab = (xCenter: number) => {
          const pivot = new THREE.Group();
          pivot.position.set(xCenter, footOffset, 0);
          const slab = new THREE.Mesh(new THREE.BoxGeometry(slabW, slabH, slabD), matBody);
          slab.position.y = slabH / 2;
          pivot.add(slab);
          return pivot;
        };
        const slabs = [-1.5, -0.5, 0.5, 1.5].map((m) => makeSlab(m * stride));
        for (const s of slabs) group.add(s);
        const screenLMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
        const screenRMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
        const halfGeo = new THREE.BoxGeometry(stride, voxel * 0.14, voxel * 0.02);
        const screenL = new THREE.Mesh(halfGeo, screenLMat);
        screenL.position.set(0, slabH * 0.78, slabD / 2 + voxel * 0.012);
        slabs[1].add(screenL);
        const screenR = new THREE.Mesh(halfGeo, screenRMat);
        screenR.position.set(0, slabH * 0.78, slabD / 2 + voxel * 0.012);
        slabs[2].add(screenR);
        carried = new THREE.Mesh(
          new THREE.BoxGeometry(voxel * 0.45, voxel * 0.45, voxel * 0.45),
          new THREE.MeshPhongMaterial({ color: 0xffffff }),
        );
        carried.position.set(0, footOffset + slabH * 0.55, voxel * 0.3);
        carried.visible = false;
        group.add(carried);
        group.userData = {
          style: "tars",
          carriedMesh: carried,
          tars: { slabs, screenL, screenR, screenLMat, screenRMat, slabH, footOffset },
        };
      } else {
        const matBody = new THREE.MeshPhongMaterial({ color: 0x2a2a30, shininess: 10 });
        const matSkin = new THREE.MeshPhongMaterial({ color: 0xe0cda9, shininess: 20 });
        const matVisor = new THREE.MeshBasicMaterial({ color: 0x00ffcc });
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
        carried = new THREE.Mesh(
          new THREE.BoxGeometry(voxel * 0.45, voxel * 0.45, voxel * 0.45),
          new THREE.MeshPhongMaterial({ color: 0xffffff }),
        );
        carried.position.set(0, voxel * 1.15, 0);
        carried.visible = false;
        group.add(carried);
        group.userData = { style: "humanoid", carriedMesh: carried };
      }
      return { group, carried };
    };

    const createWorker = (id: string, vx: number, vy: number, vz: number) => {
      const style = ((window as any).__tw?.workerStyle === "humanoid") ? "humanoid" : 
                    ((window as any).__tw?.workerStyle === "tars") ? "tars" : "ghibli";
      const { group, carried } = buildWorkerVisual(style);
      scene.add(group);
      const w: WorkerState = {
        id, vx, vy, vz,
        targetVX: vx, targetVY: vy, targetVZ: vz,
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
      };
      workers.push(w);
      return w;
    };

    // Spawn one worker on a real top cell nearest the column centroid.
    // Without this call, createWorker is defined but never invoked and
    // worlds load with zero workers (regression from an earlier refactor).
    if (colMap.size > 0) {
      let sumX = 0, sumY = 0, sumZ = 0, n = 0;
      for (const [k, ySet] of colMap.entries()) {
        const cs = k.split(",");
        for (const y of ySet) {
          sumX += +cs[0]; sumY += y; sumZ += +cs[1]; n++;
        }
      }
      if (n > 0) {
        const cx = sumX / n, cy = sumY / n, cz = sumZ / n;
        let bestD2 = Infinity;
        let spawn: [number, number, number] | null = null;
        for (const [k, ySet] of colMap.entries()) {
          const cs = k.split(",");
          const x = +cs[0], z = +cs[1];
          for (const y of ySet) {
            if (ySet.has(y + 1)) continue; // top of column only
            const dx = x - cx, dy = y - cy, dz = z - cz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; spawn = [x, y, z]; }
          }
        }
        if (spawn) {
          createWorker("worker-1", spawn[0], spawn[1], spawn[2]);
          console.log("[tinyworld] worker spawned at cell", spawn[0], spawn[1], spawn[2]);
        }
      }
    }

    let lastWorkerTickMs = 0;
    let lastWorkerUiMs = 0;
    let lastWorkerUiHadWorker = false;
    // Slower than v1 â workers now feel deliberate. Cell move 2500ms,
    // pickup 8000ms, place 4000ms. LLM call latency (~1s) is invisible
    // at these timings.
    const W_CELL_MS = 2500;
    const W_PICK_MS = 8000;
    const W_PLACE_MS = 4000;
    const W_PLAN_BACKOFF_MS = 6000;
    const W_WANDER_MS = 3500;
    const W_BUILD_STEP_MS = 1400;
    const BUILD_BLUEPRINTS: Record<string, Array<{ dx: number; dy: number; dz: number }>> = {
      pillar: [
        { dx: 0, dy: 0, dz: 0 }, { dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: 2, dz: 0 }, { dx: 0, dy: 3, dz: 0 },
      ],
      wall: [
        { dx: -1, dy: 0, dz: 0 }, { dx: 0, dy: 0, dz: 0 }, { dx: 1, dy: 0, dz: 0 },
        { dx: -1, dy: 1, dz: 0 }, { dx: 0, dy: 1, dz: 0 }, { dx: 1, dy: 1, dz: 0 },
      ],
      arch: [
        { dx: 0, dy: 0, dz: 0 }, { dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: 2, dz: 0 },
        { dx: 1, dy: 2, dz: 0 },
        { dx: 2, dy: 0, dz: 0 }, { dx: 2, dy: 1, dz: 0 }, { dx: 2, dy: 2, dz: 0 },
      ],
      hut: [
        { dx: 0, dy: 0, dz: 0 }, { dx: 1, dy: 0, dz: 0 }, { dx: 2, dy: 0, dz: 0 },
        { dx: 0, dy: 0, dz: 2 }, { dx: 1, dy: 0, dz: 2 }, { dx: 2, dy: 0, dz: 2 },
        { dx: 0, dy: 1, dz: 0 }, { dx: 2, dy: 1, dz: 2 },
      ],
      cap: [
        { dx: 0, dy: 0, dz: 0 },
        { dx: 1, dy: 0, dz: 0 }, { dx: -1, dy: 0, dz: 0 },
        { dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 },
      ],
      tower: [
        { dx: 0, dy: 0, dz: 0 }, { dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: 2, dz: 0 },
        { dx: 0, dy: 3, dz: 0 }, { dx: 0, dy: 4, dz: 0 }, { dx: 0, dy: 5, dz: 0 },
      ],
      ring: [
        { dx: 2, dy: 0, dz: 0 }, { dx: -2, dy: 0, dz: 0 },
        { dx: 0, dy: 0, dz: 2 }, { dx: 0, dy: 0, dz: -2 },
        { dx: 2, dy: 0, dz: 1 }, { dx: 2, dy: 0, dz: -1 },
        { dx: -2, dy: 0, dz: 1 }, { dx: -2, dy: 0, dz: -1 },
        { dx: 1, dy: 0, dz: 2 }, { dx: -1, dy: 0, dz: 2 },
        { dx: 1, dy: 0, dz: -2 }, { dx: -1, dy: 0, dz: -2 },
      ],
    };
    const tickWorkers = (now: number) => {
      for (const w of workers) {
        // Ground re-sync + escape route. Void creatures eating the column
        // beneath a worker leaves w.vy stale (worker visibly floats). Run
        // only between actions to avoid disrupting mid-walk interpolation.
        // Convention: w.vy = the top occupied block's vy (a Star, spawn,
        // and findAdjacentWalkableW all use this offset â there is NO +1).
        if (w.mode === "idle" && !w.pickupTarget && !w.placeTarget && !(w as any).buildTarget) {
          const top = colTop(w.vx, w.vz);
          if (top !== null) {
            if (w.vy !== top) { w.vy = top; w.targetVY = w.vy; }
          } else {
            // Column under worker is empty â try a neighbor first.
            let stepped = false;
            const dirs: Array<[number, number]> = [[1,0],[-1,0],[0,1],[0,-1]];
            for (const [dx, dz] of dirs) {
              const t = colTop(w.vx + dx, w.vz + dz);
              if (t === null) continue;
              w.vx += dx; w.vz += dz; w.vy = t;
              w.targetVX = w.vx; w.targetVY = w.vy; w.targetVZ = w.vz;
              stepped = true; break;
            }
            if (!stepped) {
              // Build escape route â spawn a stockpile block at the
              // worker's current vy so it becomes the new top under them.
              const sp = stockpileByLayerRef.current as Record<string, number>;
              let lay: string | null = null;
              for (const cand of ["dirt", "grass", "dryGrass", "stone", "snow", "leaves"]) {
                if ((sp[cand] || 0) > 0) { lay = cand; break; }
              }
              if (lay) {
                let mesh: any = null;
                for (const m of meshesRef.current) {
                  if (m.userData?.layer === lay && (m.userData?.freeSlots?.length || 0) > 0) { mesh = m; break; }
                }
                if (mesh) {
                  const escY = Math.max(0, w.vy);
                  if (spawnBlockInto(mesh, w.vx, escY, w.vz, "worker-escape")) {
                    syncGroundAfterPlace(w.vx, escY, w.vz, lay);
                    ledgerMove("stockpile", "void", 1, "worker-escape", lay, lowestGrade(lay));
                    w.vy = escY; w.targetVY = w.vy;
                  }
                }
              }
            }
          }
        }

        if (w.mode === "idle") {
          // No plan yet â request one (async).
          if (!w.plan) {
            if (!w.planRequested && now - w.lastPlanFailMs > W_PLAN_BACKOFF_MS) {
              w.planRequested = true;
              w.mode = "planning";
              w.modeStartMs = now;
              fetchWorkerPlan(w).then((plan) => {
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
            // Wander fallback so workers don't freeze while plans are unavailable.
            if (!w.planRequested && w.mode === "idle") {
              const lastWander = (w as any).lastWanderMs ?? 0;
              if (now - lastWander > W_WANDER_MS) {
                (w as any).lastWanderMs = now;
                const R = 6;
                let started = false;
                for (let tries = 0; tries < 8; tries++) {
                  const dx = Math.floor(Math.random() * (R * 2 + 1)) - R;
                  const dz = Math.floor(Math.random() * (R * 2 + 1)) - R;
                  if (dx === 0 && dz === 0) continue;
                  const tvx = w.vx + dx;
                  const tvz = w.vz + dz;
                  const tvy = topAt(tvx, tvz);
                  if (tvy === null) continue;
                  const path = aStarOnGround(w.vx, w.vy, w.vz, tvx, tvy, tvz);
                  if (path && path.length >= 1) {
                    w.path = path; w.pathIdx = 0;
                    w.placeTarget = null; w.pickupTarget = null; (w as any).currentAction = null;
                    w.mode = "walking"; w.moveEndMs = now;
                    (w as any).wanderFails = 0;
                    started = true;
                    break;
                  }
                }
                if (!started) {
                  (w as any).wanderFails = ((w as any).wanderFails ?? 0) + 1;
                  // After 2 failed wanders, ask the LLM for a stuck-recovery plan (it can use Mine to dig out).
                  if ((w as any).wanderFails >= 2 && !(w as any).stuckPlanRequested) {
                    (w as any).stuckPlanRequested = true;
                    w.planRequested = true;
                    w.mode = "planning";
                    w.modeStartMs = now;
                    fetchWorkerPlan(w, { stuck: true }).then((plan) => {
                      w.planRequested = false;
                      (w as any).stuckPlanRequested = false;
                      if (plan) {
                        w.plan = plan;
                        (w as any).wanderFails = 0;
                      } else {
                        w.lastPlanFailMs = performance.now();
                      }
                      if (w.mode === "planning") {
                        w.mode = "idle";
                        w.modeStartMs = performance.now();
                      }
                    }).catch(() => {
                      w.planRequested = false;
                      (w as any).stuckPlanRequested = false;
                      w.lastPlanFailMs = performance.now();
                      if (w.mode === "planning") w.mode = "idle";
                    });
                  }
                  // After 4 failed wanders (LLM also gave up), teleport-rescue as last resort.
                  if ((w as any).wanderFails >= 4) {
                    const R2 = 12;
                    let best: { vx: number; vy: number; vz: number; d2: number } | null = null;
                    for (let dx = -R2; dx <= R2; dx++) {
                      for (let dz = -R2; dz <= R2; dz++) {
                        if (dx === 0 && dz === 0) continue;
                        const tvx = w.vx + dx;
                        const tvz = w.vz + dz;
                        const tvy = topAt(tvx, tvz);
                        if (tvy === null) continue;
                        const d2 = dx * dx + dz * dz;
                        if (!best || d2 < best.d2) best = { vx: tvx, vy: tvy, vz: tvz, d2 };
                      }
                    }
                    if (best) {
                      w.vx = best.vx; w.vy = best.vy; w.vz = best.vz;
                      w.targetVX = best.vx; w.targetVY = best.vy; w.targetVZ = best.vz;
                      w.path = []; w.pathIdx = 0;
                      (w as any).wanderFails = 0;
                    }
                  }
                }
              }
            }
            continue;
          }
          const next = w.plan.actions.find((a) => !a.done);
          if (!next) {
            w.plan = null;
            continue;
          }
          
          if (next.action === "PickUp" && next.layer) {
            if (w.carrying) { next.done = true; continue; }
            const src = findSourceBlockForLayer(w.vx, w.vy, w.vz, next.layer);
            if (!src) { next.done = true; continue; }
            const dest = findAdjacentWalkableW(src.vx, src.vy, src.vz);
            if (!dest) { next.done = true; continue; }
            const path = aStarOnGround(w.vx, w.vy, w.vz, dest[0], dest[1], dest[2]);
            if (path && path.length >= 1) {
              w.path = path; w.pathIdx = 0;
              w.pickupTarget = { ...src, actionRef: next };
              w.placeTarget = null; w.currentAction = next;
              w.mode = "walking"; w.moveEndMs = now;
            } else { next.done = true; }
          }
          else if (next.action === "Place" && next.vx !== undefined && next.vz !== undefined) {
            if (!w.carrying) { next.done = true; continue; }
            const destVY = (colTop(next.vx, next.vz) ?? 0);
            const dest = findAdjacentWalkableW(next.vx, destVY, next.vz);
            if (!dest) { next.done = true; continue; }
            const path = aStarOnGround(w.vx, w.vy, w.vz, dest[0], dest[1], dest[2]);
            if (path && path.length >= 1) {
              w.path = path; w.pathIdx = 0;
              w.placeTarget = { vx: next.vx, vy: destVY, vz: next.vz, actionRef: next };
              w.pickupTarget = null; w.currentAction = next;
              w.mode = "walking"; w.moveEndMs = now;
            } else { next.done = true; }
          }
          else if (next.action === "MoveTo" && next.vx !== undefined && next.vz !== undefined) {
            const destVY = (colTop(next.vx, next.vz) ?? 0);
            const path = aStarOnGround(w.vx, w.vy, w.vz, next.vx, destVY, next.vz);
            if (path && path.length >= 1) {
              w.path = path; w.pathIdx = 0;
              w.placeTarget = null; w.pickupTarget = null; w.currentAction = next;
              w.mode = "walking"; w.moveEndMs = now;
            } else { next.done = true; }
          }
          else if (next.action === "Interact") {
            if (next.target === "press" && pressPersistRef.current?.built) {
              const pvx = pressPersistRef.current.vx, pvz = pressPersistRef.current.vz;
              const path = aStarOnGround(w.vx, w.vy, w.vz, pvx, colTop(pvx, pvz) ?? w.vy, pvz);
              if (path && path.length >= 1) {
                w.path = path; w.pathIdx = 0;
                w.placeTarget = null; w.pickupTarget = null; w.currentAction = next;
                w.mode = "walking"; w.moveEndMs = now;
              } else { next.done = true; }
            } else { next.done = true; }
          } else if (next.action === "Mine") {
            let mineMesh: any = null;
            const mineKey = w.vx + "," + (w.vy - 1) + "," + w.vz;
            for (const m of meshesRef.current) {
              const slotMap = m.userData?.slotMap as Map<string, number> | undefined;
              if (slotMap?.has(mineKey)) { mineMesh = m; break; }
            }
            if (mineMesh && removeBlockFrom(mineMesh, w.vx, w.vy - 1, w.vz, "worker-mine")) {
              w.vy = w.vy - 1;
              w.targetVY = w.vy;
              (w as any).wanderFails = 0;
            }
            next.done = true;
          } else if (next.action === "Build" && next.vx !== undefined && next.vz !== undefined && next.layer) {
            const sp = stockpileByLayerRef.current as Record<string, number>;
            let offsets: Array<{ dx: number; dy: number; dz: number }> | null = null;
            if (Array.isArray(next.blueprint) && next.blueprint.length > 0) {
              offsets = next.blueprint.slice(0, 12).filter(
                (o: any) => typeof o?.dx === "number" && typeof o?.dy === "number" && typeof o?.dz === "number",
              );
            } else if (next.structure && BUILD_BLUEPRINTS[next.structure]) {
              offsets = BUILD_BLUEPRINTS[next.structure];
            }
            if (!offsets || offsets.length === 0) { next.done = true; continue; }
            const have = sp[next.layer] || 0;
            if (have < offsets.length) {
              console.warn("[tinyworld] Build skipped: insufficient stockpile", { layer: next.layer, need: offsets.length, have });
              next.done = true; continue;
            }
            const anchorVY = (colTop(next.vx, next.vz) ?? 0);
            const dest = findAdjacentWalkableW(next.vx, anchorVY, next.vz);
            if (!dest) { next.done = true; continue; }
            const path = aStarOnGround(w.vx, w.vy, w.vz, dest[0], dest[1], dest[2]);
            if (path && path.length >= 1) {
              w.path = path; w.pathIdx = 0;
              w.placeTarget = null; w.pickupTarget = null;
              w.buildTarget = { vx: next.vx, vz: next.vz, layer: next.layer, offsets, idx: 0, lastStepMs: 0, actionRef: next, type: next.structure || (Array.isArray(next.blueprint) ? "custom" : "build"), startedMs: now };
              w.currentAction = next;
              w.mode = "walking"; w.moveEndMs = now;
            } else { next.done = true; }
          } else {
            next.done = true;
          }
        } else if (w.mode === "planning") {
          // Awaiting fetch â handled in promise resolver above.
          continue;
        } else if (w.mode === "walking") {
          if (now < w.moveEndMs) continue;
          if (w.pathIdx + 1 < w.path.length) {
            w.pathIdx++;
            w.vx = w.path[w.pathIdx][0];
            w.vy = w.path[w.pathIdx][1];
            w.vz = w.path[w.pathIdx][2];
            if (w.pathIdx + 1 < w.path.length) {
              w.targetVX = w.path[w.pathIdx + 1][0];
              w.targetVY = w.path[w.pathIdx + 1][1];
              w.targetVZ = w.path[w.pathIdx + 1][2];
              w.moveStartMs = now;
              const stepsLeft = w.path.length - w.pathIdx;
              const cellMs = w.carrying
                ? W_CELL_MS
                : stepsLeft > 10 ? 800
                : stepsLeft > 4 ? 1500
                : W_CELL_MS;
              w.moveEndMs = now + cellMs;
            } else {
              w.targetVX = w.vx;
              w.targetVY = w.vy;
              w.targetVZ = w.vz;
              w.moveStartMs = now;
              w.moveEndMs = now;
            }
          } else {
            if (w.pickupTarget) {
              w.mode = "picking";
              w.modeStartMs = now;
            } else if (w.placeTarget) {
              w.mode = "placing";
              w.modeStartMs = now;
            } else if (w.buildTarget) {
              w.buildTarget.lastStepMs = now - W_BUILD_STEP_MS;
              w.mode = "mining";
              w.modeStartMs = now;
            } else {
              if (w.currentAction && w.currentAction.action === "Interact") {
                w.mode = "stuck";
                w.modeStartMs = now;
              } else {
                if (w.currentAction) w.currentAction.done = true;
                w.currentAction = null;
                w.mode = "idle";
                w.modeStartMs = now;
              }
            }
          }
        } else if (w.mode === "picking") {
          if (now - w.modeStartMs < W_PICK_MS) continue;
          const t = w.pickupTarget!;
          const pickGrade = blockGradesRef.current.get(t.vx + "," + t.vy + "," + t.vz) || "raw";
          if (removeBlockFrom(t.mesh, t.vx, t.vy, t.vz, "tinyperson")) {
            syncGroundAfterRemove(t.vx, t.vy, t.vz, t.mesh.userData.layer);
            ledgerMove("void", "stockpile", 1, "tinyperson", t.mesh.userData.layer, pickGrade);
            w.carrying = { mesh: t.mesh, color: t.mesh.material.color.clone(), layer: t.mesh.userData.layer };
            if (w.carriedMesh) {
              (w.carriedMesh.material as any).color.copy(w.carrying.color);
              w.carriedMesh.visible = true;
            }
          }
          if (t.actionRef) t.actionRef.done = true;
          w.pickupTarget = null;
          w.currentAction = null;
          w.mode = "idle";
          w.modeStartMs = now;
        } else if (w.mode === "placing") {
          if (now - w.modeStartMs < W_PLACE_MS) continue;
          let placed = false;
          if (w.carrying && w.placeTarget) {
            const top = colTop(w.placeTarget.vx, w.placeTarget.vz) ?? w.placeTarget.vy;
            const placeVy = top + 1;
            if (spawnBlockInto(w.carrying.mesh, w.placeTarget.vx, placeVy, w.placeTarget.vz, "tinyperson")) {
              syncGroundAfterPlace(w.placeTarget.vx, placeVy, w.placeTarget.vz, w.carrying.layer);
              const wGrade = lowestGrade(w.carrying.layer);
              ledgerMove("stockpile", "void", 1, "tinyperson", w.carrying.layer, wGrade);
              if (wGrade !== "raw") blockGradesRef.current.set(w.placeTarget.vx + "," + placeVy + "," + w.placeTarget.vz, wGrade);
              placed = true;
            }
          }
          if (w.placeTarget?.actionRef) w.placeTarget.actionRef.done = true;
          // On failure keep carrying â the block stays in the stockpile
          // instead of silently vanishing like it used to.
          if (placed) {
            w.carrying = null;
            if (w.carriedMesh) w.carriedMesh.visible = false;
          }
          w.placeTarget = null; w.currentAction = null;
          w.mode = "idle"; w.modeStartMs = now;
        } else if (w.mode === "mining") {
          const bt = w.buildTarget;
          if (!bt) { w.mode = "idle"; w.modeStartMs = now; continue; }
          if (now - bt.lastStepMs < W_BUILD_STEP_MS) continue;
          const sp = stockpileByLayerRef.current as Record<string, number>;
          if ((sp[bt.layer] || 0) <= 0) {
            console.warn("[tinyworld] Build aborted: stockpile depleted mid-build", { layer: bt.layer });
            if (bt.actionRef) bt.actionRef.done = true;
            w.buildTarget = null; w.currentAction = null;
            w.mode = "idle"; w.modeStartMs = now;
            continue;
          }
          let targetMesh: any = null;
          for (const m of meshesRef.current) {
            if (m.userData?.layer === bt.layer && (m.userData?.freeSlots?.length || 0) > 0) { targetMesh = m; break; }
          }
          if (!targetMesh) {
            if (bt.actionRef) bt.actionRef.done = true;
            w.buildTarget = null; w.currentAction = null;
            w.mode = "idle"; w.modeStartMs = now;
            continue;
          }
          while (bt.idx < bt.offsets.length) {
            const o = bt.offsets[bt.idx];
            const bx = bt.vx + o.dx;
            const bz = bt.vz + o.dz;
            const baseTop = (colTop(bx, bz) ?? 0);
            const by = baseTop + 1 + o.dy;
            bt.idx++;
            if (spawnBlockInto(targetMesh, bx, by, bz, "worker-build")) {
              syncGroundAfterPlace(bx, by, bz, bt.layer);
              ledgerMove("stockpile", "void", 1, "worker-build", bt.layer, lowestGrade(bt.layer));
              bt.lastStepMs = now;
              break;
            }
          }
          if (bt.idx >= bt.offsets.length || (sp[bt.layer] || 0) <= 0) {
            if (bt.idx >= bt.offsets.length) {
              const fp: Array<{ dx: number; dz: number }> = [];
              const seen = new Set<string>();
              let maxDy = 0;
              for (const o of bt.offsets) {
                const k = o.dx + "," + o.dz;
                if (!seen.has(k)) { seen.add(k); fp.push({ dx: o.dx, dz: o.dz }); }
                if (o.dy > maxDy) maxDy = o.dy;
              }
              const baseTop = (colTop(bt.vx, bt.vz) ?? 0);
              builtStructuresRef.current.push({
                type: (bt as any).type || "build",
                vx: bt.vx,
                vz: bt.vz,
                layer: bt.layer,
                topY: baseTop + maxDy,
                footprint: fp,
                builtMs: now,
              });
              if (builtStructuresRef.current.length > 32) {
                builtStructuresRef.current.splice(0, builtStructuresRef.current.length - 32);
              }
            }
            if (bt.actionRef) bt.actionRef.done = true;
            w.buildTarget = null; w.currentAction = null;
            w.mode = "idle"; w.modeStartMs = now;
          }
        } else if (w.mode === "stuck") {
          if (now - w.modeStartMs < W_PLACE_MS) continue;
          if (w.currentAction?.target === "press" && pressPersistRef.current?.built) {
            // Compress whatever is stockpiled that has >= 4
            for (const layer of ["dirt", "stone", "metal", "densium"]) {
              if ((stockpileByLayerRef.current[layer] || 0) >= 4) {
                // We'll just call compress for them if possible
                // They shouldn't be holding it, it comes from stockpile
                const pool = gradePool(layer);
                const clean = pool.pure >= 4;
                if (clean) pool.pure -= 4;
                else drainPoolLow(layer, 4);
                stockpileByLayerRef.current[layer] -= 4;
                const nextLayer = layer === "dirt" ? "stone" : layer === "stone" ? "metal" : layer === "metal" ? "densium" : "core";
                if (!clean) {
                  stockpileByLayerRef.current["slug_" + nextLayer] = (stockpileByLayerRef.current["slug_" + nextLayer] || 0) + 1;
                } else {
                  stockpileByLayerRef.current[nextLayer] = (stockpileByLayerRef.current[nextLayer] || 0) + 1;
                  gradePool(nextLayer).raw += 1;
                }
                const L = ledgerRef.current as any;
                L.stockpile -= 3;
                L.baseline -= 3;
                if (clean) {
                  queueBlockEvent("compress", 3, "press_" + layer);
                } else {
                  queueBlockEvent("compress", 3, "slug_" + layer);
                }
                break;
              }
            }
          }
          if (w.currentAction) w.currentAction.done = true;
          w.currentAction = null;
          w.mode = "idle";
          w.modeStartMs = now;
        }
      }
    };
    const renderWorkers = (now: number) => {
      for (const w of workers) {
        let wx: number, wy: number, wz: number;
        const isWalking = w.mode === "walking" && w.moveEndMs > w.moveStartMs;
        if (isWalking) {
          const t = Math.max(0, Math.min(1, (now - w.moveStartMs) / (w.moveEndMs - w.moveStartMs)));
          const fromX = (w.vx - cxRound) * voxel;
          const fromY = w.vy * voxel;
          const fromZ = (w.vz - czRound) * voxel;
          const toX = (w.targetVX - cxRound) * voxel;
          const toY = w.targetVY * voxel;
          const toZ = (w.targetVZ - czRound) * voxel;
          wx = fromX + (toX - fromX) * t;
          wy = fromY + (toY - fromY) * t;
          wz = fromZ + (toZ - fromZ) * t;
        } else {
          wx = (w.vx - cxRound) * voxel;
          wy = w.vy * voxel;
          wz = (w.vz - czRound) * voxel;
        }
        w.worldX = wx; w.worldY = wy + voxel * 1.1; w.worldZ = wz;
        
        // Bobbing is handled per limb now, so the root stays anchored
        w.group.position.set(wx, w.worldY, wz);
        
        // Character Animation
        if (w.group.userData.style === "ghibli") {
          const ch = w.group.userData.chibi;
          if (isWalking) {
            // Limb swing: arms and legs alternate on x-axis
            const swing = Math.sin(now * 0.012) * 0.55;
            ch.armL.rotation.x = swing;
            ch.armR.rotation.x = -swing;
            ch.legL.rotation.x = -swing * 0.8;
            ch.legR.rotation.x =  swing * 0.8;
            // Whole-body bob during walk
            const bob = Math.abs(Math.sin(now * 0.012)) * voxel * 0.05;
            w.group.position.y = w.worldY + bob;
          } else {
            // Idle: limbs relaxed, gentle bob
            ch.armL.rotation.x = 0;
            ch.armR.rotation.x = 0;
            ch.legL.rotation.x = 0;
            ch.legR.rotation.x = 0;
            const bob = Math.sin(now * 0.004) * voxel * 0.025;
            w.group.position.y = w.worldY + bob;
          }
        } else if (w.group.userData.style === "tars") {
          const td = w.group.userData.tars;
          if (isWalking) {
            // Three gaits keyed to movement speed (ms-per-cell).
            // Override: __tw.setGait("slow"|"normal"|"fast"|"auto")
            const dur = Math.max(1, w.moveEndMs - w.moveStartMs);
            const gaitOverride = (window as any).__tw?.gaitOverride;
            let gait: "slow" | "normal" | "fast";
            if (gaitOverride && gaitOverride !== "auto") {
              gait = gaitOverride;
            } else if (dur > 2200) {
              gait = "slow";
            } else if (dur > 1000) {
              gait = "normal";
            } else {
              gait = "fast";
            }
            if (gait === "slow") {
              // Walk modulation 1: whole-body domino lean, slabs stay together.
              const phase = Math.sin(now * 0.005);
              const lean = phase * 0.18;
              for (const s of td.slabs) {
                s.rotation.x = lean;
                s.rotation.z = 0;
              }
              w.group.rotation.z = 0;
            } else if (gait === "normal") {
              // Walk modulation 2: A-shape split â outer slabs tilt forward,
              // inner slabs tilt back, alternating each half-stride.
              const phase = Math.sin(now * 0.012);
              td.slabs[0].rotation.x = phase * 0.35;
              td.slabs[1].rotation.x = -phase * 0.35;
              td.slabs[2].rotation.x = -phase * 0.35;
              td.slabs[3].rotation.x = phase * 0.35;
              for (const s of td.slabs) s.rotation.z = 0;
              w.group.rotation.z = 0;
            } else {
              // Fast: N-shape spin (Interstellar TARS sprint). Outer slabs
              // tilt forward in parallel at a steady rate forming the rails.
              // Inner slabs tilt opposite each other at ~1.6Ã the frequency,
              // crossing through the middle to draw the diagonal of the N.
              const phaseOuter = Math.sin(now * 0.022);
              const phaseInner = Math.sin(now * 0.035);
              const outerTilt = phaseOuter * 0.35;
              const innerTilt = phaseInner * 0.55;
              td.slabs[0].rotation.x = outerTilt;
              td.slabs[3].rotation.x = outerTilt;
              td.slabs[1].rotation.x = innerTilt;
              td.slabs[2].rotation.x = -innerTilt;
              for (const s of td.slabs) s.rotation.z = 0;
              w.group.rotation.x = 0;
              w.group.rotation.z = 0;
            }
          } else {
            for (const s of td.slabs) {
              s.rotation.x = 0;
              s.rotation.z = 0;
            }
            w.group.rotation.z = 0;
          }
          if (w.mode === "planning") {
            const blink = (Math.floor(now / 250) % 2) === 0;
            const hex = blink ? 0x00ffff : 0x003a3a;
            td.screenLMat.color.setHex(hex);
            td.screenRMat.color.setHex(hex);
          } else if (w.mode === "stuck") {
            td.screenLMat.color.setHex(0xff4040);
            td.screenRMat.color.setHex(0xff4040);
          } else {
            const t = now * 0.001;
            const lPulse = 0.85 + 0.15 * Math.sin(t * 1.1);
            const rPulse = 0.85 + 0.15 * Math.sin(t * 1.1 + 0.6);
            td.screenLMat.color.setRGB(0, lPulse, lPulse);
            td.screenRMat.color.setRGB(0, rPulse, rPulse);
          }
          if (w.carrying) {
            w.carriedMesh.position.set(0, td.footOffset + td.slabH * 0.55, voxel * 0.3);
          } else {
            w.carriedMesh.position.set(0, td.footOffset + td.slabH * 0.55, voxel * 0.3);
          }
        } else {
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
            visor.material.color.setHex(0x00ffcc);
          } else {
            armL.rotation.x = Math.sin(now * 0.002) * 0.1;
            armR.rotation.x = -Math.sin(now * 0.002) * 0.1;
            legL.rotation.x = 0;
            legR.rotation.x = 0;
            torsoGroup.rotation.y = 0;
            torsoGroup.position.y = voxel * 0.1;
            headGroup.rotation.x = Math.sin(now * 0.001) * 0.1 - 0.15;
            const pulse = 0.4 + Math.sin(now * 0.003) * 0.4;
            const r = Math.floor(0x00 * pulse);
            const g = Math.floor(0xcc * pulse);
            const b = Math.floor(0xaa * pulse);
            visor.material.color.setRGB(r/255, g/255, b/255);
          }
        }

        // Face the direction of travel (snap, not lerp â they're tiny).
        if (w.mode === "walking" && (w.targetVX !== w.vx || w.targetVZ !== w.vz)) {
          w.group.rotation.y = Math.atan2(w.targetVX - w.vx, w.targetVZ - w.vz);
        }
      }
    };

    type ChargeState = { startMs: number; mesh: any; idx: number; hardMs: number; vx: number; vy: number; vz: number; color: any };
    type Carry = { mesh: any; originVX: number; originVY: number; originVZ: number; color: any; hardMs: number; layer: string; grade?: string };
    let chargeState: ChargeState | null = null;
    let carryState: Carry | null = null;

    const getPlacementTarget = () => {
      const hit = marchRay();
      if (hit) {
        // Place against the face we hit â normal points back toward camera.
        const vx = hit.vx + hit.nx;
        const vy = hit.vy + hit.ny;
        const vz = hit.vz + hit.nz;
        return {
          vx,
          vy,
          vz,
          world: new THREE.Vector3((vx - cxRound) * voxel, vy * voxel, (vz - czRound) * voxel),
        };
      }
      // No hit: fall back to top-of-column ahead (preserves the old behavior
      // when aiming at sky).
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const target = camera.position.clone().addScaledVector(forward, REACH * 0.6);
      const vx = Math.round(target.x / voxel) + cxRound;
      const vz = Math.round(target.z / voxel) + czRound;
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
      if ((!fp.isLocked && !isMobileRef.current) || carryState || chargeState) return;
      let hit = marchRay();
      if (!hit && isMobileRef.current) {
        // Mobile aim is imprecise â fall back to nearest pickable top block within ~4 voxels.
        const px = Math.floor(camera.position.x / voxel) + cxRound;
        const pz = Math.floor(camera.position.z / voxel) + czRound;
        const py = Math.floor(camera.position.y / voxel);
        let bestD2 = Infinity;
        for (let dx = -4; dx <= 4; dx++) {
          for (let dz = -4; dz <= 4; dz++) {
            const vx = px + dx, vz = pz + dz;
            const col = colMap.get(vx + "," + vz);
            if (!col || col.size === 0) continue;
            let top = -Infinity;
            for (const y of col) if (y > top) top = y;
            if (top > py + 2) continue;
            const dy = top - py;
            const d2 = dx * dx + dz * dz + dy * dy;
            if (d2 >= bestD2) continue;
            for (const m of meshesRef.current) {
              const slotMap = m.userData?.slotMap as Map<string, number>;
              const slot = slotMap?.get(vx + "," + top + "," + vz);
              if (slot === undefined) continue;
              const layer = (m.userData?.layer as string) || "block";
              const hardMs = MOVE_MS[layer];
              if (hardMs !== undefined && !isFinite(hardMs)) break;
              bestD2 = d2;
              hit = { vx, vy: top, vz, mesh: m, slot };
              break;
            }
          }
        }
      }
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
      const pgKey = vx + "," + vy + "," + vz;
      const pGrade = blockGradesRef.current.get(pgKey) || "raw";
      blockGradesRef.current.delete(pgKey);
      carryState = { mesh, originVX: vx, originVY: vy, originVZ: vz, color, hardMs, layer, grade: pGrade };
      ledgerMove("world", "stockpile", 1, "user", layer, pGrade);
      chargeState = null;
      ghostMesh.visible = false;
      setCarryLayer(layer);
      // LARGE Sentinel: sweep the surrounding 4x4x4 cube as a single "truck"
      // operation. The targeted block is already in carry; this fills out the
      // remaining 63 cells straight into stockpile.
      if (sentinelModeRef.current === "large") {
        bulkHarvestAround(vx, vy, vz, true);
      }
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

    // âââ Sentinel LARGE mode: 4Ã4Ã4 bulk block ops âââââââââââââââââââââââ
    // Sweeps a 4Ã4Ã4 cube centered on the targeted block (offsets -1..+2 each
    // axis), pulling every solid cell directly into stockpile. Skips water +
    // any unmoveable layer. The single-block pickup the user initiated stays
    // in carry; this just adds the bulk dividend.
    const bulkHarvestAround = (cx: number, cy: number, cz: number, skipSelf: boolean): number => {
      let harvested = 0;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let dx = -1; dx <= 2; dx++) {
        for (let dy = -1; dy <= 2; dy++) {
          for (let dz = -1; dz <= 2; dz++) {
            if (skipSelf && dx === 0 && dy === 0 && dz === 0) continue;
            const vx = cx + dx, vy = cy + dy, vz = cz + dz;
            const key = vx + "," + vy + "," + vz;
            for (const m of meshesRef.current) {
              const slotMap = m.userData?.slotMap as Map<string, number> | undefined;
              if (!slotMap) continue;
              const slot = slotMap.get(key);
              if (slot === undefined) continue;
              const layer = (m.userData?.layer as string) || "block";
              const hardMs = MOVE_MS[layer];
              if (hardMs !== undefined && !isFinite(hardMs)) break;
              m.setMatrixAt(slot, zero);
              m.instanceMatrix.needsUpdate = true;
              (m.userData.freeSlots as number[]).push(slot);
              slotMap.delete(key);
              removeCol(vx, vy, vz);
              protAdd(vx, vz, layer, -1);
              tryRevealHidden(vx, vy, vz);
              const pGrade = blockGradesRef.current.get(key) || "raw";
              blockGradesRef.current.delete(key);
              if (groundRef.current && (layer === "grass" || layer === "dryGrass" || layer === "snow" || layer === "wet" || layer === "dirt")) {
                const gKey = vx + "," + vz;
                const gCurr = groundRef.current.map.get(gKey);
                if (gCurr !== undefined && gCurr === vy) {
                  const newTop = colTop(vx, vz);
                  if (newTop !== null) groundRef.current.map.set(gKey, newTop);
                  else groundRef.current.map.delete(gKey);
                }
              }
              ledgerMove("world", "stockpile", 1, "user", layer, pGrade);
              harvested++;
              break;
            }
          }
        }
      }
      return harvested;
    };

    // Bulk place: fills the 4Ã4Ã4 cube centered on (cx,cy,cz) with blocks
    // drawn from stockpile. Prefers the carry layer; falls back to dirt for
    // any cell whose preferred layer is exhausted. Respects ledger.
    const bulkPlaceAround = (cx: number, cy: number, cz: number, preferLayer: string, skipSelf: boolean): number => {
      let placed = 0;
      for (let dx = -1; dx <= 2; dx++) {
        for (let dy = -1; dy <= 2; dy++) {
          for (let dz = -1; dz <= 2; dz++) {
            if (skipSelf && dx === 0 && dy === 0 && dz === 0) continue;
            const vx = cx + dx, vy = cy + dy, vz = cz + dz;
            if (solidAt(vx, vy, vz)) continue;
            // Pick a layer with stock available.
            let layer: string | null = null;
            if ((stockpileByLayerRef.current[preferLayer] || 0) > 0) layer = preferLayer;
            else {
              for (const l of ["dirt", "stone", "grass", "dryGrass", "snow", "wet"]) {
                if ((stockpileByLayerRef.current[l] || 0) > 0) { layer = l; break; }
              }
            }
            if (!layer) return placed; // stockpile dry
            const m = meshesRef.current.find((x: any) => x.userData?.layer === layer);
            if (!m) continue;
            const freeSlots = m.userData.freeSlots as number[];
            if (!freeSlots.length) continue;
            const slot = freeSlots.pop()!;
            dummy.position.set((vx - cxRound) * voxel, vy * voxel, (vz - czRound) * voxel);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            m.setMatrixAt(slot, dummy.matrix);
            m.instanceMatrix.needsUpdate = true;
            (m.userData.slotMap as Map<string, number>).set(vx + "," + vy + "," + vz, slot);
            addCol(vx, vy, vz);
            protAdd(vx, vz, layer, 1);
            ledgerMove("stockpile", "world", 1, "user", layer, "raw");
            if (groundRef.current && (layer === "grass" || layer === "dryGrass" || layer === "snow" || layer === "wet" || layer === "dirt")) {
              const gKey = vx + "," + vz;
              const gCurr = groundRef.current.map.get(gKey);
              if (gCurr === undefined || vy > gCurr) groundRef.current.map.set(gKey, vy);
            }
            placed++;
          }
        }
      }
      return placed;
    };

    const placeAt = (vx: number, vy: number, vz: number) => {
      if (!carryState) return;
      const freeSlots = carryState.mesh.userData.freeSlots as number[];
      if (!freeSlots.length) return false;
      // Reject if target voxel is already solid.
      if (solidAt(vx, vy, vz)) return false;
      // Require at least one adjacent occupied face â no floating placement.
      // Also accept ground-level under foot as an anchor (groundRef map).
      const hasNeighbor =
        solidAt(vx + 1, vy, vz) || solidAt(vx - 1, vy, vz) ||
        solidAt(vx, vy + 1, vz) || solidAt(vx, vy - 1, vz) ||
        solidAt(vx, vy, vz + 1) || solidAt(vx, vy, vz - 1);
      const groundY = groundRef.current?.map.get(vx + "," + vz);
      const onGround = groundY !== undefined && vy === groundY + 1;
      if (!hasNeighbor && !onGround) return false;
      const slot = freeSlots.pop()!;
      dummy.position.set((vx - cxRound) * voxel, vy * voxel, (vz - czRound) * voxel);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      carryState.mesh.setMatrixAt(slot, dummy.matrix);
      carryState.mesh.instanceMatrix.needsUpdate = true;
      (carryState.mesh.userData.slotMap as Map<string, number>).set(vx + "," + vy + "," + vz, slot);
      addCol(vx, vy, vz);
      protAdd(vx, vz, carryState.layer, 1);
      const cGrade = (carryState as any).grade || "raw";
      ledgerMove("stockpile", "world", 1, "user", carryState.layer, cGrade);
      if (cGrade !== "raw") blockGradesRef.current.set(vx + "," + vy + "," + vz, cGrade);
      // If we placed a floor-ish block at the new top of column, raise walkable ground.
      if (groundRef.current && (carryState.layer === "grass" || carryState.layer === "dryGrass" || carryState.layer === "snow" || carryState.layer === "wet" || carryState.layer === "dirt")) {
        const gKey = vx + "," + vz;
        const gCurr = groundRef.current.map.get(gKey);
        if (gCurr === undefined || vy > gCurr) groundRef.current.map.set(gKey, vy);
      }
      return true;
    };

    // âââ Water flow (settle on edit, conservation-respecting) âââââââââââââââ
    // After any land block is moved, redistribute nearby water to fill the
    // lowest reachable cells in its connected region. Total water count is
    // preserved â water only re-pours into newly-opened space, draining from
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
      if (!carryState || (!fp.isLocked && !isMobileRef.current)) return;
      const target = getPlacementTarget();
      if (!target) return;
      const placedLayer = carryState.layer;
      if (placeAt(target.vx, target.vy, target.vz)) {
        carryState = null;
        ghostMesh.visible = false;
        setCarryLayer(null);
        setMoves((m) => m + 1);
        // LARGE Sentinel: dump the remaining 63 cells of the 4x4x4 cube using
        // matching layer from stockpile.
        if (sentinelModeRef.current === "large") {
          bulkPlaceAround(target.vx, target.vy, target.vz, placedLayer, true);
        }
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
      const tm = targetModeRef.current;
      if (tm) {
        if (ev.button !== 0) { setTargetMode(null); return; }
        const hit = marchRay();
        if (!hit) {
          console.log("[tinyworld] " + tm + ": aim at a block first");
          return;
        }
        if (tm === "placeBomb") {
          const sp = stockpileByLayerRef.current as any;
          let tier: string | null = null;
          for (const t of ["core", "densium", "metal", "stone", "dirt"]) {
            if ((sp["slug_" + t] || 0) >= 1) { tier = t; break; }
          }
          if (!tier) {
            console.warn("[tinyworld] place bomb: no slugs available");
            setTargetMode(null);
            return;
          }
          const res = placeBomb(hit.vx, hit.vy + 1, hit.vz, 1, tier);
          console.log("[tinyworld] place bomb", res);
        } else if (tm === "flyShip") {
          const res = flyShip(hit.vx, hit.vz, 0);
          console.log("[tinyworld] fly ship", res);
        }
        setTargetMode(null);
        return;
      }
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
      if (e.code === "Escape" && fp.isLocked) {
        if (targetModeRef.current) {
          setTargetMode(null);
        } else {
          fp.unlock();
        }
      }
      if (e.code === "KeyG" && fp.isLocked) returnCarry();
      if (e.code === "Space" && fp.isLocked && Math.abs(velocityYRef.current) < 0.01) {
        velocityYRef.current = JUMP_VELOCITY;
      }
      if (e.code === "KeyE" && fp.isLocked && carryState && carryState.layer === "fruit") {
        // Eat: carried fruit is consumed â STOCKPILE â VOID, satiation up.
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
      if (composerRef.current) composerRef.current.setSize(innerWidth, innerHeight);
      const db = renderer.getDrawingBufferSize(new THREE.Vector2());
      normalTarget.setSize(db.x, db.y);
      outlinePass.uniforms.resolution.value.set(db.x, db.y);
    });

    // âââ Conservation ledger init âââââââââââââââââââââââââââââââââââââââââ
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
      const c4 = (((worldDataRef.current?.meta as any)?.chunk4) || {}) as any;
      stockpileByLayerRef.current = c4.stockpileByLayer && typeof c4.stockpileByLayer === "object" ? { ...c4.stockpileByLayer } : {};
      stockGradesRef.current = c4.stockGrades && typeof c4.stockGrades === "object" ? JSON.parse(JSON.stringify(c4.stockGrades)) : {};
      blockGradesRef.current.clear();
      if (Array.isArray(c4.blockGrades)) {
        for (const e of c4.blockGrades) {
          if (Array.isArray(e) && e.length === 2) blockGradesRef.current.set(String(e[0]), e[1]);
        }
      }
      if (typeof c4.scanSeconds === "number") scanSecondsRef.current = Math.max(0, c4.scanSeconds);
      else scanSecondsRef.current = 12;
      pressPersistRef.current = c4.press && c4.press.built ? { built: true, vx: c4.press.vx, vz: c4.press.vz } : null;
      setPressUi({ built: !!pressPersistRef.current, queued: 0, refined: 0 });
      pendingEventsRef.current.clear();
      setLedger({ ...ledgerRef.current });
    }

    // âââ Void creatures (Chunk 3): night wraiths that erode weak edges âââââ
    // No pathfinding â they hover and drift toward targets. Spawn at the
    // lowest-protection exposed faces of the 3D frontier during active/
    // aggressive void phases (caps: aggressive 3, active 1, passive 0 â
    // despawn at dawn). They bite the exact block they reach â any exposed
    // face, including undersides and overhangs â via
    // removeBlockFrom(...,"void_creature"), so every bite is
    // ledger-conserving (world â void). Eat rate slows with local
    // protection; strong protection repels them back to weak ground.
    type VoidCreature = {
      vx: number; vy: number; vz: number;
      tx: number; ty: number; tz: number;
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

    let voidFrontierCache: { picks: Array<{ vx: number; vy: number; vz: number; p: number }>; median: number; at: number } = { picks: [], median: 1, at: -Infinity };
    const weakestFrontier = (n: number, now = performance.now()) => {
      if (now - voidFrontierCache.at > 5000 || voidFrontierCache.picks.length < n) {
        const frontier: Array<{ vx: number; vy: number; vz: number }> = [];
        const hasBlocks = (k: string) => {
          const colSet = colMap.get(k);
          return !!colSet && colSet.size > 0;
        };
        for (const k of colMap.keys()) {
          if (!hasBlocks(k)) continue;
          const parts = k.split(",");
          const vx = +parts[0], vz = +parts[1];
          let open = false;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!hasBlocks((vx + dx) + "," + (vz + dz))) { open = true; break; }
          }
          if (!open) {
            // Frontier rule: columns with vertical gaps (bridge undersides,
            // overhangs, interior shafts) are exposed surface too â the void
            // attacks any exposed face, not just horizontal edges.
            const colSet = colMap.get(k)!;
            let yMin = Infinity, yMax = -Infinity;
            for (const y of colSet) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
            if (colSet.size < yMax - yMin + 1) open = true;
          }
          if (open) frontier.push({ vx, vy: -Infinity, vz });
        }
        const scored: Array<{ vx: number; vy: number; vz: number; p: number }> = [];
        const stride = Math.max(1, Math.floor(frontier.length / 400));
        for (let i = 0; i < frontier.length; i += stride) {
          const { vx, vz } = frontier[i];
          // Weight protection down by exposure: a block with 4â5 open faces
          // (spindle, overhang underside) is far weaker surface than a flat
          // top with 1 â necking falls out of this for free.
          let maxExp = 1;
          let bestY = 0;
          const colSet = colMap.get(vx + "," + vz);
          if (colSet) {
            let first = true;
            for (const y of colSet) {
              const e = exposureAt(vx, y, vz);
              if (first || e > maxExp || (e === maxExp && y > bestY)) { maxExp = Math.max(e, 1); bestY = y; first = false; }
            }
          }
          scored.push({ vx, vy: bestY, vz, p: protectionAt(vx, vz) / (1 + 0.5 * (maxExp - 1)) });
        }
        scored.sort((a, b) => a.p - b.p);
        const median = scored.length > 0 ? scored[Math.floor(scored.length / 2)].p : 1;
        voidFrontierCache = { picks: scored.slice(0, Math.max(n, 6)), median, at: now };
      }
      return voidFrontierCache;
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
      group.userData.eye = eye;
      return group;
    };

    const spawnVoidCreature = (vx: number, vy: number, vz: number) => {
      const group = makeVoidBody();
      scene.add(group);
      const c: VoidCreature = { vx, vy, vz, tx: vx, ty: vy, tz: vz, group, lastEatMs: performance.now(), eaten: 0, bobPhase: Math.random() * Math.PI * 2 };
      voidCreatures.push(c);
      console.log("[tinyworld] void creature spawned at", vx, vy, vz);
      return c;
    };
    const despawnVoidCreature = (c: VoidCreature) => {
      scene.remove(c.group);
      const i = voidCreatures.indexOf(c);
      if (i >= 0) voidCreatures.splice(i, 1);
    };

    const VOID_TICK_MS = 1000;
    const VOID_EAT_BASE_MS = 6000;
    // Eat-fx pool: expanding pink wireframe cube spawned at the eaten block.
    // Pooled meshes so spam doesn't allocate. Ticked in the main render loop.
    type EatFx = { mesh: any; t0: number };
    const eatFx: EatFx[] = [];
    const eatFxPool: any[] = [];
    const spawnEatFx = (vx: number, vy: number, vz: number) => {
      let m = eatFxPool.pop();
      if (!m) {
        const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(voxel * 1.0, voxel * 1.0, voxel * 1.0));
        const mat = new THREE.LineBasicMaterial({ color: 0xff5fbd, transparent: true, opacity: 1, depthWrite: false });
        m = new THREE.LineSegments(g, mat);
      }
      m.material.opacity = 1;
      m.scale.setScalar(1);
      m.position.set((vx - cxRound) * voxel, vy * voxel, (vz - czRound) * voxel);
      scene.add(m);
      eatFx.push({ mesh: m, t0: performance.now() });
    };
    const tickEatFx = (now: number) => {
      for (let i = eatFx.length - 1; i >= 0; i--) {
        const f = eatFx[i];
        const t = (now - f.t0) / 450;
        if (t >= 1) {
          scene.remove(f.mesh);
          eatFxPool.push(f.mesh);
          eatFx.splice(i, 1);
        } else {
          f.mesh.scale.setScalar(1 + t * 0.8);
          f.mesh.material.opacity = 1 - t;
        }
      }
    };
    const tickVoidCreatures = (now: number) => {
      const phase = voidPhaseNow();
      const cap = phase === "aggressive" ? 3 : phase === "active" ? 1 : 0;
      while (voidCreatures.length > cap) despawnVoidCreature(voidCreatures[voidCreatures.length - 1]);
      if (cap > 0) {
        const { picks, median } = weakestFrontier(cap, now);
        if (voidCreatures.length < cap && picks.length > 0) {
          const pick = picks[voidCreatures.length % picks.length];
          spawnVoidCreature(pick.vx, pick.vy, pick.vz);
        }
        const repelThreshold = Math.max(0.5, median * 2.5);
        for (const c of voidCreatures) {
          const ddx = c.tx - c.vx, ddy = c.ty - c.vy, ddz = c.tz - c.vz;
          const dist = Math.hypot(ddx, ddy, ddz);
          if (dist > 0.01) {
            const step = Math.min(dist, 2.0);
            c.vx += (ddx / dist) * step;
            c.vy += (ddy / dist) * step;
            c.vz += (ddz / dist) * step;
          }
          // Surface-clamp Y: hover above the topmost block in this column so
          // the wraith doesn't phase through walls/towers. Reads colMap which
          // is already maintained as blocks change.
          {
            const cxNow = Math.round(c.vx), czNow = Math.round(c.vz);
            const colSetNow = colMap.get(cxNow + "," + czNow);
            if (colSetNow && colSetNow.size > 0) {
              let topY = -Infinity;
              for (const y of colSetNow) if (y > topY) topY = y;
              const hoverY = topY + 1.2;
              if (c.vy < hoverY) c.vy = hoverY;
            }
          }
          const nearBomb = bombs.find((b) => Math.hypot(b.vx - c.vx, b.vz - c.vz) < 14);
          if (nearBomb) {
            if (Math.hypot(nearBomb.vx - c.vx, nearBomb.vz - c.vz) < 1.3) {
              detonate(nearBomb, new Set());
              break;
            }
            c.tx = nearBomb.vx;
            c.ty = nearBomb.vy;
            c.tz = nearBomb.vz;
          }
          const cx = Math.round(c.vx), cy = Math.round(c.vy), cz = Math.round(c.vz);
          const prot = protectionAt(cx, cz);
          if (prot > repelThreshold && picks.length > 0) {
            const pick = picks[Math.floor(Math.random() * picks.length)];
            c.tx = pick.vx;
            c.ty = pick.vy;
            c.tz = pick.vz;
          } else if (Math.hypot(c.tx - c.vx, c.ty - c.vy, c.tz - c.vz) < 0.8) {
            const relProt = median > 0 ? prot / median : 1;
            const eatMs = (VOID_EAT_BASE_MS * (1 + 3 * relProt)) / VOID_SEASON_MULT;
            if (now - c.lastEatMs > eatMs) {
              let ate = false;
              // Frontier rule: bite the MOST exposed block in this column â
              // not just the top. Undersides of bridges and overhangs (5
              // open faces) erode before flat ground (1), so thin geometry
              // necks and severs exactly as mass-and-density.md describes.
              let vtarget: number | null = null;
              let bestExp = 0;
              const colSet = colMap.get(cx + "," + cz);
              if (colSet) {
                for (const y of colSet) {
                  const e = exposureAt(cx, y, cz);
                  if (e > bestExp || (e === bestExp && (vtarget === null || y > vtarget))) { bestExp = e; vtarget = y; }
                }
              }
              if (vtarget !== null) {
                const slotKey = cx + "," + vtarget + "," + cz;
                for (const m of meshesRef.current) {
                  if (m.userData?.slotMap?.has(slotKey)) {
                    if (removeBlockFrom(m, cx, vtarget, cz, "void_creature")) {
                      syncGroundAfterRemove(cx, vtarget, cz, m.userData.layer);
                      c.eaten += 1;
                      voidEatenTotal += 1;
                      ate = true;
                      // Visual feedback: pink wireframe burst at eaten cell
                      // + eye flare on the wraith itself.
                      spawnEatFx(cx, vtarget, cz);
                      (c as any).eyeFlareUntil = now + 220;
                    }
                    break;
                  }
                }
              }
              c.lastEatMs = now;
              if (!ate && picks.length > 0) {
                const pick = picks[Math.floor(Math.random() * picks.length)];
                c.tx = pick.vx;
                c.ty = pick.vy;
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
        const hoverY = (c.vy + 1.1) * voxel + Math.sin(now * 0.0022 + c.bobPhase) * voxel * 0.35;
        c.group.position.set((c.vx - cxRound) * voxel, hoverY, (c.vz - czRound) * voxel);
        c.group.rotation.y = now * 0.0009 + c.bobPhase;
        const eye = c.group.userData.eye;
        if (eye && eye.scale) {
          const flareUntil = (c as any).eyeFlareUntil || 0;
          const t = Math.max(0, (flareUntil - now) / 220);
          eye.scale.setScalar(1 + t * 1.6);
        }
      }
    };

    // âââ Scan economy + press (Chunk 4) âââââââââââââââââââââââââââââââââââââ
    // Scanning new land is the ONLY legitimate baseline increase â fresh
    // matter enters the conservation ledger via a `scan` block_event.
    // Material rolls are mostly raw loam/stone; rare pure metal veins and
    // very rare core blocks (docs/mass-and-density.md Â§9.3). The press
    // compresses 4 stockpiled blocks of a tier into 1 of the next
    // (4Ãd â 1Ã4d): mass conserved exactly, block COUNT drops by 3, so the
    // block-count baseline drops with it via a `compress` event.
    const scanDirtMesh = makeGrowable(PAL.dirt, 3072, "dirt");
    const scanGrassMesh = makeGrowable(PAL.grass, 1536, "grass");
    const stoneMesh = makeGrowable(0x6e7178, 1024, "stone");
    const metalMesh = makeGrowable(0x9fb4c0, 384, "metal");
    const densiumMesh = makeGrowable(0x4b2e6f, 96, "densium");
    const coreScanMesh = makeGrowable(0xffd75e, 16, "core");
    const blockGrades = blockGradesRef.current;

    // Restore saved scan-economy layers â snapshotLiveLayers persists them
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

    // Scan-seconds: one banked currency (docs/scan-economy.md). Bloom feeds
    // the bank via ledgerMove's grow accrual; spending is expand (scan new
    // land) or purge (re-sweep owned territory to expel the void).
    const SCAN_SEC_CAP = 60;
    const SCAN_COST_SEC = 10;
    const PURGE_COST_SEC = 5;
    const PURGE_RADIUS = 8;
    const PURGE_MAX_BLOCKS = 16;
    if (typeof window !== "undefined") {
      const ovSec = new URLSearchParams(window.location.search).get("scansec");
      if (ovSec !== null) scanSecondsRef.current = Math.max(0, Math.min(999, parseInt(ovSec, 10) || 0));
    }
    let scanCount = 0;
    let purgeCount = 0;
    let lastScanTickMs = 0;
    let lastScanUiSent = -1;
    const tickScan = (now: number) => {
      const secs = Math.floor(scanSecondsRef.current);
      if (secs !== lastScanUiSent) {
        lastScanUiSent = secs;
        setScanUi({ charge: secs, scans: scanCount });
      }
    };

    // 3D frontier scan: scanning adds BLOCKS, not "land". The frontier is
    // ANY exposed face of the scanned volume (docs/persistence-and-access.md)
    // â sideways off an edge, up a wall, down under an overhang. Pick a
    // random exposed face with open space along its normal and grow a
    // connected blob of new matter from it; the old horizontal patch is just
    // the special case where the face normal is horizontal.
    const scanNewLand = () => {
      if (scanSecondsRef.current < SCAN_COST_SEC) return { ok: false, reason: "need " + SCAN_COST_SEC + "s banked, have " + Math.floor(scanSecondsRef.current) + "s" };
      // Sample random occupied blocks; take the first exposed face with room
      // to grow (â¥4 of 5 probe cells empty along the outward normal). A
      // cramped face (interior notch) is kept only as a fallback.
      const keys = Array.from(colMap.keys());
      let seed: { x: number; y: number; z: number } | null = null;
      let normal: [number, number, number] = [1, 0, 0];
      let fallbackSeed: { s: { x: number; y: number; z: number }; n: [number, number, number] } | null = null;
      for (let tries = 0; tries < 400 && !seed; tries++) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        const colSet = colMap.get(k);
        if (!colSet || colSet.size === 0) continue;
        const parts = k.split(",");
        const x = +parts[0], z = +parts[1];
        const ys = Array.from(colSet);
        const y = ys[Math.floor(Math.random() * ys.length)];
        const dirs = FACE_DIRS.slice();
        for (let i = dirs.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t;
        }
        for (const d of dirs) {
          if (hasBlockAt(x + d[0], y + d[1], z + d[2])) continue;
          let freeOut = 0;
          for (let probe = 1; probe <= 5; probe++) {
            if (!hasBlockAt(x + d[0] * probe, y + d[1] * probe, z + d[2] * probe)) freeOut++;
          }
          const cand = { x: x + d[0], y: y + d[1], z: z + d[2] };
          if (freeOut >= 4) {
            seed = cand;
            normal = [d[0], d[1], d[2]];
          } else if (!fallbackSeed) {
            fallbackSeed = { s: cand, n: [d[0], d[1], d[2]] };
          }
          break;
        }
      }
      if (!seed && fallbackSeed) { seed = fallbackSeed.s; normal = fallbackSeed.n; }
      if (!seed) return { ok: false, reason: "no exposed frontier face found" };
      // Blob shape: ellipsoid reaching outward along the face normal. A
      // horizontal normal reproduces the old slab (long Ã wide Ã ~3 thick);
      // a vertical normal grows a shaft/cap â same rule, no special case.
      const D = 8 + Math.floor(Math.random() * 4);
      const semiN = D / 2;
      const verticalScan = normal[1] !== 0;
      const semiW = verticalScan ? 3.5 : 5 + Math.random();
      const semiT = verticalScan ? 3.5 : 1.4 + Math.random() * 0.8;
      const c0 = {
        x: seed.x + normal[0] * (semiN - 0.5),
        y: seed.y + normal[1] * (semiN - 0.5),
        z: seed.z + normal[2] * (semiN - 0.5),
      };
      // Decompose offsets into (along-normal, lateral, thickness) components.
      const blobVal = (bx: number, by: number, bz: number): number => {
        const ox = bx - c0.x, oy = by - c0.y, oz = bz - c0.z;
        let a: number, p1: number, p2: number;
        if (normal[0] !== 0) { a = ox; p1 = oz; p2 = oy; }
        else if (normal[2] !== 0) { a = oz; p1 = ox; p2 = oy; }
        else { a = oy; p1 = ox; p2 = oz; }
        return (a / semiN) * (a / semiN) + (p1 / semiW) * (p1 / semiW) + (p2 / semiT) * (p2 / semiT);
      };
      // Collect empty candidate cells inside the (noisy) ellipsoid, then BFS
      // from the seed so the blob is one connected piece attached to the
      // face it grew from â no floating fragments behind existing geometry.
      const candidates = new Set<string>();
      const rx = Math.ceil(normal[0] !== 0 ? semiN : (normal[2] !== 0 ? semiW : semiW)) + 1;
      const ry = Math.ceil(normal[1] !== 0 ? semiN : semiT) + 1;
      const rz = Math.ceil(normal[2] !== 0 ? semiN : (normal[0] !== 0 ? semiW : semiW)) + 1;
      const cxc = Math.round(c0.x), cyc = Math.round(c0.y), czc = Math.round(c0.z);
      for (let bx = cxc - rx; bx <= cxc + rx; bx++) {
        for (let by = cyc - ry; by <= cyc + ry; by++) {
          for (let bz = czc - rz; bz <= czc + rz; bz++) {
            if (hasBlockAt(bx, by, bz)) continue;
            if (blobVal(bx, by, bz) <= 1 + (Math.random() * 0.3 - 0.15)) candidates.add(bx + "," + by + "," + bz);
          }
        }
      }
      candidates.add(seed.x + "," + seed.y + "," + seed.z);
      const blob: Array<{ x: number; y: number; z: number }> = [];
      const blobSet = new Set<string>();
      const queue = [seed.x + "," + seed.y + "," + seed.z];
      blobSet.add(queue[0]);
      while (queue.length > 0) {
        const ck = queue.shift()!;
        const cp = ck.split(",");
        const bx = +cp[0], by = +cp[1], bz = +cp[2];
        blob.push({ x: bx, y: by, z: bz });
        for (const d of FACE_DIRS) {
          const nk = (bx + d[0]) + "," + (by + d[1]) + "," + (bz + d[2]);
          if (candidates.has(nk) && !blobSet.has(nk)) { blobSet.add(nk); queue.push(nk); }
        }
      }
      if (blob.length === 0) return { ok: false, reason: "frontier face had no room" };
      // Classify cells: a cell whose up-neighbor is open (outside the blob
      // AND empty in the world) reads as surface â it gets grass/dirt and a
      // ground-map sync. Everything else is body matter (dirt/stone by how
      // buried it is). Vein/core rolls land in body cells only.
      const isTop: boolean[] = blob.map((c) => !blobSet.has(c.x + "," + (c.y + 1) + "," + c.z) && !hasBlockAt(c.x, c.y + 1, c.z));
      const bodyIdx: number[] = [];
      for (let i = 0; i < blob.length; i++) if (!isTop[i]) bodyIdx.push(i);
      const veinCells = new Set<number>();
      if (bodyIdx.length > 0 && Math.random() < 0.18) {
        const veinSize = 4 + Math.floor(Math.random() * 4);
        const start = Math.floor(Math.random() * bodyIdx.length);
        for (let i = 0; i < veinSize; i++) veinCells.add(bodyIdx[(start + i) % bodyIdx.length]);
      }
      const coreIdx = bodyIdx.length > 0 && Math.random() < 0.03 ? bodyIdx[Math.floor(Math.random() * bodyIdx.length)] : -1;
      let added = 0;
      let veinBlocks = 0;
      let coreFound = false;
      for (let i = 0; i < blob.length; i++) {
        const { x, y, z } = blob[i];
        if (isTop[i]) {
          const topMesh = Math.random() < 0.5 ? scanGrassMesh : scanDirtMesh;
          const topLayer = topMesh === scanGrassMesh ? "grass" : "dirt";
          if (topMesh && spawnBlockInto(topMesh, x, y, z, "scan")) {
            added++;
            syncGroundAfterPlace(x, y, z, topLayer);
          }
          continue;
        }
        let bodyMesh = scanDirtMesh;
        if (i === coreIdx) bodyMesh = coreScanMesh;
        else if (veinCells.has(i)) bodyMesh = metalMesh;
        else {
          const buried = blobSet.has(x + "," + (y + 1) + "," + z) && blobSet.has(x + "," + (y - 1) + "," + z);
          if (buried || Math.random() < 0.25) bodyMesh = stoneMesh;
        }
        if (bodyMesh && spawnBlockInto(bodyMesh, x, y, z, "scan")) {
          added++;
          if (bodyMesh === metalMesh) {
            blockGrades.set(x + "," + y + "," + z, "pure");
            veinBlocks++;
          } else if (bodyMesh === coreScanMesh) {
            coreFound = true;
          }
        }
      }
      if (added === 0) return { ok: false, reason: "no blocks spawned (capacity?)" };
      // spawnBlockInto moved `added` from VOIDâWORLD; scans mint NEW matter,
      // so refund the reservoir and raise the baseline â the one legit way.
      const L = ledgerRef.current as any;
      L.void += added;
      L.baseline += added;
      queueBlockEvent("scan", added, "scan_land");
      setLedger({ ...L });
      scanSecondsRef.current -= SCAN_COST_SEC;
      scanCount += 1;
      setScanUi({ charge: Math.floor(scanSecondsRef.current), scans: scanCount });
      const dirName = normal[1] === 1 ? "up" : normal[1] === -1 ? "down" : normal[0] === 1 ? "+x" : normal[0] === -1 ? "-x" : normal[2] === 1 ? "+z" : "-z";
      console.log("[tinyworld] frontier scan (" + dirName + "):", added, "blocks at", seed.x, seed.y, seed.z, veinBlocks ? "(pure metal vein Ã" + veinBlocks + ")" : "", coreFound ? "(CORE FOUND)" : "");
      return { ok: true, added, anchor: { x: seed.x, z: seed.z }, seed, normal: dirName, veinBlocks, coreFound };
    };

    // Purge: LiDAR is directed perception and the void is unperceived space â
    // re-sweeping owned territory expels void-pool mass back as RAW matter
    // (mass conserved, grades lost, per the entropy law).
    const purgeSweep = (vx?: number, vy?: number, vz?: number) => {
      if (scanSecondsRef.current < PURGE_COST_SEC) return { ok: false, reason: "need " + PURGE_COST_SEC + "s banked, have " + Math.floor(scanSecondsRef.current) + "s" };
      const cx = typeof vx === "number" ? vx : Math.round(camera.position.x / voxel) + cxRound;
      const cy = typeof vy === "number" ? vy : Math.round(camera.position.y / voxel);
      const cz = typeof vz === "number" ? vz : Math.round(camera.position.z / voxel) + czRound;
      scanSecondsRef.current -= PURGE_COST_SEC;
      let expelledCreatures = 0;
      for (let i = voidCreatures.length - 1; i >= 0; i--) {
        const c = voidCreatures[i];
        if (Math.hypot(c.vx - cx, c.vy - cy, c.vz - cz) <= PURGE_RADIUS) {
          despawnVoidCreature(c);
          expelledCreatures++;
        }
      }
      const L = ledgerRef.current as any;
      let reclaimed = 0;
      for (let tries = 0; tries < 80 && reclaimed < PURGE_MAX_BLOCKS && L.void >= 1; tries++) {
        const r1 = Math.random() * 2 - 1;
        const r2 = Math.random() * 2 - 1;
        const r3 = Math.random() * 2 - 1;
        const len = Math.hypot(r1, r2, r3) || 1;
        const rad = Math.random() * PURGE_RADIUS;
        const x = cx + Math.round((r1 / len) * rad);
        const y = cy + Math.round((r2 / len) * rad);
        const z = cz + Math.round((r3 / len) * rad);

        let hasNeighbor = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
           const s = colMap.get((x + dx) + "," + (z + dz));
           if (s && s.has(y + dy)) { hasNeighbor = true; break; }
        }
        const s = colMap.get(x + "," + z);
        if (!hasNeighbor || (s && s.has(y))) continue;

        if (spawnBlockInto(scanDirtMesh, x, y, z, "purge")) {
          syncGroundAfterPlace(x, y, z, "dirt");
          reclaimed++;
        }
      }
      purgeCount += 1;
      if (reclaimed > 0) queueBlockEvent("purge", reclaimed, "purge_sweep");
      setScanUi({ charge: Math.floor(scanSecondsRef.current), scans: scanCount });
      console.log("[tinyworld] purge sweep at", cx, cy, cz, "â", reclaimed, "reclaimed,", expelledCreatures, "creatures expelled");
      return { ok: true, at: [cx, cy, cz], reclaimed, creaturesExpelled: expelledCreatures, secondsLeft: Math.floor(scanSecondsRef.current) };
    };

    const PRESS_LADDER: Record<string, string> = { dirt: "stone", stone: "metal", metal: "densium", densium: "core" };
    const drainPoolLow = (layer: string, n: number) => {
      const pool = gradePool(layer);
      for (const g of ["raw", "worked", "pure"] as const) {
        const t = Math.min(pool[g], n);
        pool[g] -= t;
        n -= t;
        if (n <= 0) break;
      }
    };
    const PRESS_COST_STONE = 12;
    let pressGroup: any = null;
    const makePressBody = () => {
      const group = new THREE.Group();
      const matBase = new THREE.MeshPhongMaterial({ color: 0x6e7178, shininess: 10 });
      const base = new THREE.Mesh(new THREE.BoxGeometry(voxel * 1.8, voxel * 0.8, voxel * 1.8), matBase);
      base.position.y = voxel * 0.4;
      const matMetal = new THREE.MeshPhongMaterial({ color: 0x9fb4c0, shininess: 60 });
      const ram = new THREE.Mesh(new THREE.BoxGeometry(voxel * 1.2, voxel * 0.5, voxel * 1.2), matMetal);
      ram.position.y = voxel * 1.3;
      const pillarL = new THREE.Mesh(new THREE.BoxGeometry(voxel * 0.25, voxel * 1.6, voxel * 0.25), matMetal);
      pillarL.position.set(-voxel * 0.75, voxel * 0.9, 0);
      const pillarR = pillarL.clone();
      pillarR.position.x = voxel * 0.75;
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(voxel * 0.3), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
      crystal.position.y = voxel * 1.85;
      group.add(base); group.add(ram); group.add(pillarL); group.add(pillarR); group.add(crystal);
      return group;
    };
    const placePressMesh = (x: number, z: number) => {
      if (pressGroup) scene.remove(pressGroup);
      const top = colTop(x, z) ?? (groundRef.current?.map.get(x + "," + z) ?? 0);
      pressGroup = makePressBody();
      pressGroup.position.set((x - cxRound) * voxel, (top + 1) * voxel, (z - czRound) * voxel);
      scene.add(pressGroup);
    };
    const buildPress = (vx?: number, vz?: number) => {
      if (pressPersistRef.current && pressPersistRef.current.built) return { ok: false, reason: "press already built" };
      const sp = stockpileByLayerRef.current;
      if ((sp.stone || 0) < PRESS_COST_STONE) return { ok: false, reason: "need " + PRESS_COST_STONE + " stockpiled stone, have " + (sp.stone || 0) };
      const x = typeof vx === "number" ? vx : cxRound + 3;
      const z = typeof vz === "number" ? vz : czRound + 3;
      ledgerMove("stockpile", "built", PRESS_COST_STONE, "press_build", "stone");
      placePressMesh(x, z);
      pressPersistRef.current = { built: true, vx: x, vz: z };
      setPressUi((u) => ({ ...u, built: true }));
      console.log("[tinyworld] press built at", x, z);
      return { ok: true, vx: x, vz: z };
    };
    if (pressPersistRef.current && pressPersistRef.current.built) {
      placePressMesh(pressPersistRef.current.vx, pressPersistRef.current.vz);
    }
    const pressCompress = (layer: string) => {
      const next = PRESS_LADDER[layer];
      if (!next) return { ok: false, reason: layer + " is not compressible" };
      if (!pressPersistRef.current || !pressPersistRef.current.built) return { ok: false, reason: "no press built â buildPress() first (" + PRESS_COST_STONE + " stone)" };
      const sp = stockpileByLayerRef.current;
      const have = sp[layer] || 0;
      if (have < 4) return { ok: false, reason: "need 4 stockpiled " + layer + ", have " + have };
      const pool = gradePool(layer);
      const clean = pool.pure >= 4;
      if (clean) pool.pure -= 4;
      else drainPoolLow(layer, 4);
      sp[layer] = have - 4;
      const L = ledgerRef.current as any;
      L.stockpile -= 3;
      L.baseline -= 3;
      if (clean) {
        sp[next] = (sp[next] || 0) + 1;
        gradePool(next).raw += 1;
        queueBlockEvent("compress", 3, "press_" + layer);
        setLedger({ ...L });
        console.log("[tinyworld] press: 4 pure " + layer + " â 1Ã" + next);
        return { ok: true, clean: true, from: layer, to: next, stockpile: { ...sp } };
      }
      // Impure feed â the lattice shears under load (mass-and-density Â§6):
      // output is an unstable slug, not a usable block.
      sp["slug_" + next] = (sp["slug_" + next] || 0) + 1;
      queueBlockEvent("compress", 3, "slug_" + layer);
      setLedger({ ...L });
      updateBombUi();
      console.log("[tinyworld] press: impure " + layer + " feed â 1 unstable " + next + " slug");
      return { ok: true, clean: false, from: layer, slug: next, slugs: sp["slug_" + next], stockpile: { ...sp } };
    };

    // Bloom-fed refinement: the press upgrades one stockpiled block per cycle
    // (rawâworkedâpure), burning 1 stockpiled fruit per grade step.
    const REFINE_MS = 20000;
    let refineQueue: { layer: string; queued: number } | null = null;
    let refinedTotal = 0;
    let lastRefineMs = 0;
    const startRefine = (layer: string, n = 1) => {
      if (!PRESS_LADDER[layer]) return { ok: false, reason: layer + " is not refinable" };
      if (!pressPersistRef.current || !pressPersistRef.current.built) return { ok: false, reason: "no press built â buildPress() first (" + PRESS_COST_STONE + " stone)" };
      const sp = stockpileByLayerRef.current;
      if ((sp[layer] || 0) < 1) return { ok: false, reason: "no stockpiled " + layer };
      if (refineQueue && refineQueue.layer !== layer) return { ok: false, reason: "press busy refining " + refineQueue.layer };
      if (!refineQueue) lastRefineMs = typeof performance !== "undefined" ? performance.now() : 0;
      refineQueue = { layer, queued: (refineQueue ? refineQueue.queued : 0) + Math.max(1, n) };
      setPressUi((u) => ({ ...u, queued: refineQueue!.queued }));
      return { ok: true, layer, queued: refineQueue.queued };
    };
    const tickRefine = (now: number) => {
      if (!refineQueue || now - lastRefineMs < REFINE_MS) return;
      lastRefineMs = now;
      const q = refineQueue;
      const sp = stockpileByLayerRef.current as any;
      const pool = gradePool(q.layer);
      const from = pool.raw > 0 ? "raw" : pool.worked > 0 ? "worked" : null;
      if (from === null || (sp[q.layer] || 0) < 1) {
        refineQueue = null;
        setPressUi((u) => ({ ...u, queued: 0 }));
        return;
      }
      if ((sp.fruit || 0) < 1) return; // starved â wait for bloom to restock fruit
      ledgerMove("stockpile", "void", 1, "press_refine", "fruit");
      const to = from === "raw" ? "worked" : "pure";
      pool[from] -= 1;
      (pool as any)[to] += 1;
      refinedTotal += 1;
      q.queued -= 1;
      if (q.queued <= 0) refineQueue = null;
      setPressUi((u) => ({ ...u, queued: refineQueue ? refineQueue.queued : 0, refined: refinedTotal }));
      console.log("[tinyworld] press refined 1 " + q.layer + " " + from + "â" + to + " (fruit burned)");
    };

    // âââ Keel core ships (Chunk 5) ââââââââââââââââââââââââââââââââââââââââââ
    // A keel is a core taught to move (docs/mass-and-density.md Â§8). Building
    // a ship binds 1 core + 8 stone hull from STOCKPILE into BUILT. Flight
    // burns hull mass into the void (1 block per 6 cells â flight feeds the
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
      if (ship.fuel < 1) return { ok: false, reason: "stranded â no hull mass left to burn" };
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
            console.log("[tinyworld] ship stranded at", Math.round(ship.x), Math.round(ship.z), "â hull burned out");
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

    // âââ The Return â unstable slugs and bombs (Chunk 5b, Â§9.4) âââââââââââ
    // The press accepts raw matter; the imperfections store strain. A slug is
    // press math with the output flagged unstable instead of stockpiled.
    // Detonation cascades the slug back down the ladder â 4 raw blocks rain
    // out per slug, the exact inverse of the compress that made it, so the
    // baseline returns to where it started. The shockwave reuses the
    // protection law (force = strain/(1+dÂ²) â¥ density) to shake top blocks
    // loose as net-zero rescatter: nothing destroyed, everything disordered.
    // Creatures in radius dissipate (their bound mass returns void â world),
    // and bombs inside a blast also Return â chains.
    type Bomb = { vx: number; vy: number; vz: number; size: number; tier: string; group: any };
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
      if (!pressPersistRef.current || !pressPersistRef.current.built) return { ok: false, reason: "no press built â buildPress() first (" + PRESS_COST_STONE + " stone)" };
      const sp = stockpileByLayerRef.current as any;
      const have = sp[layer] || 0;
      if (have < 4) return { ok: false, reason: "need 4 stockpiled " + layer + ", have " + have };
      sp[layer] = have - 4;
      sp["slug_" + next] = (sp["slug_" + next] || 0) + 1;
      drainPoolLow(layer, 4);
      const L = ledgerRef.current as any;
      L.stockpile -= 3;
      L.baseline -= 3;
      queueBlockEvent("compress", 3, "slug_" + layer);
      setLedger({ ...L });
      updateBombUi();
      console.log("[tinyworld] slug pressed: 4Ã" + layer + " â 1 unstable " + next);
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

    const placeBomb = (vx: number, vy: number, vz: number, size: number, tier = "stone") => {
      if (size !== 1 && size !== 8 && size !== 27) return { ok: false, reason: "size must be 1, 8 or 27" };
      const sp = stockpileByLayerRef.current as any;
      const have = sp["slug_" + tier] || 0;
      if (have < size) return { ok: false, reason: "need " + size + " " + tier + " slugs, have " + have };
      sp["slug_" + tier] = have - size;
      ledgerMove("stockpile", "built", size, "bomb_place");
      const group = makeBombBody(size);
      group.position.set((vx - cxRound) * voxel, (vy + 0.4) * voxel, (vz - czRound) * voxel);
      scene.add(group);
      bombs.push({ vx, vy, vz, size, tier, group });
      updateBombUi();
      return { ok: true, vx, vy, vz, size, tier, strain: size };
    };

    const detonate = (bomb: Bomb, visited: Set<Bomb>): any => {
      if (visited.has(bomb)) return null;
      visited.add(bomb);
      const bi = bombs.indexOf(bomb);
      if (bi < 0) return null;
      bombs.splice(bi, 1);
      scene.remove(bomb.group);
      const { vx, vy, vz, size, tier } = bomb;
      const L = ledgerRef.current as any;
      const strain = size;
      const rMax = 2 + Math.cbrt(size);

      // 1. Decompression â each slug cascades a tier down: 4 raw blocks out.
      // built â void for the slugs, then spawn 4Ãsize (void â world each);
      // mint the +3Ãsize count difference exactly like scanNewLand, which
      // cancels the â3/slug the press took when the slug was made.
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

      // 2. Shockwave â crack blocks within the 3D radius where incident
      // force â¥ its density; remove + rescatter just outside the radius
      // (worldâvoid then voidâworld: net-zero, disorder not destruction).
      const blastR = Math.ceil(Math.sqrt(Math.max(0, strain / 0.25 - 1)));
      let cracked = 0;
      for (let dx = -blastR; dx <= blastR; dx++) {
        for (let dy = -blastR; dy <= blastR; dy++) {
          for (let dz = -blastR; dz <= blastR; dz++) {
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > blastR * blastR) continue;
            const force = strain / (1 + d2);
            const bx = Math.round(bomb.vx) + dx;
            const by = Math.round(bomb.vy) + dy;
            const bz = Math.round(bomb.vz) + dz;
            
            const bkey = bx + "," + by + "," + bz;
            let bmesh: any = null;
            for (const m of meshesRef.current) if (m.userData?.slotMap?.has(bkey)) { bmesh = m; break; }
            if (!bmesh) continue;
            
            const blayer = bmesh.userData.layer as string;
            if (force < densityOf(blayer)) continue;
            if (removeBlockFrom(bmesh, bx, by, bz, "detonate")) {
              syncGroundAfterRemove(bx, by, bz, blayer);
              for (let a = 0; a < 10; a++) {
                const ang1 = Math.random() * Math.PI * 2;
                const ang2 = Math.random() * Math.PI;
                const rad = blastR + 1 + Math.random() * 3;
                const sx = Math.round(bomb.vx + Math.sin(ang2) * Math.cos(ang1) * rad);
                const sy = Math.round(bomb.vy + Math.cos(ang2) * rad);
                const sz = Math.round(bomb.vz + Math.sin(ang2) * Math.sin(ang1) * rad);
                
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
      }

      // 3. The Return un-makes the void's only ordered things â creatures in
      // radius dissipate, their bound stolen mass scattering back voidâworld.
      let dissipated = 0, massReturned = 0;
      for (const c of [...voidCreatures]) {
        if (Math.hypot(c.vx - bomb.vx, c.vy - bomb.vy, c.vz - bomb.vz) > blastR + 2) continue;
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

      // 4. Chain reactions â slugs inside a blast also Return.
      let chained = 0;
      for (const other of [...bombs]) {
        if (visited.has(other)) continue;
        const od2 = (other.vx - bomb.vx) ** 2 + (other.vy - bomb.vy) ** 2 + (other.vz - bomb.vz) ** 2;
        if (strain / (1 + od2) >= 1) {
          if (detonate(other, visited)) chained++;
        }
      }

      detonationsTotal++;
      setLedger({ ...L });
      updateBombUi();
      console.log("[tinyworld] RETURN: " + size + "-slug " + tier + " bomb â " + spawnedRaw + " raw " + down + " out, " + cracked + " cracked, " + dissipated + " creatures dissipated, " + chained + " chained");
      return { ok: true, size, tier, raw: spawnedRaw, cracked, dissipated, massReturned, chained };
    };

    // âââ Debug / test harness (window.__tw) ââââââââââââââââââââââââââââââ
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
      // Mean |Îy| per moving frame, in voxel units. Smooth walking â < 0.02;
      // visible jitter shows up as > 0.1.
      jitter: () => {
        let sum = 0, n = 0;
        for (let i = 1; i < __twSamples.length; i++) {
          const a = __twSamples[i - 1], b = __twSamples[i];
          const horiz = Math.hypot(b.x - a.x, b.z - a.z);
          if (horiz < voxel * 0.01) continue;
          // Skip teleport-sized discontinuities â they're not walk jitter.
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
      // Voice-command goal injection. Replaces every worker's goal with the
      // spoken text and clears their current plan so the next planner tick
      // picks up the new goal. Returns the number of workers affected.
      setGoal: (goal: string) => {
        if (!goal || typeof goal !== "string") return 0;
        for (const w of workers) {
          (w as any).goal = goal;
          w.plan = null;
          w.lastPlanFailMs = 0;
          (w as any).wanderFails = 0;
          (w as any).stuckPlanRequested = false;
        }
        return workers.length;
      },
      // Worker visual style. Pass "tars" for the Interstellar-inspired
      // monolith slab worker; "humanoid" (default) restores the original.
      // Rebuilds existing workers in place so the swap is live.
      setWorkerStyle: (style: string) => {
        const s: "humanoid" | "tars" | "ghibli" =
          (style === "tars") ? "tars" :
          (style === "humanoid") ? "humanoid" : "ghibli";
        (window as any).__tw.workerStyle = s;
        for (const w of workers) {
          const oldGroup = w.group;
          const px = oldGroup.position.x, py = oldGroup.position.y, pz = oldGroup.position.z;
          const ry = oldGroup.rotation.y;
          const wasCarrying = !!w.carrying;
          scene.remove(oldGroup);
          const { group: newGroup, carried: newCarry } = buildWorkerVisual(s);
          newGroup.position.set(px, py, pz);
          newGroup.rotation.y = ry;
          if (wasCarrying) newCarry.visible = true;
          scene.add(newGroup);
          w.group = newGroup;
          w.carriedMesh = newCarry;
        }
        return workers.length;
      },
      // Worker gait override. Pass "slow" | "normal" | "fast" | "auto".
      // "auto" (default) selects based on movement speed: slow > 2200ms/cell,
      // normal 1000-2200ms/cell, fast < 1000ms/cell. Only affects TARS-style
      // workers.
      setGait: (gait: string) => {
        const g = ["slow", "normal", "fast", "auto"].includes(gait) ? gait : "auto";
        (window as any).__tw.gaitOverride = g;
        return g;
      },
      // Outline postprocess control. Pass any subset of:
      //   { enabled, thickness, depthThreshold, normalThreshold, color, mix }
      // color accepts a hex number (0x0a0a14) or a CSS string.
      setOutline: (opts: any = {}) => {
        const o = (window as any).__twOutline;
        if (!o) return null;
        if (typeof opts.enabled === "boolean") o.state.enabled = opts.enabled;
        if (typeof opts.thickness === "number") o.pass.uniforms.thickness.value = opts.thickness;
        if (typeof opts.depthThreshold === "number") o.pass.uniforms.depthThreshold.value = opts.depthThreshold;
        if (typeof opts.normalThreshold === "number") o.pass.uniforms.normalThreshold.value = opts.normalThreshold;
        if (typeof opts.mix === "number") o.pass.uniforms.outlineMix.value = opts.mix;
        if (opts.color !== undefined) o.pass.uniforms.outlineColor.value.set(opts.color);
        return {
          enabled: o.state.enabled,
          thickness: o.pass.uniforms.thickness.value,
          depthThreshold: o.pass.uniforms.depthThreshold.value,
          normalThreshold: o.pass.uniforms.normalThreshold.value,
          mix: o.pass.uniforms.outlineMix.value,
        };
      },
      // Diagnostic: flip individual postprocess/lighting systems on or off
      // to isolate which one is producing the screen-stable horizontal band.
      // Pass true/false for any of { env, ssao, outline, hemi, fog }; only
      // changed fields are touched. Returns the current state.
      diagBand: (opts: any = {}) => {
        const savedEnv = (scene as any).__diagSavedEnv ?? scene.environment;
        if (opts.env === false) { (scene as any).__diagSavedEnv = scene.environment; scene.environment = null; }
        if (opts.env === true)  { scene.environment = savedEnv; (scene as any).__diagSavedEnv = null; }
        if (opts.ssao === false) ssaoPass.enabled = false;
        if (opts.ssao === true)  ssaoPass.enabled = true;
        if (opts.outline === false) (window as any).__twOutline.state.enabled = false;
        if (opts.outline === true)  (window as any).__twOutline.state.enabled = true;
        if (opts.hemi === false) hemi.intensity = 0;
        if (opts.hemi === true)  hemi.intensity = 1.8;
        const savedFog = (scene as any).__diagSavedFog ?? scene.fog;
        if (opts.fog === false) { (scene as any).__diagSavedFog = scene.fog; scene.fog = null; }
        if (opts.fog === true)  { scene.fog = savedFog; (scene as any).__diagSavedFog = null; }
        if (opts.bloom === false) bloomPass.enabled = false;
        if (opts.bloom === true)  bloomPass.enabled = true;
        if (opts.under === false) under.intensity = 0;
        if (opts.under === true)  under.intensity = 1.2;
        // Kill the entire postprocess chain in one go â renders raw scene
        // straight to canvas. If band survives this, it's lighting/geometry,
        // not a screen-space pass.
        if (opts.post === false) { ssaoPass.enabled = false; bloomPass.enabled = false; (window as any).__twOutline.state.enabled = false; }
        if (opts.post === true)  { ssaoPass.enabled = true; bloomPass.enabled = true; (window as any).__twOutline.state.enabled = true; }
        return {
          env: !!scene.environment,
          ssao: ssaoPass.enabled,
          outline: (window as any).__twOutline?.state?.enabled,
          hemi: hemi.intensity,
          fog: !!scene.fog,
          bloom: bloomPass.enabled,
          under: under.intensity,
        };
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
        perimMedian: weakestFrontier(1).median,
        creatures: voidCreatures.map((c) => ({ vx: c.vx, vy: c.vy, vz: c.vz, tx: c.tx, ty: c.ty, tz: c.tz, eaten: c.eaten })),
      }),
      spawnCreature: (vx?: number, vy?: number, vz?: number) => {
        if (typeof vx === "number" && typeof vy === "number" && typeof vz === "number") { spawnVoidCreature(vx, vy, vz); return true; }
        const { picks } = weakestFrontier(1);
        if (picks.length === 0) return false;
        spawnVoidCreature(picks[0].vx, picks[0].vy, picks[0].vz);
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
      purge: (vx?: number, vy?: number, vz?: number) => purgeSweep(vx, vy, vz),
      scanInfo: () => ({ seconds: Math.floor(scanSecondsRef.current), cap: SCAN_SEC_CAP, scanCost: SCAN_COST_SEC, purgeCost: PURGE_COST_SEC, scans: scanCount, purges: purgeCount }),
      compress: (layer: string) => pressCompress(layer),
      buildPress: (vx?: number, vz?: number) => buildPress(vx, vz),
      refine: (layer: string, n = 1) => startRefine(layer, n),
      pressInfo: () => ({
        built: !!(pressPersistRef.current && pressPersistRef.current.built),
        at: pressPersistRef.current ? [pressPersistRef.current.vx, pressPersistRef.current.vz] : null,
        costStone: PRESS_COST_STONE,
        ladder: PRESS_LADDER,
        refining: refineQueue ? refineQueue.layer : null,
        queued: refineQueue ? refineQueue.queued : 0,
        refined: refinedTotal,
        pool: JSON.parse(JSON.stringify(stockGradesRef.current)),
      }),
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
      placeBomb: (vx: number, vy: number, vz: number, size = 1, tier = "stone") => placeBomb(vx, vy, vz, size, tier),
      detonate: (idx = 0) => (bombs[idx] ? detonate(bombs[idx], new Set()) : { ok: false, reason: "no bomb " + idx }),
      bombInfo: () => ({
        bombs: bombs.map((b) => ({ vx: b.vx, vy: b.vy, vz: b.vz, size: b.size, tier: b.tier })),
        slugs: Object.fromEntries(Object.entries(stockpileByLayerRef.current as any).filter(([k]) => k.startsWith("slug_"))),
        detonations: detonationsTotal,
      }),
    };

    // âââ Supplier Sentinel: MechGolem GLB w/ rigged animations ââââââââââââââââ
    // Loaded from /sentinel.glb â 13 joints, 4 baked clips
    // (Sitting, SitToStand, StandToSit, WalkSlow). Sentinel sits dormant
    // when the user is in the void; on Walk mode (F) entry it plays
    // SitToStand â WalkSlow (gentle standing sway). On exit, StandToSit â
    // Sitting. AnimationMixer crossfades between states with 0.25s fade.
    const sentinelGroup = new THREE.Group();
    scene.add(sentinelGroup);
    // Face the world centroid â flip 180Â° so the eye cluster faces inward
    // toward the player rather than out to the void.
    sentinelGroup.rotation.y = Math.PI;
    // Scale GLB (5.4 unit native height) up to ~13.5 std-block height.
    const SENTINEL_TARGET_H = 13.5 * voxel;
    const SENTINEL_NATIVE_H = 5.4;
    sentinelGroup.scale.setScalar(SENTINEL_TARGET_H / SENTINEL_NATIVE_H);

    let sentinelMixer: any = null;
    const sentinelActions: Record<string, any> = {};
    type SentState = "sitting" | "standingUp" | "standing" | "sittingDown";
    let sentinelAnimState: SentState = "sitting";

    const playSentinelClip = (name: string, loop: boolean) => {
      const next = sentinelActions[name];
      if (!next) return;
      for (const k of Object.keys(sentinelActions)) {
        if (k !== name) sentinelActions[k].fadeOut(0.25);
      }
      next.reset();
      next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop;
      next.enabled = true;
      next.setEffectiveTimeScale(1);
      next.setEffectiveWeight(1);
      next.fadeIn(0.25);
      next.play();
    };

    new GLTFLoader().load("/sentinel.glb", (gltf: any) => {
      const root = gltf.scene;
      root.traverse((obj: any) => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
          obj.frustumCulled = false; // skinned bounding boxes are unreliable
          // Recolor to match the wall palette (PAL.wall = 0x9a8c7c).
          // Replace the GLB's baked materials with a uniform stone color
          // so the sentinel reads as carved from the same material as the
          // world's walls. Handles both single and array material slots.
          const makeWallMat = () => new THREE.MeshStandardMaterial({
            color: 0x9a8c7c,
            roughness: 0.92,
            metalness: 0.04,
          });
          if (Array.isArray(obj.material)) {
            obj.material = obj.material.map(() => makeWallMat());
          } else if (obj.material) {
            obj.material = makeWallMat();
          }
        }
      });
      sentinelGroup.add(root);

      sentinelMixer = new THREE.AnimationMixer(root);
      for (const clip of gltf.animations) {
        sentinelActions[clip.name] = sentinelMixer.clipAction(clip);
      }
      // Chain one-shot transitions into their idle loop on completion.
      sentinelMixer.addEventListener("finished", (e: any) => {
        const finishedName = Object.keys(sentinelActions).find(k => sentinelActions[k] === e.action);
        if (finishedName === "SitToStand") {
          sentinelAnimState = "standing";
          playSentinelClip("WalkSlow", true);
        } else if (finishedName === "StandToSit") {
          sentinelAnimState = "sitting";
          playSentinelClip("Sitting", true);
        }
      });
      // Initial state matches current walk mode (almost always false at scene init).
      if (walkingRef.current) {
        sentinelAnimState = "standingUp";
        playSentinelClip("SitToStand", false);
      } else {
        sentinelAnimState = "sitting";
        playSentinelClip("Sitting", true);
      }
    }, undefined, (err: any) => {
      console.warn("[sentinel] failed to load GLB:", err);
    });

    let sx = cxRound + 5, sz = czRound + 5, sy = 0;
    const sentinelState = { vx: sx, vz: sz, vy: sy, active: false };
    let sentinelLastMs = performance.now();

    const tickSentinel = (now: number) => {
      const delta = Math.min(0.1, (now - sentinelLastMs) / 1000);
      sentinelLastMs = now;
      const want = walkingRef.current;
      // State-machine transitions: only fire on edge.
      if (want && (sentinelAnimState === "sitting" || sentinelAnimState === "sittingDown")) {
        sentinelAnimState = "standingUp";
        playSentinelClip("SitToStand", false);
      } else if (!want && (sentinelAnimState === "standing" || sentinelAnimState === "standingUp")) {
        sentinelAnimState = "sittingDown";
        playSentinelClip("StandToSit", false);
      }
      // Gate WalkSlow on actual user movement: when standing, only animate
      // the walk cycle while the player is pressing WASD or driving the
      // mobile joystick. When idle, freeze the clip on its current frame
      // (timeScale 0) so the sentinel stands still rather than marching
      // in place.
      if (sentinelAnimState === "standing") {
        const walkAction = sentinelActions["WalkSlow"];
        if (walkAction) {
          let moving = false;
          if (isMobileRef.current) {
            const j = joystickRef.current;
            moving = !!(j && j.active && (Math.abs(j.x) > 0.05 || Math.abs(j.y) > 0.05));
          } else {
            const k = keysRef.current;
            moving = !!(k && (k["KeyW"] || k["KeyA"] || k["KeyS"] || k["KeyD"]));
          }
          // Slow the gait: even at full pace, WalkSlow runs at 0.4Ã the
          // baked clip rate so the sentinel reads as heavy/lumbering.
          walkAction.setEffectiveTimeScale(moving ? 0.4 : 0);
        }
      }
      if (sentinelMixer) sentinelMixer.update(delta);
    };

    // Drone anchor: pose where the MechGolem freezes while the drone is out.
    // Captured every frame in walk+large mode so we have a fresh pose ready
    // the instant the user flips to drone.
    const droneAnchorRef = { x: 0, y: 0, z: 0, yaw: 0, set: false };

    const renderSentinel = (_now: number) => {
      // In walk mode the sentinel becomes the player's avatar: position it
      // at the camera's XZ with feet at the camera's ground level (camera
      // sits EYE_HEIGHT above the ground). Rotation tracks the camera's
      // facing â plus the default 180Â° flip so the sentinel's eyes look
      // forward with the camera, not backward.
      if (walkingRef.current) {
        if (sentinelModeRef.current === "drone" && droneAnchorRef.set) {
          sentinelGroup.position.set(droneAnchorRef.x, droneAnchorRef.y, droneAnchorRef.z);
          sentinelGroup.rotation.y = droneAnchorRef.yaw;
          return;
        }
        const feetY = camera.position.y - EYE_HEIGHT - WALK_CAMERA_LIFT;
        sentinelGroup.position.set(camera.position.x, feetY, camera.position.z);
        sentinelGroup.rotation.y = camera.rotation.y + Math.PI;
        droneAnchorRef.x = camera.position.x;
        droneAnchorRef.y = feetY;
        droneAnchorRef.z = camera.position.z;
        droneAnchorRef.yaw = camera.rotation.y + Math.PI;
        droneAnchorRef.set = true;
        return;
      }
      // Out of walk mode (void/orbit view): anchor to world centroid on
      // first render once groundMap is populated.
      if (groundMap.size > 0 && sentinelState.vx === sx) {
        let sumX = 0, sumZ = 0, n = 0;
        for (const k of groundMap.keys()) {
          const [vx, vz] = k.split(",").map(Number);
          sumX += vx; sumZ += vz; n++;
        }
        sentinelState.vx = Math.round(sumX / n);
        sentinelState.vz = Math.round(sumZ / n);
        const top = groundMap.get(sentinelState.vx + "," + sentinelState.vz);
        sentinelState.vy = (top !== undefined ? top : 0) + 1;
      }
      const ox = (sentinelState.vx - cxRound) * voxel;
      const oz = (sentinelState.vz - czRound) * voxel;
      const oy = sentinelState.vy * voxel;
      sentinelGroup.position.set(ox, oy, oz);
      sentinelGroup.rotation.y = Math.PI;
    };

    let prev = performance.now();
    let frameCount = 0;
    // Tracks the last applied bob delta so subsequent frames cancel the prior
    // sin offset cleanly (otherwise it accumulates and the drone climbs).
    const lastDroneBobRef = { value: 0 };
    const loop = () => {
      try {
        rafRef.current = requestAnimationFrame(loop);
        frameCount += 1;
        // Live TOD tint: re-interpolate hemisphere + ambient + rim every ~2s
        // so mood drifts with real time without re-baking PMREM (expensive).
        if (frameCount % 120 === 0 && !_todOv) {
          const _a = anchorRef.current;
          const liveTp = paletteAt(_solarVirtualHour(Date.now(), _a.lat, _a.lon));
          hemi.color.setHex(liveTp.hemiS);
          hemi.groundColor.setHex(liveTp.hemiG);
          // hemi.intensity intentionally NOT updated â hemi is OFF by default
          // and the live tint loop must not re-enable it. Toggle on with
          // __tw.diagBand({ hemi: true }) if you want the moonlit ambient back.
          rim.color.setHex(liveTp.rim);
          rim.intensity = liveTp.rimI;
          // Re-aim the sun (and its shadow camera) to match the real solar
          // position right now. Updating position alone is enough â the
          // DirectionalLight's shadow camera follows its position; target
          // stays at origin (world center).
          const dir = _solarDirection(Date.now(), _a.lat, _a.lon);
          const rr = span * 3;
          sun.position.set(dir.x * rr, dir.y * rr, dir.z * rr);
          sun.shadow.camera.updateProjectionMatrix();
        }
        const now = performance.now();
        tickOrganic(now);
        if (now - lastWorkerTickMs > 100) {
          tickWorkers(now);
          lastWorkerTickMs = now;
          if (now - lastWorkerUiMs > 500) {
            lastWorkerUiMs = now;
            const w0 = workers[0];
            if (w0) {
              lastWorkerUiHadWorker = true;
              setWorkerUi({
                name: w0.name || "Worker",
                mode: w0.mode,
                plan: w0.plan ? w0.plan.name : null,
                error: (w0 as any).lastPlanError || null,
              });
            } else if (lastWorkerUiHadWorker) {
              lastWorkerUiHadWorker = false;
              setWorkerUi(null);
            }
          }
        }
        renderWorkers(now);
        tickSentinel(now);
        renderSentinel(now);
        if (now - lastVoidTickMs > VOID_TICK_MS) {
          tickVoidCreatures(now);
          lastVoidTickMs = now;
        }
        renderVoidCreatures(now);
        tickEatFx(now);
        if (now - lastScanTickMs > 1000) {
          tickScan(now);
          lastScanTickMs = now;
        }
        tickRefine(now);
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

        if (fp.isLocked || __twSim.walk || (isMobileRef.current && walkingRef.current)) {
          if (orbit.enabled) orbit.enabled = false;
          const speed = MOVE_SPEED * dt;
          const oldX = camera.position.x;
          const oldZ = camera.position.z;
          const wasStuck = bodyBlockedAtY(oldX, camera.position.y, oldZ);
          
          let inF = 0, inR = 0;
          if (isMobileRef.current && joystickRef.current.active) {
            inF = -joystickRef.current.y;
            inR = joystickRef.current.x;
          } else {
            if (keysRef.current["KeyW"]) inF += 1;
            if (keysRef.current["KeyS"]) inF -= 1;
            if (keysRef.current["KeyD"]) inR += 1;
            if (keysRef.current["KeyA"]) inR -= 1;
          }

          if (isMobileRef.current) {
            if (lookJoystickRef.current.active) {
              const lookSensitivity = 2.5 * dt;
              targetLookRef.current.y -= lookJoystickRef.current.x * lookSensitivity;
              targetLookRef.current.x -= lookJoystickRef.current.y * lookSensitivity;
              targetLookRef.current.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, targetLookRef.current.x));
            }

            const lookLerp = Math.min(1, dt * 18);
            camera.rotation.order = 'YXZ';
            camera.rotation.y += (targetLookRef.current.y - camera.rotation.y) * lookLerp;
            camera.rotation.x += (targetLookRef.current.x - camera.rotation.x) * lookLerp;
          }

          const isDrone = sentinelModeRef.current === "drone";

          if (!isDrone && isMobileRef.current && mobileActionsRef.current.jump && Math.abs(velocityYRef.current) < 0.01) {
            velocityYRef.current = JUMP_VELOCITY;
            mobileActionsRef.current.jump = false;
          }

          const inLen = Math.hypot(inF, inR);
          if (inLen > 0) {
            // Drone mode: use full camera direction (incl. pitch) so pushing
            // the stick forward while looking down dives. Walk mode: strip y.
            const moveDir = new THREE.Vector3(inR / inLen, 0, -inF / inLen);
            moveDir.applyQuaternion(camera.quaternion);
            if (!isDrone) {
              moveDir.y = 0;
              moveDir.normalize();
            }
            const moveSpeed = isDrone ? speed * 1.8 : speed; // drone is snappier
            camera.position.addScaledVector(moveDir, moveSpeed);
          }

          // Drone vertical thrust: hold the ascend/descend buttons (mobile) or
          // Space/Shift (desktop). Unbounded â unlimited flight by design.
          if (isDrone) {
            const thrust = MOVE_SPEED * dt * 1.4;
            let vert = 0;
            if (isMobileRef.current) {
              if (mobileActionsRef.current.droneAscend || mobileActionsRef.current.jump) vert += 1;
              if (mobileActionsRef.current.droneDescend) vert -= 1;
            } else {
              if (keysRef.current["Space"]) vert += 1;
              if (keysRef.current["ShiftLeft"] || keysRef.current["ShiftRight"]) vert -= 1;
            }
            if (vert !== 0) camera.position.y += vert * thrust;
            // Ambient hover bob: 6 cm sinusoid so the drone feels alive even
            // when input is zero. Tiny enough not to wreck aim.
            const bob = Math.sin(now * 0.003) * voxel * 0.08;
            camera.position.y += bob - (lastDroneBobRef.value || 0);
            lastDroneBobRef.value = bob;
            // Mobile jump tap should not survive across frames in drone mode.
            mobileActionsRef.current.jump = false;
          }

          if (isMobileRef.current && mobileActionsRef.current.action) {
            if (carryState) tryPlace();
            else tryPickup();
            mobileActionsRef.current.action = false;
          }

          const newX = camera.position.x;
          const newZ = camera.position.z;
          if (!isDrone && !wasStuck) {
            if (isBlockedAt(newX, oldZ)) camera.position.x = oldX;
            if (isBlockedAt(camera.position.x, newZ)) camera.position.z = oldZ;
          }
          let recoveringFromStuck = false;
          if (!isDrone && wasStuck) {
            for (let s = 0; s < 32 && bodyBlockedAtY(camera.position.x, camera.position.y, camera.position.z); s++) {
              camera.position.y += voxel * 0.5;
            }
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
          const groundY = sampleGround(camera.position.x, camera.position.z, camera.position.y - EYE_HEIGHT - WALK_CAMERA_LIFT, playerR);
          const eye = groundY + EYE_HEIGHT + WALK_CAMERA_LIFT;
          // Off-world detection: is there any scanned column within the body
          // radius? If not, treat as void â no eye-clamp, gravity drops the
          // player past the world edge until the dynamic kill-plane respawns.
          let overWorld = false;
          {
            const g = groundRef.current;
            if (g && g.map.size > 0) {
              const v = g.voxel;
              const minVX = Math.round((camera.position.x - playerR) / v) + g.cx;
              const maxVX = Math.round((camera.position.x + playerR) / v) + g.cx;
              const minVZ = Math.round((camera.position.z - playerR) / v) + g.cz;
              const maxVZ = Math.round((camera.position.z + playerR) / v) + g.cz;
              outer: for (let vx = minVX; vx <= maxVX; vx++) {
                for (let vz = minVZ; vz <= maxVZ; vz++) {
                  if (g.map.has(vx + "," + vz)) { overWorld = true; break outer; }
                }
              }
            }
          }
          if (!isDrone && !recoveringFromStuck) {
            if (!overWorld) {
              // Off-world: unbounded gravity, no eye clamp.
              velocityYRef.current -= GRAVITY * dt;
              camera.position.y += velocityYRef.current * dt;
              const g = groundRef.current;
              if (g && camera.position.y < (g.minY - 40) * g.voxel) {
                // Past the dynamic kill-plane (40 voxels below the world's
                // lowest scanned cell â follows downward scans). Respawn.
                enterWalkRef.current?.();
              }
            } else if (velocityYRef.current > 0 || camera.position.y > eye + voxel * 0.5) {
              velocityYRef.current -= GRAVITY * dt;
              camera.position.y += velocityYRef.current * dt;
              if (camera.position.y < eye) {
                camera.position.y = eye;
                velocityYRef.current = 0;
              }
            } else {
              const lerp = Math.min(1, dt * 14);
              camera.position.y += (eye - camera.position.y) * lerp;
              if (Math.abs(eye - camera.position.y) < voxel * 0.02) {
                camera.position.y = eye;
              }
              velocityYRef.current = 0;
            }
          }

          if (chargeState) {
            const elapsed = now - chargeState.startMs;
            const pct = Math.min(1, elapsed / chargeState.hardMs);
            if (ring) {
              ring.style.setProperty("--p", String(pct * 100));
              ring.style.opacity = "1";
            }
            const cs = chargeState;
            const layerName = (cs.mesh?.userData?.layer as string) || "block";
            if (miningPill) {
              miningPill.textContent = `MINING ${layerName.toUpperCase()} ${Math.round(pct * 100)}%`;
              miningPill.style.opacity = "1";
            }
            highlight.position.set((cs.vx - cxRound) * voxel, cs.vy * voxel, (cs.vz - czRound) * voxel);
            hlMat.color.setHex(pct < 0.5 ? 0xffeb6a : 0xffa040);
            highlight.visible = true;
            if (pct >= 1) {
              lastChargeEndMs = now;
              completePickup();
            }
          } else if (ring && ring.style.opacity !== "0") {
            if (now - lastChargeEndMs > 300) {
              ring.style.opacity = "0";
              if (miningPill) miningPill.style.opacity = "0";
            }
          }

          if (!carryState) {
            if ((frameCount % 3) === 0) {
              const hit = marchRay();
              if (hit) {
                highlight.position.set((hit.vx - cxRound) * voxel, hit.vy * voxel, (hit.vz - czRound) * voxel);
                const lyr = (hit.mesh.userData?.layer as string) || "block";
                const hardness = MOVE_MS[lyr] ?? 500;
                if (!isFinite(hardness)) hlMat.color.setHex(0xe06868);
                else if (hardness >= 2500) hlMat.color.setHex(0x8a6bff);
                else if (hardness >= 1000) hlMat.color.setHex(0xa6b8ff);
                else hlMat.color.setHex(0xffeb6a);
                highlight.visible = true;
              } else {
                highlight.visible = false;
              }
            }
          } else if (highlight.visible) {
            highlight.visible = false;
          }

          if (carryState) {
            const carryColor = (carryState as any).color;
            if (carryColor !== undefined && (ghostMesh.material as any).color) {
              (ghostMesh.material as any).color.set(carryColor);
            }
            if ((frameCount % 2) === 0) {
              const target = getPlacementTarget();
              if (target) {
                ghostMesh.position.set(target.world.x, target.world.y, target.world.z);
                ghostMesh.visible = true;
                (ghostMesh.material as any).opacity = 0.45;
              } else {
                const forward2 = new THREE.Vector3();
                camera.getWorldDirection(forward2);
                const hold = camera.position.clone().addScaledVector(forward2, voxel * 1.6);
                hold.y -= voxel * 0.4;
                ghostMesh.position.set(hold.x, hold.y, hold.z);
                ghostMesh.visible = true;
                (ghostMesh.material as any).opacity = 0.22;
              }
            }
          } else if (ghostMesh.visible) {
            ghostMesh.visible = false;
            (ghostMesh.material as any).color?.set?.(0xffffff);
          }
        } else {
          orbit.update();
          if (ring.style.opacity !== "0") ring.style.opacity = "0";
          if (ghostMesh.visible) ghostMesh.visible = false;
        }

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
          const walkActive = fp.isLocked || (isMobileRef.current && walkingRef.current);
          let targetOpacity = 1;
          if (!walkActive && xrayRef.current) {
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
            if (walkActive) {
              m.material.opacity = 1;
              m.material.transparent = false;
              m.material.depthWrite = true;
            } else {
              m.material.transparent = true;
              m.material.depthWrite = false;
              m.material.opacity += (targetOpacity - m.material.opacity) * 0.12;
            }
          };
          lerp(fade.ceiling);
          lerp(fade.wallUpper);
        }

        if (composerRef.current) {
          if (outlineState.enabled) {
            // Normal/depth prepass into normalTarget. overrideMaterial forces
            // every mesh to write view-space normals; the DepthTexture on the
            // target captures depth automatically.
            scene.overrideMaterial = normalMaterial;
            renderer.setRenderTarget(normalTarget);
            renderer.clear();
            renderer.render(scene, camera);
            scene.overrideMaterial = null;
            renderer.setRenderTarget(null);
            // Keep linearization in sync with the live camera.
            outlinePass.uniforms.cameraNear.value = camera.near;
            outlinePass.uniforms.cameraFar.value = camera.far;
          }
          outlinePass.enabled = outlineState.enabled;
          composerRef.current.render();
        } else {
          renderer.render(scene, camera);
        }
      } catch (err: any) {
        if (!(window as any).__twLoopError) {
          (window as any).__twLoopError = true;
          const el = document.createElement("div");
          el.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:red;color:white;padding:20px;z-index:10000;font-family:monospace;pointer-events:none;max-width:90vw;word-wrap:break-word";
          el.textContent = "LOOP CRASH: " + (err.message || String(err));
          document.body.appendChild(el);
          console.error("LOOP CRASH:", err);
        }
      }
    };
    loop();

    setBlocks(currentBlocks);
    setCatchUpInfo(catchUpInfo);
    setPhase("ready");
  }, [anchor.lat, anchor.lon, fetchWeather]);

  const onLoadSelected = useCallback(async (overrideId?: string) => {
    const worldId = overrideId || selectedWorldId || worlds.find((w) => w.hasSavedBlocks)?.id || "";
    if (!worldId) {
      setLoadNote("no saved world selected");
      return;
    }
    try {
      setLoadNote("loadingâ¦");
      const saved = await loadWorldToScene(worldId);
      const world = worlds.find((w) => w.id === worldId) || null;
      persistWorldMeta(worldId, world?.name || String(saved.meta?.worldName ?? saved.meta?.sourceName ?? "TinyWorld save"));
      await buildWorld(saved);
      setLoadNote(`loaded ${saved.blockCount.toLocaleString()} blocks from ${world?.name ?? "saved world"}`);
    } catch (error) {
      console.error("[tinyworld] world load failed:", error);
      setLoadNote(error instanceof Error ? error.message : String(error));
    }
  }, [buildWorld, loadWorldToScene, persistWorldMeta, selectedWorldId, worlds]);

  const onSaveSelected = useCallback(async () => {
    const worldId = selectedWorldId || worlds.find((w) => w.hasSavedBlocks)?.id || "";
    if (!worldId) {
      setLoadNote("no world selected â use Save As");
      return;
    }
    try {
      setLoadNote("savingâ¦");
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
    root: { position: "fixed", inset: 0, width: "100dvw", height: "100dvh", background: "#07070f", overflow: "hidden", fontFamily: "'SF Mono', monospace" } as React.CSSProperties,
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

  const BotwStamina = ({ value, max }: { value: number, max: number }) => (
    <div className="relative w-16 h-16 flex items-center justify-center">
      <svg className="absolute inset-0 w-full h-16 transform -rotate-90 filter drop-shadow-[0_0_4px_rgba(74,222,128,0.4)]">
        <circle cx="32" cy="32" r="26" stroke="rgba(0,0,0,0.4)" strokeWidth="5" fill="none" />
        <circle 
          cx="32" cy="32" r="26" 
          stroke="#4ade80" 
          strokeWidth="4" 
          fill="none" 
          strokeDasharray={163.3} 
          strokeDashoffset={163.3 * (1 - value / max)} 
          strokeLinecap="round"
          className="transition-all duration-500 ease-out"
        />
      </svg>
      <Zap className="w-6 h-6 text-green-400" />
    </div>
  );

  const BotwHearts = ({ health }: { health: number }) => {
    const total = 5;
    const filled = Math.ceil(health * total);
    return (
      <div className="flex gap-1 filter drop-shadow-[0_0_4px_rgba(239,68,68,0.3)]">
        {Array.from({ length: total }).map((_, i) => (
          <Heart 
            key={i} 
            className={`w-5 h-5 ${i < filled ? "text-red-500 fill-red-500" : "text-red-900 opacity-30"}`} 
            strokeWidth={3}
          />
        ))}
      </div>
    );
  };

  // Matter integrity readout â slim NieR-style indicator.
  // Reads as a quiet field instrument, not a health bar: a thin etched
  // line whose right edge is "eaten" by a faint void-purple gradient as
  // world matter drains. Tiny tabular-nums readout below for the precise
  // ratio. Color of the held portion warms from ivory â amber â void
  // purple as integrity falls, so the indicator goes from "clear sky"
  // to "something is wrong" without ever shouting.
  const MatterReadout = ({ health }: { health: number }) => {
    const pct = Math.max(0, Math.min(1, health));
    const lostPct = 1 - pct;
    const held =
      pct > 0.7 ? "rgb(230, 225, 211)" :
      pct > 0.4 ? "rgb(216, 166, 87)" :
                  "rgb(168, 123, 214)";
    return (
      <div className="flex flex-col gap-1.5">
        <div className="relative h-[3px] w-32 overflow-hidden bg-white/[0.04]">
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-700"
            style={{
              width: `${pct * 100}%`,
              backgroundColor: held,
              boxShadow: `0 0 6px ${held}`,
            }}
          />
          {lostPct > 0.001 && (
            <div
              className="absolute inset-y-0 right-0 transition-[width] duration-700"
              style={{
                width: `${lostPct * 100}%`,
                background:
                  "linear-gradient(90deg, rgba(168,123,214,0) 0%, rgba(168,123,214,0.28) 100%)",
              }}
            />
          )}
        </div>
        <div className="flex items-baseline gap-2 text-[9px] font-mono text-white/40 tabular-nums tracking-[0.2em]">
          <span className="text-white/30">MATTER</span>
          <span className="text-white/55">{(pct * 100).toFixed(1)}</span>
        </div>
      </div>
    );
  };

  return (
    <div 
      ref={rootRef}
      style={ui.root} 
      onTouchStart={(e) => {
        if (!walking || (e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('.joystick-zone')) return;
        if (touchLookRef.current.active) return;
        const touch = e.changedTouches[0];
        touchLookRef.current = { id: touch.identifier, lastX: touch.clientX, lastY: touch.clientY, active: true };
      }}
      onTouchMove={(e) => {
        if (!touchLookRef.current.active || !walking) return;
        let touch;
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === touchLookRef.current.id) {
            touch = e.changedTouches[i];
            break;
          }
        }
        if (!touch) return;
        const dx = touch.clientX - touchLookRef.current.lastX;
        const dy = touch.clientY - touchLookRef.current.lastY;
        touchLookRef.current.lastX = touch.clientX;
        touchLookRef.current.lastY = touch.clientY;
        const sensitivity = 0.004;
        targetLookRef.current.y -= dx * sensitivity;
        targetLookRef.current.x -= dy * sensitivity;
        targetLookRef.current.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, targetLookRef.current.x));
      }}
      onTouchEnd={(e) => { 
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === touchLookRef.current.id) {
            touchLookRef.current.active = false;
            break;
          }
        }
      }}
      onTouchCancel={(e) => { 
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === touchLookRef.current.id) {
            touchLookRef.current.active = false;
            break;
          }
        }
      }}
    >
      <div ref={mountRef} style={ui.mount} />
      <button
        onClick={toggleFullscreen}
        title="Toggle fullscreen"
        aria-label="Toggle fullscreen"
        style={{
          position: "fixed",
          top: "calc(env(safe-area-inset-top, 0px) + 10px)",
          left: "calc(env(safe-area-inset-left, 0px) + 56px)",
          zIndex: 1100,
          width: 30,
          height: 30,
          padding: 0,
          background: "rgba(0,0,0,0.45)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 6,
          color: "rgba(255,255,255,0.75)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
        }}
      >
        {isFs ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      {isMobileRef.current && (
        <div className="landscape-overlay fixed inset-0 z-[99999] bg-black text-white flex-col items-center justify-center p-8 text-center"
             style={{ display: "none" }}>
          <div className="w-20 h-20 border-4 border-white/40 rounded-xl flex items-center justify-center mb-6 relative"
               style={{ animation: "spin 2s ease-in-out infinite" }}>
          </div>
          <h2 className="text-xl font-bold mb-2 tracking-widest">LANDSCAPE REQUIRED</h2>
          <p className="text-sm text-white/60">Please rotate your device horizontally to play.</p>
          <style>{`
            @media (orientation: portrait) {
              .landscape-overlay { display: flex !important; }
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              30% { transform: rotate(90deg); }
              70% { transform: rotate(90deg); }
              100% { transform: rotate(0deg); }
            }
          `}</style>
        </div>
      )}
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
          <p style={ui.sub}>NYC Temperate Â· weather + terrain + trees</p>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              marginTop: 8,
              padding: "14px 26px",
              background: "linear-gradient(180deg, rgba(138,43,226,0.28), rgba(138,43,226,0.10))",
              border: "1px solid rgba(138,43,226,0.7)",
              color: "#f5f1e8",
              fontSize: 13,
              letterSpacing: 2,
              textDecoration: "none",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              cursor: "pointer",
            }}
          >
            <ArrowUpCircle className="w-4 h-4" />
            <span>UPLOAD GLB</span>
            <input
              type="file"
              accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
              style={{ display: "none" }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;

                // Dedup: same GLB â existing saved zone, not a fresh build.
                const baseName = file.name.replace(/\.(glb|gltf)$/i, "").trim().toLowerCase();
                if (baseName) {
                  const refreshed = await fetchWorlds().catch(() => [] as any[]);
                  const pool = (refreshed && refreshed.length ? refreshed : worlds) as WorldRecord[];
                  const candidates = pool.filter((w) => {
                    if (!w.hasSavedBlocks) return false;
                    const wn = (w.name || "").toLowerCase();
                    return wn === baseName || wn.startsWith(baseName + " ") || wn.startsWith(baseName + " Â·");
                  });
                  const existing = candidates.sort((a: any, b: any) =>
                    (b.last_visited ?? b.last_scanned ?? 0) - (a.last_visited ?? a.last_scanned ?? 0)
                  )[0];
                  if (existing) {
                    setLoadNote(`recognized Â· loading saved zone`);
                    setSelectedWorldId(existing.id);
                    try {
                      await onLoadSelected(existing.id);
                    } catch (err: any) {
                      setLoadNote(`load failed: ${err?.message || err}`);
                    }
                    return;
                  }
                }

                await buildWorld(file);
                // Auto-save: tag the world with the current GPS anchor so
                // future visits to this geo bucket auto-load it.
                try {
                  const base = file.name.replace(/\.(glb|gltf)$/i, "").trim() || "TinyWorld";
                  const name = `${base} Â· ${new Date().toLocaleDateString()}`;
                  const target = await createWorldRecord(name);
                  await saveCurrentWorld(target.id, name);
                  await fetchWorlds();
                  setLoadNote(`saved Â· auto-loads next time you visit`);
                } catch (err: any) {
                  setLoadNote(`auto-save failed: ${err?.message || err}`);
                }
              }}
            />
          </label>
          <p style={{ ...ui.sub, opacity: 0.55, marginTop: 4 }}>
            drop a Scaniverse / Polycam mesh export Â· seeds a fresh tiny world
          </p>
          <a
            href="/tinyworld/capture"
            style={{
              ...ui.sub,
              opacity: 0.45,
              marginTop: 14,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            or capture with camera (experimental)
          </a>
          {nodeInfo && nodeInfo.source !== "unresolved" ? (
            <p style={{ ...ui.sub, opacity: 0.65 }}>
              node: {nodeInfo.city ?? "unknown"} ({nodeInfo.source})
              {nodeInfo.hiddenCount > 0
                ? ` Â· ${nodeInfo.hiddenCount} world${nodeInfo.hiddenCount === 1 ? "" : "s"} beyond perception`
                : ""}
            </p>
          ) : null}
          {nodeInfo && nodeInfo.source !== "gps" ? (
            <button
              type="button"
              onClick={() => {
                if (!("geolocation" in navigator)) {
                  setLoadNote("this browser has no geolocation API");
                  return;
                }
                setLoadNote("requesting locationâ¦");
                navigator.geolocation.getCurrentPosition(
                  (pos) => {
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    setAnchor({ lat, lon });
                    setLoadNote("got it â looking for saved worldsâ¦");
                    fetchWorlds({ lat, lon }).catch((e) => {
                      setLoadNote(`fetch failed: ${e?.message || e}`);
                    });
                  },
                  (err) => {
                    if (err.code === 1) setLoadNote("location denied â enable in Settings âº Safari âº Location");
                    else if (err.code === 2) setLoadNote("location unavailable");
                    else if (err.code === 3) setLoadNote("location request timed out");
                    else setLoadNote(`location error: ${err.message}`);
                  },
                  { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
                );
              }}
              style={{
                marginTop: 10,
                padding: "8px 16px",
                background: "rgba(138,43,226,0.10)",
                border: "1px solid rgba(138,43,226,0.5)",
                color: "#f5f1e8",
                fontSize: 11,
                letterSpacing: 1.5,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                cursor: "pointer",
              }}
            >
              USE MY LOCATION
            </button>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={toggleFullscreen}
              style={{
                padding: "6px 14px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#d6d6ff",
                fontSize: 10,
                letterSpacing: 1.3,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                cursor: "pointer",
              }}
            >
              FULLSCREEN
            </button>
            <button
              onClick={async () => {
                if (!window.confirm("Wipe ALL saved scans and worlds? This cannot be undone.")) return;
                setLoadNote("clearing saved scansâ¦");
                try {
                  const res = await fetch("/api/tinyworld-worlds", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify({ action: "clearAll" }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!data?.ok) throw new Error(data?.error || "clear failed");
                  savedWorldRef.current = null;
                  setSelectedWorldId(null);
                  await fetchWorlds();
                  setLoadNote("cleared Â· ready for fresh upload");
                } catch (e) {
                  setLoadNote(`clear failed: ${(e as any)?.message || e}`);
                }
              }}
              style={{
                padding: "6px 14px",
                background: "rgba(255,80,80,0.06)",
                border: "1px solid rgba(255,80,80,0.35)",
                color: "#ffb3b3",
                fontSize: 10,
                letterSpacing: 1.3,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                cursor: "pointer",
              }}
            >
              CLEAR SAVED SCANS
            </button>
          </div>
          {worlds.some((w) => w.hasSavedBlocks) && (
            <div style={ui.worldList}>
              <p style={ui.sub}>or load a saved world</p>
              {worlds.filter((w) => w.hasSavedBlocks).map((world) => (
                <button key={world.id} style={ui.worldBtn} onClick={() => { setSelectedWorldId(world.id); onLoadSelected(world.id); }}>
                  {world.name} Â· {(world.savedBlockCount ?? 0).toLocaleString()} blocks
                </button>
              ))}
              {loadNote ? <p style={ui.sub}>{loadNote}</p> : null}
            </div>
          )}
        </div>
      )}
      {(phase === "loading" || phase === "building") && (
        <div style={ui.status}>
          <p style={ui.tag}>{phase === "loading" ? "Fetching weatherâ¦" : "Building tiny worldâ¦"}</p>
          <p style={ui.tagSub}>{phase === "loading" ? "loading Open-Meteo + biome rules" : "worker voxelization + occlusion culling"}</p>
        </div>
      )}
      {phase === "ready" && !walking && (
        <>
          {/* Top-Right: Stockpile Summary */}
          <div className="absolute top-6 right-6 flex flex-col gap-3 items-end pointer-events-none">
            <div className="flex gap-4 items-center bg-black/40 backdrop-blur-md px-4 py-2 rounded-full border border-white/10">
              <div className="flex items-center gap-1.5">
                <Box className="w-4 h-4 text-amber-600" />
                <span className="text-xs text-white/80 font-medium">{ledger.stockpile}</span>
              </div>
              {pressUi.built && (
                <div className="flex items-center gap-1.5 border-l border-white/10 pl-4">
                  <Cpu className="w-4 h-4 text-blue-400" />
                  <span className="text-xs text-white/80 font-medium">{pressUi.refined}</span>
                </div>
              )}
              {shipUi.count > 0 && (
                <div className="flex items-center gap-1.5 border-l border-white/10 pl-4">
                  <Ship className="w-4 h-4 text-yellow-500" />
                  <span className="text-xs text-white/80 font-medium">{shipUi.count}</span>
                </div>
              )}
              {bombUi.slugs > 0 && (
                <div className="flex items-center gap-1.5 border-l border-white/10 pl-4" title="unstable slugs (press 4 stone â 1 slug)">
                  <Zap className="w-4 h-4 text-fuchsia-400" />
                  <span className="text-xs text-white/80 font-medium">{bombUi.slugs}</span>
                </div>
              )}
              {bombUi.bombs > 0 && (
                <div className="flex items-center gap-1.5 border-l border-white/10 pl-4" title="armed bombs">
                  <Bomb className="w-4 h-4 text-rose-400" />
                  <span className="text-xs text-white/80 font-medium">{bombUi.bombs}</span>
                </div>
              )}
            </div>
            {loadNote && (
              <div className="text-[10px] text-white/40 uppercase tracking-widest">{loadNote}</div>
            )}
            {workerUi && (
              <div className="text-[10px] uppercase tracking-widest mt-0.5" title={workerUi.error || workerUi.plan || workerUi.mode}>
                <span className="text-white/40">{workerUi.name} Â· </span>
                <span className={workerUi.error ? "text-rose-400" : workerUi.mode === "idle" ? "text-amber-300" : "text-emerald-300"}>{workerUi.mode}</span>
                {workerUi.plan && <span className="text-white/40"> Â· {workerUi.plan}</span>}
                {workerUi.error && <span className="text-rose-400"> Â· {workerUi.error}</span>}
              </div>
            )}
          </div>

          {/* Bottom-Right: Info & Scan */}
          <div className="absolute bottom-8 right-8 flex flex-col items-end gap-4">
            <div className="flex flex-col items-end gap-1 mb-2">
              <div className="flex items-center gap-3 text-white/60">
                <span className="text-[10px] uppercase tracking-tighter">{weather?.current?.label || "Sky Clear"}</span>
                {weather?.modifiers?.isRaining ? <CloudRain className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
              </div>
              <div className="flex items-center gap-2 text-white/40 text-[10px]">
                <Thermometer className="w-3 h-3" />
                <span>{Math.round(weather?.current?.temperature ?? 22)}Â°C</span>
                <Clock className="w-3 h-3 ml-2" />
                <span className="uppercase">{voidUi.phase}</span>
              </div>
            </div>
            
            <div className="group relative">
              <button 
                onClick={() => (window as any).__tw?.scan?.()}>
                <BotwStamina value={scanUi.charge} max={60} />
              </button>
              <div className="absolute right-full mr-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-[10px] text-white/40 bg-black/60 px-2 py-1 rounded border border-white/5 whitespace-nowrap uppercase tracking-widest">
                  Hold to Expand Â· 10s
                </span>
              </div>
            </div>
          </div>

          {/* Bottom-Left: World Integrity & Prompts */}
          <div className="absolute bottom-8 left-8 flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <MatterReadout health={ledger.world / (ledger.baseline || 1)} />
            </div>

            <div className="flex flex-col gap-3">
              <button 
                className="group flex items-center gap-3"
                onClick={() => enterWalkRef.current()}>
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center group-hover:bg-white group-hover:text-black transition-colors">
                  <span className="text-xs font-bold">F</span>
                </div>
                <span className="text-[11px] text-white/60 group-hover:text-white uppercase tracking-widest">Embody Worker</span>
              </button>
              
              <button 
                className="group flex items-center gap-3"
                onClick={() => setShowActions(!showActions)}>
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center group-hover:bg-blue-500/20 group-hover:border-blue-400 transition-colors">
                  <Hammer className="w-5 h-5 text-white/80 group-hover:text-blue-400" />
                </div>
                <span className="text-[11px] text-white/60 group-hover:text-white uppercase tracking-widest">Structures</span>
              </button>

              <a
                href="/tinyworld/capture"
                className="group flex items-center gap-3 no-underline">
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center group-hover:bg-purple-500/20 group-hover:border-purple-400 transition-colors">
                  <Camera className="w-5 h-5 text-white/80 group-hover:text-purple-400" />
                </div>
                <span className="text-[11px] text-white/60 group-hover:text-white uppercase tracking-widest">Capture</span>
              </a>

              <button
                className="group flex items-center gap-3"
                onClick={toggleVoice}
                title={voiceError ? "Voice: " + voiceError : (voiceListening ? "Listening â speak a goal" : "Voice command")}>
                <div className={"w-10 h-10 rounded-full border flex items-center justify-center transition-colors " + (voiceListening ? "border-amber-300 bg-amber-300/15" : "border-white/20 group-hover:bg-amber-300/15 group-hover:border-amber-300")}>
                  {voiceListening
                    ? <Mic className="w-5 h-5 text-amber-200 animate-pulse" />
                    : <MicOff className="w-5 h-5 text-white/80 group-hover:text-amber-200" />}
                </div>
                <span className="text-[11px] text-white/60 group-hover:text-white uppercase tracking-widest">
                  {voiceListening ? "Listening" : "Voice"}
                </span>
              </button>
            </div>
          </div>

          {/* Voice transcript pill */}
          {(voiceListening || voiceTranscript) && (
            <div className="pointer-events-none absolute left-6 bottom-24 z-30 max-w-md">
              <div className="px-3 py-2 rounded-md border border-amber-300/30 bg-black/60 backdrop-blur-sm">
                <div className="text-[9px] text-amber-200/70 uppercase tracking-widest font-mono">
                  {voiceListening ? "voice command â villager goal" : "last command"}
                </div>
                {voiceTranscript && (
                  <div className="text-[12px] text-amber-100/95 font-mono mt-0.5">
                    "{voiceTranscript}"
                  </div>
                )}
                {voiceError && !voiceTranscript && (
                  <div className="text-[11px] text-red-300/80 font-mono mt-0.5">{voiceError}</div>
                )}
              </div>
            </div>
          )}

          {/* Action Wheel / Overlay */}
          {targetMode && (
            <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[1100] pointer-events-none flex items-center gap-3 px-5 py-3 rounded-full bg-black/70 backdrop-blur-md border border-white/15">
              <Crosshair className={"w-5 h-5 " + (targetMode === "placeBomb" ? "text-rose-300" : "text-cyan-300")} />
              <div className="flex flex-col leading-tight">
                <span className="text-[11px] uppercase tracking-widest text-white/80">
                  {targetMode === "placeBomb" ? "Place Bomb â aim & click" : "Fly Ship â aim & click destination"}
                </span>
                <span className="text-[10px] text-white/40">Right-click or ESC to cancel</span>
              </div>
            </div>
          )}
          {showActions && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[1000]">
              <div className="flex gap-8 p-12 flex-wrap justify-center max-w-5xl">
                {!pressUi.built && (
                  <button 
                    onClick={() => { (window as any).__tw?.buildPress?.(); setShowActions(false); }}>
                    <div className="w-24 h-24 rounded-full border-2 border-white/10 flex items-center justify-center group-hover:border-white/40 group-hover:bg-white/5 transition-all">
                      <Hammer className="w-10 h-10 text-white/60 group-hover:text-white" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Build Press (12 Stone)</span>
                  </button>
                )}
                {pressUi.built && (
                  <button 
                    onClick={() => { (window as any).__tw?.compress?.("dirt"); setShowActions(false); }}>
                    <div className="w-24 h-24 rounded-full border-2 border-white/10 flex items-center justify-center group-hover:border-white/40 group-hover:bg-white/5 transition-all">
                      <Box className="w-10 h-10 text-white/60 group-hover:text-white" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Compress Dirt</span>
                  </button>
                )}
                {pressUi.built && (
                  <button 
                    className="group flex flex-col items-center gap-2"
                    onClick={() => { (window as any).__tw?.makeSlug?.("stone"); setShowActions(false); }}>
                    <div className="w-24 h-24 rounded-full border-2 border-fuchsia-400/20 flex items-center justify-center group-hover:border-fuchsia-400/60 group-hover:bg-fuchsia-500/10 transition-all">
                      <Zap className="w-10 h-10 text-fuchsia-400/70 group-hover:text-fuchsia-300" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Make Slug (4 Stone)</span>
                  </button>
                )}
                <button 
                  onClick={() => { (window as any).__tw?.buildShip?.(); setShowActions(false); }}>
                  <div className="w-24 h-24 rounded-full border-2 border-white/10 flex items-center justify-center group-hover:border-white/40 group-hover:bg-white/5 transition-all">
                    <Ship className="w-10 h-10 text-white/60 group-hover:text-white" />
                  </div>
                  <span className="text-xs text-white/40 uppercase tracking-widest">Build Ship (1 Core + 8 Stone)</span>
                </button>
                {shipUi.count > 0 && (
                  <button 
                    className="group flex flex-col items-center gap-2"
                    onClick={() => {
                      setShowActions(false);
                      setTargetMode("flyShip");
                      if (!walkingRef.current) enterWalkRef.current();
                    }}>
                    <div className="w-24 h-24 rounded-full border-2 border-cyan-400/20 flex items-center justify-center group-hover:border-cyan-400/60 group-hover:bg-cyan-500/10 transition-all">
                      <Crosshair className="w-10 h-10 text-cyan-400/70 group-hover:text-cyan-300" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Fly Ship (aim &amp; click)</span>
                  </button>
                )}
                {shipUi.count > 0 && (
                  <button 
                    className="group flex flex-col items-center gap-2"
                    onClick={() => { (window as any).__tw?.scrapShip?.(0); setShowActions(false); }}>
                    <div className="w-24 h-24 rounded-full border-2 border-yellow-500/20 flex items-center justify-center group-hover:border-yellow-500/60 group-hover:bg-yellow-500/10 transition-all">
                      <Ship className="w-10 h-10 text-yellow-500/60 group-hover:text-yellow-400" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Scrap Ship (recover core)</span>
                  </button>
                )}
                {bombUi.slugs > 0 && (
                  <button 
                    className="group flex flex-col items-center gap-2"
                    onClick={() => {
                      setShowActions(false);
                      setTargetMode("placeBomb");
                      if (!walkingRef.current) enterWalkRef.current();
                    }}>
                    <div className="w-24 h-24 rounded-full border-2 border-rose-300/20 flex items-center justify-center group-hover:border-rose-300/60 group-hover:bg-rose-400/10 transition-all">
                      <Crosshair className="w-10 h-10 text-rose-300/70 group-hover:text-rose-200" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Place Bomb (1 slug, aim &amp; click)</span>
                  </button>
                )}
                {bombUi.bombs > 0 && (
                  <button 
                    className="group flex flex-col items-center gap-2"
                    onClick={() => { (window as any).__tw?.detonate?.(0); setShowActions(false); }}>
                    <div className="w-24 h-24 rounded-full border-2 border-rose-400/20 flex items-center justify-center group-hover:border-rose-400/70 group-hover:bg-rose-500/10 transition-all">
                      <Bomb className="w-10 h-10 text-rose-400/70 group-hover:text-rose-300" />
                    </div>
                    <span className="text-xs text-white/40 uppercase tracking-widest">Detonate ({bombUi.bombs})</span>
                  </button>
                )}
                <button 
                  onClick={() => setShowActions(false)}>
                  <X className="w-10 h-10" />
                </button>
              </div>
            </div>
          )}

          {/* Mini Save Trigger (Top Left) */}
          <div className="absolute top-6 left-6 group">
            <button 
              onClick={() => setShowSave(!showSave)}>
              <Save className="w-4 h-4 text-white/40 group-hover:text-white/80" />
            </button>
            {showSave && (
              <div className="mt-4 bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-4 w-64 pointer-events-auto">
                <select 
                  value={selectedWorldId} 
                  onChange={(e) => setSelectedWorldId(e.target.value)}>
                  <option value="">Select worldâ¦</option>
                  {worlds.map((world) => (
                    <option key={world.id} value={world.id}>
                      {world.name}{world.hasSavedBlocks ? ` Â· ${(world.savedBlockCount ?? 0).toLocaleString()}` : ""}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => onLoadSelected()} className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded text-[10px] uppercase font-bold tracking-widest transition-colors">Load</button>
                  <button onClick={onSaveSelected} className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded text-[10px] uppercase font-bold tracking-widest transition-colors">Save</button>
                  <button onClick={onSaveAsSelected} className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded text-[10px] uppercase font-bold tracking-widest col-span-2 transition-colors">Save As New</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {walking && (
        <>
          {walkDebug && walkDebugUrlEnabledRef.current && (
            <div className="absolute top-20 left-4 right-4 bg-black/80 text-white text-[10px] font-mono p-2 rounded border border-yellow-400/60 pointer-events-none z-[2000] leading-tight">
              <div className="text-yellow-400 font-bold mb-1">WALK DEBUG</div>
              <div>path: {walkDebug.path} Â· placed: {String(walkDebug.placed)}</div>
              <div>workers: {walkDebug.workers} Â· ground: {walkDebug.groundSize} Â· mobile: {String(walkDebug.isMobile)}</div>
              <div>spawn: ({walkDebug.spawn.sx.toFixed(1)}, {walkDebug.spawn.sy.toFixed(1)}, {walkDebug.spawn.sz.toFixed(1)})</div>
              <div>prevCam: ({walkDebug.prevCam.x.toFixed(1)}, {walkDebug.prevCam.y.toFixed(1)}, {walkDebug.prevCam.z.toFixed(1)})</div>
              <div>camAfter: ({walkDebug.camAfter.x.toFixed(1)}, {walkDebug.camAfter.y.toFixed(1)}, {walkDebug.camAfter.z.toFixed(1)})</div>
              <div>vox: {walkDebug.voxel?.toFixed(2)} Â· eyeH: {walkDebug.eyeH?.toFixed(2)} Â· surfY: {walkDebug.sampledSurfaceY?.toFixed(2)}</div>
            </div>
          )}
          {isMobileRef.current && (
            <>
              <div className="absolute bottom-8 left-12 z-50">
                <Joystick 
                  onMove={(x, y) => { joystickRef.current = { x, y, active: true }; }}
                  onStop={() => { joystickRef.current = { x: 0, y: 0, active: false }; }}
                />
              </div>
              <div className="absolute bottom-8 right-12 z-50">
                <Joystick 
                  onMove={(x, y) => { lookJoystickRef.current = { x, y, active: true }; }}
                  onStop={() => { lookJoystickRef.current = { x: 0, y: 0, active: false }; }}
                />
              </div>
            </>
          )}
          
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-1.5 h-1.5 bg-white/40 rounded-full blur-[1px]"></div>
          </div>
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-4 pointer-events-none z-40">
             <div className="flex items-center gap-8">
               {!isMobileRef.current ? (
                 <div className="flex flex-col items-center gap-1">
                   <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center bg-black/20">
                     <span className="text-xs font-bold text-white">M1</span>
                   </div>
                   <span className="text-[9px] text-white/40 uppercase tracking-widest">{carryLayer ? "Place" : "Pick Up"}</span>
                 </div>
               ) : (
                 <button 
                   className="pointer-events-auto flex flex-col items-center gap-1 active:scale-90 transition-transform"
                   onTouchStart={(e) => { e.stopPropagation(); mobileActionsRef.current.action = true; }}
                 >
                   <div className="w-14 h-14 rounded-full border-2 border-white/30 flex items-center justify-center bg-white/10 backdrop-blur-md">
                     <Crosshair className="w-6 h-6 text-white/80" />
                   </div>
                   <span className="text-[9px] text-white/40 uppercase tracking-widest">{carryLayer ? "Place" : "Pick Up"}</span>
                 </button>
               )}

               {isMobileRef.current && sentinelMode === "large" && (
                 <button
                   className="pointer-events-auto flex flex-col items-center gap-1 active:scale-90 transition-transform"
                   onTouchStart={(e) => { e.stopPropagation(); mobileActionsRef.current.jump = true; }}
                 >
                   <div className="w-14 h-14 rounded-full border-2 border-white/30 flex items-center justify-center bg-white/10 backdrop-blur-md">
                     <ArrowUpCircle className="w-6 h-6 text-white/80" />
                   </div>
                   <span className="text-[9px] text-white/40 uppercase tracking-widest">Jump</span>
                 </button>
               )}

               {isMobileRef.current && sentinelMode === "drone" && (
                 <>
                   <button
                     className="pointer-events-auto flex flex-col items-center gap-1 active:scale-90 transition-transform select-none"
                     onTouchStart={(e) => { e.stopPropagation(); mobileActionsRef.current.droneAscend = true; }}
                     onTouchEnd={(e) => { e.stopPropagation(); mobileActionsRef.current.droneAscend = false; }}
                     onTouchCancel={(e) => { e.stopPropagation(); mobileActionsRef.current.droneAscend = false; }}
                   >
                     <div className="w-14 h-14 rounded-full border-2 border-cyan-300/80 flex items-center justify-center bg-cyan-400/15 backdrop-blur-md">
                       <ArrowUpCircle className="w-6 h-6 text-cyan-200" />
                     </div>
                     <span className="text-[9px] text-cyan-200/60 uppercase tracking-widest">Climb</span>
                   </button>
                   <button
                     className="pointer-events-auto flex flex-col items-center gap-1 active:scale-90 transition-transform select-none"
                     onTouchStart={(e) => { e.stopPropagation(); mobileActionsRef.current.droneDescend = true; }}
                     onTouchEnd={(e) => { e.stopPropagation(); mobileActionsRef.current.droneDescend = false; }}
                     onTouchCancel={(e) => { e.stopPropagation(); mobileActionsRef.current.droneDescend = false; }}
                   >
                     <div className="w-14 h-14 rounded-full border-2 border-cyan-300/80 flex items-center justify-center bg-cyan-400/15 backdrop-blur-md">
                       <ArrowUpCircle className="w-6 h-6 text-cyan-200 rotate-180" />
                     </div>
                     <span className="text-[9px] text-cyan-200/60 uppercase tracking-widest">Dive</span>
                   </button>
                 </>
               )}

               {carryLayer === "fruit" && (
                 <div className="flex flex-col items-center gap-1">
                   <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center bg-black/20">
                     <span className="text-xs font-bold text-white">E</span>
                   </div>
                   <span className="text-[9px] text-white/40 uppercase tracking-widest">Eat</span>
                 </div>
               )}

               <button
                 className="pointer-events-auto flex flex-col items-center gap-1 active:scale-90 transition-transform"
                 onClick={() => setSentinelMode(sentinelMode === "large" ? "drone" : "large")}
                 onTouchStart={(e) => { e.stopPropagation(); setSentinelMode(sentinelMode === "large" ? "drone" : "large"); }}
               >
                 <div className={`${isMobileRef.current ? "w-14 h-14" : "w-10 h-10"} rounded-full border-2 ${sentinelMode === "drone" ? "border-cyan-300/80 bg-cyan-400/10" : "border-white/30 bg-white/10"} flex items-center justify-center backdrop-blur-md`}>
                   <span className={`${isMobileRef.current ? "text-[10px]" : "text-[9px]"} font-bold ${sentinelMode === "drone" ? "text-cyan-300" : "text-white/80"}`}>{sentinelMode === "drone" ? "DRN" : "4x4"}</span>
                 </div>
                 <span className="text-[9px] text-white/40 uppercase tracking-widest">{sentinelMode === "drone" ? "Drone" : "Bulk"}</span>
               </button>

               <div className="flex flex-col items-center gap-1">
                 <button
                   className="pointer-events-auto w-10 h-10 rounded-full border border-white/20 flex items-center justify-center bg-black/20 active:bg-white active:text-black transition-colors"
                   onClick={() => {
                     setWalking(false);
                     walkingRef.current = false;
                     if (orbitRef.current) orbitRef.current.enabled = true;
                     if (fpRef.current && fpRef.current.isLocked) {
                       try { fpRef.current.unlock(); } catch {}
                     }
                   }}
                 >
                   <span className="text-xs font-bold">{isMobileRef.current ? "X" : "ESC"}</span>
                 </button>
                 <span className="text-[9px] text-white/40 uppercase tracking-widest">Exit</span>
               </div>
             </div>
             {carryLayer && (
               <div className="px-4 py-1.5 bg-white/10 backdrop-blur-md rounded-full border border-white/10 flex items-center gap-3">
                 <Box className="w-3.5 h-3.5 text-blue-400" />
                 <span className="text-[10px] text-white/80 uppercase tracking-[0.2em]">{carryLayer}</span>
               </div>
             )}
          </div>
        </>
      )}
    </div>
  );
}
