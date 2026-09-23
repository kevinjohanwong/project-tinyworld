import {
  surfaceVariance, valueNoise, chooseSpringOrigin, emitterCell,
  applyRain, springEmit, emitAndSettle, type Vec3,
} from "./water_spring";

const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
let passed = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

// A flat top surface patch: top solid cell y=10 for every column in an NxN grid.
const gridColumns = (n: number, y = 10): Vec3[] => {
  const cols: Vec3[] = [];
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) cols.push([x, y, z]);
  return cols;
};

// ── variance ──────────────────────────────────────────────────────────────
test("variance is deterministic", () => {
  const a = surfaceVariance(gridColumns(16), { amplitude: 3, frequency: 8, seed: 7 });
  const b = surfaceVariance(gridColumns(16), { amplitude: 3, frequency: 8, seed: 7 });
  for (const [key, v] of a) ok(b.get(key) === v, `mismatch at ${key}`);
});

test("variance stays within [0, amplitude]", () => {
  const v = surfaceVariance(gridColumns(24), { amplitude: 3, frequency: 6, seed: 3 });
  for (const [, d] of v) ok(d >= 0 && d <= 3, `delta ${d} out of range`);
});

test("variance actually varies (not a flat slab)", () => {
  const v = [...surfaceVariance(gridColumns(24), { amplitude: 4, frequency: 6, seed: 5 }).values()];
  const min = Math.min(...v), max = Math.max(...v);
  ok(max - min >= 2, `variance too flat: min ${min} max ${max}`);
});

test("variance creates interior basins (depressions that hold pools)", () => {
  // A basin floor = a cell no higher than any neighbor, with at least one
  // higher rim neighbor. Flat-bottomed basins (ties) count — that is exactly
  // what an integer-height pool floor looks like.
  const n = 24;
  const v = surfaceVariance(gridColumns(n), { amplitude: 4, frequency: 6, seed: 9 });
  const h = (x: number, z: number) => v.get(`${x},${z}`) ?? 0;
  let basins = 0;
  for (let x = 1; x < n - 1; x++) for (let z = 1; z < n - 1; z++) {
    const c = h(x, z);
    const nb = [h(x - 1, z), h(x + 1, z), h(x, z - 1), h(x, z + 1)];
    if (nb.every((val) => val >= c) && nb.some((val) => val > c)) basins++;
  }
  ok(basins >= 1, `expected at least one interior basin, found ${basins}`);
});

test("different seeds give different ceilings", () => {
  const a = surfaceVariance(gridColumns(16), { amplitude: 3, frequency: 8, seed: 1 });
  const b = surfaceVariance(gridColumns(16), { amplitude: 3, frequency: 8, seed: 2 });
  let diffs = 0;
  for (const [key, v] of a) if (b.get(key) !== v) diffs++;
  ok(diffs > 0, "seeds produced identical ceilings");
});

test("valueNoise is bounded in [0,1)", () => {
  for (let i = 0; i < 500; i++) {
    const nz = valueNoise(i * 3 - 40, i * 7 - 90, 8, 4);
    ok(nz >= 0 && nz < 1, `noise ${nz} out of [0,1)`);
  }
});

// ── siting ──────────────────────────────────────────────────────────────
test("spring sites on the highest post-variance column", () => {
  const cols = gridColumns(8);
  const variance = new Map<string, number>();
  variance.set("3,4", 9); // artificial peak well above the amplitude of others
  const origin = chooseSpringOrigin(cols, variance)!;
  ok(origin[0] === 3 && origin[2] === 4, `sited at ${origin} not the peak`);
});

test("emitter cell is one voxel above the spring block", () => {
  const e = emitterCell([5, 12, 6]);
  ok(e[0] === 5 && e[1] === 13 && e[2] === 6, `emitter at ${e}`);
});

test("empty surface has no spring", () => {
  ok(chooseSpringOrigin([]) === null, "expected null origin for empty surface");
});

// ── rainfall budget ─────────────────────────────────────────────────────
test("rain adds precipitation and caps at capacity", () => {
  let s = { budget: 0, capacity: 100 };
  s = applyRain(s, 30);         // +30
  ok(s.budget === 30, `budget ${s.budget}`);
  s = applyRain(s, 200);        // capped
  ok(s.budget === 100, `budget not capped: ${s.budget}`);
});

test("rain scale factor k applies", () => {
  const s = applyRain({ budget: 0, capacity: 1000 }, 5, 8);
  ok(s.budget === 40, `k scaling wrong: ${s.budget}`);
});

// ── emission gating ─────────────────────────────────────────────────────
test("spring emits only while funded, then goes dry", () => {
  let s = { budget: 2, capacity: 10 };
  const em: Vec3 = [0, 5, 0];
  let r = springEmit(s, em); ok(r.emit !== null && r.state.budget === 1, "tick1");
  s = r.state;
  r = springEmit(s, em); ok(r.emit !== null && r.state.budget === 0, "tick2");
  s = r.state;
  r = springEmit(s, em); ok(r.emit === null && r.state.budget === 0, "dry tick should not emit");
});

// ── integration: spring + additive settle conserves + falls + stacks ──────
test("spring drip down a well stacks and conserves exactly", () => {
  // A capped 1-wide well: floor at y=0, walls y=1..8. Emit from the top; water
  // falls and stacks from the floor up. Each funded tick adds exactly one cell.
  const solid = new Set<string>([k(0, 0, 0)]);
  for (let y = 1; y <= 8; y++) { solid.add(k(-1, y, 0)); solid.add(k(1, y, 0)); solid.add(k(0, y, -1)); solid.add(k(0, y, 1)); }
  const isSolid = (x: number, y: number, z: number) => solid.has(k(x, y, z));
  let water = new Set<string>();
  let s = { budget: 5, capacity: 10 };
  const emit: Vec3 = [0, 8, 0];
  let emitted = 0;
  for (let tick = 0; tick < 8; tick++) {
    const r = springEmit(s, emit); s = r.state;
    if (!r.emit) continue;
    emitted++;
    water = emitAndSettle(water, isSolid, r.emit, 1, { radius: 12, maxCells: 256, maxRise: 12 });
  }
  ok(emitted === 5, `expected 5 funded emissions, got ${emitted}`);
  ok(water.size === 5, `conservation broken: ${water.size} cells for 5 emissions`);
  // Stacked from the floor: cells at y=1..5.
  for (let y = 1; y <= 5; y++) ok(water.has(k(0, y, 0)), `missing stacked cell at y=${y}`);
});

test("dry spring adds no water", () => {
  const solid = new Set([k(0, 0, 0)]);
  const isSolid = (x: number, y: number, z: number) => solid.has(k(x, y, z));
  const water = new Set<string>([k(0, 1, 0)]);
  const s = { budget: 0, capacity: 10 };
  const emit = emitterCell([0, 8, 0]);
  const r = springEmit(s, emit);
  ok(r.emit === null, "dry spring emitted");
  const after = r.emit ? emitAndSettle(water, isSolid, emit, 1) : water;
  ok(after.size === 1, "water changed on a dry tick");
});

test("emitAndSettle leaves remote ponds untouched", () => {
  const solid = new Set<string>([k(0, 0, 0), k(40, 0, 40)]);
  const isSolid = (x: number, y: number, z: number) => solid.has(k(x, y, z));
  const water = new Set<string>([k(40, 1, 40)]); // remote pond far outside radius
  const out = emitAndSettle(water, isSolid, [0, 4, 0], 1, { radius: 8 });
  ok(out.has(k(40, 1, 40)), "remote pond was disturbed");
  ok(out.size === 2, `expected 2 cells (remote + 1 new), got ${out.size}`);
});

test("spring on a varied ceiling pools downhill into the dips (the wow case)", () => {
  // Build a solid varied ceiling: base slab at y=10, variance stacked on top.
  const n = 20, baseY = 10;
  const cols = gridColumns(n, baseY);
  const variance = surfaceVariance(cols, { amplitude: 4, frequency: 5, seed: 9 });
  const solid = new Set<string>();
  for (const [x, , z] of cols) {
    solid.add(k(x, baseY, z));
    const d = variance.get(`${x},${z}`) ?? 0;
    for (let j = 1; j <= d; j++) solid.add(k(x, baseY + j, z));
  }
  const isSolid = (x: number, y: number, z: number) => solid.has(k(x, y, z));
  const origin = chooseSpringOrigin(cols, variance)!; // effective peak cell
  const emit = emitterCell(origin);

  let water = new Set<string>();
  let s = { budget: 40, capacity: 60 };
  let emitted = 0;
  for (let tick = 0; tick < 60; tick++) {
    const r = springEmit(s, emit); s = r.state;
    if (!r.emit) continue;
    emitted++;
    water = emitAndSettle(water, isSolid, r.emit, 1, { radius: 30, maxCells: 4096, maxRise: 8 });
  }
  ok(emitted === 40, `expected 40 funded emissions, got ${emitted}`);
  ok(water.size === 40, `conservation broken: ${water.size} cells for 40 emissions`);
  // Never inside solid.
  for (const c of water) { const [x, y, z] = c.split(",").map(Number); ok(!isSolid(x, y, z), `water in solid at ${c}`); }
  // Water flowed downhill: at least some rests below the spring peak.
  const minY = Math.min(...[...water].map((c) => +c.split(",")[1]));
  ok(minY < origin[1], `water did not descend from the peak (minY ${minY} >= peak ${origin[1]})`);
});

console.log(`\nwater spring tests passed (${passed})`);
