// TinyWorld runtime for the particle water system (ported from
// water-sim-sandbox, KJ-approved settings baked as defaults).
//
// Division of labor:
//  - The SOLVER runs untouched in voxel-CELL space (1 cell = 1 world voxel):
//    identical dynamics to the sandbox KJ tuned, at any world scale.
//  - This module owns the world bridge: crop the live voxel occupancy into a
//    solver Terrain, site the source at the spring's cell, transform particle
//    positions cell->world for the SSFR renderer, and drive per-frame
//    sky/sun/fog palette from the live TinyWorld lights.
//  - Rendering is the SSFR pipeline (fluid-ssfr.ts) with unitScale = voxel,
//    so every hand-tuned band/pattern reads exactly like the sandbox.
//
// KJ's optimal settings (IMG_6228, Jul 28): source 45 drops/s, viscosity
// 0.23, flow 1x, sleep ON, evap ON, drop tier 70%, debug balls hidden.
import { createDriver, SNAP_MAX_P, type DriverCtl, type FrameState, type SimDriver, type SimSource } from "./sim-driver";
import { MAX_FOAM } from "./foam";
import type { Terrain } from "./particles";
import { createFluidRenderer, type FluidRenderer } from "./fluid-ssfr";

export type PWaterCtx = {
  THREE: any;
  renderer: any;
  scene: any;
  // Solid oracle: drawn voxels per column ("x,z" -> Set<y>) + latent fill.
  colMap: Map<string, Set<number>>;
  extraSolid?: (x: number, y: number, z: number) => boolean;
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
  emitRate: 45,
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
  const { THREE, renderer, scene, colMap, extraSolid, voxel, cxRound, czRound, origin, params } = ctx;
  const num = (name: string, dflt: number) => {
    const v = params.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  // ── Terrain crop around the spring ──────────────────────────────────────
  let half = Math.max(16, Math.round(num("pwbox", 48)));
  let minX = origin.x, maxX = origin.x, minZ = origin.z, maxZ = origin.z, maxY = origin.y;
  for (const key of colMap.keys()) {
    const c = key.indexOf(",");
    const x = +key.slice(0, c);
    const z = +key.slice(c + 1);
    if (x < minX) minX = x; else if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
  }
  for (const set of colMap.values()) for (const y of set) if (y > maxY) maxY = y;
  const clampBox = () => {
    const x0 = Math.max(minX - 2, origin.x - half);
    const x1 = Math.min(maxX + 3, origin.x + half);
    const z0 = Math.max(minZ - 2, origin.z - half);
    const z1 = Math.min(maxZ + 3, origin.z + half);
    const y1 = Math.min(maxY + 4, origin.y + 10);
    return { x0, x1, z0, z1, y0: 0, y1 };
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
  const sx = origin.x - box.x0 + 0.5;
  // Source floats 2 cells above the sited outlet — the sandbox's own source
  // geometry (its spring hovered 2 cells over the bowl floor). The drops fall
  // as a small visible cascade instead of a sub-visible dribble at floor
  // level, and the mouth stays clear of the pool's back-pressure gate longer.
  const sy = origin.y - box.y0 + 2.0;
  const sz = origin.z - box.z0 + 0.5;
  const terrain: Terrain = {
    nx, ny, nz, solid,
    source: [sx, sy, sz],
    basin: {
      x0: Math.max(0, Math.floor(sx) - 8), x1: Math.min(nx, Math.floor(sx) + 8),
      z0: Math.max(0, Math.floor(sz) - 8), z1: Math.min(nz, Math.floor(sz) + 8),
    },
    rimY: Math.floor(sy),
    open: "all",
  };
  console.log(
    `[pwater] terrain crop ${nx}x${ny}x${nz} (${((performance.now() - t0) | 0)}ms), ` +
    `source cell (${origin.x},${origin.y},${origin.z})`,
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
  let driver: SimDriver = createDriver(useWorker, source, ctl.scale);
  const createdAt = performance.now();
  let gotSnap = false;

  const fluid: FluidRenderer = createFluidRenderer(THREE, renderer, SNAP_MAX_P, 0.6 * ctl.scale * voxel, voxel);

  // cell -> world: worldX = (px + offX) * voxel (see water-spring-runtime's
  // dummy.position convention; cell i center i+0.5 ↔ voxel index box+i).
  const offX = box.x0 - cxRound - 0.5;
  const offY = box.y0 - 0.5;
  const offZ = box.z0 - czRound - 0.5;
  let cellD = 0.6 * ctl.scale; // particle D in CELL units (driver reports on terrain msg)
  driver.onTerrain((_t, D) => {
    cellD = D;
    fluid.setParticleD(D * voxel);
    fluid.markSceneDirty();
  });

  const renderPos = new Float32Array(SNAP_MAX_P * 3);
  const foamPos = new Float32Array(MAX_FOAM * 3);
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
    if (!gotSnap && driver.kind === "worker" && now - createdAt > 5000) {
      console.warn("[pwater] worker produced no snapshot in 5s — falling back to inline solver");
      driver.dispose();
      driver = createDriver(false, source, ctl.scale);
      driver.onTerrain((_t, D) => {
        cellD = D;
        fluid.setParticleD(D * voxel);
        fluid.markSceneDirty();
      });
    }

    const st = driver.frame(dtReal, ctl);
    lastState = st;
    if (!st) return false; // worker warm-up: caller presents via the classic path
    gotSnap = true;

    renderer.getSize(sizeV);
    if (sizeV.x !== lastW || sizeV.y !== lastH) {
      lastW = sizeV.x;
      lastH = sizeV.y;
      fluid.resize(sizeV.x, sizeV.y);
    }

    const extra = st.extra;
    const n3 = st.count * 3;
    for (let i = 0; i < n3; i += 3) {
      renderPos[i] = (st.pos[i] + st.vel[i] * extra + offX) * voxel;
      renderPos[i + 1] = (st.pos[i + 1] + st.vel[i + 1] * extra + offY) * voxel;
      renderPos[i + 2] = (st.pos[i + 2] + st.vel[i + 2] * extra + offZ) * voxel;
    }
    const f3 = st.foamCount * 3;
    for (let i = 0; i < f3; i += 3) {
      foamPos[i] = (st.foamPos[i] + offX) * voxel;
      foamPos[i + 1] = (st.foamPos[i + 1] + offY) * voxel;
      foamPos[i + 2] = (st.foamPos[i + 2] + offZ) * voxel;
    }
    fluid.updateParticles(renderPos, st.speed, st.count);
    fluid.updateFoam(foamPos, st.foamFade, st.foamCount);

    // Live palette: key light + hemi sky drive the water exactly like the
    // sandbox sky presets did (doctrine: all water light from real sources).
    const key = ctx.moon.intensity > ctx.sun.intensity ? ctx.moon : ctx.sun;
    sunDir.copy(key.position).sub(key.target.position).normalize();
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
      box: { x0: box.x0, x1: box.x1, y1: box.y1, z0: box.z0, z1: box.z1 },
      settings: {
        emitRate: ctl.emitRate, viscosity: ctl.viscosity, timeScale: ctl.timeScale,
        sleep: ctl.sleep, evaporation: ctl.evaporation, scale: ctl.scale,
      },
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
    if (o.smooth) fluid.smooth(o.smooth);
    if (o.shadows !== undefined) fluid.shadows(!!o.shadows);
    return report();
  }

  function dispose() {
    driver.dispose();
    fluid.dispose();
  }

  return { renderFrame, report, knob, dispose, fluid: () => fluid, terrain: () => terrain };
}
