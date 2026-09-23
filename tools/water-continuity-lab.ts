import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const modules: Record<string, string> = {};
for (const [name, path] of Object.entries({ current: "src/pwater/terrace-water.ts", fill: "src/latent-fill-geometry.ts" })) {
  const result = await Bun.build({ entrypoints: [resolve(root, path)], target: "browser", format: "esm" });
  if (!result.success) throw new Error(String(result.logs));
  modules[`/${name}.js`] = await result.outputs[0].text();
}
const baseline = Bun.spawnSync(["git", "show", "3b574f88ff53aa39415706ecab53cc5636d2bcc0:src/pwater/terrace-water.ts"], { cwd: root });
if (baseline.exitCode) throw new Error("Missing baseline commit");
modules["/baseline.js"] = new Bun.Transpiler({ loader: "ts" }).transformSync(baseline.stdout.toString());
const html = `<!doctype html><html><body style="margin:0;width:1220px;background:#18222a;color:white;font:16px sans-serif"><div id="label">Water continuity: baseline / current</div><script type="module">
import * as THREE from '/three.js';
import {createTerraceWater as baseline} from '/baseline.js';
import {createTerraceWater as current} from '/current.js';
const runs=[]; let clock=1000; performance.now=()=>clock;
for(const [name,make] of [['baseline',baseline],['current',current]]) {
 const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setSize(600,400); renderer.setPixelRatio(1); renderer.toneMapping=THREE.ACESFilmicToneMapping;
 document.body.appendChild(renderer.domElement);
 const scene=new THREE.Scene(); scene.background=new THREE.Color('#9cbccf'); scene.add(new THREE.HemisphereLight(0xffffff,0x556644,2));
 const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(-6,15,10);scene.add(sun);
 const camera=new THREE.PerspectiveCamera(48,1.5,0.1,100);camera.position.set(24,19,28);camera.lookAt(9,3,7);
 const nx=20,ny=12,nz=14,solid=new Uint8Array(nx*ny*nz);
 const blocks=[]; const geo=new THREE.BoxGeometry(1,1,1),mat=new THREE.MeshStandardMaterial({color:0x736146,roughness:1});
 for(let z=1;z<nz-1;z++)for(let x=1;x<nx-1;x++) {
   let h=x<9?4:1;if(z===1||z===nz-2||x===1)h=7;
   for(let y=1;y<=h;y++){solid[y*nx*nz+z*nx+x]=1;blocks.push([x+.5,y+.5,z+.5]);}
 }
 const terrain=new THREE.InstancedMesh(geo,mat,blocks.length),matrix=new THREE.Matrix4(); blocks.forEach((p,i)=>terrain.setMatrixAt(i,matrix.makeTranslation(...p)));scene.add(terrain);
 const water=make({THREE,renderer,nx,ny,nz,solid,spring:{x:4,y:5,z:7},off:{x:0,y:0,z:0},cellV:1,springRate:.09,warmSteps:0,ribNorm:.005,drops:false}); water.resize(600,400);
 runs.push({name,water,renderer,scene,camera,sun,solid,nx,ny,nz});
}
window.lab={compareMass(){let max=0;for(let i=0;i<20*12*14;i++)max=Math.max(max,Math.abs(runs[0].water.massAt(i)-runs[1].water.massAt(i)));return {maxCellDifference:max};},advance(frames=60){for(let n=0;n<frames;n++){clock+=1000/60;for(const r of runs)r.water.frame(r.scene,r.camera,new THREE.Vector3(-1,2,1).normalize(),r.sun,new THREE.Color(.7,.85,1),null);}return runs.map(r=>({name:r.name,...r.water.stats()}));},pause(){runs[1].water.knob({paused:true});},report(){return runs.map(r=>({name:r.name,...r.water.stats()}));}};
window.lab.advance(1);
</script></body></html>`;
Bun.serve({ hostname: "127.0.0.1", port: 4601, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
  if (path === "/three.js") return new Response(Bun.file("/home/workspace/node_modules/three/build/three.module.js"), { headers: { "content-type": "text/javascript" } });
  if (modules[path]) return new Response(modules[path], { headers: { "content-type": "text/javascript" } });
  return new Response("Not found", { status: 404 });
} });
console.log("Water continuity lab ready on 4601");
