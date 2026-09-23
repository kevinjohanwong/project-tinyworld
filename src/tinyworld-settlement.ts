import type { ConstructionKind, DevelopmentGeneration } from "./tinyworld-construction";

export type SettlementPattern = "shelter" | "homestead" | "courtyard" | "cliff-village" | "district";
export type SettlementStage = "survey" | "access" | "terrain" | "buildings" | "landscape" | "inspection" | "complete";
export type ParcelStatus = "planned" | "building" | "complete" | "blocked";
export type TerrainOperationKind = "cave" | "cliff-stairs" | "terrace" | "retaining-wall";
export type LandscapeKind = "garden" | "grove" | "plaza" | "drainage";
export type PlanPoint = { dx: number; dz: number };
export type SettlementParcel = { id: string; kind: ConstructionKind; dx: number; dz: number; rotation: 0 | 1 | 2 | 3; status: ParcelStatus; dependsOn: string[] };
export type TerrainOperation = { id: string; kind: TerrainOperationKind; cells: PlanPoint[]; status: "planned" | "complete" | "blocked"; produces: "stone" | "dirt"; dependsOn: string[] };
export type LandscapeZone = { id: string; kind: LandscapeKind; cells: PlanPoint[]; status: "planned" | "complete"; dependsOn: string[] };
export type SettlementPlan = {
  id: string;
  level: DevelopmentGeneration;
  pattern: SettlementPattern;
  anchor: { vx: number; vz: number };
  stage: SettlementStage;
  status: "planned" | "active" | "inspection" | "complete" | "blocked";
  parcels: SettlementParcel[];
  paths: PlanPoint[];
  terrain: TerrainOperation[];
  landscape: LandscapeZone[];
  createdMs: number;
  inspection?: { score: number; issues: string[] };
};

const line = (ax: number, az: number, bx: number, bz: number): PlanPoint[] => {
  const out: PlanPoint[] = [], steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
  for (let i = 0; i <= steps; i++) out.push({ dx: Math.round(ax + (bx - ax) * i / Math.max(1, steps)), dz: Math.round(az + (bz - az) * i / Math.max(1, steps)) });
  return out;
};

const rect = (x0: number, z0: number, w: number, d: number): PlanPoint[] => {
  const out: PlanPoint[] = [];
  for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) out.push({ dx: x, dz: z });
  return out;
};

const unique = (cells: PlanPoint[]) => [...new Map(cells.map((c) => [`${c.dx},${c.dz}`, c])).values()];

export function settlementLevel(structures: Array<{ type: string }>, workers: number): DevelopmentGeneration {
  const homes = structures.filter((s) => ["cottage", "longhouse", "townhouse"].includes(s.type)).length;
  if (structures.some((s) => s.type === "hall") && structures.length >= 8) return 5;
  if (structures.some((s) => s.type === "watchtower") || structures.length >= 6) return 4;
  if (homes >= 2 || structures.length >= 4) return 3;
  if (structures.length >= 1 || workers >= 2) return 2;
  return 1;
}

export function createSettlementPlan(level: DevelopmentGeneration, anchor: { vx: number; vz: number }, seed: number, createdMs = 0): SettlementPlan {
  const pattern: SettlementPattern = (["shelter", "shelter", "homestead", "courtyard", "cliff-village", "district"] as SettlementPattern[])[level];
  const layouts: Record<DevelopmentGeneration, Array<[ConstructionKind, number, number, 0 | 1 | 2 | 3]>> = {
    1: [["cottage", 0, 0, 0]],
    2: [["cottage", -5, 0, 0], ["workshop", 7, 1, 2]],
    3: [["longhouse", -9, -6, 0], ["workshop", 8, -5, 2], ["townhouse", 0, 9, 3]],
    4: [["longhouse", -12, -8, 0], ["workshop", 8, -8, 2], ["townhouse", -10, 10, 1], ["watchtower", 11, 10, 3]],
    5: [["hall", 0, 0, 0], ["townhouse", -16, -12, 0], ["townhouse", 12, -12, 2], ["workshop", -16, 12, 0], ["watchtower", 14, 13, 2]],
  };
  const parcels = layouts[level].map(([kind, dx, dz, rotation], i) => ({ id: `parcel-${i + 1}`, kind, dx, dz, rotation, status: "planned" as const, dependsOn: i === 0 ? [] : ["access-main"] }));
  const paths = unique(parcels.flatMap((p) => line(0, 0, p.dx, p.dz)));
  const terrain: TerrainOperation[] = [];
  if (level >= 3) terrain.push({ id: "terrace-main", kind: "terrace", cells: rect(-5, -4, 11, 9), status: "planned", produces: "dirt", dependsOn: ["survey"] });
  if (level >= 4) {
    terrain.push({ id: "stairs-slope", kind: "cliff-stairs", cells: line(-12, -8, 11, 10), status: "planned", produces: "stone", dependsOn: ["survey"] });
    terrain.push({ id: "wall-terrace", kind: "retaining-wall", cells: line(-6, 5, 6, 5), status: "planned", produces: "stone", dependsOn: ["terrace-main"] });
    if ((seed & 1) === 0) terrain.push({ id: "cave-room", kind: "cave", cells: rect(14, -3, 6, 7), status: "planned", produces: "stone", dependsOn: ["stairs-slope"] });
  }
  const landscape: LandscapeZone[] = [
    { id: "garden-main", kind: "garden", cells: rect(-3, 3, 7, 5), status: "planned", dependsOn: [parcels[0].id] },
    ...(level >= 3 ? [{ id: "plaza-main", kind: "plaza" as const, cells: rect(-4, -3, 9, 7), status: "planned" as const, dependsOn: parcels.slice(0, 2).map((p) => p.id) }] : []),
    ...(level >= 4 ? [{ id: "drainage-main", kind: "drainage" as const, cells: line(-12, 14, 14, 14), status: "planned" as const, dependsOn: ["wall-terrace"] }] : []),
  ];
  return { id: `settlement-${level}-${seed >>> 0}`, level, pattern, anchor, stage: "survey", status: "planned", parcels, paths, terrain, landscape, createdMs };
}

export function nextSettlementParcel(plan: SettlementPlan, kind?: ConstructionKind): SettlementParcel | null {
  return plan.parcels.find((p) => p.status === "planned" && (!kind || p.kind === kind)) || plan.parcels.find((p) => p.status === "planned") || null;
}

export function advanceSettlementPlan(plan: SettlementPlan): SettlementPlan {
  const buildingsDone = plan.parcels.every((p) => p.status === "complete");
  const terrainDone = plan.terrain.every((p) => p.status === "complete");
  const landscapeDone = plan.landscape.every((p) => p.status === "complete");
  if (plan.stage === "survey") plan.stage = "access";
  else if (plan.stage === "access") plan.stage = plan.terrain.length ? "terrain" : "buildings";
  else if (plan.stage === "terrain" && terrainDone) plan.stage = "buildings";
  else if (plan.stage === "buildings" && buildingsDone) plan.stage = "landscape";
  else if (plan.stage === "landscape" && landscapeDone) plan.stage = "inspection";
  if (plan.stage === "inspection") {
    plan.inspection = inspectSettlementPlan(plan);
    if (plan.inspection.score >= 0.9) { plan.stage = "complete"; plan.status = "complete"; }
  } else plan.status = "active";
  return plan;
}

export function inspectSettlementPlan(plan: SettlementPlan): { score: number; issues: string[] } {
  const issues: string[] = [];
  if (!plan.parcels.length) issues.push("no building parcels");
  if (!plan.paths.length) issues.push("no shared path network");
  if (plan.parcels.some((p) => !plan.paths.some((c) => Math.hypot(c.dx - p.dx, c.dz - p.dz) <= 1))) issues.push("a building entrance is disconnected from the shared path");
  if (plan.terrain.some((t) => t.status === "blocked")) issues.push("blocked terrain work");
  const completion = [...plan.parcels, ...plan.terrain, ...plan.landscape].filter((x) => x.status === "complete").length / Math.max(1, plan.parcels.length + plan.terrain.length + plan.landscape.length);
  const functional = [plan.parcels.length > 0, plan.paths.length > 0, issues.length === 0].filter(Boolean).length / 3;
  return { score: completion * 0.7 + functional * 0.3, issues };
}
