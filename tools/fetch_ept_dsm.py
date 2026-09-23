#!/usr/bin/env python3
"""Fetch a local DSM (max LiDAR return per grid cell) from the USGS public
Entwine point cloud for NYC (usgs-lidar-public/NY_NewYorkCity, EPSG:3857).

Output grid is in the TinyWorld ENU frame (x=east, z=south, meters, anchored
at the given lat/lon) so the voxelizer can sample it without knowing about
mercator. Per cell we keep max z of ALL returns and max z of building-class
(6) returns; ground-class (2) points feed a street-level reference.

Usage:
  python3 fetch_ept_dsm.py --lat 40.77117 --lon -73.95843 --half 60 \
      --cell 0.25 --out /tmp/ues_dsm.npz
"""
import argparse, io, json, math, urllib.request
from pathlib import Path
import numpy as np
import laspy

EPT_BASE = "https://usgs-lidar-public.s3.amazonaws.com/NY_NewYorkCity"
CACHE = Path("/tmp/ept_cache")


def http_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())


def fetch_node(key):
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / f"{key}.laz"
    if not p.exists():
        with urllib.request.urlopen(f"{EPT_BASE}/ept-data/{key}.laz", timeout=120) as r:
            p.write_bytes(r.read())
    return p


def walk_hierarchy(root_bounds, qxmin, qymin, qxmax, qymax):
    """Yield node keys whose cube intersects the query box (xy only)."""
    size0 = root_bounds[3] - root_bounds[0]
    loaded = {}

    def load(key):
        if key not in loaded:
            loaded[key] = http_json(f"{EPT_BASE}/ept-hierarchy/{key}.json")
        return loaded[key]

    hits = []
    stack = [("0-0-0-0", "0-0-0-0")]
    while stack:
        key, hier_key = stack.pop()
        d, xi, yi, zi = (int(v) for v in key.split("-"))
        size = size0 / (1 << d)
        nxmin = root_bounds[0] + xi * size
        nymin = root_bounds[1] + yi * size
        if nxmin > qxmax or nxmin + size < qxmin or nymin > qymax or nymin + size < qymin:
            continue
        table = load(hier_key)
        count = table.get(key, 0)
        if count == 0:
            continue
        if count == -1:  # subtree rooted here lives in its own hierarchy file
            table = load(key)
            hier_key = key
            count = table.get(key, 0)
        hits.append(key)
        for dz in (0, 1):
            for dy in (0, 1):
                for dx in (0, 1):
                    ck = f"{d + 1}-{2 * xi + dx}-{2 * yi + dy}-{2 * zi + dz}"
                    if ck in table:
                        stack.append((ck, hier_key))
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--half", type=float, default=60, help="half-extent, ground meters")
    ap.add_argument("--cell", type=float, default=0.25, help="grid cell, ground meters")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    R = 20037508.342789244
    mx0 = a.lon / 180.0 * R
    my0 = math.log(math.tan((90 + a.lat) * math.pi / 360)) / math.pi * R
    cosf = math.cos(math.radians(a.lat))
    half_merc = a.half / cosf  # mercator meters are ground/cos(lat)

    ept = http_json(f"{EPT_BASE}/ept.json")
    b = ept["bounds"]
    keys = walk_hierarchy(b, mx0 - half_merc, my0 - half_merc, mx0 + half_merc, my0 + half_merc)
    print(f"nodes intersecting: {len(keys)}")

    n = int(round(2 * a.half / a.cell))
    top = np.full((n, n), np.nan, dtype=np.float32)       # max z, any class
    top_bldg = np.full((n, n), np.nan, dtype=np.float32)  # max z, class 6
    ground = []                                           # class 2 z samples
    used = 0
    for i, key in enumerate(keys):
        las = laspy.read(fetch_node(key))
        mx = np.asarray(las.x); my = np.asarray(las.y); mz = np.asarray(las.z)
        cls = np.asarray(las.classification)
        east = (mx - mx0) * cosf
        south = -(my - my0) * cosf
        m = (np.abs(east) < a.half) & (np.abs(south) < a.half)
        if not m.any():
            continue
        east = east[m]; south = south[m]; mz = mz[m]; cls = cls[m]
        used += len(mz)
        ix = np.clip(((east + a.half) / a.cell).astype(int), 0, n - 1)
        iz = np.clip(((south + a.half) / a.cell).astype(int), 0, n - 1)
        np.fmax.at(top, (iz, ix), mz)
        bm = cls == 6
        if bm.any():
            np.fmax.at(top_bldg, (iz[bm], ix[bm]), mz[bm])
        gm = cls == 2
        if gm.any():
            ground.append(mz[gm])
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{len(keys)} nodes, {used} pts in box")

    street = float(np.median(np.concatenate(ground))) if ground else float("nan")
    filled = int(np.isfinite(top).sum())
    print(f"points in box: {used}; cells filled: {filled}/{n * n} ({100 * filled / (n * n):.0f}%)")
    print(f"street ref (median class-2 z): {street:.2f}")
    zs = top[np.isfinite(top)]
    if len(zs):
        print(f"z range: {zs.min():.1f}..{zs.max():.1f}")
    np.savez_compressed(a.out, top=top, top_bldg=top_bldg, street=street,
                        half=a.half, cell=a.cell, lat=a.lat, lon=a.lon)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
