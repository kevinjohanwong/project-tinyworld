// Faithful offline replication of the runtime's TWO interacting loops:
//   flowStep (stepFluid CA)  every FLOW_MS=90ms
//   growStep (emitAndSettle) every EMIT_MS=140ms
// Question: does the emitAndSettle re-settle YANK channel water back to source?
// Compare current (re-settle) vs additive-only emission. Measure how far water travels.
import { stepFluid, emitAndSettle, type MomentumCell } from "../src/water-spring";
const k=(x:number,y:number,z:number)=>`${x},${y},${z}`;
// Flat plateau y<=BED for x in [0..LIP], void beyond LIP. Source at x=0. z width 1.
const BED=6, LIP=30, WALLT=40, EMIT_X=0;
const solid=(x:number,y:number,z:number)=>{ if(y<0)return false; if(x>LIP)return false; if(z!==0) return y<=WALLT; return y<=BED; };
const emitter:[number,number,number]=[EMIT_X,BED+1,0];
const FLOW_MS=90, EMIT_MS=140, FILL_RADIUS=24, DRAIN_CAP=1, PER_TICK=8;
const opt=(tick:number,dwell:Map<string,number>,field:Map<string,MomentumCell>)=>({
  tick, floorY:-30, spreadRange:16, maxScan:200, edgeHold:5, dwell, maxDrainPerCol:DRAIN_CAP,
  hydro:true, carryRate:1, fwdHeadK:1, fwdDischargeK:0.5, carrySpeedMin:0.5,
  momentum:{field,inject:1,frictionRest:0.7,frictionDeep:0.35,frictionFlow:0.92,weirK:1,weirRes:1.2,headK:1,headMax:12,maxSpeed:6,biasMin:0.3,levelFlow:0.25,stats:{drops:0,overtops:0}},
});
function sim(additive:boolean, ms:number){
  let w=new Set<string>(); const dwell=new Map<string,number>(); const field=new Map<string,MomentumCell>();
  let tFlow=0,tEmit=0,tick=0;
  for(let t=0;t<ms;t+=10){
    if(t-tEmit>=EMIT_MS){ tEmit=t;
      if(additive){ // inject PER_TICK cells at source column, stacking up
        let a=0; for(let y=BED+1;y<WALLT&&a<PER_TICK;y++) if(!w.has(k(EMIT_X,y,0))){w.add(k(EMIT_X,y,0));a++;}
      } else { w=emitAndSettle(w,solid,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:50000,maxRise:6}); }
    }
    if(t-tFlow>=FLOW_MS){ tFlow=t; w=stepFluid(w,solid,opt(tick++,dwell,field)); }
  }
  // furthest x reached, depth profile, total
  let far=0; const depth:number[]=new Array(LIP+1).fill(0);
  for(const c of w){const[x,y,z]=c.split(",").map(Number); if(z===0){ if(x>far)far=x; const d=y-BED; if(d>depth[x])depth[x]=d; }}
  return {far,total:w.size,depth};
}
for(const add of [false,true]){
  const r=sim(add, 60000); // 60s sim
  const bar=r.depth.map(d=>d<=0?".":d<10?String(d):"#").join("");
  console.log(`${add?"ADDITIVE-only ":"emitAndSettle"}  furthest x=${String(r.far).padStart(2)}/${LIP}  total=${String(r.total).padStart(4)}  profile ${bar}`);
}
console.log("(source at x=0, lip at x="+LIP+"; furthest x = how far water traveled down the channel)");
