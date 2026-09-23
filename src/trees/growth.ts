import type { GrowthStage } from "./types";

// Wall-clock growth: age is derived purely from plantedAt vs now, so the
// world keeps growing while closed (docs: "time-based, online or offline").
export interface GrowthConfig {
  // Seconds at which a tree enters stage 1, 2, 3 respectively.
  stageThresholdsSec: [number, number, number];
}

// Placeholder pacing — real numbers are the idle-loop tuning knobs
// (mass-and-density.md §9.3). 1h young, 4h mature, 12h ancient.
export const DEFAULT_GROWTH: GrowthConfig = {
  stageThresholdsSec: [3600, 4 * 3600, 12 * 3600],
};

export function ageSeconds(plantedAtMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - plantedAtMs) / 1000);
}

export function stageForAge(ageSec: number, cfg: GrowthConfig = DEFAULT_GROWTH): GrowthStage {
  const [t1, t2, t3] = cfg.stageThresholdsSec;
  if (ageSec >= t3) return 3;
  if (ageSec >= t2) return 2;
  if (ageSec >= t1) return 1;
  return 0;
}

// 0..1 overall progress across the full lifespan, for smooth size scaling
// (and for the super tree filling toward its scan-set cap over time).
export function growthFraction(ageSec: number, cfg: GrowthConfig = DEFAULT_GROWTH): number {
  const max = cfg.stageThresholdsSec[2];
  return Math.max(0, Math.min(1, ageSec / max));
}
