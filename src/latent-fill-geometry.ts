export type FillRange = { x: number; z: number; y0: number; y1: number };

export function buildLatentFillGeometry(ranges: FillRange[]) {
  const columns = new Map<string, FillRange[]>();
  for (const r of ranges) {
    const key = `${r.x},${r.z}`;
    const col = columns.get(key) || [];
    col.push(r);
    columns.set(key, col);
  }
  for (const col of columns.values()) col.sort((a, b) => a.y0 - b.y0);
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const quad = (points: number[][], normal: number[]) => {
    const base = positions.length / 3;
    for (const p of points) { positions.push(...p); normals.push(...normal); }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const r of ranges) {
    const x0 = r.x - 0.5, x1 = r.x + 0.5, z0 = r.z - 0.5, z1 = r.z + 0.5;
    const y0 = r.y0 - 0.5, y1 = r.y1 + 0.5;
    quad([[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]], [0,1,0]);
    quad([[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]], [0,-1,0]);
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      let lo = r.y0;
      const expose = (a: number, b: number) => {
        if (a > b) return;
        const bottom = a - 0.5, top = b + 0.5;
        if (dx === 1) quad([[x1,bottom,z0],[x1,top,z0],[x1,top,z1],[x1,bottom,z1]], [1,0,0]);
        else if (dx === -1) quad([[x0,bottom,z1],[x0,top,z1],[x0,top,z0],[x0,bottom,z0]], [-1,0,0]);
        else if (dz === 1) quad([[x1,bottom,z1],[x1,top,z1],[x0,top,z1],[x0,bottom,z1]], [0,0,1]);
        else quad([[x0,bottom,z0],[x0,top,z0],[x1,top,z0],[x1,bottom,z0]], [0,0,-1]);
      };
      for (const n of columns.get(`${r.x + dx},${r.z + dz}`) || []) {
        if (n.y1 < lo) continue;
        if (n.y0 > r.y1) break;
        expose(lo, Math.min(r.y1, n.y0 - 1));
        lo = Math.max(lo, n.y1 + 1);
        if (lo > r.y1) break;
      }
      expose(lo, r.y1);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}
