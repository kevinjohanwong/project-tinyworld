import { solveWaterFlow } from "./water_flow";

const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
const solidFrom = (rows: Array<[number, number, number]>) => new Set(rows.map(([x, y, z]) => k(x, y, z)));
const run = (name: string, water: Set<string>, solid: Set<string>, center: [number, number, number], check: (out: Set<string>) => void) => {
  const out = solveWaterFlow(water, (x, y, z) => solid.has(k(x, y, z)), center, { radius: 5, maxCells: 256 });
  if (out.size !== water.size) throw new Error(`${name}: volume ${out.size} != ${water.size}`);
  check(out);
  console.log(`${name}: ${out.size} cells`, [...out].sort().join(" "));
};

run("falls into basin", new Set([k(0, 4, 0), k(1, 4, 0), k(0, 4, 1)]), solidFrom([
  [-1, 0, -1], [0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1],
]), [0, 4, 0], (out) => {
  if (![...out].every((cell) => Number(cell.split(",")[1]) === 1)) throw new Error("falls into basin: water did not pool on the floor");
});

run("spreads across floor", new Set([k(0, 1, 0), k(0, 1, 1)]), solidFrom([
  [0, 0, 0], [0, 0, 1], [-1, 0, 0], [-1, 0, 1], [1, 0, 0], [1, 0, 1],
]), [0, 1, 0], (out) => {
  if (![...out].every((cell) => Number(cell.split(",")[1]) === 1)) throw new Error("spreads across floor: water left floor");
});

run("does not enter solid cells", new Set([k(0, 2, 0)]), solidFrom([[0, 1, 0], [1, 2, 0]]), [0, 2, 0], (out) => {
  if (out.has(k(1, 2, 0)) || out.has(k(0, 1, 0))) throw new Error("solid cell occupied");
});

run("stacks when basin floor is full", new Set([k(0, 4, 0), k(0, 5, 0)]), solidFrom([[0, 0, 0]]), [0, 4, 0], (out) => {
  if (!out.has(k(0, 1, 0)) || !out.has(k(0, 2, 0))) throw new Error("water did not form a supported column");
});

run("preserves remote water", new Set([k(0, 3, 0), k(20, 7, 20)]), solidFrom([[0, 0, 0]]), [0, 3, 0], (out) => {
  if (!out.has(k(20, 7, 20))) throw new Error("remote water was deleted by local solve");
  if (!out.has(k(0, 1, 0))) throw new Error("local water did not fall");
});

run("does not exchange between disconnected ponds", new Set([k(0, 3, 0), k(4, 3, 0)]), solidFrom([[0, 0, 0], [4, 2, 0]]), [0, 3, 0], (out) => {
  if (!out.has(k(4, 3, 0))) throw new Error("disconnected pond donated its water");
  if (!out.has(k(0, 1, 0))) throw new Error("edited pond did not settle independently");
});

run("does not cross a solid barrier", new Set([k(0, 1, 0)]), solidFrom([
  [0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 2, 0],
]), [0, 1, 0], (out) => {
  if ([...out].some((cell) => Number(cell.split(",")[0]) > 1)) throw new Error("water crossed a solid barrier");
});

run("open void remains bounded", new Set([k(0, 3, 0)]), new Set(), [0, 3, 0], (out) => {
  if (!out.has(k(0, 3, 0))) throw new Error("unsupported water escaped to solver boundary");
});

console.log("water flow tests passed");
