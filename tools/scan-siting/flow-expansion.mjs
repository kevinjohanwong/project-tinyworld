// Empirically check the water expansion ORDER using the REAL physics from
// water-spring.ts: does the pool spread horizontally (fill its footprint) before
// building up vertically, and is the spread ring-symmetric (no directional
// finger)? Replicates the runtime growStep(emitAndSettle) + flowStep(stepFluid)
// interleave. Run: bun tools/scan-siting/flow-expansion.mjs
import { emitAndSettle, stepFluid, emitterCell, springEmit } from "/__substrate/space/src/water-spring.ts";

const KEY = (x,y,z) => `${x},${y},${z}`;
// Runtime constants (water-spring-runtime.ts).
const PER_TICK = 8, CAPACITY = 7200, FILL_RADIUS = 24, MAX_RISE = 6;
const SPREAD_RANGE = 16, MAX_SCAN = 200, EDGE_HOLD = 5, FLOW_DROP = 26;

function metrics(body, floorTopY) {
  const xz = new Set(); let maxH = 0, minY = Infinity, maxY = -Infinity;
  const perLayer = new Map();
  for (const k of body) { const [x,y,z] = k.split(",").map(Number);
    xz.add(x+","+z); if (y<minY)minY=y; if (y>maxY)maxY=y;
    perLayer.set(y, (perLayer.get(y)||0)+1); }
  maxH = body.size ? (maxY - (floorTopY+1) + 1) : 0;   // layers above the floor
  // radial symmetry: stddev of cell distance from source / mean (0 = perfect ring)
  return { size: body.size, footprint: xz.size, layers: maxH, minY, maxY, perLayer };
}

// Run the real grow+flow loop and log footprint vs height as volume grows.
function simulate(name, isSolid, origin, floorTopY, { steps = 40, ratio = 1.5 } = {}) {
  const emitter = emitterCell(origin);           // origin + [0,1,0]
  let body = new Set();
  let state = { budget: CAPACITY, capacity: CAPACITY };
  const floorY = floorTopY - FLOW_DROP;
  const dwell = new Map();
  let tickN = 0, flowCredit = 0;
  console.log(`\n=== ${name} ===  origin ${JSON.stringify(origin)} emitter ${JSON.stringify(emitter)}`);
  console.log(" tick  vol  footprint  layers  fill%(size/footprint)  perLayer");
  for (let s = 1; s <= steps; s++) {
    // growStep: fund PER_TICK then emitAndSettle (self-level).
    const r = springEmit(state, emitter, PER_TICK);
    if (r.emit) { state = r.state;
      body = emitAndSettle(body, isSolid, emitter, PER_TICK, { radius: FILL_RADIUS, maxCells: CAPACITY, maxRise: MAX_RISE }); }
    // flowStep(s): stepFluid at ~ratio the grow cadence.
    flowCredit += ratio;
    while (flowCredit >= 1) { flowCredit -= 1; tickN++;
      body = stepFluid(body, isSolid, { floorY, tick: tickN, maxCells: CAPACITY, spreadRange: SPREAD_RANGE, maxScan: MAX_SCAN, edgeHold: EDGE_HOLD, dwell }); }
    if (s % 4 === 0 || s <= 4) {
      const m = metrics(body, floorTopY);
      const fillPct = m.footprint ? (m.size / m.footprint) : 0;
      const layerStr = [...m.perLayer.entries()].sort((a,b)=>a[0]-b[0]).map(([y,c])=>`y${y}:${c}`).join(" ");
      console.log(`  ${String(s).padStart(3)}  ${String(m.size).padStart(4)}   ${String(m.footprint).padStart(6)}    ${String(m.layers).padStart(3)}      ${fillPct.toFixed(2).padStart(5)}          ${layerStr}`);
    }
  }
}

// (a) Flat open ground: solid floor at y=0 within a bounded pad; void beyond so
//     overflow spills off the edge. Source at pad centre.
const PAD = 20;
const flatSolid = (x,y,z) => y <= 0 && Math.abs(x) <= PAD && Math.abs(z) <= PAD;
simulate("FLAT open ground (pad ±20)", flatSolid, [0,0,0], 0);

// (b) Walled basin: floor at y=0, a solid ring wall at radius R rising to y=5,
//     open interior. Water must fill the disk bottom-up before topping the rim.
const R = 8, RIM = 5;
const basinSolid = (x,y,z) => {
  if (y <= 0) return Math.hypot(x,z) <= R + 1;        // floor disk
  const ring = Math.hypot(x,z);
  if (ring > R && ring <= R + 1 && y >= 1 && y <= RIM) return true;  // rim wall
  return false;
};
simulate("WALLED basin (r=8, rim y=5)", basinSolid, [0,0,0], 0, { steps: 80 });
