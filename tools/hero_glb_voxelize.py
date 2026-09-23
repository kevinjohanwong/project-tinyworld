#!/usr/bin/env python3
"""Hero-object voxelizer: rasterize a GLB's mesh surface into colored voxels.

Unlike glb_to_world_payload.py (terrain/city: synthesizes a floor + rolling
hills) and the interior-room staging worker (gravity-settle + floor/ceiling
snap), this does a PLAIN surface voxelization of a single free-standing object
(e.g. a floating castle). No floor plane, no terrain, no gravity settle, no
ceiling logic — the mesh becomes voxels, nothing else is invented.

Output matches the proven TinyWorld payload format: layers = {name: base64 of
flat little-endian int32 [x,y,z,...]}, colored voxels as pal_<rrggbb>, plus a
meta block. Inject with inject_payload_as_world.py.
"""
import argparse, base64, json, sys
from collections import defaultdict
import numpy as np
import trimesh


def load_concat(path):
    scene = trimesh.load(path, process=False)
    meshes = []
    if isinstance(scene, trimesh.Scene):
        for name, geom in scene.geometry.items():
            g = geom.copy()
            # bake node transform into vertices
            for node_name in scene.graph.nodes_geometry:
                _, gname = scene.graph[node_name]
                if gname == name:
                    T = scene.graph.get(node_name)[0]
                    g.apply_transform(T)
                    break
            meshes.append(g)
    else:
        meshes = [scene]
    return meshes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("out")
    ap.add_argument("--resolution", type=int, default=150,
                    help="target voxel divisions across the largest bbox dim")
    ap.add_argument("--samples-per-voxel", type=float, default=6.0)
    ap.add_argument("--palette", type=int, default=28, help="quantized color count")
    ap.add_argument("--quant", type=int, default=12,
                    help="color channel quantization step (smaller=more colors)")
    args = ap.parse_args()

    meshes = load_concat(args.glb)
    total_tris = sum(len(m.faces) for m in meshes)
    print(f"[hero] loaded {len(meshes)} mesh(es), {total_tris} triangles", file=sys.stderr)

    # global bbox over all meshes
    allmin = np.array([np.inf] * 3)
    allmax = np.array([-np.inf] * 3)
    for m in meshes:
        allmin = np.minimum(allmin, m.vertices.min(axis=0))
        allmax = np.maximum(allmax, m.vertices.max(axis=0))
    size = allmax - allmin
    span = float(size.max())
    voxel = span / args.resolution
    print(f"[hero] bbox size {size.round(3)} span {span:.3f} -> voxel {voxel:.4f}m", file=sys.stderr)

    centerX = float((allmin[0] + allmax[0]) / 2)
    centerZ = float((allmin[2] + allmax[2]) / 2)
    baseY = float(allmin[1])  # place object base at grid y=0

    # accumulate color per voxel
    color_sum = defaultdict(lambda: np.zeros(3, dtype=np.float64))
    color_n = defaultdict(int)

    for m in meshes:
        # Bake texture -> per-vertex colors up front so surface sampling can
        # interpolate color without needing the (PBR) material.image path.
        try:
            if hasattr(m.visual, "to_color"):
                m.visual = m.visual.to_color()
        except Exception as e:
            print(f"[hero] to_color failed ({e})", file=sys.stderr)
        area = float(m.area)
        n = max(1000, int(area / (voxel * voxel) * args.samples_per_voxel))
        n = min(n, 6_000_000)
        try:
            pts, fidx, colors = trimesh.sample.sample_surface(m, n, sample_color=True)
        except Exception as e:
            print(f"[hero] color sample failed ({e}); falling back to grey", file=sys.stderr)
            pts, fidx = trimesh.sample.sample_surface(m, n)
            colors = np.full((len(pts), 4), 160, dtype=np.uint8)
        colors = np.asarray(colors)[:, :3].astype(np.float64)
        vx = np.round((pts[:, 0] - centerX) / voxel).astype(np.int64)
        vy = np.round((pts[:, 1] - baseY) / voxel).astype(np.int64)
        vz = np.round((pts[:, 2] - centerZ) / voxel).astype(np.int64)
        for i in range(len(pts)):
            k = (int(vx[i]), int(vy[i]), int(vz[i]))
            color_sum[k] += colors[i]
            color_n[k] += 1

    print(f"[hero] {len(color_sum)} unique voxels", file=sys.stderr)

    # quantize colors and bucket into pal_ layers
    layers = defaultdict(list)
    q = max(1, args.quant)
    for k, csum in color_sum.items():
        c = (csum / color_n[k]).clip(0, 255)
        r = int(round(c[0] / q) * q); r = min(255, r)
        g = int(round(c[1] / q) * q); g = min(255, g)
        b = int(round(c[2] / q) * q); b = min(255, b)
        layers[f"pal_{r:02x}{g:02x}{b:02x}"].extend(k)

    # encode
    encoded = {}
    xs, ys, zs = [], [], []
    block_count = 0
    for name, flat in layers.items():
        arr = np.array(flat, dtype="<i4")
        encoded[name] = base64.b64encode(arr.tobytes()).decode()
        tri = arr.reshape(-1, 3)
        xs.append(tri[:, 0]); ys.append(tri[:, 1]); zs.append(tri[:, 2])
        block_count += len(tri)

    xs = np.concatenate(xs); ys = np.concatenate(ys); zs = np.concatenate(zs)
    resolution = int(max(xs.max() - xs.min(), zs.max() - zs.min()))
    meta = {
        "voxel": voxel,
        "span": span,
        "centerX": 0,
        "centerZ": 0,
        "blockCount": block_count,
        "resolution": resolution,
        "weatherSeason": "summer",
        "sourceName": args.glb.split("/")[-1],
        "inferredFrom": {
            "source": "hero-glb-surface-voxelize",
            "model": "trimesh surface sampling + palette color, no floor/terrain/gravity",
            "mesh_triangles": total_tris,
            "palette_layers": len(encoded),
        },
    }
    payload = {"layers": encoded, "meta": meta}
    with open(args.out, "w") as f:
        json.dump(payload, f)
    print(json.dumps({
        "out": args.out, "blockCount": block_count, "resolution": resolution,
        "voxel": round(voxel, 4), "palette_layers": len(encoded),
        "yRange": [int(ys.min()), int(ys.max())], "yTall": int(ys.max() - ys.min()),
    }, indent=2))


if __name__ == "__main__":
    main()
