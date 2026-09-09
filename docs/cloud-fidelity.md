# Cloud fidelity and motion

Status: cloud-only changes deployed to **/tinyworld-staging**, September 9, 2026. **/tinyworld is unchanged.**

## Source ownership

The staging route imports `/home/workspace/project-tinyworld/src/tw-staging-app.tsx` through the Space route tool. Its cloud import is relative, so the workspace's `tw-voxel-cloud.ts`, `tw-cloud-shading.ts`, and `tw-cloud-sea.ts` are authoritative for this staging change. Other `@/` imports still resolve to the installed Space modules. The workspace project has an ignored `node_modules` symlink to the existing Space dependencies; no packages were installed or Space package files changed. Modify route wrappers only through Space tools. The Sentinel `sentStop.settleDur=1` wrapper is retained.

Rollback: use Space route undo to restore the prior staging import (`@/tw-staging-app`), or the wrapper saved in `.route-backups/tinyworld-staging-20260909-cloud-before.tsx`. Do not use old reapply scripts that modify generated Space files directly.

## Implemented

- **Scale-independent motion.** Bob displacement is now applied after the instance transform, matching CPU visibility bounds. Previously `transformed.y += bob` multiplied world-unit motion by each mesh's scale; large formations moved much farther than small ones and their rendered bounds disagreed with culling.
- **Slow, coherent motion.** Orbit speed is 0.00012 radians/second instead of 0.0035: about 0.41 degrees/minute rather than 12.0. Bob amplitude is 0.003 × world span, with sky periods roughly 7.5–13 minutes and swell periods roughly 12–21 minutes. A local clock skips resume/long-frame jumps; changing speed does not change accumulated angle. Shading detail is attached to formation-rest coordinates rather than sliding across moving clouds.
- **Real voxel sea geometry.** The old polar triangle grid sampled a quantized heightfield but connected different heights with sloping triangles; time-varying quantization also jumped whole cells. A deterministic Cartesian mesh now emits flat tops and exposed vertical walls from the same two-scale mound field at rest. Geometry moves with the bank without changing voxel levels every frame. Existing coverage, clearance taper, sea level, palette, and hero assets are retained.
- **One shading implementation.** All three layers share the ramp, day/dusk/night palette, normal-detail model, view direction, and haze calculation. World normals use Three.js's transformed normal (including nonuniform instance scale correction). Haze is camera-distance-based. The highest-frequency normal detail fades when under-resolved. Zero-alpha fragments still discard before writing depth.
- **Default tower mix restored.** Missing `towerfrac` previously passed `Number(null) === 0`, disabling the module's 0.4 default. Absence now yields NaN and falls back normally; explicit `towerfrac=0` is retained.
- Geometry is disposed when the sea is rebuilt/disposed, and re-scatter invalidates the culling cache immediately.

## Evidence and limits

`bun test tools/test-cloud-fidelity.ts` passes eight tests covering frame-rate independence (30/60/120 Hz), clock discontinuities, scale-independent bob order, geometry determinism/winding/normals/budget, scaling, shader anchors, and re-scatter/sea-off lifecycle. TypeScript checks pass for the three cloud modules.

The isolated lab uses pinned Three.js 0.165.0 and the actual full-resolution cloud GLB. Day/dusk/night renders compiled without reported shader errors. New sea: 19,004 cells, 65,204 triangles versus the old ring's 103,680 (37% fewer). Matched day frame: 11 draws in both versions, 797,148 versus 844,908 visible triangles. This is a geometry/draw-count comparison, **not an FPS benchmark**.

Full staging smoke: new sea and cloud layers visibly rendered, `towerFrac=0.4`, new motion values, Sentinel settle duration 1, no reported loop/page errors, and balanced world ledger. Headless world rendering used reduced resolution with grass/GI/AO/bloom disabled to keep inspection responsive. It does not verify full-quality phone rendering, performance, or motion feel. The lab is the sharpness comparison; device acceptance remains necessary.

Artifacts: `Images/tinyworld-clouds-sep9-comparison.png`, `Images/tinyworld-clouds-sep9-night.png`, and `verification/cloud-fidelity-sep9/`. The lab can be run with `bun clouds-lab/fidelity-server.ts`; its localhost endpoint is internal testing only. `lab.load('baseline'|'new')`, `lab.set({tod,view,angle})`, `lab.advance(seconds,fps)`, and `lab.report()` provide deterministic comparisons. Baseline comes from the pinned pre-pass commit, not a moving HEAD.

## Next fidelity candidates — not implemented

1. **Distance-aware voxel detail:** the sea, flattened swells, and stacked heroes intentionally use different cell scales. Shared shading cannot make their geometric detail identical. A screen-size-based mesh-detail policy is the next targeted experiment; protect the approved island clearance and measure phone triangle/fragment cost before adding density.
2. **Cloud lighting/output contract:** shading is still an authored post-tone-map palette, not volumetric light transport. Fixing the whole-scene HDR/tone-map path must be isolated from this pass; do not blindly move the cloud output earlier and change approved day/dusk/night colors. The existing transmission term also warrants a controlled sun-behind-cloud versus sun-behind-camera test before changing its sign.
3. **Transparent overlap:** instances are ordered within geometry buckets, not globally across all nine buckets. Cross-bucket silhouette overlaps can still differ. Weighted transparency would add render targets and mobile bandwidth; do not add it without a visible failing overlap case.

Terrain, vegetation, characters, water solver/rendering, weather, and paused void systems were not redesigned in this pass. September 8 terrain/shadow/material correctness fixes remain as previously implemented.
