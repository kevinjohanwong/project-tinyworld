const fract = (v: number) => v - Math.floor(v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hash(x: number, y: number, z: number) {
  x = fract(x * 0.3183099 + 0.1) * 17;
  y = fract(y * 0.3183099 + 0.1) * 17;
  z = fract(z * 0.3183099 + 0.1) * 17;
  return fract(x * y * z * (x + y + z));
}
function noise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(0, 1, fract(x)), fy = smooth(0, 1, fract(y)), fz = smooth(0, 1, fract(z));
  const plane = (dz: number) => mix(
    mix(hash(ix, iy, iz + dz), hash(ix + 1, iy, iz + dz), fx),
    mix(hash(ix, iy + 1, iz + dz), hash(ix + 1, iy + 1, iz + dz), fx), fy);
  return mix(plane(0), plane(1), fz);
}
function fbm(x: number, y: number, z: number) {
  return 0.6 * noise(x, y, z) + 0.3 * noise(x * 2.03 + 11.1, y * 2.03 + 11.1, z * 2.03 + 11.1)
    + 0.15 * noise(x * 4.01 + 23.7, y * 4.01 + 23.7, z * 4.01 + 23.7);
}
export function cloudSeaHeight(x: number, z: number, span: number, inner: number, cell: number) {
  const dome = smooth(0.34, 0.76, fbm(x * 1.1 / span, 0, z * 1.1 / span));
  const dome2 = smooth(0.36, 0.80, fbm(x * 2.7 / span + 17, 0, z * 2.7 / span));
  const height = (dome * 0.72 + dome2 * 0.28) * span * 0.5 * smooth(inner * 0.85, inner * 1.6, Math.hypot(x, z));
  return Math.floor(height / cell + 0.5) * cell;
}
export function createCloudSeaData(span: number, inner: number, outer: number) {
  if (![span, inner, outer].every(Number.isFinite) || span <= 0 || inner <= 0 || outer <= inner)
    throw new Error("Invalid cloud sea dimensions");
  const cell = Math.max(span * 0.09, outer / 120);
  const half = Math.ceil(outer / cell), size = half * 2;
  const heights = new Float64Array(size * size).fill(NaN);
  let cells = 0;
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const wx = (x - half + 0.5) * cell, wz = (z - half + 0.5) * cell;
    if (Math.hypot(wx, wz) > outer) continue;
    heights[z * size + x] = cloudSeaHeight(wx, wz, span, inner, cell);
    cells++;
  }
  const height = (x: number, z: number) => x < 0 || z < 0 || x >= size || z >= size ? NaN : heights[z * size + x];
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], y01: number[] = [], indices: number[] = [];
  const quad = (points: number[][], n: number[], ao: number) => {
    const start = positions.length / 3;
    for (const p of points) {
      positions.push(...p);
      normals.push(...n);
      colors.push(ao, ao, ao);
      y01.push(Math.max(0, Math.min(1, p[1] / (span * 0.5))));
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const h = height(x, z);
    if (!Number.isFinite(h)) continue;
    const x0 = (x - half) * cell, x1 = x0 + cell, z0 = (z - half) * cell, z1 = z0 + cell;
    const sides = [height(x + 1, z), height(x - 1, z), height(x, z + 1), height(x, z - 1)];
    const cover = sides.reduce((n, v) => n + (Number.isFinite(v) && v > h ? Math.min(1, (v - h) / cell) : 0), 0);
    quad([[x0,h,z0],[x0,h,z1],[x1,h,z1],[x1,h,z0]], [0,1,0], 1 - cover * 0.1);
    for (let face = 0; face < 4; face++) {
      const low = Number.isFinite(sides[face]) ? sides[face] : -cell;
      if (low >= h) continue;
      if (face === 0) quad([[x1,low,z0],[x1,h,z0],[x1,h,z1],[x1,low,z1]], [1,0,0], 1);
      if (face === 1) quad([[x0,low,z1],[x0,h,z1],[x0,h,z0],[x0,low,z0]], [-1,0,0], 1);
      if (face === 2) quad([[x1,low,z1],[x1,h,z1],[x0,h,z1],[x0,low,z1]], [0,0,1], 1);
      if (face === 3) quad([[x0,low,z0],[x0,h,z0],[x1,h,z0],[x1,low,z0]], [0,0,-1], 1);
    }
  }
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    colors: new Float32Array(colors), y01: new Float32Array(y01), indices: new Uint32Array(indices),
    cells, cell,
  };
}
