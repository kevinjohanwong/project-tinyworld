import argparse, base64, json, math, os, re, sqlite3, time, urllib.request
from collections import Counter, defaultdict, deque
from pathlib import Path
import numpy as np
import trimesh

TARGET_DIVS=int(__import__("os").environ.get("TARGET_DIVS", "690"))
MAX_TRIANGLES=220000
# Gentle floor undulation ("very low rolling hills"). amplitude=max relief in
# voxels above the dominant plane; wavelength=cells per hill. Defaults keep the
# field gradient <0.5/cell so adjacent floor cells never differ by >1 voxel.
HILL_AMPLITUDE=float(__import__("os").environ.get("HILL_AMPLITUDE", "3"))
HILL_WAVELENGTH=float(__import__("os").environ.get("HILL_WAVELENGTH", "36"))
# Light eroded-cliff relief on the island's void-adjacent rim. depth=max extra
# voxels an edge column hangs below the y-1 dirt underside; wavelength=coherence
# scale of the variation. Kept small ("not too extreme") — underside-only, so it
# never affects the walkable top surface.
CLIFF_DEPTH=float(__import__("os").environ.get("CLIFF_DEPTH", "2"))
CLIFF_WAVELENGTH=float(__import__("os").environ.get("CLIFF_WAVELENGTH", "12"))
# Dead-city destruction (metric path only). Off by default: the worn/cratered
# top surfaces read as ugly "worn ceilings" in the OSM city prototype. Use
# WEAR=1 only for explicit ruin experiments.
WEAR_ENABLED=__import__("os").environ.get("WEAR", "0") == "1"
# Roof ortho-color pass (metric path only). Samples NYC's open 2022
# orthoimagery at each building's top voxel, quantizes to a small palette and
# ships the tops as pal_<rrggbb> layers so the layer-based payload/client
# format stays unchanged. Needs a geo anchor (baked into OSM-exporter GLB
# node names, or GEO_LAT/GEO_LON env). ORTHO=0 disables.
ORTHO_ENABLED=__import__("os").environ.get("ORTHO", "1") == "1"
ROOF_COLORS=int(__import__("os").environ.get("ROOF_COLORS", "12"))
ORTHO_ZOOM=int(__import__("os").environ.get("ORTHO_ZOOM", "20"))
ORTHO_TILE_URL="https://tiles.arcgis.com/tiles/yG5s3afENB5iO9fj/arcgis/rest/services/NYC_Orthos_2022/MapServer/tile/{z}/{y}/{x}"
ORTHO_CACHE=os.environ.get("ORTHO_CACHE", "/tmp/nyc_ortho_cache")

def parse_glb_anchor(path):
    """ENU anchor lat/lon. export-osm-glb.ts bakes it into the node name
    (osm_<lat>_<lon>_r<radius>); GEO_LAT/GEO_LON env overrides for GLBs
    without one. Returns (lat, lon) or None (=> skip the ortho pass)."""
    lat=os.environ.get("GEO_LAT"); lon=os.environ.get("GEO_LON")
    if lat and lon:
        return float(lat), float(lon)
    try:
        m=re.search(rb'osm_(-?\d+\.\d+)_(-?\d+\.\d+)_r\d+', Path(path).read_bytes())
        if m:
            return float(m.group(1)), float(m.group(2))
    except Exception:
        pass
    return None

class OrthoSampler:
    """Web-mercator tile sampler over NYC Open Data 2022 orthos (~0.11 m/px
    at LOD 20 in NYC). Tiles cached on disk; a failed tile is remembered so
    one bad fetch can't stall a 700k-roof-cell pass."""
    def __init__(self, zoom=ORTHO_ZOOM):
        from PIL import Image
        self._Image=Image
        self.zoom=zoom; self.n=1<<zoom
        self.tiles={}; self.fetched=0; self.failed=0
        Path(ORTHO_CACHE).mkdir(parents=True, exist_ok=True)
    def _tile(self, tx, ty):
        key=(tx,ty)
        if key in self.tiles: return self.tiles[key]
        img=None
        cache=Path(ORTHO_CACHE)/f"{self.zoom}_{ty}_{tx}.jpg"
        try:
            if not cache.exists():
                url=ORTHO_TILE_URL.format(z=self.zoom, y=ty, x=tx)
                with urllib.request.urlopen(url, timeout=20) as r:
                    cache.write_bytes(r.read())
                self.fetched+=1
            img=self._Image.open(cache).convert('RGB')
        except Exception:
            self.failed+=1
            try: cache.unlink(missing_ok=True)
            except Exception: pass
        self.tiles[key]=img
        return img
    def sample(self, lat, lon):
        x=(lon+180.0)/360.0*self.n
        latr=math.radians(lat)
        y=(1.0-math.log(math.tan(latr)+1.0/math.cos(latr))/math.pi)/2.0*self.n
        tx=int(x); ty=int(y)
        img=self._tile(tx, ty)
        if img is None: return None
        px=min(255, int((x-tx)*256)); py=min(255, int((y-ty)*256))
        return img.getpixel((px, py))

# DSM=<path.npz from fetch_ept_dsm.py>: replace flat OSM extrusion tops with
# measured LiDAR first-return heights per column (water towers, penthouses,
# setbacks, courtyards). Geometry source, independent of the color pass.
DSM_PATH=os.environ.get("DSM", "")
# Facade relief spec (metric path only): FACADE=<spec.json> extrudes photo-
# inferred window grids / sills / cornices on named street faces. See
# apply_facade_relief.
FACADE_SPEC=os.environ.get("FACADE", "")
# Triangle sampler subdivision cap. 120 gives 0.167m sample spacing on the
# exporter's 20m-tessellated edges — fine at 0.25m voxels, holes at 0.1m.
# Small-CROP runs pre-crop triangles, so raising this stays cheap.
STEP_CAP=int(os.environ.get("STEP_CAP", "120"))

def apply_dsm_tops(col_top, keep_cols, floor, voxel, centerX, centerZ, rot_deg, anchor, min_h):
    """Override building column tops with LiDAR DSM heights (ENU-frame grid
    from fetch_ept_dsm.py). 3x3-cell max window rides over the ~40% per-cell
    LiDAR fill and OSM/LiDAR edge misalignment. Columns measuring < 1.5m are
    real openings (courtyards) and get dropped — but only when the low reading
    is corroborated (at/above street, majority of the window has returns);
    street-return dropouts read below street from sparse noise returns and
    would otherwise tear a full-height seam out of a facade. No DSM sample =>
    OSM height."""
    d=np.load(DSM_PATH)
    osm=dict(col_top)  # pre-override OSM extrusion tops (lot-line clamp ref)
    top=d['top']; street=float(d['street']); half=float(d['half']); cell=float(d['cell'])
    LAT, LON=anchor
    M_LAT=111320.0; M_LON=111320.0*math.cos(math.radians(LAT))
    # DSM grid may be anchored at a slightly different point than the GLB
    e0=(float(d['lon'])-LON)*M_LON; s0=-(float(d['lat'])-LAT)*M_LAT
    if 1<rot_deg<89:
        rot=-math.radians(rot_deg); cr=math.cos(rot); sr=math.sin(rot)
    else:
        cr, sr=1.0, 0.0
    n=top.shape[0]
    overridden=0; dropped=0; no_data=0; dropout_kept_osm=0; lotline_clamped=0
    # Lot-line bleed clamp params: within 0.75m of a taller-OSM neighbor the
    # 3x3-max window reads the neighbor's roof, extruding a fin above this
    # column's own parapet. Clamp back to own OSM + parapet tolerance, but
    # only when the reading sits at/above the neighbor's level (>= nb-2m) —
    # genuine own-roof structure (bulkheads, towers) stays untouched.
    lot_r=max(1, int(round(0.75/voxel)))
    ptol=max(1, int(round(1.0/voxel)))
    nb_band=int(round(2.0/voxel))
    for (x,z) in list(keep_cols):
        xr=x*voxel+centerX; zr=z*voxel+centerZ
        e=xr*cr+zr*sr-e0; s=zr*cr-xr*sr-s0
        ix=int((e+half)/cell); iz=int((s+half)/cell)
        if not (0<=ix<n and 0<=iz<n):
            no_data+=1; continue
        w=top[max(0,iz-1):iz+2, max(0,ix-1):ix+2]
        w=w[np.isfinite(w)]
        if not len(w):
            no_data+=1; continue
        h=float(w.max())-street
        if h<1.5:
            if h>=0.0 and len(w)>=5:
                keep_cols.discard((x,z)); dropped+=1
            else:
                dropout_kept_osm+=1
            continue
        nt=floor.get((x,z),0)+max(int(round(h/voxel)), min_h)
        own=osm.get((x,z))
        if own is not None and nt>own+ptol:
            nb_max=max((osm.get((x+dx,z+dz),-1<<30)
                        for dx in range(-lot_r,lot_r+1)
                        for dz in range(-lot_r,lot_r+1) if dx or dz),
                       default=-1<<30)
            if nb_max>own+ptol and nt>=nb_max-nb_band:
                nt=own+ptol; lotline_clamped+=1
        col_top[(x,z)]=nt
        overridden+=1
    # Despike: isolated needle columns are LiDAR outliers (birds, antenna
    # glints) amplified by the max window. Real rooftop structures (water
    # towers ~3-4m across = 12-16 cells at 0.25m) have tall company; a column
    # >6m above its 5x5 median with <4 similarly-tall neighbors gets clamped.
    spike_m=6.0; despiked=0
    tall=int(round(spike_m/voxel))
    tops={k:col_top[k] for k in keep_cols if k in col_top}
    for (x,z),t in list(tops.items()):
        nb=[tops[(x+dx,z+dz)] for dx in range(-2,3) for dz in range(-2,3)
            if (dx or dz) and (x+dx,z+dz) in tops]
        if len(nb)<3: continue
        med=sorted(nb)[len(nb)//2]
        if t-med>tall and sum(1 for v in nb if v>=t-tall//2)<4:
            col_top[(x,z)]=med; despiked+=1
    # Parapet smoothing: at edges the 3x3-max window mixes wall/street/neighbor
    # returns and the 0.25m DSM grid staircases at sub-cell voxel sizes, tearing
    # rooflines by 1-2 voxels. A tight median (r=0.5m) snaps deviations <=0.6m;
    # real rooftop structure (bulkheads, water towers, rowhouse parapet steps)
    # exceeds the band and survives untouched.
    smooth_r=max(2, int(round(0.5/voxel))); band=max(2, int(round(0.6/voxel)))
    tops={k:col_top[k] for k in keep_cols if k in col_top}
    smoothed=0
    for (x,z),t in tops.items():
        nb=[tops[(x+dx,z+dz)] for dx in range(-smooth_r,smooth_r+1)
            for dz in range(-smooth_r,smooth_r+1) if (x+dx,z+dz) in tops]
        if len(nb)<5: continue
        nb.sort(); med=nb[len(nb)//2]
        if 0<abs(t-med)<=band:
            col_top[(x,z)]=med; smoothed+=1
    return {'source':'USGS 3DEP EPT NY_NewYorkCity (usgs-lidar-public)',
            'grid_cell_m':cell, 'window':'3x3-max', 'street_ref_z':street,
            'overridden':overridden, 'dropped_openings':dropped,
            'no_data_kept_osm':no_data, 'dropout_kept_osm':dropout_kept_osm,
            'lotline_clamped':lotline_clamped, 'despiked':despiked,
            'parapet_smoothed':smoothed, 'smooth_r_m':smooth_r*voxel,
            'smooth_band_m':band*voxel,
            'mode':'per-column-lidar-top'}

def median_cut(colors, k):
    """Quantize Nx3 uint8 colors to <=k palette colors (median cut)."""
    boxes=[np.asarray(colors, dtype=float)]
    while len(boxes)<k:
        spans=[(np.ptp(b, axis=0).max() if len(b)>1 else -1.0, i) for i,b in enumerate(boxes)]
        span, bi=max(spans)
        if span<=0: break
        b=boxes.pop(bi)
        ax=int(np.argmax(np.ptp(b, axis=0)))
        b=b[b[:,ax].argsort()]
        m=len(b)//2
        boxes.append(b[:m]); boxes.append(b[m:])
    return np.array([b.mean(axis=0) for b in boxes if len(b)])

def recolor_roofs(final, col_top, keep_cols, voxel, centerX, centerZ, rot_deg, anchor):
    """One median color per roof segment, not per voxel: the 2022 orthos carry
    hard cast shadows that per-voxel sampling turns into salt-and-pepper
    speckle. Tops are segmented by 4-connectivity with a <=1m height step
    (splits abutting rowhouses and bulkheads); each segment takes the median
    of its well-lit ortho pixels (low-luminance shadow pixels rejected, with
    an adaptive cutoff so tar-black roofs survive), and the segment colors are
    quantized to ROOF_COLORS pal_<rrggbb> layers. Cells whose tile fetch fails
    inherit their segment color; segments with zero coverage stay plain wall."""
    LAT, LON=anchor
    M_LAT=111320.0; M_LON=111320.0*math.cos(math.radians(LAT))
    cr, sr=_cardinal_rot(rot_deg)
    sampler=OrthoSampler()
    tops={}; rest=[]
    for x,y,z in final['wall']:
        if (x,z) in keep_cols and col_top.get((x,z))==y:
            tops[(x,z)]=y
        else:
            rest.append((x,y,z))
    stats={'source':'NYC_Orthos_2022 (tiles.arcgis.com, NYC Open Data)',
           'zoom':sampler.zoom, 'sampled':0, 'unsampled_tops':0,
           'tiles':0, 'tile_failures':0, 'palette':0, 'segments':0,
           'anchor':[LAT, LON], 'mode':'roof-segment-lit-median'}
    if not tops:
        final['wall']=rest
        return stats
    step=max(1, int(round(1.0/voxel)))
    remain=set(tops); segs=[]
    while remain:
        start=remain.pop(); comp=[start]; q=deque([start])
        while q:
            x,z=q.popleft()
            for dx,dz in ((1,0),(-1,0),(0,1),(0,-1)):
                nb=(x+dx,z+dz)
                if nb in remain and abs(tops[nb]-tops[(x,z)])<=step:
                    remain.remove(nb); q.append(nb); comp.append(nb)
        segs.append(comp)
    seg_colors=[]; colored=[]; sampled=0; unsampled=0
    for comp in segs:
        samples=[]
        for x,z in comp:
            xr=x*voxel+centerX; zr=z*voxel+centerZ
            # inverse of rotate_to_cardinal (v_rot = v @ R.T  =>  v = v_rot @ R)
            x0=xr*cr+zr*sr; z0=zr*cr-xr*sr
            c=sampler.sample(LAT-z0/M_LAT, LON+x0/M_LON)
            if c is not None:
                samples.append(c)
        if not samples:
            unsampled+=len(comp)
            rest.extend((x,tops[(x,z)],z) for x,z in comp)
            continue
        sampled+=len(samples)
        cols=np.asarray(samples, dtype=float)
        lum=cols@np.array([0.2126,0.7152,0.0722])
        cut=max(30.0, 0.55*float(np.percentile(lum,75)))
        lit=cols[lum>=cut]
        if len(lit)<max(4, 0.1*len(cols)):
            lit=cols
        seg_colors.append(np.median(lit, axis=0)); colored.append(comp)
    stats.update(sampled=sampled, unsampled_tops=unsampled,
                 tiles=len(sampler.tiles), tile_failures=sampler.failed,
                 segments=len(colored))
    final['wall']=rest
    if not colored:
        return stats
    segcols=np.asarray(seg_colors, dtype=float)
    palette=median_cut(segcols, ROOF_COLORS)
    idx=np.argmin(((segcols[:,None,:]-palette[None,:,:])**2).sum(axis=2), axis=1)
    for i,comp in enumerate(colored):
        r,g,b=(int(round(v)) for v in palette[idx[i]])
        final[f'pal_{r:02x}{g:02x}{b:02x}'].extend((x,tops[(x,z)],z) for x,z in comp)
    stats['palette']=int(len(palette))
    return stats

def _cardinal_rot(rot_deg):
    if 1<rot_deg<89:
        rot=-math.radians(rot_deg); return math.cos(rot), math.sin(rot)
    return 1.0, 0.0

def _spec_face_cols(b, keep_cols, voxel, centerX, centerZ, cr, sr):
    """Per-column true face row for a spec'd building: front-most footprint
    column near the expected row (street side is -z after cardinal rotation).
    Returns (face {vx: fz}, arx, usign)."""
    ax,az=b['a_enu']; bx,bz=b['b_enu']
    # forward of rotate_to_cardinal: v_rot = v @ R.T
    arx=ax*cr-az*sr; brx=bx*cr-bz*sr
    arz=ax*sr+az*cr; brz=bx*sr+bz*cr
    vz_f=int(round(((arz+brz)/2-centerZ)/voxel))
    ix_lo=int(round((min(arx,brx)-centerX)/voxel))
    ix_hi=int(round((max(arx,brx)-centerX)/voxel))
    usign=1.0 if brx>=arx else -1.0
    face={}
    for vx in range(ix_lo, ix_hi+1):
        cand=[vz for vz in range(vz_f-8, vz_f+9) if (vx,vz) in keep_cols]
        if cand: face[vx]=min(cand)
    return face, arx, usign

def flatten_facade_rooflines(col_top, keep_cols, voxel, centerX, centerZ, rot_deg):
    """Runs between the DSM pass and shell build. DSM edge cells mix
    wall/street returns, so per-column tops tear exactly where the facade
    relief expects a straight parapet. Rowhouse street parapets ARE flat:
    snap each spec'd face (plus 0.5m of parapet return behind it) to the
    face-median top so the shell and the relief pass share one roofline.
    The snap is UNCONDITIONAL for the face row + return: any DSM deviation
    (even >2m spikes from mixed wall/street returns) becomes a band artifact
    on the facade, so the measured roofline always wins there."""
    spec=json.loads(Path(FACADE_SPEC).read_text())
    cr, sr=_cardinal_rot(rot_deg)
    depth=max(1, int(round(0.5/voxel)))
    out=[]
    for b in spec['buildings']:
        face,_,_=_spec_face_cols(b, keep_cols, voxel, centerX, centerZ, cr, sr)
        tops=sorted(col_top[(vx,fz)] for vx,fz in face.items() if (vx,fz) in col_top)
        if not tops:
            out.append({'name':b.get('name','?'),'snapped':0}); continue
        med=tops[len(tops)//2]; snapped=0
        for vx,fz in face.items():
            for dz in range(0, depth+1):
                k=(vx,fz+dz)
                if k in keep_cols and k in col_top and col_top[k]!=med:
                    col_top[k]=med; snapped+=1
        out.append({'name':b.get('name','?'),'roofline_vox':int(med),'snapped':snapped})
    return {'buildings':out,'mode':'face-median-snap-unconditional'}

def apply_facade_relief(final, col_top, keep_cols, floor, voxel, centerX, centerZ, rot_deg, anchor):
    """Semantic facade relief from street photography — geometry, not paint.
    Additive only (no latent surgery): extrudes a 0.2m masonry plane out of
    each spec'd street face so window/door rects stay recessed at the
    original shell plane (moved into glass/door pal layers), then extrudes
    sills, lintels, bandcourses, cornice+brackets, stoop and awning beyond
    it. The building grows ~0.2-0.5m toward the street, which keeps the
    latent interior untouched. Spec coords: u = meters along the facade from
    corner a (image-left as seen from the street), v = meters above street."""
    spec=json.loads(Path(FACADE_SPEC).read_text())
    cr, sr=_cardinal_rot(rot_deg)
    out=[]
    for b in spec['buildings']:
        face, arx, usign=_spec_face_cols(b, keep_cols, voxel, centerX, centerZ, cr, sr)
        if not face:
            out.append({'name':b.get('name','?'),'face_cols':0}); continue
        g=[floor[(vx,fz-k)] for vx,fz in face.items() for k in (2,4,6) if (vx,fz-k) in floor]
        y0=sorted(g)[len(g)//2] if g else 0
        cols=b.get('window_cols',[]); rows=b.get('window_rows',[])
        bands=b.get('bands',[]); door=b.get('door'); stoop=b.get('stoop')
        corn=b.get('cornice'); awn=b.get('awning'); C=b.get('colors',{})
        # Anchor the cornice band to the measured (flattened) roofline instead
        # of the photo-scaled absolute height — DSM owns total height, the
        # photo owns internal layout. Prevents the top band clipping mid-crown
        # when the two disagree by more than a scale error.
        ft=sorted(col_top[(vx,fz)] for vx,fz in face.items() if (vx,fz) in col_top)
        if corn and ft:
            dv=(ft[len(ft)//2]-y0)*voxel-corn['top']
            if abs(dv)>0.3:
                corn={**corn, 'base':corn['base']+dv, 'top':corn['top']+dv,
                      **({'bracket_base':corn['bracket_base']+dv} if 'bracket_base' in corn else {})}
        Lm='pal_'+C.get('masonry','82503f'); Lt='pal_'+C.get('trim','6a4136')
        Lg='pal_'+C.get('glass','232a33'); Ld='pal_'+C.get('door','7a1f1f')
        def in_door(u,v):
            return door and abs(u-door['c'])<door['w']/2 and door['base']<=v<door['head']
        def in_window(u,v):
            for r in rows:
                if r['sill']<=v<r['head']:
                    for i,c in enumerate(cols):
                        if i in r.get('skip',()): continue
                        if abs(u-c['c'])<c['w']/2: return True
            return False
        def trim_depth(u,v):
            d=0
            for r in rows:
                for i,c in enumerate(cols):
                    if i in r.get('skip',()): continue
                    if abs(u-c['c'])<c['w']/2+0.12:
                        if r['sill']-0.22<=v<r['sill']: d=3
                        elif r['head']<=v<r['head']+0.32: d=3
            for bd in bands:
                if bd['v0']<=v<bd['v1']: d=max(d,3)
            if corn:
                if corn['base']<=v<corn['top']:
                    f=(v-corn['base'])/max(1e-9, corn['top']-corn['base'])
                    d=max(d, 3+int(f*2.999))
                elif 'bracket_base' in corn and corn['bracket_base']<=v<corn['base']:
                    if (u%0.7)<0.25: d=max(d,4)
            return d
        add=defaultdict(set); glass=set(); doorset=set()
        for vx,fz in face.items():
            u=(vx*voxel+centerX-arx)*usign
            top=col_top.get((vx,fz))
            if top is None: continue
            for vy in range(y0+1, top+1):
                v=(vy-y0)*voxel
                if in_door(u,v):
                    doorset.add((vx,vy,fz)); continue
                if in_window(u,v):
                    glass.add((vx,vy,fz)); continue
                d=max(2, trim_depth(u,v))
                for k in range(1, d+1):
                    (add[Lt] if k>2 else add[Lm]).add((vx,vy,fz-k))
        if stoop:
            tvox=max(1, int(round(stoop.get('tread',0.3)/voxel)))
            rise=stoop['top']/stoop['steps']
            for vx,fz in face.items():
                u=(vx*voxel+centerX-arx)*usign
                if abs(u-stoop['c'])>stoop['w']/2: continue
                for i in range(stoop['steps']):
                    ytop=y0+max(1, int(round((stoop['top']-i*rise)/voxel)))
                    for vz in range(fz-2-(i+1)*tvox+1, fz-2-i*tvox+1):
                        for vy in range(y0+1, ytop+1):
                            add[Lm].add((vx,vy,vz))
        if awn:
            proj=int(round(awn.get('proj',1.4)/voxel))
            drop=awn.get('drop',0.03)
            for vx,fz in face.items():
                u=(vx*voxel+centerX-arx)*usign
                if abs(u-awn['c'])>awn['w']/2: continue
                for j in range(proj):
                    vy=y0+int(round((awn['v']-j*drop)/voxel))
                    add[Ld].add((vx,vy,fz-3-j))
        wall_rest=[]; moved_g=0; moved_d=0
        for p in final['wall']:
            t=tuple(p)
            if t in glass: final[Lg].append(t); moved_g+=1
            elif t in doorset: final[Ld].append(t); moved_d+=1
            else: wall_rest.append(p)
        final['wall']=wall_rest
        added=0
        for name, pts in add.items():
            final[name].extend(sorted(pts)); added+=len(pts)
        out.append({'name':b.get('name','?'),'face_cols':len(face),'street_y':int(y0),
                    'relief_added':added,'glass_moved':moved_g,'door_moved':moved_d})
    return {'buildings':out,'spec':Path(FACADE_SPEC).name,
            'mode':'photo-inferred-semantic-relief-additive'}

def b64_i32(points):
    if not points:
        return base64.b64encode(np.array([], dtype='<i4').tobytes()).decode()
    arr=np.array(points, dtype='<i4').reshape(-1)
    return base64.b64encode(arr.tobytes()).decode()

def hash2(x,z):
    return ((x*73856093) ^ (z*19349663)) & 0xffffffff

def load_triangles(path):
    scene=trimesh.load(path, force='scene')
    tris=[]
    for name, geom in scene.geometry.items():
        if not hasattr(geom,'vertices') or not hasattr(geom,'faces'): continue
        try: T=scene.graph.get(name)[0]
        except Exception: T=np.eye(4)
        verts=trimesh.transform_points(np.asarray(geom.vertices), T)
        faces=np.asarray(geom.faces)
        for f in faces[:max(0, MAX_TRIANGLES-len(tris))]:
            tris.append(verts[f].astype(float))
            if len(tris)>=MAX_TRIANGLES: break
        if len(tris)>=MAX_TRIANGLES: break
    if not tris: raise SystemExit('no triangles in GLB')
    allv=np.vstack([t for t in tris])
    return tris, allv.min(axis=0), allv.max(axis=0)

def rotate_to_cardinal(tris):
    hist=np.zeros(90, dtype=float)
    for tri in tris:
        a,b,c=tri
        n=np.cross(b-a, c-a); ln=np.linalg.norm(n) or 1.0
        nx,ny,nz=n/ln
        horiz=math.hypot(nx,nz)
        if horiz>0.85:
            deg=(math.degrees(math.atan2(nz,nx))%90+90)%90
            hist[int(round(deg))%90]+=np.linalg.norm(n)/2
    scores=[]
    for d in range(90):
        scores.append(sum(hist[(d+o)%90] for o in range(-2,3)))
    best=int(np.argmax(scores))
    if 1<best<89:
        rot=-math.radians(best); cr=math.cos(rot); sr=math.sin(rot)
        R=np.array([[cr,0,-sr],[0,1,0],[sr,0,cr]], dtype=float)
        tris=[tri@R.T for tri in tris]
    allv=np.vstack([t for t in tris])
    return tris, allv.min(axis=0), allv.max(axis=0), best

def median_smooth_floor(floor):
    for _ in range(2):
        out={}
        for (x,z), y in floor.items():
            vals=[y]
            for dx in (-1,0,1):
                for dz in (-1,0,1):
                    if dx==0 and dz==0: continue
                    if (x+dx,z+dz) in floor: vals.append(floor[(x+dx,z+dz)])
            vals.sort(); out[(x,z)]=vals[len(vals)//2]
        floor.update(out)
    return floor

def fnv1a(s):
    """Deterministic 32-bit string hash (stable across runs, unlike hash())."""
    h=2166136261
    for ch in s.encode():
        h=((h ^ ch)*16777619) & 0xffffffff
    return h

def _smootherstep(t):
    return t*t*t*(t*(t*6-15)+10)   # C2-continuous, deriv max ~1.875

def _lattice(ix, iz, seed):
    """Pseudo-random lattice value in [0,1), keyed on integer grid + seed."""
    h=(hash2(ix + (seed*0x9E3779B1 & 0xffffffff),
             iz - (seed*0x85EBCA77 & 0xffffffff)) ^ (seed*2654435761)) & 0xffffffff
    return (h & 0xffffff)/float(0x1000000)

def _value_noise(x, z, cell, seed):
    """One octave of bilinearly-interpolated value noise (smootherstep). [0,1)."""
    fx=x/cell; fz=z/cell
    ix=math.floor(fx); iz=math.floor(fz)
    tx=_smootherstep(fx-ix); tz=_smootherstep(fz-iz)
    v00=_lattice(ix,iz,seed);     v10=_lattice(ix+1,iz,seed)
    v01=_lattice(ix,iz+1,seed);   v11=_lattice(ix+1,iz+1,seed)
    a=v00+(v10-v00)*tx
    b=v01+(v11-v01)*tx
    return a+(b-a)*tz

def rolling_hills(floor, amplitude=HILL_AMPLITUDE, wavelength=HILL_WAVELENGTH, seed=0):
    """Add gentle, organic, non-repeating undulation to the snapped-flat floor.

    Uses 3-octave value noise (base lattice = wavelength cells, halving spacing
    and amplitude per octave) instead of a periodic sine field, so the hills
    read as natural varied terrain rather than a tiling egg-carton. The summed
    per-cell gradient stays < ~0.3 voxel/cell at the defaults (smootherstep
    deriv * sum(amp/cell) / norm * amplitude), so adjacent floor cells never
    differ by more than 1 voxel -> the floor stays walkable (<=1 step-up) and
    gap-free with the thin underside dirt. Displacement is biased non-negative
    ([0, amplitude]) so the dominant plane forms the valleys and walls keep
    sitting flush on their floor cell.

    `seed` offsets the noise field per world, so each scan gets distinct hills
    instead of the same pattern sampled at shared (x,z). Fully deterministic:
    re-voxelizing the same scan yields identical hills (bake once, never drift).
    """
    if not floor or amplitude <= 0:
        return floor
    base=max(8.0, wavelength)
    octaves=[(base,1.0), (base/2,0.5), (base/4,0.25)]
    norm=sum(a for _,a in octaves)
    # Pass 1: raw fractional noise per cell, plus its min/max for contrast.
    raw={}; lo=2.0; hi=-1.0
    for (x,z) in floor.keys():
        n=0.0
        for cell,amp in octaves:
            n += amp*_value_noise(x, z, cell, seed)
        n/=norm
        raw[(x,z)]=n
        if n<lo: lo=n
        if n>hi: hi=n
    span=(hi-lo) or 1.0
    # Pass 2: contrast-stretch the noise to fill [0, amplitude] so valleys reach
    # the dominant plane and crests reach full relief (value noise alone clusters
    # near its mean). The stretch is a single linear scale of the whole field, so
    # the per-cell gradient stays sub-voxel -> neighbours still differ by <=1.
    for k in list(floor.keys()):
        floor[k] += int(round(amplitude*((raw[k]-lo)/span)))   # [0, amplitude]
    return floor

def cliff_edges(floor, seed=0, depth=CLIFF_DEPTH, wavelength=CLIFF_WAVELENGTH):
    """Add light, organic depth to the island's void-adjacent floor edges.

    For each floor column on a void edge (>=1 of its 4 orthogonal neighbours is
    empty), hang a few extra voxels below the existing y-1 dirt underside, by a
    coherent value-noise amount in [0, depth]. Coherent noise makes the
    deeper/shallower runs contiguous (natural cliff sections rather than per-cell
    speckle). The first extra voxel continues the loam (dirt); anything deeper is
    stone, giving a grass -> loam -> rock strata read on the tallest sections.

    Underside-only: the walkable top surface is never touched, so walkability is
    unaffected by construction. Deterministic per-world via `seed` (bake once).
    Returns (dirt_pts, stone_pts).
    """
    if not floor or depth <= 0:
        return [], []
    fset=set(floor.keys())
    cell=max(4.0, wavelength)
    dirt_pts=[]; stone_pts=[]
    for (x,z), y in floor.items():
        if all((x+dx,z+dz) in fset for dx,dz in ((1,0),(-1,0),(0,1),(0,-1))):
            continue   # interior column, not a void edge
        d=int(round(depth*_value_noise(x, z, cell, seed)))   # [0, depth]
        for k in range(2, 2+d):                              # below the y-1 dirt
            (dirt_pts if k==2 else stone_pts).append((x, y-k, z))
    return dirt_pts, stone_pts

def connected_keep(cols, min_size=6):
    remain=set(cols); keep=set()
    dirs=[(1,0),(-1,0),(0,1),(0,-1)]
    while remain:
        start=remain.pop(); comp=[start]; q=deque([start])
        while q:
            x,z=q.popleft()
            for dx,dz in dirs:
                nb=(x+dx,z+dz)
                if nb in remain:
                    remain.remove(nb); q.append(nb); comp.append(nb)
        if len(comp)>=min_size: keep.update(comp)
    return keep

def components_2d(cols):
    """4-connected components of a set of (x,z) columns."""
    remain=set(cols); comps=[]
    dirs=[(1,0),(-1,0),(0,1),(0,-1)]
    while remain:
        start=remain.pop(); comp=[start]; q=deque([start])
        while q:
            x,z=q.popleft()
            for dx,dz in dirs:
                nb=(x+dx,z+dz)
                if nb in remain:
                    remain.remove(nb); q.append(nb); comp.append(nb)
        comps.append(comp)
    return comps

def building_footprint(cols):
    """All (x,z) cells inside a wall silhouette (walls + enclosed interior).

    Flood-fills the exterior from a padded bounding box; any cell the fill cannot
    reach without crossing a wall column is interior. Open (non-closed) silhouettes
    leak and simply yield no interior -- graceful: we still get the solid perimeter.
    """
    cols=set(cols)
    xs=[x for x,_ in cols]; zs=[z for _,z in cols]
    minx=min(xs)-1; maxx=max(xs)+1; minz=min(zs)-1; maxz=max(zs)+1
    outside=set(); q=deque()
    for x in range(minx, maxx+1):
        for z in (minz, maxz):
            if (x,z) not in cols and (x,z) not in outside:
                outside.add((x,z)); q.append((x,z))
    for z in range(minz, maxz+1):
        for x in (minx, maxx):
            if (x,z) not in cols and (x,z) not in outside:
                outside.add((x,z)); q.append((x,z))
    dirs=[(1,0),(-1,0),(0,1),(0,-1)]
    while q:
        x,z=q.popleft()
        for dx,dz in dirs:
            nx,nz=x+dx,z+dz
            if minx<=nx<=maxx and minz<=nz<=maxz and (nx,nz) not in cols and (nx,nz) not in outside:
                outside.add((nx,nz)); q.append((nx,nz))
    foot=set(cols)
    for x in range(minx, maxx+1):
        for z in range(minz, maxz+1):
            if (x,z) not in cols and (x,z) not in outside:
                foot.add((x,z))
    return foot

def apply_top_wear(col_top, keep_cols, floor, voxel, seed):
    """Top-down destruction for the dead city: dig craters into building tops.

    Per 4-connected building component, draw a deterministic damage tier
    (ruin / damaged / weathered), then lower each column's top by
    intensity * height * crater-noise. Squaring the value noise sharpens it
    into localized bowls (collapsed sections) instead of uniform shaving, and
    perimeter columns get extra hash chipping so rooflines read jagged.
    Mutating col_top BEFORE the fill/shell/latent stages keeps everything
    consistent for free: the crater surface becomes real shell, the mass
    below stays latent + physics-solid. Very tall components are capped at
    "damaged" so landmark silhouettes (ESB) survive. Ruins shed a little
    rubble onto adjacent open street. Deterministic via `seed` (re-runs
    reproduce the same ruins). Returns (stats, rubble_pts).
    """
    crater_cell=max(3.0, 7.0/voxel)
    keep=set(keep_cols)
    stats={"ruin":0,"damaged":0,"weathered":0,"removed_cells":0}
    rubble=set()
    for comp in components_2d(list(keep_cols)):
        mx=min(x for x,_ in comp); mz=min(z for _,z in comp)
        h=(hash2(mx,mz) ^ (seed*2654435761)) & 0xffffffff
        r=h%100
        maxh=0
        for k in comp:
            maxh=max(maxh, col_top[k]-floor.get(k,0))
        if r<18: tier,lo,hi="ruin",0.55,0.90
        elif r<50: tier,lo,hi="damaged",0.20,0.45
        else: tier,lo,hi="weathered",0.04,0.10
        if tier=="ruin" and maxh*voxel>50.0:
            tier,lo,hi="damaged",0.20,0.45
        stats[tier]+=1
        inten=lo + ((h>>8)&0xffff)/65535.0*(hi-lo)
        for k in comp:
            x,z=k
            g=floor.get(k,0)
            top=col_top[k]
            H=top-g
            if H<=0: continue
            # Two octaves: 7m bowls + 2.7m detail, then squared into localized
            # pits. Pure low-frequency noise reads as smooth "eroded dune"
            # slopes (adjacent-column steps almost never exceed 1m) — the
            # second octave + per-column jitter below make it jagged collapse.
            n=0.7*_value_noise(x,z,crater_cell,seed)+0.3*_value_noise(x,z,crater_cell/2.6,seed+1013)
            depth=inten*H*n*n
            perim=any((x+dx,z+dz) not in keep for dx,dz in ((1,0),(-1,0),(0,1),(0,-1)))
            if perim:
                depth += (hash2(x*7+1,z*13-5) ^ seed) % 3
            if depth>0.5:
                # rubble-step jitter on worn surfaces only; intact roofs stay crisp
                depth += (hash2(x*13+7,z*29-3) ^ (seed>>1)) % 3
            d=int(round(depth))
            if d<=0: continue
            new_top=max(g+2, top-d)
            removed=top-new_top
            if removed<=0: continue
            col_top[k]=new_top
            stats["removed_cells"]+=removed
            if tier=="ruin" and perim and removed>=3:
                for dx,dz in ((1,0),(-1,0),(0,1),(0,-1)):
                    nk=(x+dx,z+dz)
                    if nk in keep or nk not in floor: continue
                    hh=hash2(x*31+dx, z*17+dz) ^ h
                    if hh%3: continue
                    gy=floor[nk]
                    rubble.add((nk[0], gy+1, nk[1]))
                    if hh%7==0: rubble.add((nk[0], gy+2, nk[1]))
    return stats, sorted(rubble)

def metric_shell(col_top, keep_cols, floor):
    """Exposed-only shell + latent rule for the per-column heightfield fill.

    Replaces the metric path's materialized solid fill + set-based visibility
    cull: at 0.25 m the interior fill is ~90M cells, which as Python tuples in
    sets is an OOM. Exposure has a closed form on a heightfield — a cell is
    shell iff it's the column top, below a neighbour column's fill base, above
    a neighbour's top, or the fill bottom over open ground. Slight over-ship
    at street level (floor blocks ignored as occluders) is harmless: a few
    extra hidden voxels, never a hole. Latent = in-column cells not shipped,
    identical semantics to the old shipped-set subtraction.
    Returns (wall_pts, latent_quads, latent_total).
    """
    keep=set(keep_cols)
    wall=[]; latent_quads=[]; latent_total=0
    for k in sorted(keep):
        x,z=k
        g=floor.get(k,0)
        base=max(1,g+1)
        top=col_top[k]
        if top<base: continue
        shipped={top}
        if not (k in floor and floor[k]==base-1):
            shipped.add(base)
        for dx,dz in ((1,0),(-1,0),(0,1),(0,-1)):
            nk=(x+dx,z+dz)
            if nk in keep:
                ng=floor.get(nk,0)
                nbase=max(1,ng+1); ntop=col_top[nk]
                for y in range(base, min(top, nbase-1)+1): shipped.add(y)
                for y in range(max(base, ntop+1), top+1): shipped.add(y)
            else:
                for y in range(base, top+1): shipped.add(y)
        for y in sorted(shipped):
            if base<=y<=top: wall.append((x,y,z))
        y0=max(1,g); y1=top
        n=(y1-y0+1)-sum(1 for y in shipped if y0<=y<=y1)
        if n>0:
            latent_quads.extend((x,z,y0,y1)); latent_total+=n
    return wall, latent_quads, latent_total

def close_metric_footprints(col_top, keep_cols, floor):
    """Fill missing X/Z columns inside metric building silhouettes.

    The metric city GLB is a surface asset, not a voxel volume. Sampling it at
    0.25m can leave walls/roofs as a sparse crust, so the later heightfield
    shell reads as hollow when a crop or crater exposes the side. Close each
    2D component, exclude known street/floor cells, and assign added columns
    the nearest sampled top height. The interior still remains latent for
    storage/physics, but exposed cuts now have solid mass behind them.
    """
    keep=set(keep_cols)
    street=set(floor.keys())
    added=0
    dirs=((1,0),(-1,0),(0,1),(0,-1))
    for comp in components_2d(list(keep)):
        if len(comp)<4:
            continue
        target=building_footprint(comp)
        fill=[k for k in target if k not in keep and k not in street]
        if not fill:
            continue
        fill_set=set(fill)
        q=deque()
        seen=set()
        for k in comp:
            if k not in col_top:
                continue
            for dx,dz in dirs:
                nk=(k[0]+dx,k[1]+dz)
                if nk in fill_set and nk not in seen:
                    seen.add(nk); q.append((nk, col_top[k]))
        while q:
            k, top=q.popleft()
            if k in keep or k in street:
                continue
            keep.add(k); col_top[k]=top; added+=1
            for dx,dz in dirs:
                nk=(k[0]+dx,k[1]+dz)
                if nk in fill_set and nk not in seen:
                    seen.add(nk); q.append((nk, top))
    return keep, added

def prune_floating(layers, floor_band=(-2,2), min_grounded=8):
    """Drop floating-island scatter from sparse reconstructions.

    Keep the single largest 6-connected solid component plus any component
    that is grounded (has a voxel in the floor band) and is not tiny debris.
    Everything else — deep floaters, high islands, speckle — is dropped.
    """
    solid=set()
    for pts in layers.values():
        for p in pts: solid.add(tuple(p))
    if not solid:
        return layers
    remain=set(solid)
    dirs=[(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]
    comps=[]
    while remain:
        start=remain.pop(); comp=[start]; q=deque([start])
        while q:
            x,y,z=q.popleft()
            for dx,dy,dz in dirs:
                nb=(x+dx,y+dy,z+dz)
                if nb in remain:
                    remain.remove(nb); q.append(nb); comp.append(nb)
        comps.append(comp)
    lo,hi=floor_band
    keep=set(max(comps, key=len))
    for comp in comps:
        if len(comp)>=min_grounded and any(lo<=y<=hi for _,y,_ in comp):
            keep.update(comp)
    pruned=defaultdict(list)
    for name, pts in layers.items():
        for p in pts:
            if tuple(p) in keep: pruned[name].append(p)
    return pruned

def prune_tiny_components(layers, min_size=None):
    """Strict isolated-voxel / tiny-clump removal (KJ 2026-07-19).

    Independent of grounding: any 6-connected solid component with fewer than
    `min_size` voxels (default 3, override via TINY_CLUMP_MIN) is deleted
    outright — a lone speck (0 neighbours) or a 2-block scatter. Runs on
    structural mass ONLY; call it BEFORE vegetation so real tree trunks and the
    deliberately-sparse canopy leaves authored later are never touched. This is
    an explicit belt-and-suspenders guarantee on top of prune_floating (which is
    a heuristic keyed on the largest component + grounded mass); the two compose.
    """
    if min_size is None:
        min_size=int(os.environ.get("TINY_CLUMP_MIN", "3"))
    if min_size<=1:
        return layers
    solid=set()
    for pts in layers.values():
        for p in pts: solid.add(tuple(p))
    if not solid:
        return layers
    remain=set(solid)
    dirs=[(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]
    keep=set()
    while remain:
        start=remain.pop(); comp=[start]; q=deque([start])
        while q:
            x,y,z=q.popleft()
            for dx,dy,dz in dirs:
                nb=(x+dx,y+dy,z+dz)
                if nb in remain:
                    remain.remove(nb); q.append(nb); comp.append(nb)
        if len(comp)>=min_size:
            keep.update(comp)
    pruned=defaultdict(list)
    for name, pts in layers.items():
        for p in pts:
            if tuple(p) in keep: pruned[name].append(p)
    return pruned

def decorate_vegetation(layers, floor, occupied, wall_cols, avoid_tree=None):
    # avoid_tree(x,z)->bool vetoes TREE sites only (shrubs/ground cover still
    # allowed) — used to keep a clearing around the super tree so it reads as
    # the differentiated landmark (KJ 2026-07-14).
    if not floor:
        return {"trees": 0, "shrubs": 0, "ground": 0, "treeRecords": []}

    xs=[x for x,_ in floor.keys()]
    zs=[z for _,z in floor.keys()]
    span=max(max(xs)-min(xs), max(zs)-min(zs), 1)
    floor_items=list(floor.items())

    def open_floor(x, z, radius=1):
        if (x,z) in wall_cols:
            return False
        y=floor.get((x,z))
        if y is None:
            return False
        for dx in range(-radius, radius+1):
            for dz in range(-radius, radius+1):
                if (x+dx,z+dz) in wall_cols:
                    return False
                if (x+dx,z+dz) not in floor:
                    return False
        return True

    def add(layer, x, y, z):
        p=(int(x),int(y),int(z))
        if p in occupied:
            return False
        occupied.add(p)
        layers[layer].append(p)
        return True

    n=len(floor_items)
    tree_budget=max(14, min(110, n//140))
    shrub_budget=max(40, min(260, n//28))
    ground_budget=max(200, min(1500, n//9))
    species={
        'nyc_honeylocust': {'height':(8,12),'crown':(4.2,2.8),'spacing':7.0,'shade':0.58,'moisture':0.48,'slope':0.72,'branches':5,'angle':0.66},
    }
    dirs=((1,0),(-1,0),(0,1),(0,-1),(1,1),(-1,1),(1,-1),(-1,-1))
    min_y=min(y for _,y in floor_items); max_y=max(y for _,y in floor_items)
    relief=max(1,max_y-min_y)

    def site_metrics(x,z,y):
        local=[]
        for dx in range(-2,3):
            for dz in range(-2,3):
                yy=floor.get((x+dx,z+dz))
                if yy is not None: local.append(yy)
        if len(local)<18:
            return None
        slope=max(local)-min(local)
        flatness=math.exp(-0.48*slope)
        gx=(floor.get((x+2,z),y)-floor.get((x-2,z),y))/4.0
        gz=(floor.get((x,z+2),y)-floor.get((x,z-2),y))/4.0
        gl=math.hypot(gx,gz) or 1.0
        soil=sum((x+dx,z+dz) in floor for dx in range(-2,3) for dz in range(-2,3))/25.0
        open_dirs=[]
        for dx,dz in dirs:
            reach=12
            for step in range(1,13):
                k=(x+dx*step,z+dz*step)
                fy=floor.get(k)
                if k in wall_cols or (fy is not None and fy>y+3):
                    reach=step-1; break
                if fy is None:
                    reach=max(0,step-2); break
            open_dirs.append(reach/12.0)
        sunlight=sum(open_dirs)/len(open_dirs)
        available=sum(1 for v in open_dirs if v>=0.45)/len(open_dirs)
        elevation=(y-min_y)/relief
        basin=1.0-elevation
        moisture=max(0.0,min(1.0,0.18+0.62*basin+0.20*((hash2(x//7,z//7)&255)/255.0)))
        sx=sum(dirs[i][0]*open_dirs[i] for i in range(len(dirs)))
        sz=sum(dirs[i][1]*open_dirs[i] for i in range(len(dirs)))
        sl=math.hypot(sx,sz) or 1.0
        return {'sunlight':sunlight,'flatness':flatness,'soil':soil,'available':available,
                'moisture':moisture,'elevation':elevation,'slope':slope,
                'lightDir':(sx/sl,sz/sl),'slopeDir':(gx/gl,gz/gl),'openDirs':open_dirs}

    def species_fit(name,m):
        p=species[name]
        shade_fit=1.0-abs(m['sunlight']-p['shade'])*0.62
        moisture_fit=1.0-abs(m['moisture']-p['moisture'])*0.78
        slope_fit=max(0.2,1.0-m['slope']*(1.0-p['slope'])*0.45)
        return max(0.01,shade_fit*moisture_fit*slope_fit)

    candidates=[]
    sample_mod=max(5,min(45,n//max(1,tree_budget*18)))
    for (x,z),y in floor_items:
        h=hash2(x,z)
        if h%sample_mod or not open_floor(x,z,1):
            continue
        m=site_metrics(x,z,y)
        if not m:
            continue
        base=(0.12+0.88*m['sunlight'])*(0.20+0.80*m['soil'])*(0.18+0.82*m['flatness'])*(0.20+0.80*m['available'])
        variation=0.72+0.56*((hash2(x+91,z-47)&0xffff)/65535.0)
        weight=max(0.001,base*variation)
        u=max(1e-6,((hash2(x-311,z+719)&0xffffff)+1)/16777217.0)
        candidates.append((-math.log(u)/weight,h,x,y,z,m))
    candidates.sort(key=lambda row:row[0])

    planted=[]; records=[]
    now_ms=int(time.time()*1000)

    def line(a,b,layer='trunks',radius=0):
        ax,ay,az=a; bx,by,bz=b
        steps=max(1,int(math.ceil(max(abs(bx-ax),abs(by-ay),abs(bz-az))*1.5)))
        for i in range(steps+1):
            t=i/steps; px=round(ax+(bx-ax)*t); py=round(ay+(by-ay)*t); pz=round(az+(bz-az)*t)
            for rx in range(-radius,radius+1):
                for rz in range(-radius,radius+1):
                    if rx*rx+rz*rz<=radius*radius: add(layer,px+rx,py,pz+rz)

    def grow_tree(name,seed,x,y,z,m,competition):
        p=species[name]; r01=(seed&0xffff)/65535.0
        stress=max(0.58,min(1.08,0.72+0.30*m['sunlight']+0.16*m['soil']-0.18*competition))
        height=max(5,round((p['height'][0]+(p['height'][1]-p['height'][0])*r01)*stress))
        lean=(0.10+0.28*(1.0-m['sunlight']))
        lx,lz=m['lightDir']; top=(x+lx*height*lean,y+height,z+lz*height*lean)
        line((x,y+1,z),top,'trunks',1 if height>=11 else 0)
        tips=[]
        levels=2
        queue=[]
        # Honey locusts form open, ascending crowns from limbs that emerge at
        # different heights. A shared branch origin made every terminal lobe
        # land in one horizontal band, reading as a clipped, flat canopy.
        primary_count=p['branches']
        for k in range(primary_count):
            hh=hash2(seed+k*977,x-z)
            angle=2*math.pi*((k/primary_count)+((hh&255)/255.0-0.5)*0.22)
            light_bias=0.22+0.30*(1.0-m['sunlight'])
            dx=math.cos(angle)*(1-light_bias)+lx*light_bias
            dz=math.sin(angle)*(1-light_bias)+lz*light_bias
            dl=math.hypot(dx,dz) or 1.0; dx/=dl; dz/=dl
            emerge=0.48+0.40*((hh>>8&255)/255.0)
            origin=(x+(top[0]-x)*emerge,y+1+height*emerge,z+(top[2]-z)*emerge)
            branch_len=p['crown'][0]*(0.68+0.42*((hh>>16&255)/255.0))
            rise=branch_len*(0.30+0.46*((hh>>24&255)/255.0))
            end=(origin[0]+dx*branch_len,origin[1]+rise,origin[2]+dz*branch_len)
            line(origin,end,'trunks',0)
            queue.append((end,(dx,rise/max(1,branch_len),dz),0))
        for level in range(levels):
            nxt=[]
            for origin,parent_dir,_ in queue:
                count=2 if level == 0 else 1
                for k in range(count):
                    hh=hash2(seed+k*977+level*131+round(origin[1])*31,x-z)
                    angle=math.atan2(parent_dir[2],parent_dir[0]) + (k-0.5)*(0.72+0.32*((hh&255)/255.0))
                    dx=math.cos(angle)*0.78+parent_dir[0]*0.22
                    dz=math.sin(angle)*0.78+parent_dir[2]*0.22
                    dl=math.hypot(dx,dz) or 1.0; dx/=dl; dz/=dl
                    branch_len=p['crown'][0]*(0.52-level*0.16)*(0.72+0.42*((hh>>8&255)/255.0))
                    rise=branch_len*(0.18+0.48*((hh>>16&255)/255.0))
                    end=(origin[0]+dx*branch_len,origin[1]+rise,origin[2]+dz*branch_len)
                    line(origin,end,'trunks',0)
                    nxt.append((end,(dx,rise/max(1,branch_len),dz),level+1))
            queue=nxt; tips.extend(o for o,_,_ in queue)
        crown_x=max(1.8,p['crown'][0]*(0.72+0.34*m['sunlight'])*(1-0.20*competition))
        crown_y=max(1.8,p['crown'][1]*(1.12-0.22*m['sunlight']))
        crown_z=crown_x*(0.88+0.18*((seed>>16&255)/255.0))
        for lobe_i,(tx,ty,tz) in enumerate(tips or [top]):
            lh=hash2(seed+lobe_i*1597,round(tx)*31+round(tz))
            lobe_x=crown_x*(0.38+0.18*((lh&255)/255.0))
            lobe_y=crown_y*(0.46+0.28*((lh>>8&255)/255.0))
            lobe_z=crown_z*(0.38+0.18*((lh>>16&255)/255.0))
            ty += ((lh>>24&255)/255.0-0.35)*1.4
            for dx in range(-math.ceil(lobe_x),math.ceil(lobe_x)+1):
                for dy in range(-math.ceil(lobe_y),math.ceil(lobe_y)+1):
                    for dz in range(-math.ceil(lobe_z),math.ceil(lobe_z)+1):
                        q=(dx/lobe_x)**2+(dy/lobe_y)**2+(dz/lobe_z)**2
                        noise=((hash2(round(tx)+dx+seed,round(tz)+dz-dy*17)&255)/255.0-0.5)*0.34
                        # Perforated, irregular leaf masses preserve the fine,
                        # airy honey-locust silhouette instead of a solid cap.
                        pore=((hash2(round(tx)+dx*13,round(tz)+dz*17+seed)&1023)/1023.0)
                        if q+noise<=1.0 and not (q>0.38 and pore<0.10):
                            add('leaves',round(tx)+dx,round(ty)+dy,round(tz)+dz)
        root_reach=max(2,round(p['spacing']*0.45))
        for dx,dz in dirs[:4]:
            rr=root_reach if floor.get((x+dx*root_reach,z+dz*root_reach),y)>=y-1 else max(1,root_reach-1)
            line((x,y,z),(x+dx*rr,y-(1 if m['slope'] else 0),z+dz*rr),'trunks',0)
        return height,stress

    for _,h,x,y,z,m in candidates:
        if len(planted)>=tree_budget:
            break
        if avoid_tree and avoid_tree(x,z):
            continue
        nearest=min((math.hypot(x-t['x'],z-t['z'])/t['spacing'] for t in planted),default=99.0)
        competition=max(0.0,1.0-nearest/2.2) if planted else 0.0
        name=max(species,key=lambda candidate:species_fit(candidate,m))
        spacing=species[name]['spacing']*(0.84+0.28*((h>>8&255)/255.0))
        if any((x-t['x'])**2+(z-t['z'])**2 < ((spacing+t['spacing'])*0.5)**2 for t in planted):
            continue
        seed=hash2(h^0x6d2b79f5,x+z)
        height,stress=grow_tree(name,seed,x,y,z,m,competition)
        planted.append({'x':x,'z':z,'spacing':spacing})
        age_hours=5.0+10.0*((seed>>5&0xffff)/65535.0)
        records.append({'type':'ltree','species':name,'seed':seed,'plantedAtMs':now_ms-round(age_hours*3600000),
                        'ageHours':round(age_hours,3),'origin':[x,y,z],'growthStage':3 if age_hours>=12 else 2,
                        'lightScore':round(m['sunlight'],4),'moistureScore':round(m['moisture'],4),
                        'flatnessScore':round(m['flatness'],4),'soilDepthScore':round(m['soil'],4),
                        'elevationScore':round(m['elevation'],4),'competition':round(competition,4),
                        'lightDirection':[round(m['lightDir'][0],4),round(m['lightDir'][1],4)],
                        'slopeDirection':[round(m['slopeDir'][0],4),round(m['slopeDir'][1],4)],
                        'matureHeight':height,'growthStress':round(stress,4),'pruningHistory':[]})

    shrubs=0
    ground=0
    for (x,z), y in floor_items:
        if (x,z) in wall_cols:
            continue
        h=hash2(x+17,z-31)
        if shrubs < shrub_budget and (h % 1000) < 120 and open_floor(x,z,0):
            for dx,dz in ((0,0),(1,0),(0,1)) if h % 2 == 0 else ((0,0),(-1,0),(0,-1)):
                if add('leaves', x+dx, y+1, z+dz):
                    shrubs += 1
            if h % 7 == 0 and add('fruit', x, y+2, z):
                shrubs += 1
        elif ground < ground_budget and (h % 1000) < 220 and open_floor(x,z,0):
            # Flower-patch clustering: grass tufts with occasional blossoms.
            if add('grass', x, y+1, z):
                ground += 1
            if (h % 6) == 0:
                for dx,dz in ((1,0),(0,1)):
                    if add('grass', x+dx, y+1, z+dz):
                        ground += 1
            if (h % 11) == 0 and add('fruit', x, y+1, z):
                ground += 1

    return {"trees": len(planted), "shrubs": shrubs, "ground": ground,
            "species": dict(Counter(r['species'] for r in records)),
            "model": "environmental-nyc-v1", "treeRecords": records}

def convert(path):
    tris, mn, mx = load_triangles(path)
    tris, mn, mx, rot_deg = rotate_to_cardinal(tris)
    span=float(max(mx-mn)) or 1.0
    # Fixed metric voxel size (meters/voxel) => true, consistent world scale.
    # 0.25m per KJ (2026-07-10): finer massing for the dead city; the analytic
    # metric_shell path keeps memory flat at this resolution. Set VOXEL_M="auto"
    # to restore the old span/TARGET_DIVS normalization for scale-ambiguous scans.
    _vm=os.environ.get("VOXEL_M", "0.25")
    # Floor lowered 0.025→0.015 (2026-07-11): iPhone-scan real detail bottoms out
    # ~2-5cm, so 1.5cm is the useful limit; 1cm rejected (~30M blocks, 10x budget).
    voxel=max(span/TARGET_DIVS, 0.015) if _vm=="auto" else max(float(_vm), 0.015)
    # metric = complete gravity-aligned real-meter GLB (Google tiles): trust the
    # geometry directly. auto = scan reconstructions: keep the shell-repair
    # machinery (classification, footprint fill, dominant-plane snap).
    metric=_vm!="auto"
    centerX=float((mn[0]+mx[0])/2); centerZ=float((mn[2]+mx[2])/2)
    # CROP runs discard columns outside the box anyway; dropping triangles
    # entirely outside it first makes fine-voxel (0.1m + STEP_CAP=400) runs
    # affordable. Same box as the column crop: voxel index 0 = rotated center.
    _crop=float(os.environ.get("CROP", "0") or 0)
    # CROP_RECT="x0,x1,z0,z1" (meters, rotated frame, relative to mesh center):
    # off-center rectangular crop for strips like a rowhouse block — the square
    # CROP can't reach buildings far from the mesh center without ballooning
    # the column count past the client's build budget.
    _rect=os.environ.get("CROP_RECT", "")
    _rect=[float(v) for v in _rect.split(",")] if _rect else None
    if _rect:
        _x0,_x1,_z0,_z1=(v for v in _rect)
        _pre=len(tris)
        tris=[t for t in tris
              if not (max(t[0][0],t[1][0],t[2][0])<centerX+_x0-2.5 or min(t[0][0],t[1][0],t[2][0])>centerX+_x1+2.5
                      or max(t[0][2],t[1][2],t[2][2])<centerZ+_z0-2.5 or min(t[0][2],t[1][2],t[2][2])>centerZ+_z1+2.5)]
        print(f'crop-rect pre-filter: {_pre} -> {len(tris)} triangles')
    elif _crop>0:
        _m=_crop+2.5
        _pre=len(tris)
        tris=[t for t in tris
              if not (max(t[0][0],t[1][0],t[2][0])<centerX-_m or min(t[0][0],t[1][0],t[2][0])>centerX+_m
                      or max(t[0][2],t[1][2],t[2][2])<centerZ-_m or min(t[0][2],t[1][2],t[2][2])>centerZ+_m)]
        print(f'crop pre-filter: {_pre} -> {len(tris)} triangles')
    # Metric path streams samples straight into col_top_raw + per-column y-sets
    # instead of materializing allsurf/wall/ceil lists — at 0.25 m those lists
    # are ~60M tuples (multi-GB) and the metric branch never reads them.
    floor_samples=defaultdict(set); wall=[]; ceil=[]; allsurf=[]
    col_top_raw={}
    for tri in tris:
        a,b,c=tri
        n=np.cross(b-a,c-a); ln=np.linalg.norm(n) or 1.0
        nx,ny,nz=n/ln
        avgY=float((a[1]+b[1]+c[1])/3)
        rel=(avgY-mn[1])/max(1e-9, (mx[1]-mn[1]))
        if metric:
            up=ny>=0.55; down=ny<=-0.55
        else:
            up=abs(ny)>=0.55 and rel<0.60
            down=abs(ny)>=0.55 and rel>=0.45
        e1=np.linalg.norm(b-a); e2=np.linalg.norm(c-a)
        steps=min(STEP_CAP, max(4, int(math.ceil(max(e1,e2)/(voxel*0.5)))))
        for su in range(steps+1):
            for sv in range(steps-su+1):
                u=su/steps; v=sv/steps; w=1-u-v
                p=a*u+b*v+c*w
                vx=int(round((p[0]-centerX)/voxel)); vy=int(round(p[1]/voxel)); vz=int(round((p[2]-centerZ)/voxel))
                if metric:
                    k=(vx,vz)
                    if vy>col_top_raw.get(k,-1<<30): col_top_raw[k]=vy
                    if up: floor_samples[k].add(vy)
                    continue
                allsurf.append((vx,vy,vz))
                if up:
                    floor_samples[(vx,vz)].add(vy)
                elif down:
                    ceil.append((vx,vy,vz))
                else:
                    wall.append((vx,vy,vz))
    if not floor_samples:
        raise SystemExit('no up-facing floor samples in GLB')

    # Pick the dominant walkable plane from up-facing mesh samples, then choose the
    # candidate nearest that plane per column. The previous "lowest up surface"
    # rule often selected undersides/sloped scan noise, producing terraced floors.
    sample_hist=Counter()
    for ys in floor_samples.values():
        for y in set(ys):
            sample_hist[y] += 1
    domY, domCount = sample_hist.most_common(1)[0]
    floor={}
    floor_snap_band=18
    floor_preserved=0
    floor_snapped=0
    if metric:
        # Street-level candidates only (within 8m of the dominant plane), true
        # height kept so avenues preserve their real slope. Columns whose only
        # up-facing samples are roofs get NO floor entry -> covered interior.
        street_band=max(4, int(round(8.0/voxel)))
        for k, ys in floor_samples.items():
            cand=[y for y in set(ys) if abs(y-domY)<=street_band]
            if cand:
                floor[k]=min(cand, key=lambda y: abs(y-domY))
                floor_preserved += 1
    else:
        for k, ys in floor_samples.items():
            uniq=sorted(set(ys))
            best=min(uniq, key=lambda y: (abs(y-domY), abs(y)))
            if abs(best-domY) <= floor_snap_band:
                floor[k]=domY
                floor_snapped += 1
            else:
                floor[k]=best
                floor_preserved += 1

    # Fill small floor gaps.
    for _ in range(2):
        additions=[]
        for (x,z), y in list(floor.items()):
            for dx,dz in ((1,0),(-1,0),(0,1),(0,-1)):
                nk=(x+dx,z+dz)
                if nk in floor: continue
                vals=[floor[(x+dx+adx,z+dz+adz)] for adx,adz in ((1,0),(-1,0),(0,1),(0,-1)) if (x+dx+adx,z+dz+adz) in floor]
                if vals: additions.append((nk, int(round(sum(vals)/len(vals)))))
        for k,y in additions: floor.setdefault(k,y)
    median_smooth_floor(floor)
    hist=Counter(floor.values())
    domY, domCount = hist.most_common(1)[0]
    if not metric:
        # Snap aggressively to dominant plane; this is the old-path behavior KJ wants.
        for k,y in list(floor.items()):
            if abs(y-domY)<=8: floor[k]=domY
    # Rebase so the dominant floor is y=0.
    domY=Counter(floor.values()).most_common(1)[0][0]
    floor={k:y-domY for k,y in floor.items()}
    # Break up the perfectly-flat snapped plane into organic rolling hills.
    # Seed off the source path so each world gets distinct, non-tiling terrain.
    hill_seed=fnv1a(str(Path(path).resolve()))
    if not metric:
        # Metric maps keep their REAL street elevation; synthetic hills would
        # fight the preserved slope and re-terrace the fill above it.
        rolling_hills(floor, seed=hill_seed)
    wall=[(x,y-domY,z) for x,y,z in wall]
    ceil=[(x,y-domY,z) for x,y,z in ceil]
    allsurf=[(x,y-domY,z) for x,y,z in allsurf]
    solid_wall=[]
    ceiling=[]
    wear_stats=None; rubble=[]; latent_quads=[]; latent_total=0; footprint_closed=0; roof_stats=None; dsm_stats=None; facade_stats=None; facade_roofline=None
    if metric:
        # Per-column heightfield. The GLB is a COMPLETE surface shell with real
        # roofs, so each column's highest sample IS its roof. Threshold scales
        # with voxel size (1.5m) so curbs/cars/slope noise stay open at any
        # resolution. Destruction wear digs into col_top BEFORE the shell +
        # latent derivation, so craters become real shell and the mass below
        # them stays latent + physics-solid — always consistent, never a hole.
        col_top={k: v-domY for k,v in col_top_raw.items()}
        min_h=max(2, int(round(1.5/voxel)))
        keep_cols=set()
        for (x,z),top in col_top.items():
            g=floor.get((x,z),0)
            if top < g+min_h: continue
            keep_cols.add((x,z))
        # CROP=<half-extent meters>: hard column crop around the anchor.
        # Full-UES at 0.25m (8.8M blocks / 845M-cell wall grid) exceeds the
        # client's synchronous build budget. Building-whole cropping is
        # useless here — Manhattan buildings touch wall-to-wall, so the whole
        # extract is ~16 4-connected superblocks and a centroid test keeps
        # ~everything. Instead buildings are SLICED at the boundary: the cut
        # flank ships as a full wall via metric_shell's missing-neighbor rule,
        # reading as the island's cut rim (the ground already ends in cliffs).
        crop_m=float(os.environ.get("CROP", "0") or 0)
        crop_rect=os.environ.get("CROP_RECT", "")
        if crop_rect:
            x0,x1,z0,z1=(int(round(float(v)/voxel)) for v in crop_rect.split(","))
            keep_cols={k for k in keep_cols if x0<=k[0]<=x1 and z0<=k[1]<=z1}
            for k in [k for k in floor if not (x0<=k[0]<=x1 and z0<=k[1]<=z1)]:
                del floor[k]
        elif crop_m>0:
            R=int(round(crop_m/voxel))
            keep_cols={k for k in keep_cols if abs(k[0])<=R and abs(k[1])<=R}
            for k in [k for k in floor if abs(k[0])>R or abs(k[1])>R]:
                del floor[k]
        keep_cols, footprint_closed = close_metric_footprints(col_top, keep_cols, floor)
        if DSM_PATH:
            anchor=parse_glb_anchor(path)
            if anchor:
                dsm_stats=apply_dsm_tops(col_top, keep_cols, floor, voxel, centerX, centerZ, rot_deg, anchor, min_h)
        if FACADE_SPEC:
            facade_roofline=flatten_facade_rooflines(col_top, keep_cols, voxel, centerX, centerZ, rot_deg)
        if WEAR_ENABLED:
            wear_seed=fnv1a(str(Path(path).resolve())+":wear")
            wear_stats, rubble = apply_top_wear(col_top, keep_cols, floor, voxel, wear_seed)
            wear_stats["seed"]=int(wear_seed)
        solid_wall, latent_quads, latent_total = metric_shell(col_top, keep_cols, floor)
    else:
        # Keep wall columns with real vertical support and connect them to floor.
        wall_cols={}
        for x,y,z in wall:
            if y<=0: continue
            k=(x,z); col=wall_cols.setdefault(k, [y,y,0])
            col[0]=min(col[0],y); col[1]=max(col[1],y); col[2]+=1
        keep_cols=connected_keep([k for k,c in wall_cols.items() if c[2]>=3], min_size=6)
        # No synthetic roof/ceiling lids. Earlier versions closed each wall
        # silhouette with a one-voxel cap, which hid hollow interiors but looked
        # like a flat "ceiling style" instead of respecting source geometry.
        # Keep only sampled/supporting wall columns here; metric city GLBs use
        # metric_shell above, where true roof height comes from the source top
        # samples and interiors stay latent/solid for tunneling.
        for x,z in keep_cols:
            y0,y1,_=wall_cols[(x,z)]
            base=max(1, floor.get((x,z),0)+1, y0)
            for y in range(base, max(base,y1)+1):
                solid_wall.append((x,y,z))
    # Light eroded-cliff relief on the void-adjacent rim (underside only -> never
    # affects walkability). Separate sub-seed so cliffs vary independently of hills.
    cliff_seed=fnv1a(str(Path(path).resolve())+":cliff")
    cliff_dirt, cliff_stone = cliff_edges(floor, seed=cliff_seed)
    if metric:
        # Direct final assembly. metric_shell already emitted exposure-culled
        # wall + the latent interior rule, a heightfield fill can't produce
        # floaters, and the layers are disjoint by construction (floor at g,
        # dirt at g-1, cliffs below, wall from g+1 up, rubble on open street) —
        # so the scan-era occupied-set dedupe, prune_floating and set-based
        # visibility cull (multi-GB at 0.25 m) are all skipped.
        final=defaultdict(list)
        for (x,z),y in floor.items():
            final['dryGrass'].append((x,y,z))
            final['dirt'].append((x,y-1,z))
        for p in cliff_dirt: final['dirt'].append(p)
        for p in cliff_stone: final['stone'].append(p)
        for p in rubble: final['stone'].append(p)
        final['wall']=solid_wall
        if os.environ.get("NO_VEG", "0")=="1":
            vegetation_stats={"trees":0,"shrubs":0,"ground":0,"treeRecords":[]}
        else:
            occupied=set()
            for pts in final.values():
                occupied.update(tuple(p) for p in pts)
            vegetation_stats=decorate_vegetation(final, floor, occupied, keep_cols)
        if ORTHO_ENABLED:
            anchor=parse_glb_anchor(path)
            if anchor:
                roof_stats=recolor_roofs(final, col_top, keep_cols, voxel, centerX, centerZ, rot_deg, anchor)
        if FACADE_SPEC:
            anchor=parse_glb_anchor(path)
            if anchor:
                facade_stats=apply_facade_relief(final, col_top, keep_cols, floor, voxel, centerX, centerZ, rot_deg, anchor)
    else:
        # Floor layer: one flat visible floor per column, plus underside island mass.
        layers=defaultdict(list)
        for (x,z),y in floor.items():
            layers['dryGrass'].append((x,y,z))
            # underside depth tapers inward to keep the Laputa island look without hiding the floor.
            layers['dirt'].append((x,y-1,z))
        for p in cliff_dirt: layers['dirt'].append(p)
        for p in cliff_stone: layers['stone'].append(p)
        for p in solid_wall: layers['wall'].append(p)
        # Do not emit generated ceiling/lid geometry from the fallback path.
        # Real roof mass should come from metric heightfield tops or source
        # surface samples preserved as wall/stone, not an invented ceiling layer.
        occupied=set()
        ordered=['dryGrass','dirt','wall']
        for name in ordered:
            uniq=[]
            for p in layers[name]:
                if p in occupied: continue
                occupied.add(p); uniq.append(p)
            layers[name]=uniq
        # Preserve non-structural surface details as stone/metal accents when not
        # colliding. These remain part of the structural scan pass.
        for x,y,z in set(allsurf):
            if y<=0 or (x,y,z) in occupied: continue
            if (x,z) in keep_cols: continue
            if len(layers['stone']) < 6000:
                layers['stone'].append((x,y,z)); occupied.add((x,y,z))
        # Remove unsupported scan noise before authoring vegetation. Regular
        # trees are deliberately added after this pass, so real trunks and
        # canopy branches can never be mistaken for scan floaters. Vegetation
        # is not part of this structural cleanup: it is authored below.
        layers=prune_floating(layers)
        # Strict follow-up: nuke isolated specks / <3-block scatter that the
        # connected-component heuristic above is not built to target (KJ
        # 2026-07-19). Still before vegetation, so trees stay safe.
        layers=prune_tiny_components(layers)
        occupied=set()
        for pts in layers.values():
            for p in pts: occupied.add(tuple(p))
        # Structural scan cleanup is complete before vegetation is authored.
        # Generated trees/plants are intentionally added afterward, so the
        # support-connected floater pass removes scan noise without deleting
        # legitimate tree trunks or overhanging canopies.
        if os.environ.get("NO_VEG", "0")=="1":
            vegetation_stats={"trees":0,"shrubs":0,"ground":0}
        else:
            vegetation_stats=decorate_vegetation(layers, floor, occupied, keep_cols)
        # Visibility cull with hidden_dirt for solid interiors.
        dirs=[(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]
        final=defaultdict(list); hidden=[]
        for name, pts in layers.items():
            for p in pts:
                x,y,z=p
                exposed=any((x+dx,y+dy,z+dz) not in occupied for dx,dy,dz in dirs)
                if exposed: final[name].append(p)
                elif name=='dirt': hidden.append(p)
        if hidden: final['hidden_dirt']=hidden
    encoded={k:b64_i32(v) for k,v in final.items() if v}
    block_count=sum(len(v) for v in final.values())
    xs=[]; ys=[]; zs=[]
    for pts in final.values():
        for x,y,z in pts: xs.append(x); ys.append(y); zs.append(z)
    meta={
        'voxel': voxel,
        'span': int(max(max(xs)-min(xs), max(zs)-min(zs))) if xs else 0,
        'centerX': 0,
        'centerZ': 0,
        'blockCount': block_count,
        'resolution': int(max(max(xs)-min(xs), max(zs)-min(zs))) if xs else 0,
        'weatherSeason': 'summer',
        'sourceName': Path(path).name,
        'inferredFrom': {
            'source':'aligned-glb-old-path',
            'model':'COLMAP/OpenMVS aligned GLB + TinyWorld GLB voxelizer mirror',
            'mesh_vertices': int(sum(len(t) for t in tris)),
            'mesh_triangles': int(len(tris)),
            'floor_plane': 'true-street-height' if metric else 'dominant-low-plane+rolling-hills-noise',
            'solid_fill': 'per-column-heightfield' if metric else 'source-wall-columns-no-generated-ceiling',
            'hills': {'amplitude': HILL_AMPLITUDE, 'wavelength': HILL_WAVELENGTH,
                      'method': 'value-noise-3oct', 'seed': int(hill_seed)},
            'cliffs': {'depth': CLIFF_DEPTH, 'wavelength': CLIFF_WAVELENGTH,
                       'method': 'value-noise-edge', 'seed': int(cliff_seed)},
            'rotated_deg': int(rot_deg),
            'vegetation': {
                'style': 'environmental-nyc-v1',
                **vegetation_stats,
            },
        },
        'savedAt': int(time.time()*1000),
        # Regular trees are authored exactly once by this voxelization pass.
        # Runtime clients must preserve the emitted voxels and records verbatim.
        'treesUpgraded': True,
        'treeUpgradeVersion': 3,
        'treeRecords': vegetation_stats.get('treeRecords', []),
    }
    if latent_total:
        meta['latentCols']=b64_i32(latent_quads)
        meta['latentTotal']=latent_total
        meta['latentVersion']=1
        meta['inferredFrom']['latent_interior']={'columns':len(latent_quads)//4,'total':latent_total,'mode':'per-column-rule'}
    if wear_stats:
        meta['inferredFrom']['wear']={**wear_stats, 'rubble': len(rubble), 'mode': 'top-crater-noise'}
    if roof_stats:
        meta['inferredFrom']['roof_ortho']=roof_stats
    if dsm_stats:
        meta['inferredFrom']['dsm_tops']=dsm_stats
    if facade_stats:
        meta['inferredFrom']['facade_relief']=facade_stats
    if facade_roofline:
        meta['inferredFrom']['facade_roofline']=facade_roofline
    if metric:
        meta['inferredFrom']['footprint_close']={'added_columns': int(footprint_closed), 'mode': 'xz-fill-nearest-top-excluding-streets'}
    return {'layers':encoded,'meta':meta}, block_count, meta

if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('glb')
    ap.add_argument('out')
    args=ap.parse_args()
    payload, count, meta=convert(args.glb)
    Path(args.out).write_text(json.dumps(payload))
    print(json.dumps({'out':args.out,'blockCount':count,'meta':meta}, indent=2))
