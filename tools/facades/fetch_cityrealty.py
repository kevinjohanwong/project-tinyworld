#!/usr/bin/env python3
"""Batch-fetch straight-on facade candidate photos from CityRealty building
pages into the persistent store (images/ + manifest.json). Only REAL photos
are kept: Street View embeds (maps.googleapis.com) are Google and banned for
facade inference. Idempotent: buildings already status>=sourced are skipped,
so images are never re-sourced."""
import json, re, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).parent
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PAGES = {
    "202 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/202-east-75th-street/72403",
    "204 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/204-east-75th-street/28326",
    "206 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/206-east-75th-street/64942",
    "208 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/208-east-75th-street/1129",
    "210 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/210-east-75th-street/110828",
    "216-218 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/216-east-75th-street/5884",
    "222 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/222-east-75th-street/2053",
    "226 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/226-east-75th-street/52677",
    "228 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/228-east-75th-street/2247",
    "230 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/230-east-75th-street/128624",
    "232 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/232-east-75th-street/67368",
    "234 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/234-east-75th-street/128652",
    "240 East 75th Street": "https://www.cityrealty.com/nyc/lenox-hill/240-east-75th-street/14983",
}

def curl(url, out=None):
    cmd = ["curl", "-sL", "-A", UA, "--max-time", "60", url]
    if out: cmd += ["-o", str(out)]
    r = subprocess.run(cmd, capture_output=not out)
    return r.stdout.decode(errors="replace") if not out else (out.exists() and out.stat().st_size > 0)

def building_photos(html):
    """Real slider photos only, deduped, original order."""
    seen, urls = set(), []
    for m in re.finditer(r'<img src="([^"]+)"[^>]*alt="[^"]*building photo', html):
        u = m.group(1)
        if "maps.googleapis.com" in u or "thumbs.cityrealty.com" not in u:
            continue
        key = u.rsplit("/", 1)[-1]
        if key in seen: continue
        seen.add(key); urls.append(u)
    return urls

def main():
    mpath = ROOT / "manifest.json"
    manifest = json.loads(mpath.read_text())
    imgdir = ROOT / "images"; imgdir.mkdir(exist_ok=True)
    for b in manifest["buildings"]:
        addr = b["address"]
        if b["status"] not in ("pending",):
            print(f"skip {addr} (status={b['status']})"); continue
        page = PAGES.get(addr)
        if not page:
            b["status"] = "needs_alt_source"; b["note"] = "no CityRealty building page found"
            print(f"NO PAGE  {addr}"); continue
        html = curl(page)
        urls = building_photos(html)
        if not urls:
            b["status"] = "needs_alt_source"; b["source_url"] = page
            b["note"] = "CityRealty page has no real photo (Street View embed only)"
            print(f"SV-ONLY  {addr}"); continue
        num = addr.split(" ")[0].replace("-", "_")
        saved = []
        for i, u in enumerate(urls):
            full = u.replace("/x424/", "/0x0/")
            out = imgdir / f"{num}_e75_{i:02d}.jpg"
            ok = curl(full, out) or curl(u, out)
            if ok and out.stat().st_size > 5000:
                saved.append({"file": f"images/{out.name}", "url": u})
            elif out.exists():
                out.unlink()
            time.sleep(0.4)
        if saved:
            b["status"] = "sourced"; b["source_url"] = page
            b["image"] = saved[0]["file"]; b["photos"] = saved
            print(f"SOURCED  {addr}: {len(saved)} photos")
        else:
            b["status"] = "needs_alt_source"; b["source_url"] = page
            b["note"] = "photo downloads failed"
            print(f"FAILED   {addr}")
        time.sleep(0.6)
    mpath.write_text(json.dumps(manifest, indent=2))
    print("manifest updated")

if __name__ == "__main__":
    main()
