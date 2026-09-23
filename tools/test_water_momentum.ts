// Phase 1 momentum offline verification against the LIVE core.
import { stepFluid, type MomentumCell } from "../src/water-spring";

const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
let passed = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok ${name}`); };

// Flat solid floor at y=0 (everything below y=1 is solid) inside a box.
const flatFloor = (x: number, y: number, z: number) => y < 1;

// ── 1. Parity: momentum with inject=0 (speed can never accumulate) must be
// bit-identical to the classic CA — proves the s=0 math reduces to the classic
// constants (quota + floor(0), gate never fires). The runtime's ?momentum=0
// path passes NO momentum option at all, which is trivially identical.
test("zero-speed momentum parity (bit-identical steps)", () => {
  // A messy body: a tower, a sheet, a ledge spiller.
  const solid = (x: number, y: number, z: number) => y < 1 || (y < 5 && x < 3);
  let a = new Set<string>(), b = new Set<string>();
  for (const s of [a, b]) {
    for (let i = 0; i < 4; i++) s.add(k(1, 5 + i, 1));
    s.add(k(5, 3, 5)); s.add(k(5, 4, 5)); s.add(k(6, 1, 5));
  }
  const dwellA = new Map<string, number>(), dwellB = new Map<string, number>();
  const field = new Map<string, MomentumCell>();
  for (let t = 0; t < 30; t++) {
    a = stepFluid(a, solid, { tick: t, maxDrainPerCol: 1, edgeHold: 3, dwell: dwellA });
    b = stepFluid(b, solid, { tick: t, maxDrainPerCol: 1, edgeHold: 3, dwell: dwellB, momentum: { field, inject: 0, headK: 0, stats: { drops: 0, overtops: 0 } } });
    ok(a.size === b.size && [...a].every((c) => b.has(c)), `diverged at tick ${t}`);
  }
});

// ── 2. Injection: a falling cell compounds speed per cell of descent ────────
test("descent injects + compounds, clamped at maxSpeed", () => {
  let w = new Set<string>([k(0, 10, 0)]);
  const field = new Map<string, MomentumCell>();
  for (let t = 0; t < 9; t++) w = stepFluid(w, flatFloor, { tick: t, momentum: { field, inject: 1, maxSpeed: 6 } });
  ok(w.has(k(0, 1, 0)), "cell should land on the floor");
  const m = field.get(k(0, 1, 0));
  ok(!!m, "landed cell should carry momentum");
  ok(m!.s === 6, `9 drops at inject 1 should clamp to 6, got ${m!.s}`);
});

// ── 3. Hydraulic jump: deep-pool cell sheds speed in ~2 ticks ────────────────
test("deep pool decays fast (hydraulic jump), flat rest decays slow", () => {
  // Deep: a walled 1×1 pit holding a stable 3-deep column — nothing can move,
  // the buried bottom cell has ≥2 water above it every tick.
  const pit = (x: number, y: number, z: number) => y < 1 || (y < 5 && !(x === 0 && z === 0));
  const deep = new Set<string>([k(0, 1, 0), k(0, 2, 0), k(0, 3, 0)]);
  const fDeep = new Map<string, MomentumCell>([[k(0, 1, 0), { vx: 1, vz: 0, s: 5 }]]);
  let d = deep;
  for (let t = 0; t < 2; t++) d = stepFluid(d, pit, { tick: t, maxDrainPerCol: 1, momentum: { field: fDeep, frictionDeep: 0.35, frictionRest: 0.7 } });
  const solidPool = (x: number, y: number, z: number) => y < 1;
  const sd = fDeep.get(k(0, 1, 0))?.s ?? 0;
  ok(sd < 5 * 0.36 * 0.36 + 0.01, `deep decay too slow: ${sd}`);
  // Flat single cell resting on solid: slower decay.
  const fRest = new Map<string, MomentumCell>([[k(0, 1, 0), { vx: 1, vz: 0, s: 5 }]]);
  let r = new Set<string>([k(0, 1, 0)]);
  for (let t = 0; t < 2; t++) r = stepFluid(r, solidPool, { tick: t, momentum: { field: fRest, frictionDeep: 0.35, frictionRest: 0.7 } });
  const sr = fRest.get(k(0, 1, 0))?.s ?? 0;
  ok(Math.abs(sr - 5 * 0.7 * 0.7) < 0.01, `rest decay wrong: ${sr}`);
  ok(sr > sd, "rest must retain more speed than deep");
});

// ── 4. Weir quota: fast water widens the per-mouth drain cap ────────────────
test("drain quota scales with descending cell speed", () => {
  // Two stacked cells over an open shaft; mouth cap 1.
  const shaft = (x: number, y: number, z: number) => y < 1 && !(x === 0 && z === 0);
  const mk = () => new Set<string>([k(0, 5, 0), k(0, 6, 0)]);
  const ySum = (s: Set<string>) => [...s].reduce((a, c) => a + +c.split(",")[1], 0);
  // Calm: mouth cap 1 → only one cell may descend this tick (y-sum −1; the
  // second cell is pushed to SPREAD).
  const calm = mk();
  const calmNext = stepFluid(calm, shaft, { tick: 0, maxDrainPerCol: 1, momentum: { field: new Map() } });
  const calmDrop = ySum(calm) - ySum(calmNext);
  // Fast: both carry s=2, weirK=1 → quota 1+floor(2)=3 → both descend (y-sum −2).
  const fast = mk();
  const ff = new Map<string, MomentumCell>([[k(0, 5, 0), { vx: 0, vz: 0, s: 2 }], [k(0, 6, 0), { vx: 0, vz: 0, s: 2 }]]);
  const fastNext = stepFluid(fast, shaft, { tick: 0, maxDrainPerCol: 1, momentum: { field: ff, weirK: 1 } });
  const fastDrop = ySum(fast) - ySum(fastNext);
  ok(calmDrop === 1, `calm should descend 1 cell total, got ${calmDrop}`);
  ok(fastDrop === 2, `fast should descend 2 cells total, got ${fastDrop}`);
});

// ── 5. Weir gate: fast crest cell skips the dwell, calm one holds ───────────
test("crest gate: s ≥ weirRes overtops immediately, calm water dwells", () => {
  // A ledge: solid platform at y<3 for x<=0; open void for x>0. One water cell
  // at the lip with pool water behind it (so `behind` is true).
  const ledge = (x: number, y: number, z: number) => y < 3 && x <= 0;
  // The lip cell (0,3,0) plus pool water beside it. (0,3,1) sorts AFTER the lip
  // (same y/x, larger z), so it is still in place when the lip's `behind` test
  // runs — a stable stand-in for the full pool of the real slope bed.
  const mk = () => new Set<string>([k(0, 3, 0), k(-1, 3, 0), k(0, 3, 1)]);
  // The lip cell would slide diagonally over the edge (down-diag free 2 deep).
  const dwellCalm = new Map<string, number>();
  const stCalm = { drops: 0, overtops: 0 };
  let calm = mk();
  calm = stepFluid(calm, ledge, { tick: 0, edgeHold: 5, dwell: dwellCalm, momentum: { field: new Map(), stats: stCalm } });
  ok(calm.has(k(0, 3, 0)), "calm lip cell must hold at the crest");
  ok(stCalm.overtops === 0, "calm hold is not an overtop");
  const stFast = { drops: 0, overtops: 0 };
  const ffield = new Map<string, MomentumCell>([[k(0, 3, 0), { vx: 1, vz: 0, s: 3 }]]);
  let fast = mk();
  fast = stepFluid(fast, ledge, { tick: 0, edgeHold: 5, dwell: new Map(), momentum: { field: ffield, weirRes: 1.2, stats: stFast } });
  ok(!fast.has(k(0, 3, 0)), "fast lip cell must punch over the lip");
  ok(stFast.overtops === 1, `expected 1 overtop, got ${stFast.overtops}`);
});

// ── 6. Phase 2 — heading bias: spread follows momentum heading ──────────────
test("spread picks the drop aligned with heading; calm cell keeps rotation order", () => {
  // Flat shelf (solid y<3) with two equidistant pit columns: (3,0) along +x and
  // (0,3) along +z. Classic rotation order at tick 0 explores +x first.
  const shelf = (x: number, y: number, z: number) =>
    y < 3 && !((x === 3 && z === 0) || (x === 0 && z === 3));
  // Calm cell → classic order → moves toward +x.
  let calm = new Set<string>([k(0, 3, 0)]);
  calm = stepFluid(calm, shelf, { tick: 0, momentum: { field: new Map() } });
  ok(calm.has(k(1, 3, 0)), `calm cell should step +x (rotation order), got ${[...calm]}`);
  // Cell carrying +z heading → biased order → moves toward +z.
  const f = new Map<string, MomentumCell>([[k(0, 3, 0), { vx: 0, vz: 1, s: 2 }]]);
  let fast = new Set<string>([k(0, 3, 0)]);
  fast = stepFluid(fast, shelf, { tick: 0, momentum: { field: f, biasMin: 0.3 } });
  ok(fast.has(k(0, 3, 1)), `heading cell should step +z (biased), got ${[...fast]}`);
  // Below biasMin → classic again.
  const f2 = new Map<string, MomentumCell>([[k(0, 3, 0), { vx: 0, vz: 1, s: 0.1 }]]);
  let slow = new Set<string>([k(0, 3, 0)]);
  slow = stepFluid(slow, shelf, { tick: 0, momentum: { field: f2, biasMin: 0.3 } });
  ok(slow.has(k(1, 3, 0)), `sub-threshold cell should step +x (classic), got ${[...slow]}`);
});

// ── 7. Head-driven outlet: a pileup above the mouth widens the drain quota ────
test("head above the mouth widens the drain quota (taller fall on pileup)", () => {
  // A 1×1 open shaft (mouth at 0,0) with a 3-cell water pileup stacked above it.
  const shaft = (x: number, y: number, z: number) => y < 1 && !(x === 0 && z === 0);
  const mk = () => new Set<string>([k(0, 5, 0), k(0, 6, 0), k(0, 7, 0)]);
  const ySum = (s: Set<string>) => [...s].reduce((a, c) => a + +c.split(",")[1], 0);
  // Head OFF (headK 0): mouth cap 1, all speeds 0 → exactly one cell descends (y-sum −1).
  const off = mk();
  const offNext = stepFluid(off, shaft, { tick: 0, maxDrainPerCol: 1, momentum: { field: new Map(), headK: 0 } });
  const offDrop = ySum(off) - ySum(offNext);
  // Head ON (headK 1): the bottom cell (0,5,0) has 2 water cells stacked above it →
  // quota 1 + floor(1·2) = 3 → the whole stack drills through the mouth this tick.
  const on = mk();
  const onNext = stepFluid(on, shaft, { tick: 0, maxDrainPerCol: 1, momentum: { field: new Map(), headK: 1 } });
  const onDrop = ySum(on) - ySum(onNext);
  ok(offDrop === 1, `head-off should descend 1 cell, got ${offDrop}`);
  ok(onDrop > offDrop, `head-on should descend more than head-off (${onDrop} vs ${offDrop})`);
});

// ── 8. Drawdown: a stronger/faster outlet holds the lake at a LOWER equilibrium ─
// KJ ruling: "if the flow force is high enough it pulls the lake to a lower
// equilibrium." Throughput is conserved (= inflow at steady state), but the LAKE
// LEVEL is free: a stronger outlet passes the same inflow at a LOWER banked head.
// Tank = 3×3 footprint, tall solid walls (no overtop escape), solid floor with a
// SINGLE 1-col drain hole at (2,2) that falls to void. Steady inflow at the top.
// The only exit is the drain, whose per-mouth discharge = cap + weirK·s + headK·head,
// so the equilibrium head self-regulates to whatever level makes discharge = inflow.
test("stronger flow-force outlet draws the lake to a lower equilibrium level", () => {
  const FLOOR_Y = 0, WALL_TOP = 40, SRC_Y = 30, HX = 2, HZ = 2;
  const solid = (x: number, y: number, z: number) => {
    if (y < FLOOR_Y) return false;                         // void below → culled
    if (y < 1) return !(x === HX && z === HZ);             // floor: solid except the drain hole
    return (x < 1 || x > 3 || z < 1 || z > 3) && y < WALL_TOP; // tall containing walls
  };
  const run = (weirK: number, headK: number, cap: number) => {
    let w = new Set<string>();
    const field = new Map<string, MomentumCell>();
    const dwell = new Map<string, number>();
    for (let t = 0; t < 900; t++) {
      // steady inflow: keep three source cells filled at the top each tick
      for (const [sx, sz] of [[2, 2], [1, 2], [3, 2]]) if (!w.has(k(sx, SRC_Y, sz))) w.add(k(sx, SRC_Y, sz));
      w = stepFluid(w, solid, {
        tick: t, floorY: FLOOR_Y - 3, maxDrainPerCol: cap, edgeHold: 0, dwell,
        momentum: { field, inject: 1, weirK, headK, weirRes: 1.2, maxSpeed: 6, stats: { drops: 0, overtops: 0 } },
      });
    }
    let count = 0, maxY = -1;
    for (const c of w) { const y = +c.split(",")[1]; if (y < SRC_Y - 1) { count++; if (y > maxY) maxY = y; } }
    return { count, maxY };
  };
  const weak = run(0.2, 0, 1);   // weak, head-insensitive outlet → banks up high
  const strong = run(3, 5, 1);   // strong, flow+head-driven outlet → draws down
  ok(strong.count < weak.count, `strong outlet must hold less water (weak ${weak.count} vs strong ${strong.count})`);
  ok(strong.maxY < weak.maxY, `strong outlet must sit at a lower level (weak y${weak.maxY} vs strong y${strong.maxY})`);
});

// ── 9. Column propagation: upper water inherits the lower cell's direction ────
test("a stacked column advances together instead of collapsing to one layer", () => {
  const floor = (_x: number, y: number, _z: number) => y < 2;
  const start = new Set<string>([k(0, 2, 0), k(0, 3, 0)]);
  // A FLOWING column (real momentum) advances together; a calm one would collapse — the
  // momentum gate is the point, so seed the stack with speed heading +x.
  const field = new Map<string, { vx: number; vz: number; s: number }>([
    [k(0, 2, 0), { vx: 1, vz: 0, s: 3 }],
    [k(0, 3, 0), { vx: 1, vz: 0, s: 3 }],
  ]);
  const next = stepFluid(start, floor, {
    tick: 0, hydro: true, carryRate: 1,   // enable forward discharge; budget (head-driven) carries the stack
    momentum: { field },
  });
  ok(next.has(k(1, 2, 0)), `lower cell should advance into channel, got ${[...next]}`);
  ok(next.has(k(1, 3, 0)), `upper cell should inherit forward direction, got ${[...next]}`);
  ok(!next.has(k(0, 2, 0)) && !next.has(k(0, 3, 0)), "source column should advance as a two-cell body");
});

console.log(`\n${passed} momentum tests passed`);
