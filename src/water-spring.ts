// Pure, deterministic spring + ceiling-variance core for TinyWorld.
//
// This module owns everything that can be reasoned about WITHOUT the live
// scene: how a ceiling/top surface is given rolling elevation variance so
// water pools in the dips, where a spring is sited, how rainfall funds the
// spring's finite budget, and how much water the spring emits per tick.
//
// The actual voxel stamping + downhill flow is done in the staging app, which
// composes `springEmit` with the existing volume-preserving `solveWaterFlow`.
// Keeping this side pure means it is unit-tested offline like water_flow.ts.

export type Vec3 = [number, number, number];

const keyXZ = (x: number, z: number) => `${x},${z}`;

// ── deterministic value noise ────────────────────────────────────────────
// Integer hash -> [0,1). Stable across runs (no Math.random), so a world's
// ceiling shape is reproducible and can be persisted/re-derived.
function hash2(x: number, z: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

// Smooth bilinear value noise on a grid of `freq`-voxel cells -> [0,1).
export function valueNoise(x: number, z: number, freq: number, seed: number): number {
  const f = Math.max(1, freq);
  const gx = Math.floor(x / f), gz = Math.floor(z / f);
  const fx = smooth((x - gx * f) / f), fz = smooth((z - gz * f) / f);
  const n00 = hash2(gx, gz, seed), n10 = hash2(gx + 1, gz, seed);
  const n01 = hash2(gx, gz + 1, seed), n11 = hash2(gx + 1, gz + 1, seed);
  const nx0 = n00 + (n10 - n00) * fx, nx1 = n01 + (n11 - n01) * fx;
  return nx0 + (nx1 - nx0) * fz;
}

// ── ceiling / top-surface variance ───────────────────────────────────────
export type VarianceOptions = {
  amplitude?: number; // max extra cells stacked above a top column
  frequency?: number; // noise cell size in voxels (larger = broader hills)
  seed?: number;
};

// Given the top solid cell of each (x,z) column of a surface, return how many
// extra solid cells to stack on top of it. Low-frequency noise yields rolling
// hills with interior local minima (natural basins that hold pools) while the
// surface perimeter stays an overflow edge. delta is in [0, amplitude].
export function surfaceVariance(
  columns: Vec3[],
  options: VarianceOptions = {},
): Map<string, number> {
  const amplitude = options.amplitude ?? 3;
  const frequency = options.frequency ?? 8;
  const seed = options.seed ?? 1;
  const out = new Map<string, number>();
  for (const [x, , z] of columns) {
    const n = valueNoise(x, z, frequency, seed); // [0,1)
    out.set(keyXZ(x, z), Math.round(n * amplitude));
  }
  return out;
}

// Effective top height of a column after variance is applied.
const effHeight = (c: Vec3, variance?: Map<string, number>) =>
  c[1] + (variance?.get(keyXZ(c[0], c[2])) ?? 0);

// ── spring siting ────────────────────────────────────────────────────────
// Pick the highest post-variance top cell (tie-break toward the surface
// centroid) so emitted water cascades outward across the whole varied surface
// into the dips, then overflows the edge as a waterfall. Returns the EFFECTIVE
// solid cell the spring block sits on (variance folded into y), so the emitter
// air cell is simply one voxel above it.
export function chooseSpringOrigin(
  topCells: Vec3[],
  variance?: Map<string, number>,
  opts?: { preferLow?: boolean },
): Vec3 | null {
  if (!topCells.length) return null;
  let cx = 0, cz = 0;
  for (const c of topCells) { cx += c[0]; cz += c[2]; }
  cx /= topCells.length; cz /= topCells.length;
  // preferLow sites the spring in the lowest central dip so emitted water pools
  // into that depression as a flat LAKE (contained by the basin walls) instead
  // of heaping on the highest point and overflowing everywhere.
  const low = opts?.preferLow ?? false;
  let best: Vec3 | null = null, bestScore = -Infinity;
  for (const c of topCells) {
    const h = effHeight(c, variance);
    const central = Math.abs(c[0] - cx) + Math.abs(c[2] - cz);
    const score = (low ? -h : h) * 100000 - central; // highest/lowest wins; centrality breaks ties
    if (score > bestScore) { bestScore = score; best = [c[0], h, c[2]]; }
  }
  return best;
}

// The air cell directly above the spring block, where water is injected.
export const emitterCell = (springCell: Vec3): Vec3 => [springCell[0], springCell[1] + 1, springCell[2]];

// ── rainfall budget + emission ───────────────────────────────────────────
// A finite, rain-fed reservoir behind the spring. Storage is abstract (a
// number), but it is a metered tap, not spendable inventory: it only ever
// dribbles out one cell at a time at the emitter, so conservation holds and
// no free building matter is created.
export type SpringState = { budget: number; capacity: number };

// Rain adds precipitation to the budget (capped at capacity). `k` scales
// precipitation units into water-cells; default 1 = "just add the amount".
export function applyRain(state: SpringState, precip: number, k = 1): SpringState {
  const budget = Math.max(0, Math.min(state.capacity, state.budget + precip * k));
  return { ...state, budget };
}

// If the budget can fund it, emit `perTick` cells: returns the emitter cell to
// add as water and the decremented state. Dry budget -> no emission (drought).
export function springEmit(
  state: SpringState,
  emitter: Vec3,
  perTick = 1,
): { emit: Vec3 | null; state: SpringState } {
  if (state.budget >= perTick) {
    return { emit: emitter, state: { ...state, budget: state.budget - perTick } };
  }
  return { emit: null, state };
}

// ── additive settle ──────────────────────────────────────────────────────
export type SettleOptions = { radius?: number; maxCells?: number; maxRise?: number };

// Add exactly `add` water cells to the connected pocket reachable from the
// emitter, then settle the whole pocket lowest-supported-first. Unlike
// solveWaterFlow (which re-solves ONE connected body at its current volume),
// this targets `localVolume + add`, so accumulation from a source is
// conservation-exact even when a fresh drop is not yet touching the pool it
// falls into. Water outside the emitter's reachable pocket (blocked by solids,
// e.g. remote ponds) is never touched.
export function emitAndSettle(
  water: Set<string>,
  isSolid: (x: number, y: number, z: number) => boolean,
  emitter: Vec3,
  add: number,
  options: SettleOptions = {},
): Set<string> {
  const radius = options.radius ?? 12, maxCells = options.maxCells ?? 1024, maxRise = options.maxRise ?? 4;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const [ex, ey, ez] = emitter;
  const minX = ex - radius, maxX = ex + radius, minZ = ez - radius, maxZ = ez + radius;
  const minY = ey - radius - maxRise, maxY = ey + maxRise;
  const inside = (x: number, y: number, z: number) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
  const dirs: Vec3[] = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]];

  // Spill-level priority flood (Barnes 2014) of the non-solid pocket reachable
  // from the emitter (water counts as non-solid, so an existing pool below is
  // part of the same pocket). Each cell's SPILL LEVEL is the highest y water
  // must cross to reach it from the source — for a cell you reach by going flat
  // or downhill that is just the source height, but to reach lower ground behind
  // a wall the level is the wall's rim height. Filling in (level, then y) order
  // makes water:
  //   • spread outward across open ground as a thin flat sheet (never towers),
  //   • fill a genuine basin bottom-up to its lowest lip, THEN spill over that
  //     lip — it can't "teleport" over a wall into lower ground it hasn't yet
  //     risen to reach.
  // Real solid terrain is the only wall; there is no invisible box dam.
  type Node = { x: number; y: number; z: number; d: number; L: number };
  const heapLess = (a: Node, b: Node) => a.L - b.L || a.d - b.d;
  const heap: Node[] = [];
  const heapPush = (n: Node) => {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapLess(heap[i], heap[p]) < 0) { const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; } else break;
    }
  };
  const heapPop = (): Node => {
    const top = heap[0], last = heap.pop() as Node;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let s = i;
        if (l < heap.length && heapLess(heap[l], heap[s]) < 0) s = l;
        if (r < heap.length && heapLess(heap[r], heap[s]) < 0) s = r;
        if (s === i) break;
        const t = heap[i]; heap[i] = heap[s]; heap[s] = t; i = s;
      }
    }
    return top;
  };
  const reachable = new Set<string>(), seen = new Set<string>();
  const levelOf = new Map<string, number>();
  if (!isSolid(ex, ey, ez)) { seen.add(key(ex, ey, ez)); heapPush({ x: ex, y: ey, z: ez, d: 0, L: ey }); }
  // Min-heap on L means a cell is first popped with its minimal spill level, so
  // recording level at first pop (and marking seen at push) is exact here.
  while (heap.length && reachable.size < maxCells) {
    const nd = heapPop(), kc = key(nd.x, nd.y, nd.z);
    reachable.add(kc); levelOf.set(kc, nd.L);
    for (const [dx, dy, dz] of dirs) {
      const nx = nd.x + dx, ny = nd.y + dy, nz = nd.z + dz, kk = key(nx, ny, nz);
      if (!inside(nx, ny, nz) || seen.has(kk) || isSolid(nx, ny, nz)) continue;
      seen.add(kk);
      heapPush({ x: nx, y: ny, z: nz, d: Math.abs(nx - ex) + Math.abs(nz - ez), L: Math.max(nd.L, ny) });
    }
  }

  const localBody = [...reachable].filter((k) => water.has(k));
  const target = localBody.length + Math.max(0, add);
  if (target <= 0) return new Set(water);

  const cells = [...reachable].map((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return { k, x, y, z, d: Math.abs(x - ex) + Math.abs(z - ez), L: levelOf.get(k) ?? y };
  });

  // Support test (no floating water): a cell rests on solid or on a fillable cell
  // below it. Computed in y order so support propagates upward correctly.
  const supported = new Set<string>();
  for (const c of [...cells].sort((a, b) => a.y - b.y)) {
    const below = key(c.x, c.y - 1, c.z);
    if (isSolid(c.x, c.y - 1, c.z) || supported.has(below)) supported.add(c.k);
  }
  // Fill in spill-level order: lowest reachable level first, lowest y within a
  // level, nearest first — the resting water configuration.
  const candidates = cells
    .filter((c) => supported.has(c.k))
    .sort((a, b) => a.L - b.L || a.y - b.y || a.d - b.d || a.x - b.x || a.z - b.z);

  const result = new Set(water);
  for (const k of localBody) result.delete(k);
  for (const c of candidates.slice(0, target)) result.add(c.k);
  return result;
}

// ── cellular-automata flow (temporal, one cell per tick) ───────────────────
// A discrete falling-sand / CA step: unlike emitAndSettle (which computes a
// resting level in ONE shot and can pile water inside its own search bound),
// this advances the fluid by exactly ONE cell of motion per call, so water
// visibly ticks downward from the source, spreads outward as it flows, and can
// NEVER tower on open ground — the classic complaint. Best-in-class references:
//   • Minecraft / Dwarf Fortress — discrete per-tick flow toward the lowest
//     reachable neighbour (down, then down-diagonal, then sideways).
//   • W-Shadow / "Game of Flow" cellular-automaton fluids — horizontal
//     EQUALIZATION so a pile sheds sideways and self-levels instead of stacking.
//   • Noita / falling-sand — the down → down-diagonal → sideways priority.
//
// Rules, applied to each water cell once per step (processed lowest-y first so a
// cell that vacates frees space for the one above it, then a deterministic
// tie-break; direction order rotates with `tick` to kill left-bias):
//   1. FALL       — the cell directly below is free → move down one cell.
//   2. SLIDE      — straight-down blocked but a down-diagonal is free → slide.
//   3. SPREAD     — resting on something, but the cell is PILED (standing on
//                   water, i.e. ≥2 deep) and a same-level neighbour is free and
//                   supported → move sideways to level out. The "piled" guard is
//                   what stops a 1-deep sheet from creeping forever: a single
//                   layer resting on solid ground never spreads, so the fluid
//                   settles to a flat, still sheet with no jitter.
// Cells that fall below `floorY` (off an island edge into the void) are culled,
// so an overflowing spring pours off the rim as a real, falling waterfall that
// then drains away — inflow at the source balances outflow at the lip.
// ── momentum field (Phase 1, water-physics-plan.md) ────────────────────────
// Per-active-water-cell coarse velocity {vx, vz, s}: s is MEASURED speed (cells
// advanced over recent ticks — front-tracking, not force integration), vx/vz the
// horizontal heading. The field never moves mass on its own — it only weights
// choices the CA already makes (drain quota, crest gate). Passing no `momentum`
// option (or an empty field with default params) leaves stepFluid bit-identical
// to the pre-momentum behaviour.
export type MomentumCell = { vx: number; vz: number; s: number };
export type MomentumOptions = {
  field: Map<string, MomentumCell>; // runtime-owned, keyed by cell key, mutated in place
  inject?: number;        // speed added per cell of descent (PE→KE; consecutive drops compound)
  frictionRest?: number;  // per-tick decay multiplier for a cell that did not move (flat ground)
  frictionDeep?: number;  // decay when ≥2 water above (subcritical pool — the hydraulic jump)
  frictionFlow?: number;  // mild decay while moving horizontally (channel run keeps most speed)
  weirK?: number;         // extra per-mouth drain quota per unit of the descending cell's s
  weirRes?: number;       // lip resistance: a crest cell with s ≥ weirRes overtops without dwelling
  headK?: number;         // HEAD-DRIVEN OUTLET: extra per-mouth quota per cell of water STACKED
                          // above the mouth (the pileup behind a notch). A narrow gap that backs
                          // water up thus pushes MORE discharge through the same mouth → a taller,
                          // denser falling curtain. 0 = off (classic mouth cap).
  headMax?: number;       // clamp on the counted head so a very deep pool can't runaway the quota
  maxSpeed?: number;      // hard clamp on s
  biasMin?: number;       // Phase 2: min s for heading-biased spread (below = classic rotation order)
  levelFlow?: number;     // FLOW-AWARE LEVELING (KJ, rivers): a resting cell may equalise onto a
                          // neighbour whose surface is only ONE cell lower — instead of the churn-safe
                          // ≥2 gate — but ONLY while it still carries s ≥ levelFlow (active through-flow).
                          // This lets a FED channel back up and stack a taller face against a weir/lip
                          // (the depth that ≥2 alone froze into a 1-cell staircase), while a STILL pool
                          // decays below the gate and settles with the classic ≥2 rule → no churn.
                          // 0 disables (pure ≥2). Inert when momentum is off (s≡0). Default 0.25.
  stats?: { drops: number; overtops: number }; // per-step counters, mutated in place
};

export type FluidOptions = {
  floorY?: number;                 // cells strictly below this are removed (fell off world)
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  tick?: number;                   // step counter → rotates horizontal preference (anti-bias)
  maxCells?: number;               // hard safety cap on body size
  spreadRange?: number;            // how far water on a solid top searches for a drop/edge
  maxScan?: number;                // per-cell BFS visit cap (perf guard)
  edgeHold?: number;               // steps a lip/crest cell dwells before spilling over (0 = off)
  dwell?: Map<string, number>;     // persistent crest-dwell counters (runtime-owned, mutated in place)
  momentum?: MomentumOptions;      // optional momentum layer (absent = exactly the classic CA)
  hydro?: boolean;                 // HYDROSTATIC-PRESSURE lateral rule (replaces the BFS "seek a
                                   // distant drop" SPREAD with real head-gradient flow). Off (default)
                                   // = the classic BFS spread → bit-identical to the pre-hydro CA.
                                   // When on: a resting cell flows to an immediate neighbour ONLY if
                                   // that neighbour offers a lower head — either it can descend (an
                                   // outlet at this cell's own level → multi-level discharge) or its
                                   // column surface is lower (spread to equalise). No lower neighbour ⇒
                                   // no move ⇒ CALM EMERGES with no threshold checking for it. The
                                   // per-column lateral quota scales with the water STACKED ABOVE the
                                   // cell (hydrostatic pressure): a deep column pushes MANY cells out
                                   // per tick, a shallow one just a trickle — so a lake feeding a narrow
                                   // channel supplies it faster than one layer drains and the channel
                                   // runs several voxels deep, while a wide shallow sheet barely pushes.
                                   // Depth pressure emerges from multi-level discharge (every submerged
                                   // level sheds through its own opening), not a per-column rate knob.
  carryRate?: number;              // hydro FORWARD-DISCHARGE ENABLE (KJ): >0 turns on the mass-conserving
                                   // forward carry — when a cell would drop into a hole the cell below JUST
                                   // vacated, it instead rides FORWARD toward the lowest-head neighbour so a
                                   // column advances as a BODY and a fed channel holds depth. 0 = off. The
                                   // value is no longer a probability; how many cells cross is set by the
                                   // head-driven budget below (this only gates the mechanism on/off).
  fwdHeadK?: number;               // MASS-CONSERVING DISCHARGE BUDGET: cells a column may carry forward per
                                   // tick = max(1, floor(fwdHeadK·(head−1) + fwdDischargeK·s)). head = total
                                   // column depth (the pileup pressing down). fwdHeadK=1 ⇒ a stack of depth D
                                   // translates ~D-deep forward instead of collapsing to a 1-voxel skin, so
                                   // the river at the entrance is as deep as the column feeding it. Default 1.
  fwdDischargeK?: number;          // extra forward budget per unit of the feeding cell's measured speed s
                                   // (stream power): faster flow pushes more cells across the mouth. Default 0.5.
  carrySpeedMin?: number;          // MOMENTUM GATE: the feeding cell must carry at least this speed to ride a
                                   // column forward. Calm water decays below it (friction) → no carry → a
                                   // closed pool levels and settles; only flowing water holds depth. Default 0.5.
  maxDrainPerCol?: number;         // PER-MOUTH DRAIN CAP: max cells that may descend through one
                                   // (x,z) column per tick. A wide cliff = long perimeter = many
                                   // mouths = high throughput (spills fast); a narrow crater pinhole
                                   // = one mouth = bottlenecks (backs up and SPREADS sideways). So a
                                   // pool fills horizontal volume before it drills a hole, and the
                                   // geometry self-classifies as edge-vs-hole with no explicit test.
                                   // Default Infinity = unthrottled (original behaviour).
};

const HDIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function stepFluid(
  water: Set<string>,
  isSolid: (x: number, y: number, z: number) => boolean,
  options: FluidOptions = {},
): Set<string> {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const floorY = options.floorY ?? -Infinity;
  const b = options.bounds;
  const tick = options.tick ?? 0;
  const spreadRange = options.spreadRange ?? 20;
  const maxScan = options.maxScan ?? 400;
  const edgeHold = options.edgeHold ?? 0;
  const dwell = options.dwell;
  const maxDrainPerCol = options.maxDrainPerCol ?? Infinity;
  const inB = (x: number, z: number) => !b || (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);

  // Momentum layer (optional). All hooks are no-ops when `mom` is undefined,
  // and with an empty field + s=0 the quota/gate math reduces to the classic
  // constants — so momentum-off is bit-identical to the original CA.
  const mom = options.momentum;
  const momField = mom?.field;
  const M_INJECT = mom?.inject ?? 1;
  const M_FREST = mom?.frictionRest ?? 0.7;
  const M_FDEEP = mom?.frictionDeep ?? 0.35;
  const M_FFLOW = mom?.frictionFlow ?? 0.92;
  const M_WEIRK = mom?.weirK ?? 1;
  const M_WEIRRES = mom?.weirRes ?? 1.2;
  const M_HEADK = mom?.headK ?? 0;
  const M_HEADMAX = mom?.headMax ?? 12;
  const M_MAX = mom?.maxSpeed ?? 6;
  const M_BIASMIN = mom?.biasMin ?? 0.3;
  const M_LEVELFLOW = mom?.levelFlow ?? 0.25; // flow-aware leveling gate (rivers stack, lakes stay calm)
  const speedOf = (k: string) => momField?.get(k)?.s ?? 0;
  // Phase 2 — DIRECTIONAL CHANNEL BIAS: a cell carrying real momentum explores
  // its spread directions best-aligned-with-heading first (dot product), so a
  // stream KEEPS its heading through the BFS drop search instead of sheeting
  // radially in rotation order. Calm cells (s < biasMin, tiny heading, or no
  // momentum layer) use the classic rotated order — parity preserved.
  const dirsFor = (k: string, base: ReadonlyArray<readonly [number, number]>) => {
    const m = momField?.get(k);
    if (!m || m.s < M_BIASMIN) return base;
    const len = Math.hypot(m.vx, m.vz);
    if (len < 0.2) return base;
    const nx = m.vx / len, nz = m.vz / len;
    return [...base].sort((a, b) => (b[0] * nx + b[1] * nz) - (a[0] * nx + a[1] * nz));
  };
  // Transfer a cell's momentum entry to its new key, applying an update.
  // kind: "drop" = descended one cell (inject, heading kept unless diagonal),
  // "flow" = moved horizontally (mild friction, heading blends toward the move).
  const momMove = (fromK: string, toK: string, dx: number, dz: number, kind: "drop" | "flow") => {
    if (!momField) return;
    const m = momField.get(fromK) ?? { vx: 0, vz: 0, s: 0 };
    momField.delete(fromK);
    if (kind === "drop") {
      m.s = Math.min(M_MAX, m.s + M_INJECT);
      if (mom?.stats) mom.stats.drops++;
    } else {
      m.s = m.s * M_FFLOW;
    }
    if (dx !== 0 || dz !== 0) { m.vx = m.vx * 0.5 + dx * 0.5; m.vz = m.vz * 0.5 + dz * 0.5; }
    if (m.s >= 0.05 || m.vx !== 0 || m.vz !== 0) momField.set(toK, m);
  };
  // Friction for a cell that did NOT move this step: deep pool (≥2 water above =
  // subcritical) sheds speed in 1–2 ticks — the hydraulic jump; flat rest decays
  // slower. Entries that fall below the floor are dropped (bounded field).
  const momRest = (k: string, x: number, y: number, z: number) => {
    if (!momField) return;
    const m = momField.get(k);
    if (!m) return;
    const deep = result.has(key(x, y + 1, z)) && result.has(key(x, y + 2, z));
    m.s *= deep ? M_FDEEP : M_FREST;
    if (m.s < 0.05) momField.delete(k); else momField.set(k, m);
  };

  const result = new Set(water);
  const moved = new Set<string>();
  // Per-tick descent ledger: (x,z) mouth → how many cells have already descended
  // through it this step. A mouth accepts a descent only while under its quota.
  // WEIR (momentum): the quota grows with the DESCENDING cell's speed —
  // maxDrainPerCol + floor(weirK × s) — so fast water drains more through the
  // same mouth per tick (stream power = discharge × slope); still water gets
  // exactly the classic cap. Once saturated, further water above it must spread
  // sideways instead of drilling.
  const drained = new Map<string, number>();
  const mouthKey = (x: number, z: number) => `${x},${z}`;
  // HEAD above a mouth = contiguous water cells stacked directly over (x,y,z) in the
  // live body — the vertical pileup pressing down on the outlet. Clamped to headMax.
  const headAbove = (x: number, y: number, z: number) => {
    if (!momField || M_HEADK <= 0) return 0;
    let h = 0, yy = y;
    while (h < M_HEADMAX && result.has(key(x, yy + 1, z))) { h++; yy++; }
    return h;
  };
  // Per-mouth quota = maxDrainPerCol + floor(weirK·s) [stream power] + floor(headK·head)
  // [hydrostatic head]. So a narrow notch that piles water up behind it discharges
  // more through the same mouth — a taller, thicker fall — instead of a thin trickle.
  const canDrain = (x: number, z: number, s = 0, head = 0) =>
    (drained.get(mouthKey(x, z)) ?? 0) < maxDrainPerCol + (momField ? Math.floor(M_WEIRK * s) + Math.floor(M_HEADK * head) : 0);
  const useDrain = (x: number, z: number) => { const k = mouthKey(x, z); drained.set(k, (drained.get(k) ?? 0) + 1); };
  // A target is available if it is inside bounds, not solid, and not already
  // occupied in the (mutating) result — reading result gives us reservation, so
  // two cells can never flow into the same voxel this step.
  const free = (x: number, y: number, z: number) =>
    inB(x, z) && !isSolid(x, y, z) && !result.has(key(x, y, z));

  // Rotate the 4 horizontal directions by tick so bias averages out over time.
  const rot = ((tick % 4) + 4) % 4;
  const hdirs = HDIRS.map((_, i) => HDIRS[(i + rot) % 4]);

  const cells = [...water]
    .map((k) => { const [x, y, z] = k.split(",").map(Number); return { k, x, y, z }; })
    .sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);

  // ── HYDROSTATIC lateral (options.hydro) ────────────────────────────────────
  // colTop(x,z) = per-tick snapshot of the water surface height of each column
  // (highest water y in the INPUT body). Stable within the tick; head comparisons
  // read it so a level surface yields no gradient → no lateral move → emergent calm.
  const HYDRO = options.hydro ?? false;
  const CARRY_RATE = options.carryRate ?? 0;          // forward-discharge ENABLE (0 = off, parity)
  const FWD_HEAD_K = options.fwdHeadK ?? 1;           // budget slope per unit of head (pileup)
  const FWD_DISCHARGE_K = options.fwdDischargeK ?? 0.5; // + budget per unit of feeding speed (stream power)
  const CARRY_SPEED_MIN = options.carrySpeedMin ?? 0.5; // feeding cell must carry ≥ this MOMENTUM to ride
                                                        // forward. Calm water (s→0 via friction) never carries,
                                                        // so a closed pool LEVELS and settles emergently; only
                                                        // genuinely FLOWING water holds a column together. This
                                                        // is the local signal for "net through-flow" that head
                                                        // alone cannot provide (KJ: speed drives flow, not depth).
  const colTop = new Map<string, number>();          // per-tick water surface height per column
  const colBottom = new Map<string, number>();       // lowest occupied level; top-bottom+1 = total column head
  if (HYDRO) {
    for (const c of cells) {
      const ck = `${c.x},${c.z}`;
      const t = colTop.get(ck), bot = colBottom.get(ck);
      if (t === undefined || c.y > t) colTop.set(ck, c.y);
      if (bot === undefined || c.y < bot) colBottom.set(ck, c.y);
    }
  }
  // A lower cell that genuinely moves sideways writes the direction and its measured
  // speed for its SOURCE column. Because cells are processed bottom-up, supported cells
  // above it inherit that direction instead of serially collapsing into the hole.
  const columnForward = new Map<string, { dx: number; dz: number; s: number }>();
  const recordColumnForward = (c: { k: string; x: number; y: number; z: number }, dx: number, dz: number) => {
    if (!HYDRO) return;
    columnForward.set(`${c.x},${c.z}`, { dx, dz, s: speedOf(c.k) });
  };
  // MASS-CONSERVING FORWARD-DISCHARGE BUDGET (replaces the old per-cell probability).
  // Meter how many stacked cells a source column may carry FORWARD across the mouth this
  // tick as a deterministic function of head (the pileup pressing down) + the feeding
  // cell's speed (stream power) — instead of each upper cell independently rolling a dice.
  // A fixed count crosses, so a deep-fed channel translates forward as a body and holds
  // its depth along its whole length instead of thinning to a 1-voxel skin wherever the
  // rolls came up short. A 1-deep skin (head<2) has no pileup to push, so budget 0.
  const forwarded = new Map<string, number>();       // forward carries already spent per source column this tick
  const forwardBudget = (ck: string, s: number): number => {
    const top = colTop.get(ck), bot = colBottom.get(ck);
    if (top === undefined || bot === undefined) return 0;
    const head = top - bot + 1;
    if (head < 2) return 0;
    return Math.max(1, Math.floor(FWD_HEAD_K * (head - 1) + FWD_DISCHARGE_K * s));
  };
  // The hydrostatic lateral choice for a RESTING cell (below blocked). One step toward
  // the lowest-head neighbour, or null (→ the cell rests → calm). Depth pressure is NOT
  // a per-column rate knob (grid gravity refills a column vertically the instant it
  // sheds, so such a knob is inert); it emerges instead from MULTI-LEVEL DISCHARGE —
  // every submerged level runs this rule against its OWN neighbour, so a deep body
  // pushes out across many levels at once while a shallow one barely trickles.
  const hydroDir = (c: { k: string; x: number; y: number; z: number }): readonly [number, number] | null => {
    const myTop = colTop.get(`${c.x},${c.z}`) ?? c.y;
    let best: readonly [number, number] | null = null, bestScore = -Infinity;
    for (const [dx, dz] of dirsFor(c.k, hdirs)) {
      const nx = c.x + dx, nz = c.z + dz;
      if (!free(nx, c.y, nz)) continue;                             // opening must exist at THIS level
      const canDrop = free(nx, c.y - 1, nz);                        // outlet at this level (multi-level discharge)
      const nTop = colTop.get(`${nx},${nz}`) ?? -Infinity;          // neighbour column surface
      // A same-level (non-drop) move only LOWERS the profile if the neighbour is ≥2
      // below: moving onto a 1-below neighbour merely swaps the bump (churn, never
      // settles). ≥2 genuinely levels. This is the discrete condition for the move to
      // reduce potential energy — and it makes a level (or ±1) surface a fixed point,
      // so calm emerges with no threshold policing it.
      // A same-level (non-drop) move lowers the profile only if the neighbour is ≥2 below
      // (a 1-below move just swaps the bump → churn) — EXCEPT a cell still carrying real
      // flow (s ≥ M_LEVELFLOW) may equalise a 1-cell step, so a FED body backs up and stacks
      // against a barrier instead of freezing into a 1-cell staircase. Still water decays
      // below the gate → classic ≥2 → settles calm.
      const levels = (myTop - nTop >= 2) || (M_LEVELFLOW > 0 && myTop - nTop >= 1 && speedOf(c.k) >= M_LEVELFLOW);
      if (!canDrop && !levels) continue;                            // no downhill head gradient → skip (calm)
      const score = (canDrop ? 1e6 : 0) + (myTop - nTop);          // prefer real outlets, then steepest surface drop
      if (score > bestScore) { bestScore = score; best = [dx, dz] as const; }
    }
    return best;
  };

  for (const c of cells) {
    if (moved.has(c.k)) continue;
    // Fell off the world → cull.
    if (c.y < floorY) { result.delete(c.k); continue; }

    // 0. CREST DWELL — a cell perched at a spill lip (it would FALL straight over,
    //    or SLIDE diagonally over, a real 2-deep drop into void) while pool water
    //    is behind it holds for `edgeHold` steps before spilling. While it holds it
    //    blocks the cells feeding toward the edge, so the pool behind stays a touch
    //    fuller (a surface-tension crest) instead of draining the instant water
    //    reaches the rim. Only genuine ledges qualify (the water would free-fall),
    //    so ordinary downhill flow and mid-air droplets are never held — the fall
    //    itself doesn't stutter, only the crest at the very edge does.
    if (edgeHold > 0 && dwell && !result.has(key(c.x, c.y + 1, c.z))) {
      // A genuine spill = a spill direction where the target is free AND the cell
      // below the target is also free (water will keep falling past it).
      let spills = free(c.x, c.y - 1, c.z) && free(c.x, c.y - 2, c.z);
      if (!spills) {
        for (const [dx, dz] of HDIRS) {
          if (free(c.x + dx, c.y - 1, c.z + dz) && free(c.x + dx, c.y - 2, c.z + dz)) { spills = true; break; }
        }
      }
      if (spills) {
        let behind = false;
        for (const [dx, dz] of HDIRS) {
          if (result.has(key(c.x + dx, c.y, c.z + dz))) { behind = true; break; }
        }
        if (behind) {
          // WEIR GATE (momentum): lip = "minus", accumulated momentum = "plus".
          // A crest cell that arrives carrying s ≥ weirRes punches straight over
          // the lip (no dwell). Calm water (s < weirRes, including momentum-off)
          // banks up behind the crest exactly as before: it holds for edgeHold
          // steps, then spills — a still lake never bursts, it overtops only by
          // genuinely rising over the lip.
          if (momField && speedOf(c.k) >= M_WEIRRES) {
            dwell.delete(c.k);
            if (mom?.stats) mom.stats.overtops++;
          } else {
            const d = dwell.get(c.k) ?? edgeHold;
            if (d > 0) { dwell.set(c.k, d - 1); momRest(c.k, c.x, c.y, c.z); continue; } // hold at the crest
            dwell.delete(c.k);                                // dwell expired → spill this step
            if (mom?.stats) mom.stats.overtops++;
          }
        }
      }
    }

    // 1. FALL straight down — throttled by the mouth column (c.x,c.z). When the
    //    mouth is saturated the cell may NOT fall this tick and skips SLIDE too, so
    //    it is pushed into SPREAD and levels out instead of drilling the hole.
    if (free(c.x, c.y - 1, c.z)) {
      // COLUMN FORWARD PROPAGATION (hydro): the cell below was water at tick start
      // but just moved sideways, opening a hole. Instead of collapsing straight down
      // into it, this cell rides FORWARD in the lower cell's inherited direction — but
      // only while the column's mass-conserving discharge budget has room. The budget
      // is a deterministic function of head + feeding speed, so a stack of depth D
      // advances ~D cells forward as a BODY (the river at the entrance stays as deep as
      // the column feeding it) rather than each cell independently rolling a dice and
      // usually losing, which thinned the flow to a 1-voxel skin. Once the budget for
      // this column is spent this tick, the remaining upper cells collapse down normally.
      // A pre-existing unsupported drop (below empty at tick start) always falls.
      // Carry ONLY along an INHERITED horizontal direction — i.e. the cell below just
      // moved SIDEWAYS (a genuine translation / through-flow), so the column advances as a
      // body and the river stays as deep as the stack feeding it. Crucially there is NO
      // fresh-direction fallback: when the cell below instead DROPPED (slid/fell downward,
      // which never records a direction), the column is collapsing and this cell must fall
      // straight into the vacated hole. That single distinction is what lets a closed body
      // level and settle while a fed channel keeps its depth.
      if (HYDRO && CARRY_RATE > 0 && water.has(key(c.x, c.y - 1, c.z))) {
        const ck = `${c.x},${c.z}`;
        const inherited = columnForward.get(ck);
        const used = forwarded.get(ck) ?? 0;
        const budget = inherited ? forwardBudget(ck, inherited.s) : 0;
        if (inherited && inherited.s >= CARRY_SPEED_MIN && used < budget && free(c.x + inherited.dx, c.y, c.z + inherited.dz)) {
          forwarded.set(ck, used + 1);
          recordColumnForward(c, inherited.dx, inherited.dz);
          result.delete(c.k);
          const nk = key(c.x + inherited.dx, c.y, c.z + inherited.dz);
          result.add(nk); moved.add(nk);
          momMove(c.k, nk, inherited.dx, inherited.dz, "flow");
          continue;
        }
      }
      if (canDrain(c.x, c.z, speedOf(c.k), headAbove(c.x, c.y, c.z))) {
        useDrain(c.x, c.z);
        result.delete(c.k);
        const nk = key(c.x, c.y - 1, c.z);
        result.add(nk); moved.add(nk);
        momMove(c.k, nk, 0, 0, "drop");   // PE→KE: descent injects speed, heading kept
        continue;
      }
      // saturated straight-down mouth → fall through to SPREAD (do not slide).
    } else {
      // 2. SLIDE down-diagonally (only reached when straight-down is blocked),
      //    throttled by the TARGET mouth column.
      let slid = false;
      for (const [dx, dz] of hdirs) {
        if (free(c.x + dx, c.y - 1, c.z + dz)) {
          if (!canDrain(c.x + dx, c.z + dz, speedOf(c.k), headAbove(c.x, c.y, c.z))) continue;
          useDrain(c.x + dx, c.z + dz);
          result.delete(c.k);
          const nk = key(c.x + dx, c.y - 1, c.z + dz);
          result.add(nk); moved.add(nk);
          momMove(c.k, nk, dx, dz, "drop"); // diagonal descent: inject + heading toward the slide
          slid = true; break;
        }
      }
      if (slid) continue;
    }
    // 3. SPREAD sideways — Minecraft/Dwarf-Fortress-style DOWNHILL SEEKING. From
    //    a cell resting on a solid/water top, breadth-first search the reachable
    //    same-level surface (up to `spreadRange`) for the nearest "drop": a
    //    position from which water could descend (a lower/unfilled column, a
    //    basin rim, or a void edge). Step one cell toward it. If NO drop is in
    //    reach, the cell stays put — so a thin sheet on flat ground does not
    //    creep or jitter, while water always flows toward edges and self-levels
    //    piles (an unfilled neighbour column reads as a drop). This is the piece
    //    that makes "spread outward until it hits real terrain, then stop" true.
    const dir = HYDRO ? hydroDir(c) : flowDir(c.x, c.y, c.z, dirsFor(c.k, hdirs));
    if (dir) {
      const nx = c.x + dir[0], nz = c.z + dir[1];
      recordColumnForward(c, dir[0], dir[1]);
      result.delete(c.k);
      const nk = key(nx, c.y, nz);
      result.add(nk); moved.add(nk);
      momMove(c.k, nk, dir[0], dir[1], "flow"); // advection: momentum rides with the moving cell
    } else {
      momRest(c.k, c.x, c.y, c.z); // resting: friction (deep pool = hydraulic jump)
    }
  }

  // Bounded BFS over the walkable same-level surface for the first-step direction
  // toward the nearest drop. A neighbour cell is walkable if it is free and
  // supported (rests on solid or water); a cell is a "drop" if water placed there
  // could fall (its floor is free — void/air/unfilled). Returns null if none in
  // reach (→ the cell rests).
  function flowDir(
    sx: number, sy: number, sz: number,
    dirs: ReadonlyArray<readonly [number, number]> = hdirs,
  ): readonly [number, number] | null {
    const startK = key(sx, sy, sz);
    const seen = new Set<string>([startK]);
    let q: Array<{ x: number; z: number; first: readonly [number, number] | null; d: number }> = [
      { x: sx, z: sz, first: null, d: 0 },
    ];
    let scanned = 0;
    while (q.length && scanned < maxScan) {
      const n = q.shift()!;
      scanned++;
      if (n.d > spreadRange) continue;
      for (const [dx, dz] of dirs) {
        const nx = n.x + dx, nz = n.z + dz, kk = key(nx, sy, nz);
        if (seen.has(kk)) continue;
        if (!free(nx, sy, nz)) continue;             // blocked by solid/water at this level
        seen.add(kk);
        const first = n.first ?? ([dx, dz] as const);
        // Can water at (nx,sy,nz) descend? → this is a drop; flow toward it.
        if (free(nx, sy - 1, nz)) return first;
        // Otherwise it's supported walkable surface; keep searching outward.
        q.push({ x: nx, z: nz, first, d: n.d + 1 });
      }
    }
    return null;
  }
  // Drop dwell counters for cells that no longer exist at that position (spilled,
  // moved, or culled) so the map can't grow without bound.
  if (dwell) for (const k of dwell.keys()) if (!result.has(k)) dwell.delete(k);
  // Same bound for the momentum field: entries only for live water cells.
  if (momField) for (const k of momField.keys()) if (!result.has(k)) momField.delete(k);
  return result;
}
