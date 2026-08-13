// Dedicated sim worker: owns the PBF solver + foam system and self-paces the
// fixed-timestep loop, so a long solver batch can never block the render
// thread. Semantics match the old inline loop exactly (same DT, same backlog
// guard, same foam cadence); only the thread changed.
import { createSim, createSimFromTerrain, setParticleScale, SIM_CONSTANTS, type Sim, type SimOptions } from "./particles";
import { GpuSim, requestGpuDevice } from "./gpu-sim";
import { FoamSystem } from "./foam";
import {
  H_ASLEEP, H_BASINY, H_CALM, H_CAPPED, H_COUNT, H_D, H_DRAINED, H_EMITTED, H_EVAP, H_FOAM,
  H_GPU, H_MASS_ERR, H_MAXN, H_MAXSP, H_MEANSP, H_OUTFLOW, H_REMAINDER, H_SCALE, H_SOLVED, H_SOLVER_MS,
  H_SPREAD, H_TICK, H_TICKS_SEC, H_WARMUP, OFF_FOAM_FADE, OFF_FOAM_POS, OFF_POS, OFF_SPEED, OFF_VEL,
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
// Load warm-up: sim-seconds still to fast-forward at full CPU speed. Burned
// in bounded chunks (WARM_CHUNK_MS per pass, then yield) so opts/reset
// messages keep flowing and snapshots stream the pool visibly filling.
let warmupLeft = 0;
let warmupTotal = 0;
const WARM_CHUNK_MS = 24;

// WebGPU compute home (?pwgpu): the mirror Sim stays authoritative for
// emission/evaporation/drain/ledger; GpuSim runs the substep solve as compute
// dispatches. The device is requested once and reused across resets. Adoption
// is seamless mid-fill (GpuSim uploads the mirror's pos/vel every tick), so
// the CPU path carries the sim until the device resolves. Any init failure
// (no adapter in this worker, grid over the buffer limit, WGSL error) logs
// and stays on the proven CPU path.
let gpuSim: GpuSim | null = null;
let gpuDevice: GPUDevice | null = null;
let gpuDevicePending = false;
let gpuWanted = false;
function tryAdoptGpu() {
  if (!gpuWanted || !sim || gpuSim) return;
  if (!gpuDevice) {
    if (gpuDevicePending) return;
    gpuDevicePending = true;
    void requestGpuDevice().then((dev) => {
      gpuDevicePending = false;
      if (!dev) {
        console.warn("[pwater gpu] WebGPU unavailable in the sim worker — staying on the CPU solver");
        gpuWanted = false;
        return;
      }
      gpuDevice = dev;
      tryAdoptGpu();
    });
    return;
  }
  try {
    gpuSim = new GpuSim(gpuDevice, sim);
    console.log(`[pwater gpu] compute solver adopted (count ${sim.count}, cap ${SIM_CONSTANTS.MAX_N})`);
  } catch (e) {
    console.warn("[pwater gpu] init failed — staying on the CPU solver:", e);
    gpuWanted = false;
  }
}
async function stepSim(stepDt: number) {
  if (gpuSim) await gpuSim.step(stepDt, opts);
  else sim!.step(stepDt, opts);
}
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
    wallOpen: t.wallOpen,
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
  f[H_WARMUP] = warmupLeft;
  f[H_MAXN] = SIM_CONSTANTS.MAX_N;
  f[H_GPU] = gpuSim ? 1 : 0;
  const n3 = sim.count * 3;
  f.set(sim.pos.subarray(0, n3), OFF_POS);
  f.set(sim.vel.subarray(0, n3), OFF_VEL);
  f.set(sim.speed.subarray(0, sim.count), OFF_SPEED);
  f.set(foam.pos.subarray(0, foam.count * 3), OFF_FOAM_POS);
  f.set(foam.fade.subarray(0, foam.count), OFF_FOAM_FADE);
  (self as unknown as Worker).postMessage({ t: "snap", buf }, [buf]);
}

async function pump() {
  const now = performance.now();
  const rawDt = lastNow > 0 ? (now - lastNow) / 1000 : DT;
  const dtReal = Math.min(0.1, rawDt);
  lastNow = now;
  let simmed = 0;
  let ticks = 0;
  if (sim) {
    const t0 = performance.now();
    if (warmupLeft > 0 && running && !stepOnce) {
      // Fast-forward: same fixed-step solver, at the max catch-up stride the
      // real-time path already uses (CFL clamp keeps it stable) — just not
      // throttled to wall-clock. Physics identical to having left the tab
      // open; only load time changes.
      const stepDt = DT * 4;
      while (warmupLeft > 0 && performance.now() - t0 < WARM_CHUNK_MS) {
        await stepSim(stepDt);
        warmupLeft -= stepDt;
        simmed += stepDt;
        ticks++;
      }
      if (warmupLeft <= 1e-9) {
        warmupLeft = 0;
        console.log(`[pwater] warm-up complete: ${warmupTotal}s of sim fast-forwarded (count ${sim.count})`);
      }
      pending = 0;
    } else if (stepOnce) {
      await stepSim(DT);
      stepOnce = false;
      pending = 0;
      simmed = DT;
      ticks = 1;
    } else if (running) {
      pending += dtReal * Math.max(1, timeScale);
      let guard = MAX_TICKS_PER_PASS;
      while (pending >= DT && guard-- > 0) {
        const stepDt = catchupDt(pending);
        await stepSim(stepDt);
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
    setParticleScale(m.scale, m.baseMax);
    warmupTotal = Math.max(0, m.warmup ?? 0);
    warmupLeft = warmupTotal;
    if (gpuSim) {
      gpuSim.dispose();
      gpuSim = null;
    }
    gpuWanted = m.gpu === true;
    sim = m.terrain
      ? createSimFromTerrain({
          nx: m.terrain.nx, ny: m.terrain.ny, nz: m.terrain.nz,
          solid: m.terrain.solid, source: m.terrain.source,
          basin: m.terrain.basin, rimY: m.terrain.rimY, open: m.terrain.open,
          wallOpen: m.terrain.wallOpen,
        })
      : createSim(m.scenario);
    foam = new FoamSystem();
    pending = 0;
    solverEma = 0;
    ticksEma = 0;
    sendTerrain();
    snapshot(true);
    tryAdoptGpu();
  } else if (m.t === "solidEdit") {
    if (sim) {
      sim.applySolidEdits(m.edits);
      gpuSim?.updateSolid(m.edits);
    }
  } else if (m.t === "recycle") {
    pool.push(m.buf);
    if (snapDirty) snapshot();
  }
};

pump();
