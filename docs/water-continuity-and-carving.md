# Water continuity and carving — September 21, 2026

Status: implemented on public `/tinyworld-staging`; phone acceptance pending. This is the active record for the September 21 recording review. It does not replace the approved water or lighting snapshots.

## Changes

- Water surface density ramps continuously through the former 0.04 film cutoff. At mass >= 0.04, the approved standing-water density mapping is retained. Bed contribution and air/wet weighting also interpolate instead of switching abruptly.
- Unsupported water blends out of the pool surface as downward flux increases, instead of switching off at exactly half its mass. Ribbon classification, normalizer, spring rate, solver rules, and droplet diversion remain unchanged.
- Surface, flow, and foam smoothing use exponential response so low frame rates do not snap directly to the next state.
- Added `__twPWater.knob({paused:true})` and `paused`/`simulatedSteps` reporting for separating simulation changes from rendering changes. `running` still controls the spring only.
- Water volume reporting includes thin films; building over water now records displaced mass once instead of subtracting it in both drained and displaced totals. These are accounting corrections, not changes to water dynamics.
- Latent interior fill now uses exact cell boundaries with exposed-face geometry, replacing 92%-width columns. Shared interior faces are removed; occupied/materialized cells are excluded. This addresses actual gaps in this rendering path, not every possible greedy-wall/shadow seam.
- Interior rebuild requests are batched once per frame and replaced geometries are disposed. Previously one laser burst could rebuild the entire fill repeatedly.
- Machine charge/carve interval: 850 -> 425 ms. Beam shutdown: 320 -> 160 ms. Carve volume per pulse and frame remesh budgets are unchanged.
- Hopper limits: drone 256 -> 1,024; Sentinel 1,024 -> 4,096. Inventory remains material-count based with the existing save and placement paths.

## Source and deployment

Staging already imports the workspace app. Its water import now also resolves relatively to the workspace bridge and renderer, so this pass does not modify the installed production modules. The live route wrapper was synced through Space tools and retains `sentStop.settleDur=1`. Do not copy these changes into `/tinyworld` without a promotion request.

Files: `src/pwater/surface-continuity.ts`, `src/pwater/terrace-water.ts`, `src/pwater/tinyworld-pwater.ts`, `src/latent-fill-geometry.ts`, `src/tw-staging-app.tsx`.

## Verification

- Seven new tests pass: continuous shore thresholds, established-pool mapping, frame-rate response, pool/fall transition, joined geometry bounds/winding, carved-gap exposure, and live solver pause/displacement accounting.
- Eight existing cloud regression tests pass.
- Targeted TypeScript checks and production build pass. Space reported no route errors.
- Staging acceptance bed smoke: K=3, warm-up completed, pools and falls visibly present, mass ledger error rounded to zero, world ledger balanced, Sentinel settle duration 1. Both hopper capacities confirmed through the live harness. This used reduced-resolution headless rendering and a five-second warm-up, not a phone performance benchmark.
- Isolated baseline/current lab visibly renders both pools and falls. After 2,402 simulation steps, maximum per-cell mass difference was exactly zero; both versions had seven waterfall streams. `tools/water-continuity-lab.ts` pins the baseline to `3b574f88ff53aa39415706ecab53cc5636d2bcc0`; run with Bun, then use `lab.advance`, `lab.report`, `lab.compareMass`, or `lab.pause` in its local browser page. Lab droplets are off to isolate the surface comparison.

Phone acceptance remains necessary for temporal shimmer, all wall seam paths, laser feel under sustained carving, and inventory save/reload at the increased capacity. Warm-up retains its existing accelerated simulation; a visible filling change during warm-up is not itself evidence of newly created mass. The new step counter and mass reporting distinguish that from surface popping.

Commands: `bun test ./tools/test-water-continuity.ts ./tools/test-cloud-fidelity.ts`. Evidence is under `verification/water-continuity-sep21/`.
