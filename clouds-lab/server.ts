// clouds-lab — a tiny separate environment for iterating on the REAL
// tw-volumetric-clouds.ts shader with headless self-capture (no TinyWorld world
// load, so agent-browser can actually reach a frame). The page imports the
// production module transpiled live, so what we judge here IS what ships.
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const ROOT = import.meta.dir;
const MODULE = ROOT + "/../src/tw-volumetric-clouds.ts";
const OUT = ROOT + "/out";
mkdirSync(OUT, { recursive: true });

const transpiler = new Bun.Transpiler({ loader: "ts" });

function scalarUniformDefaults(): Record<string, number> {
  const src = readFileSync(MODULE, "utf8");
  const block = src.match(/const uniforms = \{([\s\S]*?)\n  \};/);
  const out: Record<string, number> = {};
  if (block) {
    const re = /(u[A-Za-z]+): \{ value: (-?[\d.]+) \}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block[1]))) out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

Bun.serve({
  port: 4599,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/module.js") {
      const js = transpiler.transformSync(readFileSync(MODULE, "utf8"));
      return new Response(js, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/voxel-module.js") {
      const js = transpiler.transformSync(readFileSync(ROOT + "/../src/tw-voxel-cloud.ts", "utf8"));
      return new Response(js, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/cloud-pieces-lo.glb" || url.pathname === "/cloud-pieces.glb") {
      const fn = url.pathname === "/cloud-pieces.glb" ? "/../assets/cloud-pieces.glb" : "/../assets/cloud-pieces-lo.glb";
      return new Response(readFileSync(ROOT + fn), {
        headers: { "content-type": "model/gltf-binary", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/voxel" || url.pathname === "/voxel.html")
      return new Response(readFileSync(ROOT + "/voxel.html"), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/voxspike" || url.pathname === "/voxspike.html")
      return new Response(readFileSync(ROOT + "/voxspike.html"), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/voxpal" || url.pathname === "/voxpal.html")
      return new Response(readFileSync(ROOT + "/voxpal.html"), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/worker.js") {
      // the REAL production voxelizer: extract WORKER_CODE from tw-staging-core.tsx
      // and interpolate its template constants, so the lab runs the exact shipped path.
      const core = readFileSync(ROOT + "/../src/tw-staging-core.tsx", "utf8");
      const m = core.match(/const WORKER_CODE = String\.raw`([\s\S]*?)\n`;/);
      let code = m ? m[1] : "throw new Error('WORKER_CODE not found')";
      const val = (name: string) => {
        const mm = core.match(new RegExp("const " + name + " = ([^;]+);"));
        return mm ? mm[1].trim().replace(/^"|"$/g, "") : "";
      };
      for (const n of ["THREE_URL", "GLTF_URL", "MAX_TRIANGLES", "VOXEL_METERS", "MAX_WATER", "TERRAIN_DEPTH"])
        code = code.split("${" + n + "}").join(val(n));
      return new Response(code, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/pal.json") {
      const core = readFileSync(ROOT + "/../src/tw-staging-core.tsx", "utf8");
      const pm = core.match(/const PAL = \{([\s\S]*?)\};/);
      const pal: Record<string, number> = {};
      if (pm) {
        const re = /(\w+): (0x[0-9a-fA-F]+)/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(pm[1]))) pal[mm[1]] = parseInt(mm[2], 16);
      }
      return Response.json(pal);
    }
    if (url.pathname === "/debug-scan.glb")
      return new Response(readFileSync("/root/.z/space/assets/debug-scan.glb"), {
        headers: { "content-type": "model/gltf-binary", "cache-control": "no-store" },
      });
    if (url.pathname === "/hero" || url.pathname === "/hero.html")
      return new Response(readFileSync(ROOT + "/hero.html"), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/defaults") return Response.json(scalarUniformDefaults());
    if (url.pathname === "/shot" && req.method === "POST") {
      const { name, data } = (await req.json()) as { name: string; data: string };
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
      writeFileSync(OUT + "/" + safe, Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64"));
      return new Response("ok");
    }
    if (url.pathname === "/done" && req.method === "POST") {
      writeFileSync(OUT + "/DONE.txt", new Date().toISOString());
      return new Response("ok");
    }
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(readFileSync(ROOT + "/index.html"), { headers: { "content-type": "text/html" } });
    return new Response("404", { status: 404 });
  },
});
console.log("clouds-lab on http://localhost:4599");
