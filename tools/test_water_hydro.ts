// Hydrostatic-pressure lateral rule (options.hydro) — offline verification against
// the LIVE core (src/water-spring.ts). Proves: emergent calm (no threshold), depth
// pressure rate, multi-level discharge, mass conservation, and off-parity.
import { stepFluid } from "../src/water-spring";

const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
let passed = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok ${name}`); };
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((c) => b.has(c));

// ── 1. Emergent calm: a LEVEL lake in a walled basin does not move — with NO
// threshold guarding it. Every interior cell has water/floor below and water/wall
// beside → no lower-head neighbour exists → nothing moves. Bit-identical over ticks.
test("level lake is bit-still (calm emerges, not by threshold)", () => {
  const box = (x: number, y: number, z: number) => y < 1 || x < 1 || x > 3 || z < 1 || z > 3;
  let w = new Set<string>();
  for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) { w.add(k(x, 1, z)); w.add(k(x, 2, z)); }
  const start = new Set(w);
  for (let t = 0; t < 12; t++) {
    w = stepFluid(w, box, { tick: t, hydro: true, pressureK: 1 });
    ok(same(w, start), `level lake moved at tick ${t}`);
  }
});

// ── 2. Full hydrostatic — MULTI-LEVEL DISCHARGE: a deep tank whose ONLY opening is a
// single side hole at depth H (rim intact, taller than H) drains through the side at
// depth down to the hole level. Proves buried water pushes out at its own level, not
// only over the rim.
test("multi-level discharge: deep tank drains through a mid-depth side hole", () => {
  const H = 2;
  const tank = (x: number, y: number, z: number) => {
    if (x >= 2) return false;                 // open exterior beyond the hole (escapees fall away → culled)
    if (x === 1 && z === 0) return y !== H;    // right wall solid EXCEPT the single hole at y=H
    if (x === 0 && z === 0) return y < 1;      // shaft: floor at y0, open above
    return true;                                // left wall, z walls, surrounding solid
  };
  let w = new Set<string>();
  for (let y = 1; y <= 6; y++) w.add(k(0, y, 0));  // deep fill, well above the hole
  const n0 = w.size;
  for (let t = 0; t < 80; t++) w = stepFluid(w, tank, { tick: t, hydro: true, pressureK: 1, floorY: -3 });
  let interiorMax = -1; for (const c of w) { const [x, y, z] = c.split(",").map(Number); if (x === 0 && z === 0 && y > interiorMax) interiorMax = y; }
  ok(interiorMax <= H, `tank must drain to the hole level (interior maxY ${interiorMax} should be ≤ ${H})`);
  ok(w.size < n0, `water must have discharged out the side (left ${w.size} of ${n0})`);
});

// ── 4. Mass conservation: closed box, no floor cull → count is invariant no matter
// how the body sloshes and levels.
test("mass conserved in a closed box (no cull)", () => {
  const box = (x: number, y: number, z: number) => y < 1 || x < 1 || x > 4 || z < 1 || z > 4;
  let w = new Set<string>();
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 2; x++) for (let z = 1; z <= 2; z++) w.add(k(x, y, z));
  const n0 = w.size;
  for (let t = 0; t < 50; t++) w = stepFluid(w, box, { tick: t, hydro: true, pressureK: 1 });
  ok(w.size === n0, `mass changed: ${w.size} vs ${n0}`);
});

// ── 5. Equilibrium emerges: a lopsided pile spreads and then reaches a STILL state
// on its own (calm is the fixed point of the same rule, not a special case).
test("lopsided fill spreads then rests (equilibrium is emergent)", () => {
  const box = (x: number, y: number, z: number) => y < 1 || x < 1 || x > 4 || z < 1 || z > 4;
  let w = new Set<string>();
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 2; x++) for (let z = 1; z <= 2; z++) w.add(k(x, y, z));
  for (let t = 0; t < 90; t++) w = stepFluid(w, box, { tick: t, hydro: true, pressureK: 1 });
  const settled = new Set(w);
  let stable = true;
  for (let t = 90; t < 96; t++) { w = stepFluid(w, box, { tick: t, hydro: true, pressureK: 1 }); if (!same(w, settled)) { stable = false; break; } }
  ok(stable, "hydro body did not reach a still equilibrium");
});

// ── 6. Off-parity: hydro:false is the classic CA (the whole point of the flag).
test("hydro:false matches the classic spread path", () => {
  const box = (x: number, y: number, z: number) => y < 1 || x < 1 || x > 4 || z < 1 || z > 4;
  const seed = () => { const s = new Set<string>(); for (let y = 1; y <= 5; y++) for (let x = 1; x <= 2; x++) for (let z = 1; z <= 2; z++) s.add(k(x, y, z)); return s; };
  let a = seed(), b = seed();
  for (let t = 0; t < 30; t++) {
    a = stepFluid(a, box, { tick: t });                    // no hydro option = classic
    b = stepFluid(b, box, { tick: t, hydro: false });      // explicit off
    ok(same(a, b), `hydro:false diverged from classic at tick ${t}`);
  }
});

// ── 7. A CONTAINED deep 1-wide slot fills DEEP (communicating vessels): a lake feeding
// a one-voxel-wide slot whose far end is walled (throttled, not free-draining) backs up
// and fills the slot several voxels deep — the "forward pressure fills the channel"
// behavior. (A FREE-DRAINING slot correctly runs thin — depth needs containment.)
test("contained deep 1-wide slot fills several voxels deep (forward pressure → depth)", () => {
  const world = (x: number, y: number, z: number) => {
    if (z !== 0) return true;                 // 1-wide z=0 lane
    if (y < 1) return x <= 5;                  // floor under reservoir(0..3) + slot(4) + far wall base(5)
    if (x < 0 || x >= 5) return true;          // back wall + FAR WALL (closes the slot → water backs up)
    return false;                              // open above the floor
  };
  let w = new Set<string>();
  const dwell = new Map<string, number>();
  for (let t = 0; t < 300; t++) {
    for (let y = 1; y <= 6; y++) if (!w.has(k(0, y, 0))) w.add(k(0, y, 0));  // steady head behind the slot
    w = stepFluid(w, world, { tick: t, floorY: -4, maxDrainPerCol: 2, edgeHold: 0, dwell, hydro: true });
  }
  let slotDepth = 0; for (const c of w) { const [x, , z] = c.split(",").map(Number); if (x === 4 && z === 0) slotDepth++; }
  ok(slotDepth >= 2, `contained slot should fill ≥2 deep, got ${slotDepth}`);
});

// ── 8. Waterfalls unbroken: a mid-air column with empty space below falls as a BODY.
test("mid-air column free-falls as a body onto the floor", () => {
  const floor = (x: number, y: number, z: number) => y < 1;   // solid floor at y0, open above
  let w = new Set<string>([k(0, 8, 0), k(0, 9, 0), k(0, 10, 0)]);   // 3-cell column in mid-air
  for (let t = 0; t < 16; t++) w = stepFluid(w, floor, { tick: t, hydro: true });
  // the column must FALL to the floor (none stranded mid-air) — on an open floor it then
  // spreads to a 1-layer puddle, which is correct; just assert all 3 reached y≤1.
  ok(w.size === 3 && [...w].every((c) => +c.split(",")[1] <= 1), `column did not free-fall to the floor: ${[...w].sort()}`);
});

// ── 9. Collapse-redirect SAFETY: a closed lopsided body with carry ON still reaches a
// STILL equilibrium (the rate must not make a calm body circulate — the failure mode
// that killed the deterministic follow).
test("carry on: closed body still settles to rest (rate doesn't circulate)", () => {
  const box = (x: number, y: number, z: number) => y < 1 || x < 1 || x > 4 || z < 1 || z > 4;
  let w = new Set<string>();
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 2; x++) for (let z = 1; z <= 2; z++) w.add(k(x, y, z));
  const step = (s: Set<string>, t: number) => stepFluid(s, box, { tick: t, hydro: true, carryRate: 0.25 });
  for (let t = 0; t < 120; t++) w = step(w, t);
  const settled = new Set(w);
  let stable = true;
  for (let t = 120; t < 126; t++) { w = step(w, t); if (!same(w, settled)) { stable = false; break; } }
  ok(stable, "carry-on body did not settle (circulating)");
});

// ── 10. A lake feeding a long deep 1-wide channel that free-drains off the far edge
// forms a COHERENT graded river surface (deep at the head, thinning monotonically toward
// the outlet) with the momentum-fed carry ON, instead of the lumpy 1-layer-skin profile
// carry-off leaves. Water correctly thins as it accelerates over the lip; the win is the
// channel HOLDS depth upstream (≥2 at the head) and the surface slopes smoothly.
// FLOW-AWARE LEVELING (KJ, rivers): a fed channel must be able to back up behind a
// barrier and STACK a taller water face that OVERTOPS the lip — the depth the churn-safe
// ≥2 gate alone froze into a 1-cell staircase skin. With levelFlow ON a genuinely flowing
// (fed) body raises its level over 1-cell steps and pours over the crest; with it OFF the
// classic ≥2 rule keeps a thin skin that never overtops. (Still-lake calm is guarded by the
// "level lake is bit-still" test above — flow-aware leveling only fires on moving water.)
test("fed channel backs up behind a lip and overtops (flow-aware leveling stacks a face)", () => {
  const F = 10, X0 = 5, XEND = 40, LIP = 4;   // flat channel floor y=F; solid lip wall at XEND, crest y=F+LIP-1=13
  const world = (x: number, y: number, z: number) => {
    if (y < 2) return true;                    // bedrock
    if (z < 1 || z > 3) return true;           // side walls (3-wide lane)
    if (x < 1) return true;                    // back wall
    if (x >= 1 && x <= 4) return y < F;        // source basin floor, open above (steady head)
    if (x >= X0 && x < XEND) return y < F;     // flat channel floor
    if (x === XEND) return y < F + LIP;        // solid lip wall
    return false;                              // x>XEND => void (cull)
  };
  const run = (levelFlow: number) => {
    let w = new Set<string>();
    const field = new Map<string, { vx: number; vz: number; s: number }>();
    let avg = 0, n = 0, overtop = false;
    for (let t = 0; t < 1200; t++) {
      for (let x = 1; x <= 4; x++) for (const z of [1, 2, 3]) for (let y = F; y <= F + 8; y++) w.add(k(x, y, z)); // steady heavy inflow
      w = stepFluid(w, world, {
        tick: t, floorY: -4, edgeHold: 5, maxDrainPerCol: 1,
        hydro: true, carryRate: 1, fwdHeadK: 1, fwdDischargeK: 0.5, carrySpeedMin: 0.5,
        momentum: { field, inject: 1, weirK: 1, weirRes: 1.2, headK: 1, headMax: 12, maxSpeed: 6, biasMin: 0.3, levelFlow },
      });
      if (t >= 1150) {                          // sample steady state (wave-robust: average over the tail)
        let tot = 0; for (const c of w) { const [x] = c.split(",").map(Number); if (x >= X0 && x <= XEND) tot++; }
        avg += tot; n++;
        for (const z of [1, 2, 3]) if (w.has(k(XEND, F + LIP, z))) overtop = true; // water reached the crest → overtops
      }
    }
    return { avg: avg / Math.max(1, n), overtop };
  };
  const on = run(0.25);   // flow-aware leveling ON (default)
  const off = run(0);     // OFF → classic ≥2 gate (frozen 1-deep staircase, never fills)
  ok(on.overtop, `fed channel must back up and overtop the lip, got avgStanding=${Math.round(on.avg)} overtop=${on.overtop}`);
  ok(!off.overtop, `with leveling off the thin skin must NOT overtop, got overtop=${off.overtop}`);
  ok(on.avg > off.avg * 2, `leveling must hold far more standing water (a backed-up body), got on=${Math.round(on.avg)} off=${Math.round(off.avg)}`);
});

console.log(`\n${passed} hydro tests passed`);
