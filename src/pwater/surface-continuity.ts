export function smoothUnit(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function surfaceDensity(mass: number): number {
  return Math.min(1.1, Math.max(0.45, mass)) * smoothUnit(mass / 0.04);
}

export function responseAlpha(rate: number, dt: number): number {
  return -Math.expm1(-rate * Math.max(0, dt));
}

export function standingFraction(mass: number, downwardFlow: number, supported: boolean): number {
  if (supported || mass <= 0) return 1;
  return 1 - smoothUnit((downwardFlow / mass - 0.35) / 0.3);
}
