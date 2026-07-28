// Foam sprite system (simplified Ihmsen et al. "Unified spray, foam and air
// bubbles for SPH"). Foam is COSMETIC: sprites spawn where the sim's own
// state says turbulence is happening, ride the local fluid velocity, and die
// on a lifetime — nothing here feeds back into physics, so all placement is
// emergent from the solver.
//
// Spawn rule (history-free, robust to the sim's index swaps): a particle
// that is FAST while densely neighbored is dissipating energy inside/at the
// surface of a body — the plunge pool under a fall, rapids over a lip, a
// bore front. Lone fast particles (low neighbors) are airborne spray and
// already render via the SSFR speed channel; the moment they land they
// become fast+dense and seed foam exactly at the impact.
import { PARTICLE_SCALE, type Sim } from "./particles";

export const MAX_FOAM = 3072;

export interface FoamParams {
  spawnSpeed: number; // speed above which churn foam can spawn
  spawnDense: number; // neighbor count above which a particle counts as "in the body"
  spawnRate: number; // expected sprites per qualifying particle per second at speed+1
  lifeMin: number;
  lifeMax: number;
  follow: number; // fraction of local fluid velocity foam inherits
  surfaceSnap: number; // 1/s spring pulling foam to the free surface
  drySpeedup: number; // lifetime decay multiplier with no fluid support
}

// Tuned live on basin-spill: at spawnSpeed 6 / rate 2.2 the emitter plume
// alone painted the whole lake center one solid white cap. Higher speed bar
// + lower rate + shorter lives keeps the center a mottled churn patch and
// leaves the heavy foam to the falls and rapids.
const DEFAULTS: FoamParams = {
  spawnSpeed: 7,
  spawnDense: 12,
  spawnRate: 1.4,
  lifeMin: 0.9,
  lifeMax: 2.4,
  follow: 0.85,
  surfaceSnap: 8,
  drySpeedup: 5,
};

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

export class FoamSystem {
  readonly params: FoamParams;
  readonly pos = new Float32Array(MAX_FOAM * 3);
  readonly fade = new Float32Array(MAX_FOAM); // render alpha 0..1
  count = 0;

  private life = new Float32Array(MAX_FOAM);
  private lifeFull = new Float32Array(MAX_FOAM);
  private rng: () => number;
  private flow = new Float32Array(5);

  constructor(seed = 7331, params: Partial<FoamParams> = {}) {
    this.rng = mulberry32(seed);
    this.params = { ...DEFAULTS, ...params };
  }

  step(sim: Sim, dt: number) {
    if (dt <= 0) return;
    const p = this.params;

    // advect + age + compact in one pass
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      const b = i * 3;
      let x = this.pos[b];
      let y = this.pos[b + 1];
      let z = this.pos[b + 2];
      sim.sampleFlow(x, y, z, this.flow);
      const support = this.flow[3];
      let decay = 1;
      if (support > 0.5) {
        x += this.flow[0] * p.follow * dt;
        z += this.flow[2] * p.follow * dt;
        // foam floats: spring toward the local free surface instead of
        // integrating vertical flow (bubbles rise as fast as churn pulls down)
        const target = this.flow[4] + 0.1;
        y += (target - y) * Math.min(1, p.surfaceSnap * dt);
      } else {
        decay = p.drySpeedup; // stranded on rock / water receded
      }
      const life = this.life[i] - dt * decay;
      if (life <= 0) continue;
      const wb = w * 3;
      this.pos[wb] = x;
      this.pos[wb + 1] = y;
      this.pos[wb + 2] = z;
      this.life[w] = life;
      this.lifeFull[w] = this.lifeFull[i];
      this.fade[w] = Math.min(1, life / (0.4 * this.lifeFull[i]));
      w++;
    }
    this.count = w;

    // spawn from the sim's current turbulence
    const budget = Math.min(MAX_FOAM - this.count, 80);
    if (budget <= 0) return;
    let spawned = 0;
    for (let i = 0; i < sim.count && spawned < budget; i++) {
      if (sim.asleep[i]) continue;
      const s = sim.speed[i];
      if (s < p.spawnSpeed) continue;
      if (sim.nbCount[i] < p.spawnDense) continue;
      // spawnRate is per BASE-sized particle: finer sims have 1/scale^3 more
      // qualifying particles in the same churning water, so scale the
      // per-particle probability down to keep sprites-per-volume invariant
      const rateK = PARTICLE_SCALE * PARTICLE_SCALE * PARTICLE_SCALE;
      if (this.rng() >= p.spawnRate * rateK * dt * (s - p.spawnSpeed + 1)) continue;
      const b = i * 3;
      const k = this.count++;
      const kb = k * 3;
      this.pos[kb] = sim.pos[b] + (this.rng() - 0.5) * 0.8;
      this.pos[kb + 1] = sim.pos[b + 1] + 0.15;
      this.pos[kb + 2] = sim.pos[b + 2] + (this.rng() - 0.5) * 0.8;
      const life = p.lifeMin + this.rng() * (p.lifeMax - p.lifeMin);
      this.life[k] = life;
      this.lifeFull[k] = life;
      this.fade[k] = 1;
      spawned++;
    }
  }
}
