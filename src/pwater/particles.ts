// Clean-room particle water solver (position-based fluids).
// Universal rules ONLY: gravity, incompressibility (pressure via density
// constraint), momentum (velocity from positions), viscosity/friction,
// terrain + wall boundaries, explicit sources, open-boundary drainage.
// Lakes, rivers, waterfalls, and underwater streams must EMERGE from these.
// No phenomenon-specific targets, no scripted levels, no terrain exceptions.

export type ScenarioName = "basin-spill" | "crack-drain" | "terraces";

export interface SimOptions {
  emitRate: number; // particles per second at the source
  viscosity: number; // XSPH coefficient (0..0.4)
  sleep?: boolean; // freeze settled particles (default true)
  evaporation?: boolean; // exposed-surface evaporation (default true)
}

export interface Report {
  tick: number;
  count: number;
  emitted: number;
  drained: number;
  evaporated: number;
  error: number; // emitted - drained - evaporated - count; exact 0 by construction
  outflowPerSec: number;
  meanSpeed: number;
  maxSpeed: number;
  surfaceSpread: number; // std-dev of basin surface heights (cells)
  basinSurfaceY: number; // mean basin surface height (cells, -1 if empty)
  capped: boolean;
  asleep: number; // frozen particles (boundary support only, zero solve cost)
  solved: number; // particles in the last pressure solve (awake + interface)
}

export interface Terrain {
  nx: number;
  ny: number;
  nz: number;
  solid: Uint8Array;
  source: [number, number, number];
  basin: { x0: number; x1: number; z0: number; z1: number };
  rimY: number;
  // Which lateral bounds are open drains. Sandbox scenarios use "px" (+X edge
  // only). TinyWorld crops use "all": water leaving the sim box on any side
  // is culled (matches the CA's edge-cull), never piles on invisible walls.
  open?: "px" | "all";
}

// Base particle geometry at scale 1. Fine mode shrinks these uniformly via
// setParticleScale(); every derived constant below recomputes with it. The
// scale must only change between sims (rho0, buffers, and the hash grid are
// built at construction) — the page applies it inside the reset path.
const BASE_D = 0.6;
const BASE_H = 1.2;
const BASE_R = 0.28;
// 10000 (sandbox shipped 6000): TinyWorld basins are bigger than the sandbox
// scenarios — the slope bed needs ~16k particles at the 70% tier just to
// reach its lip, and a cap hit STOPS the source (reads as "water stopped
// spawning"). Headroom lets the overtop river find equilibrium first.
const BASE_MAX_N = 10000;
let D = BASE_D; // rest particle spacing (cells)
let H = BASE_H; // kernel radius
let R = BASE_R; // contact radius vs terrain
const GRAV = -28; // cells / s^2
const SUBSTEPS = 2;
const ITERS = 3;
let MAX_N = BASE_MAX_N;
const KILL_Y = -8;
const SCORR_K = 0.08;
const SCORR_N = 4;
const CFM_EPS = 1e-4;
// A pressure correction is a push, never a teleport: one solver iteration may
// move a particle at most DP_MAX. Deep overlap (e.g. mass appearing inside
// dense fluid) then resolves over several substeps as a bounded shove chain
// instead of one giant dp that the velocity update turns into a launch.
let DP_MAX = 0.1 * H; // per-iteration; x ITERS x SUBSTEPS = 0.72 cells/frame max
// Source back-pressure: a submerged mouth reads ~rho0 (incompressible), so
// the gate sits ABOVE rest — the spring keeps feeding a covered mouth, and
// only genuine compression (mass injected faster than the clamped solver can
// relax it outward) retains inflow in the accumulator. Relaxation of that
// compression is exactly the pool being pushed up, so submerged inflow
// becomes rate-limited by pressure, not blocked.
const EMIT_RHO_GATE = 1.25; // fraction of rho0 above which the mouth is compressed
// Evaporation — a universal air-boundary rule: water leaves through exposed
// surface. Exposure is inferred from the neighborhood: a buried or lake-bulk
// particle (nb >= EVAP_NB) has ~no exposed surface and never evaporates; an
// isolated droplet stranded on dry ground is ALL surface and evaporates in
// ~1/EVAP_RATE seconds. Progress resorbs while a particle is submerged, so
// recycling spray doesn't slowly eat the pool. Neighbor counts are
// scale-invariant, so this needs no per-scale tuning. Ledger stays exact:
// emitted - drained - evaporated - count = 0.
const EVAP_RATE = 1 / 20; // fully exposed droplet lifetime ~20s
const EVAP_NB = 12; // neighbors at/above which exposure reads zero
const BOUND_FRICTION = 0.985;
const NB_STRIDE = 128; // cached neighbors per particle (~33 at rest density)

// Sleeping: a settled particle freezes (no integrate, no solve) but stays in
// the grid as density/boundary support. It wakes when disturbed. This is a
// pure compute optimization — sleep can only trigger where nothing is moving,
// so behavior stays emergent (a sleeper is woken before anything reaches it).
// Stillness is POSITIONAL, not velocity-based: PBF rest jiggle oscillates in
// place at speeds that never settle, so we sleep a particle that stays inside
// a small anchor radius for SLEEP_TICKS. Real creep exits the radius and
// resets the anchor; jiggle does not.
let STILL_R2 = Math.pow(0.15 * D, 2); // anchor radius for "hasn't moved"
const SLEEP_TICKS = 30; // buried particles: in-anchor ticks before freezing
// Free-surface particles need much longer stillness: an actively-fed heap must
// keep creeping level (freezing its crust builds frozen mounds); only a truly
// settled surface earns sleep. Buried = dense neighborhood.
const SLEEP_TICKS_SURF = 300;
// Buried = FULLY surrounded (rest-lattice count inside H is ~33). At 22 the
// layer right under the surface crust counted as buried and fast-froze while
// the pool was still filling, locking the center heap in place — the surface
// dome over the spring. At 30 only genuinely deep bulk fast-sleeps;
// near-surface particles need the long surface stillness, so a changing
// level keeps its whole surface region fluid and hydrostatic leveling works.
// Measured (basin-spill, 120/s): active-fill dome 0.70 -> 0.52 cells,
// post-inflow dome 0.20 -> 0.04 (flat), settled step cost unchanged.
const BURIED_N = 30; // neighbor count above which a particle counts as buried
const WAKE_SPEED = 4.0; // a neighbor moving faster than this wakes a sleeper
let WAKE_DP2 = Math.pow(0.03 * D, 2); // instant pressure shove that force-wakes
// Persistent-pressure wake: small sub-shove displacements on a frozen boundary
// accumulate (leaky integrator); sustained imbalance wakes the sleeper so
// pressure waves can propagate THROUGH sleeping bulk (a filling pool levels
// hydrostatically instead of crawling over a frozen lid). One-off solver noise
// decays away and never wakes anything.
const SHOVE_DECAY = 0.9;
let SHOVE_WAKE = 0.09 * D; // steady dp > ~0.9% of spacing wakes in ~10 substeps
let SRC_R2 = Math.pow(2.5 * H, 2); // awake radius around an EMITTING source

let H2 = H * H;
let POLY6 = 315 / (64 * Math.PI * Math.pow(H, 9));
let SPIKY = -45 / (Math.PI * Math.pow(H, 6));

export let PARTICLE_SCALE = 1;

// Particle cap a given scale would use — lets the page pre-size GPU buffers
// for the finest mode it offers before any toggle happens.
export function maxParticlesAtScale(scale: number): number {
  return Math.round(BASE_MAX_N / (scale * scale * scale));
}

// Uniform rescale of the particle geometry (drop size). All physics is
// scale-similar in cell space — terrain cells, gravity, and speeds are
// unchanged; only the fluid's sampling resolution changes. MAX_N grows as
// 1/scale^3 so the same water VOLUME fits at any scale. Call only between
// sims (the page's reset path); a live sim built at another scale would read
// mismatched kernels.
export function setParticleScale(scale: number): void {
  PARTICLE_SCALE = scale;
  D = BASE_D * scale;
  H = BASE_H * scale;
  R = BASE_R * scale;
  MAX_N = Math.round(BASE_MAX_N / (scale * scale * scale));
  DP_MAX = 0.1 * H;
  STILL_R2 = Math.pow(0.15 * D, 2);
  WAKE_DP2 = Math.pow(0.03 * D, 2);
  SHOVE_WAKE = 0.09 * D;
  SRC_R2 = Math.pow(2.5 * H, 2);
  H2 = H * H;
  POLY6 = 315 / (64 * Math.PI * Math.pow(H, 9));
  SPIKY = -45 / (Math.PI * Math.pow(H, 6));
  SIM_CONSTANTS.D = D;
  SIM_CONSTANTS.H = H;
  SIM_CONSTANTS.R = R;
  SIM_CONSTANTS.MAX_N = MAX_N;
}

function poly6(r2: number): number {
  if (r2 >= H2) return 0;
  const t = H2 - r2;
  return POLY6 * t * t * t;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- terrain ---

function buildTerrain(name: ScenarioName): Terrain {
  const nx = 48;
  const ny = 26;
  const nz = 28;
  const zc = nz / 2;
  const height = new Float32Array(nx * nz);
  const at = (x: number, z: number) => height[z * nx + x];
  const set = (x: number, z: number, v: number) => {
    height[z * nx + x] = v;
  };

  const carveBowl = (cx: number, cz: number, rad: number, floor: number) => {
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (d < rad) {
          const t = 1 - d / rad;
          const s = t * t * (3 - 2 * t);
          set(x, z, Math.min(at(x, z), 16 - s * (16 - floor)));
        }
      }
  };

  let source: [number, number, number] = [11, 10, zc];
  let basin = { x0: 4, x1: 18, z0: Math.floor(zc - 8), z1: Math.ceil(zc + 8) };
  let rimY = 16;

  if (name === "basin-spill" || name === "crack-drain") {
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        let hgt: number;
        if (x <= 20) hgt = 16;
        else if (x <= 42) hgt = 16 - ((x - 20) / 22) * 12;
        else hgt = 4 - (x - 42);
        set(x, z, Math.max(1, hgt));
      }
    carveBowl(11, zc, 8.5, 8);
    // channel: a walled strip that descends monotonically from the rim gap to
    // the open edge; outside the strip the plateau shoulder walls it in
    const chTop = name === "basin-spill" ? 13 : 9;
    for (let z = 0; z < nz; z++)
      for (let x = 21; x < nx; x++) {
        const inChannel = Math.abs(z + 0.5 - zc) <= 2.5;
        if (!inChannel) set(x, z, Math.min(16, at(x, z) + 4));
        else if (x <= 42) set(x, z, Math.min(at(x, z), Math.max(1, chTop - ((x - 21) / 21) * (chTop - 3))));
      }
    if (name === "basin-spill") {
      for (let x = 17; x <= 21; x++)
        for (let z = Math.floor(zc - 1.5); z <= Math.ceil(zc + 0.5); z++)
          set(x, z, Math.min(at(x, z), 13));
      rimY = 13;
    }
  } else {
    const steps = [
      { x0: 0, x1: 10, floor: 18, lip: 20 },
      { x0: 10, x1: 20, floor: 13, lip: 15 },
      { x0: 20, x1: 30, floor: 8, lip: 10 },
      { x0: 30, x1: 40, floor: 4, lip: 6 },
    ];
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        // beyond the last step the world falls away — cascades pour off the
        // cliff and free-fall past the kill plane (the open drain)
        if (x >= 40) {
          set(x, z, 0);
          continue;
        }
        const s = steps.find((s) => x >= s.x0 && x < s.x1)!;
        const nearWall = Math.abs(z + 0.5 - zc) > 4;
        const isLip = x >= s.x1 - 2 && s.lip > s.floor;
        let hgt = isLip ? s.lip : s.floor;
        if (nearWall) hgt += 6;
        set(x, z, Math.min(24, hgt));
      }
    source = [4, 19, zc];
    basin = { x0: 0, x1: 8, z0: Math.floor(zc - 6), z1: Math.ceil(zc + 6) };
    rimY = 20;
  }

  const solid = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const hgt = Math.round(at(x, z));
      for (let y = 0; y < Math.min(ny, hgt); y++) solid[(y * nz + z) * nx + x] = 1;
    }

  if (name === "crack-drain") {
    // a submerged crack through the rim, its top well below the rim (y16): an
    // underwater drain from the bowl into the walled canyon. Sized so it passes
    // the full inflow with the lake settling BELOW the rim — the outlet, not the
    // rim, sets the equilibrium level.
    for (let x = 13; x <= 22; x++)
      for (let y = 9; y <= 12; y++)
        for (let z = Math.floor(zc - 2); z <= Math.floor(zc + 1); z++)
          solid[(y * nz + z) * nx + x] = 0;
  }

  return { nx, ny, nz, solid, source, basin, rimY };
}

// ------------------------------------------------------------------ solver ---

export class Sim {
  readonly scenario: ScenarioName;
  readonly terrain: Terrain;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly speed: Float32Array;
  readonly asleep: Uint8Array;
  count = 0;
  emitted = 0;
  drained = 0;
  evaporated = 0;
  tick = 0;
  capped = false;
  asleepCount = 0;
  solvedCount = 0;
  // Diagnostic: how often a particle's center ended up INSIDE a solid cell
  // (contact-shell tunneling — possible when travel/substep exceeds R).
  tunnelHits = 0;

  private prev: Float32Array;
  private lambda: Float32Array;
  private dp: Float32Array;
  private contact: Uint8Array;
  private stillTicks: Uint16Array;
  private anchor: Float32Array;
  private shove: Float32Array;
  private evap: Float32Array;
  readonly nbCount: Uint16Array;
  private interfaceFlag: Uint8Array;
  private active: Int32Array;
  private rho0: number;
  private rng: () => number;
  private emitAcc = 0;
  private drainWindow = new Int16Array(60);

  private gnx: number;
  private gny: number;
  private gnz: number;
  private cellOf: Int32Array;
  private cellStart: Int32Array;
  private cellCount: Int32Array;
  private sorted: Int32Array;
  // Neighbor cache: each grid walk is ~16x more expensive than reading the
  // result back, and the solve reads the same neighborhood up to 8x per
  // substep (wake + ITERS x 2 + viscosity). Lists are found once per particle
  // per grid epoch (= substep) and reused — the standard PBF discipline
  // (Macklin & Muller find neighbors once per step). Fixed stride per
  // particle; at rest density a particle has ~33 neighbors inside H, so 128
  // never truncates in practice.
  private nbrList: Int32Array;
  private nbrLen: Int32Array;
  private nbrStamp: Int32Array;
  private gridEpoch = 0;

  constructor(scenario: ScenarioName, seed = 1337, terrain?: Terrain) {
    this.scenario = scenario;
    this.terrain = terrain ?? buildTerrain(scenario);
    this.rng = mulberry32(seed);
    this.pos = new Float32Array(MAX_N * 3);
    this.vel = new Float32Array(MAX_N * 3);
    this.speed = new Float32Array(MAX_N);
    this.prev = new Float32Array(MAX_N * 3);
    this.lambda = new Float32Array(MAX_N);
    this.dp = new Float32Array(MAX_N * 3);
    this.contact = new Uint8Array(MAX_N);
    this.asleep = new Uint8Array(MAX_N);
    this.stillTicks = new Uint16Array(MAX_N);
    this.anchor = new Float32Array(MAX_N * 3);
    this.shove = new Float32Array(MAX_N);
    this.evap = new Float32Array(MAX_N);
    this.nbCount = new Uint16Array(MAX_N);
    this.interfaceFlag = new Uint8Array(MAX_N);
    this.active = new Int32Array(MAX_N);
    this.nbrList = new Int32Array(MAX_N * NB_STRIDE);
    this.nbrLen = new Int32Array(MAX_N);
    this.nbrStamp = new Int32Array(MAX_N).fill(-1);

    let rho = 0;
    const span = Math.ceil(H / D);
    for (let ix = -span; ix <= span; ix++)
      for (let iy = -span; iy <= span; iy++)
        for (let iz = -span; iz <= span; iz++) {
          const r2 = (ix * ix + iy * iy + iz * iz) * D * D;
          rho += poly6(r2);
        }
    this.rho0 = rho;

    const t = this.terrain;
    this.gnx = Math.ceil((t.nx + 8) / H);
    this.gny = Math.ceil((t.ny + 14 - KILL_Y) / H);
    this.gnz = Math.ceil(t.nz / H);
    const cells = this.gnx * this.gny * this.gnz;
    this.cellOf = new Int32Array(MAX_N);
    this.cellStart = new Int32Array(cells + 1);
    this.cellCount = new Int32Array(cells);
    this.sorted = new Int32Array(MAX_N);
  }

  private solidAt(x: number, y: number, z: number): boolean {
    const t = this.terrain;
    if (x < 0 || x >= t.nx || z < 0 || z >= t.nz || y < 0 || y >= t.ny) return false;
    return t.solid[(y * t.nz + z) * t.nx + x] === 1;
  }

  private gridIndex(px: number, py: number, pz: number): number {
    let cx = Math.floor(px / H);
    let cy = Math.floor((py - KILL_Y) / H);
    let cz = Math.floor(pz / H);
    cx = cx < 0 ? 0 : cx >= this.gnx ? this.gnx - 1 : cx;
    cy = cy < 0 ? 0 : cy >= this.gny ? this.gny - 1 : cy;
    cz = cz < 0 ? 0 : cz >= this.gnz ? this.gnz - 1 : cz;
    return (cy * this.gnz + cz) * this.gnx + cx;
  }

  private rebuildGrid() {
    this.gridEpoch++;
    this.cellCount.fill(0);
    for (let i = 0; i < this.count; i++) {
      const c = this.gridIndex(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.cellOf[i] = c;
      this.cellCount[c]++;
    }
    let acc = 0;
    for (let c = 0; c < this.cellCount.length; c++) {
      this.cellStart[c] = acc;
      acc += this.cellCount[c];
      this.cellCount[c] = 0;
    }
    this.cellStart[this.cellCount.length] = acc;
    for (let i = 0; i < this.count; i++) {
      const c = this.cellOf[i];
      this.sorted[this.cellStart[c] + this.cellCount[c]++] = i;
    }
  }

  // Returns the neighbor count; the list lives at nbrList[i*NB_STRIDE ..].
  // Cached per grid epoch: repeat calls within a substep are free.
  private gatherNeighbors(i: number): number {
    if (this.nbrStamp[i] === this.gridEpoch) return this.nbrLen[i];
    const px = this.pos[i * 3];
    const py = this.pos[i * 3 + 1];
    const pz = this.pos[i * 3 + 2];
    const base = i * NB_STRIDE;
    let n = 0;
    const cx = Math.floor(px / H);
    const cy = Math.floor((py - KILL_Y) / H);
    const cz = Math.floor(pz / H);
    outer: for (let dy = -1; dy <= 1; dy++) {
      const gy = cy + dy;
      if (gy < 0 || gy >= this.gny) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= this.gnz) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= this.gnx) continue;
          const c = (gy * this.gnz + gz) * this.gnx + gx;
          const s0 = this.cellStart[c];
          const s1 = this.cellStart[c + 1];
          for (let s = s0; s < s1; s++) {
            const j = this.sorted[s];
            if (j === i) continue;
            const rx = px - this.pos[j * 3];
            const ry = py - this.pos[j * 3 + 1];
            const rz = pz - this.pos[j * 3 + 2];
            if (rx * rx + ry * ry + rz * rz < H2) {
              this.nbrList[base + n++] = j;
              if (n >= NB_STRIDE) break outer;
            }
          }
        }
      }
    }
    this.nbrStamp[i] = this.gridEpoch;
    this.nbrLen[i] = n;
    return n;
  }

  // Predicted density a particle would have if spawned at (px,py,pz): its own
  // self-term plus kernel contributions from existing particles (last-built
  // grid; stale by < a fraction of H) and from same-tick spawns not yet in the
  // grid (indices sinceIdx..count). Used by the emitter's back-pressure gate.
  private spawnDensityAt(px: number, py: number, pz: number, sinceIdx: number): number {
    let rho = poly6(0);
    const cx = Math.floor(px / H);
    const cy = Math.floor((py - KILL_Y) / H);
    const cz = Math.floor(pz / H);
    for (let dy = -1; dy <= 1; dy++) {
      const gy = cy + dy;
      if (gy < 0 || gy >= this.gny) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= this.gnz) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= this.gnx) continue;
          const c = (gy * this.gnz + gz) * this.gnx + gx;
          const s0 = this.cellStart[c];
          const s1 = this.cellStart[c + 1];
          for (let s = s0; s < s1; s++) {
            const j = this.sorted[s];
            if (j >= sinceIdx) continue;
            const jb = j * 3;
            const rx = px - this.pos[jb];
            const ry = py - this.pos[jb + 1];
            const rz = pz - this.pos[jb + 2];
            rho += poly6(rx * rx + ry * ry + rz * rz);
          }
        }
      }
    }
    for (let j = sinceIdx; j < this.count; j++) {
      const jb = j * 3;
      const rx = px - this.pos[jb];
      const ry = py - this.pos[jb + 1];
      const rz = pz - this.pos[jb + 2];
      rho += poly6(rx * rx + ry * ry + rz * rz);
    }
    return rho;
  }

  // Read-only flow query at an arbitrary point, for cosmetic systems (foam
  // sprites) that ride the fluid. Never feeds back into physics. Writes
  // [vx, vy, vz, support, topY] into out: kernel-weighted fluid velocity,
  // total kernel weight (0 = no fluid here), and the local free-surface
  // height (max particle top within ~0.7H horizontally).
  sampleFlow(px: number, py: number, pz: number, out: Float32Array) {
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let wsum = 0;
    let topY = -Infinity;
    const rh2 = 0.7 * H * 0.7 * H;
    const cx = Math.floor(px / H);
    const cy = Math.floor((py - KILL_Y) / H);
    const cz = Math.floor(pz / H);
    for (let dy = -1; dy <= 1; dy++) {
      const gy = cy + dy;
      if (gy < 0 || gy >= this.gny) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= this.gnz) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= this.gnx) continue;
          const c = (gy * this.gnz + gz) * this.gnx + gx;
          const s1 = this.cellStart[c + 1];
          for (let s = this.cellStart[c]; s < s1; s++) {
            const j = this.sorted[s];
            const jb = j * 3;
            const rx = px - this.pos[jb];
            const ry = py - this.pos[jb + 1];
            const rz = pz - this.pos[jb + 2];
            const r2 = rx * rx + ry * ry + rz * rz;
            if (r2 >= H2) continue;
            const w = 1 - r2 / H2;
            vx += this.vel[jb] * w;
            vy += this.vel[jb + 1] * w;
            vz += this.vel[jb + 2] * w;
            wsum += w;
            if (rx * rx + rz * rz < rh2 && this.pos[jb + 1] > topY) topY = this.pos[jb + 1];
          }
        }
      }
    }
    if (wsum > 0) {
      vx /= wsum;
      vy /= wsum;
      vz /= wsum;
    }
    out[0] = vx;
    out[1] = vy;
    out[2] = vz;
    out[3] = wsum;
    out[4] = topY;
  }

  private collide(i: number) {
    const b = i * 3;
    let px = this.pos[b];
    let py = this.pos[b + 1];
    let pz = this.pos[b + 2];
    const t = this.terrain;

    if (px < R) {
      px = R;
      this.contact[i] = 1;
    }
    if (pz < R) {
      pz = R;
      this.contact[i] = 1;
    }
    if (pz > t.nz - R) {
      pz = t.nz - R;
      this.contact[i] = 1;
    }
    // +x face is OPEN (drain edge): no wall.

    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const cz = Math.floor(pz);
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const vx = cx + dx;
          const vy = cy + dy;
          const vz = cz + dz;
          if (!this.solidAt(vx, vy, vz)) continue;
          const qx = px < vx ? vx : px > vx + 1 ? vx + 1 : px;
          const qy = py < vy ? vy : py > vy + 1 ? vy + 1 : py;
          const qz = pz < vz ? vz : pz > vz + 1 ? vz + 1 : pz;
          const ox = px - qx;
          const oy = py - qy;
          const oz = pz - qz;
          const d2 = ox * ox + oy * oy + oz * oz;
          if (d2 >= R * R) continue;
          this.contact[i] = 1;
          if (d2 > 1e-12) {
            const d = Math.sqrt(d2);
            const push = (R - d) / d;
            px += ox * push;
            py += oy * push;
            pz += oz * push;
          } else {
            this.tunnelHits++;
            // Center is INSIDE the cell. At fine drop scales the contact
            // shell R is thinner than one substep's travel, so a fast drop
            // can cross it in a single step. Resolve to the face the segment
            // prev->pos entered through — bounded by the real penetration.
            // The old cell-top snap could teleport up to a full cell and the
            // position-based velocity update turned that into launch speed.
            const ex = this.prev[b];
            const ey = this.prev[b + 1];
            const ez = this.prev[b + 2];
            const mx = px - ex;
            const my = py - ey;
            const mz = pz - ez;
            let tBest = -1;
            let axis = -1;
            let side = 0;
            if (mx > 1e-9 && ex <= vx) { const tt = (vx - ex) / mx; if (tt > tBest) { tBest = tt; axis = 0; side = -1; } }
            if (mx < -1e-9 && ex >= vx + 1) { const tt = (vx + 1 - ex) / mx; if (tt > tBest) { tBest = tt; axis = 0; side = 1; } }
            if (my > 1e-9 && ey <= vy) { const tt = (vy - ey) / my; if (tt > tBest) { tBest = tt; axis = 1; side = -1; } }
            if (my < -1e-9 && ey >= vy + 1) { const tt = (vy + 1 - ey) / my; if (tt > tBest) { tBest = tt; axis = 1; side = 1; } }
            if (mz > 1e-9 && ez <= vz) { const tt = (vz - ez) / mz; if (tt > tBest) { tBest = tt; axis = 2; side = -1; } }
            if (mz < -1e-9 && ez >= vz + 1) { const tt = (vz + 1 - ez) / mz; if (tt > tBest) { tBest = tt; axis = 2; side = 1; } }
            if (axis === 0) px = side < 0 ? vx - R : vx + 1 + R;
            else if (axis === 1) py = side < 0 ? vy - R : vy + 1 + R;
            else if (axis === 2) pz = side < 0 ? vz - R : vz + 1 + R;
            else {
              // prev was inside too (chained solver pushes): legacy top snap,
              // but cancel the implied velocity so it can't read as a launch.
              py = vy + 1 + R;
              this.prev[b + 1] = py;
            }
          }
        }

    this.pos[b] = px;
    this.pos[b + 1] = py;
    this.pos[b + 2] = pz;
  }

  private emit(dt: number, rate: number) {
    // rate is VOLUME flux in base-sized drops/s: a scaled drop carries
    // scale^3 of the water, so finer sims emit proportionally more particles
    // and the waterfall carries the same physical mass at any drop size.
    this.emitAcc += (rate / (PARTICLE_SCALE * PARTICLE_SCALE * PARTICLE_SCALE)) * dt;
    const t = this.terrain;
    const sinceIdx = this.count;
    const gate = EMIT_RHO_GATE * this.rho0;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      if (this.count >= MAX_N) {
        this.capped = true;
        this.emitAcc = 0;
        return;
      }
      const ang = this.rng() * Math.PI * 2;
      const rad = Math.sqrt(this.rng()) * 0.9;
      const px = t.source[0] + Math.cos(ang) * rad;
      const py = t.source[1] + this.rng() * 1.2;
      const pz = t.source[2] + Math.sin(ang) * rad;
      // Back-pressure: a full mouth accepts no mass this tick; the retained
      // inflow stays in emitAcc and flows out as the pool makes room. The
      // gate self-limits any later release — each spawn raises mouth density.
      if (this.spawnDensityAt(px, py, pz, sinceIdx) >= gate) {
        this.emitAcc += 1;
        return;
      }
      const i = this.count++;
      const b = i * 3;
      this.pos[b] = px;
      this.pos[b + 1] = py;
      this.pos[b + 2] = pz;
      this.vel[b] = 0;
      this.vel[b + 1] = -2;
      this.vel[b + 2] = 0;
      this.asleep[i] = 0;
      this.stillTicks[i] = 0;
      this.evap[i] = 0;
      this.anchor[b] = this.pos[b];
      this.anchor[b + 1] = this.pos[b + 1];
      this.anchor[b + 2] = this.pos[b + 2];
      this.emitted++;
    }
  }

  private removeAt(i: number) {
    const b = i * 3;
    const last = --this.count;
    const lb = last * 3;
    this.pos[b] = this.pos[lb];
    this.pos[b + 1] = this.pos[lb + 1];
    this.pos[b + 2] = this.pos[lb + 2];
    this.vel[b] = this.vel[lb];
    this.vel[b + 1] = this.vel[lb + 1];
    this.vel[b + 2] = this.vel[lb + 2];
    this.speed[i] = this.speed[last];
    this.asleep[i] = this.asleep[last];
    this.stillTicks[i] = this.stillTicks[last];
    this.shove[i] = this.shove[last];
    this.evap[i] = this.evap[last];
    this.nbCount[i] = this.nbCount[last];
    this.anchor[b] = this.anchor[lb];
    this.anchor[b + 1] = this.anchor[lb + 1];
    this.anchor[b + 2] = this.anchor[lb + 2];
  }

  private drain() {
    const t = this.terrain;
    const all = t.open === "all";
    let removed = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const b = i * 3;
      const px = this.pos[b];
      const py = this.pos[b + 1];
      const pz = this.pos[b + 2];
      if (py > KILL_Y && px < t.nx + 6 && (!all || (px > -6 && pz > -6 && pz < t.nz + 6))) continue;
      this.removeAt(i);
      this.drained++;
      removed++;
    }
    this.drainWindow[this.tick % 60] = removed;
  }

  // Exposed-surface evaporation (see EVAP_RATE above). Runs once per step
  // over every particle, awake or asleep — a stray frozen on dry ground
  // keeps its frozen (isolated) neighbor count and evaporates away, while
  // buried bulk reads zero exposure and only resorbs.
  private evaporate(dt: number) {
    for (let i = this.count - 1; i >= 0; i--) {
      const x = 1 - this.nbCount[i] / EVAP_NB;
      if (x <= 0) {
        const e = this.evap[i] - dt * EVAP_RATE;
        this.evap[i] = e > 0 ? e : 0;
        continue;
      }
      this.evap[i] += dt * EVAP_RATE * x;
      if (this.evap[i] < 1) continue;
      this.removeAt(i);
      this.evaporated++;
    }
  }

  step(dt: number, opts: SimOptions) {
    const sleepOn = opts.sleep !== false;
    if (!sleepOn && this.asleepCount > 0) {
      this.asleep.fill(0, 0, this.count);
      this.stillTicks.fill(0, 0, this.count);
      this.asleepCount = 0;
    }
    this.emit(dt, Math.max(0, opts.emitRate));
    const sdt = dt / SUBSTEPS;
    const vmax = (0.45 * H) / sdt;
    const wq = poly6(0.2 * H * 0.2 * H);
    const visc = Math.max(0, Math.min(0.4, opts.viscosity));

    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (let i = 0; i < this.count; i++) {
        if (this.asleep[i]) continue;
        const b = i * 3;
        this.vel[b + 1] += GRAV * sdt;
        let vx = this.vel[b];
        let vy = this.vel[b + 1];
        let vz = this.vel[b + 2];
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (sp > vmax) {
          const s = vmax / sp;
          vx *= s;
          vy *= s;
          vz *= s;
          this.vel[b] = vx;
          this.vel[b + 1] = vy;
          this.vel[b + 2] = vz;
        }
        this.prev[b] = this.pos[b];
        this.prev[b + 1] = this.pos[b + 1];
        this.prev[b + 2] = this.pos[b + 2];
        this.pos[b] += vx * sdt;
        this.pos[b + 1] += vy * sdt;
        this.pos[b + 2] += vz * sdt;
        this.contact[i] = 0;
      }

      this.rebuildGrid();

      // Wake / interface marking: a fast awake particle wakes sleeping
      // neighbors; a slow one marks them as interface — they join the pressure
      // solve as frozen boundaries and wake only if genuinely shoved.
      this.interfaceFlag.fill(0, 0, this.count);
      if (this.asleepCount > 0) {
        for (let i = 0; i < this.count; i++) {
          if (this.asleep[i]) continue;
          const nn = this.gatherNeighbors(i);
          const nbase = i * NB_STRIDE;
          const fast = this.speed[i] > WAKE_SPEED;
          for (let k = 0; k < nn; k++) {
            const j = this.nbrList[nbase + k];
            if (!this.asleep[j]) continue;
            if (fast) {
              const jb = j * 3;
              this.asleep[j] = 0;
              this.stillTicks[j] = 0;
              this.shove[j] = 0;
              this.contact[j] = 0;
              this.prev[jb] = this.pos[jb];
              this.prev[jb + 1] = this.pos[jb + 1];
              this.prev[jb + 2] = this.pos[jb + 2];
            } else {
              this.interfaceFlag[j] = 1;
            }
          }
        }
      }
      let nActive = 0;
      for (let i = 0; i < this.count; i++)
        if (!this.asleep[i] || this.interfaceFlag[i]) this.active[nActive++] = i;
      this.solvedCount = nActive;

      for (let iter = 0; iter < ITERS; iter++) {
        for (let a = 0; a < nActive; a++) {
          const i = this.active[a];
          const nn = this.gatherNeighbors(i);
          const nbase = i * NB_STRIDE;
          if (iter === 0) this.nbCount[i] = nn;
          const b = i * 3;
          const px = this.pos[b];
          const py = this.pos[b + 1];
          const pz = this.pos[b + 2];
          let rho = poly6(0);
          let sumGrad2 = 0;
          let gx = 0;
          let gy = 0;
          let gz = 0;
          for (let k = 0; k < nn; k++) {
            const j = this.nbrList[nbase + k];
            const jb = j * 3;
            const rx = px - this.pos[jb];
            const ry = py - this.pos[jb + 1];
            const rz = pz - this.pos[jb + 2];
            const r2 = rx * rx + ry * ry + rz * rz;
            rho += poly6(r2);
            const r = Math.sqrt(r2);
            if (r > 1e-9 && r < H) {
              const gmag = (SPIKY * (H - r) * (H - r)) / (r * this.rho0);
              const ggx = gmag * rx;
              const ggy = gmag * ry;
              const ggz = gmag * rz;
              gx += ggx;
              gy += ggy;
              gz += ggz;
              sumGrad2 += ggx * ggx + ggy * ggy + ggz * ggz;
            }
          }
          sumGrad2 += gx * gx + gy * gy + gz * gz;
          const C = rho / this.rho0 - 1;
          this.lambda[i] = C > 0 ? -C / (sumGrad2 + CFM_EPS) : 0;
        }

        for (let a = 0; a < nActive; a++) {
          const i = this.active[a];
          const nn = this.gatherNeighbors(i);
          const nbase = i * NB_STRIDE;
          const b = i * 3;
          const px = this.pos[b];
          const py = this.pos[b + 1];
          const pz = this.pos[b + 2];
          let dx = 0;
          let dy = 0;
          let dz = 0;
          for (let k = 0; k < nn; k++) {
            const j = this.nbrList[nbase + k];
            const jb = j * 3;
            const rx = px - this.pos[jb];
            const ry = py - this.pos[jb + 1];
            const rz = pz - this.pos[jb + 2];
            const r2 = rx * rx + ry * ry + rz * rz;
            const r = Math.sqrt(r2);
            if (r <= 1e-9 || r >= H) continue;
            const ratio = poly6(r2) / wq;
            const scorr = -SCORR_K * ratio * ratio * ratio * ratio;
            const gmag = (SPIKY * (H - r) * (H - r)) / (r * this.rho0);
            const s = this.lambda[i] + this.lambda[j] + scorr;
            dx += s * gmag * rx;
            dy += s * gmag * ry;
            dz += s * gmag * rz;
          }
          this.dp[b] = dx;
          this.dp[b + 1] = dy;
          this.dp[b + 2] = dz;
        }

        for (let a = 0; a < nActive; a++) {
          const i = this.active[a];
          const b = i * 3;
          const dpm2 =
            this.dp[b] * this.dp[b] + this.dp[b + 1] * this.dp[b + 1] + this.dp[b + 2] * this.dp[b + 2];
          if (dpm2 > DP_MAX * DP_MAX) {
            const cs = DP_MAX / Math.sqrt(dpm2);
            this.dp[b] *= cs;
            this.dp[b + 1] *= cs;
            this.dp[b + 2] *= cs;
          }
          if (this.asleep[i]) {
            // frozen boundary: an instant shove OR sustained pressure wakes it
            const m2 =
              this.dp[b] * this.dp[b] + this.dp[b + 1] * this.dp[b + 1] + this.dp[b + 2] * this.dp[b + 2];
            if (m2 <= WAKE_DP2) {
              this.shove[i] = this.shove[i] * SHOVE_DECAY + Math.sqrt(m2);
              if (this.shove[i] <= SHOVE_WAKE) continue;
            }
            this.asleep[i] = 0;
            this.stillTicks[i] = 0;
            this.shove[i] = 0;
            this.contact[i] = 0;
            this.prev[b] = this.pos[b];
            this.prev[b + 1] = this.pos[b + 1];
            this.prev[b + 2] = this.pos[b + 2];
          }
          this.pos[b] += this.dp[b];
          this.pos[b + 1] += this.dp[b + 1];
          this.pos[b + 2] += this.dp[b + 2];
          this.collide(i);
        }
      }

      for (let i = 0; i < this.count; i++) {
        if (this.asleep[i]) continue;
        const b = i * 3;
        let vx = (this.pos[b] - this.prev[b]) / sdt;
        let vy = (this.pos[b + 1] - this.prev[b + 1]) / sdt;
        let vz = (this.pos[b + 2] - this.prev[b + 2]) / sdt;
        if (this.contact[i]) {
          vx *= BOUND_FRICTION;
          vy *= BOUND_FRICTION;
          vz *= BOUND_FRICTION;
        }
        this.vel[b] = vx;
        this.vel[b + 1] = vy;
        this.vel[b + 2] = vz;
      }

      if (visc > 0) {
        // reuses the substep's cached neighbor lists (positions drift less
        // than a fraction of H within a substep; XSPH is a smoothing term)
        for (let i = 0; i < this.count; i++) {
          if (this.asleep[i]) continue;
          const nn = this.gatherNeighbors(i);
          const nbase = i * NB_STRIDE;
          const b = i * 3;
          let ax = 0;
          let ay = 0;
          let az = 0;
          for (let k = 0; k < nn; k++) {
            const j = this.nbrList[nbase + k];
            const jb = j * 3;
            const rx = this.pos[b] - this.pos[jb];
            const ry = this.pos[b + 1] - this.pos[jb + 1];
            const rz = this.pos[b + 2] - this.pos[jb + 2];
            const w = poly6(rx * rx + ry * ry + rz * rz) / this.rho0;
            ax += (this.vel[jb] - this.vel[b]) * w;
            ay += (this.vel[jb + 1] - this.vel[b + 1]) * w;
            az += (this.vel[jb + 2] - this.vel[b + 2]) * w;
          }
          this.dp[b] = ax;
          this.dp[b + 1] = ay;
          this.dp[b + 2] = az;
        }
        for (let i = 0; i < this.count; i++) {
          if (this.asleep[i]) continue;
          const b = i * 3;
          this.vel[b] += visc * this.dp[b];
          this.vel[b + 1] += visc * this.dp[b + 1];
          this.vel[b + 2] += visc * this.dp[b + 2];
        }
      }
    }

    for (let i = 0; i < this.count; i++) {
      if (this.asleep[i]) continue;
      const b = i * 3;
      this.speed[i] = Math.sqrt(
        this.vel[b] * this.vel[b] + this.vel[b + 1] * this.vel[b + 1] + this.vel[b + 2] * this.vel[b + 2],
      );
    }

    // Sleep scan: sustained positional stillness freezes a particle. While the
    // source is EMITTING, a bubble around it stays live so bottom-fed inflow
    // always has somewhere to push (a sealed sleeping inlet would
    // over-compress); an idle source earns no exemption.
    if (sleepOn) {
      const t = this.terrain;
      const srcLive = opts.emitRate > 0;
      let asleepN = 0;
      for (let i = 0; i < this.count; i++) {
        if (this.asleep[i]) {
          asleepN++;
          continue;
        }
        const b = i * 3;
        const ax = this.pos[b] - this.anchor[b];
        const ay = this.pos[b + 1] - this.anchor[b + 1];
        const az = this.pos[b + 2] - this.anchor[b + 2];
        if (ax * ax + ay * ay + az * az > STILL_R2) {
          this.anchor[b] = this.pos[b];
          this.anchor[b + 1] = this.pos[b + 1];
          this.anchor[b + 2] = this.pos[b + 2];
          this.stillTicks[i] = 0;
          continue;
        }
        if (srcLive) {
          const dxs = this.pos[b] - t.source[0];
          const dys = this.pos[b + 1] - t.source[1];
          const dzs = this.pos[b + 2] - t.source[2];
          if (dxs * dxs + dys * dys + dzs * dzs <= SRC_R2) continue;
        }
        const need = this.nbCount[i] >= BURIED_N ? SLEEP_TICKS : SLEEP_TICKS_SURF;
        if (++this.stillTicks[i] < need) continue;
        this.asleep[i] = 1;
        this.vel[b] = 0;
        this.vel[b + 1] = 0;
        this.vel[b + 2] = 0;
        this.speed[i] = 0;
        this.lambda[i] = 0;
        this.shove[i] = 0;
        asleepN++;
      }
      this.asleepCount = asleepN;
    }

    if (opts.evaporation !== false) this.evaporate(dt);
    this.drain();
    this.tick++;
  }

  report(): Report {
    let meanSpeed = 0;
    let maxSpeed = 0;
    for (let i = 0; i < this.count; i++) {
      meanSpeed += this.speed[i];
      if (this.speed[i] > maxSpeed) maxSpeed = this.speed[i];
    }
    if (this.count > 0) meanSpeed /= this.count;

    const t = this.terrain;
    const bw = t.basin.x1 - t.basin.x0;
    const bd = t.basin.z1 - t.basin.z0;
    const top = new Float32Array(bw * bd).fill(-1);
    const colN = new Int16Array(bw * bd);
    for (let i = 0; i < this.count; i++) {
      const b = i * 3;
      const x = Math.floor(this.pos[b]);
      const z = Math.floor(this.pos[b + 2]);
      if (x < t.basin.x0 || x >= t.basin.x1 || z < t.basin.z0 || z >= t.basin.z1) continue;
      const c = (z - t.basin.z0) * bw + (x - t.basin.x0);
      colN[c]++;
      if (this.pos[b + 1] > top[c]) top[c] = this.pos[b + 1];
    }
    let n = 0;
    let mean = 0;
    for (let c = 0; c < top.length; c++)
      if (colN[c] >= 3) {
        mean += top[c];
        n++;
      }
    let spread = 0;
    if (n > 1) {
      mean /= n;
      let s2 = 0;
      for (let c = 0; c < top.length; c++)
        if (colN[c] >= 3) {
          const d = top[c] - mean;
          s2 += d * d;
        }
      spread = Math.sqrt(s2 / n);
    } else if (n === 1) {
      // single column: no spread measurable
    } else {
      mean = -1;
    }

    let drains = 0;
    for (let k = 0; k < 60; k++) drains += this.drainWindow[k];

    return {
      tick: this.tick,
      count: this.count,
      emitted: this.emitted,
      drained: this.drained,
      evaporated: this.evaporated,
      error: this.emitted - this.drained - this.evaporated - this.count,
      outflowPerSec: drains,
      meanSpeed,
      maxSpeed,
      surfaceSpread: spread,
      basinSurfaceY: n > 0 ? mean : -1,
      capped: this.capped,
      asleep: this.asleepCount,
      solved: this.solvedCount,
    };
  }
}

export function createSim(scenario: ScenarioName, seed?: number): Sim {
  return new Sim(scenario, seed);
}

// TinyWorld path: the terrain is built OUTSIDE the solver (a crop of the live
// voxel world) and injected. Physics is identical — same cell-space rules the
// sandbox tuned; only the occupancy source differs.
export function createSimFromTerrain(terrain: Terrain, seed?: number): Sim {
  return new Sim("basin-spill", seed, terrain);
}

export const SIM_CONSTANTS = { D, H, R, MAX_N, SUBSTEPS, ITERS };
