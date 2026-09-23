// Simulate KJ's proposal: apply gravity to every disconnected floater voxel.
// Each falls straight down until the cell below is solid (LANDS) or it passes
// below the world floor (VOID -> deleted). Reports land-vs-void split and where
// landed blocks end up, so we know if "fall into void -> disappear" actually
// holds in an enclosed room with a solid floor.
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
const solid = new Map();
const VIS = ["dirt", "grass", "dryGrass", "snow", "wet", "trunks", "leaves", "water", "wall", "ceiling"];
for (const n of VIS) { const b = res.layers[n]; if (!b) continue; const a = new Int32Array(b);
  for (let i = 0; i < a.length; i += 3) solid.set(K(a[i], a[i+1], a[i+2]), n); }
if (res.hidden) for (const [n, b] of Object.entries(res.hidden)) { const a = new Int32Array(b);
  for (let i = 0; i < a.length; i += 3) solid.set(K(a[i], a[i+1], a[i+2]), n + "*"); }

const FACE = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const seen = new Set(); const comps = [];
for (const s of solid.keys()) { if (seen.has(s)) continue; const cells = []; const st = [s]; seen.add(s);
  while (st.length) { const k = st.pop(); cells.push(k); const [x,y,z] = k.split(",").map(Number);
    for (const [dx,dy,dz] of FACE) { const nk = K(x+dx,y+dy,z+dz); if (solid.has(nk) && !seen.has(nk)) { seen.add(nk); st.push(nk); } } }
  comps.push(cells); }
comps.sort((a, b) => b.length - a.length);
const main = new Set(comps[0]);

// world floor = lowest solid Y anywhere
let worldFloorY = Infinity;
for (const k of solid.keys()) worldFloorY = Math.min(worldFloorY, +k.split(",")[1]);

// Occupancy that a falling block can rest on: main mass + already-landed floaters.
const rest = new Set(main);
// Collect all floater voxels (everything not in main), sort bottom-up so lower ones settle first.
const CAP = 1024; // protect big detached structures (real architecture), like the live sweep
const floaterVox = [];
for (const c of comps.slice(1)) { if (c.length > CAP) { for (const k of c) rest.add(k); continue; } for (const k of c) floaterVox.push(k); }
floaterVox.sort((a, b) => (+a.split(",")[1]) - (+b.split(",")[1]));

let landed = 0, voided = 0, fellDistTotal = 0; const landLayer = {}, voidLayer = {};
const landYs = [];
for (const k of floaterVox) {
  const [x, y0, z] = k.split(",").map(Number);
  const lay = solid.get(k);
  let y = y0;
  while (y - 1 >= worldFloorY && !rest.has(K(x, y - 1, z))) y -= 1;
  if (y - 1 < worldFloorY && !rest.has(K(x, y - 1, z))) {
    // nothing under it all the way down -> falls out of world
    voided += 1; voidLayer[lay] = (voidLayer[lay] || 0) + 1;
  } else {
    rest.add(K(x, y, z)); landed += 1; landYs.push(y); fellDistTotal += (y0 - y);
    landLayer[lay] = (landLayer[lay] || 0) + 1;
  }
}

const tot = landed + voided;
console.log(`\nworld floor Y = ${worldFloorY}   floater voxels (≤${CAP}) = ${tot}`);
console.log(`\nGRAVITY SETTLE OUTCOME:`);
console.log(`  LANDED on solid : ${landed}  (${(100*landed/tot).toFixed(0)}%)  avg fall ${(fellDistTotal/Math.max(1,landed)).toFixed(1)} vox`);
console.log(`  fell to VOID    : ${voided}  (${(100*voided/tot).toFixed(0)}%)  -> deleted`);
console.log(`\n  landed layer mix:`, landLayer);
console.log(`  voided layer mix:`, voidLayer);
if (landYs.length) { landYs.sort((a,b)=>a-b); console.log(`\n  landed rest at Y: min ${landYs[0]}  median ${landYs[landYs.length>>1]}  max ${landYs[landYs.length-1]}  (world floor ${worldFloorY})`); }
