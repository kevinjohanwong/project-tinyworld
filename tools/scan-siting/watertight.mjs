import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const HERE=new URL(".",import.meta.url).pathname;
execFileSync("bun",[HERE+"extract-voxelizer.ts"],{stdio:"ignore"});
const {voxelize}=await import("./voxelizer.mjs");
const {emitAndSettle,emitterCell}=await import("/__substrate/space/src/water-spring.ts");
const buf=readFileSync(HERE+"fixtures/debug-scan-small.glb");
const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
const res=await voxelize(ab,null);
const VIS=["dirt","grass","dryGrass","snow","wet","trunks","leaves","water","wall","ceiling"];
const K=(x,z)=>`${x},${z}`;const cm=new Map();
for(const n of VIS){const b=res.layers[n];if(!b)continue;const a=new Int32Array(b);for(let i=0;i<a.length;i+=3){const k=K(a[i],a[i+2]);let s=cm.get(k);if(!s){s=new Set();cm.set(k,s);}s.add(a[i+1]);}}
const isSolid=(x,y,z)=>cm.get(K(x,z))?.has(y)??false;
// tops + basin watershed (full-relief) to enumerate ALL enclosed columns by depth
const HDIRS=[[1,0],[-1,0],[0,1],[0,-1]];
const top=new Map();let maxTop=-Infinity,minTop=Infinity;
for(const[k,ys] of cm){let t=-Infinity;for(const y of ys)if(y>t)t=y;top.set(k,t);if(t>maxTop)maxTop=t;if(t<minTop)minTop=t;}
const spill=new Map(),seen=new Set(),heap=[];const pop=()=>{let b=0;for(let i=1;i<heap.length;i++)if(heap[i].L<heap[b].L)b=i;return heap.splice(b,1)[0];};
for(const[k,y] of top){const[x,z]=k.split(",").map(Number);if(HDIRS.some(([dx,dz])=>!top.has(K(x+dx,z+dz)))){heap.push({k,x,z,L:y});seen.add(k);}}
while(heap.length){const n=pop();if(spill.has(n.k))continue;spill.set(n.k,n.L);for(const[dx,dz] of HDIRS){const nx=n.x+dx,nz=n.z+dz,kk=K(nx,nz);if(!top.has(kk)||seen.has(kk))continue;seen.add(kk);heap.push({k:kk,x:nx,z:nz,L:Math.max(n.L,top.get(kk))});}}
const enclosed=[];for(const[k,y] of top){const d=(spill.get(k)??y)-y;if(d>=1){const[x,z]=k.split(",").map(Number);enclosed.push({x,y,z,depth:d});}}
enclosed.sort((a,b)=>b.depth-a.depth);
// Watertight test: flood 60 cells, does the resting pool stay near the surface?
function holds(o){
  const body=emitAndSettle(new Set(),isSolid,emitterCell([o.x,o.y,o.z]),60,{radius:24,maxCells:7200,maxRise:6});
  let low=Infinity,hi=-Infinity;for(const k of body){const y=+k.split(",")[1];if(y<low)low=y;if(y>hi)hi=y;}
  return {size:body.size,low,hi,sink:o.y-low};
}
console.log(`enclosed columns (depth>=1): ${enclosed.length}   maxTop ${maxTop} minTop ${minTop}`);
console.log("Testing deepest 12 candidates for watertightness (sink = how far below origin the test pool sinks):");
let anyTight=0;
for(const o of enclosed.slice(0,12)){const h=holds(o);const tight=h.sink<=2;if(tight)anyTight++;
  console.log(`  (${o.x},${o.y},${o.z}) depth=${o.depth}  poolLow=${h.low} sink=${h.sink}  ${tight?"WATERTIGHT":"leaks"}`);}
console.log(anyTight?`\n${anyTight}/12 deepest are watertight`:"\nNONE of the deepest candidates hold water — scan has no watertight basin");
