# scan-siting — offline spring-siting regression against a real scan

Voxelizes a GLB through the app's **exact** browser voxelizer (`WORKER_CODE` in
`/__substrate/space/src/tinyworld-app.tsx`, extracted at runtime so it can't
drift) and runs the water-spring siting logic that mirrors
`water-spring-runtime.ts` `init()`/`chooseBasin()`/`chooseOutlet()`. Lets us test
spring/voxelizer changes against a real scan without a device check.

Fixture: `fixtures/debug-scan-small.glb` — a small real Scaniverse scan whose top
surface is a bright rim around a deep central crater. It has an **outlier spike**
(`maxTop=51`) while the real floor sits at `y=1` (2,714 of 3,645 columns), which
is exactly what broke the v7 fixed-band basin finder and motivated the v8
full-relief band.

## Run

```bash
bun install                        # one-time (installs three)
bun tools/scan-siting/test.ts      # PASS/FAIL regression (exit 0/1)
bun tools/scan-siting/inspect.mjs [path.glb]   # height map + band sweep + siting
```

`test.ts` asserts, dry and raining: siting succeeds, finds a **natural basin**
(not edge-outlet), depth ≥ 10 voxels, on the real floor (not the spike), emitter
cell + a horizontal neighbour open to air (water travels **over a lip**, not
through geometry).

Drop another `.glb` in `fixtures/` and point `inspect.mjs` at it to characterize
any new scan.
