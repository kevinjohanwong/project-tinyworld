// Drive the REAL TinyWorld voxelizer (extracted live worker) on a GLB file and
// emit an app-format payload JSON. Encoding mirrors revoxel-one.mjs exactly.
//   bun tools/scan-siting/glb-to-world.mjs <glb-path> <out-payload.json> [season]
import { readFileSync, writeFileSync } from "node:fs";
import { voxelize } from "/home/workspace/project-tinyworld/tools/scan-siting/voxelizer.mjs";

const [glbPath, outPath, season = "summer"] = process.argv.slice(2);
if (!glbPath || !outPath) throw new Error("usage: glb-to-world.mjs <glb> <out.json> [season]");

const glb = readFileSync(glbPath);
const buf = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
const r = await voxelize(buf, { season, modifiers: { snowLayers: 0, dryGrassPct: 0, isRaining: false } });
if (!r || !r.ok) throw new Error("voxelize failed: " + (r && r.error));

const b64 = (ab) => (ab ? Buffer.from(new Uint8Array(ab)).toString("base64") : "");
const layers = {};
for (const [k, v] of Object.entries(r.layers || {})) { if (k === "ground") continue; layers[k] = b64(v); }

// resolution = footprint extent in voxels (x/z span), matching other tools.
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
const counts = {};
for (const [k, s] of Object.entries(layers)) {
  const raw = Buffer.from(s, "base64");
  counts[k] = raw.length / 12;
  for (let i = 0; i < raw.length; i += 12) {
    const x = raw.readInt32LE(i), y = raw.readInt32LE(i + 4), z = raw.readInt32LE(i + 8);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
}
const resolution = Math.max(maxX - minX, maxZ - minZ) || 0;

const meta = {
  voxel: r.voxel, span: r.span, centerX: r.centerX, centerZ: r.centerZ,
  latentCols: b64(r.latentCols), latentTotal: r.latentTotal || 0, latentLayer: r.latentLayer || "dirt",
  blockCount: r.visibleCount, resolution, weatherSeason: r.weatherSeason || season,
  savedAt: Date.now(),
  inferredFrom: { source: "tinyworld-live-worker-voxelizer", model: "tw-staging-core WORKER_CODE via extract-voxelizer" },
};
writeFileSync(outPath, JSON.stringify({ layers, meta }));
console.log(JSON.stringify({
  out: outPath, blockCount: meta.blockCount, resolution,
  voxel: +r.voxel.toFixed(4), span: +r.span.toFixed(3),
  yRange: [minY, maxY], yTall: maxY - minY, layers: counts,
}, null, 2));
