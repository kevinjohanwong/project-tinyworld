#!/usr/bin/env python3
"""CPU-only isometric voxel renderer for TinyWorld debug/verification.

Reads a world's block payload (from the SQLite DB or a payload JSON), decodes
the base64 Int32Array layers, culls occluded interior voxels, and rasterizes a
back-to-front isometric diorama with numpy + PIL. No browser, no GPU, no
esm.sh -- so it handles 200K+ block worlds that wedge the headless renderer.

It renders GEOMETRY + PALETTE (hills, trees, walls, density, layer placement),
which is where nearly every recent bug has lived. It does NOT reproduce the
live beauty pass (tilt-shift / bloom / soft shadows) -- that still needs a real
device.

Usage:
  python3 tools/render_world.py --db data/tinyworld.db --world w_glb_mqv04joc -o /tmp/w.png
  python3 tools/render_world.py --json data/revoxel-payloads-hills/hills_xxx.json -o /tmp/w.png
  python3 tools/render_world.py --db data/tinyworld.db --world w_glb_mqv04joc --view top -o /tmp/top.png
"""
import argparse, base64, json, os, sqlite3, sys, time
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Production colors, mirrored from src/tinyworld-route.tsx PAL + stoneMesh(0x6e7178).
COLORS = {
    "grass":       (0x4f, 0x8f, 0x3a),
    "dryGrass":    (0x9a, 0xa0, 0x4b),
    "dirt":        (0x5c, 0x43, 0x27),
    "hidden_dirt": (0x5c, 0x43, 0x27),
    "wall":        (0x9a, 0x8c, 0x7c),
    "ceiling":     (0xd8, 0xcc, 0xbc),
    "water":       (0x3a, 0xa6, 0xe0),
    "trunks":      (0x3a, 0x25, 0x10),
    "leaves":      (0x2d, 0x6b, 0x1f),
    "snow":        (0xee, 0xf5, 0xff),
    "wet":         (0x6a, 0x70, 0x79),
    "fruit":       (0xd2, 0x4a, 0x4a),
    "stone":       (0x6e, 0x71, 0x78),
}
DEFAULT_COLOR = (0xcc, 0x44, 0xcc)  # hot magenta = unmapped layer (loud on purpose)
BG = (0x10, 0x12, 0x18)

# Lower number = drawn first (under). Surface layers / canopy win on coord clashes.
LAYER_PRIORITY = ["hidden_dirt", "stone", "dirt", "wall", "ceiling",
                  "grass", "dryGrass", "snow", "wet", "water",
                  "trunks", "leaves", "fruit"]


def decode_layer(b64):
    raw = base64.b64decode(b64)
    arr = np.frombuffer(raw, dtype="<i4")
    if arr.size % 3 != 0:
        arr = arr[: arr.size - (arr.size % 3)]
    return arr.reshape(-1, 3)


def load_payload(args):
    if args.json:
        d = json.load(open(args.json))
        return d["layers"], d.get("meta", {}), os.path.basename(args.json)
    con = sqlite3.connect(args.db)
    row = con.execute(
        "SELECT payload, block_count, resolution FROM world_blocks WHERE world_id=?",
        (args.world,),
    ).fetchone()
    name_row = con.execute("SELECT name FROM worlds WHERE id=?", (args.world,)).fetchone()
    con.close()
    if not row:
        sys.exit(f"no world_blocks row for {args.world}")
    payload = json.loads(row[0])
    layers = payload.get("layers", payload)
    meta = payload.get("meta", {})
    meta.setdefault("blockCount", row[1])
    meta.setdefault("resolution", row[2])
    label = (name_row[0] if name_row else args.world) + f" [{args.world}]"
    return layers, meta, label


def build_voxels(layers):
    """Return (coords Nx3 int, color_idx N, palette list[(r,g,b)], counts dict)."""
    palette = []
    pal_index = {}
    occ = {}          # (x,y,z) -> color index of winning layer
    counts = {}
    # Assign in priority order so later (higher-priority) layers overwrite.
    present = [l for l in LAYER_PRIORITY if l in layers]
    present += [l for l in layers if l not in LAYER_PRIORITY]  # unknowns last
    for layer in present:
        b64 = layers[layer]
        if not b64:
            continue
        pts = decode_layer(b64)
        counts[layer] = len(pts)
        col = COLORS.get(layer, DEFAULT_COLOR)
        if col not in pal_index:
            pal_index[col] = len(palette)
            palette.append(col)
        ci = pal_index[col]
        for x, y, z in pts:
            occ[(int(x), int(y), int(z))] = ci
    return occ, palette, counts


def cull_surface(occ):
    """Keep only voxels with >=1 empty face-neighbor (surface shell)."""
    occ_set = occ.keys() if hasattr(occ, "keys") else occ
    keyset = set(occ.keys())
    nbr = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    surf = {}
    for (x, y, z), ci in occ.items():
        exposed = False
        for dx, dy, dz in nbr:
            if (x + dx, y + dy, z + dz) not in keyset:
                exposed = True
                break
        if exposed:
            surf[(x, y, z)] = ci
    return surf


def shade(rgb, f):
    return (int(rgb[0] * f), int(rgb[1] * f), int(rgb[2] * f))


def render(occ, palette, view, tile, out, label, meta, counts):
    coords = np.array(list(occ.keys()), dtype=np.int64)
    cidx = np.array(list(occ.values()), dtype=np.int64)
    minc = coords.min(axis=0)
    coords = coords - minc  # shift to non-negative
    xs, ys, zs = coords[:, 0], coords[:, 1], coords[:, 2]
    maxx, maxy, maxz = int(xs.max()), int(ys.max()), int(zs.max())

    hw = tile               # iso half-width (px)
    hh = tile / 2.0         # iso half-height (2:1)
    vh = tile               # voxel pixel height

    if view == "top":
        # straight top-down ortho: drop y, color by layer, height tint
        W = (maxx + 1) * 2 + 40
        H = (maxz + 1) * 2 + 40
        img = Image.new("RGB", (W, H), BG)
        px = img.load()
        # paint highest voxel per (x,z) column
        top = {}
        for i in range(len(coords)):
            x, y, z = int(xs[i]), int(ys[i]), int(zs[i])
            k = (x, z)
            if k not in top or y > top[k][0]:
                top[k] = (y, int(cidx[i]))
        for (x, z), (y, ci) in top.items():
            f = 0.55 + 0.45 * (y / max(1, maxy))
            r, g, b = shade(palette[ci], f)
            bx, bz = 20 + x * 2, 20 + z * 2
            for ox in range(2):
                for oz in range(2):
                    if 0 <= bx + ox < W and 0 <= bz + oz < H:
                        px[bx + ox, bz + oz] = (r, g, b)
    else:
        # isometric: camera from (+x,+y,+z)
        sx_min = (0 - maxz) * hw - hw
        sx_max = (maxx - 0) * hw + hw
        sy_min = (0 + 0) * hh - (maxy + 1) * vh
        sy_max = (maxx + maxz) * hh - 0 * vh
        pad = 24
        W = int(sx_max - sx_min) + pad * 2
        H = int(sy_max - sy_min) + pad * 2
        ox = -sx_min + pad
        oy = -sy_min + pad
        img = Image.new("RGB", (W, H), BG)
        draw = ImageDraw.Draw(img)

        def proj(px_, py_, pz_):
            return (ox + (px_ - pz_) * hw, oy + (px_ + pz_) * hh - py_ * vh)

        # painter's: far (small x+y+z) first
        order = np.argsort(xs + ys + zs)
        for i in order:
            x, y, z = int(xs[i]), int(ys[i]), int(zs[i])
            base = palette[int(cidx[i])]
            top_f = 1.0
            left_f = 0.74   # +z face
            right_f = 0.56  # +x face
            # top face (y+1)
            draw.polygon(
                [proj(x, y + 1, z), proj(x + 1, y + 1, z),
                 proj(x + 1, y + 1, z + 1), proj(x, y + 1, z + 1)],
                fill=shade(base, top_f),
            )
            # +x face (right)
            draw.polygon(
                [proj(x + 1, y, z), proj(x + 1, y + 1, z),
                 proj(x + 1, y + 1, z + 1), proj(x + 1, y, z + 1)],
                fill=shade(base, right_f),
            )
            # +z face (left)
            draw.polygon(
                [proj(x, y, z + 1), proj(x + 1, y, z + 1),
                 proj(x + 1, y + 1, z + 1), proj(x, y + 1, z + 1)],
                fill=shade(base, left_f),
            )

    # overlay caption
    draw = ImageDraw.Draw(img)
    cap = f"{label}  |  {meta.get('blockCount','?')} blocks  res={meta.get('resolution','?')}  view={view}"
    sub = "  ".join(f"{k}:{v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:8])
    draw.rectangle([0, 0, img.width, 34], fill=(0, 0, 0))
    draw.text((8, 4), cap, fill=(235, 235, 235))
    draw.text((8, 19), sub, fill=(150, 200, 150))
    img.save(out)
    return img.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/tinyworld.db")
    ap.add_argument("--world")
    ap.add_argument("--json")
    ap.add_argument("--view", choices=["iso", "top"], default="iso")
    ap.add_argument("--tile", type=float, default=4.0)
    ap.add_argument("-o", "--out", default="/tmp/world_render.png")
    args = ap.parse_args()
    if not args.world and not args.json:
        ap.error("need --world (with --db) or --json")

    t0 = time.time()
    layers, meta, label = load_payload(args)
    occ, palette, counts = build_voxels(layers)
    t1 = time.time()
    surf = cull_surface(occ)
    t2 = time.time()
    size = render(surf, palette, args.view, args.tile, args.out, label, meta, counts)
    t3 = time.time()
    print(f"world={label}")
    print(f"  layers={list(counts.keys())}")
    print(f"  total voxels={len(occ)}  surface={len(surf)}  ({100*len(surf)/max(1,len(occ)):.0f}%)")
    print(f"  decode+build {t1-t0:.1f}s  cull {t2-t1:.1f}s  raster {t3-t2:.1f}s  -> {args.out} {size}")


if __name__ == "__main__":
    main()
