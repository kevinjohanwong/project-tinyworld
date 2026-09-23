// Validate the "solid walls + floor" fix: voxelize the debug scan through the
// STAGING worker, build the latent-underside oracle from the worker's OWN
// latentCols (solid from the walkable floor downward — NOT the tallest voxel),
// then run the production settle+flow and confirm water is contained: it rests
// on the floor, never drips into a void column, never drills below the floor
// crust. Compares latent-ON vs latent-OFF (raw thin shell) to prove the fix.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "ignore" });
const { voxelize } = await import("./voxelizer.mjs");
const { siteSpring } = await import("./siting.mjs");
const { emitAndSettle, stepFluid, emitterCell, springEmit } =
  await import("/__substrate/space/src/water-spring.ts");

const buf = readFileSync(HERE + "fixtures/debug-scan-small.glb");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const res = await voxelize(ab, null);

const VIS = ["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"];
const K = (x,z)=>`${x},${z}`;
const cm = new Map();
for (const n of VIS){ const b=res.layers[n]; if(!b) continue; const a=new Int32Array(b);
  for(let i=0;i<a.length;i+=3){ const k=K(a[i],a[i+2]); let s=cm.get(k); if(!s){s=new Set();cm.set(k,s);} s.add(a[i+1]); } }

// Latent underside oracle from the worker's latentCols quads (x,z,y0,y1) —
// every y in [y0,y1] is solid, exactly as the client's latentSolidAt treats it.
const latCols = new Map();
if (res.latentCols && res.latentCols.byteLength) {
  const q = new Int32Array(res.latentCols);
  for (let i=0;i+3<q.length;i+=4) latCols.set(K(q[i],q[i+1]), [q[i+2],q[i+3]]);
}
console.log(`latent columns: ${latCols.size}  (cells to y0)`);

const explicitSolid = (x,y,z)=>cm.get(K(x,z))?.has(y)??false;
const latentSolid = (x,y,z)=>{ const r=latCols.get(K(x,z)); return !!r && y>=r[0] && y<=r[1]; };
const solidWithLatent = (x,y,z)=> explicitSolid(x,y,z) || latentSolid(x,y,z);
const solidRaw = explicitSolid;

const topOf=(x,z)=>{ const s=cm.get(K(x,z)); if(!s) return null; let m=-Infinity; for(const y of s) if(y>m)m=y; return m; };
// Walkable floor top per column: lowest solid run's top (the ground you stand
// on), ignoring the ceiling. Used only to score "did water sit on the floor".
const floorTopOf=(x,z)=>{ const s=cm.get(K(x,z)); if(!s) return null; const ys=[...s].sort((a,b)=>a-b);
  let top=ys[0]; for(let i=1;i<ys.length;i++){ if(ys[i]===top+1) top=ys[i]; else break; } return top; };

const site = await siteSpring(HERE + "fixtures/debug-scan-small.glb");
const origin = [site.origin.x, site.origin.y, site.origin.z];
console.log(`siting: ${site.siting} @ [${origin}]  depth=${site.basinDepth}  onFloor=${site.onDominantFloor}`);
const emitter = emitterCell(origin);
const PER_TICK=8,CAP=7200,FILL_RADIUS=24,MAX_RISE=6,SPREAD=16,MAXSCAN=200,EDGE=5,FLOW_DROP=26,DRAINCAP=1;

function run(solid){
  const floorY=origin[1]-FLOW_DROP; const dwell=new Map();
  let body=new Set(),state={budget:CAP,capacity:CAP},tickN=0,credit=0;
  for(let s=1;s<=160;s++){
    const r=springEmit(state,emitter,PER_TICK);
    if(r.emit){state=r.state;body=emitAndSettle(body,solid,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:CAP,maxRise:MAX_RISE});}
    credit+=1.5;while(credit>=1){credit-=1;tickN++;body=stepFluid(body,solid,{floorY,tick:tickN,maxCells:CAP,spreadRange:SPREAD,maxScan:MAXSCAN,edgeHold:EDGE,dwell,maxDrainPerCol:DRAINCAP});}
  }
  const top=new Map(); for(const k of body){const[x,y,z]=k.split(",").map(Number);const kk=K(x,z);const p=top.get(kk);if(p===undefined||y>p)top.set(kk,y);}
  let voidCols=0, belowFloor=0, minY=Infinity,maxY=-Infinity;
  for(const[kk,wy] of top){ const[x,z]=kk.split(",").map(Number);
    if(!cm.has(kk) && !latCols.has(kk)) voidCols++;              // no solid at all under this column
    const ft=floorTopOf(x,z); if(ft!==null && wy < ft) belowFloor++;   // water sank under the floor
    if(wy<minY)minY=wy; if(wy>maxY)maxY=wy; }
  return { cells:body.size, footprint:top.size, voidCols, belowFloor, minY, maxY, floorY };
}

const off = run(solidRaw);
const on  = run(solidWithLatent);
const fmt = r => `cells=${r.cells} footprint=${r.footprint} voidCols=${r.voidCols} belowFloor=${r.belowFloor} yRange=${r.minY}..${r.maxY} (floorCull=${r.floorY})`;
console.log(`\n[RAW shell   ] ${fmt(off)}`);
console.log(`[LATENT solid] ${fmt(on)}`);
console.log(`\ncontainment win: belowFloor ${off.belowFloor}→${on.belowFloor}, voidCols ${off.voidCols}→${on.voidCols}, deepest ${off.minY}→${on.minY}`);
