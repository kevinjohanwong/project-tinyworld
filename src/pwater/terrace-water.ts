// Terrace-spring water: mass-based voxel fluid automaton + isosurface/ribbon
// renderer, ported from KJ's terrace-spring build (Sep 3) as a FULL
// REPLACEMENT for the particle solver. One cell holds a continuous mass of
// water; three per-cell rules (fall with compression, level sideways with
// thin-film cling, squeeze up) make pools find their level, and lip momentum
// (V0_BASE + V0_DEPTH·depth, VDECAY per cell fallen) gives falls a real
// parabolic launch INSIDE the sim. Resting water renders as a surface-nets
// isosurface over a temporally smoothed density field (mass m reads exactly
// m high); falling water renders as ribbons tracing the actual cell path the
// water takes, merged into sheets where falls touch; foam is born only where
// falls land. All constants are the terrace-spring values KJ approved —
// change them there first.
//
// Everything here works in CELL space (1 cell = K^3 world voxels, see
// tinyworld-pwater.ts). The render group carries the cell→world transform,
// so the ported geometry/shaders keep terrace-spring's tuning verbatim.

export type TerraceOpts = {
  THREE: any;
  renderer: any;
  nx: number;
  ny: number;
  nz: number;
  // Shared reference with the bridge's terrain.solid — live edits flow in.
  solid: Uint8Array;
  // Spring cell (box coords). Snapped up to the first open cell at init.
  spring: { x: number; y: number; z: number };
  off: { x: number; y: number; z: number };
  cellV: number;
  springRate: number; // mass/step
  warmSteps: number;
  // Ribbon density normalizer: per-cell fall density at which a ribbon reaches
  // full width/whiteness. Terrace reference = 0.03 (tuned on its 52-cell demo
  // grid); TinyWorld falls carry less mass per cell, so the bridge defaults
  // lower. Presentation-only — never feeds back into the sim.
  ribNorm?: number;
  // Momentum-everywhere toggle (default on). Off reproduces the lip-only
  // momentum behavior exactly (retention/bias/head-impulse all skipped).
  momentum?: boolean;
  // Ballistic-droplet toggle (default on). Off keeps all lip outflow on the
  // grid path (pre-droplet behavior).
  drops?: boolean;
};

const MAXC = 0.02, MINMASS = 0.0001, MINFLOW = 0.01, MAXSPEED = 1.0, VIS = 0.028;
const V0_BASE = 0.22, V0_DEPTH = 0.38, VDECAY = 0.66;
// Momentum everywhere (best-in-class ladder rung 1): every cell of water
// carries velocity, not just lip launches. Universal rules only — resting
// water RETAINS momentum with friction (bed vs free), every mass transfer
// CARRIES the source's momentum, head drops feed a gravity impulse into the
// moving parcel, flows are biased along existing velocity (inertia — lets
// water surge slightly past level, which is where sloshing and traveling
// waves come from), and solid walls reflect the incoming component.
const INERTIA = 1.6, MOM_PUSH = 0.04, HEADV = 0.55;
const RET_FREE = 0.997, RET_BED = 0.985, REFL = 0.3;
// Ballistic droplets (ladder rung 2): water crossing a lip with launch speed
// leaves the grid as simulated airborne parcels — position + 3D velocity,
// gravity-integrated, mass-conserving — and splashes its mass back into the
// grid where it lands. The arc is SIMULATED, not rendered. VSCALE converts
// automaton launch speed (cells/step) to continuous cells/s at the approved
// diorama pace; G_DROP matches the sim's visual gravity constant.
const MAXD = 3000, DROP_MASS = 0.02, VSCALE = 6, G_DROP = 28, LAND_MASS = 0.35;
const STEP_HZ = 120; // terrace runs 2 steps/frame at 60fps
const ISO = 0.5;
// Corner-lattice vote weight of a dry (air) cell relative to a wet cell.
const AIR_W = 1 / 3;

export function createTerraceWater(opts: TerraceOpts) {
  const { THREE, renderer, nx, ny, nz, solid, off, cellV } = opts;
  let ribNorm = opts.ribNorm && opts.ribNorm > 0 ? opts.ribNorm : 0.03;
  let momOn = opts.momentum !== false;
  let dropsOn = opts.drops !== false;
  const LAYER = nx * nz; // idx = y*LAYER + z*nx + x — same layout as terrain.solid
  const S = nx * ny * nz;
  const idx = (x: number, y: number, z: number) => y * LAYER + z * nx + x;

  let mass = new Float32Array(S);
  let nmass = new Float32Array(S);
  const flux = new Float32Array(S);
  const dflow = new Float32Array(S);
  const fvx = new Float32Array(S), fvz = new Float32Array(S);
  const hvx = new Float32Array(S), hvz = new Float32Array(S);
  const mmx = new Float32Array(S), mmz = new Float32Array(S);

  // Spring: first open cell at/above the sited origin in its column.
  let springI = -1;
  {
    const { x, z } = opts.spring;
    for (let y = Math.max(0, opts.spring.y); y < ny; y++) {
      if (!solid[idx(x, y, z)]) { springI = idx(x, y, z); break; }
    }
    if (springI < 0) springI = idx(x, Math.max(0, Math.min(ny - 1, opts.spring.y)), z);
  }
  let springOn = true;
  let springRate = opts.springRate;
  let inAcc = 0, outAcc = 0, displacedAcc = 0;
  let inTotal = 0, outTotal = 0;

  // ── Ballistic droplet state ──────────────────────────────────────────────
  // Lip outflow accrues per-cell until a full droplet's mass is available,
  // then emits a parcel with the momentum-weighted launch velocity. Every
  // unit of mass is ledger-tracked: accumulator (airAcc) + flying (airFly).
  const dPos = new Float32Array(MAXD * 3), dVel = new Float32Array(MAXD * 3), dMass = new Float32Array(MAXD);
  let dCount = 0, airAcc = 0, airFly = 0;
  const dAcc = new Map<number, { m: number; px: number; pz: number }>();
  const dropImpacts: Array<{ x: number; z: number; t: number }> = [];
  function accrueDroplet(cx: number, cy: number, cz: number, dm: number, lvx: number, lvz: number) {
    const key = cy * LAYER + cz * nx + cx;
    let a = dAcc.get(key);
    if (!a) dAcc.set(key, (a = { m: 0, px: 0, pz: 0 }));
    a.m += dm; a.px += dm * lvx; a.pz += dm * lvz; airAcc += dm;
    while (a.m >= DROP_MASS && dCount < MAXD) {
      const j3 = dCount * 3;
      dPos[j3] = cx + 0.2 + Math.random() * 0.6;
      dPos[j3 + 1] = cy + 0.3 + Math.random() * 0.3;
      dPos[j3 + 2] = cz + 0.2 + Math.random() * 0.6;
      const mvx = a.px / a.m, mvz = a.pz / a.m;
      dVel[j3] = mvx * VSCALE * (0.85 + Math.random() * 0.3);
      dVel[j3 + 1] = (Math.random() - 0.35) * 1.4;
      dVel[j3 + 2] = mvz * VSCALE * (0.85 + Math.random() * 0.3);
      dMass[dCount] = DROP_MASS;
      dCount++;
      a.px -= DROP_MASS * mvx; a.pz -= DROP_MASS * mvz; a.m -= DROP_MASS;
      airAcc -= DROP_MASS; airFly += DROP_MASS;
    }
  }

  // Land a droplet: its mass and horizontal momentum rejoin the grid cell,
  // conserving both (the cell's velocity becomes the mass-weighted mean).
  function landDroplet(cell: number, dm: number, vx: number, vz: number) {
    const m0 = mass[cell], mt = m0 + dm;
    let cvx = (hvx[cell] * m0 + Math.max(-0.95, Math.min(0.95, vx / VSCALE)) * dm) / mt;
    let cvz = (hvz[cell] * m0 + Math.max(-0.95, Math.min(0.95, vz / VSCALE)) * dm) / mt;
    hvx[cell] = cvx; hvz[cell] = cvz;
    mass[cell] = mt;
    airFly -= dm;
    // A droplet may land beyond the active box — grow it so the automaton
    // scans the landed water next step.
    const ly = (cell / LAYER) | 0, lr = cell - ly * LAYER, lz = (lr / nx) | 0, lx = lr - lz * nx;
    if (lx < bx0) bx0 = lx; if (lx > bx1) bx1 = lx;
    if (ly < by0) by0 = ly; if (ly > by1) by1 = ly;
    if (lz < bz0) bz0 = lz; if (lz > bz1) bz1 = lz;
  }

  // Ballistic integrator: gravity + straight-line motion, substepped so fast
  // warm-up frames cannot tunnel through one-cell-thick terrain. A droplet
  // ends by landing on solid ground, plunging into standing water, or leaving
  // the world (ledger-drained) — never by timeout.
  function stepDroplets(dt: number) {
    if (dCount === 0) return;
    const nSub = Math.max(1, Math.ceil(dt * 30));
    const h = dt / nSub;
    for (let s = 0; s < nSub && dCount > 0; s++) {
      let j = 0;
      while (j < dCount) {
        const j3 = j * 3;
        dVel[j3 + 1] -= G_DROP * h;
        dPos[j3] += dVel[j3] * h;
        dPos[j3 + 1] += dVel[j3 + 1] * h;
        dPos[j3 + 2] += dVel[j3 + 2] * h;
        const cx = Math.floor(dPos[j3]), cy = Math.floor(dPos[j3 + 1]), cz = Math.floor(dPos[j3 + 2]);
        let dead = false;
        if (cx < 0 || cz < 0 || cx >= nx || cz >= nz || cy < 0) {
          // Off the world: same true-void exit as the box floor.
          outTotal += dMass[j]; outAcc += dMass[j]; airFly -= dMass[j];
          dead = true;
        } else if (cy < ny) {
          const cell = cy * LAYER + cz * nx + cx;
          if (solid[cell]) {
            // Hit terrain — splash into the first open cell above the surface.
            let ly = cy + 1;
            while (ly < ny && solid[ly * LAYER + cz * nx + cx]) ly++;
            const sp = Math.sqrt(dVel[j3] * dVel[j3] + dVel[j3 + 1] * dVel[j3 + 1] + dVel[j3 + 2] * dVel[j3 + 2]);
            if (ly < ny) {
              landDroplet(ly * LAYER + cz * nx + cx, dMass[j], dVel[j3], dVel[j3 + 2]);
              spawnSpray(dPos[j3], ly, dPos[j3 + 2], Math.min(1, sp * 0.08) * LAND_MASS, 2);
            } else { outTotal += dMass[j]; outAcc += dMass[j]; airFly -= dMass[j]; }
            dead = true;
          } else if (mass[cell] >= 0.5 && dVel[j3 + 1] < 0) {
            // Plunged into standing water.
            const sp = Math.sqrt(dVel[j3] * dVel[j3] + dVel[j3 + 1] * dVel[j3 + 1] + dVel[j3 + 2] * dVel[j3 + 2]);
            landDroplet(cell, dMass[j], dVel[j3], dVel[j3 + 2]);
            spawnSpray(dPos[j3], cy + Math.min(1, mass[cell]), dPos[j3 + 2], Math.min(1, sp * 0.08) * LAND_MASS, 2);
            dead = true;
          }
        }
        if (dead) {
          const l = --dCount, l3 = l * 3;
          dPos[j3] = dPos[l3]; dPos[j3 + 1] = dPos[l3 + 1]; dPos[j3 + 2] = dPos[l3 + 2];
          dVel[j3] = dVel[l3]; dVel[j3 + 1] = dVel[l3 + 1]; dVel[j3 + 2] = dVel[l3 + 2];
          dMass[j] = dMass[l];
          continue;
        }
        j++;
      }
    }
  }

  function stable(t: number) {
    if (t <= 1) return 1;
    if (t < 2 + MAXC) return (1 + t * MAXC) / (1 + MAXC);
    return (t + MAXC) / 2;
  }
  const DX = [-1, 1, 0, 0], DZ = [0, 0, -1, 1], DOFF = [-1, 1, -nx, nx];

  // Active bounding box: the automaton scans only where water is (plus the
  // spring). Terrace scans the whole 52³ grid; our grids reach ~1M cells, so
  // this is the one structural change — identical dynamics inside the box.
  const sx0 = springI % nx, sy0 = (springI / LAYER) | 0, sz0 = ((springI - sy0 * LAYER) / nx) | 0;
  let bx0 = sx0, bx1 = sx0, by0 = sy0, by1 = sy0, bz0 = sz0, bz1 = sz0;

  function step() {
    if (springOn && !solid[springI]) {
      const add = Math.min(springRate, 2.4 - mass[springI]);
      if (add > 0) { mass[springI] += add; inAcc += add; inTotal += add; }
    }
    nmass.set(mass);
    mmx.fill(0); mmz.fill(0);
    const x0 = Math.max(0, bx0), x1 = Math.min(nx - 1, bx1);
    const y0 = Math.max(0, by0), y1 = Math.min(ny - 1, by1);
    const z0 = Math.max(0, bz0), z1 = Math.min(nz - 1, bz1);
    for (let y = y0; y <= y1; y++) {
      const yb = y * LAYER;
      for (let z = z0; z <= z1; z++) {
        const zb = yb + z * nx;
        for (let x = x0; x <= x1; x++) {
          const i = zb + x;
          if (solid[i]) continue;
          let rem = mass[i];
          if (rem <= MINMASS) { if (flux[i] > 0) flux[i] *= 0.85; continue; }
          const rem0 = rem;
          const vIx = hvx[i], vIz = hvz[i];
          const resting = y === 0 || solid[i - LAYER] === 1 || mass[i - LAYER] >= 0.5;
          let moved = 0;
          let freeEdgeMask = 0;
          dflow[i] = 0; fvx[i] = 0; fvz[i] = 0;

          /* 1. down */
          if (y > 0) {
            const b = i - LAYER;
            if (!solid[b]) {
              let f = stable(rem + mass[b]) - mass[b];
              if (f > MINFLOW) f *= 0.5;
              if (f > 0) {
                if (f > rem) f = rem;
                if (f > MAXSPEED) f = MAXSPEED;
                // Free fall carries its horizontal velocity: part of the mass
                // steps sideways as it drops (the discrete parabola).
                const vx = vIx, vz = vIz;
                let fd = 0;
                if (f > 0.5 * rem0 && (vx !== 0 || vz !== 0)) {
                  const ax = Math.abs(vx), az = Math.abs(vz);
                  const k = ax >= az ? (vx > 0 ? 1 : 0) : (vz > 0 ? 3 : 2);
                  const qx = x + DX[k], qz = z + DZ[k];
                  if (qx >= 0 && qz >= 0 && qx < nx && qz < nz) {
                    const j = b + DOFF[k];
                    if (!solid[j]) {
                      fd = f * Math.min(0.9, Math.max(ax, az));
                      nmass[j] += fd; mmx[j] += fd * vx * VDECAY; mmz[j] += fd * vz * VDECAY;
                    }
                  }
                  mmx[b] += (f - fd) * vx * VDECAY; mmz[b] += (f - fd) * vz * VDECAY;
                } else if (momOn && (vx !== 0 || vz !== 0)) {
                  // Gentle downflow keeps its horizontal momentum too.
                  mmx[b] += f * vx * VDECAY; mmz[b] += f * vz * VDECAY;
                }
                nmass[i] -= f; nmass[b] += f - fd; rem -= f; moved += f; dflow[i] = f;
              }
            }
          }

          /* 2. unsupported-neighbour outflow — gravity gets first claim.
             A shallow film may cling over supported water, but not when the
             adjacent cell opens into a genuine drop. Move into that open
             neighbour before level spreading, then carry the measured launch
             momentum into the falling column on the next step. */
          if (rem > MINMASS && resting && y > 0) {
            for (let k = 0; k < 4; k++) {
              const qx = x + DX[k], qz = z + DZ[k];
              if (qx < 0 || qz < 0 || qx >= nx || qz >= nz) continue;
              const j = i + DOFF[k];
              if (solid[j] || solid[j - LAYER] || mass[j - LAYER] >= 0.5) continue;
              freeEdgeMask |= 1 << k;
              let f = (rem - mass[j]) / 5;
              if (f > MINFLOW) f *= 0.5;
              if (f <= 0) continue;
              if (f > rem) f = rem;
              const v0 = V0_BASE + V0_DEPTH * Math.min(1, rem0);
              const lvx = (momOn ? vIx : 0) + v0 * DX[k], lvz = (momOn ? vIz : 0) + v0 * DZ[k];
              let dm = 0;
              if (dropsOn && dCount < MAXD - 8) {
                // The faster the launch, the more of the parcel detaches
                // from the grid as ballistic droplets.
                const sp = Math.sqrt(lvx * lvx + lvz * lvz);
                dm = f * Math.min(0.3, sp * 0.55);
                if (dm > 1e-6) accrueDroplet(qx, y, qz, dm, lvx, lvz); else dm = 0;
              }
              nmass[i] -= f; nmass[j] += f - dm; rem -= f; moved += f;
              fvx[i] += f * DX[k]; fvz[i] += f * DZ[k];
              mmx[j] += (f - dm) * v0 * DX[k]; mmz[j] += (f - dm) * v0 * DZ[k];
              if (momOn) { mmx[j] += (f - dm) * vIx; mmz[j] += (f - dm) * vIz; }
              if (rem <= MINMASS) break;
            }
          }

          /* 3. level sideways — a thin film riding on full water clings */
          if (rem > MINMASS && !(rem < 0.06 && y > 0 && !solid[i - LAYER] && mass[i - LAYER] >= 0.95)) {
            for (let k = 0; k < 4; k++) {
              if (freeEdgeMask & (1 << k)) continue;
              const qx = x + DX[k], qz = z + DZ[k];
              if (qx < 0 || qz < 0 || qx >= nx || qz >= nz) continue;
              const j = i + DOFF[k];
              if (solid[j]) continue;
              const head = rem - mass[j];
              let f = head / 5;
              if (momOn) {
                // Inertia: flow along the cell's velocity is amplified, flow
                // against it suppressed; strong momentum pushes water slightly
                // past level equilibrium (surge → slosh → traveling waves).
                const vdot = vIx * DX[k] + vIz * DZ[k];
                const bias = 1 + INERTIA * vdot;
                f = (f > 0 ? f : 0) * (bias > 0 ? bias : 0) + (vdot > 0 ? MOM_PUSH * vdot * rem : 0);
              }
              if (f > MINFLOW) f *= 0.5;
              if (f <= 0) continue;
              if (f > rem) f = rem;
              nmass[i] -= f; nmass[j] += f; rem -= f; moved += f; fvx[i] += f * DX[k]; fvz[i] += f * DZ[k];
              let dm = 0;
              // Over a lip: water leaving resting ground into air picks up
              // speed — and the fast fraction detaches as ballistic droplets.
              if (resting && y > 0 && !solid[j - LAYER] && mass[j - LAYER] < 0.5) {
                const v0 = V0_BASE + V0_DEPTH * Math.min(1, rem0);
                const lvx = (momOn ? vIx : 0) + v0 * DX[k], lvz = (momOn ? vIz : 0) + v0 * DZ[k];
                if (dropsOn && dCount < MAXD - 8) {
                  const sp = Math.sqrt(lvx * lvx + lvz * lvz);
                  dm = f * Math.min(0.3, sp * 0.55);
                  if (dm > 1e-6) { accrueDroplet(qx, y, qz, dm, lvx, lvz); nmass[j] -= dm; } else dm = 0;
                }
                mmx[j] += (f - dm) * v0 * DX[k]; mmz[j] += (f - dm) * v0 * DZ[k];
              }
              if (momOn) {
                // The parcel keeps the source velocity and gains a gravity
                // impulse from the head it dropped through.
                const hg = head > 0 ? HEADV * Math.min(1, head) : 0;
                mmx[j] += (f - dm) * (vIx + hg * DX[k]); mmz[j] += (f - dm) * (vIz + hg * DZ[k]);
              }
              if (rem <= MINMASS) break;
            }
          }

          /* 4. squeeze up */
          if (rem > MINMASS && y < ny - 1) {
            const u = i + LAYER;
            if (!solid[u]) {
              let f = rem - stable(rem + mass[u]);
              if (f > MINFLOW) f *= 0.5;
              if (f > 0) {
                if (f > rem) f = rem;
                if (f > MAXSPEED) f = MAXSPEED;
                nmass[i] -= f; nmass[u] += f; rem -= f; moved += f;
              }
            }
          }
          // Momentum retention: whatever stays in the cell keeps its velocity
          // minus friction — bed contact drains it faster than free water.
          if (momOn && rem > MINMASS && (vIx !== 0 || vIz !== 0)) {
            const ret = resting ? RET_BED : RET_FREE;
            mmx[i] += rem * vIx * ret; mmz[i] += rem * vIz * ret;
          }
          flux[i] = flux[i] * 0.84 + moved * 0.16;
        }
      }
    }
    const t = mass; mass = nmass; nmass = t;

    // momentum -> velocity, and refresh the active box (mm*/water written at
    // most 1 cell outside the old box, so scan old box + 2).
    const rx0 = Math.max(0, x0 - 2), rx1 = Math.min(nx - 1, x1 + 2);
    const ry0 = Math.max(0, y0 - 2), ry1 = Math.min(ny - 1, y1 + 2);
    const rz0 = Math.max(0, z0 - 2), rz1 = Math.min(nz - 1, z1 + 2);
    let wx0 = sx0, wx1 = sx0, wy0 = sy0, wy1 = sy0, wz0 = sz0, wz1 = sz0;
    for (let y = ry0; y <= ry1; y++) {
      const yb = y * LAYER;
      for (let z = rz0; z <= rz1; z++) {
        const zb = yb + z * nx;
        for (let x = rx0; x <= rx1; x++) {
          const i = zb + x;
          const mx = mmx[i], mz = mmz[i];
          if (mx === 0 && mz === 0) { hvx[i] = 0; hvz[i] = 0; }
          else {
            const m = mass[i];
            if (m <= MINMASS) { hvx[i] = 0; hvz[i] = 0; }
            else {
              let vx = mx / m, vz = mz / m;
              if (vx > 0.95) vx = 0.95; else if (vx < -0.95) vx = -0.95;
              if (vz > 0.95) vz = 0.95; else if (vz < -0.95) vz = -0.95;
              if (momOn) {
                // Solid walls (and the grid boundary) reflect the incoming
                // velocity component with damping — waves bounce, not vanish.
                if (vx > 0.001 && (x + 1 >= nx || solid[i + 1])) vx *= -REFL;
                else if (vx < -0.001 && (x < 1 || solid[i - 1])) vx *= -REFL;
                if (vz > 0.001 && (z + 1 >= nz || solid[i + nx])) vz *= -REFL;
                else if (vz < -0.001 && (z < 1 || solid[i - nx])) vz *= -REFL;
              }
              hvx[i] = vx; hvz[i] = vz;
            }
          }
          if (mass[i] > MINMASS) {
            if (x < wx0) wx0 = x; if (x > wx1) wx1 = x;
            if (y < wy0) wy0 = y; if (y > wy1) wy1 = y;
            if (z < wz0) wz0 = z; if (z > wz1) wz1 = z;
          }
        }
      }
    }
    bx0 = wx0; bx1 = wx1; by0 = wy0; by1 = wy1; bz0 = wz0; bz1 = wz1;

    // The box floor sits in true void under the island (minSolidY-6): water
    // that reaches the bottom layer has fallen off the world and leaves it.
    {
      const zb0 = Math.max(0, bz0), zb1 = Math.min(nz - 1, bz1);
      for (let z = zb0; z <= zb1; z++) {
        const zb = z * nx;
        for (let x = Math.max(0, bx0); x <= Math.min(nx - 1, bx1); x++) {
          const i = zb + x;
          if (!solid[i] && mass[i] > 0) { outAcc += mass[i]; outTotal += mass[i]; mass[i] = 0; }
        }
      }
    }
  }

  // A cell turned solid (dam/build): its water is displaced, tracked in the
  // ledger so conservation stays exact. Opened cells need nothing — water
  // levels into them on the next steps.
  function onCellSolidified(i: number) {
    if (mass[i] > 0) { displacedAcc += mass[i]; outTotal += mass[i]; mass[i] = 0; }
  }

  /* ══════════════════════ renderer (cell space) ══════════════════════ */
  const GX = nx + 1, GY = ny + 1, GZ = nz + 1, G = GX * GY * GZ;
  const raw = new Float32Array(S), dens = new Float32Array(S), cfoam = new Float32Array(S), cdepth = new Float32Array(S);
  const flowx = new Float32Array(S), flowz = new Float32Array(S);
  const sdens = new Float32Array(S);
  const corner = new Float32Array(G), cornerFoam = new Float32Array(G), cornerDepth = new Float32Array(G);
  const cornerFx = new Float32Array(G), cornerFz = new Float32Array(G);
  corner.fill(ISO);
  let volume = 0, wetCount = 0;

  // Render box: grows to cover everywhere water has been (so dens/sdens/foam
  // keep decaying after water leaves a region), shrinks only on drain-all.
  let vx0 = sx0, vx1 = sx0, vy0 = sy0, vy1 = sy0, vz0 = sz0, vz1 = sz0;

  /* surface-nets tables (Lysenko) */
  const cubeEdges = new Int32Array(24), edgeTable = new Int32Array(256);
  {
    let k = 0;
    for (let i = 0; i < 8; i++) for (let j = 1; j <= 4; j <<= 1) { const p = i ^ j; if (i <= p) { cubeEdges[k++] = i; cubeEdges[k++] = p; } }
    for (let i = 0; i < 256; i++) {
      let em = 0;
      for (let j = 0; j < 24; j += 2) {
        const a = !!(i & (1 << cubeEdges[j])), b = !!(i & (1 << cubeEdges[j + 1]));
        em |= a !== b ? 1 << (j >> 1) : 0;
      }
      edgeTable[i] = em;
    }
  }

  const MAXV = 90000;
  const wPos = new Float32Array(MAXV * 3), wNor = new Float32Array(MAXV * 3), wFoam = new Float32Array(MAXV), wDep = new Float32Array(MAXV);
  const wFlow = new Float32Array(MAXV * 2);
  const wIdx = new Uint32Array(MAXV * 18);
  const snBuf = new Int32Array(GX * GY * 2);
  const wGeo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(wPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aNor = new THREE.BufferAttribute(wNor, 3).setUsage(THREE.DynamicDrawUsage);
  const aFoam = new THREE.BufferAttribute(wFoam, 1).setUsage(THREE.DynamicDrawUsage);
  const aDep = new THREE.BufferAttribute(wDep, 1).setUsage(THREE.DynamicDrawUsage);
  const aFlow = new THREE.BufferAttribute(wFlow, 2).setUsage(THREE.DynamicDrawUsage);
  const aIdx = new THREE.BufferAttribute(wIdx, 1).setUsage(THREE.DynamicDrawUsage);
  wGeo.setAttribute("position", aPos);
  wGeo.setAttribute("normal", aNor);
  wGeo.setAttribute("foam", aFoam);
  wGeo.setAttribute("depth", aDep);
  wGeo.setAttribute("flow", aFlow);
  wGeo.setIndex(aIdx);
  wGeo.setDrawRange(0, 0);

  // Opaque scene → RT (color + depth) for refraction; blit + water on top.
  const sceneDepth = new THREE.DepthTexture(2, 2);
  sceneDepth.type = THREE.UnsignedIntType;
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
    depthTexture: sceneDepth, depthBuffer: true, stencilBuffer: false,
  });
  const blitMat = new THREE.MeshBasicMaterial({ map: sceneRT.texture, depthTest: false, depthWrite: false });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
  const blitScene = new THREE.Scene();
  blitScene.add(blitQuad);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // Shared by all water materials: the water pass renders after clearDepth(),
  // so terrain occlusion must be tested manually against sceneDepth.
  const resVec = new THREE.Vector2(2, 2);
  const OCC_GLSL = `
    uniform sampler2D tDepth; uniform vec2 resolution;
    uniform float cameraNear; uniform float cameraFar;
    #include <packing>
    float sceneViewZ(vec2 uv){ return perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    bool occluded(float viewZ){ return viewZ < sceneViewZ(gl_FragCoord.xy / resolution) - 0.02; }
  `;
  const occUniforms = () => ({
    tDepth: { value: sceneDepth }, resolution: { value: resVec },
    cameraNear: { value: 0.5 }, cameraFar: { value: 400 },
  });

  // Patterns (uv/noise/rings) read CELL-space coords (vCell) so terrace's
  // tuning holds at any world scale; lighting reads world-space normal/view.
  const WATER_VS = `
    attribute float foam; attribute float depth; attribute vec2 flow;
    varying vec3 vWorld; varying vec3 vCell; varying vec3 vN; varying float vFoam; varying float vDepth; varying vec2 vFlow; varying float vViewZ;
    void main(){
      vCell = position;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      vFoam = foam; vDepth = depth; vFlow = flow;
      vec4 mvPosition = viewMatrix * wp;
      vViewZ = mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;
    }`;
  const WATER_FS = `
    uniform float time; uniform vec3 sunDir; uniform vec3 sunColor;
    uniform vec3 shallow; uniform vec3 deep; uniform vec3 skyZenith; uniform vec3 skyHorizon; uniform vec3 foamColor;
    uniform vec3 impacts[8];
    uniform sampler2D tScene; uniform sampler2D tDepth; uniform vec2 resolution;
    uniform float cameraNear; uniform float cameraFar; uniform vec3 voidColor;
    varying vec3 vWorld; varying vec3 vCell; varying vec3 vN; varying float vFoam; varying float vDepth; varying vec2 vFlow; varying float vViewZ;
    #include <packing>
    float sceneViewZ(vec2 uv){ return perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    vec3 sceneColor(vec2 uv){ vec4 c = texture2D(tScene, uv); return mix(voidColor, c.rgb, c.a); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
      return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
    }
    void main(){
      if(vViewZ < sceneViewZ(gl_FragCoord.xy / resolution) - 0.02) discard;
      vec3 N = normalize(vN);
      if(!gl_FrontFacing) N = -N;
      float foam = clamp(vFoam, 0.0, 1.0);
      float calm = clamp(N.y,0.0,1.0) * (1.0 - foam);
      vec2 uv = vCell.xz;
      float n1 = noise(uv*1.9 + vec2(time*0.31, time*0.19));
      float n2 = noise(uv*3.3 - vec2(time*0.24, -time*0.29));
      vec3 dN = vec3(n1-0.5, 0.0, n2-0.5) * 0.11;
      float fmag = length(vFlow);
      if(fmag > 0.02){
        vec2 fd = vFlow / fmag;
        vec2 p = vec2(dot(uv, fd), dot(uv, vec2(-fd.y, fd.x)));
        float st = noise(vec2(p.x*1.1 - time*(2.0 + 5.0*fmag), p.y*6.0)) - 0.5;
        dN += vec3(fd.x, 0.0, fd.y) * st * 0.28 * min(1.0, fmag*1.5);
      }
      for(int k=0;k<8;k++){
        vec3 im = impacts[k];
        if(im.z <= 0.001) continue;
        vec2 dv = uv - im.xy;
        float dd = length(dv);
        if(dd < 0.05 || dd > 7.0) continue;
        float ring = sin(dd*5.5 - time*10.0) * exp(-dd*0.75) * im.z;
        dN += vec3(dv.x, 0.0, dv.y) / dd * ring * 0.22;
      }
      N = normalize(N + dN * calm);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = max(dot(N,V), 0.0);
      float fres = 0.04 + 0.96*pow(1.0-ndv, 4.0);
      vec3 R = reflect(-V, N);
      vec3 sky = mix(skyHorizon, skyZenith, clamp(R.y*0.85+0.15, 0.0, 1.0));
      float ndl = max(dot(N, sunDir), 0.0);
      vec3 Hh = normalize(sunDir + V);
      float ndh = max(dot(N,Hh),0.0);
      float spec = pow(ndh, 180.0)*1.5 + pow(ndh, 22.0)*0.22;
      /* screen-space refraction of whatever is behind this surface */
      vec2 suv = gl_FragCoord.xy / resolution;
      float thick = max(0.0, vViewZ - sceneViewZ(suv));
      vec3 nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
      vec2 ruv = suv + nv.xy * 0.045 * clamp(thick, 0.15, 2.5);
      ruv = clamp(ruv, vec2(0.002), vec2(0.998));
      float rz = sceneViewZ(ruv);
      if(rz > vViewZ + 0.02) ruv = suv;
      float rth = max(0.0, vViewZ - rz);
      /* thickness is in WORLD units; absorption is tuned per CELL of water */
      float rthC = rth / uCell;
      vec3 floorCol = sceneColor(ruv);
      vec3 absorbed = floorCol * exp(-vec3(0.30, 0.12, 0.05) * rthC * 1.1);
      vec3 scatter = mix(shallow, deep, clamp(rthC*0.32, 0.0, 1.0)) * (0.62 + 0.38*ndl);
      vec3 under = mix(absorbed, scatter, max(0.28, 1.0 - exp(-rthC*0.30)));
      vec3 col = mix(under, sky, fres*0.7) + sunColor*spec;
      float fn = noise(uv*3.2 + vec2(time*0.5, -time*0.7))*0.6 + noise(uv*7.0 - vec2(time*0.9, time*0.4))*0.4;
      foam = smoothstep(0.30, 0.95, foam * (0.55 + 0.9*fn)) * 0.9;
      col = mix(col, foamColor, foam);
      float alpha = 0.55 + 0.42*smoothstep(0.0, 0.6, thick / uCell);
      gl_FragColor = vec4(col, alpha);
    }`;
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      impacts: { value: [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3()) },
      tScene: { value: sceneRT.texture }, tDepth: { value: sceneDepth }, resolution: { value: resVec },
      cameraNear: { value: 0.5 }, cameraFar: { value: 400 }, voidColor: { value: new THREE.Color(0x0d1620) },
      uCell: { value: cellV },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(0xfff1dc) },
      shallow: { value: new THREE.Color(0x5fd3e6) },
      deep: { value: new THREE.Color(0x0f5a92) },
      skyZenith: { value: new THREE.Color(0x8ccbe9) },
      skyHorizon: { value: new THREE.Color(0x6f9dbb) },
      foamColor: { value: new THREE.Color(0xf3fbff) },
    },
    vertexShader: WATER_VS,
    fragmentShader: "uniform float uCell;\n" + WATER_FS,
    transparent: true, depthWrite: true, side: THREE.DoubleSide,
  });
  const water = new THREE.Mesh(wGeo, waterMat);
  water.frustumCulled = false;
  water.renderOrder = 1;

  /* falling water: ribbons tracing the actual fall paths */
  const MAXRV = 24000;
  const rPos = new Float32Array(MAXRV * 3), rUv = new Float32Array(MAXRV * 2), rInfo = new Float32Array(MAXRV * 3);
  const rIdx = new Uint32Array(MAXRV * 3);
  const rGeo = new THREE.BufferGeometry();
  const aRPos = new THREE.BufferAttribute(rPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aRUv = new THREE.BufferAttribute(rUv, 2).setUsage(THREE.DynamicDrawUsage);
  const aRInfo = new THREE.BufferAttribute(rInfo, 3).setUsage(THREE.DynamicDrawUsage);
  const aRIdx = new THREE.BufferAttribute(rIdx, 1).setUsage(THREE.DynamicDrawUsage);
  rGeo.setAttribute("position", aRPos);
  rGeo.setAttribute("uv", aRUv);
  rGeo.setAttribute("info", aRInfo);
  rGeo.setIndex(aRIdx);
  rGeo.setDrawRange(0, 0);
  const ribbonMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, foamColor: { value: new THREE.Color(0xf4fcff) }, tint: { value: new THREE.Color(0x8fd2e4) }, ...occUniforms() },
    vertexShader: `
      attribute vec3 info;
      varying vec2 vUv; varying vec3 vInfo; varying vec3 vCell; varying float vViewZ;
      void main(){
        vUv=uv; vInfo=info; vCell=position;
        vec4 mv = viewMatrix*modelMatrix*vec4(position,1.0);
        vViewZ = mv.z;
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: OCC_GLSL + `
      uniform float time; uniform vec3 foamColor; uniform vec3 tint;
      varying vec2 vUv; varying vec3 vInfo; varying vec3 vCell; varying float vViewZ;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      void main(){
        if(occluded(vViewZ)) discard;
        float t=vInfo.x, fall=vInfo.y;
        float u=vUv.x;
        float edge = smoothstep(0.0,0.24,u)*smoothstep(1.0,0.76,u);
        float v = vUv.y*1.7 + time*9.5;
        float across = vCell.x*1.9 + vCell.z*1.3;
        float n1 = noise(vec2(across, v));
        float n2 = noise(vec2(across*2.7 + 7.0, v*1.9 + 4.0));
        float streak = n1*0.65 + n2*0.35;
        float cut = mix(0.58, 0.12, t);
        float body = smoothstep(cut, cut+0.26, streak + 0.12*t);
        float white = clamp(0.22 + 0.5*streak + fall*0.10, 0.0, 1.0);
        float lip = smoothstep(0.0, 0.25, fall);
        vec3 col = mix(tint, foamColor, white);
        float a = edge * body * lip * (0.30 + 0.55*t);
        if(a < 0.012) discard;
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const streams = new THREE.Mesh(rGeo, ribbonMat);
  streams.frustumCulled = false;
  streams.renderOrder = 2;

  /* spray points */
  const MAXP = 1800;
  const pPos = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP);
  const pVel = new Float32Array(MAXP * 3), pAge = new Float32Array(MAXP), pMax = new Float32Array(MAXP), pFloor = new Float32Array(MAXP);
  let pCount = 0;
  const pGeo = new THREE.BufferGeometry();
  const aPPos = new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aPLife = new THREE.BufferAttribute(pLife, 1).setUsage(THREE.DynamicDrawUsage);
  pGeo.setAttribute("position", aPPos);
  pGeo.setAttribute("life", aPLife);
  pGeo.setDrawRange(0, 0);
  const sprayMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0xeafaff) }, pr: { value: 1 }, uCell: { value: cellV }, ...occUniforms() },
    vertexShader: `
      attribute float life; varying float vLife; varying float vViewZ; uniform float pr; uniform float uCell;
      void main(){ vLife=life; vec4 mv=modelViewMatrix*vec4(position,1.0); vViewZ=mv.z; gl_Position=projectionMatrix*mv;
        gl_PointSize = (0.05 + 0.09*life) * 1500.0 * uCell * pr / max(uCell,-mv.z); }`,
    fragmentShader: OCC_GLSL + `
      uniform vec3 color; varying float vLife; varying float vViewZ;
      void main(){ if(occluded(vViewZ)) discard;
        vec2 p=gl_PointCoord-0.5; float d=length(p);
        float a=smoothstep(0.5,0.12,d)*(1.0-vLife)*(1.0-vLife)*0.8; if(a<0.01) discard;
        gl_FragColor=vec4(color,a); }`,
    transparent: true, depthWrite: false,
  });
  const spray = new THREE.Points(pGeo, sprayMat);
  spray.frustumCulled = false;
  spray.renderOrder = 3;

  /* ballistic droplet points — the simulated airborne water parcels, drawn in
     the same soft blurred-spray language as the mist (the arc lives in the
     simulated trajectory, not the sprite shape) */
  const dGeo = new THREE.BufferGeometry();
  const aDPos = new THREE.BufferAttribute(dPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aDVel = new THREE.BufferAttribute(dVel, 3).setUsage(THREE.DynamicDrawUsage);
  dGeo.setAttribute("position", aDPos);
  dGeo.setAttribute("velocity", aDVel);
  dGeo.setDrawRange(0, 0);
  const dropMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0xeafaff) }, pr: { value: 1 }, uCell: { value: cellV }, ...occUniforms() },
    vertexShader: `
      attribute vec3 velocity; varying float vViewZ; varying float vSeed;
      uniform float pr; uniform float uCell;
      void main(){
        vec4 mv=modelViewMatrix*vec4(position,1.0); vViewZ=mv.z; gl_Position=projectionMatrix*mv;
        vSeed=fract(sin(dot(position.xz,vec2(12.9898,78.233)))*43758.5453);
        gl_PointSize = (0.09 + 0.07*vSeed) * 1500.0 * uCell * pr / max(uCell,-mv.z);
      }`,
    fragmentShader: OCC_GLSL + `
      uniform vec3 color; varying float vViewZ; varying float vSeed;
      void main(){ if(occluded(vViewZ)) discard;
        vec2 p=gl_PointCoord-0.5; float d=length(p);
        float a=smoothstep(0.5,0.10,d)*(0.45+0.25*vSeed);
        if(a<0.01) discard;
        gl_FragColor=vec4(color,a); }`,
    transparent: true, depthWrite: false,
  });
  const dropPts = new THREE.Points(dGeo, dropMat);
  dropPts.frustumCulled = false;
  dropPts.renderOrder = 3;

  const group = new THREE.Group();
  group.scale.setScalar(cellV);
  group.position.set(off.x * cellV, off.y * cellV, off.z * cellV);
  group.add(water);
  group.add(streams);
  group.add(spray);
  group.add(dropPts);
  const waterScene = new THREE.Scene();
  waterScene.add(group);

  function spawnSpray(x: number, y: number, z: number, strength: number, n: number) {
    for (let k = 0; k < n && pCount < MAXP; k++) {
      const j = pCount++;
      const ang = Math.random() * 6.2832, sp = (0.8 + Math.random() * 2.2) * (0.5 + strength);
      pPos[j * 3] = x + (Math.random() - 0.5) * 0.6;
      pPos[j * 3 + 1] = y + 0.05;
      pPos[j * 3 + 2] = z + (Math.random() - 0.5) * 0.6;
      pVel[j * 3] = Math.cos(ang) * sp;
      pVel[j * 3 + 1] = 2.0 + Math.random() * 3.5 * (0.4 + strength);
      pVel[j * 3 + 2] = Math.sin(ang) * sp;
      pAge[j] = 0; pMax[j] = 0.35 + Math.random() * 0.5; pFloor[j] = y - 0.15;
    }
  }
  function updateSpray(dt: number) {
    let j = 0;
    while (j < pCount) {
      pAge[j] += dt;
      pVel[j * 3 + 1] -= 9.5 * dt;
      pPos[j * 3] += pVel[j * 3] * dt;
      pPos[j * 3 + 1] += pVel[j * 3 + 1] * dt;
      pPos[j * 3 + 2] += pVel[j * 3 + 2] * dt;
      if (pAge[j] >= pMax[j] || pPos[j * 3 + 1] < pFloor[j]) {
        const l = --pCount;
        pPos[j * 3] = pPos[l * 3]; pPos[j * 3 + 1] = pPos[l * 3 + 1]; pPos[j * 3 + 2] = pPos[l * 3 + 2];
        pVel[j * 3] = pVel[l * 3]; pVel[j * 3 + 1] = pVel[l * 3 + 1]; pVel[j * 3 + 2] = pVel[l * 3 + 2];
        pAge[j] = pAge[l]; pMax[j] = pMax[l]; pFloor[j] = pFloor[l];
        continue;
      }
      pLife[j] = pAge[j] / pMax[j];
      j++;
    }
    aPPos.needsUpdate = true;
    aPLife.needsUpdate = true;
    pGeo.setDrawRange(0, pCount);
  }

  const impacts: Array<{ x: number; z: number; t: number }> = [];
  const used = new Uint8Array(S);
  let streamCount = 0;
  const impStr = new Float32Array(8);
  const gridV = new Float32Array(8);

  function sampleCorner(px: number, py: number, pz: number) {
    let x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
    if (x0 < 0) x0 = 0; else if (x0 > GX - 2) x0 = GX - 2;
    if (y0 < 0) y0 = 0; else if (y0 > GY - 2) y0 = GY - 2;
    if (z0 < 0) z0 = 0; else if (z0 > GZ - 2) z0 = GZ - 2;
    const fx = Math.min(1, Math.max(0, px - x0)), fy = Math.min(1, Math.max(0, py - y0)), fz = Math.min(1, Math.max(0, pz - z0));
    const b = x0 + GX * (y0 + GY * z0), sy = GX, sz2 = GX * GY;
    const c00 = corner[b] + (corner[b + 1] - corner[b]) * fx;
    const c10 = corner[b + sy] + (corner[b + sy + 1] - corner[b + sy]) * fx;
    const c01 = corner[b + sz2] + (corner[b + sz2 + 1] - corner[b + sz2]) * fx;
    const c11 = corner[b + sz2 + sy] + (corner[b + sz2 + sy + 1] - corner[b + sz2 + sy]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  }

  // camera position in CELL space (for camera-facing ribbon strips)
  const camCell = { x: 0, z: 0 };

  function updateWater(dt: number) {
    // Grow the render box to the current wet extent (+2 for smoothing halo).
    vx0 = Math.max(0, Math.min(vx0, bx0 - 2)); vx1 = Math.min(nx - 1, Math.max(vx1, bx1 + 2));
    vy0 = Math.max(0, Math.min(vy0, by0 - 2)); vy1 = Math.min(ny - 1, Math.max(vy1, by1 + 2));
    vz0 = Math.max(0, Math.min(vz0, bz0 - 2)); vz1 = Math.min(nz - 1, Math.max(vz1, bz1 + 2));

    /* 1. classify: resting water feeds the isosurface, free fall becomes streams */
    let vol = 0, wet = 0;
    for (let z = vz0; z <= vz1; z++) for (let x = vx0; x <= vx1; x++) {
      let run = 0;
      for (let y = vy0; y <= vy1; y++) {
        const i = y * LAYER + z * nx + x;
        if (solid[i]) { raw[i] = 0; cdepth[i] = 0; run = 0; continue; }
        const m = mass[i];
        if (m <= 0.0012) { raw[i] = 0; cdepth[i] = 0; run = 0; continue; }
        if (y > 0 && !solid[i - LAYER] && dflow[i] > 0.5 * m) { raw[i] = -m; run = 0; cdepth[i] = 0; vol += m; wet++; continue; }
        if (m <= 0.04) { raw[i] = 0; cdepth[i] = 0; run = 0; if (m > VIS) { vol += m; wet++; } continue; }
        vol += m; wet++;
        // Presence floor: a cell that passed the film cutoff holds real water,
        // but a shallow apron (m 0.05-0.3) fed raw < ISO gets averaged away by
        // the corner lattice and the mesh retreats from the true shoreline.
        // Floor the iso density near ISO so wet-vs-dry sets the surface's
        // extent and m keeps setting its height only above the floor.
        raw[i] = m > 1.1 ? 1.1 : m < 0.45 ? 0.45 : m;
        if (m > 0.25) run++; else run = 0;
        cdepth[i] = run;
      }
    }
    volume = vol; wetCount = wet;

    /* 2. temporal smoothing of the fields */
    const k = Math.min(1, dt * 13), kf = Math.min(1, dt * 9), ks = Math.min(1, dt * 18);
    let nx0 = nx, nx1 = -1, ny0 = ny, ny1 = -1, nz0v = nz, nz1 = -1;
    for (let y = vy0; y <= vy1; y++) {
      const yb = y * LAYER;
      for (let z = vz0; z <= vz1; z++) {
        const zb = yb + z * nx;
        for (let x = vx0; x <= vx1; x++) {
          const i = zb + x;
          const r = raw[i];
          const ri = r > 0 ? r : 0, rs = r < 0 ? -r : 0;
          let d = dens[i]; d += (ri - d) * k; if (d < 0.002) d = 0; dens[i] = d;
          let sd = sdens[i]; sd += (rs - sd) * ks; if (sd < 0.0008) sd = 0; sdens[i] = sd;
          const up = i + LAYER;
          const landing = y < ny - 1 && dflow[up] > 0.5 * mass[up] + 0.0005 ? dflow[up] : 0;
          let nb = 0;
          if (x > 0) nb += cfoam[i - 1];
          if (x < nx - 1) nb += cfoam[i + 1];
          if (z > 0) nb += cfoam[i - nx];
          if (z < nz - 1) nb += cfoam[i + nx];
          const tf = Math.min(1, landing * 28 + nb * 0.21);
          let f = cfoam[i]; f += (tf - f) * kf; if (f < 0.004) f = 0; cfoam[i] = f;
          let vx = flowx[i]; vx += (fvx[i] - vx) * kf; flowx[i] = vx;
          let vz2 = flowz[i]; vz2 += (fvz[i] - vz2) * kf; flowz[i] = vz2;
          if (d > 0) {
            if (x < nx0) nx0 = x; if (x > nx1) nx1 = x;
            if (y < ny0) ny0 = y; if (y > ny1) ny1 = y;
            if (z < nz0v) nz0v = z; if (z > nz1) nz1 = z;
          }
        }
      }
    }

    /* 3. falls: trace each fall along its actual path, merge touching falls into sheets */
    {
      let nv = 0, ni = 0, nrib = 0;
      impacts.length = 0;
      const cpx = camCell.x, cpz = camCell.z;
      const THR = 0.0015;
      used.fill(0);
      type FallPath = {
        x: number; y: number; z: number; cells: number[]; n: number; t: number;
        lipx: number; lipz: number; lm: number; onWater: boolean; ysurf: number;
        lx: number; lz: number; ly: number; g: number;
      };
      const paths: FallPath[] = [];
      const topMap = new Map<number, FallPath>();
      for (let y = vy1; y >= Math.max(1, vy0); y--) {
        for (let z = vz0; z <= vz1; z++) {
          for (let x = vx0; x <= vx1; x++) {
            const i0 = y * LAYER + z * nx + x;
            if (sdens[i0] < THR || used[i0]) continue;
            const cells: number[] = [];
            let px = x, pz = z, pi = i0, tsum = 0;
            while (true) {
              cells.push(pi); used[pi] = 1; tsum += sdens[pi];
              const py = (pi / LAYER) | 0;
              if (py === 0) break;
              const bi = pi - LAYER;
              let nxt = -1, qx = px, qz = pz;
              const vx = hvx[pi], vz = hvz[pi], ax = Math.abs(vx), az = Math.abs(vz);
              if (Math.max(ax, az) > 0.12) {
                const kk = ax >= az ? (vx > 0 ? 1 : 0) : vz > 0 ? 3 : 2;
                const cx2 = px + DX[kk], cz2 = pz + DZ[kk];
                if (cx2 >= 0 && cz2 >= 0 && cx2 < nx && cz2 < nz) {
                  const dj = bi + DOFF[kk];
                  if (sdens[dj] >= THR && !used[dj] && sdens[dj] >= sdens[bi] * 0.6) { nxt = dj; qx = cx2; qz = cz2; }
                }
              }
              if (nxt < 0 && sdens[bi] >= THR && !used[bi]) nxt = bi;
              if (nxt < 0) break;
              pi = nxt; px = qx; pz = qz;
            }
            const n = cells.length;
            const last = cells[n - 1], ly2 = (last / LAYER) | 0, lr = last - ly2 * LAYER, lz = (lr / nx) | 0, lxc = lr - lz * nx;
            const bi = last - LAYER;
            let onWater = false, ysurf = ly2;
            if (ly2 > 0 && !solid[bi] && mass[bi] > 0.03) { onWater = true; ysurf = ly2 - 1 + Math.min(1, Math.max(0.1, mass[bi])); }
            let lipx = -1, lipz = -1, lscore = -1e9, lm = 0;
            for (let kk = 0; kk < 4; kk++) {
              const qx = x + DX[kk], qz = z + DZ[kk];
              if (qx < 0 || qz < 0 || qx >= nx || qz >= nz) continue;
              const j = i0 + DOFF[kk];
              if (solid[j] || mass[j] < 0.01) continue;
              if (!(solid[j - LAYER] || mass[j - LAYER] >= 0.5)) continue;
              const sc = -(flowx[j] * DX[kk] + flowz[j] * DZ[kk]) + mass[j] * 0.02;
              if (sc > lscore) { lscore = sc; lipx = qx; lipz = qz; lm = mass[j]; }
            }
            const P: FallPath = {
              x, y, z, cells, n, t: Math.min(1, tsum / n / ribNorm),
              lipx, lipz, lm, onWater, ysurf, lx: lxc, lz, ly: ly2, g: -1,
            };
            paths.push(P);
            topMap.set(i0, P);
          }
        }
      }
      const cxz = (P: FallPath, kk: number): [number, number] => {
        let sx = 0, sz = 0, c = 0;
        for (let q = kk - 1; q <= kk + 1; q++) {
          const qq = Math.max(0, Math.min(P.n - 1, q));
          const id = P.cells[qq], yy = (id / LAYER) | 0, rr = id - yy * LAYER, zz = (rr / nx) | 0;
          sz += zz + 0.5; sx += rr - zz * nx + 0.5; c++;
        }
        return [sx / c, sz / c];
      };
      const groups: FallPath[][] = [];
      for (let a = 0; a < paths.length; a++) {
        const P = paths[a];
        if (P.g >= 0) continue;
        const Grp = [P];
        P.g = groups.length;
        const stack = [P];
        while (stack.length) {
          const Q = stack.pop()!;
          const qi = Q.y * LAYER + Q.z * nx + Q.x;
          for (let kk = 0; kk < 4; kk++) {
            const qx = Q.x + DX[kk], qz = Q.z + DZ[kk];
            if (qx < 0 || qz < 0 || qx >= nx || qz >= nz) continue;
            const R = topMap.get(qi + DOFF[kk]);
            if (R && R.g < 0) { R.g = P.g; Grp.push(R); stack.push(R); }
          }
        }
        groups.push(Grp);
      }
      for (let gi = 0; gi < groups.length; gi++) {
        const Grp = groups[gi];
        let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, maxN = 0, tsum = 0, ys = 0, lipCount = 0, hsum = 0;
        for (const P of Grp) {
          minx = Math.min(minx, P.x); maxx = Math.max(maxx, P.x);
          minz = Math.min(minz, P.z); maxz = Math.max(maxz, P.z);
          maxN = Math.max(maxN, P.n); tsum += P.t; ys += P.ysurf;
          if (P.lipx >= 0) { lipCount++; hsum += P.y + Math.min(0.95, Math.max(0.12, P.lm)); }
        }
        const tG = tsum / Grp.length, ysurfG = ys / Grp.length;
        const sheet = Grp.length > 1;
        const axisX = maxx - minx >= maxz - minz;
        const hasLip = lipCount > 0;
        const h = hasLip ? hsum / lipCount : Grp[0].y + 0.6;
        const rows = (hasLip ? 3 : 1) + maxN + 1;
        if (nv + rows * 2 > MAXRV || ni + (rows - 1) * 6 > rIdx.length) continue;
        const base = nv;
        let r = 0;
        const row = (qx: number, qy: number, qz: number, axx: number, azz: number, hw: number, t: number, fall: number, along: number) => {
          const o = nv * 3;
          rPos[o] = qx - axx * hw; rPos[o + 1] = qy; rPos[o + 2] = qz - azz * hw;
          rPos[o + 3] = qx + axx * hw; rPos[o + 4] = qy; rPos[o + 5] = qz + azz * hw;
          rUv[nv * 2] = 0; rUv[nv * 2 + 1] = along; rUv[nv * 2 + 2] = 1; rUv[nv * 2 + 3] = along;
          rInfo[o] = t; rInfo[o + 1] = fall; rInfo[o + 2] = 0;
          rInfo[o + 3] = t; rInfo[o + 4] = fall; rInfo[o + 5] = 0;
          nv += 2;
          if (r > 0) { const a = base + (r - 1) * 2, b = base + r * 2; rIdx[ni++] = a; rIdx[ni++] = b; rIdx[ni++] = a + 1; rIdx[ni++] = a + 1; rIdx[ni++] = b; rIdx[ni++] = b + 1; }
          r++;
        };
        const span = (pts: Array<[number, number, number]>): [number, number, number] => {
          let lo = 1e9, hi = -1e9, os = 0;
          for (const q of pts) { const a = axisX ? q[0] : q[1]; lo = Math.min(lo, a - q[2]); hi = Math.max(hi, a + q[2]); os += axisX ? q[1] : q[0]; }
          const c = (lo + hi) * 0.5, o = os / pts.length;
          return axisX ? [c, o, (hi - lo) * 0.5] : [o, c, (hi - lo) * 0.5];
        };
        const axv: [number, number] = axisX ? [1, 0] : [0, 1];
        const rightOf = (qx: number, qz: number): [number, number] => {
          if (sheet) return axv;
          let dx = qx - cpx, dz = qz - cpz;
          const dl = Math.sqrt(dx * dx + dz * dz) || 1;
          return [-dz / dl, dx / dl];
        };
        const hwOf = (t: number, fall: number, flare: number) => (0.06 + 0.44 * Math.pow(t, 0.7)) * (1 + 0.22 * Math.min(1, fall / 4)) * flare;
        const tops: Array<[number, number, number]> = [];
        for (const P of Grp) { const c = cxz(P, 0); tops.push([c[0], c[1], sheet ? 0.5 : hwOf(P.t, 0, 1)]); }
        const top = span(tops);
        if (hasLip) {
          const lips: Array<[number, number, number]> = [];
          for (const P of Grp) if (P.lipx >= 0) lips.push([P.lipx + 0.5, P.lipz + 0.5, sheet ? 0.5 : 0.22 + 0.30 * P.t]);
          const L = span(lips);
          let ddx = top[0] - L[0], ddz = top[1] - L[1];
          const dl2 = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
          ddx /= dl2; ddz /= dl2;
          const pv = sheet ? axv : [-ddz, ddx];
          row(L[0], h, L[1], pv[0], pv[1], sheet ? L[2] : 0.22 + 0.30 * tG, tG, 0.4, h + 1.0);
          row((L[0] + top[0]) * 0.5, h, (L[1] + top[1]) * 0.5, pv[0], pv[1], sheet ? (L[2] + top[2]) * 0.5 : 0.22 + 0.30 * tG, tG, 0.6, h + 0.5);
          row(top[0], h - 0.08, top[1], pv[0], pv[1], sheet ? top[2] : (0.22 + 0.30 * tG) * 1.05, tG, 0.9, h);
        } else {
          const rr = rightOf(top[0], top[1]);
          row(top[0], h, top[1], rr[0], rr[1], sheet ? top[2] : hwOf(tG, 0, 1), tG, 0.4, h);
        }
        let lastPts: [number, number, number] | null = null;
        for (let kk = 0; kk < maxN; kk++) {
          const pts: Array<[number, number, number]> = [];
          let ry = 0, ts = 0;
          for (const P of Grp) {
            if (kk >= P.n) continue;
            const c = cxz(P, kk);
            const t = tG * 0.75 + Math.min(1, sdens[P.cells[kk]] / ribNorm) * 0.25;
            pts.push([c[0], c[1], hwOf(t, 1 + kk, kk === P.n - 1 ? 1.18 : 1.0)]);
            ts += t;
            ry = (P.cells[kk] / LAYER) | 0;
          }
          if (!pts.length) break;
          const sp = span(pts);
          const rr = rightOf(sp[0], sp[1]);
          row(sp[0], ry, sp[1], rr[0], rr[1], sp[2], ts / pts.length, 1 + kk, ry);
          lastPts = sp;
        }
        if (!lastPts) lastPts = top;
        const rl = rightOf(lastPts[0], lastPts[1]);
        row(lastPts[0], ysurfG - 0.3, lastPts[1], rl[0], rl[1], lastPts[2] * 1.2, tG, maxN + 1, ysurfG - 0.3);
        nrib++;
        if (sheet && nv + (maxN + 2) * 2 <= MAXRV && ni + (maxN + 1) * 6 <= rIdx.length) {
          // camera-facing centre strip keeps a sheet visible viewed edge-on
          const base2 = nv;
          r = 0;
          const row2 = (qx: number, qy: number, qz: number, hw: number, t: number, fall: number, along: number) => {
            let dx = qx - cpx, dz = qz - cpz;
            const dl = Math.sqrt(dx * dx + dz * dz) || 1;
            const axx = -dz / dl, azz = dx / dl;
            const o = nv * 3;
            rPos[o] = qx - axx * hw; rPos[o + 1] = qy; rPos[o + 2] = qz - azz * hw;
            rPos[o + 3] = qx + axx * hw; rPos[o + 4] = qy; rPos[o + 5] = qz + azz * hw;
            rUv[nv * 2] = 0; rUv[nv * 2 + 1] = along; rUv[nv * 2 + 2] = 1; rUv[nv * 2 + 3] = along;
            rInfo[o] = t; rInfo[o + 1] = fall; rInfo[o + 2] = 0; rInfo[o + 3] = t; rInfo[o + 4] = fall; rInfo[o + 5] = 0;
            nv += 2;
            if (r > 0) { const a = base2 + (r - 1) * 2, b = base2 + r * 2; rIdx[ni++] = a; rIdx[ni++] = b; rIdx[ni++] = a + 1; rIdx[ni++] = a + 1; rIdx[ni++] = b; rIdx[ni++] = b + 1; }
            r++;
          };
          row2(top[0], h - 0.08, top[1], hwOf(tG, 0, 1), tG, 0.9, h);
          for (let kk = 0; kk < maxN; kk++) {
            const pts: Array<[number, number]> = [];
            let ry = 0;
            for (const P of Grp) { if (kk >= P.n) continue; const c = cxz(P, kk); pts.push([c[0], c[1]]); ry = (P.cells[kk] / LAYER) | 0; }
            if (!pts.length) break;
            let sxm = 0, szm = 0;
            for (const q of pts) { sxm += q[0]; szm += q[1]; }
            row2(sxm / pts.length, ry, szm / pts.length, hwOf(tG, 1 + kk, 1.0), tG, 1 + kk, ry);
          }
          row2(lastPts[0], ysurfG - 0.3, lastPts[1], hwOf(tG, maxN + 1, 1.3), tG, maxN + 1, ysurfG - 0.3);
        }
        for (const P of Grp) {
          if (P.ly > 0 && P.t > 0.08) {
            if (P.onWater) impacts.push({ x: P.lx + 0.5, z: P.lz + 0.5, t: P.t });
            const rate = P.t * (P.onWater ? 70 : 30) * dt;
            spawnSpray(P.lx + 0.5, P.onWater ? P.ysurf + 0.05 : P.ly, P.lz + 0.5, P.t, Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0));
          }
        }
      }
      aRPos.needsUpdate = aRUv.needsUpdate = aRInfo.needsUpdate = aRIdx.needsUpdate = true;
      rGeo.setDrawRange(0, ni);
      streamCount = nrib;
      impacts.sort((a, b) => b.t - a.t);
      const U = waterMat.uniforms.impacts.value;
      for (let kk = 0; kk < 8; kk++) {
        const im = impacts[kk];
        const target = im ? im.t : 0;
        impStr[kk] += (target - impStr[kk]) * Math.min(1, dt * 6);
        if (im) { U[kk].x = im.x; U[kk].y = im.z; }
        U[kk].z = impStr[kk];
      }
      updateSpray(dt);
    }

    if (nx1 < 0) { wGeo.setDrawRange(0, 0); return; }
    const ax0 = Math.max(0, nx0 - 1), ax1 = Math.min(nx - 1, nx1 + 1);
    const ay0 = Math.max(0, ny0 - 1), ay1 = Math.min(ny - 1, ny1 + 1);
    const az0 = Math.max(0, nz0v - 1), az1 = Math.min(nz - 1, nz1 + 1);

    /* 4. corner lattice: mean of the non-solid cells touching each corner */
    const ccz1 = Math.min(GZ - 1, az1 + 2), ccy1 = Math.min(GY - 1, ay1 + 2), ccx1 = Math.min(GX - 1, ax1 + 2);
    for (let cz = az0; cz <= ccz1; cz++) {
      for (let cy = ay0; cy <= ccy1; cy++) {
        for (let cx = ax0; cx <= ccx1; cx++) {
          let s = 0, fs = 0, ds = 0, c = 0, c2 = 0, qx = 0, qz = 0;
          for (let z = cz - 1; z <= cz; z++) {
            if (z < 0 || z >= nz) continue;
            for (let y = cy - 1; y <= cy; y++) {
              if (y < 0 || y >= ny) continue;
              const b = y * LAYER + z * nx;
              for (let x = cx - 1; x <= cx; x++) {
                if (x < 0 || x >= nx) continue;
                const i = b + x;
                if (solid[i]) {
                  // the bed of a pool is part of the water body; bare rock is not
                  if (y + 1 < ny && !solid[i + LAYER] && dens[i + LAYER] > 0.03) { s += 1; c++; }
                  continue;
                }
                // Shore-aware weighting: air votes at 1/3 the weight of wet
                // cells so a thin shoreline strip isn't averaged below ISO by
                // its dry neighbours (which made lone puddle cells invisible
                // and pulled the mesh a cell back from every true shore).
                const d = dens[i];
                if (d > 0.02) { s += d; c++; } else c += AIR_W;
                fs += cfoam[i]; ds += cdepth[i]; qx += flowx[i]; qz += flowz[i]; c2++;
              }
            }
          }
          const ci = cx + GX * (cy + GY * cz);
          corner[ci] = c ? ISO - s / c : ISO;
          if (c2) { cornerFoam[ci] = fs / c2; cornerDepth[ci] = ds / c2; cornerFx[ci] = qx / c2; cornerFz[ci] = qz / c2; }
          else { cornerFoam[ci] = 0; cornerDepth[ci] = 0; cornerFx[ci] = 0; cornerFz[ci] = 0; }
        }
      }
    }

    /* 5. surface nets over lattice cells inside the box */
    let nv = 0, ni = 0;
    const SL = GX * GY;
    const cx0 = ax0, cx1 = Math.min(GX - 2, ax1 + 1), cy0 = ay0, cy1 = Math.min(GY - 2, ay1 + 1), cz0 = az0, cz1 = Math.min(GZ - 2, az1 + 1);
    for (let cz = cz0; cz <= cz1; cz++) {
      const bo = (cz & 1) * SL, bp = ((cz + 1) & 1) * SL;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          let mask = 0, g = 0, fsum = 0, dsum = 0, qxs = 0, qzs = 0;
          for (let kk = 0; kk < 2; kk++) for (let jj = 0; jj < 2; jj++) for (let ii = 0; ii < 2; ii++) {
            const ci = cx + ii + GX * (cy + jj + GY * (cz + kk));
            const pv = corner[ci];
            gridV[g] = pv;
            if (pv < 0) mask |= 1 << g;
            g++;
            fsum += cornerFoam[ci]; dsum += cornerDepth[ci]; qxs += cornerFx[ci]; qzs += cornerFz[ci];
          }
          if (mask === 0 || mask === 255) continue;
          const em = edgeTable[mask];
          let vx = 0, vy = 0, vz = 0, ec = 0;
          for (let e = 0; e < 12; e++) {
            if (!(em & (1 << e))) continue;
            const e0 = cubeEdges[e << 1], e1 = cubeEdges[(e << 1) + 1];
            const g0 = gridV[e0], g1 = gridV[e1];
            let t = g0 - g1;
            if (Math.abs(t) > 1e-6) t = g0 / t; else continue;
            ec++;
            let a = e0 & 1, b = e1 & 1;
            vx += a !== b ? (a ? 1 - t : t) : a ? 1 : 0;
            a = e0 & 2; b = e1 & 2;
            vy += a !== b ? (a ? 1 - t : t) : a ? 1 : 0;
            a = e0 & 4; b = e1 & 4;
            vz += a !== b ? (a ? 1 - t : t) : a ? 1 : 0;
          }
          if (ec === 0 || nv >= MAXV) continue;
          const sc = 1 / ec;
          const px = cx + vx * sc, py = cy + vy * sc, pz = cz + vz * sc;
          const vi = nv++;
          wPos[vi * 3] = px; wPos[vi * 3 + 1] = py; wPos[vi * 3 + 2] = pz;
          const hh = 0.5;
          let gx = sampleCorner(px + hh, py, pz) - sampleCorner(px - hh, py, pz);
          let gy = sampleCorner(px, py + hh, pz) - sampleCorner(px, py - hh, pz);
          let gz = sampleCorner(px, py, pz + hh) - sampleCorner(px, py, pz - hh);
          let gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (gl < 1e-6) { gx = 0; gy = 1; gz = 0; gl = 1; }
          wNor[vi * 3] = gx / gl; wNor[vi * 3 + 1] = gy / gl; wNor[vi * 3 + 2] = gz / gl;
          wFoam[vi] = fsum * 0.125;
          wDep[vi] = Math.min(1, dsum * 0.125 / 4.0);
          wFlow[vi * 2] = Math.max(-1, Math.min(1, qxs * 0.125 * 30));
          wFlow[vi * 2 + 1] = Math.max(-1, Math.min(1, qzs * 0.125 * 30));
          snBuf[bo + cx + GX * cy] = vi;

          if (ni + 18 > wIdx.length) continue;
          for (let ax = 0; ax < 3; ax++) {
            if (!(em & (1 << ax))) continue;
            let v1: number, v2: number, v3: number;
            if (ax === 0) {
              if (cy <= cy0 || cz <= cz0) continue;
              v1 = snBuf[bo + cx + GX * (cy - 1)]; v2 = snBuf[bp + cx + GX * (cy - 1)]; v3 = snBuf[bp + cx + GX * cy];
            } else if (ax === 1) {
              if (cz <= cz0 || cx <= cx0) continue;
              v1 = snBuf[bp + cx + GX * cy]; v2 = snBuf[bp + (cx - 1) + GX * cy]; v3 = snBuf[bo + (cx - 1) + GX * cy];
            } else {
              if (cx <= cx0 || cy <= cy0) continue;
              v1 = snBuf[bo + (cx - 1) + GX * cy]; v2 = snBuf[bo + (cx - 1) + GX * (cy - 1)]; v3 = snBuf[bo + cx + GX * (cy - 1)];
            }
            if (mask & 1) {
              wIdx[ni++] = vi; wIdx[ni++] = v1; wIdx[ni++] = v2;
              wIdx[ni++] = vi; wIdx[ni++] = v2; wIdx[ni++] = v3;
            } else {
              wIdx[ni++] = vi; wIdx[ni++] = v3; wIdx[ni++] = v2;
              wIdx[ni++] = vi; wIdx[ni++] = v2; wIdx[ni++] = v1;
            }
          }
        }
      }
    }
    aPos.needsUpdate = aNor.needsUpdate = aFoam.needsUpdate = aDep.needsUpdate = aFlow.needsUpdate = aIdx.needsUpdate = true;
    wGeo.setDrawRange(0, ni);
  }

  /* ══════════════════════ frame ══════════════════════ */
  let warmLeft = Math.max(0, opts.warmSteps);
  let stepAcc = 0;
  let lastMs = 0;
  const prevClearCol = new THREE.Color();
  const fallbackClear = new THREE.Color(0x9db8cf);
  let w = 2, hgt = 2;

  function resize(pw: number, ph: number) {
    const pr = renderer.getPixelRatio();
    w = Math.max(2, Math.round(pw * pr));
    hgt = Math.max(2, Math.round(ph * pr));
    sceneRT.setSize(w, hgt);
    resVec.set(w, hgt);
  }

  function frame(scene: any, camera: any, sunDir: any, key: any, hemiCol: any, fogCol: any) {
    const now = performance.now();
    const dt = lastMs > 0 ? Math.min(0.1, (now - lastMs) / 1000) : 1 / 60;
    lastMs = now;

    let n = 0;
    if (warmLeft > 0) { n = Math.min(45, warmLeft); warmLeft -= n; }
    else {
      stepAcc += dt * STEP_HZ;
      n = Math.min(5, Math.floor(stepAcc));
      stepAcc -= n;
    }
    const t0 = performance.now();
    for (let s = 0; s < n; s++) step();
    // Droplets integrate over the same span of sim time the steps advanced.
    if (n > 0) stepDroplets(n / STEP_HZ);
    const simMs = performance.now() - t0;
    aDPos.needsUpdate = true;
    aDVel.needsUpdate = true;
    dGeo.setDrawRange(0, dCount);

    camCell.x = camera.position.x / cellV - off.x;
    camCell.z = camera.position.z / cellV - off.z;
    updateWater(dt);

    const t = now / 1000;
    waterMat.uniforms.time.value = t;
    ribbonMat.uniforms.time.value = t;
    waterMat.uniforms.sunDir.value.copy(sunDir);
    waterMat.uniforms.sunColor.value.copy(key.color);
    waterMat.uniforms.skyZenith.value.copy(hemiCol);
    if (fogCol) waterMat.uniforms.skyHorizon.value.copy(fogCol);
    waterMat.uniforms.cameraNear.value = camera.near;
    waterMat.uniforms.cameraFar.value = camera.far;
    ribbonMat.uniforms.cameraNear.value = camera.near;
    ribbonMat.uniforms.cameraFar.value = camera.far;
    sprayMat.uniforms.cameraNear.value = camera.near;
    sprayMat.uniforms.cameraFar.value = camera.far;
    dropMat.uniforms.cameraNear.value = camera.near;
    dropMat.uniforms.cameraFar.value = camera.far;
    dropMat.uniforms.pr.value = renderer.getPixelRatio();
    if (fogCol) waterMat.uniforms.voidColor.value.copy(fogCol);
    sprayMat.uniforms.pr.value = renderer.getPixelRatio();

    // scene → RT (color + depth), blit, water on top (hifi's clear discipline)
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(prevClearCol);
    const prevClearA = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(fogCol ?? fallbackClear, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.clear(true, true, true);
    renderer.render(blitScene, fsCam);
    renderer.clearDepth();
    renderer.render(waterScene, camera);
    renderer.setClearColor(prevClearCol, prevClearA);
    renderer.autoClear = prevAuto;
    return { simMs, steps: n };
  }

  // Column spans of standing/falling water (box cell coords) for the
  // moisture consumer. m > 0.03 matches the render "onWater" threshold.
  function columnSpans(): Map<number, { lo: number; hi: number }> {
    const spans = new Map<number, { lo: number; hi: number }>();
    for (let z = Math.max(0, bz0); z <= Math.min(nz - 1, bz1); z++) {
      for (let x = Math.max(0, bx0); x <= Math.min(nx - 1, bx1); x++) {
        let lo = -1, hi = -1;
        for (let y = Math.max(0, by0); y <= Math.min(ny - 1, by1); y++) {
          if (mass[y * LAYER + z * nx + x] > 0.03) {
            if (lo < 0) lo = y;
            hi = y;
          }
        }
        if (lo >= 0) spans.set(z * nx + x, { lo, hi });
      }
    }
    return spans;
  }

  function drainAll() {
    mass.fill(0); nmass.fill(0); flux.fill(0); dflow.fill(0); hvx.fill(0); hvz.fill(0);
    pCount = 0;
    dCount = 0; dAcc.clear(); airAcc = 0; airFly = 0;
  }

  function stats() {
    const flushIn = inAcc, flushOut = outAcc;
    inAcc = 0; outAcc = 0;
    let vsum = 0, vmax = 0, vn = 0;
    for (let y = Math.max(0, by0); y <= Math.min(ny - 1, by1); y++) {
      const yb = y * LAYER;
      for (let z = Math.max(0, bz0); z <= Math.min(nz - 1, bz1); z++) {
        const zb = yb + z * nx;
        for (let x = Math.max(0, bx0); x <= Math.min(nx - 1, bx1); x++) {
          const i = zb + x;
          if (mass[i] <= MINMASS) continue;
          const s2 = hvx[i] * hvx[i] + hvz[i] * hvz[i];
          vsum += Math.sqrt(s2);
          if (s2 > vmax) vmax = s2;
          vn++;
        }
      }
    }
    const airborne = airAcc + airFly;
    return {
      // Airborne mass is still live water — the ledger stays exact.
      volume: volume + airborne, wetCount, streams: streamCount, spray: pCount,
      droplets: { on: dropsOn, count: dCount, airborne: Math.round(airborne * 1000) / 1000 },
      momentum: {
        on: momOn,
        meanV: vn ? Math.round((vsum / vn) * 10000) / 10000 : 0,
        maxV: Math.round(Math.sqrt(vmax) * 1000) / 1000,
        movingCells: vn,
      },
      inRate: flushIn, outRate: flushOut,
      emitted: inTotal, drained: outTotal, displaced: displacedAcc,
      warmLeft, springOn, springRate,
      box: { x0: bx0, x1: bx1, y0: by0, y1: by1, z0: bz0, z1: bz1 },
      tris: (wGeo.drawRange.count / 3) | 0,
    };
  }

  function knob(o: any = {}) {
    if (o.springRate !== undefined) springRate = Math.max(0, Number(o.springRate) || 0);
    if (o.running !== undefined) springOn = !!o.running;
    if (o.drain) drainAll();
    if (o.warm !== undefined) warmLeft += Math.max(0, Number(o.warm) | 0);
    if (o.ribNorm !== undefined && Number(o.ribNorm) > 0) ribNorm = Number(o.ribNorm);
    if (o.momentum !== undefined) momOn = !!o.momentum;
    if (o.droplets !== undefined) dropsOn = !!o.droplets;
  }

  function dispose() {
    wGeo.dispose(); waterMat.dispose();
    rGeo.dispose(); ribbonMat.dispose();
    pGeo.dispose(); sprayMat.dispose();
    dGeo.dispose(); dropMat.dispose();
    blitQuad.geometry.dispose(); blitMat.dispose();
    sceneRT.dispose();
  }

  return {
    frame, resize, stats, knob, dispose, columnSpans, onCellSolidified, drainAll,
    massAt: (i: number) => mass[i],
    get warmLeft() { return warmLeft; },
  };
}
