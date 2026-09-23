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
export function chooseSpringOrigin(topCells: Vec3[], variance?: Map<string, number>): Vec3 | null {
  if (!topCells.length) return null;
  let cx = 0, cz = 0;
  for (const c of topCells) { cx += c[0]; cz += c[2]; }
  cx /= topCells.length; cz /= topCells.length;
  let best: Vec3 | null = null, bestScore = -Infinity;
  for (const c of topCells) {
    const h = effHeight(c, variance);
    const central = Math.abs(c[0] - cx) + Math.abs(c[2] - cz);
    const score = h * 100000 - central; // highest wins; centrality breaks ties
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

  // Flood the non-solid pocket reachable from the emitter (water counts as
  // non-solid, so an existing pool below is part of the same pocket).
  const reachable = new Set<string>(), queue: Vec3[] = [];
  if (!isSolid(ex, ey, ez)) { reachable.add(key(ex, ey, ez)); queue.push([ex, ey, ez]); }
  for (let h = 0; h < queue.length && reachable.size < maxCells;) {
    const [x, y, z] = queue[h++];
    for (const [dx, dy, dz] of dirs) {
      const nx = x + dx, ny = y + dy, nz = z + dz, kk = key(nx, ny, nz);
      if (!inside(nx, ny, nz) || reachable.has(kk) || isSolid(nx, ny, nz)) continue;
      reachable.add(kk); queue.push([nx, ny, nz]);
      if (reachable.size >= maxCells) break;
    }
  }

  const localBody = [...reachable].filter((k) => water.has(k));
  const target = localBody.length + Math.max(0, add);
  if (target <= 0) return new Set(water);

  const ordered = [...reachable].map((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return { k, x, y, z, d: Math.abs(x - ex) + Math.abs(z - ez) };
  }).sort((a, b) => a.y - b.y || a.d - b.d || a.x - b.x || a.z - b.z);

  // A cell is fillable if it rests on solid or on an already-filled cell below.
  const supported = new Set<string>();
  for (const c of ordered) {
    const below = key(c.x, c.y - 1, c.z);
    if (isSolid(c.x, c.y - 1, c.z) || supported.has(below)) supported.add(c.k);
  }
  const candidates = ordered.filter((c) => supported.has(c.k));

  const result = new Set(water);
  for (const k of localBody) result.delete(k);
  for (const c of candidates.slice(0, target)) result.add(c.k);
  return result;
}
