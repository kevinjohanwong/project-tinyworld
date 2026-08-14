// Runtime glue for the rain-fed spring, composed from the pure, tested core in
// water-spring.ts. This owns only the parts that need the live scene: building
// the private water meshes, siting the spring on an existing ceiling outlet,
// and the throttled rain->emit->settle tick. Fluid physics lives in
// ./water-spring and is unit
// tested offline (tools/test_water_spring.ts).
//
// Design constraints proven against tw-staging-app.tsx:
//  - addLayer sizes each mesh to exactly its cells, so spring water needs its
//    OWN capped mesh (cap = reservoir capacity).
//  - snapshotLiveLayers serializes any mesh with userData.layer+slotMap, so the
//    spring meshes are scene-only (no layer/slotMap exposed) and regenerated
//    deterministically from a persisted seed each load (the superTree pattern).
//    Only meta.spring {version, seed, origin, budget, capacity} persists.

import {
  emitterCell, applyRain, springEmit, emitAndSettle, stepFluid,
  type Vec3, type SpringState, type MomentumCell,
} from "@/water-spring";
import { installWaterSurface } from "@/water-surface-shader";

export type SpringMeta = {
  version: number;
  seed: number;
  origin: { x: number; y: number; z: number };
  budget: number;
  capacity: number;
};

export type SpringContext = {
  THREE: any;
  scene: any;
  colMap: Map<string, Set<number>>;
  addCol: (x: number, y: number, z: number) => void;
  voxel: number;
  cellSize: number;          // voxel * BLOCK_SCALE (matches other layers' boxes)
  cxRound: number;
  czRound: number;
  waterColor: number;        // PAL.water
  meta: Record<string, any>; // persisted world meta; we write meta.spring
  worldSeed: number;         // deterministic per-world seed source
  params: URLSearchParams;
  // Optional extra solidity test beyond colMap — the app passes latentSolidAt
  // so water rests on the latent underside instead of streaming through
  // visible-crust gaps (colMap holds only drawn voxels; the latent fill is
  // solid ground the sim must respect).
  extraSolid?: (x: number, y: number, z: number) => boolean;
  // Latent column tops ("x,z" -> highest un-spent latent y). Latent mass is
  // real terrain (KJ ruling, Aug 13): siting must see a latent-only mass
  // (mesa, building fill) as ground, same view the pwater route march gets.
  extraColTops?: Map<string, number>;
};

const KEY = (x: number, y: number, z: number) => `${x},${y},${z}`;
const KEYXZ = (x: number, z: number) => `${x},${z}`;
const HDIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Cheap deterministic 32-bit mix so a world id yields a stable seed.
function mix32(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) | 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createSpring(ctx: SpringContext) {
  const {
    THREE, scene, colMap, voxel, cellSize,
    cxRound, czRound, waterColor, meta, params, extraSolid, extraColTops,
  } = ctx;

  const num = (name: string, dflt: number) => {
    const v = params.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  const CEIL_BAND = num("springband", 3);   // how far below the top counts as "surface"
  const DEBUG_CAPACITY = meta.debugWorld === true ? 250000 : 50000;
  const CAPACITY = Math.max(1, Math.round(num("springcap", DEBUG_CAPACITY))); // debug beds need room to reach an emergent equilibrium; production retains the 50k safety ceiling. Override with ?springcap=N.
  const RAIN_K = num("springraink", 32);    // precip(mm) -> water cells per rainy tick (4x)
  const TICK_MS = num("springtickms", 260); // throttle: rain-funding cadence
  const PER_TICK = num("springpertick", 8); // cells emitted per funded emit tick (4x: denser fall)

  // ── cellular-automata flow ────────────────────────────────────────────────
  // With CA on (default), water flows one cell/step: it ticks DOWN from the
  // source, spreads outward, self-levels, and pours off edges — so it can never
  // tower on open ground. `?cawater=0` reverts to the old instant resting-solve.
  const CA_ON = params.get("cawater") !== "0";
  const EMIT_MS = num("springemitms", 140);  // source dribble cadence
  const FLOW_MS = num("springflowms", 90);   // CA advance cadence (smaller = faster water)
  const FLOW_DROP = num("springflowdrop", 26); // cells a fall drops into the void before culling
  const SPREAD_RANGE = num("springspread", 16); // how far water searches for a drop/edge
  const MAX_SCAN = num("springscan", 200);      // per-cell BFS visit cap (perf guard)
  const SEED_CAP = num("springseedcap", 220);   // max cells to pre-settle at load (prime cost guard)
  // Cascade polish (Jul 18): crest-dwell holds water briefly at a spill lip;
  // falling cells render as a spray of small sub-voxels that reform into full
  // voxels on landing. Both CA-only; render split is matter-neutral.
  const EDGE_HOLD = Math.max(0, Math.round(num("springedgehold", 5))); // ~0.5s at FLOW_MS 90
  // Per-mouth drain cap: max cells that may descend through one (x,z) column per
  // tick. 1 = flattest (water fills horizontal volume before drilling a hole);
  // higher = livelier drain. Tunable with ?springdraincap=N.
  const DRAIN_CAP = Math.max(1, Math.round(num("springdraincap", 1)));
  // ── momentum field (Phase 1, water-physics-plan.md) ──────────────────────
  // Coarse per-cell velocity measured from recent CA moves (front-tracking).
  // It only WEIGHTS choices the CA already makes: descent injects speed, rest
  // and deep pools decay it (hydraulic jump), and at spill lips / drain mouths
  // accumulated speed overtops the lip resistance and widens the drain quota
  // (stream power). `?momentum=0` ⇒ bit-identical to the classic CA.
  let momEnabled = CA_ON && params.get("momentum") !== "0";
  // HYDROSTATIC lateral rule: replaces the BFS "seek a distant drop" spread with real
  // head-gradient flow (calm emerges from zero gradient; buried water discharges out
  // its own level = full hydrostatic pressure). `?pressure=0` ⇒ the classic BFS spread.
  let hydroEnabled = CA_ON && params.get("pressure") !== "0";
  // FORWARD DISCHARGE (KJ, replaces the old probabilistic carry): a cell that would drop
  // into a just-vacated hole instead rides FORWARD when the column below moved sideways
  // AND the water carries real momentum. How many cross per tick is a mass-conserving
  // head+speed budget (deterministic, not a dice), so a fed channel holds depth as a body
  // while calm water (zero speed) never carries and a lake settles. `?carry=0` disables.
  let carryRate = num("carry", 1);          // >0 = enable (no longer a probability)
  let fwdHeadK = num("fwdheadk", 1);        // budget cells per unit of column head (pileup)
  let fwdDischargeK = num("fwddisk", 0.5);  // + budget per unit of feeding speed (stream power)
  let carrySpeedMin = num("carryspeed", 0.5); // min momentum to ride forward (calm water never does)
  const momField = new Map<string, MomentumCell>();
  const momCfg = {
    inject: num("mominject", 1),        // speed per cell of descent
    frictionRest: num("momfrest", 0.7), // flat-rest decay per tick
    frictionDeep: num("momfdeep", 0.35),// ≥2 water above (subcritical) — sheds in 1–2 ticks
    frictionFlow: num("momfflow", 0.92),// horizontal run keeps most speed
    weirK: num("momweirk", 1),          // extra drain quota per unit speed
    weirRes: num("momweirres", 1.2),    // lip resistance the momentum "plus" must beat
    headK: num("momheadk", 1),          // HEAD-DRIVEN OUTLET: extra quota per stacked cell of head
                                        // above the mouth — a pileup behind a narrow notch pushes more
                                        // discharge → a TALLER, thicker fall face (0 = classic mouth cap)
    headMax: num("momheadmax", 12),     // clamp on counted head so a deep pool can't runaway the quota
    maxSpeed: num("mommax", 6),
    biasMin: num("mombias", 0.3),       // Phase 2: min s for heading-biased spread
    levelFlow: num("momlevelflow", 0.25), // FLOW-AWARE LEVELING: min s at which a cell may equalise a
                                        // 1-cell step, so a FED channel backs up + stacks a face against a
                                        // barrier while still lakes (s→0) settle with the classic ≥2 rule.
                                        // 0 = pure ≥2 (frozen 1-deep skin). Override ?momlevelflow=N.
  };
  let momDropsTotal = 0, momOvertopsTotal = 0;
  const momOvertopLog: number[] = [];   // recent overtop timestamps (rate window)
  const SPLIT_ON = CA_ON && params.get("springsplit") !== "0";
  const SUBVOX = Math.max(1, Math.round(num("springsubvox", 252)));     // droplets per falling cell (3x denser: fills the long streak, was 84)
  const DROP_SCALE = num("springdropscale", 0.28);                      // droplet size vs a full voxel (finer w/ high count)
  const DROP_CAP = num("springdropcap", 72000);                        // droplet instance cap (headroom for 3x)
  const dwell = new Map<string, number>();                             // crest-dwell counters

  // Sub-voxel surface skin. Water is simulated as whole voxels (conservation +
  // flow depend on the integer grid), but the VISIBLE surface height is decoupled
  // from the voxel: the exposed top cell of a pool is drawn as a slab whose height
  // is a fraction of a voxel, floored to the voxel bottom, so a shallow sheet reads
  // as a film rather than a chunky 1-voxel block. The fraction feathers CONTINUOUSLY
  // from WATER_THIN in the pool interior down to WATER_THIN*EDGE_MIN at the rim (a
  // cell with fewer water neighbours), the same neighbour-averaged surface Minecraft
  // uses so a fluid tapers at its edge instead of ending in a hard cube. Submerged
  // cells (water above them) stay full so a deep pool fills solid.
  // Tune live: ?waterthin=N (interior film, 0.05–1; 1 = old full-cube) and
  // ?wateredge=N (rim taper as a fraction of the film, 0.05–1).
  const WATER_THIN = Math.max(0.05, Math.min(1, num("waterthin", 0.4)));
  const EDGE_MIN = Math.max(0.05, Math.min(1, num("wateredge", 0.3)));

  // Place a cell instance into a private InstancedMesh at voxel coords. `hFrac` is
  // the rendered height as a fraction of a voxel (1 = full cube); a sub-1 slab is
  // dropped so its bottom stays on the voxel floor (the surface lowers, base holds).
  const box = new THREE.BoxGeometry(cellSize, cellSize, cellSize);
  const dummy = new THREE.Object3D();
  const setCell = (mesh: any, slot: number, x: number, y: number, z: number, hFrac = 1) => {
    const f = hFrac >= 1 ? 1 : Math.max(0.02, hFrac);
    const yOff = f < 1 ? -(cellSize * (1 - f)) / 2 : 0;
    dummy.position.set((x - cxRound) * voxel, y * voxel + yOff, (z - czRound) * voxel);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, f, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  };

  let waterMesh: any = null;      // capped, dynamic spring water (resting/pool cells)
  let flowAttr: any = null;       // per-instance aFlow (dirX, dirZ, foam01) for the V3 shader
  let lastFoam = { cells: 0, mean: 0 }; // last aFlow fill stats (verification)
  // Animated liquid-surface uniforms for the still lake mesh (shared shader with
  // scan water). uTime + uWaterTopY are driven in tick(). Falls/drops keep the
  // plain translucent look (turbulent streams, not a calm surface).
  let waterSurfUniforms: any = null;
  let maxWaterVy = -Infinity;     // highest filled water voxel Y → depth-tint surface ref
  let lastSurfScan = 0;           // cadence guard for the depth-tint surface recompute
  const waterSlot = new Map<string, number>();
  const waterThin = new Map<string, number>(); // cell -> currently drawn height fraction (1 = full)
  const waterFree: number[] = [];
  const springWater = new Set<string>(); // authoritative spring-water cell set (pool + falling)
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  // Falling-cell droplet spray (render-only, CA path). Each falling water cell is
  // drawn as SUBVOX small jittered boxes instead of one full voxel; on landing it
  // rejoins the pool mesh as a full voxel ("reforms"). Not in springWater/colMap.
  let dropMesh: any = null;
  const dropSlots = new Map<string, number[]>(); // falling cell -> its droplet slot indices
  const dropFree: number[] = [];
  // Anime-waterfall drop styling (render-only). A fall is not one drop size or one
  // colour: fresh/slow water reads as chunky translucent blue; fast, shattered water
  // whitens toward a cool near-white mist (high-albedo diffuse, lit only by real
  // light — no emissive, doctrine-compliant). Per-drop size varies across a spectrum
  // so the curtain reads as a mix of big drops + fine spray, not a uniform grid.
  const DROP_WHITE = num("dropwhite", 0.9);   // max whitening frac for the fastest drops
  const DROP_MIST = num("dropmist", 0.45);    // how much fast falls shrink toward mist
  const DROP_SPREAD = num("dropspread", 0.95);// horizontal jitter width (voxels) — wider curtain for the denser spray
  const BASE_WHITE = num("dropbasewhite", 0.28); // floor fraction of drops that are aerated-white (mix even at rest)
  // Falling cells are spaced several voxels apart vertically (the CA advances one
  // grid step/tick, the stream is not a solid column), so droplets clustered ±0.5
  // voxel around each cell leave GAPS between cells. Streak each cell's droplets
  // DOWNWARD along the fall — a velocity-scaled motion-blur trail — so consecutive
  // puffs overlap into a continuous curtain (faster water streaks longer).
  const STREAK_MIN = num("dropstreakmin", 2.2);  // downward streak (voxels) at rest
  const STREAK_MAX = num("dropstreakmax", 7.5);  // downward streak (voxels) at full speed
  const _dropBlue = new THREE.Color(waterColor);
  const _dropWhite = new THREE.Color(0xdff2ff); // cool near-white (anime waterfall core)
  const _dropTmp = new THREE.Color();

  // ── Waterfalls ───────────────────────────────────────────────────────────
  // A visual, matter-neutral overlay: wherever the pool has a "lip" (a water
  // cell with an air neighbour that also has air below — i.e. the pool edge next
  // to a drop), we render a falling column of translucent water down that
  // neighbour column to the first solid/water below (or MAXDROP cells into the
  // void for an island-edge overflow). These cells are NOT in springWater / the
  // colMap / the conservation ledger — they're pure render, so irrigation,
  // autosave and the water budget are untouched. `?waterfall=0` off;
  // `?waterfalldemo=1` floods the pool so it overflows an edge for the demo.
  const WATERFALL_ON = params.get("waterfall") !== "0";
  const DEMO = params.get("waterfalldemo") === "1";
  const WATERFALL_CAP = num("waterfallcap", 800);
  const WATERFALL_MAXDROP = num("waterfalldrop", 30);
  const FILL_RADIUS = num("springradius", 24);  // PERF bound on the flood search only — NOT a basin-size knob; terrain + water volume decide the lake
  let waterfallMesh: any = null;
  const wfSlot = new Map<string, number>();
  const wfFree: number[] = [];
  const wfSet = new Set<string>();

  let state: SpringState = { budget: 0, capacity: CAPACITY };
  let origin: Vec3 | null = null;
  let emitter: Vec3 | null = null;
  let lastTick = 0;
  let active = false;
  // CA flow bookkeeping.
  let floorY = -Infinity;   // water below this has fallen off the world → culled
  let stepCount = 0;        // rotates CA horizontal preference (anti-bias)
  let lastEmit = 0, lastFlow = 0;
  let culledTotal = 0;      // lifetime cells drained off edges (for report)

  // Spring water rests on any solid OR on scan water (both live in colMap; scan
  // water is added to colMap by settleWaterNear). Spring water itself is kept
  // out of colMap so the solver treats the passed set as the fluid body.
  const isSolid = (x: number, y: number, z: number) =>
    (colMap.get(KEYXZ(x, z))?.has(y) ?? false) || (extraSolid?.(x, y, z) ?? false);

  function persist() {
    if (!origin) return;
    meta.spring = {
      version: 13, seed: theSeed,
      origin: { x: origin[0], y: origin[1], z: origin[2] },
      budget: state.budget, capacity: CAPACITY,
    } as SpringMeta;
  }

  let theSeed = 0;

  function init(): { ok: boolean; reason?: string } {
    if (params.get("spring") === "0") return { ok: false, reason: "disabled (?spring=0)" };
    if (!colMap.size) return { ok: false, reason: "empty world" };

    const saved = meta.spring as SpringMeta | undefined;
    theSeed = saved?.seed ?? (mix32(ctx.worldSeed) % 1_000_000);

    // 1) Per-column top solid height, then the high band = the "surface".
    let maxTop = -Infinity, minSolid = Infinity, minTop = Infinity;
    const topByKey = new Map<string, number>();
    for (const [k, ys] of colMap) {
      let t = -Infinity;
      for (const y of ys) { if (y > t) t = y; if (y < minSolid) minSolid = y; }
      if (t === -Infinity) continue;
      topByKey.set(k, t);
    }
    // Latent-interior mass is real terrain (KJ ruling, Aug 13): fold latent
    // column tops in so the plateau/basin passes see a latent-only mass as
    // ground. The flatness/thickness gates already test cell solidity through
    // extraSolid, so a latent top that qualifies is genuinely load-bearing.
    if (extraColTops) for (const [k, t] of extraColTops) {
      const prev = topByKey.get(k);
      if (prev == null || t > prev) topByKey.set(k, t);
    }
    const tops: Vec3[] = [];
    for (const [k, t] of topByKey) {
      const [x, z] = k.split(",").map(Number);
      tops.push([x, t, z]);
      if (t > maxTop) maxTop = t;
      if (t < minTop) minTop = t;   // lowest column TOP (not lowest solid) = surface floor
    }
    // Water that falls this far below the lowest terrain has gone off an edge
    // into the void → cull it (and recirculate its volume back to the reservoir).
    floorY = (Number.isFinite(minSolid) ? minSolid : 0) - FLOW_DROP;
    // Sanity-check against the FULL terrain, not the top band: on varied terrain
    // a single tall tree/leaf can define maxTop and starve the CEIL_BAND band to
    // a handful of cells (false "no usable surface"). Siting uses `tops` anyway.
    if (tops.length < 8) return { ok: false, reason: "no usable surface" };
    const surface = tops.filter((c) => c[1] >= maxTop - CEIL_BAND);

    // 2) Prefer a NATURAL BASIN in the ceiling; else an existing lip cell.
    //    The spring never edits the scan to manufacture a basin — it only picks
    //    a real existing depression. Water starts one cell above the origin and
    //    must travel through air (over the basin's lip, or over the outlet lip)
    //    before it can descend.
    const surfaceKeys = new Set(surface.map(([x, , z]) => KEYXZ(x, z)));
    let cx = 0, cz = 0;
    for (const [x, , z] of surface) { cx += x; cz += z; }
    cx /= Math.max(1, surface.length); cz /= Math.max(1, surface.length);
    const outletCandidates = surface.filter(([x, y, z]) => HDIRS.some(([dx, dz]) => {
      const nx = x + dx, nz = z + dz;
      return !surfaceKeys.has(KEYXZ(nx, nz)) && !isSolid(nx, y + 1, nz) && !isSolid(nx, y, nz);
    }));
    const chooseOutlet = () => {
      const candidates = outletCandidates.length ? outletCandidates : surface;
      return candidates.reduce<Vec3 | null>((best, c) => {
        if (!best) return c;
        const score = Math.abs(c[0] - cx) + Math.abs(c[2] - cz);
        const bestScore = Math.abs(best[0] - cx) + Math.abs(best[2] - cz);
        return score < bestScore || (score === bestScore && c[1] > best[1]) ? c : best;
      }, null);
    };

    // Find a NATURAL BASIN: a genuine enclosed depression in the ceiling surface
    // where emitted water pools into a contained lake instead of sheeting off an
    // edge. Priority-flood watershed (Barnes 2014): every ceiling column gets a
    // SPILL LEVEL = the height water must rise to before it escapes over the
    // lowest surrounding rim to an open edge. depth = spillLevel - columnTop; the
    // deepest cell is the basin bottom. Returns null on a flat/unenclosed ceiling.
    // BASIN_BAND must cover the world's FULL vertical relief, not a fixed
    // skullcap under maxTop. On real scans maxTop is an outlier spike (a wall or
    // ceiling fragment) while the walkable surface sits far below it — e.g. the
    // debug scan's median column-top is 1 but maxTop is 51. A fixed 8-voxel band
    // then only sees the thin cap around the spike, finds no enclosure, and the
    // spring falls back to sheeting off that spike (reads as "through geometry"),
    // never considering the obvious basin in the terrain below. Default to the
    // full top-surface relief (maxTop - minTop); the priority-flood still returns
    // null on genuinely flat/monotone ceilings, so the wider search is safe.
    const relief = Number.isFinite(minTop) ? Math.max(0, maxTop - minTop) : 8;
    // Ceiling-aware band. On a ROOFED scan a large fraction of columns share the
    // top surface at ~maxTop (the ceiling sheet), while ceiling GAPS drop to the
    // floor far below. The full-relief band then lets the watershed flood tunnel
    // straight through a gap and report the whole floor-to-ceiling void (depth
    // ~179) as the "deepest basin" — siting the spring on the FLOOR (y=0) instead
    // of a real depression in the roof. Detect the ceiling (≥15% of column tops
    // within CEIL_BAND of maxTop) and cap the band to the roof's own undulation
    // so the basin is found ON the ceiling, above the room. Open terrain (no
    // ceiling — e.g. the outdoor crater) keeps the v8 full-relief band.
    let nearTop = 0;
    for (const c of tops) if (c[1] >= maxTop - CEIL_BAND) nearTop += 1;
    const hasCeiling = tops.length > 0 && nearTop / tops.length >= 0.15;
    const CEIL_RELIEF = num("springceilband", 28); // roof undulation the basin may see through
    const autoBand = hasCeiling ? Math.min(relief, CEIL_RELIEF) : Math.max(CEIL_BAND, 8, relief);
    const BASIN_BAND = num("springbasinband", autoBand);
    const chooseBasin = (): Vec3 | null => {
      const H = new Map<string, number>();  // ceiling footprint: keyXZ -> top y
      for (const [x, y, z] of tops) {
        if (y >= maxTop - BASIN_BAND) H.set(KEYXZ(x, z), y);
      }
      if (H.size < 12) return null;
      type N = { k: string; x: number; z: number; L: number };
      const heap: N[] = [];
      const less = (a: N, b: N) => a.L - b.L;
      const push = (n: N) => {
        heap.push(n);
        let i = heap.length - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p]) < 0) { const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; } else break; }
      };
      const pop = (): N => {
        const top = heap[0], last = heap.pop() as N;
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && less(heap[l], heap[s]) < 0) s = l; if (r < heap.length && less(heap[r], heap[s]) < 0) s = r; if (s === i) break; const t = heap[i]; heap[i] = heap[s]; heap[s] = t; i = s; }
        }
        return top;
      };
      // Seed with rim cells (a ceiling column with a non-ceiling 4-neighbour =
      // the open edge water escapes over); their spill level is their own top.
      const spill = new Map<string, number>();
      const seen = new Set<string>();
      for (const [k, y] of H) {
        const [x, z] = k.split(",").map(Number);
        if (HDIRS.some(([dx, dz]) => !H.has(KEYXZ(x + dx, z + dz)))) { push({ k, x, z, L: y }); seen.add(k); }
      }
      while (heap.length) {
        const n = pop();
        if (spill.has(n.k)) continue;
        spill.set(n.k, n.L);
        for (const [dx, dz] of HDIRS) {
          const nx = n.x + dx, nz = n.z + dz, kk = KEYXZ(nx, nz);
          if (!H.has(kk) || seen.has(kk)) continue;
          seen.add(kk);
          push({ k: kk, x: nx, z: nz, L: Math.max(n.L, H.get(kk)!) });
        }
      }
      // Deepest enclosed column = basin bottom (rim strictly above it); tie-break
      // toward the surface centroid so the lake sits centrally.
      let best: Vec3 | null = null, bestDepth = 0, bestCentral = Infinity;
      for (const [k, y] of H) {
        const depth = (spill.get(k) ?? y) - y;
        if (depth < 1) continue;  // no containment → not a basin, water sheets off
        const [x, z] = k.split(",").map(Number);
        const central = Math.abs(x - cx) + Math.abs(z - cz);
        if (depth > bestDepth || (depth === bestDepth && central < bestCentral)) {
          best = [x, y, z]; bestDepth = depth; bestCentral = central;
        }
      }
      return best;
    };

    // PLATEAU siting v10 (KJ Aug 11: "water should come from plateau or
    // relatively flat surface (higher elevation) — not from the point of a
    // wall"). v9's shelf test (>=2 near-level 4-neighbours, score = biggest
    // drop) was satisfied along a 1-cell-wide wall ridge, so the tallest wall
    // crest won and the fall plunged the whole world height — which also
    // starves the sim: most of the fixed particle budget hangs in flight, so
    // the stream thins and the pool never fills. Now a source cell must sit on
    // a REAL flat patch: of the 24 neighbours in its 5x5 window, >= SPRING_FLAT
    // (default 70%) must exist AND be within +-2 cells of its top. Missing
    // columns count AGAINST flatness, so thin walls, spikes, and void edges
    // all fail. The fall stays emergent: some column within SHELF_DROP_RAD
    // (Chebyshev, default 6) must top out >= SHELF_DROP cells lower — the lip
    // is a few cells away and water reaches it by flowing, instead of the
    // source sitting ON the lip. Missing neighbours never count as a drop
    // (can't pour off the world). Scoring v11 (KJ Aug 12: v10's highest-first
    // rank always climbed to the tallest plateau — "too high up"): blended
    // score = deviation from a MIDDLING target elevation (?springheight,
    // fraction of the world top range, default 0.55) + weighted centroid
    // distance (?springcent, default 1). Lowest score wins; flatness breaks
    // ties. Scoring v12 (KJ Aug 13: "bigger plateau if there is one"): a
    // plateau-AREA term (?springarea, default 1.5) prefers candidates on
    // larger connected near-level regions — see the component pass below.
    // ?springsite=basin restores the basin-first order; knobs
    // ?springdrop, ?springdroprad, ?springflat (0-1).
    const SHELF_DROP = num("springdrop", 8);
    const DROP_RAD = Math.max(1, Math.round(num("springdroprad", 6)));
    const FLAT_MIN = Math.min(1, Math.max(0, num("springflat", 0.7)));
    const HEIGHT_FRAC = Math.min(1, Math.max(0, num("springheight", 0.55)));
    const CENTRAL_W = Math.max(0, num("springcent", 1));
    const AREA_W = Math.max(0, num("springarea", 1.5));
    const chooseShelf = (): Vec3 | null => {
      const Hall = new Map<string, number>();
      for (const [x, y, z] of tops) Hall.set(KEYXZ(x, z), y);
      // Plateau AREA (v12, KJ Aug 13: "bigger plateau if there is one"):
      // segment all columns into near-level connected components (4-neighbour,
      // |Δtop| <= 2 — the same tolerance the flatness window uses) and prefer
      // candidates on LARGER plateaus. Chained tolerance means a gentle slope
      // can read as one component; the local flatness + nearby-drop gates
      // still decide eligibility — area only ranks eligible candidates, so a
      // 5x5 terrace next to a wall no longer ties a whole field.
      const compOf = new Map<string, number>();
      const compSize: number[] = [];
      {
        const stack: string[] = [];
        for (const [x0c, , z0c] of tops) {
          const k0 = KEYXZ(x0c, z0c);
          if (compOf.has(k0)) continue;
          const id = compSize.length;
          compSize.push(0);
          compOf.set(k0, id);
          stack.push(k0);
          while (stack.length) {
            const k = stack.pop()!;
            compSize[id]++;
            const ci = k.indexOf(",");
            const x = +k.slice(0, ci), z = +k.slice(ci + 1);
            const y = Hall.get(k)!;
            for (let n = 0; n < 4; n++) {
              const nk = KEYXZ(x + (n === 0 ? 1 : n === 1 ? -1 : 0), z + (n === 2 ? 1 : n === 3 ? -1 : 0));
              if (compOf.has(nk)) continue;
              const nt = Hall.get(nk);
              if (nt == null || Math.abs(nt - y) > 2) continue;
              compOf.set(nk, id);
              stack.push(nk);
            }
          }
        }
      }
      let maxArea = 1;
      for (const s of compSize) if (s > maxArea) maxArea = s;
      const flatFrac = (x: number, z: number, y: number, R: number) => {
        let level = 0, cells = 0;
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
          if (dx === 0 && dz === 0) continue;
          cells += 1;
          const nt = Hall.get(KEYXZ(x + dx, z + dz));
          if (nt != null && Math.abs(nt - y) <= 2) level += 1;
        }
        return level / cells;
      };
      const dropNear = (x: number, z: number, y: number) => {
        let drop = 0;
        for (let dz = -DROP_RAD; dz <= DROP_RAD && drop < SHELF_DROP; dz++) {
          for (let dx = -DROP_RAD; dx <= DROP_RAD && drop < SHELF_DROP; dx++) {
            const nt = Hall.get(KEYXZ(x + dx, z + dz));
            if (nt != null && y - nt > drop) drop = y - nt;
          }
        }
        return drop;
      };
      const hSpan = Math.max(1, maxTop - minTop);
      const targetY = minTop + hSpan * HEIGHT_FRAC;
      let centralNorm = 1;
      for (const [x, , z] of tops) {
        const d = Math.abs(x - cx) + Math.abs(z - cz);
        if (d > centralNorm) centralNorm = d;
      }
      const pass = (requireThick: boolean, R: number): Vec3 | null => {
        let best: Vec3 | null = null, bestScore = Infinity, bestFlat = 0, bestArea = 0;
        for (const [x, y, z] of tops) {
          if (requireThick && (!isSolid(x, y - 1, z) || !isSolid(x, y - 2, z))) continue;
          let clear = true;
          for (let dy = 1; dy <= 6 && clear; dy++) if (isSolid(x, y + dy, z)) clear = false;
          if (!clear) continue;
          const flat = flatFrac(x, z, y, R);
          if (flat < FLAT_MIN) continue;
          if (dropNear(x, z, y) < SHELF_DROP) continue;
          const central = Math.abs(x - cx) + Math.abs(z - cz);
          const compId = compOf.get(KEYXZ(x, z));
          const area = compId != null ? compSize[compId] : 1;
          const score = Math.abs(y - targetY) / hSpan + CENTRAL_W * (central / centralNorm) + AREA_W * (1 - area / maxArea);
          if (score < bestScore || (score === bestScore && flat > bestFlat)) {
            best = [x, y, z]; bestScore = score; bestFlat = flat; bestArea = area;
          }
        }
        if (best) console.log(`[spring] plateau sited at (${best[0]},${best[1]},${best[2]}), flat ${(bestFlat * 100) | 0}%, area ${bestArea}/${maxArea}, score ${bestScore.toFixed(3)} (targetY ${targetY.toFixed(1)})${requireThick ? "" : " (thin sheet)"}`);
        return best;
      };
      // Tier 1: thick ground plateau (solid y-1 and y-2 — real high ground).
      // Tier 2: a thin elevated sheet, accepted only as a LARGE coherent flat
      // surface — the wider 7x7 flatness window is what a lumpy tree canopy
      // cannot satisfy, so a structural roof slab qualifies but leaves never
      // host the spring. Without this tier a scan whose only elevated flat
      // ground is a roof shell (e.g. the debug world's [0,1,9] slab columns)
      // would skip plateau siting entirely and fall back to a floor basin.
      return pass(true, 2) ?? pass(false, 3);
    };

    // Re-site once for the latent-tops terrain view (version 13).
    const savedVersion = (saved as any)?.version ?? 0;
    const RESITE = params.get("springresite") === "1" || (saved != null && savedVersion < 13);
    if (saved?.origin && !RESITE) {
      origin = [saved.origin.x, saved.origin.y, saved.origin.z];
    } else {
      origin = (params.get("springsite") === "basin" ? null : chooseShelf()) ?? chooseBasin() ?? chooseOutlet();
    }
    if (!origin) return { ok: false, reason: "could not site spring" };

    // Cull floor stays anchored BELOW the world's lowest solid (set above from
    // minSolid − FLOW_DROP), NEVER source-relative. Water must be free to fall the
    // full height from a ceiling source down to the solid room floor and POOL
    // there — it is never destroyed in mid-air. The old "goes through geometry"
    // drill that once motivated a source-relative cap is now cured at its root by
    // the solid latent underside: the floor and walls are real solids the water
    // rests on, so nothing drills through. In a fully enclosed room this cull can
    // never fire (solid stops the water long before it). The only water that ever
    // reaches this floor is water that genuinely poured off an OPEN-world edge into
    // the void, which recirculates into the reservoir as the water cycle.

    // Visual marker overlays the already-existing ceiling voxel. It is not added
    // to colMap and therefore creates no new world geometry.
    const blockMat = new THREE.MeshStandardMaterial({ color: 0x3fa9ff, emissive: 0x1a5fbf, emissiveIntensity: 0.6, roughness: 0.5 });
    const blockMesh = new THREE.InstancedMesh(box, blockMat, 1);
    setCell(blockMesh, 0, origin[0], origin[1], origin[2]);
    blockMesh.count = 1;
    blockMesh.instanceMatrix.needsUpdate = true;
    scene.add(blockMesh);

    // 3) Capped spring-water mesh (cap = reservoir capacity).
    const waterSurfMat = new THREE.MeshStandardMaterial({ color: waterColor, transparent: true, opacity: 0.78, roughness: 0.3, metalness: 0.02 });
    waterSurfUniforms = installWaterSurface(THREE, waterSurfMat, { waterTopY: origin[1] * voxel });
    // Phase 3 flow-aware surface: the spring mesh gets its OWN geometry (the
    // shared box is used by other meshes with different instance counts) with a
    // per-instance aFlow attribute (dirX, dirZ, foam01) the V3 shader reads for
    // white-water. Filled at 1s cadence in tick(); zeros = calm V2 look.
    const waterGeo = box.clone();
    flowAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    flowAttr.setUsage(THREE.DynamicDrawUsage);
    waterGeo.setAttribute("aFlow", flowAttr);
    waterMesh = new THREE.InstancedMesh(
      waterGeo,
      waterSurfMat,
      CAPACITY,
    );
    waterMesh.count = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < CAPACITY; i++) { waterMesh.setMatrixAt(i, zero); waterFree.push(i); }
    waterMesh.instanceMatrix.needsUpdate = true;
    scene.add(waterMesh);
    buildWaterfallMesh();   // visual falling-water overlay (legacy non-CA path)
    buildDropMesh();        // CA falling-cell droplet spray

    emitter = emitterCell(origin);

    // Budget: reuse persisted, else prime to half so there is a visible pool on
    // first load (rain tops it up; drought drains it).
    state = { budget: saved ? Math.min(CAPACITY, saved.budget) : Math.floor(CAPACITY * 0.5), capacity: CAPACITY };
    active = true;
    persist();

    // Never prebuild a pool. The live CA emits from the ceiling source and the
    // water reaches lower terrain only by visibly travelling over a real lip.
    if (CA_ON) {
      if (DEMO) state.budget = CAPACITY;
    } else {
      if (DEMO) state.budget = CAPACITY;
      renderWaterfalls();
    }

    return { ok: true };
  }

  // Push `add` water cells through the settle solver and reconcile the mesh.
  // Vertical head-room for the fill search box. The settle is now a lowest-first
  // priority flood, so on open ground water spreads outward as a flat sheet no
  // matter how high this ceiling is; it only ever climbs where REAL solid
  // terrain walls contain it. So this is just "how deep a genuine basin may fill
  // before overflowing its lowest lip" — keep it tall enough to reach real rims.
  const MAX_RISE = num("springrise", DEMO ? 8 : 6);
  function fill(add: number) {
    if (!emitter || !waterMesh || add <= 0) return 0;
    const next = emitAndSettle(springWater, isSolid, emitter, add, { radius: FILL_RADIUS, maxCells: CAPACITY, maxRise: MAX_RISE });
    const changed = reconcile(next);
    if (changed) renderWaterfalls();
    return changed;
  }

  // ── CA flow: seed, advance, and dribble the source ─────────────────────────
  // Seed a resting pool of ~`volume` cells by fast-forwarding the SAME CA the
  // live sim uses (dribble at the source, then settle), so the initial pool is
  // already flat — no momentary tower on load. All synchronous; mesh reconciled
  // once at the end.
  function prime(volume: number) {
    if (!emitter) return;
    const [ex, ey, ez] = emitter;
    // Bound the pre-settle so a large budget can't freeze load; the live tick
    // keeps filling from here.
    const vol = Math.max(0, Math.min(volume, SEED_CAP));
    let body = new Set(springWater);
    const SETTLE_CAP = 320;
    const opts = { floorY, maxCells: CAPACITY, spreadRange: SPREAD_RANGE, maxScan: MAX_SCAN, maxDrainPerCol: DRAIN_CAP };
    for (let s = 0; s < vol + SETTLE_CAP; s++) {
      if (s < vol && !isSolid(ex, ey, ez) && !body.has(KEY(ex, ey, ez)) && body.size < CAPACITY) {
        body.add(KEY(ex, ey, ez));
      }
      const next = stepFluid(body, isSolid, { ...opts, tick: s, hydro: hydroEnabled, carryRate: hydroEnabled ? carryRate : 0 });
      const stable = s >= vol && next.size === body.size && [...next].every((k) => body.has(k));
      body = next;
      if (stable) break;
    }
    reconcile(body);
  }

  // Advance the fluid one cell of motion; recirculate any water that poured off
  // an edge back into the rain-fed reservoir (conservation: the water cycle).
  function flowStep() {
    if (!waterMesh) return;
    stepCount++;
    const prevSize = springWater.size;
    const momStats = { drops: 0, overtops: 0 };
    const next = stepFluid(springWater, isSolid, {
      floorY, tick: stepCount, maxCells: CAPACITY, spreadRange: SPREAD_RANGE, maxScan: MAX_SCAN,
      edgeHold: EDGE_HOLD, dwell, maxDrainPerCol: DRAIN_CAP, hydro: hydroEnabled,
      carryRate: hydroEnabled ? carryRate : 0, fwdHeadK, fwdDischargeK, carrySpeedMin,
      momentum: momEnabled ? { field: momField, ...momCfg, stats: momStats } : undefined,
    });
    if (momEnabled) {
      momDropsTotal += momStats.drops;
      if (momStats.overtops > 0) {
        momOvertopsTotal += momStats.overtops;
        const now = performance.now();
        while (momOvertopLog.length && now - momOvertopLog[0] > 10_000) momOvertopLog.shift();
        for (let i = 0; i < momStats.overtops; i++) momOvertopLog.push(now);
        if (momOvertopLog.length > 2000) momOvertopLog.splice(0, momOvertopLog.length - 2000);
      }
    }
    const culled = prevSize - next.size; // stepFluid only shrinks the body via culling
    if (culled > 0) {
      culledTotal += culled;
      state = { ...state, budget: Math.min(CAPACITY, state.budget + culled) };
    }
    reconcile(next);
  }

  // Dribble one source cell at the emitter when funded and the emitter is clear.
  // (Legacy raw-CA source: kept for reference. Superseded by growStep — a raw
  // dribble PLUGS on flat ground, because a single cell resting on the flat
  // spring block has nothing below to fall into and no reachable drop, so it sits
  // on the emitter forever and blocks further emission → the pool never forms.)
  function emitTick() {
    if (!emitter || springWater.size >= CAPACITY) return;
    const [ex, ey, ez] = emitter;
    if (isSolid(ex, ey, ez) || springWater.has(KEY(ex, ey, ez))) return; // source still occupied
    const r = springEmit(state, [ex, ey, ez], 1);
    if (!r.emit) return; // dry reservoir → drought
    state = r.state;
    springWater.add(KEY(ex, ey, ez));
  }

  // Grow the pool from the source by a funded, self-leveling RESTING relaxation
  // (emitAndSettle) rather than a raw CA dribble. This is the jitter-safe
  // self-leveling rule: each funded tick adds PER_TICK cells to the connected
  // pocket and re-settles the whole body lowest-supported-first, so — proven by
  // the offline flood fixtures (incremental point growth) — the lake:
  //   • grows OUTWARD as a flat 1-deep sheet on open ground (never towers, and
  //     the source can't plug — the solver sweeps the emitter cell into the pool),
  //   • fills a real walled basin BOTTOM-UP, layer by layer (a lake that deepens),
  //   • is deterministic, so it never jitters (unlike unit-cell CA equalization).
  // The live stepFluid pass (flowStep) still animates water that CAN move — the
  // fall from a perched source and the spill off a filled basin's lip — so the
  // motion reads as flowing while the body itself self-levels.
  function growStep() {
    if (!emitter || springWater.size >= CAPACITY) return;
    const want = Math.min(PER_TICK, CAPACITY - springWater.size);
    const r = springEmit(state, emitter, want); // fund the volume (drought → no-op)
    if (!r.emit) return;
    // ADDITIVE bottom-up placement (was: emitAndSettle re-settle every tick). The old
    // one-shot settle re-laid the ENTIRE local body to a flat resting level on every
    // emit tick, which (a) fought the CA — yanking flowing channel water back toward
    // the source and flattening it so a river/depth could never establish — and (b)
    // LEAKED MASS: once the near-source pool saturated, it placed fewer cells than
    // `want`, yet springEmit had already debited `want`, so the shortfall was
    // withdrawn-but-never-placed = destroyed (uncredited). Both are the "water
    // disappearing / lake-outflow ≠ waterfall" bug. Now we ADD `want` new cells at the
    // LOWEST empty resting spots reachable from the emitter, filling bottom-up WITHOUT
    // disturbing existing water — so the CA (flowStep) owns all flow (no yank-back), the
    // source never towers (bottom-up), and it is conservation-exact (refund any cells we
    // could not place). Offline-proven on the real breachflat bed (tools/diag_breachflat2.ts):
    // no source tower, channel fills continuously, balance = 0.
    const placed = placeSpringWater(want);
    state = { ...r.state, budget: Math.min(CAPACITY, r.state.budget + (want - placed)) };
    if (placed > 0) reconcile(new Set(springWater));
  }

  // Add up to `want` NEW water cells at the lowest empty resting spots reachable from
  // the emitter, filling bottom-up, WITHOUT disturbing existing water. Returns how many
  // were actually placed (< want when the reachable basin is full → the caller refunds
  // the rest, keeping budget+body conservation-exact). Flood the reachable non-solid
  // pocket (through water + air), then greedily fill lowest-first where the cell below
  // is solid / existing water / an already-placed lower cell — so water wells up in the
  // basin instead of towering at the source column, and flowing water downstream is
  // never touched (the CA owns it).
  function placeSpringWater(want: number): number {
    if (!emitter) return 0;
    const [ex, ey, ez] = emitter;
    const R = FILL_RADIUS;
    const inR = (x: number, y: number, z: number) =>
      Math.abs(x - ex) <= R && Math.abs(z - ez) <= R && y >= ey - R - 6 && y <= ey + R;
    const isFree = (x: number, y: number, z: number) => !isSolid(x, y, z) && !springWater.has(KEY(x, y, z));
    const seen = new Set<string>();
    const stack: Array<[number, number, number]> = [];
    if (!isSolid(ex, ey, ez)) { seen.add(KEY(ex, ey, ez)); stack.push([ex, ey, ez]); }
    const DIRS: Array<[number, number, number]> = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]];
    const empties: Array<[number, number, number]> = [];
    let guard = 0;
    while (stack.length && guard++ < 300000) {
      const [x, y, z] = stack.pop()!;
      if (isFree(x, y, z)) empties.push([x, y, z]);
      for (const [dx, dy, dz] of DIRS) {
        const nx = x + dx, ny = y + dy, nz = z + dz, kk = KEY(nx, ny, nz);
        if (!inR(nx, ny, nz) || seen.has(kk) || isSolid(nx, ny, nz)) continue;
        seen.add(kk); stack.push([nx, ny, nz]);
      }
    }
    empties.sort((a, b) => a[1] - b[1] || (Math.abs(a[0] - ex) + Math.abs(a[2] - ez)) - (Math.abs(b[0] - ex) + Math.abs(b[2] - ez)));
    const placedSet = new Set<string>();
    let placed = 0;
    const supported = (x: number, y: number, z: number) =>
      isSolid(x, y - 1, z) || springWater.has(KEY(x, y - 1, z)) || placedSet.has(KEY(x, y - 1, z));
    let progress = true;
    while (placed < want && progress) {
      progress = false;
      for (const [x, y, z] of empties) {
        if (placed >= want) break;
        const kk = KEY(x, y, z);
        if (placedSet.has(kk)) continue;
        if (supported(x, y, z)) { placedSet.add(kk); springWater.add(kk); placed++; progress = true; }
      }
    }
    return placed;
  }

  // A water cell is FALLING when the contiguous water column it sits on has no
  // solid support directly beneath its base — the whole airborne stream reads as
  // spray, not just its lowest cell. (The old test only checked the single cell
  // directly below, so a stacked mid-air column rendered every cell but the bottom
  // as a full "pool" cube — the boxes-in-the-waterfall artifact.) Resting pool
  // water bottoms out on solid ground → not falling → drawn as full boxes.
  const isFalling = (x: number, y: number, z: number, body: Set<string>) => {
    let yy = y;
    // descend through contiguous water in this column to its base
    while (body.has(KEY(x, yy - 1, z))) yy--;
    // base rests on solid → pool; base over void → the whole column is falling
    return !isSolid(x, yy - 1, z);
  };

  function reconcile(next: Set<string>): number {
    // Split the body into resting pool cells (full voxels) and falling cells
    // (droplet spray). With SPLIT off, everything is "pool" → original behaviour.
    let poolTarget: Set<string>, fallingTarget: Set<string> | null = null;
    if (SPLIT_ON) {
      poolTarget = new Set<string>();
      fallingTarget = new Set<string>();
      for (const k of next) {
        const [x, y, z] = k.split(",").map(Number);
        (isFalling(x, y, z, next) ? fallingTarget : poolTarget).add(k);
      }
    } else {
      poolTarget = next;
    }

    const changed = reconcilePool(poolTarget);
    if (fallingTarget) renderDrops(fallingTarget);

    // springWater stays the authoritative FULL body (pool + falling) so irrigation,
    // waterCells() and conservation see every cell regardless of how it's drawn.
    springWater.clear();
    for (const k of next) springWater.add(k);
    return changed;
  }

  // Reconcile the pool mesh against the resting-cell set (keyed by its own slot map
  // so pool⇄falling transitions move a cell cleanly between meshes). Each cell is
  // drawn thin when it is the exposed surface (no pool water directly above) and
  // full when submerged; the map remembers the drawn state so a cell re-renders
  // when the pool rises over it (thin→full) or drains off it (full→thin).
  function reconcilePool(target: Set<string>): number {
    let changed = 0;
    // Continuous surface height for a cell: full if submerged (water directly above),
    // else a film that feathers by how many horizontal neighbours are also water —
    // WATER_THIN in the interior tapering to WATER_THIN*EDGE_MIN at the rim. Quantised
    // to 0.02 steps so ripples don't thrash the instance buffer every tick.
    const hFracOf = (k: string) => {
      const [x, y, z] = k.split(",").map(Number);
      if (target.has(KEY(x, y + 1, z))) return 1;
      let n = 0;
      for (const [dx, dz] of HDIRS) if (target.has(KEY(x + dx, y, z + dz))) n++;
      const t = n / 4, sm = t * t * (3 - 2 * t);
      const f = WATER_THIN * (EDGE_MIN + (1 - EDGE_MIN) * sm);
      return Math.round(f * 50) / 50;
    };
    for (const k of [...waterSlot.keys()]) {
      if (!target.has(k)) {
        const slot = waterSlot.get(k)!;
        waterMesh.setMatrixAt(slot, ZERO);
        waterFree.push(slot); waterSlot.delete(k); waterThin.delete(k); changed++;
      }
    }
    for (const k of target) {
      const f = hFracOf(k);
      if (!waterSlot.has(k)) {
        const slot = waterFree.pop();
        if (slot === undefined) break; // cap reached
        const [x, y, z] = k.split(",").map(Number);
        setCell(waterMesh, slot, x, y, z, f);
        waterSlot.set(k, slot); waterThin.set(k, f); changed++;
      } else if (waterThin.get(k) !== f) {
        const [x, y, z] = k.split(",").map(Number);
        setCell(waterMesh, waterSlot.get(k)!, x, y, z, f);
        waterThin.set(k, f); changed++;
      }
    }
    if (changed) {
      waterMesh.instanceMatrix.needsUpdate = true;
      let ms = -1; for (const s of waterSlot.values()) if (s > ms) ms = s;
      waterMesh.count = ms + 1;
    }
    return changed;
  }

  // Deterministic per-cell droplet offsets (stable so a vertical stream reads as
  // coherent falling lanes, not flicker). Horizontal jitter + vertical spread so
  // the full voxel visibly breaks into a spray as it falls.
  function placeDrop(slot: number, x: number, y: number, z: number, i: number, white = 0) {
    const hx = (mix32((x * 73856093) ^ (z * 19349663) ^ (i * 83492791)) & 0xffff) / 0xffff;
    const hz = (mix32((i * 40503) ^ (x * 12289) ^ (z * 6151)) & 0xffff) / 0xffff;
    const hw = (mix32((i * 2654435761) ^ (x * 40499) ^ (z * 92821)) & 0xffff) / 0xffff;
    const jx = (hx - 0.5) * DROP_SPREAD * voxel;
    const jz = (hz - 0.5) * DROP_SPREAD * voxel;
    // Streak droplets DOWNWARD from just above the cell to `streak` voxels below it,
    // so a cell's spray reaches toward the next falling cell and bridges the gap.
    // hz de-correlates the vertical march from the index-ordered lanes (avoids a
    // rigid grid). Streak length scales with fall speed = motion blur.
    const streak = STREAK_MIN + (STREAK_MAX - STREAK_MIN) * white;
    const t = SUBVOX > 1 ? (i + hz) / SUBVOX : 0; // 0 (top) → ~1 (bottom of the streak)
    const jy = (0.25 - t * (streak + 0.25)) * voxel;
    // Size spectrum: hash gives a small-biased class (0.5–1.6); fast falls shrink
    // toward fine mist. Big chunky drops + fine spray in the same curtain.
    const sizeClass = 0.5 + 1.1 * hx * hx;
    // Edge/tail atomization: the coherent core near the lip stays chunky; drops
    // finer toward the BOTTOM of the streak (tailFine) and toward the horizontal
    // EDGES of the curtain (edgeFine) so the periphery reads as fine mist.
    const tailFine = 1 - 0.6 * t;
    const rad = Math.min(1, 2 * Math.hypot(hx - 0.5, hz - 0.5));
    const edgeFine = 1 - 0.55 * rad;
    const sizeMul = sizeClass * (1 - DROP_MIST * white) * tailFine * edgeFine;
    dummy.position.set((x - cxRound) * voxel + jx, y * voxel + jy, (z - czRound) * voxel + jz);
    // Random per-drop rotation so each droplet's faces catch the sun at a different
    // angle — the curtain shimmers and shades under real light instead of reading as
    // a flat sheet of aligned cubes (the "interact with the light" ask).
    dummy.rotation.set(hx * 6.2832, hz * 6.2832, hw * 6.2832);
    dummy.scale.set(sizeMul, sizeMul, sizeMul);
    dummy.updateMatrix();
    dropMesh.setMatrixAt(slot, dummy.matrix);
    if (dropMesh.instanceColor) {
      // A true MIX of blue (coherent water) and white (aerated foam) droplets,
      // split PER-DROP rather than a uniform speed tint: faster flow turns a larger
      // fraction white, but a share always stays blue so the curtain reads blue+white
      // and never goes monochrome. `hw` selects which drop is which.
      const whiteChance = BASE_WHITE + 0.62 * white;      // speed raises the white fraction
      const wf = hw < whiteChance
        ? DROP_WHITE * (0.62 + 0.38 * hz)                 // aerated: strong white, slight variance
        : 0.10 * hz;                                       // coherent: stays blue, faint sheen
      _dropTmp.copy(_dropBlue).lerp(_dropWhite, wf);
      dropMesh.setColorAt(slot, _dropTmp);
    }
  }

  // Reconcile the droplet mesh against the falling-cell set.
  function renderDrops(falling: Set<string>) {
    if (!dropMesh) return;
    let changed = 0;
    for (const [k, slots] of [...dropSlots]) {
      if (!falling.has(k)) {
        for (const s of slots) { dropMesh.setMatrixAt(s, ZERO); dropFree.push(s); }
        dropSlots.delete(k); changed++;
      }
    }
    for (const k of falling) {
      if (!dropSlots.has(k)) {
        const [x, y, z] = k.split(",").map(Number);
        const slots: number[] = [];
        // Phase 2 jet disintegration (cosmetic): spray density scales with the
        // falling cell's momentum — a fast fall reads as a dense broken jet, a
        // slow dribble as sparse drops. Momentum off ⇒ classic full SUBVOX.
        const _s = momEnabled ? (momField.get(k)?.s ?? 0) : momCfg.maxSpeed;
        const white = momEnabled ? Math.min(1, _s / momCfg.maxSpeed) : 0;
        const want = Math.max(1, Math.round(SUBVOX * (0.4 + 0.6 * Math.min(1, _s / momCfg.maxSpeed))));
        for (let i = 0; i < want; i++) {
          const s = dropFree.pop();
          if (s === undefined) break; // cap reached
          placeDrop(s, x, y, z, i, white);
          slots.push(s);
        }
        if (slots.length) { dropSlots.set(k, slots); changed++; }
      }
    }
    if (changed) {
      dropMesh.instanceMatrix.needsUpdate = true;
      if (dropMesh.instanceColor) dropMesh.instanceColor.needsUpdate = true;
      let ms = -1; for (const slots of dropSlots.values()) for (const s of slots) if (s > ms) ms = s;
      dropMesh.count = ms + 1;
    }
  }

  // Build the capped waterfall mesh (same translucent look as the pool).
  function buildWaterfallMesh() {
    if (!WATERFALL_ON) return;
    waterfallMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: waterColor, transparent: true, opacity: 0.66, roughness: 0.22, metalness: 0.0 }),
      WATERFALL_CAP,
    );
    waterfallMesh.count = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < WATERFALL_CAP; i++) { waterfallMesh.setMatrixAt(i, zero); wfFree.push(i); }
    waterfallMesh.instanceMatrix.needsUpdate = true;
    waterfallMesh.frustumCulled = false;
    scene.add(waterfallMesh);
  }

  // Small-box mesh for the falling-cell droplet spray (CA path).
  function buildDropMesh() {
    if (!SPLIT_ON) return;
    const s = cellSize * DROP_SCALE;
    const dropBox = new THREE.BoxGeometry(s, s, s);
    dropMesh = new THREE.InstancedMesh(
      dropBox,
      // Base white so per-instance colour (blue veil → white core) reads true.
      // Lower opacity: with 10x more overlapping drops the curtain builds density by
      // stacking, so each drop is lighter and the mass reads as mist not a solid wall.
      // roughness 0.14 keeps a crisp sun glint on the randomly-rotated faces.
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, roughness: 0.14, metalness: 0.0 }),
      DROP_CAP,
    );
    dropMesh.count = 0;
    dropMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DROP_CAP * 3), 3);
    for (let i = 0; i < DROP_CAP; i++) { dropMesh.setMatrixAt(i, ZERO); dropMesh.setColorAt(i, _dropBlue); dropFree.push(i); }
    dropMesh.instanceMatrix.needsUpdate = true;
    dropMesh.instanceColor.needsUpdate = true;
    dropMesh.frustumCulled = false;
    scene.add(dropMesh);
  }

  const occupied = (x: number, y: number, z: number) => isSolid(x, y, z) || springWater.has(KEY(x, y, z));

  // Scan the pool for overflow lips and (re)build the falling columns.
  function renderWaterfalls() {
    // Under CA flow the pool water itself falls off the edge as REAL cells, so
    // the matter-neutral overlay is redundant and would double-draw. Skip it.
    if (CA_ON) return;
    if (!WATERFALL_ON || !waterfallMesh) return;
    const next = new Set<string>();
    outer:
    for (const k of springWater) {
      const [x, y, z] = k.split(",").map(Number);
      // Only the pool SURFACE overflows — a cell with water above it is a
      // vertical face, not a lip, and must not spawn a curtain of falls.
      if (occupied(x, y + 1, z)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, nz = z + dz;
        // Lip = neighbour is air at pool level AND air directly below it (a drop).
        if (occupied(nx, y, nz) || occupied(nx, y - 1, nz)) continue;
        for (let yy = y; yy > y - WATERFALL_MAXDROP; yy--) {
          if (occupied(nx, yy, nz)) break;         // landed on solid or the pool below
          next.add(KEY(nx, yy, nz));
          if (next.size >= WATERFALL_CAP) break outer;
        }
      }
    }
    reconcileWaterfall(next);
  }

  function reconcileWaterfall(next: Set<string>) {
    let changed = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const k of wfSet) {
      if (!next.has(k)) {
        const slot = wfSlot.get(k);
        if (slot !== undefined) { waterfallMesh.setMatrixAt(slot, zero); wfFree.push(slot); wfSlot.delete(k); changed++; }
      }
    }
    for (const k of next) {
      if (!wfSet.has(k)) {
        const slot = wfFree.pop();
        if (slot === undefined) break;
        const [x, y, z] = k.split(",").map(Number);
        setCell(waterfallMesh, slot, x, y, z);
        wfSlot.set(k, slot); changed++;
      }
    }
    wfSet.clear();
    for (const k of next) if (wfSlot.has(k)) wfSet.add(k);
    if (changed) {
      waterfallMesh.instanceMatrix.needsUpdate = true;
      let maxSlot = -1; for (const s of wfSlot.values()) if (s > maxSlot) maxSlot = s;
      waterfallMesh.count = maxSlot + 1;
    }
  }

  // Called every frame from the render loop; self-throttled.
  function tick(nowMs: number, weather: { precip?: number | null; isRaining?: boolean }) {
    if (!active || !emitter) return;

    // Drive the animated water surface every frame; recompute the depth-tint
    // surface reference (highest filled cell) on a 1s cadence so a filling
    // basin tints deeper as it rises without per-frame set scanning.
    if (waterSurfUniforms) {
      waterSurfUniforms.uTime.value = nowMs * 0.001;
      if (nowMs - lastSurfScan >= 1000) {
        lastSurfScan = nowMs;
        maxWaterVy = -Infinity;
        for (const k of springWater) { const _y = +k.split(",")[1]; if (_y > maxWaterVy) maxWaterVy = _y; }
        if (isFinite(maxWaterVy)) waterSurfUniforms.uWaterTopY.value = maxWaterVy * voxel;
        // Phase 3: fill the per-instance flow attribute for the V3 foam shader.
        // foam01 = momentum speed (white water in the channel / at the plunge)
        // maxed with a small shoreline term on exposed rim cells (lapping edge).
        // Momentum off ⇒ zeros ⇒ calm V2 look everywhere.
        if (flowAttr) {
          let fc = 0, fsum = 0;
          const arr = flowAttr.array as Float32Array;
          for (const [k, slot] of waterSlot) {
            const o = slot * 3;
            if (!momEnabled) { arr[o] = 0; arr[o + 1] = 0; arr[o + 2] = 0; continue; }
            const [x, y, z] = k.split(",").map(Number);
            const m = momField.get(k);
            const spd = m ? Math.min(1, m.s / momCfg.maxSpeed) : 0;
            let shore = 0;
            if (!springWater.has(KEY(x, y + 1, z))) {
              let n = 0;
              for (const [dx, dz] of HDIRS) if (springWater.has(KEY(x + dx, y, z + dz))) n++;
              if (n < 4) shore = 0.16;
            }
            const foam = Math.max(spd, shore);
            if (m && (m.vx !== 0 || m.vz !== 0)) { arr[o] = m.vx; arr[o + 1] = m.vz; }
            else { arr[o] = 0; arr[o + 1] = 0; }
            arr[o + 2] = foam;
            if (foam > 0.02) { fc++; fsum += foam; }
          }
          flowAttr.needsUpdate = true;
          lastFoam = { cells: fc, mean: fc ? Math.round((fsum / fc) * 1000) / 1000 : 0 };
        }
      }
    }

    // Rain funds the reservoir (own cadence).
    if (nowMs - lastTick >= TICK_MS) {
      lastTick = nowMs;
      const precip = typeof weather.precip === "number" ? weather.precip : 0;
      if (weather.isRaining && precip > 0) { state = applyRain(state, precip, RAIN_K); persist(); }
    }

    if (!CA_ON) {
      // Legacy instant resting-solve path (?cawater=0).
      if (nowMs - lastFlow < TICK_MS) return;
      lastFlow = nowMs;
      if (springWater.size >= CAPACITY) return;
      const r = springEmit(state, emitter, PER_TICK);
      if (!r.emit) return;
      state = r.state;
      fill(PER_TICK);
      persist();
      return;
    }

    // CA path: grow the pool from the source (funded, self-leveling) and advance
    // the flow, each on its own cadence. growStep grows the lake as a flat sheet /
    // bottom-up basin fill from a point (jitter-free); flowStep animates the fall
    // from a perch and the spill off a filled basin's lip. Net: it wells up and
    // self-levels, never towers on open ground, and pours off real edges.
    if (nowMs - lastEmit >= EMIT_MS) { lastEmit = nowMs; growStep(); }
    if (nowMs - lastFlow >= FLOW_MS) { lastFlow = nowMs; flowStep(); persist(); }
  }

  // Spring-water cells (for the irrigation pass in the host app, which unions
  // these with scan-pond water to decide which soil is watered).
  function waterCells(): Vec3[] {
    const out: Vec3[] = [];
    for (const k of springWater) { const [x, y, z] = k.split(",").map(Number); out.push([x, y, z]); }
    return out;
  }

  return {
    init,
    tick,
    waterCells,
    isActive: () => active,
    // Debug knobs (attached to __tw).
    rainNow: (n = 200) => { state = applyRain(state, n, 1); persist(); return report(); },
    springHere: () => (origin ? { origin } : { error: "no spring" }),
    report,
    momentumReport,
    // Live momentum knob: __tw.momentum({enabled, inject, frictionRest,
    // frictionDeep, frictionFlow, weirK, weirRes, maxSpeed}). Disabling clears
    // the field so re-enabling starts from a calm baseline.
    momentum: (o: Partial<typeof momCfg & { enabled: boolean }> = {}) => {
      if (o.enabled != null) {
        momEnabled = CA_ON && !!o.enabled;
        if (!momEnabled) momField.clear();
      }
      for (const k of Object.keys(momCfg) as Array<keyof typeof momCfg>) {
        const v = (o as any)[k];
        if (typeof v === "number" && Number.isFinite(v)) momCfg[k] = v;
      }
      return momentumReport();
    },
    // Live hydrostatic knob: __tw.pressure(true/false) toggles the head-gradient
    // lateral rule vs the classic BFS spread. No field to clear (it reads live).
    pressure: (on?: boolean, rate?: number) => {
      if (on != null) hydroEnabled = CA_ON && !!on;
      if (typeof rate === "number" && Number.isFinite(rate)) carryRate = rate;   // forward-discharge enable
      return { hydro: hydroEnabled, carryRate, fwdHeadK, fwdDischargeK, carrySpeedMin };
    },
    // Live forward-discharge budget knobs (device tuning of channel depth / river feel).
    carry: (cfg?: { headK?: number; dischargeK?: number; speedMin?: number; rate?: number }) => {
      if (cfg) {
        if (Number.isFinite(cfg.headK!)) fwdHeadK = cfg.headK!;
        if (Number.isFinite(cfg.dischargeK!)) fwdDischargeK = cfg.dischargeK!;
        if (Number.isFinite(cfg.speedMin!)) carrySpeedMin = cfg.speedMin!;
        if (Number.isFinite(cfg.rate!)) carryRate = cfg.rate!;
      }
      return { carryRate, fwdHeadK, fwdDischargeK, carrySpeedMin };
    },
  };

  function momentumReport() {
    let sum = 0, mx = 0;
    for (const m of momField.values()) { sum += m.s; if (m.s > mx) mx = m.s; }
    const now = performance.now();
    let recent = 0;
    for (let i = momOvertopLog.length - 1; i >= 0 && now - momOvertopLog[i] <= 10_000; i--) recent++;
    return {
      enabled: momEnabled,
      hydro: hydroEnabled,
      trackedCells: momField.size,
      // meanSpeed is over the WHOLE water body (cells without an entry are calm, s=0).
      meanSpeed: springWater.size ? Math.round((sum / springWater.size) * 1000) / 1000 : 0,
      maxSpeed: Math.round(mx * 1000) / 1000,
      overtopPerSec: Math.round((recent / 10) * 100) / 100,
      dropsTotal: momDropsTotal,
      overtopsTotal: momOvertopsTotal,
      foam: { ...lastFoam },
      params: { ...momCfg },
    };
  }

  function report() {
    return {
      active,
      origin,
      emitter,
      budget: Math.round(state.budget),
      capacity: CAPACITY,
      waterCells: springWater.size,
      waterfallCells: wfSet.size,
      ca: CA_ON,
      floorY,
      stepCount,
      culledTotal,
      split: SPLIT_ON,
      edgeHold: EDGE_HOLD,
      fallingCells: dropSlots.size,
      dwelling: dwell.size,
      poolBBox: (() => { let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity; for (const k of springWater){const[x,y,z]=k.split(",").map(Number); x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);z0=Math.min(z0,z);z1=Math.max(z1,z);} return springWater.size?{x:[x0,x1],y:[y0,y1],z:[z0,z1],w:x1-x0+1,h:y1-y0+1,d:z1-z0+1}:null; })(),
      params: { ceilBand: CEIL_BAND, rainK: RAIN_K, perTick: PER_TICK, tickMs: TICK_MS, fillRadius: FILL_RADIUS, waterfall: WATERFALL_ON, demo: DEMO },
      seed: theSeed,
    };
  }
}
