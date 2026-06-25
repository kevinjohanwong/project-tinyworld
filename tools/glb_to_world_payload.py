import argparse, base64, json, math, sqlite3, time
from collections import Counter, defaultdict, deque
from pathlib import Path
import numpy as np
import trimesh

TARGET_DIVS=int(__import__("os").environ.get("TARGET_DIVS", "345"))
MAX_TRIANGLES=220000

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

def convert(path):
    tris, mn, mx = load_triangles(path)
    tris, mn, mx, rot_deg = rotate_to_cardinal(tris)
    span=float(max(mx-mn)) or 1.0
    voxel=max(span/TARGET_DIVS, 0.025)
    centerX=float((mn[0]+mx[0])/2); centerZ=float((mn[2]+mx[2])/2)
    floor={}; wall=[]; ceil=[]; allsurf=[]
    for tri in tris:
        a,b,c=tri
        n=np.cross(b-a,c-a); ln=np.linalg.norm(n) or 1.0
        nx,ny,nz=n/ln
        avgY=float((a[1]+b[1]+c[1])/3)
        rel=(avgY-mn[1])/max(1e-9, (mx[1]-mn[1]))
        up=abs(ny)>=0.55 and rel<0.60
        down=abs(ny)>=0.55 and rel>=0.45
        e1=np.linalg.norm(b-a); e2=np.linalg.norm(c-a)
        steps=min(120, max(4, int(math.ceil(max(e1,e2)/(voxel*0.5)))))
        for su in range(steps+1):
            for sv in range(steps-su+1):
                u=su/steps; v=sv/steps; w=1-u-v
                p=a*u+b*v+c*w
                vx=int(round((p[0]-centerX)/voxel)); vy=int(round(p[1]/voxel)); vz=int(round((p[2]-centerZ)/voxel))
                allsurf.append((vx,vy,vz))
                if up:
                    k=(vx,vz); prev=floor.get(k)
                    if prev is None or vy<prev: floor[k]=vy
                elif down:
                    ceil.append((vx,vy,vz))
                else:
                    wall.append((vx,vy,vz))
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
    # Snap aggressively to dominant plane; this is the old-path behavior KJ wants.
    for k,y in list(floor.items()):
        if abs(y-domY)<=4: floor[k]=domY
    # Rebase so the dominant floor is y=0.
    domY=Counter(floor.values()).most_common(1)[0][0]
    floor={k:y-domY for k,y in floor.items()}
    wall=[(x,y-domY,z) for x,y,z in wall]
    ceil=[(x,y-domY,z) for x,y,z in ceil]
    allsurf=[(x,y-domY,z) for x,y,z in allsurf]
    # Keep wall columns with real vertical support and connect them to floor.
    wall_cols={}
    for x,y,z in wall:
        if y<=0: continue
        k=(x,z); col=wall_cols.setdefault(k, [y,y,0])
        col[0]=min(col[0],y); col[1]=max(col[1],y); col[2]+=1
    keep_cols=connected_keep([k for k,c in wall_cols.items() if c[2]>=3], min_size=6)
    solid_wall=[]
    for k in keep_cols:
        x,z=k; miny,maxy,_=wall_cols[k]
        base=max(1, floor.get(k,0)+1)
        for y in range(base, maxy+1): solid_wall.append((x,y,z))
    # Ceiling: dominant high support across kept wall columns, but only if plausible.
    ceil_cols=defaultdict(list)
    for x,y,z in ceil:
        if y>2: ceil_cols[(x,z)].append(y)
    med_ceil=[]
    for k,ys in ceil_cols.items():
        ys.sort(); med_ceil.append((k, ys[len(ys)//2]))
    ceiling=[]
    if med_ceil:
        ch=Counter(y for _,y in med_ceil); domC,_=ch.most_common(1)[0]
        for (x,z), y in med_ceil:
            if y>=3: ceiling.append((x,y,z))
    # Floor layer: one flat visible floor per column, plus underside island mass.
    layers=defaultdict(list)
    for (x,z),y in floor.items():
        layers['dryGrass'].append((x,y,z))
        # underside depth tapers inward to keep the Laputa island look without hiding the floor.
        layers['dirt'].append((x,y-1,z))
    for p in solid_wall: layers['wall'].append(p)
    for p in ceiling: layers['ceiling'].append(p)
    # Preserve non-structural surface details as stone/metal accents when not colliding.
    occupied=set()
    ordered=['dryGrass','dirt','wall','ceiling']
    for name in ordered:
        uniq=[]
        for p in layers[name]:
            if p in occupied: continue
            occupied.add(p); uniq.append(p)
        layers[name]=uniq
    for x,y,z in set(allsurf):
        if y<=0 or (x,y,z) in occupied: continue
        if (x,z) in keep_cols: continue
        if len(layers['stone']) < 6000:
            layers['stone'].append((x,y,z)); occupied.add((x,y,z))
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
            'floor_plane': 'dominant-low-plane',
            'rotated_deg': int(rot_deg),
        },
        'savedAt': int(time.time()*1000),
    }
    return {'layers':encoded,'meta':meta}, block_count, meta

if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('glb')
    ap.add_argument('out')
    args=ap.parse_args()
    payload, count, meta=convert(args.glb)
    Path(args.out).write_text(json.dumps(payload))
    print(json.dumps({'out':args.out,'blockCount':count,'meta':meta}, indent=2))
