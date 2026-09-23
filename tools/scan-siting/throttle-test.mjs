// Prototype: KJ's "each hole/edge has a max drain speed" idea.
// Compares the current unthrottled stepFluid against a throttled clone that caps
// how many cells may descend through a single (x,z) mouth per tick. Measures
// footprint vs depth over ticks on the REAL debug scan so we can see whether the
// pool flattens-and-fills before it drills down a hole.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "ignore" });
const { voxelize } = await import("./voxelizer.mjs");
const { emitAndSettle, stepFluid, emitterCell, springEmit } = await import("/__substrate/space/src/water-spring.ts");
const buf = readFileSync(HERE + "fixtures/debug-scan-small.glb");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const res = await voxelize(ab, null);
const VIS = ["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"];
const K = (x,z)=>`${x},${z}`, K3=(x,y,z)=>`${x},${y},${z}`;
const cm = new Map();
for (const n of VIS){const b=res.layers[n];if(!b)continue;const a=new Int32Array(b);for(let i=0;i<a.length;i+=3){const k=K(a[i],a[i+2]);let s=cm.get(k);if(!s){s=new Set();cm.set(k,s);}s.add(a[i+1]);}}
const isSolid=(x,y,z)=>cm.get(K(x,z))?.has(y)??false;
let minSolid=Infinity;for(const[,ys] of cm)for(const y of ys)if(y<minSolid)minSolid=y;

// --- throttled clone of stepFluid: cap descents per (x,z) mouth per tick -------
const HDIRS=[[1,0],[-1,0],[0,1],[0,-1]];
function stepFluidThrottled(water,isSolid,opts={},maxDrainPerCol=1){
  const key=K3;const floorY=opts.floorY??-Infinity;const tick=opts.tick??0;
  const spreadRange=opts.spreadRange??20;const maxScan=opts.maxScan??400;
  const result=new Set(water);const moved=new Set();
  const drained=new Map(); // (x,z) mouth -> count descended this tick
  const free=(x,y,z)=>!isSolid(x,y,z)&&!result.has(key(x,y,z));
  const rot=((tick%4)+4)%4;const hdirs=HDIRS.map((_,i)=>HDIRS[(i+rot)%4]);
  // A mouth accepts a descent only if it's under its per-tick quota.
  const canDrain=(x,z)=>{const c=drained.get(K(x,z))||0;return c<maxDrainPerCol;};
  const useDrain=(x,z)=>{const k=K(x,z);drained.set(k,(drained.get(k)||0)+1);};
  const cells=[...water].map((k)=>{const[x,y,z]=k.split(",").map(Number);return{k,x,y,z};})
    .sort((a,b)=>a.y-b.y||a.x-b.x||a.z-b.z);
  for(const c of cells){
    if(moved.has(c.k))continue;
    if(c.y<floorY){result.delete(c.k);continue;}
    // 1. FALL straight down — throttled by the mouth column (c.x,c.z).
    if(free(c.x,c.y-1,c.z)){
      if(canDrain(c.x,c.z)){useDrain(c.x,c.z);result.delete(c.k);const nk=key(c.x,c.y-1,c.z);result.add(nk);moved.add(nk);continue;}
      // mouth is saturated → this cell may NOT fall this tick; fall through to spread.
    } else {
      // 2. SLIDE down-diagonal — throttled by the TARGET mouth column.
      let slid=false;
      for(const[dx,dz]of hdirs){
        if(free(c.x+dx,c.y-1,c.z+dz)){
          if(!canDrain(c.x+dx,c.z+dz))continue;
          useDrain(c.x+dx,c.z+dz);result.delete(c.k);const nk=key(c.x+dx,c.y-1,c.z+dz);result.add(nk);moved.add(nk);slid=true;break;
        }
      }
      if(slid)continue;
    }
    // 3. SPREAD sideways toward nearest drop (unchanged BFS).
    const dir=flowDir(c.x,c.y,c.z);
    if(dir){const nx=c.x+dir[0],nz=c.z+dir[1];result.delete(c.k);const nk=key(nx,c.y,nz);result.add(nk);moved.add(nk);}
  }
  function flowDir(sx,sy,sz){
    const seen=new Set([key(sx,sy,sz)]);let q=[{x:sx,z:sz,first:null,d:0}];let scanned=0;
    while(q.length&&scanned<maxScan){const n=q.shift();scanned++;if(n.d>spreadRange)continue;
      for(const[dx,dz]of hdirs){const nx=n.x+dx,nz=n.z+dz,kk=key(nx,sy,nz);
        if(seen.has(kk))continue;if(!free(nx,sy,nz))continue;seen.add(kk);
        const first=n.first??[dx,dz];
        if(free(nx,sy-1,nz))return first;
        q.push({x:nx,z:nz,first,d:n.d+1});}}
    return null;
  }
  return result;
}

const origin=[-29,1,-14];const emitter=emitterCell(origin);
const PER_TICK=8,CAP=7200,FILL_RADIUS=24,MAX_RISE=6,SPREAD=16,MAXSCAN=200,EDGE=5,FLOW_DROP=26;
const floorY=minSolid-FLOW_DROP;

function run(label,stepFn){
  let body=new Set(),state={budget:CAP,capacity:CAP},tickN=0,credit=0;const dwell=new Map();
  console.log(`\n=== ${label} ===`);
  console.log(" tick  vol  footprint  layers  vol/fp  bottomY..topY");
  for(let s=1;s<=60;s++){
    const r=springEmit(state,emitter,PER_TICK);
    if(r.emit){state=r.state;body=emitAndSettle(body,isSolid,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:CAP,maxRise:MAX_RISE});}
    credit+=1.5;while(credit>=1){credit-=1;tickN++;body=stepFn(body,tickN,dwell);}
    if(s%10===0||s<=2){
      const xz=new Set();let minY=Infinity,maxY=-Infinity;
      for(const k of body){const[x,y,z]=k.split(",").map(Number);xz.add(x+","+z);if(y<minY)minY=y;if(y>maxY)maxY=y;}
      const layers=body.size?maxY-minY+1:0;const fp=xz.size;
      console.log(`  ${String(s).padStart(3)} ${String(body.size).padStart(4)}   ${String(fp).padStart(6)}    ${String(layers).padStart(3)}    ${(body.size/Math.max(1,fp)).toFixed(2)}   ${minY}..${maxY}`);
    }
  }
}

run("BASELINE (unthrottled, current production)",
  (body,tickN,dwell)=>stepFluid(body,isSolid,{floorY,tick:tickN,maxCells:CAP,spreadRange:SPREAD,maxScan:MAXSCAN,edgeHold:EDGE,dwell}));
for(const cap of [2,1]){
  run(`THROTTLED maxDrainPerCol=${cap}`,
    (body,tickN)=>stepFluidThrottled(body,isSolid,{floorY,tick:tickN,spreadRange:SPREAD,maxScan:MAXSCAN},cap));
}
// Combined: throttle (flatten-first) + source-relative cull floor (bound depth).
const boundedFloor=origin[1]-8;
run(`THROTTLED cap=1 + floor bounded to source-8 (y>=${boundedFloor})`,
  (body,tickN)=>stepFluidThrottled(body,isSolid,{floorY:boundedFloor,tick:tickN,spreadRange:SPREAD,maxScan:MAXSCAN},1));
