import type { Segment, SegmentKind, Skeleton } from "./types";
import {
  add,
  dist,
  len,
  normalize,
  scale,
  sub,
  v,
  type Vec3,
} from "./vec";

// Space colonization (Runions et al. 2007): branches grow toward a cloud of
// attractor points. Used for the super tree (canopy) and its roots. The
// optional `isSolid` predicate makes growth architecture-aware: steps that
// would enter solid geometry are deflected so branches/roots hug surfaces.
export interface SpaceColConfig {
  influenceRadius: number; // a node is influenced by attractors within this
  killDistance: number; // attractors closer than this to any node are removed
  segmentLength: number; // step size per growth iteration
  maxNodes: number; // hard cap on node count (the scan-set growth ceiling)
  tipRadius: number; // radius at the tips
  radiusExp: number; // da Vinci branching exponent for radius accumulation
  kind?: SegmentKind; // "branch" (default) or "root"
  isSolid?: (p: Vec3) => boolean; // architecture/terrain obstacle test
  clearance?: number; // keep this much open space around a branch (≈ its radius)
}

interface Node {
  pos: Vec3;
  parent: number; // index into nodes, -1 for root
  children: number[];
}

export function spaceColonize(
  rootPos: Vec3,
  attractors: Vec3[],
  cfg: SpaceColConfig,
): Skeleton {
  const nodes: Node[] = [{ pos: rootPos, parent: -1, children: [] }];
  const live = attractors.map((a) => ({ ...a, dead: false }));
  const kind: SegmentKind = cfg.kind ?? "branch";

  const remaining = () => live.some((a) => !a.dead);

  for (let iter = 0; iter < cfg.maxNodes && nodes.length < cfg.maxNodes && remaining(); iter++) {
    // Associate each live attractor with its nearest node (within influence).
    const pull = new Map<number, Vec3>(); // nodeIndex -> summed unit directions
    let anyAssociation = false;

    for (const a of live) {
      if (a.dead) continue;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const d = dist(nodes[i].pos, a);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0 && bestD <= cfg.influenceRadius) {
        anyAssociation = true;
        const dir = normalize(sub(a, nodes[best].pos));
        const prev = pull.get(best) ?? v(0, 0, 0);
        pull.set(best, add(prev, dir));
      }
    }

    if (!anyAssociation) {
      // Bootstrap: grow the nearest node one step toward the centroid of the
      // remaining attractors so the trunk can reach the cloud.
      const centroid = centroidOf(live);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const d = dist(nodes[i].pos, centroid);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) break;
      const grown = step(nodes[best].pos, normalize(sub(centroid, nodes[best].pos)), cfg);
      if (!grown) break;
      pushNode(nodes, best, grown);
      continue;
    }

    // Grow one new node per influenced node, toward its averaged attractors.
    let grew = false;
    for (const [nodeIdx, summed] of pull) {
      const dir = normalize(summed);
      if (len(dir) < 1e-6) continue;
      const grown = step(nodes[nodeIdx].pos, dir, cfg);
      if (!grown) continue;
      pushNode(nodes, nodeIdx, grown);
      grew = true;
      if (nodes.length >= cfg.maxNodes) break;
    }
    if (!grew) break;

    // Kill attractors reached by any node.
    for (const a of live) {
      if (a.dead) continue;
      for (const n of nodes) {
        if (dist(n.pos, a) <= cfg.killDistance) {
          a.dead = true;
          break;
        }
      }
    }
  }

  return { root: rootPos, segments: toSegments(nodes, cfg, kind) };
}

function step(from: Vec3, dir: Vec3, cfg: SpaceColConfig): Vec3 | null {
  let candidate = add(from, scale(dir, cfg.segmentLength));
  if (cfg.isSolid && blocked(candidate, cfg)) {
    // Deflect tangentially so growth hugs the surface instead of entering it.
    const deflected = normalize(add(dir, scale(perp(dir), 0.8)));
    candidate = add(from, scale(deflected, cfg.segmentLength));
    if (blocked(candidate, cfg)) return null; // boxed in — stop this tip
  }
  return candidate;
}

// Clearance probe: a candidate is "blocked" if it (or a point within the
// branch's radius along any axis) is solid. Thicker branches (larger clearance)
// deflect earlier and farther, so the trunk bends around walls rather than the
// skeleton centreline grazing the surface and the fat radius poking through.
function blocked(p: Vec3, cfg: SpaceColConfig): boolean {
  const isSolid = cfg.isSolid!;
  if (isSolid(p)) return true;
  const c = cfg.clearance ?? 0;
  if (c <= 0) return false;
  return (
    isSolid(add(p, v(c, 0, 0))) ||
    isSolid(add(p, v(-c, 0, 0))) ||
    isSolid(add(p, v(0, c, 0))) ||
    isSolid(add(p, v(0, -c, 0))) ||
    isSolid(add(p, v(0, 0, c))) ||
    isSolid(add(p, v(0, 0, -c)))
  );
}

function pushNode(nodes: Node[], parent: number, pos: Vec3): void {
  const idx = nodes.length;
  nodes.push({ pos, parent, children: [] });
  nodes[parent].children.push(idx);
}

function centroidOf(pts: { x: number; y: number; z: number; dead?: boolean }[]): Vec3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  for (const p of pts) {
    if (p.dead) continue;
    sx += p.x;
    sy += p.y;
    sz += p.z;
    n++;
  }
  return n === 0 ? v(0, 0, 0) : v(sx / n, sy / n, sz / n);
}

// Any vector perpendicular to d (for surface-deflection).
function perp(d: Vec3): Vec3 {
  const ref = Math.abs(d.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0);
  return normalize({
    x: d.y * ref.z - d.z * ref.y,
    y: d.z * ref.x - d.x * ref.z,
    z: d.x * ref.y - d.y * ref.x,
  });
}

// Build tapered segments; radius accumulates from tips to root via the
// da Vinci rule r_parent = (Σ r_child^n)^(1/n).
function toSegments(nodes: Node[], cfg: SpaceColConfig, kind: SegmentKind): Segment[] {
  const radius = new Array(nodes.length).fill(cfg.tipRadius);
  // Process in reverse so children are computed before parents.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.children.length > 0) {
      let acc = 0;
      for (const c of n.children) acc += Math.pow(radius[c], cfg.radiusExp);
      radius[i] = Math.max(cfg.tipRadius, Math.pow(acc, 1 / cfg.radiusExp));
    }
  }

  const depthOf = computeDepths(nodes);
  const segments: Segment[] = [];
  let segId = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parent < 0) continue;
    segments.push({
      id: segId++,
      a: nodes[n.parent].pos,
      b: n.pos,
      radiusA: radius[n.parent],
      radiusB: radius[i],
      depth: depthOf[i],
      terminal: n.children.length === 0,
      kind,
    });
  }
  return segments;
}

function computeDepths(nodes: Node[]): number[] {
  const depth = new Array(nodes.length).fill(0);
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].parent >= 0) depth[i] = depth[nodes[i].parent] + 1;
  }
  return depth;
}
