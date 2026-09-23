#!/usr/bin/env python3
"""Street-facing facade edges for the E 75th St block, from the OSM extract.

Same ENU frame as export-osm-glb.ts (x=east, z=south, anchor below). Buildings
are on the SOUTH (even) side of E 75th St, so the facade is the footprint edge
chain facing NORTH (-z outward normal). a = eastern endpoint (image-left as
seen from the street), b = western — matching the prototype spec convention.
"""
import json, math, re, sys
from pathlib import Path

OSM = "/home/.z/chat-uploads/map-dd2e578b75c2.osm"
LAT, LON = 40.7711699786543, -73.9584271690282
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT))

def to_xz(lat, lon):
    return ((lon - LON) * M_LON, -(lat - LAT) * M_LAT)

manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
want = {b["osm_way"]: b["address"] for b in manifest["buildings"]}

xml = Path(OSM).read_text()
nodes = {}
for m in re.finditer(r'<node id="(\d+)"[^>]*? lat="([-\d.]+)" lon="([-\d.]+)"', xml):
    nodes[m.group(1)] = to_xz(float(m.group(2)), float(m.group(3)))

out = {}
for m in re.finditer(r'<way id="(\d+)"[^>]*>([\s\S]*?)</way>', xml):
    wid, body = m.group(1), m.group(2)
    if wid not in want:
        continue
    refs = [r.group(1) for r in re.finditer(r'<nd ref="(\d+)"/>', body)]
    ring = [nodes[r] for r in refs[:-1] if r in nodes]
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    edges = []
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dz)
        if L < 2.0:
            continue
        # outward normal via centroid test (winding-independent)
        nx, nz = dz / L, -dx / L
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        if (mx + nx - cx) ** 2 + (mz + nz - cz) ** 2 < (mx - nx - cx) ** 2 + (mz - nz - cz) ** 2:
            nx, nz = -nx, -nz
        edges.append((a, b, L, nz, (a[1] + b[1]) / 2))
    # street face: outward normal points north (nz < -0.5), pick longest
    street = [e for e in edges if e[3] < -0.5]
    if not street:
        street = sorted(edges, key=lambda e: e[4])[:1]  # fallback: northmost
    a, b, L, _, _ = max(street, key=lambda e: e[2])
    # a = eastern endpoint (larger x)
    if a[0] < b[0]:
        a, b = b, a
    out[want[wid]] = {
        "way": wid,
        "a_enu": [round(a[0], 2), round(a[1], 2)],
        "b_enu": [round(b[0], 2), round(b[1], 2)],
        "frontage_m": round(L, 2),
        "n_street_edges": len(street),
    }

for addr in sorted(out, key=lambda k: int(re.match(r"(\d+)", k).group(1))):
    e = out[addr]
    print(f"{addr:32s} way {e['way']}  a={e['a_enu']}  b={e['b_enu']}  "
          f"frontage={e['frontage_m']}m  street_edges={e['n_street_edges']}")

Path(__file__).with_name("facade_edges.json").write_text(json.dumps(out, indent=2))
print("\nwrote facade_edges.json")
