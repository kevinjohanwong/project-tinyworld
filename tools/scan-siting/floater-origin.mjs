// Diagnose WHERE floaters come from: are disconnected dirt/grass clumps
// clustered near walls (scan artifacts) and sitting at elevated heights
// (not on the true floor)? Tests KJ's hypothesis directly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const GLB = process.argv[2] || HERE + "fixtures/debug-scan-small.glb";
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "ignore" });
const { voxelize } = await import("./voxelizer.mjs");

const buf = readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const res = await voxelize(ab, null);

const K = (x, y, z) => `${x},${y},${z}`;
// Full solid = every emitted voxel (visible + hidden), matching what the sweep floods.
const solid = new Map();          // key -> layer
const wallCells = new Set();      // wall voxel keys
const layersOf = res.layers;
const VIS = ["dirt", "grass", "dryGrass", "snow", "wet", "trunks", "leaves", "water", "wall", "ceiling"];
for (const n of VIS) {
  const b = layersOf[n]; if (!b) continue;
  const a = new Int32Array(b);
  for (let i = 0; i < a.length; i += 3) { const k = K(a[i], a[i+1], a[i+2]); solid.set(k, n); if (n === "wall") wallCells.add(k); }
}
// hidden buckets (only dirt exists today)
if (res.hidden) for (const [n, b] of Object.entries(res.hidden)) {
  const a = new Int32Array(b);
  for (let i = 0; i < a.length; i += 3) solid.set(K(a[i], a[i+1], a[i+2]), n + "*");
}

// 6-connected flood over full solid
const FACE = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const seen = new Set();
const comps = [];
for (const start of solid.keys()) {
  if (seen.has(start)) continue;
  const cells = []; const stack = [start]; seen.add(start);
  while (stack.length) {
    const k = stack.pop(); cells.push(k);
    const [x, y, z] = k.split(",").map(Number);
    for (const [dx, dy, dz] of FACE) { const nk = K(x+dx, y+dy, z+dz); if (solid.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); } }
  }
  comps.push(cells);
}
comps.sort((a, b) => b.length - a.length);
const main = new Set(comps[0]);
const floaters = comps.slice(1);

// column floor from res.meta? build true floor = lowest solid y per (x,z)
const colLow = new Map();
for (const k of solid.keys()) { const [x, y, z] = k.split(",").map(Number); const kk = x+","+z; const p = colLow.get(kk); if (p === undefined || y < p) colLow.set(kk, y); }

// For each floater component: layer mix, size, min-Y, and min horizontal dist to a wall voxel
function nearestWallDist(cells) {
  let best = Infinity;
  for (const k of cells) {
    const [x, y, z] = k.split(",").map(Number);
    // cheap: check a small neighbourhood in the wall set (radius up to 4)
    for (let r = 0; r <= 4 && r < best; r++) {
      let hit = false;
      for (let dx = -r; dx <= r && !hit; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = -3; dy <= 3; dy++) if (wallCells.has(K(x+dx, y+dy, z+dz))) { hit = true; break; }
        if (hit) break;
      }
      if (hit) { best = Math.min(best, r); break; }
    }
  }
  return best;
}

let total = 0, nearWall = 0, overFloorGap = 0;
const layerCount = {};
const distHist = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, ">4": 0 };
const sample = [];
for (const c of floaters) {
  if (main.has(c[0])) continue;
  total += c.length;
  const d = nearestWallDist(c);
  const bucket = d > 4 ? ">4" : String(d);
  distHist[bucket] += 1;
  if (d <= 2) nearWall += 1;
  for (const k of c) { const lay = solid.get(k); layerCount[lay] = (layerCount[lay] || 0) + 1; }
  // does the clump sit above an empty column (no real floor under it within 3)?
  const [x0, y0, z0] = c[0].split(",").map(Number);
  const low = colLow.get(x0 + "," + z0);
  const minY = Math.min(...c.map(k => +k.split(",")[1]));
  const gap = minY - (low ?? minY);
  if (c.length <= 8) sample.push({ n: c.length, at: c[0], wallDist: d === Infinity ? ">4" : d, minY, layers: [...new Set(c.map(k => solid.get(k)))].join("+") });
}

console.log(`\nfloater components: ${floaters.length}  (voxels: ${total})   main mass: ${comps[0].length}`);
console.log(`layer mix of floaters:`, layerCount);
console.log(`\ncomponent count by nearest-wall distance (voxels, x/z radius, ±3 y):`);
for (const [k, v] of Object.entries(distHist)) console.log(`  dist ${k.padStart(2)} : ${v}`);
console.log(`\n${nearWall}/${floaters.length} components sit within 2 voxels of a wall.`);
console.log(`\nsample of small floaters (n≤8):`);
for (const s of sample.slice(0, 30)) console.log(`  n=${s.n} at=${s.at} wallDist=${s.wallDist} minY=${s.minY} [${s.layers}]`);
