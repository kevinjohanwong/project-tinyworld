import { makeRng, type Rng } from "./rng";
import {
  LEAF_ELEMENT,
  type Element,
  type Skeleton,
  type Voxel,
} from "./types";
import { add, dist, lerp, len, sub, v, type Vec3 } from "./vec";

export interface VoxelizeOptions {
  woodElement: Element; // grade of wood for this growth stage
  leafSize: number; // leaf-blob radius at branch tips
  leafDensity: number; // 0..1 fraction of blob cells that become leaves
  seed: number; // deterministic leaf scatter
  pruneMask?: ReadonlySet<number>; // segment ids to skip (pruning)
  noLeaves?: boolean; // roots etc.
  // Occupancy test in tree-local voxel coords: return true if a cell is
  // already taken (wall, ceiling, another tree). Such cells are not emitted,
  // carving branches flush at the surface instead of poking through.
  occupied?: (x: number, y: number, z: number) => boolean;
}

type Cell = { x: number; y: number; z: number };
const ckey = (x: number, y: number, z: number) => `${x}|${y}|${z}`;

// Rasterize a skeleton into integer-grid voxels. Wood capsules along each
// segment + leaf blobs at terminals. Wood always wins a contested cell.
export function voxelizeSkeleton(skel: Skeleton, opts: VoxelizeOptions): Voxel[] {
  const cells = new Map<string, Voxel>();
  const rng = makeRng(opts.seed);
  const mask = opts.pruneMask;

  for (const seg of skel.segments) {
    if (mask && mask.has(seg.id)) continue;

    // Wood: sample along the segment, fill a tapered sphere at each sample.
    const segLen = len(sub(seg.b, seg.a));
    const steps = Math.max(1, Math.ceil(segLen));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const c = lerp(seg.a, seg.b, t);
      const r = lerp(seg.radiusA, seg.radiusB, t);
      fillSphere(cells, c, r, {
        kind: "wood",
        element: opts.woodElement,
        segId: seg.id,
      });
    }

    // Leaves: blob at the tip of terminal branches.
    if (!opts.noLeaves && seg.kind === "branch" && seg.terminal && opts.leafSize > 0) {
      fillLeafBlob(cells, seg.b, opts.leafSize, opts.leafDensity, seg.id, rng);
    }
  }

  const occ = opts.occupied;
  if (!occ) return [...cells.values()];
  const out: Voxel[] = [];
  for (const c of cells.values()) {
    if (!occ(c.x, c.y, c.z)) out.push(c);
  }
  return out;
}

function fillSphere(
  cells: Map<string, Voxel>,
  center: Vec3,
  radius: number,
  meta: { kind: "wood" | "leaf"; element: Element; segId: number },
): void {
  const r = Math.max(radius, 0.5);
  const r2 = r * r;
  const minc = floorCell(center, r);
  const maxc = ceilCell(center, r);
  for (let x = minc.x; x <= maxc.x; x++) {
    for (let y = minc.y; y <= maxc.y; y++) {
      for (let z = minc.z; z <= maxc.z; z++) {
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const dz = z + 0.5 - center.z;
        if (dx * dx + dy * dy + dz * dz <= r2) put(cells, x, y, z, meta);
      }
    }
  }
  // Guarantee at least the center cell for sub-voxel-thin tips.
  const cx = Math.round(center.x - 0.5);
  const cy = Math.round(center.y - 0.5);
  const cz = Math.round(center.z - 0.5);
  put(cells, cx, cy, cz, meta);
}

// A tuft is a union of 2–4 offset lobes of differing radius, so each branch
// terminal grows a clumped, varied cluster rather than a uniform sphere.
function fillLeafBlob(
  cells: Map<string, Voxel>,
  center: Vec3,
  size: number,
  density: number,
  segId: number,
  rng: Rng,
): void {
  // Per-tip size jitter so neighbouring tufts differ in bulk.
  const tipScale = 0.7 + rng() * 0.7; // 0.7..1.4
  const lobes = 2 + Math.floor(rng() * 3); // 2..4
  const spread = size * 0.55;
  for (let l = 0; l < lobes; l++) {
    // First lobe sits on the tip; the rest scatter around it.
    const off = l === 0 ? v(0, 0, 0) : v(
      (rng() * 2 - 1) * spread,
      (rng() * 2 - 1) * spread * 0.8,
      (rng() * 2 - 1) * spread,
    );
    const lobeR = size * tipScale * (0.55 + rng() * 0.6); // varied per lobe
    fillLeafLobe(cells, add(center, off), lobeR, density, segId, rng);
  }
}

function fillLeafLobe(
  cells: Map<string, Voxel>,
  center: Vec3,
  r: number,
  density: number,
  segId: number,
  rng: Rng,
): void {
  if (r < 0.5) return;
  const r2 = r * r;
  const minc = floorCell(center, r);
  const maxc = ceilCell(center, r);
  for (let x = minc.x; x <= maxc.x; x++) {
    for (let y = minc.y; y <= maxc.y; y++) {
      for (let z = minc.z; z <= maxc.z; z++) {
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const dz = z + 0.5 - center.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        // Noise mask, denser toward the lobe center for a crisp organic edge.
        const edge = 1 - d2 / r2;
        if (rng() < density * (0.4 + 0.6 * edge)) {
          put(cells, x, y, z, { kind: "leaf", element: LEAF_ELEMENT, segId });
        }
      }
    }
  }
}

// Wood overrides leaf at a contested cell; otherwise first writer wins.
function put(
  cells: Map<string, Voxel>,
  x: number,
  y: number,
  z: number,
  meta: { kind: "wood" | "leaf"; element: Element; segId: number },
): void {
  const k = ckey(x, y, z);
  const existing = cells.get(k);
  if (existing) {
    if (existing.kind === "wood") return;
    if (meta.kind === "leaf") return;
  }
  cells.set(k, { x, y, z, kind: meta.kind, element: meta.element, segId: meta.segId });
}

const floorCell = (c: Vec3, r: number): Cell => ({
  x: Math.floor(c.x - r),
  y: Math.floor(c.y - r),
  z: Math.floor(c.z - r),
});
const ceilCell = (c: Vec3, r: number): Cell => ({
  x: Math.ceil(c.x + r),
  y: Math.ceil(c.y + r),
  z: Math.ceil(c.z + r),
});

// Re-exported for callers that want quick spatial bounds of a voxel set.
export function voxelBounds(voxels: Voxel[]): { min: Vec3; max: Vec3 } {
  if (voxels.length === 0) return { min: v(0, 0, 0), max: v(0, 0, 0) };
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const p of voxels) {
    mnx = Math.min(mnx, p.x); mny = Math.min(mny, p.y); mnz = Math.min(mnz, p.z);
    mxx = Math.max(mxx, p.x); mxy = Math.max(mxy, p.y); mxz = Math.max(mxz, p.z);
  }
  void dist;
  return { min: v(mnx, mny, mnz), max: v(mxx, mxy, mxz) };
}
