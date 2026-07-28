// Dedicated sim worker: owns the PBF solver + foam system and self-paces the
// fixed-timestep loop, so a long solver batch can never block the render
// thread. Semantics match the old inline loop exactly (same DT, same backlog
// guard, same foam cadence); only the thread changed.
import { createSim, createSimFromTerrain, setParticleScale, SIM_CONSTANTS, type Sim, type SimOptions } from "./particles";
import { FoamSystem } from "./foam";
import {
  H_ASLEEP, H_BASINY, H_CALM, H_CAPPED, H_COUNT, H_D, H_DRAINED, H_EMITTED, H_EVAP, H_FOAM,
  H_MASS_ERR, H_MAXSP, H_MEANSP, H_OUTFLOW, H_REMAINDER, H_SCALE, H_SOLVED, H_SOLVER_MS,
  H_SPREAD, H_TICK, H_TICKS_SEC, OFF_FOAM_FADE, OFF_FOAM_POS, OFF_POS, OFF_SPEED, OFF_VEL,
  SNAP_BYTES, type ToWorker,
} from "./sim-protocol";

const DT = 1 / 60;
const MAX_TICKS_PER_PASS = 8;
// CPU-bound catch-up: when the backlog exceeds ~4 frames the device can't
// sustain 60 ticks/s — take bigger steps (the solver's per-substep CFL
// clamp vmax = 0.45H/sdt keeps them stable) so sim time tracks real time
// instead of running the water in slow motion. Escalates 2x -> 4x with the
// backlog, so true-speed water holds down to ~1/4 the ideal tick rate
// (phone-class devices); the CFL clamp trades top droplet speed, not
// stability, at the big sizes.
const CATCHUP_BACKLOG = 4 * DT;
function catchupDt(pending: number): number {
  if (pending >= 3 * CATCHUP_BACKLOG) return DT * 4;
  if (pending >= 1.5 * CATCHUP_BACKLOG) return DT * 3;
  if (pending >= CATCHUP_BACKLOG) return DT * 2;
  return DT;
}
const CALM_SPEED = 0.05; // matches the page's static-frame gate
const SNAP_MIN_MS = 12; // ≤ ~80 snapshots/s; render extrapolates between them

let sim: Sim | null = null;
let foam = new FoamSystem();
let scale = 1;
let running = true;
let stepOnce = false;
let timeScale = 1;
let opts: SimOptions = { emitRate: 120, viscosity: 0.05, sleep: true, evaporation: true };

let pending = 0;
let lastNow = 0;
let solverEma = 0;
let ticksEma = 0;
let lastSnapAt = 0;
let snapDirty = false;
const pool: ArrayBuffer[] = [new ArrayBuffer(SNAP_BYTES), new ArrayBuffer(SNAP_BYTES), new ArrayBuffer(SNAP_BYTES)];

function sendTerrain() {
  if (!sim) return;
  const t = sim.terrain;
  const solid = t.solid.slice();
  const msg = {
    t: "terrain" as const,
    nx: t.nx, ny: t.ny, nz: t.nz, solid,
    source: t.source, basin: t.basin, rimY: t.rimY, open: t.open,
    D: SIM_CONSTANTS.D, scale,
  };
  (self as unknown as Worker).postMessage(msg, [solid.buffer]);
}

function snapshot(force = false) {
  if (!sim) return;
  const now = performance.now();
  if (!force && now - lastSnapAt < SNAP_MIN_MS) { snapDirty = true; return; }
  const buf = pool.pop();
  if (!buf) { snapDirty = true; return; } // main thread is behind; send on recycle
  lastSnapAt = now;
  snapDirty = false;
  const f = new Float32Array(buf);
  const r = sim.report();
  let calm = sim.count > 0 && sim.asleepCount === sim.count;
  if (!calm) {
    let mx = 0;
    for (let i = 0; i < sim.count; i++) if (sim.speed[i] > mx) { mx = sim.speed[i]; if (mx >= CALM_SPEED) break; }
    calm = mx < CALM_SPEED;
  }
  f[H_COUNT] = sim.count;
  f[H_FOAM] = foam.count;
  f[H_TICK] = r.tick;
  f[H_EMITTED] = r.emitted;
  f[H_DRAINED] = r.drained;
  f[H_EVAP] = r.evaporated;
  f[H_OUTFLOW] = r.outflowPerSec;
  f[H_MEANSP] = r.meanSpeed;
  f[H_MAXSP] = r.maxSpeed;
  f[H_SPREAD] = r.surfaceSpread;
  f[H_BASINY] = r.basinSurfaceY;
  f[H_CAPPED] = r.capped ? 1 : 0;
  f[H_ASLEEP] = r.asleep;
  f[H_SOLVED] = r.solved;
  f[H_CALM] = calm ? 1 : 0;
  f[H_REMAINDER] = pending;
  f[H_SOLVER_MS] = solverEma;
  f[H_TICKS_SEC] = ticksEma;
  f[H_MASS_ERR] = r.error;
  f[H_SCALE] = scale;
  f[H_D] = SIM_CONSTANTS.D;
  const n3 = sim.count * 3;
  f.set(sim.pos.subarray(0, n3), OFF_POS);
  f.set(sim.vel.subarray(0, n3), OFF_VEL);
  f.set(sim.speed.subarray(0, sim.count), OFF_SPEED);
  f.set(foam.pos.subarray(0, foam.count * 3), OFF_FOAM_POS);
  f.set(foam.fade.subarray(0, foam.count), OFF_FOAM_FADE);
  (self as unknown as Worker).postMessage({ t: "snap", buf }, [buf]);
}

function pump() {
  const now = performance.now();
  const rawDt = lastNow > 0 ? (now - lastNow) / 1000 : DT;
  const dtReal = Math.min(0.1, rawDt);
  lastNow = now;
  let simmed = 0;
  let ticks = 0;
  if (sim) {
    const t0 = performance.now();
    if (stepOnce) {
      sim.step(DT, opts);
      stepOnce = false;
      pending = 0;
      simmed = DT;
      ticks = 1;
    } else if (running) {
      pending += dtReal * Math.max(1, timeScale);
      let guard = MAX_TICKS_PER_PASS;
      while (pending >= DT && guard-- > 0) {
        const stepDt = catchupDt(pending);
        sim.step(stepDt, opts);
        pending -= stepDt;
        simmed += stepDt;
        ticks++;
      }
      if (pending >= DT) pending = pending % DT; // still behind: drop backlog
    }
    if (simmed > 0) {
      foam.step(sim, simmed);
      const spent = performance.now() - t0;
      solverEma += (spent - solverEma) * 0.08;
      ticksEma += (ticks / Math.max(rawDt, 1e-4) - ticksEma) * 0.08;
      snapshot();
    } else if (snapDirty) {
      snapshot();
    }
  }
  setTimeout(pump, simmed > 0 ? 0 : 4);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.t === "opts") {
    opts = { emitRate: m.emitRate, viscosity: m.viscosity, sleep: m.sleep, evaporation: m.evaporation };
    timeScale = m.timeScale;
    running = m.running;
  } else if (m.t === "step") {
    stepOnce = true;
  } else if (m.t === "reset") {
    scale = m.scale;
    setParticleScale(m.scale);
    sim = m.terrain
      ? createSimFromTerrain({
          nx: m.terrain.nx, ny: m.terrain.ny, nz: m.terrain.nz,
          solid: m.terrain.solid, source: m.terrain.source,
          basin: m.terrain.basin, rimY: m.terrain.rimY, open: m.terrain.open,
        })
      : createSim(m.scenario);
    foam = new FoamSystem();
    pending = 0;
    solverEma = 0;
    ticksEma = 0;
    sendTerrain();
    snapshot(true);
  } else if (m.t === "recycle") {
    pool.push(m.buf);
    if (snapDirty) snapshot();
  }
};

pump();
