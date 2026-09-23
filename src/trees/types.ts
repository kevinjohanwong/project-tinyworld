import type { Vec3 } from "./vec";

export type Element = "bloom" | "loam" | "stone" | "metal" | "densium" | "core";

// Element ladder from docs/mass-and-density.md §2 — each 4x the last.
export const DENSITY: Record<Element, number> = {
  bloom: 0.25,
  loam: 1,
  stone: 4,
  metal: 16,
  densium: 64,
  core: 256,
};

// Growth stage = age bucket. 0 sapling .. 3 ancient.
export type GrowthStage = 0 | 1 | 2 | 3;
export const STAGE_NAMES = ["sapling", "young", "mature", "ancient"] as const;

// LOCKED ladder (docs/procedural-trees.md): each stage upgrades wood one
// density tier. Ancient wood = Densium tier = "metallic wood". Trees never
// reach Core (256) — that stays press/scan-only.
export const WOOD_ELEMENT_BY_STAGE: readonly Element[] = ["loam", "stone", "metal", "densium"];

// Leaves/fruit are always Bloom, every stage (the renewable bloom output).
export const LEAF_ELEMENT: Element = "bloom";

export type VoxelKind = "wood" | "leaf";

export interface Voxel {
  x: number;
  y: number;
  z: number;
  kind: VoxelKind;
  element: Element;
  segId: number; // skeleton segment that produced this voxel (for prune-mask)
}

export type SegmentKind = "branch" | "root";

export interface Segment {
  id: number;
  a: Vec3; // start point
  b: Vec3; // end point
  radiusA: number; // radius at a
  radiusB: number; // radius at b (taper a -> b)
  depth: number; // branch hops from root
  terminal: boolean; // tip — receives a leaf blob
  kind: SegmentKind;
}

export interface Skeleton {
  root: Vec3;
  segments: Segment[];
}
