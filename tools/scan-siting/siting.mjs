// Voxelize a GLB through the app's real worker, build colMap the way addLayer
// does (union of VISIBLE layer voxels), and run the spring siting logic that
// mirrors water-spring-runtime.ts init()/chooseBasin()/chooseOutlet() (v8:
// BASIN_BAND defaults to the full top-surface relief). Returns a result object.
import { readFileSync } from "node:fs";
import { voxelize } from "./voxelizer.mjs";

const VISIBLE = ["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"];
const HDIRS = [[1,0],[-1,0],[0,1],[0,-1]];
const KEYXZ = (x,z) => `${x},${z}`;

export async function siteSpring(glbPath, { raining = false } = {}) {
  const buf = readFileSync(glbPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const res = await voxelize(ab, raining ? { modifiers: { isRaining: true, rain: true } } : null);
  if (!res.ok) throw new Error("voxelizer failed: " + res.error);

  const colMap = new Map();
  const layerCounts = {};
  for (const name of VISIBLE) {
    const b = res.layers[name];
    if (!b) { layerCounts[name] = 0; continue; }
    const a = new Int32Array(b);
    layerCounts[name] = a.length / 3;
    for (let i = 0; i < a.length; i += 3) {
      const k = KEYXZ(a[i], a[i+2]);
      let s = colMap.get(k); if (!s) { s = new Set(); colMap.set(k, s); } s.add(a[i+1]);
    }
  }
  const isSolid = (x,y,z) => colMap.get(KEYXZ(x,z))?.has(y) ?? false;

  const CEIL_BAND = 3;
  let maxTop = -Infinity, minSolid = Infinity, minTop = Infinity;
  const tops = [];
  for (const [k, ys] of colMap) {
    let t = -Infinity;
    for (const y of ys) { if (y > t) t = y; if (y < minSolid) minSolid = y; }
    if (t === -Infinity) continue;
    const [x,z] = k.split(",").map(Number);
    tops.push([x,t,z]);
    if (t > maxTop) maxTop = t;
    if (t < minTop) minTop = t;
  }
  const base = { glb: glbPath, raining, voxel: res.voxel, span: res.span, layerCounts,
    columns: colMap.size, maxTop, minTop, minSolid };
  if (tops.length < 8) return { ...base, ok: false, reason: "no usable surface" };

  const surface = tops.filter(c => c[1] >= maxTop - CEIL_BAND);
  const surfaceKeys = new Set(surface.map(([x,,z]) => KEYXZ(x,z)));
  let cx = 0, cz = 0; for (const [x,,z] of surface) { cx += x; cz += z; }
  cx /= Math.max(1, surface.length); cz /= Math.max(1, surface.length);
  const outletCandidates = surface.filter(([x,y,z]) => HDIRS.some(([dx,dz]) => {
    const nx = x+dx, nz = z+dz;
    return !surfaceKeys.has(KEYXZ(nx,nz)) && !isSolid(nx,y+1,nz) && !isSolid(nx,y,nz);
  }));
  const chooseOutlet = () => {
    const cands = outletCandidates.length ? outletCandidates : surface;
    return cands.reduce((best,c) => {
      if (!best) return c;
      const s  = Math.abs(c[0]-cx)   + Math.abs(c[2]-cz);
      const bs = Math.abs(best[0]-cx)+ Math.abs(best[2]-cz);
      return s < bs || (s === bs && c[1] > best[1]) ? c : best;
    }, null);
  };

  // v8: full-relief band, made ceiling-aware (see water-spring-runtime.ts):
  // a roofed scan caps the band to the roof's undulation so the basin flood
  // can't tunnel through a ceiling gap down to the floor.
  const relief = Number.isFinite(minTop) ? Math.max(0, maxTop - minTop) : 8;
  let nearTop = 0;
  for (const c of tops) if (c[1] >= maxTop - CEIL_BAND) nearTop += 1;
  const hasCeiling = tops.length > 0 && nearTop / tops.length >= 0.15;
  const CEIL_RELIEF = 28;
  const BASIN_BAND = hasCeiling ? Math.min(relief, CEIL_RELIEF) : Math.max(CEIL_BAND, 8, relief);
  const chooseBasin = () => {
    const H = new Map();
    for (const [x,y,z] of tops) if (y >= maxTop - BASIN_BAND) H.set(KEYXZ(x,z), y);
    if (H.size < 12) return null;
    const spill = new Map(), seen = new Set(), heap = [];
    const push = n => heap.push(n);
    const pop = () => { let b = 0; for (let i = 1; i < heap.length; i++) if (heap[i].L < heap[b].L) b = i; return heap.splice(b,1)[0]; };
    for (const [k,y] of H) { const [x,z] = k.split(",").map(Number);
      if (HDIRS.some(([dx,dz]) => !H.has(KEYXZ(x+dx,z+dz)))) { push({k,x,z,L:y}); seen.add(k); } }
    while (heap.length) { const n = pop(); if (spill.has(n.k)) continue; spill.set(n.k, n.L);
      for (const [dx,dz] of HDIRS) { const nx = n.x+dx, nz = n.z+dz, kk = KEYXZ(nx,nz);
        if (!H.has(kk) || seen.has(kk)) continue; seen.add(kk); push({k:kk,x:nx,z:nz,L:Math.max(n.L,H.get(kk))}); } }
    let best = null, bd = 0, bc = Infinity;
    for (const [k,y] of H) { const d = (spill.get(k) ?? y) - y; if (d < 1) continue;
      const [x,z] = k.split(",").map(Number); const c = Math.abs(x-cx) + Math.abs(z-cz);
      if (d > bd || (d === bd && c < bc)) { best = [x,y,z]; bd = d; bc = c; } }
    return best ? { origin: best, depth: bd } : null;
  };

  const basin = chooseBasin();
  const origin = basin?.origin ?? chooseOutlet();
  if (!origin) return { ...base, ok: false, reason: "could not site spring" };
  const [ox,oy,oz] = origin;
  return {
    ...base, ok: true,
    siting: basin ? "natural-basin" : "edge-outlet",
    origin: { x: ox, y: oy, z: oz },
    basinDepth: basin?.depth ?? 0,
    basinBand: BASIN_BAND,
    centroid: { cx: +cx.toFixed(1), cz: +cz.toFixed(1) },
    emitterCellIsAir: !isSolid(ox, oy+1, oz),
    emitterAirNeighbours: HDIRS.filter(([dx,dz]) => !isSolid(ox+dx, oy+1, oz+dz)).length,
    onDominantFloor: oy <= minTop + 3,
  };
}
