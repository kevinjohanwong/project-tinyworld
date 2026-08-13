// SimDriver: one interface, two homes for the solver.
// - InlineDriver runs Sim + Foam synchronously in the rAF (the classic path,
//   kept behind ?worker=0 for A/B and as fallback).
// - WorkerDriver runs them in a dedicated worker; the render thread only ever
//   adopts the latest snapshot and extrapolates along velocities, so render
//   fps is decoupled from solver cost.
import { createSim, createSimFromTerrain, setParticleScale, PARTICLE_SCALE, SIM_CONSTANTS, type Report, type ScenarioName, type Sim, type Terrain } from "./particles";
import { FoamSystem, MAX_FOAM } from "./foam";
import {
  H_ASLEEP, H_BASINY, H_CALM, H_CAPPED, H_COUNT, H_D, H_DRAINED, H_EMITTED, H_EVAP, H_FOAM,
  H_GPU, H_MASS_ERR, H_MAXN, H_MAXSP, H_MEANSP, H_OUTFLOW, H_REMAINDER, H_SCALE, H_SOLVED, H_SOLVER_MS,
  H_SPREAD, H_TICK, H_TICKS_SEC, H_WARMUP, OFF_FOAM_FADE, OFF_FOAM_POS, OFF_POS, OFF_SPEED, OFF_VEL,
  SNAP_MAX_P, type FromWorker, type ToWorker,
} from "./sim-protocol";

const DT = 1 / 60;
const MAX_TICKS_PER_FRAME = 8;
// Mirrors the worker's CPU-bound catch-up: steps escalate 2x -> 4x with the
// backlog, so slow devices keep real-time water instead of slow-mo down to
// ~1/4 the ideal tick rate (CFL clamp trades top droplet speed, not stability).
const CATCHUP_BACKLOG = 4 * DT;
function catchupDt(pending: number): number {
  if (pending >= 3 * CATCHUP_BACKLOG) return DT * 4;
  if (pending >= 1.5 * CATCHUP_BACKLOG) return DT * 3;
  if (pending >= CATCHUP_BACKLOG) return DT * 2;
  return DT;
}
const CALM_SPEED = 0.05;
// Worker extrapolation horizon: bridge up to 3 frames of snapshot gap (a slow
// solver batch) before render motion pauses; beyond that, guessing diverges
// (drops sail through terrain), so we hold instead.
const EXTRA_MAX = 3 * DT;

// What to simulate: a named sandbox scenario, or an injected custom terrain
// (TinyWorld voxel crop).
export type SimSource = ScenarioName | { custom: Terrain };

function makeSim(src: SimSource): Sim {
  return typeof src === "string" ? createSim(src) : createSimFromTerrain(src.custom);
}

export interface DriverCtl {
  running: boolean;
  emitRate: number;
  viscosity: number;
  sleep: boolean;
  evaporation: boolean;
  stepOnce: boolean;
  timeScale: number;
  scale: number;
  resetTo: SimSource | null;
}

export interface FrameState {
  count: number;
  pos: Float32Array;
  vel: Float32Array;
  speed: Float32Array;
  foamCount: number;
  foamPos: Float32Array;
  foamFade: Float32Array;
  report: Report;
  calm: boolean;
  extra: number; // seconds to extrapolate along vel for this render frame
  solverMs: number;
  ticksPerSec: number;
  warmupLeft: number; // sim-seconds of load fast-forward still pending
  maxN: number; // the sim's active particle cap
  gpuActive: boolean; // true when the worker's WebGPU compute solver is live
}

// Per-sim extras applied at construction AND on every reset (a drop-tier
// change rebuilds the sim, so it re-warms and re-caps identically).
export interface DriverExtras {
  warmup?: number; // sim-seconds to fast-forward at load (unthrottled)
  baseMax?: number; // particle cap in base-sized drops (clamped to HARD_MAX_N)
  gpu?: boolean; // run the substep solve as WebGPU compute (worker path only)
}

export interface SimDriver {
  readonly kind: "inline" | "worker";
  frame(dtReal: number, ctl: DriverCtl): FrameState | null;
  onTerrain(cb: (t: Terrain, D: number, scale: number) => void): void;
  // Live terrain edits: flat [gx, gy, gz, solid, ...] quads in box cells.
  // The buffer is consumed (transferred in worker mode) — don't reuse it.
  solidEdit(edits: Int32Array): void;
  sim(): Sim | null; // inline only; null in worker mode
  dispose(): void;
}

class InlineDriver implements SimDriver {
  readonly kind = "inline" as const;
  private simInst: Sim;
  private foam = new FoamSystem();
  private pending = 0;
  private terrainCb: ((t: Terrain, D: number, scale: number) => void) | null = null;
  private report: Report | null = null;
  private reportAt = -1;
  private solverEma = 0;
  private ticksEma = 0;
  private warmupLeft = 0;
  private extras: DriverExtras;

  constructor(source: SimSource, scale: number, extras: DriverExtras = {}) {
    this.extras = extras;
    setParticleScale(scale, extras.baseMax);
    this.simInst = makeSim(source);
    this.warmupLeft = Math.max(0, extras.warmup ?? 0);
  }

  onTerrain(cb: (t: Terrain, D: number, scale: number) => void) {
    this.terrainCb = cb;
    cb(this.simInst.terrain, SIM_CONSTANTS.D, PARTICLE_SCALE);
  }

  sim() {
    return this.simInst;
  }

  solidEdit(edits: Int32Array) {
    this.simInst.applySolidEdits(edits);
  }

  frame(dtReal: number, c: DriverCtl): FrameState {
    if (c.resetTo) {
      setParticleScale(c.scale, this.extras.baseMax);
      this.simInst = makeSim(c.resetTo);
      this.foam = new FoamSystem();
      c.resetTo = null;
      this.pending = 0;
      this.reportAt = -1;
      this.warmupLeft = Math.max(0, this.extras.warmup ?? 0);
      this.terrainCb?.(this.simInst.terrain, SIM_CONSTANTS.D, PARTICLE_SCALE);
    }
    const sim = this.simInst;
    const opts = { emitRate: c.emitRate, viscosity: c.viscosity, sleep: c.sleep, evaporation: c.evaporation };
    let simmed = 0;
    let ticks = 0;
    const t0 = performance.now();
    if (this.warmupLeft > 0 && c.running && !c.stepOnce) {
      // Inline fallback shares the render thread, so warm-up burns a small
      // per-frame budget instead of the worker's big chunks — the pool still
      // fast-forwards, just spread over the first seconds of frames.
      const stepDt = DT * 4;
      while (this.warmupLeft > 0 && performance.now() - t0 < 10) {
        sim.step(stepDt, opts);
        this.warmupLeft -= stepDt;
        simmed += stepDt;
        ticks++;
      }
      if (this.warmupLeft <= 1e-9) {
        this.warmupLeft = 0;
        console.log(`[pwater] inline warm-up complete (count ${sim.count})`);
      }
      this.pending = 0;
    } else if (c.stepOnce) {
      sim.step(DT, opts);
      c.stepOnce = false;
      this.pending = 0;
      simmed = DT;
      ticks = 1;
    } else if (c.running) {
      this.pending += dtReal * Math.max(1, c.timeScale);
      let guard = MAX_TICKS_PER_FRAME;
      while (this.pending >= DT && guard-- > 0) {
        const stepDt = catchupDt(this.pending);
        sim.step(stepDt, opts);
        this.pending -= stepDt;
        simmed += stepDt;
        ticks++;
      }
      if (this.pending >= DT) this.pending = this.pending % DT;
    }
    if (simmed > 0) {
      this.foam.step(sim, simmed);
      const spent = performance.now() - t0;
      this.solverEma += (spent - this.solverEma) * 0.08;
      this.ticksEma += (ticks / Math.max(dtReal, 1e-4) - this.ticksEma) * 0.08;
    }
    let calm = simmed === 0 || (sim.count > 0 && sim.asleepCount === sim.count);
    if (!calm) {
      let mx = 0;
      for (let i = 0; i < sim.count; i++) if (sim.speed[i] > mx) { mx = sim.speed[i]; if (mx >= CALM_SPEED) break; }
      calm = mx < CALM_SPEED;
    }
    if (this.reportAt !== sim.tick) {
      this.report = sim.report();
      this.reportAt = sim.tick;
    }
    return {
      count: sim.count,
      pos: sim.pos,
      vel: sim.vel,
      speed: sim.speed,
      foamCount: this.foam.count,
      foamPos: this.foam.pos,
      foamFade: this.foam.fade,
      report: this.report!,
      calm,
      extra: Math.min(this.pending, DT),
      solverMs: this.solverEma,
      ticksPerSec: this.ticksEma,
      warmupLeft: this.warmupLeft,
      maxN: SIM_CONSTANTS.MAX_N,
      gpuActive: false,
    };
  }

  dispose() {}
}

class WorkerDriver implements SimDriver {
  readonly kind = "worker" as const;
  private worker: Worker;
  private buf: ArrayBuffer | null = null;
  private view: Float32Array | null = null;
  private receivedAt = 0;
  private terrainCb: ((t: Terrain, D: number, scale: number) => void) | null = null;
  private terrainMsg: { t: Terrain; D: number; scale: number } | null = null;
  private lastOpts = "";
  private report: Report = {
    tick: 0, count: 0, emitted: 0, drained: 0, evaporated: 0, error: 0, outflowPerSec: 0,
    meanSpeed: 0, maxSpeed: 0, surfaceSpread: 0, basinSurfaceY: -1, capped: false, asleep: 0, solved: 0,
  };
  private reportTick = -1;

  private extras: DriverExtras;

  constructor(source: SimSource, scale: number, extras: DriverExtras = {}) {
    this.extras = extras;
    this.worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.t === "terrain") {
        const t: Terrain = { nx: m.nx, ny: m.ny, nz: m.nz, solid: m.solid, source: m.source, basin: m.basin, rimY: m.rimY, open: m.open, wallOpen: m.wallOpen };
        this.terrainMsg = { t, D: m.D, scale: m.scale };
        this.terrainCb?.(t, m.D, m.scale);
      } else if (m.t === "snap") {
        if (this.buf) this.worker.postMessage({ t: "recycle", buf: this.buf } satisfies ToWorker, [this.buf]);
        this.buf = m.buf;
        this.view = new Float32Array(m.buf);
        this.receivedAt = performance.now();
      }
    };
    this.postReset(source, scale);
  }

  private post(m: ToWorker, transfer?: Transferable[]) {
    if (transfer) this.worker.postMessage(m, transfer);
    else this.worker.postMessage(m);
  }

  // Custom terrain travels as a TRANSFERRED copy of the solid buffer (the
  // caller keeps its own); scenario resets stay a tiny message.
  private postReset(source: SimSource, scale: number) {
    const warmup = this.extras.warmup;
    const baseMax = this.extras.baseMax;
    const gpu = this.extras.gpu;
    if (typeof source === "string") {
      this.post({ t: "reset", scenario: source, scale, warmup, baseMax, gpu });
    } else {
      const t = source.custom;
      const solid = t.solid.slice();
      this.post(
        {
          t: "reset", scenario: "basin-spill", scale, warmup, baseMax, gpu,
          terrain: { nx: t.nx, ny: t.ny, nz: t.nz, solid, source: t.source, basin: t.basin, rimY: t.rimY, open: t.open, wallOpen: t.wallOpen },
        },
        [solid.buffer],
      );
    }
  }

  onTerrain(cb: (t: Terrain, D: number, scale: number) => void) {
    this.terrainCb = cb;
    if (this.terrainMsg) cb(this.terrainMsg.t, this.terrainMsg.D, this.terrainMsg.scale);
  }

  sim() {
    return null;
  }

  solidEdit(edits: Int32Array) {
    this.post({ t: "solidEdit", edits }, [edits.buffer]);
  }

  frame(_dtReal: number, c: DriverCtl): FrameState | null {
    if (c.resetTo) {
      this.postReset(c.resetTo, c.scale);
      c.resetTo = null;
    }
    if (c.stepOnce) {
      this.post({ t: "step" });
      c.stepOnce = false;
    }
    const key = `${c.emitRate}|${c.viscosity}|${c.sleep}|${c.evaporation}|${c.timeScale}|${c.running}`;
    if (key !== this.lastOpts) {
      this.lastOpts = key;
      this.post({
        t: "opts", emitRate: c.emitRate, viscosity: c.viscosity, sleep: c.sleep,
        evaporation: c.evaporation, timeScale: c.timeScale, running: c.running,
      });
    }
    const f = this.view;
    if (!f) return null;
    const count = f[H_COUNT] | 0;
    const foamCount = f[H_FOAM] | 0;
    if (this.reportTick !== f[H_TICK]) {
      this.reportTick = f[H_TICK];
      this.report = {
        tick: f[H_TICK], count, emitted: f[H_EMITTED], drained: f[H_DRAINED], evaporated: f[H_EVAP],
        error: f[H_MASS_ERR], outflowPerSec: f[H_OUTFLOW], meanSpeed: f[H_MEANSP], maxSpeed: f[H_MAXSP],
        surfaceSpread: f[H_SPREAD], basinSurfaceY: f[H_BASINY], capped: f[H_CAPPED] === 1,
        asleep: f[H_ASLEEP], solved: f[H_SOLVED],
      };
    }
    const calm = f[H_CALM] === 1;
    const age = (performance.now() - this.receivedAt) / 1000;
    const extra = calm ? 0 : Math.min(EXTRA_MAX, f[H_REMAINDER] + age * Math.max(1, c.timeScale));
    return {
      count,
      pos: f.subarray(OFF_POS, OFF_POS + count * 3),
      vel: f.subarray(OFF_VEL, OFF_VEL + count * 3),
      speed: f.subarray(OFF_SPEED, OFF_SPEED + count),
      foamCount,
      foamPos: f.subarray(OFF_FOAM_POS, OFF_FOAM_POS + MAX_FOAM * 3),
      foamFade: f.subarray(OFF_FOAM_FADE, OFF_FOAM_FADE + MAX_FOAM),
      report: this.report,
      calm,
      extra,
      solverMs: f[H_SOLVER_MS],
      ticksPerSec: f[H_TICKS_SEC],
      warmupLeft: f[H_WARMUP],
      maxN: f[H_MAXN] | 0,
      gpuActive: f[H_GPU] === 1,
    };
  }

  dispose() {
    this.worker.terminate();
  }
}

export function createDriver(useWorker: boolean, source: SimSource, scale: number, extras: DriverExtras = {}): SimDriver {
  return useWorker ? new WorkerDriver(source, scale, extras) : new InlineDriver(source, scale, extras);
}

export { SNAP_MAX_P };
