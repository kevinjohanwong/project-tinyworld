// Channel-depth A/B against the LIVE fluid core (docs/water-physics-plan.md).
// KJ: "build a deeper channel outlet… see if the river flows deeper."
// Claim: on a graded channel with an escape, water stays a ~1-deep sheet; force
// the SAME discharge through a NARROW slot and it must run deeper (conveyance
// Q = width x depth x velocity). This drives stepFluid over the slope bed (wide
// 7-cell channel) and the canyon bed (one channel tapering 4 → 1) with an IDENTICAL steady
// inflow and compares steady-state channel column depth. Run: bun tools/test_channel_depth.ts
import { stepFluid, type MomentumCell } from "../src/water-spring";

const N = 64, FLOOR_Y = 2, MID = N / 2;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

// ── Terrain top height, replicated from the generators in tw-staging-app.tsx ──
function slopeH(x: number, z: number): number {
  const PLATEAU_END = 14, BASIN_END = 30, CHANNEL_END = 52, PLAIN_END = 62;
  let h: number;
  if (x < PLATEAU_END) h = 16;
  else if (x < BASIN_END) h = 9;
  else if (x < CHANNEL_END) h = Math.round(11 - ((x - BASIN_END) / (CHANNEL_END - BASIN_END)) * 5);
  else if (x < PLAIN_END) h = 5;
  else h = 3;
  if (x >= BASIN_END - 2 && x < BASIN_END) h = 12;
  if (x >= PLATEAU_END && x < BASIN_END && Math.abs(z - MID) > 9) h = Math.max(h, 15);
  if (x >= BASIN_END && x < PLAIN_END && Math.abs(z - MID) > 3) h = Math.max(h, 14);
  return Math.max(FLOOR_Y + 1, h);
}
function canyonH(x: number, z: number): number {
  const PLATEAU_END = 12, BASIN_END = 28, CANYON_END = 58, PLAIN_END = 61, MESA_Y = 17;
  const width = x < BASIN_END ? 4 : x >= CANYON_END ? 1 : Math.max(1, 4 - Math.floor(((x - BASIN_END) / (CANYON_END - BASIN_END - 1)) * 3 + 1e-9));
  const z0 = MID - Math.floor(width / 2);
  const inChannel = z >= z0 && z < z0 + width;
  let h: number;
  if (x < PLATEAU_END) h = 16;
  else if (x < BASIN_END) h = 9;
  else if (x < CANYON_END) h = Math.round(11 - ((x - BASIN_END) / (CANYON_END - BASIN_END)) * 4);
  else if (x < PLAIN_END) h = 5;
  else h = 3;
  if (x >= BASIN_END - 2 && x < BASIN_END) h = 12;
  if (x >= PLATEAU_END && x < BASIN_END && Math.abs(z - MID) > 9) h = Math.max(h, 15);
  if (x >= BASIN_END && x < PLAIN_END && !inChannel) h = Math.max(h, MESA_Y);
  return Math.max(FLOOR_Y + 1, h);
}

// isSolid: FLOOR_Y..topH inclusive is ground UP TO the cliff; at/after cliffX the
// terrain ends (open void → an "island edge") so water pouring off it falls below
// floorY and CULLS. Without this the body can never reach a discharge-limited
// steady state — it just floods everything (the real beds cull off their low shore).
const solidFor = (H: (x: number, z: number) => number, cliffX: number) =>
  (x: number, y: number, z: number) => x >= 0 && x < cliffX && z >= 0 && z < N && y >= FLOOR_Y && y <= H(x, z);

// Production stepFluid options (mirrored from water-spring-runtime.ts).
const momDefaults = { inject: 1, frictionRest: 0.7, frictionDeep: 0.35, frictionFlow: 0.92, weirK: 1, weirRes: 1.2, headK: 1, headMax: 12, maxSpeed: 6, biasMin: 0.3 };
const baseOpts = { floorY: FLOOR_Y, spreadRange: 16, maxScan: 200, edgeHold: 5, maxDrainPerCol: 1, bounds: { minX: 0, maxX: N - 1, minZ: 0, maxZ: N - 1 } };

// Steady inflow: each tick, add `n` cells at the lowest free cell of a 3x3 basin patch.
function inject(water: Set<string>, isSolid: (x: number, y: number, z: number) => boolean, patch: Array<[number, number]>, n: number) {
  let added = 0;
  for (let i = 0; added < n && i < n * 6; i++) {
    const [sx, sz] = patch[i % patch.length];
    let y = FLOOR_Y;
    while ((isSolid(sx, y, sz) || water.has(key(sx, y, sz))) && y < 45) y++;
    if (y >= 45) continue;
    water.add(key(sx, y, sz)); added++;
  }
}

function run(name: string, H: (x: number, z: number) => number, basinCenterX: number, channel: [number, number], cliffX: number, ticks: number, inflow: number) {
  const isSolid = solidFor(H, cliffX);
  const patch: Array<[number, number]> = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) patch.push([basinCenterX + dx, MID + dz]);
  let water = new Set<string>();
  const field = new Map<string, MomentumCell>();
  const dwell = new Map<string, number>();
  const samples: Array<{ maxD: number; meanD: number; cols: number; basinMax: number; chanCells: number }> = [];
  const SAMPLE_FROM = ticks - 200;
  for (let t = 0; t < ticks; t++) {
    inject(water, isSolid, patch, inflow);
    water = stepFluid(water, isSolid, { ...baseOpts, tick: t, momentum: { field, ...momDefaults, stats: { drops: 0, overtops: 0 } } });
    if (t >= SAMPLE_FROM) {
      // channel column depths + basin max depth
      const chan = new Map<string, number>();
      const basin = new Map<string, number>();
      for (const c of water) {
        const [x, , z] = c.split(",").map(Number);
        if (x >= channel[0] && x < channel[1]) { const kk = `${x},${z}`; chan.set(kk, (chan.get(kk) ?? 0) + 1); }
        if (x >= (name === "slope" ? 14 : 12) && x < (name === "slope" ? 30 : 28)) { const kk = `${x},${z}`; basin.set(kk, (basin.get(kk) ?? 0) + 1); }
      }
      const cv = [...chan.values()];
      const bv = [...basin.values()];
      samples.push({
        maxD: cv.length ? Math.max(...cv) : 0,
        meanD: cv.length ? cv.reduce((s, x) => s + x, 0) / cv.length : 0,
        cols: cv.length,
        basinMax: bv.length ? Math.max(...bv) : 0,
        chanCells: cv.reduce((s, x) => s + x, 0),
      });
    }
  }
  const avg = (f: (s: typeof samples[0]) => number) => samples.reduce((s, x) => s + f(x), 0) / samples.length;
  const r = {
    channelMaxDepth: Math.round(avg(s => s.maxD) * 100) / 100,
    channelMeanDepth: Math.round(avg(s => s.meanD) * 100) / 100,
    channelCols: Math.round(avg(s => s.cols)),
    channelWaterCells: Math.round(avg(s => s.chanCells)),
    basinMaxDepth: Math.round(avg(s => s.basinMax) * 100) / 100,
    bodySize: water.size,
  };
  console.log(`\n[${name}] steady-state (avg last 200 of ${ticks} ticks, inflow ${inflow}/tick):`);
  console.log(`  channel:  maxDepth=${r.channelMaxDepth}  meanDepth=${r.channelMeanDepth}  cols=${r.channelCols}  cells=${r.channelWaterCells}`);
  console.log(`  basin:    maxDepth=${r.basinMaxDepth}   bodySize=${r.bodySize}`);
  return r;
}

const TICKS = 1600, INFLOW = 5;
// Cliff = the open shore edge of each bed (terrain ends → water culls off it).
const slope = run("slope", slopeH, 22, [30, 52], 62, TICKS, INFLOW);
const canyon = run("canyon", canyonH, 20, [28, 58], 61, TICKS, INFLOW);

console.log("\n=== VERDICT ===");
// "Runs deeper" = the flowing channel carries more vertical water per column.
// meanDepth is the honest measure (maxDepth is dominated by backed-up water at
// the lip, not the channel run). Steady state is real only if culling balances
// inflow — bodySize must be well under inflow×ticks (= flooded, no outflow).
const steady = (r: typeof slope) => r.bodySize < INFLOW * TICKS * 0.9;
console.log(`  slope  channel meanDepth ${slope.channelMeanDepth} over ${slope.channelCols} cols (wide 7-cell channel); bodySize ${slope.bodySize}${steady(slope) ? " (steady, culling)" : " (STILL FLOODING)"}`);
console.log(`  canyon channel meanDepth ${canyon.channelMeanDepth} over ${canyon.channelCols} cols (single 4→1 tapered channel); bodySize ${canyon.bodySize}${steady(canyon) ? " (steady, culling)" : " (STILL FLOODING)"}`);
const deeper = canyon.channelMeanDepth > slope.channelMeanDepth;
const confined = canyon.channelCols < slope.channelCols;
console.log(`  narrower slot runs DEEPER for the same inflow: ${deeper ? "YES ✓" : "NO ✗"}  (${slope.channelMeanDepth} → ${canyon.channelMeanDepth}, ${Math.round((canyon.channelMeanDepth / slope.channelMeanDepth - 1) * 100)}%)`);
console.log(`  and more CONFINED (fewer flooded columns): ${confined ? "YES ✓" : "NO ✗"}  (${slope.channelCols} → ${canyon.channelCols})`);
if (!steady(slope) || !steady(canyon)) { console.error("FAIL: a bed never reached discharge-limited steady state (flooded)"); process.exit(1); }
if (!deeper) { console.error("FAIL: canyon slot did not run deeper than the wide slope channel"); process.exit(1); }
console.log("PASS");
