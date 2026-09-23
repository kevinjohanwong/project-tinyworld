export type Vec3 = { x: number; y: number; z: number };

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));

export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / l);
};

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

// Rodrigues rotation of v around unit axis k by angle radians.
export const rotateAroundAxis = (vec: Vec3, axis: Vec3, angle: number): Vec3 => {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const term1 = scale(vec, c);
  const term2 = scale(cross(k, vec), s);
  const term3 = scale(k, dot(k, vec) * (1 - c));
  return add(add(term1, term2), term3);
};
