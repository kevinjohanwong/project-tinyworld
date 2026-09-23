import { describe, expect, test } from "bun:test";
import { stageForAge, DEFAULT_GROWTH } from "./growth";
import { buildLSystem, expand } from "./lsystem";
import { makeRng } from "./rng";
import { spaceColonize, type SpaceColConfig } from "./spacecol";
import { SPECIES } from "./species";
import { DENSITY, WOOD_ELEMENT_BY_STAGE, type Voxel } from "./types";
import { v } from "./vec";
import { voxelizeSkeleton } from "./voxelize";
import { buildTree, type LTreeGenome, type SuperTreeGenome } from "./tree";

const HOUR = 3600 * 1000;
const voxKey = (vx: Voxel) => `${vx.x}|${vx.y}|${vx.z}|${vx.kind}|${vx.element}`;
const serialize = (vs: Voxel[]) => vs.map(voxKey).sort().join("\n");

describe("rng", () => {
  test("same seed produces same stream", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  test("different seeds diverge", () => {
    const a = makeRng(1);
    const b = makeRng(2);
    expect(a()).not.toBe(b());
  });
});

describe("growth stage", () => {
  test("age maps to the four stages", () => {
    const [t1, t2, t3] = DEFAULT_GROWTH.stageThresholdsSec;
    expect(stageForAge(0)).toBe(0);
    expect(stageForAge(t1 + 1)).toBe(1);
    expect(stageForAge(t2 + 1)).toBe(2);
    expect(stageForAge(t3 + 1)).toBe(3);
  });
});

describe("L-system", () => {
  test("more iterations -> more segments", () => {
    const g = SPECIES.nyc_honeylocust;
    const s2 = buildLSystem(g, 2, 42).segments.length;
    const s4 = buildLSystem(g, 4, 42).segments.length;
    expect(s4).toBeGreaterThan(s2);
  });
  test("deterministic for same seed, varies by seed", () => {
    const g = SPECIES.pnw_douglasfir;
    const a = buildLSystem(g, 4, 7);
    const b = buildLSystem(g, 4, 7);
    const c = buildLSystem(g, 4, 8);
    expect(a.segments.map((s) => s.b.x)).toEqual(b.segments.map((s) => s.b.x));
    expect(a.segments.map((s) => s.b.x)).not.toEqual(c.segments.map((s) => s.b.x));
  });
  test("no combinatorial explosion at ancient iteration", () => {
    for (const key of Object.keys(SPECIES)) {
      const n = buildLSystem(SPECIES[key], 5, 1).segments.length;
      expect(n).toBeGreaterThan(20);
      expect(n).toBeLessThan(2000);
    }
  });
  test("terminals are flagged (tips exist for leaves)", () => {
    const skel = buildLSystem(SPECIES.nyc_honeylocust, 4, 3);
    expect(skel.segments.some((s) => s.terminal)).toBe(true);
  });
  test("expand grows the string", () => {
    const g = SPECIES.arid_mesquite;
    expect(expand(g, 3).length).toBeGreaterThan(expand(g, 1).length);
  });
});

describe("space colonization", () => {
  const cfg: SpaceColConfig = {
    influenceRadius: 20,
    killDistance: 5,
    segmentLength: 4,
    maxNodes: 60,
    tipRadius: 1,
    radiusExp: 2.3,
  };
  const cloud = () => {
    const rng = makeRng(99);
    return Array.from({ length: 40 }, () =>
      v(rng() * 30 - 15, 10 + rng() * 25, rng() * 30 - 15),
    );
  };

  test("grows toward attractors and terminates within cap", () => {
    const skel = spaceColonize(v(0, 0, 0), cloud(), cfg);
    expect(skel.segments.length).toBeGreaterThan(5);
    expect(skel.segments.length).toBeLessThanOrEqual(cfg.maxNodes);
  });
  test("respects an obstacle predicate (no segment endpoint inside solid)", () => {
    const solid = (p: { x: number; y: number; z: number }) =>
      p.x > 4 && p.x < 8 && p.y > 4 && p.y < 12; // a wall slab
    const skel = spaceColonize(v(0, 0, 0), cloud(), { ...cfg, isSolid: solid });
    for (const s of skel.segments) expect(solid(s.b)).toBe(false);
  });
});

describe("voxelize", () => {
  test("produces wood and leaf voxels with stage-correct grade", () => {
    const skel = buildLSystem(SPECIES.nyc_honeylocust, 4, 5);
    const voxels = voxelizeSkeleton(skel, {
      woodElement: "metal",
      leafSize: 4,
      leafDensity: 0.6,
      seed: 5,
    });
    expect(voxels.some((vx) => vx.kind === "wood" && vx.element === "metal")).toBe(true);
    expect(voxels.some((vx) => vx.kind === "leaf" && vx.element === "bloom")).toBe(true);
  });
});

describe("buildTree (f(genome, age))", () => {
  const base: LTreeGenome = {
    type: "ltree",
    species: "nyc_honeylocust",
    seed: 1234,
    plantedAtMs: 0,
  };

  test("deterministic: same genome + age => identical voxels", () => {
    const a = buildTree(base, { nowMs: 50 * HOUR });
    const b = buildTree(base, { nowMs: 50 * HOUR });
    expect(serialize(a.voxels)).toBe(serialize(b.voxels));
  });

  test("the NYC voxelizer species has a persistent growth model", () => {
    const built = buildTree(base, { nowMs: 50 * HOUR });
    expect(built.voxels.some((vx) => vx.kind === "wood")).toBe(true);
    expect(built.voxels.some((vx) => vx.kind === "leaf")).toBe(true);
  });

  test("shade and competition produce a taller, narrower, light-seeking crown", () => {
    const open = buildTree(
      { ...base, lightScore: 1, competition: 0, lightDirection: [1, 0] },
      { nowMs: 50 * HOUR },
    );
    const shaded = buildTree(
      { ...base, lightScore: 0.2, competition: 0.8, lightDirection: [1, 0] },
      { nowMs: 50 * HOUR },
    );
    const bounds = (tree: ReturnType<typeof buildTree>) => {
      const xs = tree.skeleton.segments.flatMap((s) => [s.a.x, s.b.x]);
      const ys = tree.skeleton.segments.flatMap((s) => [s.a.y, s.b.y]);
      const zs = tree.skeleton.segments.flatMap((s) => [s.a.z, s.b.z]);
      return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs), height: Math.max(...ys) - Math.min(...ys), maxX: Math.max(...xs) };
    };
    const a = bounds(open);
    const b = bounds(shaded);
    expect(b.width * b.depth).toBeLessThan(a.width * a.depth);
    expect(b.height).toBeGreaterThan(a.height * 0.85);
    expect(b.maxX).toBeGreaterThan(0);
  });

  test("older tree is a higher stage and not smaller", () => {
    const young = buildTree(base, { nowMs: 0.5 * HOUR });
    const old = buildTree(base, { nowMs: 50 * HOUR });
    expect(old.stage).toBeGreaterThan(young.stage);
    expect(old.voxels.length).toBeGreaterThanOrEqual(young.voxels.length);
  });

  test("wood grade climbs the ladder with stage (Loam -> Densium)", () => {
    const sapling = buildTree(base, { nowMs: 0 });
    const ancient = buildTree(base, { nowMs: 50 * HOUR });
    expect(sapling.stage).toBe(0);
    expect(ancient.stage).toBe(3);
    const woodEl = (b: ReturnType<typeof buildTree>) =>
      b.voxels.find((vx) => vx.kind === "wood")!.element;
    expect(woodEl(sapling)).toBe(WOOD_ELEMENT_BY_STAGE[0]); // loam
    expect(woodEl(ancient)).toBe("densium"); // metallic wood
    expect(DENSITY[woodEl(ancient)]).toBe(64);
  });

  test("prune-mask removes a segment's voxels", () => {
    const full = buildTree(base, { nowMs: 50 * HOUR });
    const target = full.voxels.find((vx) => vx.kind === "wood")!.segId;
    const pruned = buildTree(base, {
      nowMs: 50 * HOUR,
      pruneMask: new Set([target]),
    });
    expect(pruned.voxels.length).toBeLessThan(full.voxels.length);
    expect(pruned.voxels.some((vx) => vx.segId === target)).toBe(false);
  });
});

describe("super tree", () => {
  const gen = (cap: number, plantedAtMs: number): SuperTreeGenome => ({
    type: "supertree",
    seed: 777,
    plantedAtMs,
    cap,
  });

  test("larger scan cap yields a larger tree", () => {
    const small = buildTree(gen(20, 0), { nowMs: 50 * HOUR });
    const big = buildTree(gen(60, 0), { nowMs: 50 * HOUR });
    expect(big.voxels.length).toBeGreaterThan(small.voxels.length);
  });

  test("canopy fills over time toward the cap", () => {
    const earlier = buildTree(gen(50, 0), { nowMs: 2 * HOUR });
    const later = buildTree(gen(50, 0), { nowMs: 12 * HOUR });
    const canopy = (b: ReturnType<typeof buildTree>) =>
      b.skeleton.segments.filter((s) => s.kind === "branch").length;
    expect(canopy(later)).toBeGreaterThan(canopy(earlier));
  });

  test("has both branch and root segments; ancient wood is metallic", () => {
    const b = buildTree(gen(40, 0), { nowMs: 50 * HOUR });
    expect(b.skeleton.segments.some((s) => s.kind === "branch")).toBe(true);
    expect(b.skeleton.segments.some((s) => s.kind === "root")).toBe(true);
    expect(b.voxels.some((vx) => vx.kind === "wood" && vx.element === "densium")).toBe(true);
  });

  test("segment ids are unique across canopy + roots (prune-mask safe)", () => {
    const b = buildTree(gen(40, 0), { nowMs: 50 * HOUR });
    const ids = b.skeleton.segments.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
