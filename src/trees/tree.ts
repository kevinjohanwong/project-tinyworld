import {
  ageSeconds,
  DEFAULT_GROWTH,
  growthFraction,
  stageForAge,
  type GrowthConfig,
} from "./growth";
import { buildLSystem, type LSystemGenome } from "./lsystem";
import { makeRng, range } from "./rng";
import { spaceColonize, type SpaceColConfig } from "./spacecol";
import { DEFAULT_SPECIES, SPECIES } from "./species";
import {
  WOOD_ELEMENT_BY_STAGE,
  type GrowthStage,
  type Skeleton,
  type Voxel,
} from "./types";
import { add, v, type Vec3 } from "./vec";
import { voxelizeSkeleton } from "./voxelize";

// Persisted genome — the small record stored in the ledger. Voxels are
// re-derived; only this is saved (docs/procedural-trees.md "tree = f(genome, age)").
export interface LTreeGenome {
  type: "ltree";
  species: string; // key into SPECIES
  seed: number;
  plantedAtMs: number;
  lightScore?: number;
  moistureScore?: number;
  flatnessScore?: number;
  soilDepthScore?: number;
  elevationScore?: number;
  competition?: number;
  lightDirection?: [number, number];
  slopeDirection?: [number, number];
  growthStress?: number;
  pruningHistory?: number[];
}

export interface SuperTreeGenome {
  type: "supertree";
  seed: number;
  plantedAtMs: number;
  // Scanned-area cap: sets the ceiling node count. Roots span this, canopy
  // fills toward it over time. Raised by scanning (Expand), lowered by root
  // pruning (docs/procedural-trees.md).
  cap: number;
}

export type TreeGenome = LTreeGenome | SuperTreeGenome;

export interface BuildOptions {
  nowMs: number;
  growth?: GrowthConfig;
  pruneMask?: ReadonlySet<number>;
  origin?: Vec3;
  isSolid?: (p: Vec3) => boolean; // architecture/terrain awareness (super tree)
  noLeaves?: boolean; // wood only — for previewing the grade ladder / defoliated states
  // Occupancy test in tree-local voxel coords — emitted voxels landing in an
  // occupied cell (wall, ceiling, another tree) are skipped so branches carve
  // flush at surfaces instead of clipping through.
  occupied?: (x: number, y: number, z: number) => boolean;
}

export interface BuiltTree {
  voxels: Voxel[];
  skeleton: Skeleton;
  stage: GrowthStage;
  ageSec: number;
}

export function buildTree(genome: TreeGenome, opts: BuildOptions): BuiltTree {
  return genome.type === "ltree"
    ? buildLTree(genome, opts)
    : buildSuperTree(genome, opts);
}

// Stage controls both L-system iteration count and leaf-blob size.
const ITERATIONS_BY_STAGE: readonly number[] = [2, 3, 4, 5];
const LEAF_SIZE_BY_STAGE: readonly number[] = [1.5, 2.5, 4, 5];

function buildLTree(genome: LTreeGenome, opts: BuildOptions): BuiltTree {
  const cfg = opts.growth ?? DEFAULT_GROWTH;
  const ageSec = ageSeconds(genome.plantedAtMs, opts.nowMs);
  const stage = stageForAge(ageSec, cfg);
  const ls: LSystemGenome = SPECIES[genome.species] ?? SPECIES[DEFAULT_SPECIES];

  const rawSkeleton = buildLSystem(
    ls,
    ITERATIONS_BY_STAGE[stage],
    genome.seed,
    opts.origin ?? v(0, 0, 0),
  );
  const skeleton = adaptLTreeToSite(rawSkeleton, genome, stage);

  const voxels = voxelizeSkeleton(skeleton, {
    woodElement: WOOD_ELEMENT_BY_STAGE[stage],
    leafSize: LEAF_SIZE_BY_STAGE[stage],
    leafDensity: 0.6,
    seed: genome.seed ^ 0x9e3779b9,
    pruneMask: opts.pruneMask,
    noLeaves: opts.noLeaves,
    occupied: opts.occupied,
  });

  return { voxels, skeleton, stage, ageSec };
}

function adaptLTreeToSite(
  skeleton: Skeleton,
  genome: LTreeGenome,
  stage: GrowthStage,
): Skeleton {
  const light = Math.max(0, Math.min(1, genome.lightScore ?? 0.65));
  const competition = Math.max(0, Math.min(1, genome.competition ?? 0));
  const stress = Math.max(0.55, Math.min(1.1, genome.growthStress ?? 1));
  const flatness = Math.max(0, Math.min(1, genome.flatnessScore ?? 1));
  const [lightX, lightZ] = genome.lightDirection ?? [0, 0];
  const maxHeight = Math.max(
    1,
    ...skeleton.segments.flatMap((s) => [s.a.y - skeleton.root.y, s.b.y - skeleton.root.y]),
  );
  const widthScale = (0.68 + 0.46 * light) * (1 - 0.28 * competition);
  const heightScale = stress * (1.12 - 0.18 * light);
  const lean = 0.05 + 0.2 * (1 - light);
  const transform = (p: Vec3): Vec3 => {
    const dy = p.y - skeleton.root.y;
    const heightT = Math.max(0, dy / maxHeight);
    return v(
      skeleton.root.x + (p.x - skeleton.root.x) * widthScale + lightX * dy * lean * heightT,
      skeleton.root.y + dy * heightScale,
      skeleton.root.z + (p.z - skeleton.root.z) * widthScale + lightZ * dy * lean * heightT,
    );
  };
  const segments = skeleton.segments.map((s) => ({ ...s, a: transform(s.a), b: transform(s.b) }));
  const [slopeX, slopeZ] = genome.slopeDirection ?? [0, 0];
  const rootLength = (1.5 + stage * 1.15) * (0.82 + 0.28 * flatness);
  const rootRadius = 0.65 + stage * 0.28;
  let nextId = Math.max(-1, ...segments.map((s) => s.id)) + 1;
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI * 0.5 + (genome.seed % 997) * 0.001;
    const dx = Math.cos(angle) * 0.78 - slopeX * (1 - flatness) * 0.42;
    const dz = Math.sin(angle) * 0.78 - slopeZ * (1 - flatness) * 0.42;
    segments.push({
      id: nextId++,
      a: skeleton.root,
      b: v(
        skeleton.root.x + dx * rootLength,
        skeleton.root.y - (0.35 + (1 - flatness) * 1.1),
        skeleton.root.z + dz * rootLength,
      ),
      radiusA: rootRadius,
      radiusB: 0.45,
      depth: 0,
      terminal: false,
      kind: "root",
    });
  }
  return { root: skeleton.root, segments };
}

function buildSuperTree(genome: SuperTreeGenome, opts: BuildOptions): BuiltTree {
  const cfg = opts.growth ?? DEFAULT_GROWTH;
  const ageSec = ageSeconds(genome.plantedAtMs, opts.nowMs);
  const stage = stageForAge(ageSec, cfg);
  const frac = growthFraction(ageSec, cfg); // canopy fills toward cap over time
  const origin = opts.origin ?? v(0, 0, 0);

  // Trunk + primary roots fatten as the tree grows. tipRadius scales every
  // segment, and a lower radiusExp at maturity makes the da Vinci accumulation
  // (r_parent = (Σ r_child^exp)^(1/exp)) favor the trunk and main roots
  // specifically — fine twigs and rootlets stay slim, the load-bearing core
  // thickens. frac (time-based 0..1) drives both so growth is smooth.
  const canopyTip = 1.6 + 1.5 * frac; // 1.6 sapling → 3.1 ancient
  const canopyExp = 2.4 - 0.5 * frac; // 2.4 slim trunk → 1.9 fat trunk
  const rootTip = 0.9 + 0.9 * frac; //   0.9 → 1.8
  const rootExp = 2.4 - 0.6 * frac; //   2.4 → 1.8 (primary roots fatten most)

  // Canopy attractor cloud — deterministic from seed, sized by cap. When an
  // isSolid predicate is supplied, attractors snap to surface-adjacent space so
  // the canopy climbs walls/cliffs (strangler-fig) instead of floating.
  const attractors = canopyCloud(genome.seed, genome.cap, origin, opts.isSolid);
  const canopyCfg: SpaceColConfig = {
    influenceRadius: 22,
    killDistance: 6,
    segmentLength: 4,
    maxNodes: Math.max(8, Math.floor(genome.cap * frac)), // time-filled ceiling
    tipRadius: canopyTip,
    radiusExp: canopyExp,
    kind: "branch",
    isSolid: opts.isSolid,
    clearance: canopyTip + 1.5, // thick branches bend around walls, not just carve
  };
  const canopy = spaceColonize(origin, attractors, canopyCfg);

  // Roots: spread outward/down toward ground attractors. Roots track the full
  // scanned area immediately (not time-gated) — they extend first, then canopy.
  // When architecture-aware, roots hug cliff faces and descend walls instead of
  // floating — symmetric to the canopy's wall-climbing.
  const rootAttractors = rootCloud(genome.seed, genome.cap, origin, opts.isSolid);
  const rootCfg: SpaceColConfig = {
    influenceRadius: 26,
    killDistance: 7,
    segmentLength: 5,
    maxNodes: Math.max(8, genome.cap),
    tipRadius: rootTip,
    radiusExp: rootExp,
    kind: "root",
    isSolid: opts.isSolid,
    clearance: rootTip + 1.5, // thick primary roots bend around walls
  };
  const roots = spaceColonize(origin, rootAttractors, rootCfg);

  const skeleton: Skeleton = {
    root: origin,
    segments: [...canopy.segments, ...roots.segments.map(reindex(canopy.segments.length))],
  };

  const woodEl = WOOD_ELEMENT_BY_STAGE[stage];
  const canopyVox = voxelizeSkeleton(canopy, {
    woodElement: woodEl,
    leafSize: 4 + stage,
    leafDensity: 0.78,
    seed: genome.seed ^ 0x85ebca6b,
    pruneMask: opts.pruneMask,
    noLeaves: opts.noLeaves,
    occupied: opts.occupied,
  });
  const rootVox = voxelizeSkeleton(
    { root: origin, segments: skeleton.segments.slice(canopy.segments.length) },
    {
      woodElement: woodEl,
      leafSize: 0,
      leafDensity: 0,
      seed: genome.seed ^ 0xc2b2ae35,
      pruneMask: opts.pruneMask,
      noLeaves: true,
      occupied: opts.occupied,
    },
  );

  return { voxels: [...canopyVox, ...rootVox], skeleton, stage, ageSec };
}

// Re-id root segments so canopy + root segment ids stay unique across the tree.
const reindex = (offset: number) => (s: Skeleton["segments"][number]) => ({
  ...s,
  id: s.id + offset,
});

// Probe offsets used to decide whether an empty point hugs a solid surface.
// Sampled at ~one and ~two segment-lengths out so attractors sit in the band
// of open space alongside walls/cliffs/ground that branches can colonize.
const SURFACE_PROBES: Vec3[] = [
  v(3, 0, 0), v(-3, 0, 0), v(0, 0, 3), v(0, 0, -3), v(0, -3, 0), v(0, 3, 0),
  v(6, 0, 0), v(-6, 0, 0), v(0, 0, 6), v(0, 0, -6), v(0, -6, 0),
];

// A point is a surface-hugging target if it's empty but has solid within reach.
function nearSurface(p: Vec3, isSolid: (q: Vec3) => boolean): boolean {
  if (isSolid(p)) return false; // inside geometry — not a reachable target
  for (const d of SURFACE_PROBES) if (isSolid(add(p, d))) return true;
  return false;
}

function canopyCloud(
  seed: number,
  cap: number,
  origin: Vec3,
  isSolid?: (q: Vec3) => boolean,
): Vec3[] {
  const rng = makeRng(seed ^ 0x1b56c4e9);
  const n = Math.max(12, cap);
  const radius = 8 + Math.sqrt(cap) * 2.2;
  const baseHeight = 18 + Math.sqrt(cap) * 1.6;
  const pts: Vec3[] = [];
  const surface: Vec3[] = [];
  // Oversample when architecture-aware so we have enough surface-adjacent hits.
  const tries = isSolid ? n * 4 : n;
  for (let i = 0; i < tries; i++) {
    // Ellipsoidal canopy volume above the origin.
    const r = radius * Math.cbrt(rng());
    const theta = range(rng, 0, Math.PI * 2);
    const phi = Math.acos(range(rng, -0.2, 1)); // bias upward
    const x = r * Math.sin(phi) * Math.cos(theta);
    const z = r * Math.sin(phi) * Math.sin(theta);
    const y = baseHeight * 0.5 + r * Math.cos(phi) * 1.3;
    const p = add(origin, v(x, Math.max(2, y), z));
    pts.push(p);
    if (isSolid && nearSurface(p, isSolid)) surface.push(p);
    if (surface.length >= n) break;
  }
  // Prefer surface-hugging attractors so the canopy follows the architecture;
  // fall back to the free ellipsoid on open islands with no nearby structure.
  if (isSolid && surface.length >= Math.max(8, Math.floor(n * 0.25))) {
    return surface;
  }
  return pts.slice(0, n);
}

// Root probes bias downward and sideways so roots latch onto cliff faces and
// ground below, then descend them — instead of the all-directions canopy probe.
const ROOT_PROBES: Vec3[] = [
  v(3, 0, 0), v(-3, 0, 0), v(0, 0, 3), v(0, 0, -3),
  v(6, 0, 0), v(-6, 0, 0), v(0, 0, 6), v(0, 0, -6),
  v(0, -3, 0), v(0, -6, 0), v(0, -9, 0),
];

// A point is a root target if it's empty but has solid below or beside it —
// the band of open space hugging a wall, cliff face, or the ground plane.
function nearRootSurface(p: Vec3, isSolid: (q: Vec3) => boolean): boolean {
  if (isSolid(p)) return false; // inside geometry — not a reachable target
  for (const d of ROOT_PROBES) if (isSolid(add(p, d))) return true;
  return false;
}

function rootCloud(
  seed: number,
  cap: number,
  origin: Vec3,
  isSolid?: (q: Vec3) => boolean,
): Vec3[] {
  const rng = makeRng(seed ^ 0x27d4eb2f);
  const n = Math.max(12, cap);
  const radius = 10 + Math.sqrt(cap) * 3; // roots span the island
  // Architecture-aware: sample a deep vertical band so attractors exist along
  // the full cliff height for roots to descend. Open ground: stay shallow.
  const depth = isSolid ? 14 + Math.sqrt(cap) * 1.4 : 4;
  const pts: Vec3[] = [];
  const surface: Vec3[] = [];
  // Oversample when architecture-aware so we collect enough surface-adjacent hits.
  const tries = isSolid ? n * 4 : n;
  for (let i = 0; i < tries; i++) {
    const r = radius * Math.sqrt(rng());
    const theta = range(rng, 0, Math.PI * 2);
    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);
    const y = -range(rng, 0, depth); // span cliff height when aware, else shallow
    const p = add(origin, v(x, y, z));
    pts.push(p);
    if (isSolid && nearRootSurface(p, isSolid)) surface.push(p);
    if (surface.length >= n) break;
  }
  // Prefer surface-hugging attractors so roots wrap the architecture top-to-
  // bottom; fall back to the free disc on open islands with no nearby structure.
  if (isSolid && surface.length >= Math.max(8, Math.floor(n * 0.25))) {
    return surface;
  }
  return pts.slice(0, n);
}
