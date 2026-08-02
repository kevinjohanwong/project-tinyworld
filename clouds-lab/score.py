#!/usr/bin/env python3
# score.py — quantitative silhouette overlap of our hero tower vs the reference
# cumulus. Width-normalizes + base-aligns both masks (preserving each aspect),
# then reports IoU / recall / precision + a visual overlay.
import sys, numpy as np
from PIL import Image
from scipy import ndimage

import os
_D = os.path.dirname(os.path.abspath(__file__))
REF = "/tmp/ref.png"
OURS = os.path.join(_D, "out/hero.png")

def largest_cc(mask):
    lab, n = ndimage.label(mask)
    if n == 0: return mask
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    return lab == (np.argmax(sizes) + 1)

def ref_mask():
    im = np.asarray(Image.open(REF).convert("RGB")).astype(np.int32)
    Hh, Ww = im.shape[:2]
    R, G, B = im[..., 0], im[..., 1], im[..., 2]
    # cloud (sunlit OR self-shadowed): bright with R lifted — the teal SKY has a
    # much lower R (R<~105) even though it's blue-bright, so R>120 separates the
    # shadowed blue-grey cloud lobe from sky, while excluding green grass.
    m = (R > 120) & (G > 150) & (B > 150) & ((B - R) < 78) & ((G - R) < 70)
    roi = np.zeros_like(m)
    roi[int(0.20 * Hh):int(0.79 * Hh), int(0.15 * Ww):int(0.885 * Ww)] = True
    m = m & roi
    m = largest_cc(m)  # pick the main body BEFORE closing bridges stray wisps
    m = ndimage.binary_closing(m, iterations=2)
    m = ndimage.binary_fill_holes(m)
    m = largest_cc(m)
    return m

def ours_mask():
    im = np.asarray(Image.open(OURS).convert("RGB")).astype(np.int32)
    R, G, B = im[..., 0], im[..., 1], im[..., 2]
    magenta = (R > 200) & (G < 90) & (B > 200)
    m = ~magenta
    m = ndimage.binary_fill_holes(m)
    m = largest_cc(m)
    return m

def bbox(m):
    ys, xs = np.where(m)
    return xs.min(), xs.max(), ys.min(), ys.max()

def crop(m):
    x0, x1, y0, y1 = bbox(m)
    return m[y0:y1 + 1, x0:x1 + 1]

def scale_to_width(m, W):
    h, w = m.shape
    H = max(1, round(h * W / w))
    img = Image.fromarray((m * 255).astype(np.uint8)).resize((W, H), Image.NEAREST)
    return np.asarray(img) > 127

r = crop(ref_mask())
o = crop(ours_mask())
Wr = r.shape[1]
o = scale_to_width(o, Wr)          # normalize our width to ref width (keep our aspect)
Ht = max(r.shape[0], o.shape[0])
def place(m):                       # anchor bottom-center on a Ht×Wr canvas
    c = np.zeros((Ht, Wr), bool)
    h, w = m.shape
    x = (Wr - w) // 2
    c[Ht - h:Ht, x:x + w] = m
    return c
R, O = place(r), place(o)
inter = (R & O).sum(); union = (R | O).sum()
iou = inter / union
recall = inter / R.sum(); prec = inter / O.sum()
print(f"IoU={iou*100:.1f}%  recall={recall*100:.1f}%  precision={prec*100:.1f}%  "
      f"aspect ref(H/W)={r.shape[0]/r.shape[1]:.2f} ours={o.shape[0]/o.shape[1]:.2f}")

# BEST-FIT overlap: what an artist does when overlaying — slide (dx,dy) + scale
# our silhouette to best-fit the reference. Measures pure SHAPE similarity,
# independent of the reference's off-center asymmetry.
from PIL import Image as _I
Rf = R.astype(bool)
best = 0.0
for s in [0.88, 0.94, 1.0, 1.06, 1.12]:
    oh, ow = o.shape
    nw = max(1, round(ow * s)); nh = max(1, round(oh * s))
    os_ = np.asarray(_I.fromarray((o * 255).astype(np.uint8)).resize((nw, nh), _I.NEAREST)) > 127
    for dx in range(-int(0.16 * Wr), int(0.16 * Wr) + 1, 4):
        for dy in range(-int(0.16 * Ht), int(0.10 * Ht) + 1, 4):
            canv = np.zeros((Ht, Wr), bool)
            y0 = Ht - nh + dy; x0 = (Wr - nw) // 2 + dx
            ys, xs = max(0, y0), max(0, x0)
            ye, xe = min(Ht, y0 + nh), min(Wr, x0 + nw)
            if ye <= ys or xe <= xs: continue
            canv[ys:ye, xs:xe] = os_[ys - y0:ye - y0, xs - x0:xe - x0]
            i = (Rf & canv).sum(); u = (Rf | canv).sum()
            if u and i / u > best: best = i / u
print(f"best-fit overlap (slide+scale) = {best*100:.1f}%")

# width-vs-height profile (bottom→top), each normalized to its own max width
def profile(m, nb=11):
    h, w = m.shape
    widths = m.sum(axis=1).astype(float)  # px per row, row0=top
    widths = widths[::-1]                 # flip so index0 = base
    out = []
    for b in range(nb):
        a, z = int(b * h / nb), int((b + 1) * h / nb)
        out.append(widths[a:z].mean() if z > a else 0.0)
    mx = max(out) or 1.0
    return [v / mx for v in out]
pr, po = profile(crop(ref_mask())), profile(crop(ours_mask()))
lab = "base " + " ".join(f"{i/10:.1f}" for i in range(0, 11, 1)) + " crown"
print("           " + "  ".join(f".{int(i*10):02d}" for i in [j/10 for j in range(11)]))
print("ref  width " + " ".join(f"{v:.2f}" for v in pr))
print("ours width " + " ".join(f"{v:.2f}" for v in po))

# visual overlay: ref=green, ours=red, overlap=yellow
vis = np.zeros((Ht, Wr, 3), np.uint8)
vis[R] = [0, 200, 0]; vis[O] += np.array([200, 0, 0], np.uint8); vis[R & O] = [255, 240, 0]
Image.fromarray(vis).save("/tmp/overlap.png")
print("overlay -> /tmp/overlap.png")
