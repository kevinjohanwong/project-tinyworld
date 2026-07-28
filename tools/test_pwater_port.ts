// Particle-water port guard: the pwater solver must stay BIT-IDENTICAL to the
// sandbox solver on a scenario run (the port adds custom-terrain injection and
// all-open drains without touching scenario physics), and a custom terrain
// with open:"all" must hold the exact mass ledger.
// Run: bun tools/test_pwater_port.ts
import { createSim as simSandbox, setParticleScale as spA } from "/home/workspace/water-sim-sandbox/src/sim/particles";
import { createSim as simPort, createSimFromTerrain, setParticleScale as spB } from "../src/pwater/particles";

const opts = { emitRate: 45, viscosity: 0.23, sleep: true, evaporation: true };
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

spA(0.7); spB(0.7);
const a = simSandbox("basin-spill");
const b = simPort("basin-spill");
for (let i = 0; i < 600; i++) { a.step(1 / 60, opts); b.step(1 / 60, opts); }
let same = a.count === b.count;
if (same) for (let i = 0; i < a.count * 3; i++) if (a.pos[i] !== b.pos[i]) { same = false; break; }
check("scenario parity bit-identical (600 ticks, KJ settings)", same, `counts ${a.count}/${b.count}`);
check("sandbox ledger exact", a.report().error === 0);
check("port ledger exact", b.report().error === 0);

const t = b.terrain;
const c = createSimFromTerrain({ nx: t.nx, ny: t.ny, nz: t.nz, solid: t.solid.slice(), source: t.source, basin: t.basin, rimY: t.rimY, open: "all" });
for (let i = 0; i < 600; i++) c.step(1 / 60, opts);
const rc = c.report();
check("custom terrain runs + exact ledger", rc.error === 0 && rc.count > 0, JSON.stringify(rc));
check("sleep engages on custom terrain", rc.asleep > 0, `asleep ${rc.asleep}`);

// all-open drain: tiny floating platform — everything emitted must eventually
// drain off the sides/bottom rather than pile against invisible walls.
const nx = 12, ny = 8, nz = 12;
const solid = new Uint8Array(nx * ny * nz);
for (let z = 5; z < 7; z++) for (let x = 5; x < 7; x++) solid[(0 * nz + z) * nx + x] = 1;
const d = createSimFromTerrain({ nx, ny, nz, solid, source: [6, 3, 6], basin: { x0: 0, x1: 4, z0: 0, z1: 4 }, rimY: 4, open: "all" });
for (let i = 0; i < 1200; i++) d.step(1 / 60, { ...opts, emitRate: 60 });
const rd = d.report();
check("all-open drain culls runoff (no wall pile-up)", rd.drained > rd.count, `drained ${rd.drained} vs held ${rd.count}`);
check("open-drain ledger exact", rd.error === 0);

console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
