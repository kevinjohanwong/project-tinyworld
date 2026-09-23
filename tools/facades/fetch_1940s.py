#!/usr/bin/env python3
"""Batch-fetch 1940s NYC tax photos (nynyma via 1940s.nyc) for the E 75th St
row — Manhattan block 1429. These are the straight-on, full-facade lot photos
(2800x4200 full-res) and the ONLY faithful source for 202/204/206, whose
walk-ups were demolished for the 200 E 75th tower (2023) — the OSM extract
predates that, so the world contains the 1940-era massing. Photos are stored
once and marked in manifest.json (never re-sourced). Each photo embeds its
block-lot sign (e.g. '1429 - 39 M') for verification during review."""
import json, subprocess, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
BLOCK = 1429
FULL = "https://photos.1940s.nyc/jpg/{ident}.jpg"
CLOSEST = "https://api.1940s.nyc/photos/closest?lat={lat}&lng={lng}"

# building centroids from the OSM extract (ways on E 75th south side)
CENTROIDS = {
    "202 East 75th Street": (40.771338, -73.958892),
    "204 East 75th Street": (40.771342, -73.958805),
    "206 East 75th Street": (40.771316, -73.958743),
    "208 East 75th Street": (40.771302, -73.958671),
    "210 East 75th Street": (40.771201, -73.958575),
    "216-218 East 75th Street": (40.771150, -73.958417),
    "222 East 75th Street": (40.771082, -73.958243),
    "226 East 75th Street": (40.771057, -73.958124),
    "228 East 75th Street": (40.771030, -73.958060),
    "230 East 75th Street": (40.771003, -73.957994),
    "232 East 75th Street": (40.770975, -73.957928),
    "234 East 75th Street": (40.770917, -73.957895),
    "236 East 75th Street": (40.770853, -73.957846),
    "238 East 75th Street": (40.770843, -73.957741),
    "240 East 75th Street": (40.770852, -73.957643),
    "242 East 75th Street": (40.770819, -73.957563),
}

def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tinyworld-facade-batch"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def download(url, out):
    r = subprocess.run(["curl", "-s", url, "-o", str(out), "-w", "%{http_code}"],
                       capture_output=True)
    return r.stdout.decode().strip() == "200" and out.stat().st_size > 50000

def main():
    mpath = ROOT / "manifest.json"
    manifest = json.loads(mpath.read_text())
    imgdir = ROOT / "images"; imgdir.mkdir(exist_ok=True)
    for b in manifest["buildings"]:
        addr = b["address"]
        if b["status"] not in ("pending", "needs_alt_source"):
            print(f"skip     {addr} (status={b['status']})"); continue
        lat, lng = CENTROIDS[addr]
        try:
            meta = get_json(CLOSEST.format(lat=lat, lng=lng))
        except Exception as e:
            print(f"API ERR  {addr}: {e}"); continue
        ident = meta.get("identifier"); got_addr = meta.get("address")
        if not ident or meta.get("block") != BLOCK:
            print(f"MISS     {addr}: {meta}"); continue
        num = addr.split(" ")[0].replace("-", "_")
        out = imgdir / f"{num}_e75_1940_lot{meta['lot'].split('.')[0].zfill(4)}.jpg"
        if download(FULL.format(ident=ident), out):
            b["status"] = "sourced"
            b["source_url"] = FULL.format(ident=ident)
            b["image"] = f"images/{out.name}"
            b["source_vintage"] = "1940 tax photo (NYC Municipal Archives via 1940s.nyc)"
            b["tax_lot_1940"] = meta["lot"]
            b["api_matched_address"] = got_addr
            hn = got_addr.split(" ")[0]
            flag = "" if hn in addr else "  <-- ADDRESS MISMATCH, verify via in-photo lot sign"
            print(f"SOURCED  {addr}: lot {meta['lot']} ({got_addr}){flag}")
        else:
            print(f"DL FAIL  {addr}: {ident}")
        time.sleep(0.5)
    mpath.write_text(json.dumps(manifest, indent=2))
    print("manifest updated")

if __name__ == "__main__":
    main()
