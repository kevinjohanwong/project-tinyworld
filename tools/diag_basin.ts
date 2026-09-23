// Does additive-CA emission fill a BASIN into a lake, then overtop into a channel?
import { stepFluid, type MomentumCell } from "../src/water-spring";
const k=(x:number,y:number,z:number)=>`${x},${y},${z}`;
// Geometry along +x: basin (x=2..8, floor y=3, walls to y=10 at x=1 and x=9-with-notch),
// lip notch at x=9 y=8 (lower than wall top 10) -> channel x=10..24 floor y=8 -> void x>24.
const solid=(x:number,y:number,z:number)=>{
  if(y<0)return false;
  if(z<0||z>2) return y<=12;                 // side containment in z
  if(x<=0) return y<=12;                      // back wall
  if(x>=1&&x<=8){ if(x===1) return y<=10;     // basin back wall
                  return y<3; }               // basin floor (holds water up to rim)
  if(x===9) return y<8;                        // notch/lip: solid up to y=8, opening above
  if(x>=10&&x<=24) return y<8;                 // channel floor at y=8
  return false;                                // void past x=24
};
const emitter:[number,number,number]=[3,9,1]; // source above the basin
const FLOW_MS=90,EMIT_MS=140,PER_TICK=8,FLOORY=-30;
const opt=(tick:number,dwell:Map<string,number>,field:Map<string,MomentumCell>)=>({
  tick, floorY:FLOORY, spreadRange:16, maxScan:200, edgeHold:5, dwell, maxDrainPerCol:1,
  hydro:true, carryRate:1, fwdHeadK:1, fwdDischargeK:0.5, carrySpeedMin:0.5,
  momentum:{field,inject:1,frictionRest:0.7,frictionDeep:0.35,frictionFlow:0.92,weirK:1,weirRes:1.2,headK:1,headMax:12,maxSpeed:6,biasMin:0.3,levelFlow:0.25,stats:{drops:0,overtops:0}},
});
let w=new Set<string>(); const dwell=new Map<string,number>(); const field=new Map<string,MomentumCell>();
let tFlow=0,tEmit=0,tick=0;
for(let t=0;t<90000;t+=10){
  if(t-tEmit>=EMIT_MS){ tEmit=t;
    const [ex,ey,ez]=emitter; let a=0;
    for(let y=ey;a<PER_TICK&&y<ey+40;y++) if(!solid(ex,y,ez)&&!w.has(k(ex,y,ez))){w.add(k(ex,y,ez));a++;}
  }
  if(t-tFlow>=FLOW_MS){ tFlow=t; w=stepFluid(w,solid,opt(tick++,dwell,field)); }
}
// basin water level (max y at x=5) and channel depth profile (x=10..24 at z=1)
let basinTop=2; for(const c of w){const[x,y,z]=c.split(",").map(Number); if(x===5&&z===1&&y>basinTop)basinTop=y;}
const prof:number[]=[]; for(let x=10;x<=24;x++){let mx=7;for(const c of w){const[cx,cy,cz]=c.split(",").map(Number);if(cx===x&&cz===1&&cy>mx)mx=cy;}prof.push(mx-7);}
console.log(`basin water level y=${basinTop} (floor y3, rim/notch y8) -> lake ${basinTop>=7?"FORMED":"did NOT form"}`);
console.log(`channel depth x10..24: ${prof.map(d=>d<=0?".":d<10?String(d):"#").join("")}`);
console.log(`total cells ${w.size}`);
