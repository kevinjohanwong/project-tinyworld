import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { voxelize } from "/home/workspace/project-tinyworld/tools/scan-siting/voxelizer.mjs";

const WID = process.argv[2];
const ROOT = "/home/workspace/project-tinyworld";
const db = new Database(ROOT + "/data/tinyworld.db");
const row = db.query("SELECT payload, resolution FROM world_blocks WHERE world_id=?").get(WID);
if (!row) throw new Error("no world_blocks for " + WID);
const oldMeta = (JSON.parse(row.payload).meta) || {};

const gpath = db.query("SELECT path FROM glb_uploads WHERE world_id=?").get(WID);
if (!gpath) throw new Error("no glb for " + WID);
const glb = readFileSync(gpath.path);
const buf = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
const r = await voxelize(buf, { season: oldMeta.weatherSeason || "summer", modifiers: { snowLayers: 0, dryGrassPct: 0, isRaining: false } });

const b64 = (ab) => ab ? Buffer.from(new Uint8Array(ab)).toString("base64") : "";
const layers = {};
for (const [k, v] of Object.entries(r.layers || {})) { if (k === "ground") continue; layers[k] = b64(v); }

const meta = { ...oldMeta };
meta.voxel = r.voxel; meta.span = r.span; meta.centerX = r.centerX; meta.centerZ = r.centerZ;
meta.latentCols = b64(r.latentCols); meta.latentTotal = r.latentTotal || 0; meta.latentLayer = r.latentLayer || "dirt";
meta.blockCount = r.visibleCount; meta.weatherSeason = r.weatherSeason || meta.weatherSeason || "summer";
meta.savedAt = Date.now(); meta.revoxelizedAt = Date.now();
// clear finalize + tree + player-state so plant_trees runs fresh and no stale gameplay lingers
for (const k of ["treesUpgraded","treeUpgradeVersion","treeRecords","vegetation","finalizedLayers","finalizedLayerVersion","blockCounts","finalizedBlockCount","latentGround","waterSupport","canonicalFinalization","superTree","spring","playerState","ledger","knowledgeLibrary","builtStructures","voidState","clock","structuralGrass","latentSpent","latentUsed","chunk4","sentinelAnchor"]) delete meta[k];

const payload = { layers, meta };
db.query("UPDATE world_blocks SET payload=?, block_count=?, resolution=?, updated_at=? WHERE world_id=?")
  .run(JSON.stringify(payload), meta.blockCount, row.resolution, Date.now(), WID);
const counts = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v ? Buffer.from(v, "base64").length / 12 : 0]));
console.log("WROTE base payload for", WID, "blockCount", meta.blockCount);
console.log("layer cells:", JSON.stringify(counts));
db.close();
