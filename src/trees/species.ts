import type { LSystemGenome } from "./lsystem";

// Starter species table (docs/procedural-trees.md). Species = ruleset + angles
// + palette intent; extend per biome. Bud-based grammars: `X` is a growth bud
// that branches and continues; `F` draws an internode. Segment count grows
// roughly linearly per iteration (no combinatorial explosion).
export const SPECIES: Record<string, LSystemGenome> = {
  // NYC temperate street tree — broad, balanced 3D canopy.
  nyc_honeylocust: {
    kind: "lsystem",
    axiom: "X",
    rules: { X: "F[+X][-&X][\\^X]X", F: "F" },
    angleDeg: 28,
    step: 6,
    stepFalloff: 0.82,
    baseRadius: 3.2,
    radiusFalloff: 0.62,
    jitterDeg: 8,
  },

  // PNW conifer — tall, narrow, downward branches, strong central leader.
  pnw_douglasfir: {
    kind: "lsystem",
    axiom: "X",
    rules: { X: "F[&X][/&X][\\&X]FX", F: "F" },
    angleDeg: 32,
    step: 7,
    stepFalloff: 0.8,
    baseRadius: 2.8,
    radiusFalloff: 0.58,
    jitterDeg: 5,
  },

  // Arid mesquite — short, wide, gnarled, sparse.
  arid_mesquite: {
    kind: "lsystem",
    axiom: "X",
    rules: { X: "F[++X][--^X]X", F: "F" },
    angleDeg: 38,
    step: 5,
    stepFalloff: 0.85,
    baseRadius: 2.6,
    radiusFalloff: 0.6,
    jitterDeg: 13,
  },

  // Coastal mangrove — arching prop-root silhouette, spreading low canopy.
  coastal_mangrove: {
    kind: "lsystem",
    axiom: "X",
    rules: { X: "F[&+X][&-X][&/X]FX", F: "F" },
    angleDeg: 34,
    step: 5,
    stepFalloff: 0.86,
    baseRadius: 2.4,
    radiusFalloff: 0.62,
    jitterDeg: 11,
  },
};

// The four biome regions (docs/procedural-trees.md, docs/tiny-people.md).
export const BIOME_SPECIES: readonly string[] = [
  "nyc_honeylocust",
  "pnw_douglasfir",
  "arid_mesquite",
  "coastal_mangrove",
];

export const DEFAULT_SPECIES = "nyc_honeylocust";
