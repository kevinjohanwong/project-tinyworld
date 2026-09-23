// breachflat + emission that places new water at the LOWEST empty resting spot
// (no source tower, no re-settle/yank-back), + CA. Measures tower, coverage, conservation.
import { stepFluid, type MomentumCell } from "../src/water-spring";
const k=(x:number,y:number,z:number)=>`${x},${y},${z}`;
const N=72, FLOOR_Y=2, MID=N/2, BASIN_START=8, BREACH_START=28, GORGE_END=66, EDGE_START=69;
const BASIN_FLOOR=7, BREACH_FLOOR=10, GORGE_HALF=4, WALL_Y=22;
const inGorge=(z:number)=>Math.abs(z-MID)<GORGE_HALF;
const heightAt=(x:number,z:number):number=>{ let h=WALL_Y;
  if(x>=BASIN_START&&x<BREACH_START){const dx=(x-18)/12,dz=(z-MID)/18; if(dx*dx+dz*dz<=1)h=BASIN_FLOOR;}
  else if(x>=BREACH_START&&x<GORGE_END&&inGorge(z))h=BREACH_FLOOR;
  else if(x>=GORGE_END&&x<EDGE_START&&inGorge(z))h=BREACH_FLOOR;
  else if(x>=EDGE_START&&inGorge(z))h=BREACH_FLOOR-1;
  return Math.max(FLOOR_Y+1,h); };
const solid=(x:number,y:number,z:number):boolean=>{ if(x<0||x>=N||z<0||z>=N)return false; if(y<FLOOR_Y)return false; return y<=heightAt(x,z); };
const emitter:[number,number,number]=[18,BASIN_FLOOR+1,MID];

// PLACE `want` new water cells at the lowest empty SUPPORTED spots reachable from the
// emitter, without disturbing existing water. Flood the reachable non-solid pocket,
// then greedily fill lowest-first where the cell below is solid/water/already-filled.
function placeLowest(water:Set<string>, want:number, radius=24):number{
  const [ex,ey,ez]=emitter;
  const inR=(x:number,y:number,z:number)=> Math.abs(x-ex)<=radius&&Math.abs(z-ez)<=radius&&y>=ey-radius-6&&y<=ey+radius;
  const isFree=(x:number,y:number,z:number)=> !solid(x,y,z) && !water.has(k(x,y,z));
  const seen=new Set<string>(); const stack:[number,number,number][]=[];
  if(!solid(ex,ey,ez)){seen.add(k(ex,ey,ez));stack.push([ex,ey,ez]);}
  const DIRS:[number,number,number][]=[[0,-1,0],[-1,0,0],[1,0,0],[0,0,-1],[0,0,1],[0,1,0]];
  const empties:[number,number,number][]=[]; let guard=0;
  while(stack.length&&guard++<300000){ const[x,y,z]=stack.pop()!;
    if(isFree(x,y,z))empties.push([x,y,z]);
    for(const[dx,dy,dz]of DIRS){const nx=x+dx,ny=y+dy,nz=z+dz,kk=k(nx,ny,nz);
      if(!inR(nx,ny,nz)||seen.has(kk)||solid(nx,ny,nz))continue; seen.add(kk); stack.push([nx,ny,nz]);}}
  empties.sort((a,b)=> a[1]-b[1] || (Math.abs(a[0]-ex)+Math.abs(a[2]-ez))-(Math.abs(b[0]-ex)+Math.abs(b[2]-ez)));
  const placedSet=new Set<string>(); let placed=0;
  const supported=(x:number,y:number,z:number)=> solid(x,y-1,z)||water.has(k(x,y-1,z))||placedSet.has(k(x,y-1,z));
  let progress=true;
  while(placed<want&&progress){ progress=false;
    for(const[x,y,z]of empties){ if(placed>=want)break; const kk=k(x,y,z); if(placedSet.has(kk))continue;
      if(supported(x,y,z)){placedSet.add(kk);water.add(kk);placed++;progress=true;} } }
  return placed;
}
const FLOW_MS=90,EMIT_MS=140,PER_TICK=8, floorY=FLOOR_Y-26;
const opt=(tick:number,dwell:Map<string,number>,field:Map<string,MomentumCell>)=>({
  tick, floorY, spreadRange:16, maxScan:200, edgeHold:5, dwell, maxDrainPerCol:1,
  hydro:true, carryRate:1, fwdHeadK:1, fwdDischargeK:0.5, carrySpeedMin:0.5,
  momentum:{field,inject:1,frictionRest:0.7,frictionDeep:0.35,frictionFlow:0.92,weirK:1,weirRes:1.2,headK:1,headMax:12,maxSpeed:6,biasMin:0.3,levelFlow:0.25,stats:{drops:0,overtops:0}},
});
let w=new Set<string>(); const dwell=new Map<string,number>(); const field=new Map<string,MomentumCell>();
let tFlow=0,tEmit=0,tick=0, injected=0, culled=0;
function snap(lab:string){ let maxY=0,basin=0; for(const c of w){const[x,y,z]=c.split(",").map(Number); if(y>maxY)maxY=y; if(x===18&&z===MID&&y>basin)basin=y;}
  const cov:number[]=[]; for(let x=BREACH_START;x<N;x++){let wet=0,tot=0; for(let z=MID-GORGE_HALF+1;z<MID+GORGE_HALF;z++){tot++; for(const c of w){const[cx,,cz]=c.split(",").map(Number); if(cx===x&&cz===z){wet++;break;}}} cov.push(tot?wet/tot:0);}
  console.log(`${lab}: basinLvl y${basin}  MAXwaterY y${maxY} (spill@y10,walls@y22)  total=${w.size}  bal=${injected-culled-w.size}`);
  console.log(`   coverage: ${cov.map(f=>f<=0?".":f<0.34?"-":f<0.67?"+":"#").join("")}`);
}
for(let t=0;t<=120000;t+=10){
  if(t-tEmit>=EMIT_MS){ tEmit=t; injected+=placeLowest(w,PER_TICK); }
  if(t-tFlow>=FLOW_MS){ tFlow=t; const b=w.size; w=stepFluid(w,solid,opt(tick++,dwell,field)); culled+=(b-w.size); }
  if(t===30000||t===60000||t===120000) snap(`t=${t/1000}s`);
}
