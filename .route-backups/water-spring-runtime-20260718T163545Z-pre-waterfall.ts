// Runtime glue for the rain-fed spring, composed from the pure, tested core in
// water-spring.ts. This owns only the parts that need the live scene: building
// the two private meshes (varied surface + capped spring water), siting the
// spring on the highest solid surface, and the throttled rain->emit->settle
// tick. All physics/siting/variance math lives in ./water-spring and is unit
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
  surfaceVariance, chooseSpringOrigin, emitterCell,
  applyRain, springEmit, emitAndSettle,
  type Vec3, type SpringState,
} from "@/water-spring";

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
};

const KEY = (x: number, y: number, z: number) => `${x},${y},${z}`;
const KEYXZ = (x: number, z: number) => `${x},${z}`;

// Cheap deterministic 32-bit mix so a world id yields a stable seed.
function mix32(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) | 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createSpring(ctx: SpringContext) {
  const {
    THREE, scene, colMap, addCol, voxel, cellSize,
    cxRound, czRound, waterColor, meta, params,
  } = ctx;

  const num = (name: string, dflt: number) => {
    const v = params.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  const AMPLITUDE = num("springamp", 3);   // ceiling variance depth (cells)
  const FREQUENCY = num("springfreq", 8);   // variance hill size (voxels)
  const CEIL_BAND = num("springband", 3);   // how far below the top counts as "surface"
  const CAPACITY = num("springcap", 900);   // max standing spring water = mesh slot cap
  const RAIN_K = num("springraink", 8);     // precip(mm) -> water cells per rainy tick
  const TICK_MS = num("springtickms", 260); // throttle: emit cadence
  const PER_TICK = num("springpertick", 2); // cells emitted per funded tick

  // Place a cell instance into a private InstancedMesh at voxel coords.
  const box = new THREE.BoxGeometry(cellSize, cellSize, cellSize);
  const dummy = new THREE.Object3D();
  const setCell = (mesh: any, slot: number, x: number, y: number, z: number) => {
    dummy.position.set((x - cxRound) * voxel, y * voxel, (z - czRound) * voxel);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  };

  let terrainMesh: any = null;    // varied surface + spring block (solid, in colMap)
  let waterMesh: any = null;      // capped, dynamic spring water
  const waterSlot = new Map<string, number>();
  const waterFree: number[] = [];
  const springWater = new Set<string>(); // authoritative spring-water cell set

  let state: SpringState = { budget: 0, capacity: CAPACITY };
  let origin: Vec3 | null = null;
  let emitter: Vec3 | null = null;
  let lastTick = 0;
  let active = false;

  // Spring water rests on any solid OR on scan water (both live in colMap; scan
  // water is added to colMap by settleWaterNear). Spring water itself is kept
  // out of colMap so the solver treats the passed set as the fluid body.
  const isSolid = (x: number, y: number, z: number) => colMap.get(KEYXZ(x, z))?.has(y) ?? false;

  function persist() {
    if (!origin) return;
    meta.spring = {
      version: 1, seed: theSeed,
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
    let maxTop = -Infinity;
    const tops: Vec3[] = [];
    for (const [k, ys] of colMap) {
      let t = -Infinity;
      for (const y of ys) if (y > t) t = y;
      if (t === -Infinity) continue;
      const [x, z] = k.split(",").map(Number);
      tops.push([x, t, z]);
      if (t > maxTop) maxTop = t;
    }
    const surface = tops.filter((c) => c[1] >= maxTop - CEIL_BAND);
    if (surface.length < 8) return { ok: false, reason: "no usable surface" };

    // 2) Variance across the surface (rolling dips that hold pools), stamped as
    //    solid cells above each column. In colMap so player/workers collide.
    const variance = surfaceVariance(surface, { amplitude: AMPLITUDE, frequency: FREQUENCY, seed: theSeed });
    let varCells = 0;
    for (const [, d] of variance) varCells += d;
    const springBlockCells = 1;

    terrainMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9, metalness: 0.02 }),
      Math.max(1, varCells + springBlockCells),
    );
    terrainMesh.count = 0;
    let ti = 0;
    for (const [x, baseTop, z] of surface) {
      const d = variance.get(KEYXZ(x, z)) ?? 0;
      for (let j = 1; j <= d; j++) {
        const y = baseTop + j;
        addCol(x, y, z);
        setCell(terrainMesh, ti++, x, y, z);
      }
    }

    // 3) Site the spring on the highest post-variance column (stored origin wins
    //    on reload — never re-shift), then stamp a visible spring block on it.
    if (saved?.origin) {
      origin = [saved.origin.x, saved.origin.y, saved.origin.z];
    } else {
      origin = chooseSpringOrigin(surface, variance);
    }
    if (!origin) return { ok: false, reason: "could not site spring" };
    // Spring block: a distinct emissive cube marking the source.
    const blockMat = new THREE.MeshStandardMaterial({ color: 0x3fa9ff, emissive: 0x1a5fbf, emissiveIntensity: 0.6, roughness: 0.5 });
    const blockMesh = new THREE.InstancedMesh(box, blockMat, 1);
    addCol(origin[0], origin[1], origin[2]);
    setCell(blockMesh, 0, origin[0], origin[1], origin[2]);
    blockMesh.count = 1;
    blockMesh.instanceMatrix.needsUpdate = true;
    scene.add(blockMesh);

    terrainMesh.count = ti;
    terrainMesh.instanceMatrix.needsUpdate = true;
    scene.add(terrainMesh);

    // 4) Capped spring-water mesh (cap = reservoir capacity).
    waterMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: waterColor, transparent: true, opacity: 0.78, roughness: 0.3, metalness: 0.02 }),
      CAPACITY,
    );
    waterMesh.count = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < CAPACITY; i++) { waterMesh.setMatrixAt(i, zero); waterFree.push(i); }
    waterMesh.instanceMatrix.needsUpdate = true;
    scene.add(waterMesh);

    emitter = emitterCell(origin);

    // Budget: reuse persisted, else prime to half so there is a visible pool on
    // first load (rain tops it up; drought drains it).
    state = { budget: saved ? Math.min(CAPACITY, saved.budget) : Math.floor(CAPACITY * 0.5), capacity: CAPACITY };
    active = true;
    persist();

    // Pre-fill standing water to the primed budget so the pool is visible
    // immediately (spends none of the live budget — this is the resting level).
    if (!saved && state.budget > 0) fill(Math.min(state.budget, Math.floor(CAPACITY * 0.4)));

    return { ok: true };
  }

  // Push `add` water cells through the settle solver and reconcile the mesh.
  function fill(add: number) {
    if (!emitter || !waterMesh || add <= 0) return 0;
    const next = emitAndSettle(springWater, isSolid, emitter, add, { radius: 24, maxCells: CAPACITY, maxRise: 12 });
    return reconcile(next);
  }

  function reconcile(next: Set<string>): number {
    let changed = 0;
    for (const k of springWater) {
      if (!next.has(k)) {
        const slot = waterSlot.get(k);
        if (slot !== undefined) {
          const zero = new THREE.Matrix4().makeScale(0, 0, 0);
          waterMesh.setMatrixAt(slot, zero);
          waterFree.push(slot); waterSlot.delete(k); changed++;
        }
      }
    }
    for (const k of next) {
      if (!springWater.has(k)) {
        const slot = waterFree.pop();
        if (slot === undefined) break; // cap reached
        const [x, y, z] = k.split(",").map(Number);
        setCell(waterMesh, slot, x, y, z);
        waterSlot.set(k, slot); changed++;
      }
    }
    springWater.clear();
    for (const k of next) if (waterSlot.has(k)) springWater.add(k);
    if (changed) waterMesh.instanceMatrix.needsUpdate = true;
    return changed;
  }

  // Called every frame from the render loop; self-throttled.
  function tick(nowMs: number, weather: { precip?: number | null; isRaining?: boolean }) {
    if (!active || !emitter) return;
    if (nowMs - lastTick < TICK_MS) return;
    lastTick = nowMs;
    // Rain funds the budget.
    const precip = typeof weather.precip === "number" ? weather.precip : 0;
    if (weather.isRaining && precip > 0) { state = applyRain(state, precip, RAIN_K); persist(); }
    // Emit while funded and below cap.
    if (springWater.size >= CAPACITY) return;
    const r = springEmit(state, emitter, PER_TICK);
    if (!r.emit) return; // dry
    state = r.state;
    fill(PER_TICK);
    persist();
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
  };

  function report() {
    return {
      active,
      origin,
      emitter,
      budget: Math.round(state.budget),
      capacity: CAPACITY,
      waterCells: springWater.size,
      params: { amplitude: AMPLITUDE, frequency: FREQUENCY, ceilBand: CEIL_BAND, rainK: RAIN_K, perTick: PER_TICK, tickMs: TICK_MS },
      seed: theSeed,
    };
  }
}
