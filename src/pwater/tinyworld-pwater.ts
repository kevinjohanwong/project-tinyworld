// TinyWorld runtime for the particle water system (ported from
// water-sim-sandbox, KJ-approved settings baked as defaults).
//
// Division of labor:
//  - The SOLVER runs untouched in CELL space (1 cell = K^3 world voxels,
//    K=1 on coarse worlds): identical dynamics to the sandbox KJ tuned, at
//    any world scale. See the K section below for the fixed-metric fix.
//  - This module owns the world bridge: crop the live voxel occupancy into a
//    solver Terrain, site the source at the spring's cell, transform particle
//    positions cell->world for the SSFR renderer, and drive per-frame
//    sky/sun/fog palette from the live TinyWorld lights.
//  - Rendering is the SSFR pipeline (fluid-ssfr.ts) with unitScale = voxel,
//    so every hand-tuned band/pattern reads exactly like the sandbox.
//
// KJ's optimal settings (IMG_6228, Jul 28): viscosity 0.23, flow 1x,
// sleep ON, evap ON, drop tier 70%, debug balls hidden. Emit rate raised
// 45 -> 160 (Jul 28, KJ: "rate of water is too slow") — at tier 0.7 the
// pool cap is ~29k particles, and 45 drops/s left the divot one particle
// deep for minutes, stuck in the tan shallows look (clay bed read-through
// + caustic web) instead of reaching the blue depth bands.
import { createDriver, SNAP_MAX_P, type DriverCtl, type FrameState, type SimDriver, type SimSource } from "./sim-driver";
import { MAX_FOAM } from "./foam";
import type { Terrain } from "./particles";
import { createFluidRenderer, type FluidRenderer } from "./fluid-ssfr";
import { createHiFiFluid, type HiFiFluid } from "./fluid-hifi";

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

const DEFAULTS = {
  emitRate: 160,
  viscosity: 0.23,
  timeScale: 1,
  sleep: true,
  evaporation: true,
  scale: 0.7,
};

// Crop budget: the solver's neighbor hash grid allocates over the whole box,
// so the domain is a bounded window around the spring, not the whole world.
const MAX_CELLS = 3_500_000;

export function createParticleWater(ctx: PWaterCtx) {
  const { THREE, renderer, scene, voxel, cxRound, czRound, params } = ctx;
  const { colMap: colMapF, extraSolid: extraSolidF, extraColTops: extraColTopsF, origin: originF } = ctx;
  const num = (name: string, dflt: number) => {
    const v = params.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  // ── Sim-cell scale K (1 sim cell = K^3 world voxels) ────────────────────
  // The solver is scale-similar in CELL space: every constant (gravity, D, H,
  // R, speeds, MAX_N) is a cell count. On fixed-metric scan worlds the voxel
  // is 0.015 m, so 1 cell = 1 voxel made the whole water budget ~15 litres of
  // sub-centimetre film — invisible. Decouple: pick K so a sim cell lands
  // near 6 cm on fine-voxel worlds (leslielab 0.015 -> K=4; fresh scans pass
  // the conquest-shapes 1.5x coarsen so 0.015 -> 0.0225 -> K=3) and keep K=1
  // on every coarse world/bed (voxel >= 0.03: the verification beds start at
  // 0.03375) so verified behavior is untouched. ?pwk= overrides. Only the
  // world bridge changes — solver dynamics, worker and GPU paths see an
  // ordinary (coarser) grid.
  const kDefault = voxel < 0.03 ? Math.max(1, Math.min(8, Math.round(0.06 / voxel))) : 1;
  const K = Math.max(1, Math.min(16, Math.round(num("pwk", kDefault))));
  const cellV = voxel * K; // world metres per sim cell
  const fineSolidAt = (x: number, y: number, z: number) =>
    (colMapF.get(`${x},${z}`)?.has(y) ?? false) || (extraSolidF ? extraSolidF(x, y, z) : false);

  // Coarse solid-oracle views. A sim cell is solid when ANY of its K^3 fine
  // voxels is solid (conservative: a 1-voxel crust floor stays watertight).
  // Latent fill is probed along the block's centre column (latent mass is
  // bulk column fill; edges thin by < 1 cell and the drawn crust skins them).
  let colMap = colMapF;
  let extraSolid = extraSolidF;
  let extraColTops = extraColTopsF;
  let origin = originF;
  if (K > 1) {
    const t0k = performance.now();
    const m = new Map<string, Set<number>>();
    for (const [key, set] of colMapF) {
      const c = key.indexOf(",");
      const ck = Math.floor(+key.slice(0, c) / K) + "," + Math.floor(+key.slice(c + 1) / K);
      let s = m.get(ck);
      if (!s) m.set(ck, (s = new Set()));
      for (const y of set) s.add(Math.floor(y / K));
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
      `coarsened ${colMapF.size} -> ${colMap.size} cols in ${((performance.now() - t0k) | 0)}ms`,
    );
  }

  // ── Terrain crop around the spring ──────────────────────────────────────
  // A circular spring-centred crop can cut a real downstream basin out of the
  // simulation on large worlds. Route the domain along the actual terrain
  // surface first, then pad that route. This only chooses the finite solver
  // boundary; water motion inside remains entirely solver-driven.
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
        // no spill anywhere is a true terminal basin and ends the route. This
        // still only chooses the solver boundary — level spreading itself
        // remains sim-driven.
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

  // Ceiling mount: the emitter hangs just under the roof above the sited
  // basin, so water falls from height and pools in the basin below (the pool
  // target is unchanged — only the source's boundary condition moves, which
  // the emergent-rules doctrine allows). Search the 3x3 columns around the
  // spring for the LOWEST solid overhead; require real headroom (>= 6 cells)
  // so a shallow ledge doesn't count. ?pwsrc=basin restores the old floor+2
  // source; ?pwsrch=N forces an emit height N cells above the basin floor.
  const solidAt = (x: number, y: number, z: number) =>
    (colMap.get(`${x},${z}`)?.has(y) ?? false) || (extraSolid ? extraSolid(x, y, z) : false);
  let ceilY = -1;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    for (let y = origin.y + 6; y <= maxY; y++) {
      if (solidAt(origin.x + dx, y, origin.z + dz)) {
        if (ceilY < 0 || y < ceilY) ceilY = y;
        break;
      }
    }
  }
  const srcMode = params.get("pwsrc") === "basin" || ceilY < 0 ? "basin" : "ceiling";
  const srcH = num("pwsrch", NaN);
  // Emit y in WORLD voxel coords (fractional): ceiling mode hangs 1.7 cells
  // under the roof cell's bottom face so the spawn band (source y .. +1.2
  // plus a drop radius) stays clear of the solid; basin mode keeps the
  // sandbox's floor+2 hover; ?pwsrch overrides as cells above the basin.
  const emitYW = Number.isFinite(srcH)
    ? origin.y + srcH
    : srcMode === "ceiling" ? ceilY - 1.7 : origin.y + 2.0;
  const clampBox = () => {
    const x0 = Math.max(minX - 2, Math.min(origin.x - half, routeMinX - routePad));
    const x1 = Math.min(maxX + 3, Math.max(origin.x + half, routeMaxX + routePad));
    const z0 = Math.max(minZ - 2, Math.min(origin.z - half, routeMinZ - routePad));
    const z1 = Math.min(maxZ + 3, Math.max(origin.z + half, routeMaxZ + routePad));
    // Floor the domain at the world's lowest solid, not absolute y=0: water
    // always rests ON a solid, so cells below the lowest solid are pure void
    // (an off-world fall drains at the open boundary a few cells under the
    // island's underside instead of plunging to 0). On high scanned worlds
    // this keeps ny = terrain relief rather than absolute altitude — without
    // it, a high-sited spring blew the MAX_CELLS budget vertically and the
    // while-loop squeezed the XZ footprint to a skinny column ("water height
    // limitations").
    const y0 = Math.max(0, minSolidY - 6);
    const y1 = Math.min(maxY + 4, Math.max(origin.y + 10, Math.ceil(emitYW) + 4));
    return { x0, x1, z0, z1, y0, y1 };
  };
  let box = clampBox();
  while ((box.x1 - box.x0) * (box.z1 - box.z0) * (box.y1 - box.y0) > MAX_CELLS && half > 16) {
    half = Math.round(half * 0.8);
    box = clampBox();
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
  // ── Per-column wall openness ────────────────────────────────────────────
  // The crop box is finite; its walls are honest boundaries only where the
  // WORLD also ends there. A wall column is OPEN (drain) when the 4 cells
  // beyond it hold no solid inside the box's y-range (true void — an island
  // edge), and CLOSED (no-flow) where terrain continues past the cut, so a
  // plunge pool or river backs up against the cut exactly as it would against
  // the real terrain beyond it. Boundary condition only — the sim inside is
  // untouched.
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
  const sx = origin.x - box.x0 + 0.5;
  // Source height: ceiling-mounted when a roof hangs over the basin (water
  // falls from under the roof into the pool), else the sandbox's floor+2
  // hover (small visible cascade, mouth clear of the back-pressure gate).
  // Grid mapping matches the old `origin.y - box.y0 + 2.0` convention.
  const sy = emitYW - box.y0;
  const sz = origin.z - box.z0 + 0.5;
  const terrain: Terrain = {
    nx, ny, nz, solid,
    source: [sx, sy, sz],
    basin: {
      x0: Math.max(0, Math.floor(sx) - 8), x1: Math.min(nx, Math.floor(sx) + 8),
      z0: Math.max(0, Math.floor(sz) - 8), z1: Math.min(nz, Math.floor(sz) + 8),
    },
    rimY: Math.floor(origin.y - box.y0 + 2),
    wallOpen,
  };
  console.log(
    `[pwater] terrain crop ${nx}x${ny}x${nz} (${((performance.now() - t0) | 0)}ms), ` +
    `basin cell (${origin.x},${origin.y},${origin.z}), latent tops ${latentTops}, route ${route.length} cells ` +
    `(${route[route.length - 1][0]},${route[route.length - 1][1]}), source ${srcMode}` +
    (srcMode === "ceiling" ? ` (roof y=${ceilY}, emit y=${emitYW.toFixed(1)})` : ` (emit y=${emitYW.toFixed(1)})`) +
    `, walls open px ${_openCount(wallOpen.px)}/${nz} mx ${_openCount(wallOpen.mx)}/${nz}` +
    ` pz ${_openCount(wallOpen.pz)}/${nx} mz ${_openCount(wallOpen.mz)}/${nx}`,
  );

  // ── Driver + renderer ───────────────────────────────────────────────────
  const ctl: DriverCtl = {
    running: true,
    emitRate: num("pwrate", DEFAULTS.emitRate),
    viscosity: num("pwvisc", DEFAULTS.viscosity),
    sleep: params.get("pwsleep") !== "0",
    evaporation: params.get("pwevap") !== "0",
    stepOnce: false,
    timeScale: num("pwspeed", DEFAULTS.timeScale),
    scale: num("pwscale", DEFAULTS.scale),
    resetTo: null,
  };
  const source: SimSource = { custom: terrain };
  const useWorker = params.get("pwworker") !== "0";
  // Load warm-up + pooling cap. ?pwwarm= sim-seconds fast-forwarded at full
  // CPU speed right after terrain injection (default 90 — the pool arrives
  // filled instead of trickling for real minutes; 0 disables). ?pwmax= particle
  // cap in base-sized drops (default 20000, 2x the old hard cap that silently
  // stopped the source — the "pool stops rising" limit; hard ceiling 120k
  // particles).
  // ?pwgpu=1/0: run the substep solve as WebGPU compute in the worker
  // (default ON — the worker falls back to the proven CPU solver when WebGPU
  // is unavailable or init fails, so the only risk surface is a healthy
  // WebGPU device; report.gpuActive says which path is live).
  const driverExtras = {
    warmup: Math.max(0, num("pwwarm", 90)),
    baseMax: Math.max(1000, num("pwmax", 20000)),
    gpu: params.get("pwgpu") !== "0",
  };
  let driver: SimDriver = createDriver(useWorker, source, ctl.scale, driverExtras);
  const createdAt = performance.now();
  let gotSnap = false;
  let snapWaitFrames = 0;

  const fluid: FluidRenderer = createFluidRenderer(THREE, renderer, SNAP_MAX_P, 0.6 * ctl.scale * cellV, cellV);

  // cell -> world: worldX = (px + offX) * cellV (see water-spring-runtime's
  // dummy.position convention; cell i center i+0.5 ↔ voxel index box+i).
  // At K>1 a sim cell's centre sits (K-1)/2 fine voxels above/right of its
  // first fine voxel's centre — ctr folds that in (0 at K=1, exact old form).
  const ctr = (K - 1) / (2 * K);
  const offX = box.x0 - cxRound / K - 0.5 + ctr;
  const offY = box.y0 - 0.5 + ctr;
  const offZ = box.z0 - czRound / K - 0.5 + ctr;
  let cellD = 0.6 * ctl.scale; // particle D in CELL units (driver reports on terrain msg)
  driver.onTerrain((_t, D) => {
    cellD = D;
    fluid.setParticleD(D * cellV);
    fluid.markSceneDirty();
  });

  const renderPos = new Float32Array(SNAP_MAX_P * 3);
  const foamPos = new Float32Array(MAX_FOAM * 3);

  // Presentation: "hifi" (continuous surface, KJ-approved sandbox look) is
  // the default; "?pwrender=ssfr" restores the splat pipeline.
  const renderMode = params.get("pwrender") === "ssfr" ? "ssfr" : "hifi";
  const hifi: HiFiFluid | null = renderMode === "hifi"
    ? createHiFiFluid(THREE, renderer, nx, nz, { x: offX, y: offY, z: offZ }, cellV)
    : null;

  // ── Render-side surface relaxation ("average out the tops") ─────────────
  // The SIM is untouched — mass, flow, and every particle's real position are
  // exactly what the solver produced. This smooths only the RENDERED y of
  // near-surface, slow particles toward the local neighborhood surface
  // height, so a settled pool splats as one coherent sheet instead of
  // per-particle ball tops. It reconstructs the surface the particles already
  // imply (local average, no imposed waterline), and it is speed-gated: fast
  // water (rivers, falls, splashes) keeps its true per-particle shape.
  // ?pwrelax=0..1 amount (0 disables), ?pwrelaxr= blur radius in cells.
  let relaxAmt = Math.max(0, Math.min(1, num("pwrelax", 0.85)));
  let relaxRad = Math.max(1, Math.min(6, Math.round(num("pwrelaxr", 2))));
  const RELAX_SPEED = 3; // cell/s: full relax at 0, none at >= this
  const gTop = new Float32Array(nx * nz);
  const gHas = new Uint8Array(nx * nz);
  const gTmpV = new Float32Array(nx * nz);
  const gTmpH = new Uint8Array(nx * nz);
  const gSurf = new Float32Array(nx * nz);
  const gMin = new Float32Array(nx * nz);
  const gCnt = new Float32Array(nx * nz);
  const gFx = new Float32Array(nx * nz);
  const gFz = new Float32Array(nx * nz);
  const gSpd = new Float32Array(nx * nz);
  const gImp = new Float32Array(nx * nz);
  const gFoam = new Float32Array(nx * nz);

  // Per-column bins over the particle snapshot: surface top/bottom, mean
  // horizontal flow, mean speed, fall-impact (fast downward particles), and
  // foam density. Pure read-only telemetry over sim output.
  function binFields(st: FrameState) {
    gHas.fill(0); gCnt.fill(0); gFx.fill(0); gFz.fill(0);
    gSpd.fill(0); gImp.fill(0); gFoam.fill(0);
    const n3 = st.count * 3;
    for (let i = 0; i < n3; i += 3) {
      const bx = st.pos[i] | 0;
      const bz = st.pos[i + 2] | 0;
      if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) continue;
      const b = bz * nx + bx;
      const y = st.pos[i + 1];
      if (!gHas[b]) { gTop[b] = y; gMin[b] = y; gHas[b] = 1; }
      else {
        if (y > gTop[b]) gTop[b] = y;
        if (y < gMin[b]) gMin[b] = y;
      }
      gCnt[b]++;
      gFx[b] += st.vel[i];
      gFz[b] += st.vel[i + 2];
      gSpd[b] += st.speed[i / 3];
      const vy = st.vel[i + 1];
      if (vy < -3) gImp[b] += Math.min(1, -vy / 12);
    }
    const f3 = st.foamCount * 3;
    for (let i = 0; i < f3; i += 3) {
      const bx = st.foamPos[i] | 0;
      const bz = st.foamPos[i + 2] | 0;
      if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) continue;
      gFoam[bz * nx + bx] += st.foamFade[i / 3];
    }
    // Separable box blur over WATER bins only (empty bins carry no weight, so
    // shorelines average against water, never against dry land at height 0).
    const R = relaxRad;
    for (let z = 0; z < nz; z++) {
      const row = z * nx;
      for (let x = 0; x < nx; x++) {
        let s = 0, c = 0;
        for (let d = -R; d <= R; d++) {
          const xx = x + d;
          if (xx < 0 || xx >= nx || !gHas[row + xx]) continue;
          s += gTop[row + xx]; c++;
        }
        gTmpV[row + x] = c ? s / c : 0;
        gTmpH[row + x] = c ? 1 : 0;
      }
    }
    for (let x = 0; x < nx; x++) {
      for (let z = 0; z < nz; z++) {
        let s = 0, c = 0;
        for (let d = -R; d <= R; d++) {
          const zz = z + d;
          if (zz < 0 || zz >= nz || !gTmpH[zz * nx + x]) continue;
          s += gTmpV[zz * nx + x]; c++;
        }
        gSurf[z * nx + x] = c ? s / c : 0;
      }
    }
  }

  function relaxSurface(st: FrameState, extra: number) {
    const surfBand = cellD * 1.3; // only the top particle layer relaxes
    for (let i = 0; i < n3; i += 3) {
      const bx = st.pos[i] | 0;
      const bz = st.pos[i + 2] | 0;
      if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) continue;
      const b = bz * nx + bx;
      if (!gHas[b] || st.pos[i + 1] < gTop[b] - surfBand) continue;
      const fade = relaxAmt * Math.max(0, 1 - st.speed[i / 3] / RELAX_SPEED);
      if (fade <= 0) continue;
      const y = st.pos[i + 1] + st.vel[i + 1] * extra;
      renderPos[i + 1] = (y + (gSurf[b] - y) * fade + offY) * cellV;
    }
  }
  const sunDir = new THREE.Vector3(0, 1, 0);
  const sizeV = new THREE.Vector2();
  let lastW = 0;
  let lastH = 0;
  let lastNow = 0;
  let lastState: FrameState | null = null;

  function renderFrame(camera: any): boolean {
    const now = performance.now();
    const dtReal = lastNow > 0 ? Math.min(0.1, (now - lastNow) / 1000) : 1 / 60;
    lastNow = now;

    // Worker never came up (bundler/CSP edge): fall back to the inline solver.
    // Patience is counted in RENDERED frames, not wall-clock: during the
    // world-load stampede the main thread (and the worker's CPU slice) are
    // pegged for many seconds, and a 5s wall-clock timeout here killed healthy
    // workers on real devices — silently moving the whole sim onto the main
    // thread forever. 300 interactive frames ≈ 5s at 60fps but 30s at 10fps,
    // so the deadline scales with how starved the machine actually is.
    if (!gotSnap && driver.kind === "worker" && ++snapWaitFrames > 300 && now - createdAt > 8000) {
      console.warn(`[pwater] worker produced no snapshot after ${snapWaitFrames} frames / ${((now - createdAt) / 1000).toFixed(1)}s — falling back to inline solver`);
      driver.dispose();
      driver = createDriver(false, source, ctl.scale, driverExtras);
      driver.onTerrain((_t, D) => {
        cellD = D;
        fluid.setParticleD(D * cellV);
        fluid.markSceneDirty();
      });
    }

    if (editQueue.length) {
      driver.solidEdit(Int32Array.from(editQueue));
      editQueue.length = 0;
    }

    const st = driver.frame(dtReal, ctl);
    lastState = st;
    if (!st) return false; // worker warm-up: caller presents via the classic path
    gotSnap = true;

    // Live palette (shared by both presentations): key light + hemi sky.
    const key = ctx.moon.intensity > ctx.sun.intensity ? ctx.moon : ctx.sun;
    sunDir.copy(key.position).sub(key.target.position).normalize();

    if (hifi) {
      binFields(st);
      const f = hifi.fields;
      const nb = nx * nz;
      for (let b = 0; b < nb; b++) {
        if (!gHas[b]) { f.mask[b] = 0; continue; }
        f.mask[b] = 1;
        f.h[b] = gSurf[b];
        f.dep[b] = gTop[b] - gMin[b] + cellD;
        const inv = 1 / gCnt[b];
        f.fx[b] = gFx[b] * inv;
        f.fz[b] = gFz[b] * inv;
        const spdT = Math.min(1, (gSpd[b] * inv) / 8);
        const impT = Math.min(1, gImp[b] * inv * 1.5);
        f.imp[b] = impT;
        f.foam[b] = Math.min(1, spdT * spdT * 0.8 + impT * 0.7 + Math.min(1, gFoam[b] / 3) * 0.5);
      }
      hifi.commit();
      renderer.getSize(sizeV);
      if (sizeV.x !== lastW || sizeV.y !== lastH) {
        lastW = sizeV.x;
        lastH = sizeV.y;
        hifi.resize(sizeV.x, sizeV.y);
      }
      hifi.render(scene, camera, sunDir, key, ctx.hemi.color, scene.fog && scene.fog.color ? scene.fog.color : null);
      return true;
    }

    renderer.getSize(sizeV);
    if (sizeV.x !== lastW || sizeV.y !== lastH) {
      lastW = sizeV.x;
      lastH = sizeV.y;
      fluid.resize(sizeV.x, sizeV.y);
    }

    const extra = st.extra;
    const n3 = st.count * 3;
    for (let i = 0; i < n3; i += 3) {
      renderPos[i] = (st.pos[i] + st.vel[i] * extra + offX) * cellV;
      renderPos[i + 1] = (st.pos[i + 1] + st.vel[i + 1] * extra + offY) * cellV;
      renderPos[i + 2] = (st.pos[i + 2] + st.vel[i + 2] * extra + offZ) * cellV;
    }
    if (relaxAmt > 0) {
      binFields(st);
      relaxSurface(st, extra);
    }
    const f3 = st.foamCount * 3;
    for (let i = 0; i < f3; i += 3) {
      foamPos[i] = (st.foamPos[i] + offX) * cellV;
      foamPos[i + 1] = (st.foamPos[i + 1] + offY) * cellV;
      foamPos[i + 2] = (st.foamPos[i + 2] + offZ) * cellV;
    }
    fluid.updateParticles(renderPos, st.speed, st.count);
    fluid.updateFoam(foamPos, st.foamFade, st.foamCount);

    // SSFR palette: key light + hemi sky drive the water exactly like the
    // sandbox sky presets did (doctrine: all water light from real sources).
    const u = fluid._u as any;
    u.uSunColor.value.copy(key.color);
    u.uSkyCol.value.copy(ctx.hemi.color);
    const fog = scene.fog;
    if (fog && fog.color) {
      u.uFogColor.value.copy(fog.color);
      if (fog.near !== undefined) u.uFogRange.value.set(fog.near, fog.far);
    } else if (scene.background && scene.background.isColor) {
      u.uFogColor.value.copy(scene.background);
    }
    // TinyWorld's scene is alive (wind, workers, machines) — the sandbox's
    // static-frame reuse would freeze it, so every frame runs the full path.
    fluid.markSceneDirty();
    fluid.render(scene, camera, sunDir, key);
    return true;
  }

  function report() {
    const st = lastState;
    return {
      enabled: true,
      kind: driver.kind,
      simK: K,
      cellSize: cellV,
      box: { x0: box.x0, x1: box.x1, y1: box.y1, z0: box.z0, z1: box.z1 },
      source: { mode: srcMode, basinY: origin.y, roofY: ceilY < 0 ? null : ceilY, emitY: Math.round(emitYW * 10) / 10 },
      settings: {
        emitRate: ctl.emitRate, viscosity: ctl.viscosity, timeScale: ctl.timeScale,
        sleep: ctl.sleep, evaporation: ctl.evaporation, scale: ctl.scale,
        relax: relaxAmt, relaxRad,
        warmup: driverExtras.warmup, baseMax: driverExtras.baseMax, gpu: driverExtras.gpu,
      },
      warmupLeft: st?.warmupLeft ?? 0,
      maxN: st?.maxN ?? 0,
      gpuActive: st?.gpuActive ?? false,
      renderMode,
      hifi: hifi ? hifi.state() : null,
      count: st?.count ?? 0,
      foam: st?.foamCount ?? 0,
      calm: st?.calm ?? false,
      solverMs: st?.solverMs ?? 0,
      ticksPerSec: st?.ticksPerSec ?? 0,
      report: st?.report ?? null,
    };
  }

  function knob(o: any = {}) {
    if (o.emitRate !== undefined) ctl.emitRate = o.emitRate;
    if (o.viscosity !== undefined) ctl.viscosity = o.viscosity;
    if (o.timeScale !== undefined) ctl.timeScale = o.timeScale;
    if (o.sleep !== undefined) ctl.sleep = !!o.sleep;
    if (o.evaporation !== undefined) ctl.evaporation = !!o.evaporation;
    if (o.running !== undefined) ctl.running = !!o.running;
    if (o.step) ctl.stepOnce = true;
    if (o.scale !== undefined && o.scale !== ctl.scale) {
      ctl.scale = o.scale;
      ctl.resetTo = source; // rebuild at the new drop tier (same terrain)
    }
    if (o.reset) ctl.resetTo = source;
    if (o.relax !== undefined) relaxAmt = Math.max(0, Math.min(1, Number(o.relax) || 0));
    if (o.relaxRad !== undefined) relaxRad = Math.max(1, Math.min(6, Math.round(Number(o.relaxRad) || 2)));
    if (o.smooth) fluid.smooth(o.smooth);
    if (o.shadows !== undefined) fluid.shadows(!!o.shadows);
    if (hifi && (o.absorb !== undefined || o.refract !== undefined || o.rippleAmp !== undefined || o.flowAdv !== undefined || o.ssr !== undefined)) hifi.knob(o);
    return report();
  }

  // Occupied voxel cells of the particle pool (deduped, world voxel coords) —
  // feeds recomputeMoisture so irrigation/aridity/waterlogging see the
  // particle water exactly like they saw the CA spring's cells. Called on the
  // moisture cadence (~8s), so a linear pass over <=29k particles is free.
  // CAUTION: worker snapshot buffers are TRANSFERRED back for recycling
  // between frames, so lastState's views are usually detached by the time a
  // separate task (the moisture cadence, page evals) reads them — every
  // Math.floor(NaN) collapsed to one bogus cell and the moisture field saw no
  // particle water at all. Prefer the live views when still attached; else
  // derive column spans from the persistent binFields copies (gHas/gMin/gTop),
  // which renderFrame refreshes synchronously while the buffer is valid.
  function waterCells(): Array<[number, number, number]> {
    const st = lastState;
    if (!st) return [];
    const out: Array<[number, number, number]> = [];
    if (K === 1) {
      if (st.pos.length > 0) {
        const seen = new Set<number>();
        const n3 = st.count * 3;
        for (let i = 0; i < n3; i += 3) {
          const cx = Math.floor(st.pos[i]);
          const cy = Math.floor(st.pos[i + 1]);
          const cz = Math.floor(st.pos[i + 2]);
          const key = ((cx & 1023) << 20) | ((cy & 1023) << 10) | (cz & 1023);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push([box.x0 + cx, box.y0 + cy, box.z0 + cz]);
        }
        return out;
      }
      const nb = nx * nz;
      for (let b = 0; b < nb; b++) {
        if (!gHas[b]) continue;
        const wx = box.x0 + (b % nx);
        const wz = box.z0 + ((b / nx) | 0);
        const yLo = Math.floor(gMin[b]);
        const yHi = Math.floor(gTop[b]);
        for (let y = yLo; y <= yHi; y++) out.push([wx, box.y0 + y, wz]);
      }
      return out;
    }
    // K > 1: the moisture consumer (addW) only keeps a per-FINE-column lo/hi
    // span, so per coarse water column emit each of its K x K fine columns
    // with just the span ends in FINE voxel coords. lo = bottom of the lowest
    // wet cell (conservative for irrigation reach); hi = centre of the top
    // wet cell (the surface sits inside it — top-of-cell would over-drown
    // shore grass by up to K-1 voxels).
    const spans = new Map<number, { lo: number; hi: number }>();
    if (st.pos.length > 0) {
      const n3 = st.count * 3;
      for (let i = 0; i < n3; i += 3) {
        const bx = st.pos[i] | 0;
        const by = Math.floor(st.pos[i + 1]);
        const bz = st.pos[i + 2] | 0;
        if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) continue;
        const b = bz * nx + bx;
        const e = spans.get(b);
        if (!e) spans.set(b, { lo: by, hi: by });
        else { if (by < e.lo) e.lo = by; if (by > e.hi) e.hi = by; }
      }
    } else {
      const nb = nx * nz;
      for (let b = 0; b < nb; b++) {
        if (gHas[b]) spans.set(b, { lo: Math.floor(gMin[b]), hi: Math.floor(gTop[b]) });
      }
    }
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
    driver.dispose();
    fluid.dispose();
    if (hifi) hifi.dispose();
  }

  // ── Live terrain edits (mining/building) ────────────────────────────────
  // The crop was a load-time snapshot; without this, water rests on phantom
  // solid where the player dug — a mined cavity can never fill. World-voxel
  // edits map into box cells, update the caller-owned solid copy (so a driver
  // rebuild — e.g. the worker→inline fallback — carries them), and flow to
  // whichever solver is live on the next frame. Edits outside the crop box
  // are ignored: the sim only exists around the spring.
  const editQueue: number[] = [];
  function onSolidEdit(vx: number, vy: number, vz: number, solidNow: boolean) {
    // Fine voxel edit -> sim cell. Placing any voxel makes the cell solid; a
    // removal only opens the cell when NOTHING in its K^3 block remains solid
    // (colMap + latent are already updated when this hook fires, so the
    // rescan sees current truth). K=1 reduces to the old exact mapping.
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
    editQueue.push(gx, gy, gz, v);
  }

  return { renderFrame, report, knob, waterCells, onSolidEdit, dispose, fluid: () => fluid, terrain: () => terrain };
}
