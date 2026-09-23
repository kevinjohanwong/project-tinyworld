# Build Mode — Director Camera & Sentinel Work Queue

Status: **prototype live on staging** (`/tinyworld-staging`) · 2026-07-03
Related: `scan-economy.md` (stockpile/grades), `worker-growth-mechs-and-food.md` (worker Build actions), `mass-and-density.md`

## Why

First-person block placement (Magnesis carry → crosshair → tap) works for single
blocks but fails for *structures*: no spatial overview, one block per trip, and
mobile aiming is fiddly. Build Mode flips the model — the player becomes the
**director**: camera swings out to an orbit view, the player paints a plan of
ghost blocks, and the Sentinel walks over and does the physical work. Building
becomes gameplay (watching your mech execute the plan) instead of UI.

## Mode entry / exit

- Enter: **BUILD** button in walk HUD (mobile) or **B** key (desktop). Only
  available while walking the LARGE Sentinel (not drone, not while piloting).
- Exit: **DONE** button or **B**. Player resumes walk mode *at the Sentinel's
  current position* (the mech kept whatever ground it covered while building).
  Unbuilt ghosts persist in the queue and resume next time build mode opens? —
  **No (v1): exiting clears the queue.** Unspent plan is refunded (ghosts only
  *reserve* stock; nothing is deducted until a block is physically placed).

## Camera — "director rig"

- On entry the camera **swings out**: ~700 ms eased tween from the current
  first/third-person pose to a perch behind-above the mech
  (`dist ≈ 4.5·SENTINEL_H`, `height ≈ 2.2·SENTINEL_H`, along the mech's yaw).
- After the tween the camera is **fully user-controllable** via the existing
  OrbitControls: one-finger drag / mouse-drag orbits, pinch / wheel zooms.
- **Soft follow**: the orbit focus glides toward the Sentinel as it walks
  (`k ≈ 2.5·dt`), translating camera + target together so the user's chosen
  orbit angle and zoom are preserved. The user can always re-frame mid-follow;
  their offset is respected, never fought.
- Walk physics is fully suspended (existing `walkingRef` gate) — the camera is
  render-only in this mode.

## Ghost plan (the queue)

- **Tap terrain** → a translucent ghost block appears on the tapped face
  (voxel DDA ray from the tap point, long reach — orbit camera sits far away).
- **Tap a ghost** → removes it from the plan.
- Placement validity (at *plan* time): cell is empty, not already ghosted, and
  supported by a solid neighbor, the ground map, **or another ghost** — so you
  can plan whole multi-block structures (walls, bridges) in one pass, stacked
  on blocks that don't exist yet.
- Ghost color = its layer's palette color. **Amber tint** = the bot currently
  can't act on it (unreachable, or its supporting ghost isn't built yet).
  Re-checked after every placed block and every ~2.5 s.
- Queue is FIFO **with skip**: the bot takes the oldest ghost whose *real*
  support exists and that it can path to; blocked items are skipped, retried
  later, never dropped.
- Cap: 256 ghosts.

## Economy

- Each ghost **reserves** one block of its layer from the stockpile:
  `available(layer) = stockpile[layer] − reserved(layer)`. At 0 available,
  taps are rejected with a `NO STOCK` flash. No deduction happens until the
  Sentinel physically places the block (then `ledgerMove(stockpile → world)`,
  consuming the lowest grade first — same law as all placement).
- Layer selection (v1): automatic — most abundant available layer at tap time.
  v2: a layer-chip picker in the build HUD.
- Conservation ledger holds: world + stockpile + built + void === baseline,
  unchanged by build mode.

## The Sentinel as builder

State machine: `idle → (pick target) → walking → building → idle`.

- **Pathing**: the existing worker 3D A\* (`aStarOnGround`, 4-dir, ±1 step),
  goal = any walkable cell adjacent to the ghost with the ghost's y within
  [−2 … +4] of the standing cell. Iteration budget raised to 2600 for the
  longer cross-world runs.
- **Locomotion**: drives the persisted body anchor directly (same anchor walk
  mode leaves behind), ~3.5 voxels/s, yaw faces travel, feet ground-planted;
  the WalkSlow/Idle animation state machine keys off the same gait signal as
  player-driven walking, so stepping, settling and idling all come for free.
- **Build beat**: on arrival, face the cell, ~500 ms work pause, then the block
  pops in with the standard pick-FX pop + debris chips (in the layer's color),
  water re-settles, walkable ground map updates.
- **Failure**: no path to any ready ghost → bot idles, amber flags shown,
  retry every 2.5 s. World edits (mining, raids) clear the flags immediately.

## Drone split (deliberately NOT in v1)

The interesting fork: Sentinel = free, fast, but **path-bound** (this is what
makes build order a puzzle and keeps bridges load-bearing); Drone = flies
anywhere but slow / charge-limited / costly. v1 ships Sentinel-only to test
whether path-bound building is fun on real scans. If it frustrates instead,
the drone becomes the pressure valve rather than a redesign.

## HUD

- Walk HUD gains **BUILD** (only in LARGE mode).
- Build HUD: top hint chip (`tap terrain to plan · tap a ghost to remove`),
  queue/stock readout (`PLAN n · layer × available`), **DONE**.
- Joysticks and walk chrome hide automatically (walking is false); the
  landing/menu overlay is suppressed while build mode is active.

## Headless hooks (`__tw.build`)

`enter()`, `exit()`, `add(vx,vy,vz)` (plan a ghost directly), `state()` →
`{ active, queue, unreachable, botPhase, stock }` — enough to verify the full
plan→path→place loop without a screen.

## Tuning constants (all in `tw-staging-app.tsx`, BUILD_* block)

| Constant | v1 | Meaning |
|---|---|---|
| `BUILD_CAM_TWEEN_MS` | 700 | swing-out duration |
| `BUILD_CAM_DIST` | 4.5·H | perch distance |
| `BUILD_CAM_HEIGHT` | 2.2·H | perch height |
| `BUILD_FOLLOW_K` | 2.5 | focus glide rate |
| `BUILD_BOT_SPEED` | 3.5 | voxels/sec |
| `BUILD_PLACE_MS` | 500 | work pause per block |
| `BUILD_RETRY_MS` | 2500 | amber re-check |
| `BUILD_MAX_GHOSTS` | 256 | plan cap |

## Open questions (for on-device testing)

1. Does FIFO order feel right, or should the bot pick *nearest ready* ghost?
2. Should the queue persist across build sessions (v1 clears it)?
3. Tap precision on phone — is a tap-vs-orbit-drag threshold of ~8 px right?
4. Does the soft follow fight the user during long walks? (Tune `BUILD_FOLLOW_K`.)
5. Layer picker (v2) — chips vs. hold-to-choose radial?
