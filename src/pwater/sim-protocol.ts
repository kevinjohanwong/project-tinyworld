// Shared contract between the main thread and the sim worker.
// A snapshot is ONE transferable ArrayBuffer: a small float header followed by
// fixed-offset regions sized for the finest drop tier, so the pool never
// reallocates when the tier changes. Buffers are recycled (main posts them
// back after adopting the next one) — steady state is zero allocation.
import { maxParticlesAtScale, type ScenarioName } from "./particles";
import { MAX_FOAM } from "./foam";

export const FINEST_SCALE = 0.5;
export const SNAP_MAX_P = maxParticlesAtScale(FINEST_SCALE);

// Header slots (Float32)
export const H_COUNT = 0;
export const H_FOAM = 1;
export const H_TICK = 2;
export const H_EMITTED = 3;
export const H_DRAINED = 4;
export const H_EVAP = 5;
export const H_OUTFLOW = 6;
export const H_MEANSP = 7;
export const H_MAXSP = 8;
export const H_SPREAD = 9;
export const H_BASINY = 10;
export const H_CAPPED = 11;
export const H_ASLEEP = 12;
export const H_SOLVED = 13;
export const H_CALM = 14;
export const H_REMAINDER = 15; // not-yet-simmed accumulator seconds at send time
export const H_SOLVER_MS = 16; // EMA ms per WORKED loop pass (all ticks + foam)
export const H_TICKS_SEC = 17; // EMA sim ticks per second
export const H_MASS_ERR = 18;
export const H_SCALE = 19;
export const H_D = 20;
export const HDR = 32;

export const OFF_POS = HDR;
export const OFF_VEL = OFF_POS + SNAP_MAX_P * 3;
export const OFF_SPEED = OFF_VEL + SNAP_MAX_P * 3;
export const OFF_FOAM_POS = OFF_SPEED + SNAP_MAX_P;
export const OFF_FOAM_FADE = OFF_FOAM_POS + MAX_FOAM * 3;
export const SNAP_FLOATS = OFF_FOAM_FADE + MAX_FOAM;
export const SNAP_BYTES = SNAP_FLOATS * 4;

export interface SimOptsMsg {
  t: "opts";
  emitRate: number;
  viscosity: number;
  sleep: boolean;
  evaporation: boolean;
  timeScale: number;
  running: boolean;
}
export interface StepMsg { t: "step" }
// Wire form of an injected custom terrain (TinyWorld voxel crop). solid is
// TRANSFERRED with the message — callers must post a copy, not their only one.
export interface TerrainWire {
  nx: number;
  ny: number;
  nz: number;
  solid: Uint8Array;
  source: [number, number, number];
  basin: { x0: number; x1: number; z0: number; z1: number };
  rimY: number;
  open?: "px" | "all";
}
export interface ResetMsg { t: "reset"; scenario: ScenarioName; scale: number; terrain?: TerrainWire }
export interface RecycleMsg { t: "recycle"; buf: ArrayBuffer }
export type ToWorker = SimOptsMsg | StepMsg | ResetMsg | RecycleMsg;

export interface TerrainMsg {
  t: "terrain";
  nx: number;
  ny: number;
  nz: number;
  solid: Uint8Array;
  source: [number, number, number];
  basin: { x0: number; x1: number; z0: number; z1: number };
  rimY: number;
  open?: "px" | "all";
  D: number;
  scale: number;
}
export interface SnapMsg { t: "snap"; buf: ArrayBuffer }
export type FromWorker = TerrainMsg | SnapMsg;
