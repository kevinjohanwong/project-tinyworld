// Reproduce ?terrain=breachflat EXACTLY + the real emission+CA loop, headless.
import { stepFluid, type MomentumCell } from "../src/water-spring";
const k=(x:number,y:number,z:number)=>`${x},${y},${z}`;
const N=72, FLOOR_Y=2, MID=N/2, BASIN_START=8, BREACH_START=28, GORGE_START=32, GORGE_END=66, EDGE_START=69;
const BASIN_FLOOR=7, BREACH_FLOOR=10, GORGE_HALF=4, WALL_Y=22;
const inGorge=(z:number)=>Math.abs(z-MID)<GORGE_HALF;
const heightAt=(x:number,z:number):number=>{
  let h=WALL_Y;
  if(x>=BASIN_START&&x<BREACH_START){const dx=(x-18)/12,dz=(z-MID)/18; if(dx*dx+dz*dz<=1)h=BASIN_FLOOR;}
  else if(x>=BREACH_START&&x<GORGE_START&&inGorge(z))h=BREACH_FLOOR;
  else if(x>=GORGE_START&&x<GORGE_END&&inGorge(z))h=BREACH_FLOOR;      // flatChannel
  else if(x>=GORGE_END&&x<EDGE_START&&inGorge(z))h=BREACH_FLOOR;        // flatChannel
  else if(x>=EDGE_START&&inGorge(z))h=BREACH_FLOOR-1;                   // flatChannel
  return Math.max(FLOOR_Y+1,h);
};
// solid = within world bounds AND FLOOR_Y<=y<=heightAt ; outside bounds or y<FLOOR_Y = void
const solid=(x:number,y:number,z:number):boolean=>{
  if(x<0||x>=N||z<0||z>=N) return false;   // world edge = void (fall off)
  if(y<FLOOR_Y) return false;               // under the world = void
  return y<=heightAt(x,z);
};
// Spring emitter: basin center, one above the basin floor.
const emitter:[number,number,number]=[18,BASIN_FLOOR+1,MID];
const FLOW_MS=90,EMIT_MS=140,PER_TICK=8, floorY=FLOOR_Y-26;
const opt=(tick:number,dwell:Map<string,number>,field:Map<string,MomentumCell>)=>({
  tick, floorY, spreadRange:16, maxScan:200, edgeHold:5, dwell, maxDrainPerCol:1,
  hydro:true, carryRate:1, fwdHeadK:1, fwdDischargeK:0.5, carrySpeedMin:0.5,
  momentum:{field,inject:1,frictionRest:0.7,frictionDeep:0.35,frictionFlow:0.92,weirK:1,weirRes:1.2,headK:1,headMax:12,maxSpeed:6,biasMin:0.3,levelFlow:0.25,stats:{drops:0,overtops:0}},
});
let w=new Set<string>(); const dwell=new Map<string,number>(); const field=new Map<string,MomentumCell>();
let tFlow=0,tEmit=0,tick=0, injected=0, culled=0;
function snapshot(label:string){
  // Basin fill level (max water y at x=18,z=MID) + channel coverage per x (28..71): fraction of gorge-width columns wet
  let basin=0; for(const c of w){const[x,y,z]=c.split(",").map(Number); if(x===18&&z===MID&&y>basin)basin=y;}
  const cov:number[]=[];
  for(let x=BREACH_START;x<N;x++){
    let wet=0,tot=0;
    for(let z=MID-GORGE_HALF+1;z<MID+GORGE_HALF;z++){ tot++; for(const c of w){const[cx,,cz]=c.split(",").map(Number); if(cx===x&&cz===z){wet++;break;}} }
    cov.push(tot?wet/tot:0);
  }
  const bar=cov.map(f=>f<=0?".":f<0.34?"-":f<0.67?"+":"#").join("");
  console.log(`${label}: basin lvl y${basin} (spill@y${BREACH_FLOOR})  total=${w.size}  budgetBal(in-out-body)=${injected-culled-w.size}`);
  console.log(`   channel coverage x28→71: ${bar}`);
}
for(let t=0;t<=120000;t+=10){
  if(t-tEmit>=EMIT_MS){ tEmit=t; const[ex,ey,ez]=emitter; let a=0;
    for(let y=ey;a<PER_TICK&&y<ey+64;y++) if(!solid(ex,y,ez)&&!w.has(k(ex,y,ez))){w.add(k(ex,y,ez));a++;}
    injected+=a;
  }
  if(t-tFlow>=FLOW_MS){ tFlow=t; const b=w.size; w=stepFluid(w,solid,opt(tick++,dwell,field)); culled+=(b-w.size); }
  if(t===30000||t===60000||t===120000) snapshot(`t=${t/1000}s`);
}
console.log(`\ncoverage legend: '.' dry  '-' <34%  '+' <67%  '#' ≥67% of the ~7-wide channel wet`);
