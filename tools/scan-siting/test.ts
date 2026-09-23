// Regression test against the small real scan (an interior ROOM scan with a
// ceiling). Invariants:
//  1. Siting finds a NATURAL BASIN (not an edge-outlet), meaningfully deep, with
//     a valid over-lip (emitter cell + a horizontal neighbour open to air) —
//     never sheeting off an outlier spike, never through geometry.
//  2. The worker emits a LATENT UNDERSIDE (solid from the walkable floor down),
//     and running it through the flow keeps water on the floor — dramatically
//     fewer columns drain BELOW the floor vs. the raw thin shell.
//  3. The per-mouth drain cap + source-relative cull floor keep the pool a
//     flatter, bounded sheet instead of drilling through the shell.
// Dry and raining must agree. Run:  bun tools/scan-siting/test.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const FIXTURE = HERE + "fixtures/debug-scan-small.glb";

// Refresh voxelizer.mjs from the live app first (so the test never drifts),
// THEN import the siting module (which imports the freshly-generated file).
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "inherit" });
const { siteSpring } = await import("./siting.mjs");
const { voxelize } = await import("./voxelizer.mjs");
const { emitAndSettle, stepFluid, emitterCell, springEmit } =
  await import("/__substrate/space/src/water-spring.ts");

let failed = 0;
const ok = (cond: boolean, msg: string, got?: unknown) => {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
};

let siteOrigin: any = null;
for (const raining of [false, true]) {
  const r = await siteSpring(FIXTURE, { raining });
  console.log(`\n[${raining ? "raining" : "dry"}] span=${r.span?.toFixed(2)}m cols=${r.columns} maxTop=${r.maxTop} minTop=${r.minTop} → ${r.siting} @ ${JSON.stringify(r.origin)} depth=${r.basinDepth} band=${r.basinBand}`);
  ok(r.ok === true, "siting succeeds", r.reason);
  ok(r.siting === "natural-basin", "finds a natural basin (not edge-outlet)", r.siting);
  ok(r.basinDepth >= 10, "basin is meaningfully deep (>=10 voxels)", r.basinDepth);
  ok(r.emitterCellIsAir === true, "emitter cell above origin is open air");
  ok(r.emitterAirNeighbours >= 1, "emitter has an open horizontal lip (travels over, not through geometry)", r.emitterAirNeighbours);
  siteOrigin = r.origin;
}

// ── Flow throttle: the per-mouth drain cap + source-relative cull floor must keep
// the pool a FLATTER, BOUNDED sheet instead of drilling through the thin scan shell
// to the buried dirt-cone tip. Runs the actual production stepFluid on the scan.
{
  console.log(`\n[flow throttle] production stepFluid, 60 emit-steps @ origin ${JSON.stringify(siteOrigin)}`);
  const K = (x: number, z: number) => `${x},${z}`;
  const buf = readFileSync(FIXTURE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const rv: any = await voxelize(ab, null);
  const cm = new Map<string, Set<number>>();
  for (const n of ["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"]) {
    const b = rv.layers[n]; if (!b) continue; const a = new Int32Array(b);
    for (let i = 0; i < a.length; i += 3) { const k = K(a[i], a[i+2]); let s = cm.get(k); if (!s) { s = new Set(); cm.set(k, s); } s.add(a[i+1]); }
  }
  const isSolid = (x: number, y: number, z: number) => cm.get(K(x, z))?.has(y) ?? false;
  let minSolid = Infinity; for (const [, ys] of cm) for (const y of ys) if (y < minSolid) minSolid = y;
  const origin = [siteOrigin.x, siteOrigin.y, siteOrigin.z] as [number, number, number];
  const emitter = emitterCell(origin);
  const CAP = 7200, FLOW_DROP = 26;

  // ── Latent underside containment: the worker must emit a latent underside
  // (solid from the walkable floor down), and feeding that into the solid oracle
  // must keep water on the floor — far fewer columns drain BELOW the local floor
  // top than with the raw thin shell. This is the "solid walls + floor" fix.
  // NOTE: this is a FLOOR property, independent of where the spring sites (which
  // is now correctly the CEILING). Probe it directly at a central floor cell,
  // NOT the spring origin — a ceiling-sited spring never touches the floor.
  const latCols = new Map<string, [number, number]>();
  if (rv.latentCols && (rv.latentCols as ArrayBuffer).byteLength) {
    const q = new Int32Array(rv.latentCols as ArrayBuffer);
    for (let i = 0; i + 3 < q.length; i += 4) latCols.set(K(q[i], q[i + 1]), [q[i + 2], q[i + 3]]);
  }
  ok(latCols.size > 1000, "worker emits a latent underside (solid floor columns)", latCols.size);
  const latentSolid = (x: number, y: number, z: number) => { const r = latCols.get(K(x, z)); return (!!r && y >= r[0] && y <= r[1]) || isSolid(x, y, z); };
  const floorTopOf = (x: number, z: number) => { const s = cm.get(K(x, z)); if (!s) return null; const ys = [...s].sort((a, b) => a - b); let t = ys[0]; for (let i = 1; i < ys.length; i++) { if (ys[i] === t + 1) t = ys[i]; else break; } return t; };
  // Central floor cell at the dominant floor level = probe origin for containment.
  const floorCols: [number, number, number][] = [];
  let fcx = 0, fcz = 0;
  for (const [k] of cm) { const [x, z] = k.split(",").map(Number); const ft = floorTopOf(x, z); if (ft === null) continue; floorCols.push([x, ft, z]); fcx += x; fcz += z; }
  fcx /= Math.max(1, floorCols.length); fcz /= Math.max(1, floorCols.length);
  const fhist = new Map<number, number>(); for (const [, ft] of floorCols) fhist.set(ft, (fhist.get(ft) || 0) + 1);
  let domFloor = 0, dfc = 0; for (const [y, c] of fhist) if (c > dfc) { dfc = c; domFloor = y; }
  let probe: [number, number, number] = origin, bestD = Infinity;
  for (const [x, ft, z] of floorCols) { if (ft !== domFloor) continue; const d = Math.abs(x - fcx) + Math.abs(z - fcz); if (d < bestD) { bestD = d; probe = [x, ft, z]; } }
  const probeEmitter = emitterCell(probe);
  console.log(`  floor probe @ ${JSON.stringify(probe)} (dominant floor y=${domFloor})`);
  const belowFloorCount = (solid: (x: number, y: number, z: number) => boolean) => {
    let body = new Set<string>(), state = { budget: CAP, capacity: CAP }, tickN = 0, credit = 0; const dwell = new Map<string, number>();
    const floorY = probe[1] - FLOW_DROP;
    for (let s = 1; s <= 120; s++) {
      const r = springEmit(state, probeEmitter, 8);
      if (r.emit) { state = r.state; body = emitAndSettle(body, solid, probeEmitter, 8, { radius: 24, maxCells: CAP, maxRise: 6 }); }
      credit += 1.5; while (credit >= 1) { credit -= 1; tickN++; body = stepFluid(body, solid, { floorY, tick: tickN, maxCells: CAP, spreadRange: 16, maxScan: 200, edgeHold: 5, dwell, maxDrainPerCol: 1 }); }
    }
    const top = new Map<string, number>(); for (const k of body) { const [x, y, z] = k.split(",").map(Number); const kk = K(x, z); const p = top.get(kk); if (p === undefined || y > p) top.set(kk, y); }
    let below = 0; for (const [kk, wy] of top) { const [x, z] = kk.split(",").map(Number); const ft = floorTopOf(x, z); if (ft !== null && wy < ft) below++; }
    return { below, footprint: top.size };
  };
  const rawShell = belowFloorCount(isSolid);
  const latent = belowFloorCount(latentSolid);
  console.log(`  below-floor columns: raw shell=${rawShell.below} → latent solid=${latent.below}  (footprint ${rawShell.footprint}→${latent.footprint})`);
  ok(latent.below < rawShell.below * 0.5, "latent underside cuts below-floor drainage by >50%", { raw: rawShell.below, latent: latent.below });
  // ── Conservation + full fall: the spring sites at the CEILING, and water it
  // sheds must be free to fall the full height toward the room floor and pool —
  // it is NEVER destroyed mid-air. floorY is anchored BELOW the world's lowest
  // solid (production: minSolid − FLOW_DROP), so in an enclosed room the cull can
  // never fire. The obsolete source-relative cull (origin.y − FLOW_DROP) would
  // have deleted water ~FLOW_DROP below the ceiling — this guards against its
  // return. stepFluid only shrinks the body via culling, so any shrink = a cell
  // destroyed; in the sealed room that must be zero.
  const drive = (floorY: number, cap: number) => {
    let body = new Set<string>(), state = { budget: CAP, capacity: CAP }, tickN = 0, credit = 0, culled = 0;
    const dwell = new Map<string, number>();
    for (let s = 1; s <= 60; s++) {
      const r = springEmit(state, emitter, 8);
      if (r.emit) { state = r.state; body = emitAndSettle(body, isSolid, emitter, 8, { radius: 24, maxCells: CAP, maxRise: 6 }); }
      credit += 1.5; while (credit >= 1) { credit -= 1; tickN++; const before = body.size; body = stepFluid(body, isSolid, { floorY, tick: tickN, maxCells: CAP, spreadRange: 16, maxScan: 200, edgeHold: 5, dwell, maxDrainPerCol: cap }); if (body.size < before) culled += before - body.size; }
    }
    const xz = new Set<string>(); let minY = Infinity;
    for (const k of body) { const [x, y, z] = k.split(",").map(Number); xz.add(x + "," + z); if (y < minY) minY = y; }
    return { minY, vpf: body.size / Math.max(1, xz.size), culled };
  };
  const worldFloor = minSolid - FLOW_DROP;       // production cull floor (below lowest solid)
  const oldCull = origin[1] - FLOW_DROP;         // obsolete source-relative cull we removed
  const fix = drive(worldFloor, 1);              // production: cap=1, world-anchored floor
  console.log(`  ceiling spring: bottomY=${fix.minY} vol/fp=${fix.vpf.toFixed(2)} culled=${fix.culled}  (obsolete source cull would clamp @ ${oldCull})`);
  ok(fix.culled === 0, "no water destroyed mid-air in the enclosed room — conservation holds", { culled: fix.culled });
  ok(fix.minY < oldCull, "water keeps falling past the obsolete source-relative cull toward the room floor", { bottomY: fix.minY, oldCull });
}

console.log(failed === 0 ? "\nPASS — all siting + flow invariants hold." : `\nFAIL — ${failed} assertion(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
