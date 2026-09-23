// Diagnostics for any GLB: prints the top-surface height map, a BASIN_BAND
// sweep, and the siting decision. Use to understand a scan or debug siting.
//   bun tools/scan-siting/inspect.mjs [path-to.glb]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const GLB = process.argv[2] || HERE + "fixtures/debug-scan-small.glb";
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "inherit" });
const { voxelize } = await import("./voxelizer.mjs");
const { siteSpring } = await import("./siting.mjs");

const buf = readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const res = await voxelize(ab, null);
const VIS = ["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"];
const K = (x,z) => `${x},${z}`;
const cm = new Map();
for (const n of VIS) { const b = res.layers[n]; if (!b) continue; const a = new Int32Array(b);
  for (let i = 0; i < a.length; i += 3) { const k = K(a[i], a[i+2]); let s = cm.get(k); if (!s) { s = new Set(); cm.set(k,s); } s.add(a[i+1]); } }
const HDIRS = [[1,0],[-1,0],[0,1],[0,-1]];
const top = new Map(); let maxTop = -Infinity;
for (const [k,ys] of cm) { let t = -Infinity; for (const y of ys) if (y > t) t = y; top.set(k,t); if (t > maxTop) maxTop = t; }

function deepest(band) {
  const H = new Map(); for (const [k,y] of top) if (y >= maxTop - band) H.set(k,y);
  if (H.size < 12) return { footprint: H.size, depth: 0 };
  const spill = new Map(), seen = new Set(), heap = [];
  const pop = () => { let b = 0; for (let i = 1; i < heap.length; i++) if (heap[i].L < heap[b].L) b = i; return heap.splice(b,1)[0]; };
  for (const [k,y] of H) { const [x,z] = k.split(",").map(Number); if (HDIRS.some(([dx,dz]) => !H.has(K(x+dx,z+dz)))) { heap.push({k,x,z,L:y}); seen.add(k); } }
  while (heap.length) { const n = pop(); if (spill.has(n.k)) continue; spill.set(n.k,n.L);
    for (const [dx,dz] of HDIRS) { const nx = n.x+dx, nz = n.z+dz, kk = K(nx,nz); if (!H.has(kk) || seen.has(kk)) continue; seen.add(kk); heap.push({k:kk,x:nx,z:nz,L:Math.max(n.L,H.get(kk))}); } }
  let bd = 0, at = null; for (const [k,y] of H) { const d = (spill.get(k) ?? y) - y; if (d > bd) { bd = d; at = k; } }
  return { footprint: H.size, depth: bd, at };
}

console.log(`\n${GLB.split("/").pop()}  span=${res.span.toFixed(2)}m  cols=${cm.size}  maxTop=${maxTop}`);
console.log("\nBASIN_BAND sweep (band → footprint, deepest enclosed depth):");
for (const band of [3,8,12,20,30,50,80,120]) { const r = deepest(band); console.log(`  band ${String(band).padStart(3)}  footprint ${String(r.footprint).padStart(5)}  maxDepth ${r.depth}${r.at ? "  @ "+r.at : ""}`); }

let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;
for (const k of top.keys()) { const [x,z] = k.split(",").map(Number); x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z); }
const W = Math.min(70, x1-x0+1), Hh = Math.min(34, z1-z0+1);
const glyph = " .:-=+*#%@";
console.log(`\nTop-surface height map (${x1-x0+1}x${z1-z0+1}, brighter=higher, '·'=no column):`);
for (let r = 0; r < Hh; r++) { let line = "";
  for (let c = 0; c < W; c++) { const x = x0+Math.round(c*(x1-x0)/(W-1)), z = z0+Math.round(r*(z1-z0)/(Hh-1)); const t = top.get(K(x,z));
    if (t === undefined) { line += "·"; continue; } const d = maxTop - t; line += glyph[glyph.length-1-Math.min(glyph.length-1, Math.floor(d/6))]; }
  console.log(line); }

const s = await siteSpring(GLB, {});
console.log(`\nSiting: ${s.siting} @ ${JSON.stringify(s.origin)}  depth=${s.basinDepth}  band=${s.basinBand}  onFloor=${s.onDominantFloor}  emitterAir=${s.emitterCellIsAir}/${s.emitterAirNeighbours} nbrs`);
