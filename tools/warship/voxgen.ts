// Offline generator: Warship.vox -> src/tw-warship-vox.ts (packed void-ship blocks).
const buf = new DataView(await Bun.file(new URL("./Warship.vox", import.meta.url).pathname).arrayBuffer());
const td = new TextDecoder();
const tag = (o: number) => td.decode(new Uint8Array(buf.buffer, o, 4));
let size: [number, number, number] | null = null;
let vox: Uint8Array | null = null;
let nvox = 0;
let palette: Uint8Array | null = null;
function walk(offset: number, end: number) {
  let p = offset;
  while (p < end) {
    const id = tag(p);
    const contentLen = buf.getUint32(p + 4, true);
    const childLen = buf.getUint32(p + 8, true);
    const cs = p + 12;
    if (id === "SIZE" && !size) size = [buf.getUint32(cs, true), buf.getUint32(cs + 4, true), buf.getUint32(cs + 8, true)];
    else if (id === "XYZI" && !vox) { nvox = buf.getUint32(cs, true); vox = new Uint8Array(buf.buffer, cs + 4, nvox * 4); }
    else if (id === "RGBA") palette = new Uint8Array(buf.buffer, cs, 1024);
    if (childLen > 0) walk(cs + contentLen, cs + contentLen + childLen);
    p = cs + contentLen + childLen;
  }
}
walk(20, buf.byteLength);
if (!size || !vox || !palette) throw new Error("vox parse failed");
const [SX, SY, SZ] = size;

// Class map: 0/1 hull shades, 2 engine (blue), 3 running light (red), 4 white light.
const classOf = (ci: number): number => {
  const p = (ci - 1) * 4;
  const r = palette![p], g = palette![p + 1], b = palette![p + 2];
  if (b > 160 && r < 120) return 2;                    // blues -> engine glow
  if (r > 200 && g < 90 && b < 90) return 3;           // reds -> running lights
  if (r > 200 && g > 200 && b > 200) return 4;         // white -> bright light
  return r >= 110 ? 0 : 1;                             // grays: light / dark hull
};

// Full-res occupancy + class grids.
const idx = (x: number, y: number, z: number) => (z * SY + y) * SX + x;
const cls = new Int8Array(SX * SY * SZ).fill(-1);
for (let i = 0; i < nvox; i++) {
  const x = vox[i * 4], y = vox[i * 4 + 1], z = vox[i * 4 + 2], c = vox[i * 4 + 3];
  cls[idx(x, y, z)] = classOf(c);
}

// Downsample 2x: accents win, else majority hull shade.
const DX = Math.ceil(SX / 2), DY = Math.ceil(SY / 2), DZ = Math.ceil(SZ / 2);
const didx = (x: number, y: number, z: number) => (z * DY + y) * DX + x;
const dcls = new Int8Array(DX * DY * DZ).fill(-1);
for (let z = 0; z < DZ; z++) for (let y = 0; y < DY; y++) for (let x = 0; x < DX; x++) {
  const counts = [0, 0, 0, 0, 0];
  let filled = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const fx = x * 2 + dx, fy = y * 2 + dy, fz = z * 2 + dz;
    if (fx >= SX || fy >= SY || fz >= SZ) continue;
    const c = cls[idx(fx, fy, fz)];
    if (c >= 0) { counts[c]++; filled++; }
  }
  if (filled < 2) continue;                            // sparse corner: drop
  let c = counts[0] >= counts[1] ? 0 : 1;              // hull majority
  if (counts[4] > 0) c = 4; else if (counts[3] > 0) c = 3; else if (counts[2] > 0) c = 2;
  dcls[didx(x, y, z)] = c;
}

// Surface shell only (6-neighbor exposure) to cut instance count.
const has = (x: number, y: number, z: number) =>
  x >= 0 && y >= 0 && z >= 0 && x < DX && y < DY && z < DZ && dcls[didx(x, y, z)] >= 0;
const blocks: Array<[number, number, number, number]> = [];
for (let z = 0; z < DZ; z++) for (let y = 0; y < DY; y++) for (let x = 0; x < DX; x++) {
  const c = dcls[didx(x, y, z)];
  if (c < 0) continue;
  if (has(x + 1, y, z) && has(x - 1, y, z) && has(x, y + 1, z) && has(x, y - 1, z) && has(x, y, z + 1) && has(x, y, z - 1)) continue;
  blocks.push([x, y, z, c]);
}

// Prow detection: engines (class 2) cluster at the stern along vox Y (length).
let engY = 0, engN = 0;
for (const [, y, , c] of blocks.map((b) => [b[0], b[1], b[2], b[3]])) if (c === 2) { engY += y; engN++; }
const engineAtLowY = engN > 0 && engY / engN < DY / 2;
// three.js frame: length(voxY)->X with prow at +X, height(voxZ)->Y, width(voxX)->Z.
const packed: number[] = [];
for (const [x, y, z, c] of blocks) {
  const lx = engineAtLowY ? y : DY - 1 - y;            // stern (engines) at low X -> prow +X
  packed.push(lx, z, x, c);
}
const u8 = new Uint8Array(packed);
const b64 = Buffer.from(u8).toString("base64");
const counts = [0, 0, 0, 0, 0];
for (const b of blocks) counts[b[3]]++;
console.log(`blocks=${blocks.length} dims L=${DY} H=${DZ} W=${DX} classes=${counts.join(",")} engineAtLowY=${engineAtLowY}`);

const out = `// GENERATED from Warship.vox (MagicaVoxel, 34x75x20 @16.6k voxels), 2x
// downsampled to a ${blocks.length}-block surface shell. Axes are three.js ship
// frame: X = length with the PROW at +X (engines astern), Y = up, Z = beam.
// Classes: 0 hull-light, 1 hull-dark, 2 engine glow, 3 running light, 4 white light.
// Regenerate with project-tinyworld/tools/warship/voxgen.ts (see AGENTS.md "Void warship").
export const WARSHIP_DIMS = { length: ${DY}, height: ${DZ}, width: ${DX} };
const B64 = "${b64}";
export function warshipBlocks(): Array<{ x: number; y: number; z: number; c: number }> {
  const raw = atob(B64);
  const out: Array<{ x: number; y: number; z: number; c: number }> = [];
  for (let i = 0; i + 3 < raw.length; i += 4) {
    out.push({ x: raw.charCodeAt(i), y: raw.charCodeAt(i + 1), z: raw.charCodeAt(i + 2), c: raw.charCodeAt(i + 3) });
  }
  return out;
}
`;
await Bun.write("/__substrate/space/src/tw-warship-vox.ts", out);
console.log("wrote /__substrate/space/src/tw-warship-vox.ts", out.length, "chars");
