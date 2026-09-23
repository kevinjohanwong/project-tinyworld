// Bake a hero SUPER TREE into an existing world payload (trunks/leaves layers),
// placed at the island's central summit and grown to full size. Uses the same
// TinyWorld tree generator the app uses (src/trees buildTree "supertree"), so
// it looks native. Non-destructive: only appends wood/leaf voxels + meta.superTree.
//   bun tools/scan-siting/bake-super-tree.mjs <world_id> [cap] [seed]
import { Database } from "bun:sqlite";
import { buildTree } from "/home/workspace/project-tinyworld/src/trees/index.ts";

const WID = process.argv[2];
const CAP = Math.max(32, Number(process.argv[3]) || 200);
const SEED = Number(process.argv[4]) || 1337;
if (!WID) throw new Error("usage: bake-super-tree.mjs <world_id> [cap] [seed]");

const ROOT = "/home/workspace/project-tinyworld";
const db = new Database(ROOT + "/data/tinyworld.db");
const row = db.query("SELECT payload, resolution FROM world_blocks WHERE world_id=?").get(WID);
if (!row) throw new Error("no world_blocks for " + WID);
const payload = JSON.parse(row.payload);
const layers = payload.layers || {};
const meta = payload.meta || (payload.meta = {});

const dec = (b64) => {
  const raw = Buffer.from(b64 || "", "base64");
  const out = [];
  for (let i = 0; i < raw.length; i += 12)
    out.push([raw.readInt32LE(i), raw.readInt32LE(i + 4), raw.readInt32LE(i + 8)]);
  return out;
};
const enc = (arr) => {
  const b = Buffer.alloc(arr.length * 12);
  arr.forEach((p, i) => { b.writeInt32LE(p[0], i * 12); b.writeInt32LE(p[1], i * 12 + 4); b.writeInt32LE(p[2], i * 12 + 8); });
  return b.toString("base64");
};

// ── Build a solid oracle + top-surface map from the world's blocks. ──
const SURFACE = ["grass", "dryGrass", "dirt", "snow", "wet"];
const STRUCTURE = ["wall", "ceiling"];
const solid = new Set();          // all visible solid voxels (canopy deflects around these)
const topY = new Map();           // (x,z) -> highest surface/structure voxel y
for (const [name, b64] of Object.entries(layers)) {
  if (name === "ground" || name.startsWith("hidden_")) continue;
  const isSurfaceOrStruct = SURFACE.includes(name) || STRUCTURE.includes(name) || name.startsWith("pal_");
  for (const [x, y, z] of dec(b64)) {
    solid.add(x + "," + y + "," + z);
    if (isSurfaceOrStruct) {
      const k = x + "," + z;
      const prev = topY.get(k);
      if (prev === undefined || y > prev) topY.set(k, y);
    }
  }
}
if (!topY.size) throw new Error("no surface voxels found to place the tree on");

// ── Central summit: (x,z) centroid of the footprint, then the highest column
//    within a small radius of it (the peak in the middle). ──
let sx = 0, sz = 0;
for (const k of topY.keys()) { const [x, z] = k.split(",").map(Number); sx += x; sz += z; }
const cx = Math.round(sx / topY.size), cz = Math.round(sz / topY.size);
let best = null;
for (const [k, y] of topY) {
  const [x, z] = k.split(",").map(Number);
  const d = Math.hypot(x - cx, z - cz);
  if (d > 28) continue;                      // stay near the middle
  const score = y - d * 0.15;                // highest, tie-break toward center
  if (!best || score > best.score) best = { x, y, z, score };
}
if (!best) best = { x: cx, y: topY.get(cx + "," + cz) ?? 0, z: cz };
const origin = { x: best.x, y: best.y, z: best.z };
console.log(`[super] footprint centroid (${cx},${cz}) -> summit origin (${origin.x},${origin.y},${origin.z})`);

// Solid oracle in tree-local coords (origin-relative). Only ABOVE the base is
// solid so roots can dive underground; canopy climbs/deflects around structure.
const isSolid = (p) => {
  const wy = Math.round(origin.y + p.y);
  if (wy <= origin.y) return false;
  return solid.has(Math.round(origin.x + p.x) + "," + wy + "," + Math.round(origin.z + p.z));
};

// ── Grow the super tree, fully matured. ──
const nowMs = Date.now();
const plantedAtMs = nowMs - 120 * 24 * 60 * 60 * 1000; // 120 days => growthFraction ~1
const built = buildTree(
  { type: "supertree", seed: SEED, plantedAtMs, cap: CAP },
  { nowMs, isSolid, occupied: (x, y, z) => isSolid({ x, y, z }) },
);

const trunks = dec(layers.trunks);
const leaves = dec(layers.leaves);
let wood = 0, leaf = 0;
const seenW = new Set(trunks.map((p) => p.join(","))), seenL = new Set();
for (const vox of built.voxels) {
  const w = [origin.x + vox.x, origin.y + vox.y, origin.z + vox.z];
  const key = w.join(",");
  if (vox.kind === "wood") { if (!seenW.has(key)) { seenW.add(key); trunks.push(w); wood++; } }
  else { if (!seenL.has(key)) { seenL.add(key); leaves.push(w); leaf++; } }
}

layers.trunks = enc(trunks);
layers.leaves = enc(leaves);
meta.superTree = { version: 2, plantedAtMs, cap: CAP, seed: SEED, origin };
meta.blockCount = (Number(meta.blockCount) || 0) + wood + leaf;
meta.savedAt = nowMs;

// backup then write
const bdir = ROOT + "/data/backups";
Bun.spawnSync(["mkdir", "-p", bdir]);
Bun.write(`${bdir}/world_blocks_backup_${WID}_supertree_${Math.floor(nowMs / 1000)}.json`, row.payload);
db.query("UPDATE world_blocks SET payload=?, block_count=?, updated_at=? WHERE world_id=?")
  .run(JSON.stringify(payload), meta.blockCount, nowMs, WID);
db.close();

const ys = built.voxels.map((v) => origin.y + v.y);
console.log(JSON.stringify({
  world_id: WID, cap: CAP, seed: SEED, origin,
  added: { wood, leaf }, treeYRange: [Math.min(...ys), Math.max(...ys)],
  treeHeight: Math.max(...ys) - origin.y, newBlockCount: meta.blockCount,
}, null, 2));
