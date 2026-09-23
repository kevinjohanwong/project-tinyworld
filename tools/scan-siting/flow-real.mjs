import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
execFileSync("bun", [HERE + "extract-voxelizer.ts"], { stdio: "ignore" });
const { voxelize } = await import("./voxelizer.mjs");
const { emitAndSettle, stepFluid, emitterCell, springEmit } = await import("/__substrate/space/src/water-spring.ts");
const buf = readFileSync(HERE + "fixtures/debug-scan-small.glb");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength);
const res = await voxelize(ab, null);
const VIS=["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"];
const K=(x,z)=>`${x},${z}`, K3=(x,y,z)=>`${x},${y},${z}`;
const cm=new Map();
for(const n of VIS){const b=res.layers[n];if(!b)continue;const a=new Int32Array(b);for(let i=0;i<a.length;i+=3){const k=K(a[i],a[i+2]);let s=cm.get(k);if(!s){s=new Set();cm.set(k,s);}s.add(a[i+1]);}}
const isSolid=(x,y,z)=>cm.get(K(x,z))?.has(y)??false;
let minSolid=Infinity;for(const[,ys] of cm)for(const y of ys)if(y<minSolid)minSolid=y;
const origin=[-29,1,-14]; const emitter=emitterCell(origin);
const PER_TICK=8,CAP=7200,FILL_RADIUS=24,MAX_RISE=6,SPREAD=16,MAXSCAN=200,EDGE=5,FLOW_DROP=26;
const floorY=minSolid-FLOW_DROP; const dwell=new Map();
let body=new Set(),state={budget:CAP,capacity:CAP},tickN=0,credit=0;
console.log(`real debug basin  origin ${JSON.stringify(origin)} emitter ${JSON.stringify(emitter)} floorTop=1 minSolid=${minSolid}`);
console.log(" tick  vol  footprint  layers  fill%  bottomY..topY  perLayer(top5)");
for(let s=1;s<=60;s++){
  const r=springEmit(state,emitter,PER_TICK);
  if(r.emit){state=r.state;body=emitAndSettle(body,isSolid,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:CAP,maxRise:MAX_RISE});}
  credit+=1.5;while(credit>=1){credit-=1;tickN++;body=stepFluid(body,isSolid,{floorY,tick:tickN,maxCells:CAP,spreadRange:SPREAD,maxScan:MAXSCAN,edgeHold:EDGE,dwell});}
  if(s%5===0||s<=3){
    const xz=new Set();let minY=Infinity,maxY=-Infinity;const pl=new Map();
    for(const k of body){const[x,y,z]=k.split(",").map(Number);xz.add(x+","+z);if(y<minY)minY=y;if(y>maxY)maxY=y;pl.set(y,(pl.get(y)||0)+1);}
    const layers=body.size?maxY-minY+1:0;const fp=xz.size;
    const top=[...pl.entries()].sort((a,b)=>a[0]-b[0]).slice(0,5).map(([y,c])=>`y${y}:${c}`).join(" ");
    console.log(`  ${String(s).padStart(3)} ${String(body.size).padStart(4)}   ${String(fp).padStart(6)}    ${String(layers).padStart(3)}   ${(body.size/Math.max(1,fp)).toFixed(2)}   ${minY}..${maxY}     ${top}`);
  }
}
