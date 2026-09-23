// Strict conservation: count cells injected vs culled vs present, both modes.
import { stepFluid, emitAndSettle, type MomentumCell } from "../src/water-spring";
const k=(x:number,y:number,z:number)=>`${x},${y},${z}`;
const BED=6, LIP=30, WALLT=40, EMIT_X=0;
const solid=(x:number,y:number,z:number)=>{ if(y<0)return false; if(x>LIP)return false; if(z!==0) return y<=WALLT; return y<=BED; };
const emitter:[number,number,number]=[EMIT_X,BED+1,0];
const FLOW_MS=90,EMIT_MS=140,FILL_RADIUS=24,PER_TICK=8,FLOORY=-30;
const opt=(tick:number,dwell:Map<string,number>,field:Map<string,MomentumCell>)=>({
  tick, floorY:FLOORY, spreadRange:16, maxScan:200, edgeHold:5, dwell, maxDrainPerCol:1,
  hydro:true, carryRate:1, fwdHeadK:1, fwdDischargeK:0.5, carrySpeedMin:0.5,
  momentum:{field,inject:1,frictionRest:0.7,frictionDeep:0.35,frictionFlow:0.92,weirK:1,weirRes:1.2,headK:1,headMax:12,maxSpeed:6,biasMin:0.3,levelFlow:0.25,stats:{drops:0,overtops:0}},
});
function sim(additive:boolean, ms:number){
  let w=new Set<string>(); const dwell=new Map<string,number>(); const field=new Map<string,MomentumCell>();
  let tFlow=0,tEmit=0,tick=0; let injected=0, culled=0;
  for(let t=0;t<ms;t+=10){
    if(t-tEmit>=EMIT_MS){ tEmit=t;
      if(additive){ let a=0; for(let y=BED+1;y<WALLT&&a<PER_TICK;y++) if(!w.has(k(EMIT_X,y,0))){w.add(k(EMIT_X,y,0));a++;} injected+=a; }
      else {
        const before=w.size;
        w=emitAndSettle(w,solid,emitter,PER_TICK,{radius:FILL_RADIUS,maxCells:50000,maxRise:6});
        // runtime credits (before - after) DELTA only if after<before (as a 'cull'); the intended gain is PER_TICK.
        // true injected = actual net change we asked for; measure real delta:
        injected += (w.size - before); // net cells emitAndSettle actually added (should be PER_TICK if conservative)
      }
    }
    if(t-tFlow>=FLOW_MS){ tFlow=t; const b=w.size; w=stepFluid(w,solid,opt(tick++,dwell,field)); culled += (b - w.size); }
  }
  return {present:w.size, injected, culled, balance: injected - culled - w.size};
}
for(const add of [false,true]){
  const r=sim(add,60000);
  console.log(`${add?"ADDITIVE-only ":"emitAndSettle"}  present=${String(r.present).padStart(4)}  netInjected=${String(r.injected).padStart(4)}  culled(over lip)=${String(r.culled).padStart(4)}  balance(in-out-present)=${r.balance}`);
}
console.log("balance≈0 means conserved. For emitAndSettle, netInjected counts actual added cells; if it added far fewer than 8/tick, the source couldn't grow the body = throughput clamp.");
