// WebGPU compute home for the PBF solver (ported from water-sim-sandbox,
// adapted for TinyWorld's injected voxel-crop terrains). The heavy per-substep
// math — integrate, grid build, ITERS x (lambda / deltaP / apply+collide),
// velocity update, XSPH viscosity — runs as compute dispatches; every particle
// solves every frame (no sleep system: GPU width makes full solve cheaper than
// the bookkeeping). The EXISTING CPU Sim instance is adopted as the
// authoritative mirror for everything serial: source emission with the
// back-pressure gate, evaporation, drainage, the mass ledger, report(), and
// foam's sampleFlow — those reuse the EXACT CPU rules via the host* hooks, so
// physics semantics match the classic path and adoption mid-fill (e.g. during
// the load warm-up) is seamless.
//
// TinyWorld deltas vs the sandbox spike:
//  - constructor adopts a live Sim (custom terrain) instead of building a
//    scenario sim internally;
//  - the per-column wallOpen masks ride in the tail of the solid buffer and
//    the collide kernel applies all four wall clamps, matching the CPU
//    collide exactly (without this, plunge pools leak through artificial
//    crop cuts — the Aug 12 boundary fix);
//  - worker-safe diagnostics (globalThis, no window).
//
// Data flow per tick: hostPre (emit on mirror) -> upload pos/vel ->
// SUBSTEPS x compute passes -> readback pos/vel/nbCount -> hostPost
// (speed/evaporate/drain/tick) -> hostRefreshGrid (foam + next emit gate).
import { SIM_CONSTANTS, type Sim, type SimOptions } from "./particles";

const WG = 128; // compute workgroup size
const K = 16; // particle index slots per grid cell (rest lattice fills ~8)

export async function requestGpuDevice(): Promise<GPUDevice | null> {
  try {
    const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch (e) {
    console.warn("[pwater gpu] WebGPU device request failed", e);
    return null;
  }
}

const f = (x: number): string => {
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

export class GpuSim {
  readonly mirror: Sim;
  private dev: GPUDevice;
  private cells: number;
  private disposed = false;
  private bufs: GPUBuffer[] = [];
  private posBuf!: GPUBuffer;
  private velBuf!: GPUBuffer;
  private nbBuf!: GPUBuffer;
  private paramBuf!: GPUBuffer;
  private posStage!: GPUBuffer;
  private velStage!: GPUBuffer;
  private nbStage!: GPUBuffer;
  private bindSolve!: GPUBindGroup;
  private bindGrid!: GPUBindGroup;
  private pl!: Record<string, GPUComputePipeline>;

  // Throws when the terrain's neighbor grid would exceed the device's storage
  // binding limit — callers catch and stay on the CPU path.
  constructor(dev: GPUDevice, mirror: Sim) {
    this.dev = dev;
    // Diagnostic ring: worker/headless console capture is unreliable, so
    // compile diagnostics + uncaptured device errors land in
    // globalThis.__gpuLog too.
    const g = globalThis as unknown as Record<string, unknown>;
    const log: string[] = (g.__gpuLog as string[]) ?? ((g.__gpuLog = []) as string[]);
    const note = (m: string) => {
      log.push(m);
      console.error(m);
    };
    dev.addEventListener("uncapturederror", (e) => {
      const ev = e as GPUUncapturedErrorEvent;
      note(`[pwater gpu] uncaptured: ${ev.error?.message ?? String(ev.error)}`);
    });
    dev.lost.then((info) => note(`[pwater gpu] device lost: ${info.reason} ${info.message}`)).catch(() => {});
    this.mirror = mirror;
    const t = this.mirror.terrain;
    const { H, D, R, MAX_N, GRAV, KILL_Y, SCORR_K, CFM_EPS, BOUND_FRICTION } = SIM_CONSTANTS;
    const H2 = H * H;
    const POLY6 = 315 / (64 * Math.PI * Math.pow(H, 9));
    const SPIKY = -45 / (Math.PI * Math.pow(H, 6));
    const RHO0 = this.mirror.hostRho0();
    const DP_MAX = 0.1 * H;
    const selfRho = POLY6 * H2 * H2 * H2;
    const wqT = H2 - 0.04 * H2;
    const WQ = POLY6 * wqT * wqT * wqT;
    const gnx = Math.ceil((t.nx + 8) / H);
    const gny = Math.ceil((t.ny + 14 - KILL_Y) / H);
    const gnz = Math.ceil(t.nz / H);
    this.cells = gnx * gny * gnz;
    void D;

    const gridBytes = this.cells * (K + 1) * 4;
    const limit = dev.limits.maxStorageBufferBindingSize;
    if (gridBytes > limit) {
      throw new Error(`[pwater gpu] neighbor grid ${(gridBytes / 1048576) | 0}MB exceeds device limit ${(limit / 1048576) | 0}MB`);
    }

    // Wall-openness masks ride in the tail of the solid buffer (the solve
    // stage is already at WebGPU's default 8-storage-buffer limit). Layout
    // after the nx*ny*nz solid cells: px[z 0..nz), mx[z 0..nz),
    // pz[x 0..nx), mz[x 0..nx); 1 = open (drain), 0 = closed (no-flow).
    const solidN = t.nx * t.ny * t.nz;
    const masks = this.mirror.hostWallMasks();

    const common = `
struct Params { count: u32, sdt: f32, visc: f32, pad: f32 };
const H: f32 = ${f(H)};
const H2: f32 = ${f(H2)};
const KILLY: f32 = ${f(KILL_Y)};
const GNX: i32 = ${gnx};
const GNY: i32 = ${gny};
const GNZ: i32 = ${gnz};
const K: u32 = ${K}u;
// grid buffer layout: per cell, [count, slot0 .. slot(K-1)] — one packed u32
// array keeps the solve stage inside WebGPU's default 8-storage-buffer limit
const GSTRIDE: u32 = ${K + 1}u;
fn gridIdx(px: f32, py: f32, pz: f32) -> u32 {
  var cx = i32(floor(px / H));
  var cy = i32(floor((py - KILLY) / H));
  var cz = i32(floor(pz / H));
  cx = clamp(cx, 0, GNX - 1);
  cy = clamp(cy, 0, GNY - 1);
  cz = clamp(cz, 0, GNZ - 1);
  return u32((cy * GNZ + cz) * GNX + cx);
}
`;

    const gridWgsl = `${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<f32>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;

@compute @workgroup_size(${WG})
fn clearGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= ${this.cells}u) { return; }
  atomicStore(&grid[c * GSTRIDE], 0u);
}

@compute @workgroup_size(${WG})
fn buildGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let c = gridIdx(pos[3u * i], pos[3u * i + 1u], pos[3u * i + 2u]);
  let s = atomicAdd(&grid[c * GSTRIDE], 1u);
  if (s < K) { atomicStore(&grid[c * GSTRIDE + 1u + s], i); }
}
`;

    const solveWgsl = `${common}
const POLY6C: f32 = ${f(POLY6)};
const SPIKYC: f32 = ${f(SPIKY)};
const RHO0: f32 = ${f(RHO0)};
const SELF_RHO: f32 = ${f(selfRho)};
const WQ: f32 = ${f(WQ)};
const R: f32 = ${f(R)};
const GRAV: f32 = ${f(GRAV)};
const VMAXF: f32 = ${f(0.45 * H)};
const DPMAX: f32 = ${f(DP_MAX)};
const SCORRK: f32 = ${f(SCORR_K)};
const CFMEPS: f32 = ${f(CFM_EPS)};
const FRICTION: f32 = ${f(BOUND_FRICTION)};
const TNX: i32 = ${t.nx};
const TNY: i32 = ${t.ny};
const TNZ: i32 = ${t.nz};
const SOLIDN: u32 = ${solidN}u;
const MOFF_PX: u32 = SOLIDN;
const MOFF_MX: u32 = SOLIDN + ${t.nz}u;
const MOFF_PZ: u32 = SOLIDN + ${2 * t.nz}u;
const MOFF_MZ: u32 = SOLIDN + ${2 * t.nz + t.nx}u;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<f32>;
@group(0) @binding(2) var<storage, read_write> vel: array<f32>;
@group(0) @binding(3) var<storage, read_write> prev: array<f32>;
@group(0) @binding(4) var<storage, read_write> dp: array<f32>;
@group(0) @binding(5) var<storage, read_write> lambda: array<f32>;
// flags: nbCount in bits 0..15, terrain-contact flag in bit 16
@group(0) @binding(6) var<storage, read_write> flags: array<u32>;
@group(0) @binding(7) var<storage, read> grid: array<u32>;
@group(0) @binding(8) var<storage, read> solid: array<u32>;
const CONTACT_BIT: u32 = 0x10000u;

fn poly6(r2: f32) -> f32 {
  if (r2 >= H2) { return 0.0; }
  let t = H2 - r2;
  return POLY6C * t * t * t;
}

fn solidAt(x: i32, y: i32, z: i32) -> bool {
  if (x < 0 || x >= TNX || z < 0 || z >= TNZ || y < 0 || y >= TNY) { return false; }
  return solid[u32((y * TNZ + z) * TNX + x)] == 1u;
}

@compute @workgroup_size(${WG})
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  var v = vec3<f32>(vel[b], vel[b + 1u] + GRAV * P.sdt, vel[b + 2u]);
  let vmax = VMAXF / P.sdt;
  let sp = length(v);
  if (sp > vmax) { v *= vmax / sp; }
  vel[b] = v.x; vel[b + 1u] = v.y; vel[b + 2u] = v.z;
  let p = vec3<f32>(pos[b], pos[b + 1u], pos[b + 2u]);
  prev[b] = p.x; prev[b + 1u] = p.y; prev[b + 2u] = p.z;
  let q = p + v * P.sdt;
  pos[b] = q.x; pos[b + 1u] = q.y; pos[b + 2u] = q.z;
  flags[i] = 0u;
}

@compute @workgroup_size(${WG})
fn lambdaPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  let p = vec3<f32>(pos[b], pos[b + 1u], pos[b + 2u]);
  var rho = SELF_RHO;
  var g = vec3<f32>(0.0);
  var sum2 = 0.0;
  var nn = 0u;
  let cx = i32(floor(p.x / H));
  let cy = i32(floor((p.y - KILLY) / H));
  let cz = i32(floor(p.z / H));
  for (var dy = -1; dy <= 1; dy++) {
    let gy = cy + dy;
    if (gy < 0 || gy >= GNY) { continue; }
    for (var dz = -1; dz <= 1; dz++) {
      let gz = cz + dz;
      if (gz < 0 || gz >= GNZ) { continue; }
      for (var dx = -1; dx <= 1; dx++) {
        let gx = cx + dx;
        if (gx < 0 || gx >= GNX) { continue; }
        let c = u32((gy * GNZ + gz) * GNX + gx);
        let base = c * GSTRIDE;
        let n = min(grid[base], K);
        for (var s = 0u; s < n; s++) {
          let j = grid[base + 1u + s];
          if (j == i) { continue; }
          let jb = 3u * j;
          let d = p - vec3<f32>(pos[jb], pos[jb + 1u], pos[jb + 2u]);
          let r2 = dot(d, d);
          if (r2 >= H2) { continue; }
          nn++;
          rho += poly6(r2);
          let r = sqrt(r2);
          if (r > 1e-9) {
            let gmag = SPIKYC * (H - r) * (H - r) / (r * RHO0);
            let gg = d * gmag;
            g += gg;
            sum2 += dot(gg, gg);
          }
        }
      }
    }
  }
  sum2 += dot(g, g);
  let C = rho / RHO0 - 1.0;
  lambda[i] = select(0.0, -C / (sum2 + CFMEPS), C > 0.0);
  flags[i] = (flags[i] & CONTACT_BIT) | min(nn, 0xFFFFu);
}

@compute @workgroup_size(${WG})
fn deltaPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  let p = vec3<f32>(pos[b], pos[b + 1u], pos[b + 2u]);
  let li = lambda[i];
  var acc = vec3<f32>(0.0);
  let cx = i32(floor(p.x / H));
  let cy = i32(floor((p.y - KILLY) / H));
  let cz = i32(floor(p.z / H));
  for (var dy = -1; dy <= 1; dy++) {
    let gy = cy + dy;
    if (gy < 0 || gy >= GNY) { continue; }
    for (var dz = -1; dz <= 1; dz++) {
      let gz = cz + dz;
      if (gz < 0 || gz >= GNZ) { continue; }
      for (var dx = -1; dx <= 1; dx++) {
        let gx = cx + dx;
        if (gx < 0 || gx >= GNX) { continue; }
        let c = u32((gy * GNZ + gz) * GNX + gx);
        let base = c * GSTRIDE;
        let n = min(grid[base], K);
        for (var s = 0u; s < n; s++) {
          let j = grid[base + 1u + s];
          if (j == i) { continue; }
          let jb = 3u * j;
          let d = p - vec3<f32>(pos[jb], pos[jb + 1u], pos[jb + 2u]);
          let r2 = dot(d, d);
          let r = sqrt(r2);
          if (r <= 1e-9 || r >= H) { continue; }
          let ratio = poly6(r2) / WQ;
          let scorr = -SCORRK * ratio * ratio * ratio * ratio;
          let gmag = SPIKYC * (H - r) * (H - r) / (r * RHO0);
          acc += (li + lambda[j] + scorr) * gmag * d;
        }
      }
    }
  }
  let m2 = dot(acc, acc);
  if (m2 > DPMAX * DPMAX) { acc *= DPMAX / sqrt(m2); }
  dp[b] = acc.x; dp[b + 1u] = acc.y; dp[b + 2u] = acc.z;
}

@compute @workgroup_size(${WG})
fn applyPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  var px = pos[b] + dp[b];
  var py = pos[b + 1u] + dp[b + 1u];
  var pz = pos[b + 2u] + dp[b + 2u];
  var hit = false;
  // Lateral walls: closed columns clamp (no-flow boundary), open columns let
  // the particle pass so the mirror's drain() culls it — mask per column,
  // exactly like the CPU collide.
  {
    let czi = u32(clamp(i32(floor(pz)), 0, TNZ - 1));
    let cxi = u32(clamp(i32(floor(px)), 0, TNX - 1));
    if (px < R && solid[MOFF_MX + czi] == 0u) { px = R; hit = true; }
    if (px > f32(TNX) - R && solid[MOFF_PX + czi] == 0u) { px = f32(TNX) - R; hit = true; }
    if (pz < R && solid[MOFF_MZ + cxi] == 0u) { pz = R; hit = true; }
    if (pz > f32(TNZ) - R && solid[MOFF_PZ + cxi] == 0u) { pz = f32(TNZ) - R; hit = true; }
  }
  let cx = i32(floor(px));
  let cy = i32(floor(py));
  let cz = i32(floor(pz));
  for (var dy = -1; dy <= 1; dy++) {
    for (var dz = -1; dz <= 1; dz++) {
      for (var dx = -1; dx <= 1; dx++) {
        let vx = cx + dx;
        let vy = cy + dy;
        let vz = cz + dz;
        if (!solidAt(vx, vy, vz)) { continue; }
        let fx = f32(vx);
        let fy = f32(vy);
        let fz = f32(vz);
        let qx = clamp(px, fx, fx + 1.0);
        let qy = clamp(py, fy, fy + 1.0);
        let qz = clamp(pz, fz, fz + 1.0);
        let ox = px - qx;
        let oy = py - qy;
        let oz = pz - qz;
        let d2 = ox * ox + oy * oy + oz * oz;
        if (d2 >= R * R) { continue; }
        hit = true;
        if (d2 > 1e-12) {
          let d = sqrt(d2);
          let push = (R - d) / d;
          px += ox * push;
          py += oy * push;
          pz += oz * push;
        } else {
          // center inside the cell: resolve to the face the segment
          // prev->pos entered through (bounded by real penetration)
          let ex = prev[b];
          let ey = prev[b + 1u];
          let ez = prev[b + 2u];
          let mx = px - ex;
          let my = py - ey;
          let mz = pz - ez;
          var tBest = -1.0;
          var axis = -1;
          var side = 0.0;
          if (mx > 1e-9 && ex <= fx) { let tt = (fx - ex) / mx; if (tt > tBest) { tBest = tt; axis = 0; side = -1.0; } }
          if (mx < -1e-9 && ex >= fx + 1.0) { let tt = (fx + 1.0 - ex) / mx; if (tt > tBest) { tBest = tt; axis = 0; side = 1.0; } }
          if (my > 1e-9 && ey <= fy) { let tt = (fy - ey) / my; if (tt > tBest) { tBest = tt; axis = 1; side = -1.0; } }
          if (my < -1e-9 && ey >= fy + 1.0) { let tt = (fy + 1.0 - ey) / my; if (tt > tBest) { tBest = tt; axis = 1; side = 1.0; } }
          if (mz > 1e-9 && ez <= fz) { let tt = (fz - ez) / mz; if (tt > tBest) { tBest = tt; axis = 2; side = -1.0; } }
          if (mz < -1e-9 && ez >= fz + 1.0) { let tt = (fz + 1.0 - ez) / mz; if (tt > tBest) { tBest = tt; axis = 2; side = 1.0; } }
          if (axis == 0) { px = select(fx + 1.0 + R, fx - R, side < 0.0); }
          else if (axis == 1) { py = select(fy + 1.0 + R, fy - R, side < 0.0); }
          else if (axis == 2) { pz = select(fz + 1.0 + R, fz - R, side < 0.0); }
          else { py = fy + 1.0 + R; prev[b + 1u] = py; }
        }
      }
    }
  }
  pos[b] = px;
  pos[b + 1u] = py;
  pos[b + 2u] = pz;
  if (hit) { flags[i] = flags[i] | CONTACT_BIT; }
}

@compute @workgroup_size(${WG})
fn velPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  var v = vec3<f32>(
    (pos[b] - prev[b]) / P.sdt,
    (pos[b + 1u] - prev[b + 1u]) / P.sdt,
    (pos[b + 2u] - prev[b + 2u]) / P.sdt,
  );
  if ((flags[i] & CONTACT_BIT) != 0u) { v *= FRICTION; }
  vel[b] = v.x; vel[b + 1u] = v.y; vel[b + 2u] = v.z;
}

@compute @workgroup_size(${WG})
fn viscGather(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  let p = vec3<f32>(pos[b], pos[b + 1u], pos[b + 2u]);
  let vi = vec3<f32>(vel[b], vel[b + 1u], vel[b + 2u]);
  var acc = vec3<f32>(0.0);
  let cx = i32(floor(p.x / H));
  let cy = i32(floor((p.y - KILLY) / H));
  let cz = i32(floor(p.z / H));
  for (var dy = -1; dy <= 1; dy++) {
    let gy = cy + dy;
    if (gy < 0 || gy >= GNY) { continue; }
    for (var dz = -1; dz <= 1; dz++) {
      let gz = cz + dz;
      if (gz < 0 || gz >= GNZ) { continue; }
      for (var dx = -1; dx <= 1; dx++) {
        let gx = cx + dx;
        if (gx < 0 || gx >= GNX) { continue; }
        let c = u32((gy * GNZ + gz) * GNX + gx);
        let base = c * GSTRIDE;
        let n = min(grid[base], K);
        for (var s = 0u; s < n; s++) {
          let j = grid[base + 1u + s];
          if (j == i) { continue; }
          let jb = 3u * j;
          let d = p - vec3<f32>(pos[jb], pos[jb + 1u], pos[jb + 2u]);
          let w = poly6(dot(d, d)) / RHO0;
          acc += (vec3<f32>(vel[jb], vel[jb + 1u], vel[jb + 2u]) - vi) * w;
        }
      }
    }
  }
  dp[b] = acc.x; dp[b + 1u] = acc.y; dp[b + 2u] = acc.z;
}

@compute @workgroup_size(${WG})
fn viscApply(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = 3u * i;
  vel[b] += P.visc * dp[b];
  vel[b + 1u] += P.visc * dp[b + 1u];
  vel[b + 2u] += P.visc * dp[b + 2u];
}
`;

    const mk = (size: number, usage: number): GPUBuffer => {
      const buf = dev.createBuffer({ size, usage });
      this.bufs.push(buf);
      return buf;
    };
    const S = GPUBufferUsage.STORAGE;
    const n = MAX_N;
    this.posBuf = mk(n * 12, S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.velBuf = mk(n * 12, S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const prevBuf = mk(n * 12, S);
    const dpBuf = mk(n * 12, S);
    const lambdaBuf = mk(n * 4, S);
    this.nbBuf = mk(n * 4, S | GPUBufferUsage.COPY_SRC); // flags: nb | contact<<16
    const gridBuf = mk(gridBytes, S);
    const solidBuf = mk((solidN + 2 * t.nz + 2 * t.nx) * 4, S | GPUBufferUsage.COPY_DST);
    this.paramBuf = mk(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.posStage = mk(n * 12, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.velStage = mk(n * 12, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.nbStage = mk(n * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    {
      const packed = new Uint32Array(solidN + 2 * t.nz + 2 * t.nx);
      packed.set(t.solid);
      packed.set(masks.px, solidN);
      packed.set(masks.mx, solidN + t.nz);
      packed.set(masks.pz, solidN + 2 * t.nz);
      packed.set(masks.mz, solidN + 2 * t.nz + t.nx);
      dev.queue.writeBuffer(solidBuf, 0, packed);
    }

    const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    });
    const solveLayout = dev.createBindGroupLayout({
      entries: [
        entry(0, "uniform"),
        entry(1, "storage"), entry(2, "storage"), entry(3, "storage"), entry(4, "storage"),
        entry(5, "storage"), entry(6, "storage"),
        entry(7, "read-only-storage"), entry(8, "read-only-storage"),
      ],
    });
    const gridLayout = dev.createBindGroupLayout({
      entries: [entry(0, "uniform"), entry(1, "read-only-storage"), entry(2, "storage")],
    });
    const bind = (layout: GPUBindGroupLayout, buffers: GPUBuffer[]): GPUBindGroup =>
      dev.createBindGroup({
        layout,
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    this.bindSolve = bind(solveLayout, [
      this.paramBuf, this.posBuf, this.velBuf, prevBuf, dpBuf, lambdaBuf, this.nbBuf, gridBuf, solidBuf,
    ]);
    this.bindGrid = bind(gridLayout, [this.paramBuf, this.posBuf, gridBuf]);

    const solveMod = dev.createShaderModule({ code: solveWgsl });
    const gridMod = dev.createShaderModule({ code: gridWgsl });
    for (const [name, mod] of [["solve", solveMod], ["grid", gridMod]] as const) {
      void mod.getCompilationInfo().then((info) => {
        for (const m of info.messages)
          if (m.type === "error") note(`[pwater gpu] ${name} WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
      });
    }
    const pipe = (module: GPUShaderModule, layout: GPUBindGroupLayout, entryPoint: string): GPUComputePipeline =>
      dev.createComputePipeline({
        layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint },
      });
    this.pl = {
      integrate: pipe(solveMod, solveLayout, "integrate"),
      lambdaPass: pipe(solveMod, solveLayout, "lambdaPass"),
      deltaPass: pipe(solveMod, solveLayout, "deltaPass"),
      applyPass: pipe(solveMod, solveLayout, "applyPass"),
      velPass: pipe(solveMod, solveLayout, "velPass"),
      viscGather: pipe(solveMod, solveLayout, "viscGather"),
      viscApply: pipe(solveMod, solveLayout, "viscApply"),
      clearGrid: pipe(gridMod, gridLayout, "clearGrid"),
      buildGrid: pipe(gridMod, gridLayout, "buildGrid"),
    };
  }

  async step(dt: number, opts: SimOptions): Promise<void> {
    if (this.disposed) return;
    const m = this.mirror;
    m.hostPre(dt, opts);
    m.solvedCount = m.count;
    m.asleepCount = 0;
    const n = m.count;
    if (n > 0) {
      const visc = Math.max(0, Math.min(0.4, opts.viscosity));
      const sdt = dt / SIM_CONSTANTS.SUBSTEPS;
      const dev = this.dev;
      dev.queue.writeBuffer(this.posBuf, 0, m.pos as unknown as GPUAllowSharedBufferSource, 0, n * 3);
      dev.queue.writeBuffer(this.velBuf, 0, m.vel as unknown as GPUAllowSharedBufferSource, 0, n * 3);
      const pu = new ArrayBuffer(16);
      new Uint32Array(pu, 0, 1)[0] = n;
      new Float32Array(pu, 4, 3).set([sdt, visc, 0]);
      dev.queue.writeBuffer(this.paramBuf, 0, pu);

      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      const pWG = Math.ceil(n / WG);
      const cWG = Math.ceil(this.cells / WG);
      const run = (name: string, grid: boolean, groups: number) => {
        pass.setPipeline(this.pl[name]);
        pass.setBindGroup(0, grid ? this.bindGrid : this.bindSolve);
        pass.dispatchWorkgroups(groups);
      };
      for (let sub = 0; sub < SIM_CONSTANTS.SUBSTEPS; sub++) {
        run("integrate", false, pWG);
        run("clearGrid", true, cWG);
        run("buildGrid", true, pWG);
        for (let it = 0; it < SIM_CONSTANTS.ITERS; it++) {
          run("lambdaPass", false, pWG);
          run("deltaPass", false, pWG);
          run("applyPass", false, pWG);
        }
        run("velPass", false, pWG);
        if (visc > 0) {
          run("viscGather", false, pWG);
          run("viscApply", false, pWG);
        }
      }
      pass.end();
      enc.copyBufferToBuffer(this.posBuf, 0, this.posStage, 0, n * 12);
      enc.copyBufferToBuffer(this.velBuf, 0, this.velStage, 0, n * 12);
      enc.copyBufferToBuffer(this.nbBuf, 0, this.nbStage, 0, n * 4);
      dev.queue.submit([enc.finish()]);

      await Promise.all([
        this.posStage.mapAsync(GPUMapMode.READ, 0, n * 12),
        this.velStage.mapAsync(GPUMapMode.READ, 0, n * 12),
        this.nbStage.mapAsync(GPUMapMode.READ, 0, n * 4),
      ]);
      if (this.disposed) return;
      m.pos.set(new Float32Array(this.posStage.getMappedRange(0, n * 12)));
      m.vel.set(new Float32Array(this.velStage.getMappedRange(0, n * 12)));
      const nb = new Uint32Array(this.nbStage.getMappedRange(0, n * 4));
      for (let i = 0; i < n; i++) m.nbCount[i] = nb[i] & 0xffff;
      this.posStage.unmap();
      this.velStage.unmap();
      this.nbStage.unmap();
    }
    m.hostPost(dt, opts);
    m.hostRefreshGrid();
  }

  dispose() {
    this.disposed = true;
    for (const b of this.bufs) {
      try {
        b.destroy();
      } catch {
        // buffer may still be mapped or already destroyed
      }
    }
  }
}
