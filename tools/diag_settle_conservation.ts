import { emitAndSettle } from "../src/water-spring";
const k=(x:number,y:number,z:number)=>`${x},${y},${z}`;

// CASE A: a 1-wide basin (x=0..2 walls, x=1 floor) already FULL to the rim,
// PLUS in-flight water spilling over the lip into void (x>=3). maxRise small so
// the reachable/supported capacity near the source is genuinely bounded.
const FLOOR=5, RIM=8;
// walls at x=0 and x=2 up to RIM; floor solid below y=FLOOR for x=1; void for x>=3
const solid=(x:number,y:number,z:number)=>{
  if(x===1) return y<FLOOR;                 // basin floor
  if(x===0||x===2) return y<=RIM;           // walls
  if(x>=3) return false;                    // void past the lip
  return false;
};
// basin full x=1 y=FLOOR..RIM, plus spill cells over the wall at x=2? no, wall solid.
// Spill path: water tops the wall (y=RIM+1 over x=2) then falls into void x>=3.
const water=new Set<string>();
for(let y=FLOOR;y<=RIM;y++) water.add(k(1,y,0));   // full basin column (4 cells)
water.add(k(1,RIM+1,0));                             // one above rim (in-flight, will spill)
water.add(k(2,RIM+1,0)); water.add(k(3,RIM+1,0));   // spilling over the lip into void (unsupported)
water.add(k(3,RIM,0)); water.add(k(3,RIM-1,0));      // falling down the void face (unsupported)
const before=water.size;
const emitter:[number,number,number]=[1,RIM,0];
const next=emitAndSettle(water,solid,emitter,4,{radius:24,maxCells:5000,maxRise:2}); // add 4, maxRise 2
console.log(`CASE A: add=4, maxRise=2`);
console.log(`  before ${before}  +add 4  => intended ${before+4}   after ${next.size}   NET LOST ${before+4-next.size}`);
console.log(`  before: ${[...water].sort().join(" ")}`);
console.log(`  after : ${[...next].sort().join(" ")}`);
