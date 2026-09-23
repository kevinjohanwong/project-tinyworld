export type ConstructionKind = "cottage" | "longhouse" | "workshop" | "townhouse" | "hall" | "watchtower";
export type ConstructionStageName = "foundation" | "frame" | "walls" | "roof" | "detail";
export type ConstructionCell = { dx: number; dy: number; dz: number };
export type ConstructionStage = { name: ConstructionStageName; cells: ConstructionCell[]; material: "stone" | "dirt" };
export type DevelopmentGeneration = 1 | 2 | 3 | 4 | 5;
export type OptionalMove = "balcony" | "lantern" | "side-wing" | "stoop" | "chimney" | "entrance-frame" | "setback";
export type ConstructionTechnique = {
  id: string;
  kind: ConstructionKind;
  width: number;
  depth: number;
  wallHeight: number;
  roof: "flat" | "gable" | "stepped";
  doorSide: 0 | 1 | 2 | 3;
  revision: number;
  successes: number;
  corrections: string[];
  generation?: DevelopmentGeneration;
  floors?: number;
  bays?: number;
  moves?: OptionalMove[];
  reference?: string;
};
export type ConstructionProject = {
  id: string;
  need: "shelter" | "storage" | "work" | "gathering" | "defense" | "density";
  kind: ConstructionKind;
  techniqueId: string;
  vx: number;
  vz: number;
  rotation: 0 | 1 | 2 | 3;
  stage: number;
  status: "planned" | "building" | "inspection" | "complete" | "blocked";
  assigned: string[];
  material: string;
  createdMs: number;
  inspection?: { score: number; issues: string[] };
};

const ring = (w: number, d: number, y: number): ConstructionCell[] => {
  const out: ConstructionCell[] = [];
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) if (x === 0 || z === 0 || x === w - 1 || z === d - 1) out.push({ dx: x, dy: y, dz: z });
  return out;
};

const rotate = (c: ConstructionCell, r: number): ConstructionCell => {
  if (r === 1) return { dx: -c.dz, dy: c.dy, dz: c.dx };
  if (r === 2) return { dx: -c.dx, dy: c.dy, dz: -c.dz };
  if (r === 3) return { dx: c.dz, dy: c.dy, dz: -c.dx };
  return c;
};

const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let v = s; v = Math.imul(v ^ (v >>> 15), v | 1); v ^= v + Math.imul(v ^ (v >>> 7), v | 61); return ((v ^ (v >>> 14)) >>> 0) / 4294967296; };
};

const generationForKind = (kind: ConstructionKind): DevelopmentGeneration => ({ cottage: 1, longhouse: 2, workshop: 3, townhouse: 3, watchtower: 4, hall: 5 })[kind] as DevelopmentGeneration;

export function defaultTechnique(kind: ConstructionKind, seed = 1): ConstructionTechnique {
  const specs: Record<ConstructionKind, [number, number, number, ConstructionTechnique["roof"], number, string]> = {
    cottage: [5, 5, 4, "gable", 1, "tiny-01"],
    longhouse: [7, 9, 5, "gable", 1, "small-03"],
    workshop: [7, 7, 5, "stepped", 1, "small-02"],
    townhouse: [7, 7, 10, "flat", 2, "small-01"],
    hall: [11, 13, 6, "gable", 1, "large-01"],
    watchtower: [7, 7, 14, "stepped", 3, "tall-03"],
  };
  const [width, depth, wallHeight, roof, floors, reference] = specs[kind];
  const generation = generationForKind(kind);
  const random = seeded(seed ^ kind.length * 2654435761);
  const candidates: OptionalMove[] = generation === 1 ? ["stoop", "entrance-frame"] : generation === 2 ? ["stoop", "entrance-frame", "side-wing"] : generation === 3 ? ["balcony", "lantern", "side-wing", "entrance-frame"] : generation === 4 ? ["balcony", "lantern", "setback", "entrance-frame"] : ["lantern", "stoop", "entrance-frame", "side-wing"];
  const moveCount = Math.min(generation - 1, Math.floor(random() * 4));
  const moves = [...candidates].sort(() => random() - 0.5).slice(0, moveCount);
  return { id: `${kind}-v2-${seed >>> 0}`, kind, width, depth, wallHeight, roof, doorSide: 0, revision: 2, successes: 0, corrections: [], generation, floors, bays: Math.max(2, Math.min(5, Math.round(width / 3))), moves, reference };
}

export function compileTechnique(t: ConstructionTechnique, rotation: 0 | 1 | 2 | 3 = 0): ConstructionStage[] {
  const floor: ConstructionCell[] = [];
  for (let x = 0; x < t.width; x++) for (let z = 0; z < t.depth; z++) floor.push({ dx: x, dy: 0, dz: z });
  const frame: ConstructionCell[] = [];
  const floors = Math.max(1, t.floors || (t.wallHeight >= 9 ? 2 : 1));
  const floorHeight = Math.max(5, Math.floor(t.wallHeight / floors));
  for (const x of [0, t.width - 1]) for (const z of [0, t.depth - 1]) for (let y = 1; y <= t.wallHeight; y++) frame.push({ dx: x, dy: y, dz: z });
  for (let f = 1; f < floors; f++) for (let x = 0; x < t.width; x++) for (let z = 0; z < t.depth; z++) frame.push({ dx: x, dy: f * floorHeight, dz: z });
  const walls: ConstructionCell[] = [];
  const midX = Math.floor(t.width / 2), midZ = Math.floor(t.depth / 2);
  const bayStep = Math.max(2, Math.round((t.width - 1) / Math.max(2, t.bays || 2)));
  for (let y = 1; y <= t.wallHeight; y++) for (const c of ring(t.width, t.depth, y)) {
    const door = y <= 4 && ((t.doorSide === 0 && c.dz === 0 && Math.abs(c.dx - midX) <= 1) || (t.doorSide === 1 && c.dx === t.width - 1 && Math.abs(c.dz - midZ) <= 1) || (t.doorSide === 2 && c.dz === t.depth - 1 && Math.abs(c.dx - midX) <= 1) || (t.doorSide === 3 && c.dx === 0 && Math.abs(c.dz - midZ) <= 1));
    const localY = ((y - 1) % floorHeight) + 1;
    const windowHeight = localY === 2 || localY === 3;
    const windowBay = (c.dx % bayStep === 0 || c.dz % bayStep === 0) && !(c.dx === 0 || c.dx === t.width - 1) !== !(c.dz === 0 || c.dz === t.depth - 1);
    const corner = (c.dx === 0 || c.dx === t.width - 1) && (c.dz === 0 || c.dz === t.depth - 1);
    if (!door && !corner && !(windowHeight && windowBay)) walls.push(c);
  }
  const roof: ConstructionCell[] = [];
  if (t.roof === "flat") {
    for (let x = 0; x < t.width; x++) for (let z = 0; z < t.depth; z++) roof.push({ dx: x, dy: t.wallHeight + 1, dz: z });
  } else {
    const acrossX = t.width <= t.depth, span = acrossX ? t.width : t.depth, ridge = Math.floor((span - 1) / 2);
    for (let x = 0; x < t.width; x++) for (let z = 0; z < t.depth; z++) {
      const a = acrossX ? x : z;
      const rise = t.roof === "stepped" ? Math.floor(Math.max(0, ridge - Math.abs(a - ridge)) / 2) + 1 : Math.max(1, ridge - Math.abs(a - ridge) + 1);
      roof.push({ dx: x, dy: t.wallHeight + rise, dz: z });
    }
  }
  const detail: ConstructionCell[] = [];
  const moves = new Set(t.moves || []);
  if (moves.has("stoop")) for (let x = midX - 1; x <= midX + 1; x++) detail.push({ dx: x, dy: 1, dz: -1 });
  if (moves.has("entrance-frame")) for (let y = 1; y <= 5; y++) for (const x of [midX - 2, midX + 2]) detail.push({ dx: x, dy: y, dz: 0 });
  if (moves.has("balcony") && t.wallHeight >= 8) {
    for (let x = 1; x < t.width - 1; x++) detail.push({ dx: x, dy: floorHeight + 1, dz: -1 });
    for (const x of [1, t.width - 2]) for (let y = 1; y <= floorHeight; y++) detail.push({ dx: x, dy: y, dz: -1 });
  }
  if (moves.has("side-wing")) {
    for (let x = t.width; x <= t.width + 2; x++) for (let z = 1; z <= 3; z++) detail.push({ dx: x, dy: 0, dz: z });
    for (let y = 1; y <= 4; y++) for (let x = t.width; x <= t.width + 2; x++) for (let z = 1; z <= 3; z++) if (x === t.width + 2 || z === 1 || z === 3) detail.push({ dx: x, dy: y, dz: z });
    for (let x = t.width; x <= t.width + 2; x++) for (let z = 1; z <= 3; z++) detail.push({ dx: x, dy: 5, dz: z });
  }
  if (moves.has("lantern")) {
    const roofTop = Math.max(...roof.filter((c) => Math.abs(c.dx - midX) <= 1 && Math.abs(c.dz - midZ) <= 1).map((c) => c.dy));
    for (let x = midX - 1; x <= midX + 1; x++) for (let z = midZ - 1; z <= midZ + 1; z++) detail.push({ dx: x, dy: roofTop + 1, dz: z });
  }
  if (moves.has("chimney")) for (let y = t.wallHeight + 1; y <= t.wallHeight + 4; y++) detail.push({ dx: 1, dy: y, dz: 1 });
  const stages: ConstructionStage[] = [
    { name: "foundation", cells: floor, material: "stone" },
    { name: "frame", cells: frame, material: "stone" },
    { name: "walls", cells: walls, material: "dirt" },
    { name: "roof", cells: roof, material: "stone" },
    { name: "detail", cells: detail, material: "stone" },
  ];
  return stages.filter((s) => s.cells.length > 0).map((s) => ({ ...s, cells: s.cells.map((c) => rotate(c, rotation)) }));
}

export function settlementNeed(structures: Array<{ type: string }>, workers: number): ConstructionProject["need"] {
  const count = (s: string[]) => structures.filter((x) => s.includes(x.type)).length;
  if (count(["hut", "cottage", "longhouse", "townhouse"]) < Math.max(1, Math.ceil(workers / 2))) return "shelter";
  if (count(["workshop"]) < Math.max(1, Math.floor(workers / 3))) return "work";
  if (count(["hall"]) < 1 && workers >= 3) return "gathering";
  if (count(["watchtower"]) < 1 && structures.length >= 4) return "defense";
  return structures.length % 3 === 0 ? "storage" : "density";
}

export function kindForNeed(need: ConstructionProject["need"], structures: number): ConstructionKind {
  if (need === "shelter") return structures > 3 ? "townhouse" : structures > 0 ? "longhouse" : "cottage";
  if (need === "work" || need === "storage") return "workshop";
  if (need === "gathering") return "hall";
  if (need === "defense") return "watchtower";
  return "townhouse";
}

export function teachTechnique(base: ConstructionTechnique, instruction: string): ConstructionTechnique {
  const t = { ...base, moves: [...(base.moves || [])], corrections: [...base.corrections, instruction.slice(0, 120)], revision: base.revision + 1 };
  const s = instruction.toLowerCase();
  if (/wider|more room|larger/.test(s)) t.width = Math.min(15, t.width + 2);
  if (/deeper|longer/.test(s)) t.depth = Math.min(17, t.depth + 2);
  if (/taller|more floors/.test(s)) { t.wallHeight = Math.min(18, t.wallHeight + 5); t.floors = Math.min(3, (t.floors || 1) + 1); }
  if (/lower|shorter/.test(s)) t.wallHeight = Math.max(4, t.wallHeight - 1);
  if (/flat roof/.test(s)) t.roof = "flat";
  if (/gable|pitched|sloped roof/.test(s)) t.roof = "gable";
  if (/stepped roof/.test(s)) t.roof = "stepped";
  const moveMap: Array<[RegExp, OptionalMove]> = [[/balcony|gallery/, "balcony"], [/lantern/, "lantern"], [/side wing|extension/, "side-wing"], [/porch|stoop/, "stoop"], [/chimney|vent/, "chimney"], [/entrance frame|portal/, "entrance-frame"], [/setback/, "setback"]];
  for (const [pattern, move] of moveMap) if (pattern.test(s) && !t.moves!.includes(move) && t.moves!.length < 3) t.moves!.push(move);
  return t;
}

export function inspectProject(project: ConstructionProject, stages: ConstructionStage[], placed: Set<string>): { score: number; issues: string[] } {
  const required = stages.flatMap((s) => s.cells).map((c) => `${project.vx + c.dx},${c.dy},${project.vz + c.dz}`);
  const present = required.filter((k) => placed.has(k)).length;
  const completion = required.length ? present / required.length : 0;
  const techniqueCells = stages.flatMap((s) => s.cells);
  const foundation = stages.find((s) => s.name === "foundation")?.cells || [];
  const roof = stages.find((s) => s.name === "roof")?.cells || [];
  const wallCells = stages.find((s) => s.name === "walls")?.cells || [];
  const maxWallY = Math.max(0, ...wallCells.map((c) => c.dy));
  const minX = Math.min(...foundation.map((c) => c.dx)), maxX = Math.max(...foundation.map((c) => c.dx));
  const minZ = Math.min(...foundation.map((c) => c.dz)), maxZ = Math.max(...foundation.map((c) => c.dz));
  const hollow = maxX - minX >= 4 && maxZ - minZ >= 4 && maxWallY >= 4;
  const solid = new Set(techniqueCells.map((c) => `${c.dx},${c.dy},${c.dz}`));
  let doorway = false;
  for (let x = minX; x <= maxX && !doorway; x++) for (let z = minZ; z <= maxZ && !doorway; z++) {
    const boundary = x === minX || x === maxX || z === minZ || z === maxZ;
    if (!boundary) continue;
    for (const [ax, az] of [[1, 0], [0, 1]] as const) if ([1, 2, 3, 4].every((y) => !solid.has(`${x},${y},${z}`)) && [1, 2, 3, 4].every((y) => !solid.has(`${x + ax},${y},${z + az}`))) doorway = true;
  }
  const issues: string[] = [];
  if (completion < 0.98) issues.push(`${required.length - present} planned blocks missing`);
  if (!foundation.length) issues.push("no supported foundation stage");
  if (!roof.length) issues.push("no weatherproof roof stage");
  if (!hollow) issues.push("no worker-sized hollow room");
  if (!doorway) issues.push("no 2x4 navigable doorway");
  const functional = [foundation.length > 0, roof.length > 0, hollow, doorway].filter(Boolean).length / 4;
  return { score: completion * 0.8 + functional * 0.2, issues };
}
