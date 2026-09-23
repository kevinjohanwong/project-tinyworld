export type WaterFlowPoint = [number, number, number];

export type WaterFlowOptions = {
  radius?: number;
  maxCells?: number;
  maxRise?: number;
};

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

export function solveWaterFlow(
  water: Set<string>, isSolid: (x:number,y:number,z:number)=>boolean,
  center: WaterFlowPoint, options: WaterFlowOptions = {},
): Set<string> {
  const radius=options.radius ?? 10, maxCells=options.maxCells ?? 768, maxRise=options.maxRise ?? 1;
  const [cx,cy,cz]=center, localWater=new Set<string>();
  const nearby=[...water].map(key=>{const [x,y,z]=key.split(",").map(Number);return{key,x,y,z,d:Math.abs(x-cx)+Math.abs(y-cy)+Math.abs(z-cz)};})
    .filter(p=>Math.abs(p.x-cx)<=radius&&Math.abs(p.y-cy)<=radius&&Math.abs(p.z-cz)<=radius)
    .sort((a,b)=>a.d-b.d||a.y-b.y||a.x-b.x||a.z-b.z);
  if (!nearby.length) return new Set(water);
  const seeds:WaterFlowPoint[]=[[nearby[0].x,nearby[0].y,nearby[0].z]];
  localWater.add(nearby[0].key);
  const waterDirs:WaterFlowPoint[]=[[0,-1,0],[-1,0,0],[1,0,0],[0,0,-1],[0,0,1],[0,1,0]];
  for(let head=0;head<seeds.length;head++){
    const [x,y,z]=seeds[head];
    for(const [dx,dy,dz] of waterDirs){
      const nx=x+dx,ny=y+dy,nz=z+dz,key=keyOf(nx,ny,nz);
      if(Math.abs(nx-cx)>radius||Math.abs(ny-cy)>radius||Math.abs(nz-cz)>radius||localWater.has(key)||!water.has(key))continue;
      localWater.add(key);seeds.push([nx,ny,nz]);
    }
  }
  const minX=cx-radius,maxX=cx+radius,minZ=cz-radius,maxZ=cz+radius;
  const minY=Math.min(cy-radius,...seeds.map(p=>p[1]-radius)),maxY=Math.max(cy+maxRise,...seeds.map(p=>p[1]+maxRise));
  const inside=(x:number,y:number,z:number)=>x>=minX&&x<=maxX&&y>=minY&&y<=maxY&&z>=minZ&&z<=maxZ;
  const dirs=waterDirs;
  const reachable=new Set<string>(), queue:WaterFlowPoint[]=[];
  for(const p of seeds){const key=keyOf(...p);if(!reachable.has(key)){reachable.add(key);queue.push(p);}}
  for(let head=0;head<queue.length&&reachable.size<maxCells;){const [x,y,z]=queue[head++];for(const [dx,dy,dz] of dirs){const nx=x+dx,ny=y+dy,nz=z+dz,key=keyOf(nx,ny,nz);if(!inside(nx,ny,nz)||reachable.has(key)||isSolid(nx,ny,nz))continue;reachable.add(key);queue.push([nx,ny,nz]);if(reachable.size>=maxCells)break;}}
  const volume=[...reachable].filter(k=>localWater.has(k)).length;if(!volume)return new Set(water);
  const ordered=[...reachable].map(key=>{const [x,y,z]=key.split(",").map(Number);return{key,x,y,z,d:Math.abs(x-cx)+Math.abs(z-cz)};}).sort((a,b)=>a.y-b.y||a.d-b.d||a.x-b.x||a.z-b.z);
  const supported=new Set<string>();
  for(const c of ordered){const below=keyOf(c.x,c.y-1,c.z);if(isSolid(c.x,c.y-1,c.z)||supported.has(below))supported.add(c.key);}
  const candidates=ordered.filter(c=>supported.has(c.key)||localWater.has(c.key));
  const result=new Set(water);
  for(const k of localWater)result.delete(k);
  for(const c of candidates.slice(0,volume))result.add(c.key);
  return result;
}
