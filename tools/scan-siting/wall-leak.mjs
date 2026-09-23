// Diagnose the "wall doesn't dam the water" report: voxelize the debug scan,
// run the ACTUAL production settle+flow, then cross-section the rim so we can
// see whether the wall is a watertight barrier taller than the water, or a
// thin/holey scan shell the CA leaks through/under.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "ignore" });
const { voxelize } = await import("./voxelizer.mjs");
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
const isSolid=(x,y,z)=>cm.get(K(x,z))?.has(y)??false;
const topOf=(x,z)=>{ const s=cm.get(K(x,z)); if(!s) return null; let m=-Infinity; for(const y of s) if(y>m)m=y; return m; };
let minSolid=Infinity; for(const[,ys] of cm) for(const y of ys) if(y<minSolid)minSolid=y;

// Production flow with the shipped drain-cap + source-relative floor.
const origin=[-19,1,-17], emitter=emitterCell(origin);
const PER_TICK=8,CAP=7200,FILL_RADIUS=24,MAX_RISE=6,SPREAD=16,MAXSCAN=200,EDGE=5,FLOW_DROP=26,DRAINCAP=1;
const floorY=origin[1]-FLOW_DROP; const dwell=new Map();
let body=new Set(),state={budget:CAP,capacity:CAP},tickN=0,credit=0;
for(let s=1;s<=120;s++){
  const r=springEmit(state,emitter,PER_TICK);
  if(r.emit){state=r.state;body=emitAndSettle(body,isSolid,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:CAP,maxRise:MAX_RISE});}
  credit+=1.5;while(credit>=1){credit-=1;tickN++;body=stepFluid(body,isSolid,{floorY,tick:tickN,maxCells:CAP,spreadRange:SPREAD,maxScan:MAXSCAN,edgeHold:EDGE,dwell,maxDrainPerCol:DRAINCAP});}
}
const water=new Set(body);
const waterTop=new Map(); // x,z -> max water y
for(const k of water){ const[x,y,z]=k.split(",").map(Number); const kk=K(x,z); const p=waterTop.get(kk); if(p===undefined||y>p) waterTop.set(kk,y); }

// Water level (median of water tops) and footprint bbox.
const tops=[...waterTop.values()].sort((a,b)=>a-b); const wl=tops[Math.floor(tops.length/2)];
let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
for(const kk of waterTop.keys()){ const[x,z]=kk.split(",").map(Number); minX=Math.min(minX,x);maxX=Math.max(maxX,x);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);}
console.log(`water cells=${water.size} footprint=${waterTop.size} level(median top)=${wl}  bbox x[${minX},${maxX}] z[${minZ},${maxZ}]  floorY=${floorY} minSolid=${minSolid}`);

// A column is VOID if it has no solid at all; island EDGE = solid column touching a void neighbour.
const HDIRS=[[1,0],[-1,0],[0,1],[0,-1]];
const isVoid=(x,z)=>!cm.has(K(x,z));
// Water cells sitting in a void column (no solid under them at all) = leaked off the island.
let leakedVoid=0, leakedBelowFloorTop=0;
for(const kk of waterTop.keys()){ const[x,z]=kk.split(",").map(Number);
  if(isVoid(x,z)) leakedVoid++;
  const t=topOf(x,z); if(t!==null && waterTop.get(kk) < t) leakedBelowFloorTop++; // water below the local ground top = went under/through
}
console.log(`water columns with NO solid beneath (poured into void) = ${leakedVoid}`);
console.log(`water columns sitting BELOW the local ground top (under/through terrain) = ${leakedBelowFloorTop}`);

// Cross-section: for the z with the most water, print x-profile of solid(#) vs water(~) vs air(.).
const perZ=new Map(); for(const kk of waterTop.keys()){const[,z]=kk.split(",").map(Number);perZ.set(z,(perZ.get(z)||0)+1);}
const zBest=[...perZ.entries()].sort((a,b)=>b[1]-a[1])[0][0];
const xs=[]; for(let x=minX-4;x<=maxX+4;x++) xs.push(x);
const yTop=wl+3, yBot=Math.min(floorY, wl-8);
console.log(`\ncross-section at z=${zBest}  (x ${xs[0]}..${xs[xs.length-1]}, y ${yTop}..${yBot})  # solid  ~ water  . air`);
for(let y=yTop;y>=yBot;y--){
  let row=`y${String(y).padStart(3)} `;
  for(const x of xs){ const sol=isSolid(x,y,zBest); const wat=water.has(`${x},${y},${zBest}`);
    row += wat?"~":(sol?"#":"."); }
  console.log(row);
}
// ── Fix hypothesis: a SEALED solid oracle (everything at/below a column's
// surface top counts as solid — the latent-underside rule production uses).
// Re-run the identical flow and see whether water stays on the surface.
const isSolidSealed=(x,y,z)=>{ const t=topOf(x,z); return t!==null && y<=t; };
{
  const dwell2=new Map(); const floorY2=origin[1]-FLOW_DROP;
  let b2=new Set(),st2={budget:CAP,capacity:CAP},tk=0,cr=0;
  for(let s=1;s<=120;s++){
    const r=springEmit(st2,emitter,PER_TICK);
    if(r.emit){st2=r.state;b2=emitAndSettle(b2,isSolidSealed,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:CAP,maxRise:MAX_RISE});}
    cr+=1.5;while(cr>=1){cr-=1;tk++;b2=stepFluid(b2,isSolidSealed,{floorY:floorY2,tick:tk,maxCells:CAP,spreadRange:SPREAD,maxScan:MAXSCAN,edgeHold:EDGE,dwell:dwell2,maxDrainPerCol:DRAINCAP});}
  }
  const wt2=new Map(); for(const k of b2){const[x,y,z]=k.split(",").map(Number);const kk=K(x,z);const p=wt2.get(kk);if(p===undefined||y>p)wt2.set(kk,y);}
  let below=0,fpMinY=Infinity,fpMaxY=-Infinity; for(const[kk,wy] of wt2){const[x,z]=kk.split(",").map(Number);const t=topOf(x,z);if(t!==null&&wy<t)below++;if(wy<fpMinY)fpMinY=wy;if(wy>fpMaxY)fpMaxY=wy;}
  console.log(`\n[SEALED oracle] water cells=${b2.size} footprint=${wt2.size} below-ground-top=${below}  topY range ${fpMinY}..${fpMaxY}`);
}

// Rim report along that slice: leftmost/rightmost solid tops around the pool.
console.log(`\nrim tops along z=${zBest}:`);
let seg="";
for(const x of xs){ const t=topOf(x,zBest); seg += ` x${x}:${t===null?"void":t}`; }
console.log(seg);
