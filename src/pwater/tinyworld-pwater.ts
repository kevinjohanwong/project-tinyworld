// TinyWorld water bridge — terrace-spring automaton (Sep 3 full replacement).
//
// KJ's terrace-spring build replaces the particle solver wholesale: water is
// a per-cell MASS driven by three rules (fall+compression, level with
// thin-film cling, squeeze up) plus lip momentum, rendered as a surface-nets
// isosurface + path-traced fall ribbons (terrace-water.ts). The old particle
// pipeline (sim-driver/particles/fluid-ssfr/fluid-hifi) is out of the path.
//
// This module keeps the world bridge unchanged: crop the live voxel
// occupancy into a solid grid (K-coarsened on fine-voxel scan worlds), site
// the spring, feed the moisture field (waterCells), accept live terrain
// edits (onSolidEdit), and report. External contract (createParticleWater,
// renderFrame/report/knob/waterCells/onSolidEdit/dispose) is unchanged.
import { createTerraceWater } from "./terrace-water";

export type PWaterCtx = {
  THREE: any;
  renderer: any;
  scene: any;
  // Solid oracle: drawn voxels per column ("x,z" -> Set<y>) + latent fill.
  colMap: Map<string, Set<number>>;
  extraSolid?: (x: number, y: number, z: number) => boolean;
  // Latent column tops ("x,z" -> highest un-spent latent y). Latent mass is
  // real terrain for the water (KJ ruling, Aug 13): the route march and box
  // bounds must see a latent-only mass (mesa, building fill) as high ground,
  // not a void the route could march straight through. Cell solidity inside
  // the box already comes from extraSolid; this is the ROUTING view.
  extraColTops?: Map<string, number>;
  voxel: number;
  cxRound: number;
  czRound: number;
  // Spring emitter cell (voxel coords) — the sited spring origin.
  origin: { x: number; y: number; z: number };
  // Live lights for palette + shadow sampling (same picks as the GI pass).
  sun: any;
  moon: any;
  hemi: any;
  params: URLSearchParams;
};

type Terrain = {
  nx: number; ny: number; nz: number;
  solid: Uint8Array;
  source: [number, number, number];
  basin: { x0: number; x1: number; z0: number; z1: number };
  rimY: number;
  wallOpen: { px: Uint8Array; mx: Uint8Array; pz: Uint8Array; mz: Uint8Array };
};

// Crop budget. The automaton allocates ~22 Float32 fields over the box, so
// its ceiling is lower than the particle system's hash-grid budget was
// (1.5M cells ≈ 130 MB of fields; leslielab's whole footprint is ~880k).
const MAX_CELLS = 1_500_000;
const STEP_HZ = 120; // automaton steps/sec (terrace: 2 per frame at 60fps)

export function createParticleWater(ctx: PWaterCtx) {
  const { THREE, renderer, scene, voxel, cxRound, czRound, params } = ctx;
  const { colMap: colMapF, extraSolid: extraSolidF, extraColTops: extraColTopsF, origin: originF } = ctx;
  const num = (name: string, dflt: number) => {
    const v = params.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  // ── Sim-cell scale K (1 sim cell = K^3 world voxels) ────────────────────
  // The automaton is scale-similar in CELL space (every constant is a cell
  // count/fraction). On fixed-metric scan worlds the voxel is 0.015 m, so a
  // 1-cell water grid would be sub-centimetre film — pick K so a sim cell
  // lands near 6 cm on fine-voxel worlds (leslielab 0.015 -> K=4; fresh
  // scans pass the conquest-shapes 1.5x coarsen so 0.015 -> 0.0225 -> K=3)
  // and keep K=1 on every coarse world/bed (voxel >= 0.03). ?pwk= overrides.
  const kDefault = voxel < 0.03 ? Math.max(1, Math.min(8, Math.round(0.06 / voxel))) : 1;
  const K = Math.max(1, Math.min(16, Math.round(num("pwk", kDefault))));
  const cellV = voxel * K; // world metres per sim cell
  const fineSolidAt = (x: number, y: number, z: number) =>
    (colMapF.get(`${x},${z}`)?.has(y) ?? false) || (extraSolidF ? extraSolidF(x, y, z) : false);

  // Coarse solid-oracle views. Base rule: a sim cell is solid when ANY of its
  // K^3 fine voxels is solid (a 1-voxel crust floor stays watertight). That
  // alone lets a single scan-noise voxel raise the whole ~6cm cell, so the
  // water sees a jagged, inflated bed and one pool shatters into puddles.
  // Refinement: a cell whose fine occupancy can't form even half a watertight
  // membrane (< K^2/2 voxels) AND that rests on a solid cell below is a noise
  // spike, not structure — cull it. Crusts/walls keep >= K^2 occupancy so
  // they always pass; culling supported cells can't open a vertical leak
  // (water lands on the cell below), so tightness is preserved.
  // Latent fill is probed along the block's centre column (latent mass is
  // bulk column fill; edges thin by < 1 cell and the drawn crust skins them).
  let colMap = colMapF;
  let extraSolid = extraSolidF;
  let extraColTops = extraColTopsF;
  let origin = originF;
  if (K > 1) {
    const t0k = performance.now();
    const m = new Map<string, Set<number>>();
    const cnt = new Map<string, number>();
    for (const [key, set] of colMapF) {
      const c = key.indexOf(",");
      const ck = Math.floor(+key.slice(0, c) / K) + "," + Math.floor(+key.slice(c + 1) / K);
      let s = m.get(ck);
      if (!s) m.set(ck, (s = new Set()));
      for (const y of set) {
        const cy = Math.floor(y / K);
        s.add(cy);
        const bk = ck + "," + cy;
        cnt.set(bk, (cnt.get(bk) ?? 0) + 1);
      }
    }
    const TH = Math.ceil((K * K) / 2);
    let culled = 0;
    for (const [ck, s] of m) {
      const orig = new Set(s);
      for (const cy of orig) {
        if (!orig.has(cy - 1)) continue;
        if ((cnt.get(ck + "," + cy) ?? 0) >= TH) continue;
        s.delete(cy);
        culled++;
      }
      if (s.size === 0) m.delete(ck);
    }
    colMap = m;
    extraSolid = extraSolidF
      ? (x: number, y: number, z: number) => {
          const fx = x * K + (K >> 1), fz = z * K + (K >> 1);
          for (let fy = y * K; fy < y * K + K; fy++) if (extraSolidF(fx, fy, fz)) return true;
          return false;
        }
      : undefined;
    if (extraColTopsF) {
      const t = new Map<string, number>();
      for (const [key, v] of extraColTopsF) {
        const c = key.indexOf(",");
        const ck = Math.floor(+key.slice(0, c) / K) + "," + Math.floor(+key.slice(c + 1) / K);
        const cv = Math.floor(v / K);
        const prev = t.get(ck);
        if (prev == null || cv > prev) t.set(ck, cv);
      }
      extraColTops = t;
    }
    origin = { x: Math.floor(originF.x / K), y: Math.floor(originF.y / K), z: Math.floor(originF.z / K) };
    console.log(
      `[pwater] sim cell = ${K}x voxel (${(cellV * 100).toFixed(1)} cm): ` +
      `coarsened ${colMapF.size} -> ${colMap.size} cols, ${culled} spike cells culled (th ${TH}) in ${((performance.now() - t0k) | 0)}ms`,
    );
  }

  // ── Terrain crop around the spring ──────────────────────────────────────
  // A circular spring-centred crop can cut a real downstream basin out of the
  // simulation on large worlds. Route the domain along the actual terrain
  // surface first, then pad that route. This only chooses the finite solver
  // boundary; water motion inside remains entirely automaton-driven.
  let half = Math.max(16, Math.round(num("pwbox", 48)));
  let minX = origin.x, maxX = origin.x, minZ = origin.z, maxZ = origin.z, maxY = origin.y;
  let minSolidY = origin.y;
  for (const key of colMap.keys()) {
    const c = key.indexOf(",");
    const x = +key.slice(0, c);
    const z = +key.slice(c + 1);
    if (x < minX) minX = x; else if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
  }
  for (const set of colMap.values()) for (const y of set) {
    if (y > maxY) maxY = y;
    if (y < minSolidY) minSolidY = y;
  }

  const tops = new Map<string, number>();
  for (const [key, set] of colMap) {
    let top = -Infinity;
    for (const y of set) if (y > top) top = y;
    if (Number.isFinite(top)) tops.set(key, top);
  }
  let latentTops = 0;
  if (extraColTops) for (const [key, t] of extraColTops) {
    const prev = tops.get(key);
    if (prev == null || t > prev) {
      tops.set(key, t);
      latentTops++;
      const c = key.indexOf(",");
      const x = +key.slice(0, c);
      const z = +key.slice(c + 1);
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
      if (t > maxY) maxY = t;
    }
  }
  const routeEnabled = params.get("pwroute") !== "0";
  const routeLimit = Math.max(0, Math.min(160, Math.round(num("pwroutesteps", 96))));
  const routePad = Math.max(6, Math.min(32, Math.round(num("pwroutepad", 14))));
  const route: Array<[number, number]> = [[origin.x, origin.z]];
  if (routeEnabled && routeLimit > 0) {
    let x = origin.x, z = origin.z;
    const visited = new Set([`${x},${z}`]);
    const FLAT_MAX = 20000, ROUTE_MAX = 8000;
    for (let step = 0; step < routeLimit && route.length < ROUTE_MAX; step++) {
      const here = tops.get(`${x},${z}`);
      if (here == null) break;
      let next: { x: number; z: number; y: number; d2: number } | null = null;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx, nz = z + dz;
        const key = `${nx},${nz}`;
        if (visited.has(key)) continue;
        const y = tops.get(key);
        if (y == null || y >= here) continue;
        const candidate = { x: nx, z: nz, y, d2: dx * dx + dz * dz };
        if (!next || y < next.y || (y === next.y && candidate.d2 < next.d2)) next = candidate;
      }
      if (!next) {
        // Flat cell: real water spreads level until it reaches the flat's
        // spill edge, so the route must cross the flat, not stop on it. BFS
        // over equal-height cells for a strictly lower neighbour; a flat with
        // no spill anywhere is a true terminal basin and ends the route.
        const start = `${x},${z}`;
        const parent = new Map<string, string>([[start, ""]]);
        const queue: string[] = [start];
        let spillKey: string | null = null;
        let spillNext: { x: number; z: number } | null = null;
        for (let qi = 0; qi < queue.length && qi < FLAT_MAX && !spillKey; qi++) {
          const [cx, cz] = queue[qi].split(",").map(Number);
          for (let dz = -1; dz <= 1 && !spillKey; dz++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const nx = cx + dx, nz = cz + dz;
            const nk = `${nx},${nz}`;
            const y = tops.get(nk);
            if (y == null) continue;
            if (y < here) { spillKey = queue[qi]; spillNext = { x: nx, z: nz }; break; }
            if (y === here && !parent.has(nk) && !visited.has(nk)) { parent.set(nk, queue[qi]); queue.push(nk); }
          }
        }
        if (!spillKey || !spillNext) break;
        for (let k: string | undefined = spillKey; k && k !== start; k = parent.get(k)) {
          const [px, pz] = k.split(",").map(Number);
          visited.add(k);
          route.push([px, pz]);
          if (route.length >= ROUTE_MAX) break;
        }
        next = { x: spillNext.x, z: spillNext.z, y: tops.get(`${spillNext.x},${spillNext.z}`)!, d2: 0 };
      }
      x = next.x; z = next.z;
      visited.add(`${x},${z}`);
      route.push([x, z]);
    }
  }
  let routeMinX = origin.x, routeMaxX = origin.x, routeMinZ = origin.z, routeMaxZ = origin.z;
  for (const [x, z] of route) {
    routeMinX = Math.min(routeMinX, x); routeMaxX = Math.max(routeMaxX, x);
    routeMinZ = Math.min(routeMinZ, z); routeMaxZ = Math.max(routeMaxZ, z);
  }

  const clampBox = () => {
    const x0 = Math.max(minX - 2, Math.min(origin.x - half, routeMinX - routePad));
    const x1 = Math.min(maxX + 3, Math.max(origin.x + half, routeMaxX + routePad));
    const z0 = Math.max(minZ - 2, Math.min(origin.z - half, routeMinZ - routePad));
    const z1 = Math.min(maxZ + 3, Math.max(origin.z + half, routeMaxZ + routePad));
    // Floor the domain at the world's lowest solid, not absolute y=0: water
    // always rests ON a solid, so cells below the lowest solid are pure void
    // (an off-world fall drains at the bottom layer a few cells under the
    // island's underside). World cell coords can be NEGATIVE (scan worlds
    // centre near 0), so the floor must not clamp at 0.
    const y0 = minSolidY - 6;
    // Ceiling at spring height, not world height: the level rule only moves
    // water down or level, so nothing can ever rest above the spring outlet.
    // Sizing ny to the world's tallest solid lets one spire (tower, stair)
    // inflate every column of the box, blow the cell budget, and shrink the
    // XZ footprint until real pools get truncated mid-meadow.
    const y1 = Math.min(maxY + 4, origin.y + 8);
    return { x0, x1, z0, z1, y0, y1 };
  };
  let box = clampBox();
  while ((box.x1 - box.x0) * (box.z1 - box.z0) * (box.y1 - box.y0) > MAX_CELLS && half > 16) {
    half = Math.round(half * 0.8);
    box = clampBox();
  }
  // Whole-world domain when the budget allows: every wall then sits in true
  // void, so boundaries are all honest island-edge drains. ?pwbox=N keeps
  // the sized disc; ?pwgrow=0 disables.
  let domain = "routed";
  if (params.get("pwbox") == null && params.get("pwgrow") !== "0") {
    const wx0 = minX - 2, wx1 = maxX + 3, wz0 = minZ - 2, wz1 = maxZ + 3;
    if ((wx1 - wx0) * (wz1 - wz0) * (box.y1 - box.y0) <= MAX_CELLS) {
      box = { x0: wx0, x1: wx1, z0: wz0, z1: wz1, y0: box.y0, y1: box.y1 };
      domain = "whole-world";
    }
  }
  const nx = box.x1 - box.x0;
  const ny = box.y1 - box.y0;
  const nz = box.z1 - box.z0;
  const t0 = performance.now();
  const solid = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    const wz = box.z0 + z;
    for (let x = 0; x < nx; x++) {
      const wx = box.x0 + x;
      const col = colMap.get(`${wx},${wz}`);
      for (let y = 0; y < ny; y++) {
        const wy = box.y0 + y;
        if ((col && col.has(wy)) || (extraSolid && extraSolid(wx, wy, wz))) {
          solid[(y * nz + z) * nx + x] = 1;
        }
      }
    }
  }
  // Wall openness is recorded for reporting/compat; the automaton's only
  // world exit is the bottom layer (true void under the island), which the
  // whole-world domain guarantees. Closed walls are naturally no-flow (the
  // level rule never crosses the grid boundary).
  const outsideHasSolid = (wx: number, wz: number, dx: number, dz: number) => {
    for (let s = 1; s <= 4; s++) {
      const qx = wx + dx * s;
      const qz = wz + dz * s;
      const col = colMap.get(`${qx},${qz}`);
      if (col) {
        for (const y of col) if (y >= box.y0 && y <= box.y1) return true;
      }
      if (extraSolid) {
        for (let y = box.y0; y <= box.y1; y++) if (extraSolid(qx, y, qz)) return true;
      }
    }
    return false;
  };
  const wallOpen = {
    px: new Uint8Array(nz),
    mx: new Uint8Array(nz),
    pz: new Uint8Array(nx),
    mz: new Uint8Array(nx),
  };
  for (let z = 0; z < nz; z++) {
    const wz = box.z0 + z;
    wallOpen.px[z] = outsideHasSolid(box.x1 - 1, wz, 1, 0) ? 0 : 1;
    wallOpen.mx[z] = outsideHasSolid(box.x0, wz, -1, 0) ? 0 : 1;
  }
  for (let x = 0; x < nx; x++) {
    const wx = box.x0 + x;
    wallOpen.pz[x] = outsideHasSolid(wx, box.z1 - 1, 0, 1) ? 0 : 1;
    wallOpen.mz[x] = outsideHasSolid(wx, box.z0, 0, -1) ? 0 : 1;
  }
  const _openCount = (a: Uint8Array) => { let n = 0; for (const v of a) n += v; return n; };
  const terrain: Terrain = {
    nx, ny, nz, solid,
    source: [origin.x - box.x0 + 0.5, origin.y - box.y0 + 0.5, origin.z - box.z0 + 0.5],
    basin: {
      x0: Math.max(0, origin.x - box.x0 - 8), x1: Math.min(nx, origin.x - box.x0 + 8),
      z0: Math.max(0, origin.z - box.z0 - 8), z1: Math.min(nz, origin.z - box.z0 + 8),
    },
    rimY: Math.floor(origin.y - box.y0 + 2),
    wallOpen,
  };
  console.log(
    `[pwater] terrain crop ${nx}x${ny}x${nz} ${domain} (${((performance.now() - t0) | 0)}ms), ` +
    `basin cell (${origin.x},${origin.y},${origin.z}), latent tops ${latentTops}, route ${route.length} cells ` +
    `(${route[route.length - 1][0]},${route[route.length - 1][1]}), automaton spring` +
    `, walls open px ${_openCount(wallOpen.px)}/${nz} mx ${_openCount(wallOpen.mx)}/${nz}` +
    ` pz ${_openCount(wallOpen.pz)}/${nx} mz ${_openCount(wallOpen.mz)}/${nx}`,
  );

  // ── Automaton ───────────────────────────────────────────────────────────
  // Spring rate: mass/step (terrace default 0.09; its UI range is 0.02–0.30).
  // ?pwrate values > 2 are treated as the old particle drops/s convention and
  // mapped onto the terrace default so stale URLs don't fire a firehose.
  const rateRaw = num("pwrate", 0.09);
  const springRate = rateRaw > 2 ? 0.09 : Math.max(0, rateRaw);
  // ?pwwarm= sim-seconds fast-forwarded on load (default 90, matches the old
  // particle warm-up contract; terrace's own boot warm is 75 s).
  const warmSecs = Math.max(0, num("pwwarm", 90));
  // ?pwribnorm= per-cell fall density at which ribbons hit full width/whiteness.
  // Terrace reference tuned 0.03 on its small demo grid; our K-coarsened worlds
  // carry less mass per fall cell, so the default is recalibrated denser.
  const ribNorm = Math.max(0.001, num("pwribnorm", 0.005));
  // ?pwmom=0 disables momentum-everywhere (falls back to lip-only momentum).
  const momentum = params.get("pwmom") !== "0";
  // ?pwdrops=0 disables ballistic droplets (all lip outflow stays on the grid).
  const drops = params.get("pwdrops") !== "0";
  const ctr = (K - 1) / (2 * K);
  const offX = box.x0 - cxRound / K - 0.5 + ctr;
  const offY = box.y0 - 0.5 + ctr;
  const offZ = box.z0 - czRound / K - 0.5 + ctr;
  const water = createTerraceWater({
    THREE, renderer,
    nx, ny, nz, solid,
    spring: { x: origin.x - box.x0, y: origin.y - box.y0, z: origin.z - box.z0 },
    off: { x: offX, y: offY, z: offZ },
    cellV,
    springRate,
    warmSteps: Math.round(warmSecs * STEP_HZ),
    ribNorm,
    momentum,
    drops,
  });
  console.log(`[pwater] terrace automaton grid ${nx}x${ny}x${nz}, spring rate ${springRate}/step, warm ${warmSecs}s, ribNorm ${ribNorm}, momentum ${momentum ? "on" : "off"}, droplets ${drops ? "on" : "off"}`);

  const sunDir = new THREE.Vector3(0, 1, 0);
  const sizeV = new THREE.Vector2();
  let lastW = 0;
  let lastH = 0;
  let lastSimMs = 0;
  let lastSteps = 0;

  function renderFrame(camera: any): boolean {
    const key = ctx.moon.intensity > ctx.sun.intensity ? ctx.moon : ctx.sun;
    sunDir.copy(key.position).sub(key.target.position).normalize();
    renderer.getSize(sizeV);
    if (sizeV.x !== lastW || sizeV.y !== lastH) {
      lastW = sizeV.x;
      lastH = sizeV.y;
      water.resize(sizeV.x, sizeV.y);
    }
    const fogCol = scene.fog && scene.fog.color ? scene.fog.color : null;
    const r = water.frame(scene, camera, sunDir, key, ctx.hemi.color, fogCol);
    lastSimMs = r.simMs;
    lastSteps = r.steps;
    return true;
  }

  function report() {
    const s = water.stats();
    return {
      enabled: true,
      kind: "terrace-automaton",
      simK: K,
      cellSize: cellV,
      box: { x0: box.x0, x1: box.x1, y1: box.y1, z0: box.z0, z1: box.z1 },
      source: { mode: "spring-cell", basinY: origin.y, roofY: null, emitY: origin.y },
      settings: { springRate: s.springRate, warmSecs, stepHz: STEP_HZ },
      paused: s.paused,
      simulatedSteps: s.simulatedSteps,
      warmupLeft: Math.round((s.warmLeft / STEP_HZ) * 10) / 10,
      maxN: 0,
      gpuActive: false,
      renderMode: "terrace",
      hifi: null,
      fall: { cols: s.streams, particles: s.spray, vyGate: 0 },
      momentum: s.momentum,
      droplets: s.droplets,
      count: s.wetCount,
      volume: Math.round(s.volume * 10) / 10,
      foam: 0,
      calm: false,
      solverMs: Math.round(lastSimMs * 100) / 100,
      ticksPerSec: lastSteps * 60,
      activeBox: s.box,
      tris: s.tris,
      report: {
        emitted: Math.round(s.emitted * 10) / 10,
        drained: Math.round(s.drained * 10) / 10,
        evaporated: Math.round(s.displaced * 10) / 10, // displaced-by-build; automaton has no evaporation
        live: Math.round(s.volume * 10) / 10,
        err: Math.round((s.emitted - s.drained - s.displaced - s.volume) * 10) / 10,
      },
    };
  }

  function knob(o: any = {}) {
    if (o.springRate !== undefined) water.knob({ springRate: o.springRate });
    if (o.emitRate !== undefined) water.knob({ springRate: Number(o.emitRate) > 2 ? 0.09 : Number(o.emitRate) });
    if (o.paused !== undefined) water.knob({ paused: o.paused });
    if (o.running !== undefined) water.knob({ running: o.running });
    if (o.reset || o.drain) water.knob({ drain: true });
    if (o.warm !== undefined) water.knob({ warm: Math.round(Number(o.warm) * STEP_HZ) });
    if (o.ribNorm !== undefined) water.knob({ ribNorm: o.ribNorm });
    if (o.momentum !== undefined) water.knob({ momentum: o.momentum });
    if (o.droplets !== undefined) water.knob({ droplets: o.droplets });
    return report();
  }

  // Occupied water cells (world voxel coords) — feeds recomputeMoisture so
  // irrigation/aridity/waterlogging see the automaton water exactly like
  // they saw the particle pool. Called on the moisture cadence (~8s).
  function waterCells(): Array<[number, number, number]> {
    const spans = water.columnSpans();
    const out: Array<[number, number, number]> = [];
    if (K === 1) {
      for (const [b, e] of spans) {
        const wx = box.x0 + (b % nx);
        const wz = box.z0 + ((b / nx) | 0);
        for (let y = e.lo; y <= e.hi; y++) out.push([wx, box.y0 + y, wz]);
      }
      return out;
    }
    // K > 1: the moisture consumer only keeps a per-FINE-column lo/hi span,
    // so per coarse water column emit each of its K x K fine columns with
    // just the span ends in FINE voxel coords. lo = bottom of the lowest wet
    // cell; hi = centre of the top wet cell (the surface sits inside it —
    // top-of-cell would over-drown shore grass by up to K-1 voxels).
    for (const [b, e] of spans) {
      const fx0 = (box.x0 + (b % nx)) * K;
      const fz0 = (box.z0 + ((b / nx) | 0)) * K;
      const yLo = (box.y0 + e.lo) * K;
      const yHi = (box.y0 + e.hi) * K + (K >> 1);
      for (let dz = 0; dz < K; dz++) for (let dx = 0; dx < K; dx++) {
        out.push([fx0 + dx, yLo, fz0 + dz]);
        if (yHi !== yLo) out.push([fx0 + dx, yHi, fz0 + dz]);
      }
    }
    return out;
  }

  function dispose() {
    water.dispose();
  }

  // ── Live terrain edits (mining/building) ────────────────────────────────
  // The automaton reads terrain.solid live, so an edit is just the mapped
  // cell flip: a removal only opens the cell when NOTHING in its K^3 block
  // remains solid (colMap + latent are already updated when this hook
  // fires); a placement displaces any water in the cell (ledger-tracked).
  function onSolidEdit(vx: number, vy: number, vz: number, solidNow: boolean) {
    const cx = Math.floor(vx / K), cy = Math.floor(vy / K), cz = Math.floor(vz / K);
    const gx = cx - box.x0, gy = cy - box.y0, gz = cz - box.z0;
    if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return;
    let v = solidNow ? 1 : 0;
    if (K > 1 && !solidNow) {
      scan: for (let fy = cy * K; fy < cy * K + K; fy++)
        for (let fz = cz * K; fz < cz * K + K; fz++)
          for (let fx = cx * K; fx < cx * K + K; fx++)
            if (fineSolidAt(fx, fy, fz)) { v = 1; break scan; }
    }
    const idx = (gy * nz + gz) * nx + gx;
    if (terrain.solid[idx] === v) return;
    terrain.solid[idx] = v;
    if (v === 1) water.onCellSolidified(idx);
  }

  return { renderFrame, report, knob, waterCells, onSolidEdit, dispose, fluid: () => null, terrain: () => terrain };
}
