import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const vendor = "/home/workspace/node_modules/three";
const build = await Bun.build({ entrypoints: [resolve(root, "src/tw-voxel-cloud.ts")], target: "browser", format: "esm" });
if (!build.success) throw new Error(build.logs.join("\n"));
const module = await build.outputs[0].text();
const baselineSource = Bun.spawnSync(["git", "show", "123f096:src/tw-voxel-cloud.ts"], { cwd: root });
if (baselineSource.exitCode) throw new Error("Cannot read cloud baseline");
const baseline = new Bun.Transpiler({ loader: "ts" }).transformSync(baselineSource.stdout.toString());
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4599,
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    const headers = { "cache-control": "no-store", "content-type": "text/javascript" };
    if (pathname === "/module.js") return new Response(module, { headers });
    if (pathname === "/baseline.js") return new Response(baseline, { headers });
    if (pathname === "/cloud-pieces.glb") return new Response(Bun.file(resolve(root, "assets/cloud-pieces.glb")));
    if (pathname === "/vendor/three.module.js") return new Response(Bun.file(resolve(vendor, "build/three.module.js")), { headers });
    if (pathname.startsWith("/vendor/addons/")) {
      const p = resolve(vendor, "examples/jsm", pathname.slice("/vendor/addons/".length));
      if (!p.startsWith(vendor + "/examples/jsm/")) return new Response("Forbidden", { status: 403 });
      return new Response(Bun.file(p), { headers });
    }
    if (pathname === "/") return new Response(readFileSync(resolve(import.meta.dir, "fidelity.html")), { headers: { ...headers, "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(JSON.stringify({ ready: true, port: server.port, three: "0.165.0", bytes: module.length }));
