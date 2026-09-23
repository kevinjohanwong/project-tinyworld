# Water Physics Plan — Momentum, Rivers, Rain, Erosion

**Status: ACTIVE PLAN (2026-07-26). Nothing below is built unless marked EXISTS.** Supersedes no other doc; this is the first consolidated water-physics plan. Design basis: KJ's Jul 25–26 thread — "the ledge is a minus to encourage build-up, water flowing toward it is a plus, larger pluses push through"; speed measured from "how fast the water voxel traveled in the last 2–3 frames"; momentum must COEXIST with the current system, not replace it.

## Governing principle — three coexisting layers

Each layer is correct with the layer above it turned off. Momentum only *weights choices the occupancy CA already makes*; it never moves mass on its own. `momentum=0` ⇒ bit-identical to today's shipped behavior.

| Layer | Owns | Physics covered | Status |
|---|---|---|---|
| 1. Occupancy (CA) | Mass, conservation, resting shape, lakes | Gravitational settling, base-level obstruction (lakes), water cycle (cull→reservoir) | **EXISTS** — `stepFluid`/`solveWaterFlow` in `water-spring.ts`, spring runtime in `water-spring-runtime.ts` |
| 2. Momentum | Direction + intensity of flow: rivers, waterfalls, weir overtopping, hydraulic jump | PE→KE on gradients, stream power (discharge×slope), supercritical→subcritical transition | **PLAN — Phases 1–3** |
| 3. Erosion | Terrain rewritten by flow: channel carving, deposition, undercutting, meander/oxbow | Stream-power erosion, sediment balance, mass wasting | **PLAN — Phase 5, gated, much later** |

**Out of scope permanently (coarse throttled grid can't and shouldn't):** thermal stratification, helical secondary circulation, cavitation, true meander instability. Bar = the reference dev's own: "reasonably okay for gameplay and very fast, rather than accurate."

## What EXISTS today (anchor points)

- CA: `stepFluid` (one cell of motion/tick: DOWN → sideways-drop within `spreadRange` 20 → equalize), spill-level priority flood for resting fill, `edgeHold`/`dwell` crest delay, `maxDrainPerCol: DRAIN_CAP=1` (fixed, headless — the thing momentum replaces), floor cull → reservoir recirculation (conservation).
- Spring: siting via Barnes priority-flood watershed (`chooseBasin` — per-column **spill levels already computed** at siting), `PER_TICK=8` / `EMIT_MS=140` inflow (= discharge), `CAPACITY=50k`.
- Ecology hooks: irrigation (`irrigatedCols`, IRRIG_R 3), waterlogging (`waterloggedCols`, grass recedes → lakes form), both read `springCtrl.waterCells()` — untouched by this plan.
- Rendering: shared water-surface shader V2 (`water-surface-shader.ts`), waterfall + drop-spray meshes (`buildWaterfallMesh`/`buildDropMesh`).
- Terrain: voxelizer carves dry divots/channels (no baked water anywhere); grassy hollows waiting for water.

## Phase 0 — Slope testbed + instrumentation (prereq, small) — **BUILT + VERIFIED (Jul 26)**

- New `?terrain=slope` synthetic bed (alongside `synthetic`/`hydro`): high plateau with the spring site → basin with a lip (rim 2–3 cells above bed) → long downhill channel (consistent grade) → flat plain → open cull edge. Deterministic, small enough for fast iteration.
- `__tw.hydroReport()`: body size, per-region cell counts (plateau/basin/channel/plain), mean+max momentum, overtop events/s, culled total. All later phases are judged with this + Mac-testbed frames.

**Shipped:** `makeSlopeWorldSource()` in `tw-staging-app.tsx` (project mirror synced), N=64 / voxel 0.05 bed, flow along +X: plateau y16 (dry) → basin floor y9 with a y12 lip at the +X rim (holds a lake) → channel graded y11→y6 (walled to a central strip so it reads as a channel) → plain y5 → low-shore edge y3 (open cull edge). Wired `?terrain=slope` into the `debugWorld=1` router. Region X-bounds published in `meta.hydroRegions` (`{axis, plateau, basin, channel, plain, edge}`). `__tw.hydroReport()` (registered next to `springReport` in the app) wraps the spring report and classifies each `waterCells()` cell into a region; momentum block reads `springCtrl.momentumReport?.()` if present else the `{enabled:false, meanSpeed:0, maxSpeed:0, overtopPerSec:0}` zero-baseline — so **Phase 1 plugs its numbers in with no harness change.** **Verified on the Mac (Chrome, real GPU):** bed builds, spring auto-sites in the basin, water fills → overtops the lip → runs the channel → pours off the edge. hydroReport at fill: `basin 1191 / channel 400 / plain 95 / edge 45, plateau 0, culled 10`, momentum zero-baseline. Frame confirmed visually (basin pool + edge waterfall rendering) and on Telegram. Build passed (5.45s), `get_space_errors` clean, live bundle carries the slope + hydroReport markers.

## Phase 1 — Momentum field v1 (injection, decay, weir) — **BUILT + VERIFIED (Jul 26)**

**Shipped:** momentum layer in `stepFluid` (`water-spring.ts`, optional `momentum` option — absent ⇒ bit-identical classic CA) + runtime ownership in `water-spring-runtime.ts` (field/config/stats, `?momentum=0` kill, `momentumReport()`) + `__tw.momentum({enabled, inject, frictionRest, frictionDeep, frictionFlow, weirK, weirRes, maxSpeed})` in the app. Mechanics: descent (FALL/SLIDE) injects `inject`(1)/cell clamped at `maxSpeed`(6) — front-tracking, consecutive drops compound; rest decays ×`frictionRest`(0.7), deep pool (≥2 water above) ×`frictionDeep`(0.35) = the hydraulic jump; horizontal advection carries the entry with mild ×`frictionFlow`(0.92) and blends heading; WEIR = drain quota `DRAIN_CAP + floor(weirK×s)` (stream power: fast water drains more per mouth) + crest gate (s ≥ `weirRes`(1.2) punches over the lip with no dwell; calm water banks and dwells exactly as before). Offline: 5/5 tests in `tools/test_water_momentum.ts` (zero-speed parity bit-identical, injection compounds+clamps, deep decays ≫ rest, quota scales with s, crest gate fast-vs-calm). Live on the Mac slope bed: 309/3316 cells tracked (only moving water carries momentum), meanSpeed 0.27, maxSpeed at the 6 clamp in the channel, overtop ~170/s at the lip, live disable→0 tracked→re-enable verified; frame (basin pool + edge cascades) on Telegram.

### Original Phase 1 spec

The core coexistence build. Per-active-water-cell coarse velocity `{vx, vz, s}` in a Map keyed by cell (bounded by body size ≤ CAPACITY; no field for dry cells).

1. **Injection (PE→KE):** when the CA moves a cell DOWN, add speed along its horizontal heading, ∝ drop count. Implementation per KJ's framing: *measured* speed — cells advanced over the last 2–3 ticks (front-tracking), not force integration. Consecutive drops (steep slope) compound.
2. **Decay (friction / hydraulic jump):** per-tick multiplicative decay; higher on flat ground and when the cell is deep inside a pool (≥2 water above → subcritical), lower while descending. Fast shallow flow entering a deep pool sheds momentum in 1–2 ticks = the hydraulic jump; the plunge pool is where s→0.
3. **Weir/ledge test (stream power, KJ's ±):** replace the fixed `DRAIN_CAP=1` with `drainCap(col) = DRAIN_CAP + floor(k × s_col)` and gate overtopping on `s_col ≥ lipResistance(lipHeight above water surface)`. Lip = "minus", accumulated momentum = "plus". Still water behind a lip banks up (lake holds — calm water stays calm, NOT depth-driven); fast inflow overtops and drains ∝ momentum. Discharge×slope ⇒ stream power falls out: discharge = spring PER_TICK, slope = accumulated s.
4. **Advection:** momentum rides with the moving cell (transfer on move, split on spread).
5. **Safety rails:** clamp `s ≤ maxSpeed`; momentum can only ever *increase* drain up to a hard per-tick cap and *bias* direction choice — mass movement, conservation, culling all stay CA-owned. Kill `?momentum=0` (⇒ exactly today), knobs `__tw.momentum({inject, friction, weirK, maxSpeed, enabled})`, state in `hydroReport`.

**Success on the slope bed:** pond fills behind the lip → inflow momentum overtops → water runs the channel as a stream that stays fast on the grade → dies into a spreading pool on the plain (visible jump), with the still basin never "bursting" on its own. Verified with hydroReport numbers + Mac frames (per verification default).

## Phase 2 — Directional channel bias (rivers persist) — **BUILT + VERIFIED (Jul 26)**

**Shipped:** (1) heading-biased spread — `dirsFor()` in `stepFluid` reorders the BFS exploration directions by dot-product with the cell's momentum heading when `s ≥ biasMin`(0.3, `?mombias=N`, in `__tw.momentum({biasMin})`); calm/sub-threshold/momentum-off cells keep the classic rotated order (parity retained — offline test 6/6). (2) Jet disintegration (cosmetic) — `renderDrops` droplet count per falling cell scales 40–100% of SUBVOX with `s/maxSpeed`; momentum off ⇒ classic full spray. (3) Coherence metrics — `hydroReport().spread` reports per-region cross-flow `{n, mean, sd, width}` for channel + plain. **A/B on the Mac slope bed (150s each, same conditions):** momentum ON → channel sd 10.89 / width 71, plain width 7, edge scatter 24; `?momentum=0` → channel sd 15.36 (+41%) / width 76, plain width 10, edge scatter 117. The stream holds one coherent path; the fan is measurably narrower. Frames (dense jet vs scattered fan) on Telegram.

### Original Phase 2 spec

- In the CA's sideways-spread step, weight candidate cells by alignment with the cell's momentum direction (dot product) instead of pure nearest-first — streams keep their heading rather than sheeting radially. This is what makes a *channel* read as a river.
- Waterfall handoff: cells falling >N with high s route through the existing drop-spray mesh with density ∝ s (jet disintegration, cosmetic only).
- Success: on the slope bed the flow holds one coherent channel path across runs instead of a widening fan.

## Phase 3 — Flow-aware rendering (shader V3) — **BUILT + VERIFIED (Jul 26)**

**Shipped:** `water-surface-shader.ts` V2→V3 (`customProgramCacheKey` bumped): per-instance `aFlow` attribute (dirX, dirZ, foam01) → (1) foam as HIGH-ALBEDO near-white diffuse (lit only by real scene lights, never additive — doctrine-compliant), patterned by a chop train running along the flow direction; (2) ripple anisotropy — extra chop normal perturbation aligned with flow, scaled by foam; (3) spec/sky-sheen damped ×(1−0.75·foam) (foam is rough) and alpha → opaque under foam. Geometry without the attribute (scan water) or momentum-off reads aFlow=(0,0,0) → bit-identical V2 look. Runtime: spring `waterMesh` gets its own cloned geometry + `InstancedBufferAttribute` (CAPACITY×3, DynamicDraw), filled in the existing 1s `tick()` cadence from `momField` (foam = s/maxSpeed, maxed with 0.16 shoreline term on exposed rim cells <4 water neighbors); stats in `momentumReport().foam`. **Verified on the Mac slope bed:** foam 370 cells / mean 0.251 live; overview frame shows pale plunge foam at the spring outlet + rim, close-up shows the mottled foam pattern, lighter shoreline band, and glint (both in `debug-shots/testbed/p3-foam-*.jpg`; Telegram send hit a ReadTimeout — frames on disk). Build 5.00s, errors clean, V3 markers in the live bundle, offline suite still 6/6.

### Original Phase 3 spec

- Extend `water-surface-shader.ts`: per-instance flow attribute (dir + speed) → **foam/white-water** where s is high (crest, channel, plunge pool) fading to the calm V2 look at s=0; ripple anisotropy stretched along flow dir; shoreline foam (the parked V2 lever) folded in here. Doctrine-compliant — brightness still sourced from sun/sky only.
- Driver: spring `tick()` already touches uniforms at 1s cadence; flow attr updates piggyback `reconcile()`.

## Phase 4 — Rain → temporary fill → evaporation (the parked payoff)

Divots exist for this; mechanic missing. Rain = distributed "+", evaporation = ambient "−", both through the SAME conserved reservoir (closed water cycle: reservoir → rain → runoff/pools → evaporate/cull → reservoir).

- Rain events fund emission distributed over terrain (not just the spring mouth); runoff uses the momentum layer to run downhill — **rivers appear during rain**, pool in divots, and after rain stops evaporation drains X cells/min top-down until divots dry.
- **Needs KJ design calls before build:** (a) fill source — whole-map rain pooling vs near-spring only; (b) evaporation rate (minutes vs in-game days); (c) rain trigger — random weather vs tied to the real wall-clock world anchor (real weather at the world's GPS later?).

## Phase 5 — Erosion/deposition (GATED, much later)

- Stream power per column (discharge×slope, sustained over minutes) above threshold ⇒ carve one bed cell; deposit downstream where s dies. Channels deepen where rivers actually run; waterfall undercutting/recession and meander/oxbow behavior only if the coarse grid ever supports it.
- Hard gates: opt-in per world; NEVER carves scan architecture (walls/buildings) — dirt/grass beds only; every carve goes through `block_events` (reversible ledger); rate-limited to invisible-slow. This mutates authored scanned worlds — do not start without an explicit KJ go.

## Order & rationale

0 → 1 → 2 → 3 → 4 → 5. Phase 1 is the keystone (everything else reads the momentum field). 3 can swap before 2 if look-first is preferred. 4 needs 1–2 for runoff to read as rivers. 5 is parked until the sim has soaked.

## Perf guardrails

Momentum state only for active water cells; tick cadence/bounded region/maxScan unchanged; per-tick drain hard-capped; all math in the existing throttled `flowStep` — no new per-frame work on the render thread except shader uniforms.

## Hydrostatic lateral rewrite (Jul 27) — SUPERSEDES the BFS spread rule

KJ rulings this session: "calm lakes should be emergent not by design"; "rewrite from the ground up — depth pressure should also apply, pressure outwards driven by real water physics"; "full hydrostatic".

**What changed.** The lateral/SPREAD decision in `stepFluid` (`water-spring.ts`) — previously a BFS that hunted a *distant* drop within `spreadRange` (the non-emergent, "by-design" part) — is replaced by a real **head-gradient rule**, gated by `options.hydro` (`?pressure`, default ON; `?pressure=0` = the classic BFS, bit-identical). Gravity (fall/slide), the drain-quota/weir, the momentum field and foam are UNCHANGED (approved physics); only the resting-cell lateral choice was rewritten.

**The one rule** (a resting cell, below blocked): step toward the lowest-head neighbour, else rest.
- **Down** = gravity (unchanged, still the strongest move; drain-quota throttles the mouth).
- **Lateral** to a neighbour only if it offers lower head: EITHER `canDrop` (the neighbour can descend at THIS cell's own level → **multi-level discharge**, full hydrostatic — buried water jets out a side opening at depth, not only over the rim) OR the neighbour's column surface is **≥2 lower** (a genuine leveling step; a 1-lower neighbour is skipped because moving there merely swaps the bump = churn, never settles).
- **No lower-head neighbour ⇒ no move ⇒ CALM.** A level (or ±1) surface is the rule's fixed point, so calm *emerges* with nothing policing it — no `carryMin`/`biasMin`/speed threshold. (The earlier `carryMin` forward-carry stopgap was reverted.)

**Depth pressure is emergent, not a knob.** A per-column "shed N/tick" quota was tried and removed — grid gravity refills a column vertically the instant it sheds, making such a knob inert, and it's exactly the tuned-parameter KJ rejected. Depth-pressure instead emerges from multi-level discharge: a deep body has more submerged levels, each running the rule against its own neighbour, so it pushes out across many levels at once while a shallow sheet barely trickles.

**Verified offline** (`tools/test_water_hydro.ts`, bun, 5/5): level lake bit-still (calm emergent, no threshold), multi-level side-hole discharge drains a deep tank to the hole level, mass conserved in a closed box, lopsided pile spreads then reaches a STILL equilibrium, and `hydro:false` == classic. Momentum suite still 8/8 (`hydro` off = classic, parity intact). Live: flag `?pressure`, knob `__tw.pressure(true/false)`, state in `__tw.hydroReport().momentum.hydro`. Built + shipped to the shared staging+prod app, `get_space_errors` clean.

**Known nuance to confirm on device / canyon bed.** Per-tick throughput through a *1-wide same-level notch* is 1 cell/level (physical for a fixed opening); a channel runs DEEP because a deep lake submerges the opening across many levels (multi-level discharge), not because one notch passes many cells per tick. If the canyon channel still reads too thin, the next lever is a **simultaneous/frozen-state update** (decide all moves against the tick-start snapshot so an upper cell sheds forward at its level instead of falling into the just-vacated hole = the true "both happen at once") — bigger change, breaks naive free-fall, needs its own design pass. **Look/feel + two-deep-channel = KJ device check on `?terrain=canyon`.**

### Continuity / "forward-pressure-fills-the-slot" — EXPLORED + REVERTED (Jul 27)

KJ's screenshot showed a deep 1-voxel channel running as a thin 1-layer skin; ask was "forward pressure should fill the deep one-voxel channel." Tried a **continuity rule** (a cell whose support shed sideways follows it forward instead of collapsing into the vacated hole). Three variants (blind follow; hydroDir-gated; canDrop-gated) — ALL either broke the closed-box equilibrium (full-body circulation, never settles — the exact "calm must be emergent" invariant KJ set) or gave only a marginal, geometry-fragile 1→2 improvement on a free-draining slot. **Reverted.** Offline probe settled the physics: a **contained** deep 1-wide slot (walled/throttled far end) already fills 4–5 voxels deep with the shipped hydro (communicating vessels — works, now covered by hydro test 7); a **free-draining** slot correctly runs thin (forward pressure → velocity, not depth — a steep open channel is *supposed* to be a fast skin). The screenshot channel drains off the world edge → thin is correct. To make narrow channels READ as deep rivers, the lever is **containment** (a raised outlet lip so water backs up), not a solver hack — a terrain/authoring change needing KJ's call. Do not re-attempt continuity without a fundamentally different (damped/velocity-projection) formulation.
