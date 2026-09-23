# Procedural Voxel Trees — Growth, Species, Super Tree, Pruning

*Design spec. Replaces static vegetation decorators with deterministic,
growable voxel trees. Builds on the conservation ledger
(`mass-and-density.md`), the scan economy (`scan-economy.md`), and the
Tiny People (`tiny-people.md`). Aligns to the ownership map: terrain
voxel writes are Zone 2, worker seeding is Zone 4, scan/growth/ledger
rules are Zone 6.*

## Goal

Replace the current static vegetation with **procedural voxel trees**
that:

- come in **different species per biome/region**,
- **grow over time** through discrete stages,
- include a single per-island **super tree** whose **roots span the
  island** and extend as the player scans new land,
- spread through **seeds** planted by the player *and* by workers,
- can be **pruned** because they are modular voxels,

while staying **deterministic and cheap to persist** (a tree is a
function of its genome and age, not a stored voxel blob) and staying
**inside the conservation ledger** and the **iOS VRAM ceiling**.

## Core model: tree = f(genome, age)

A tree is **not** stored as voxels. It is stored as a small genome and
re-derived on demand:

```
tree_record = {
  species:    "nyc_honeylocust",   // selects the ruleset / params
  seed:       0x8F3A...,           // deterministic RNG seed (shape)
  plantedAt:  <world-time>,        // growth clock origin
  growthFuel: <bloom banked>,      // optional: gates growth past a stage
  pruneMask:  [ ...segmentIds ],   // sparse player/worker cuts (see Pruning)
}
```

Rendered voxels = `voxelize(species, seed, age) − pruneMask`, where
`age` is derived from `plantedAt` + accumulated growth. Because the
genome is tiny, the world can hold thousands of trees in the ledger and
re-voxelize only what is near the camera / changing.

This is the standard **procedural-base + sparse-edit-delta** pattern
(Minecraft chunk deltas): the procedural function is the source of
truth; player edits live as a separate overlay so they survive
re-derivation.

### Two generators

| Generator | Used for | Why |
|---|---|---|
| **L-system** (rule grammar + seed; age = iteration count) | common / background trees | compact genome, deterministic, cheap; species = ruleset |
| **Space colonization** (branches grow toward attractor points; params = attractor density, influence radius, kill distance) | the **super tree** and its **roots** | naturally models growth-toward-space and area-driven expansion |

Skeleton → voxels: rasterize each branch segment with 3D Bresenham,
taper radius from trunk to tip; leaves are noise-masked ellipsoid blobs
(Bloom-grade voxels) at branch ends.

## Growth over time (discrete stages)

Growth is **staged**, not per-frame. Re-voxelize only at stage
transitions:

```
sapling → young → mature → ancient
```

- Each stage = one more iteration (L-system) or one more attractor
  round (space colonization).
- Stage advance is gated by **time** and optionally **bloom fuel**
  (the same bloom that feeds the scanner/forge/food — growth competes
  with refinement and survival, consistent with `scan-economy.md`).
- **Growth is purely time-based, online or offline.** Age is derived
  from `plantedAt` vs current world-time on every load — sessions do
  not matter. The world keeps growing while closed; opening it just
  re-derives the current age. (Idle game canon; LOCKED.)

### Initial state on load: mature-skewed, not barren

A freshly loaded island must read as an **established forest**, not
stage-zero seedlings:

- Most background trees load at **mature** (some **ancient**), with a
  minority of **young/sapling** for visual variety and to imply
  ongoing growth.
- The **super tree loads at a mid-point state** (e.g. ~50–60% toward
  its current cap), so it reads as ancient-but-still-growing.
- New growth from here on comes from **seeding** (below), not from the
  existing forest restarting.

## Species and biomes

Species are selected by biome / land-cover class (reuses the
`LC_GRASSLAND`, `LC_TREE_COVER`, `LC_WATER`-margin classes already in
the biome system). Starter table — extend per biome doc:

| Biome / region | Example species | Generator | Mature size | Notes |
|---|---|---|---|---|
| NYC temperate (`biome-nyc-temperate.md`) | honeylocust, callery pear, ginkgo | L-system | medium | street-tree silhouettes |
| Suburban / PNW forest | douglas fir, bigleaf maple | L-system | tall | dense `LC_TREE_COVER` |
| Arid / Southwest | mesquite, saguaro-analog | L-system | short/sparse | low canopy, wide spacing |
| Coastal / lakefront | mangrove-analog, palm-analog | L-system | medium | near `LC_WATER` margins |
| **Any island (one only)** | **Super Tree** | **space colonization** | island-scale | roots span the island |

Species genome = `{ generator, ruleset/params, leaf-style, palette }`.
Palette follows `aesthetic-pillars.md`: muted realistic bark/leaf vs.
the glowing accents reserved for tech and the Void.

## Seeding: how new growth starts

Seeds come in **two distinct classes** with separate economies:

### 1. Common seeds → L-trees (the everyday forestry loop)

Normal tree seeds. Cheap, plentiful, drive the background forest. Two
sources, both bounded by the **carrying capacity** cap (below):

- **Player plants seeds.** Player drops a seed on owned, scanned land;
  a new sapling-stage L-tree record is created at that cell. Costs
  bloom (a seed is Bloom-grade matter drawn from the ledger).
- **Workers plant seeds autonomously.** Tiny People — especially the
  Suburban/Forest Foragers ("organic engineers") — pick up seeds and
  plant them to start additional foresting near existing canopy,
  subject to the cap. GOAP action (Zone 4) that must preserve the
  conservation ledger (seed mass in = sapling mass out).

### 2. Super-tree seeds → the space-colonization super tree (rare)

The super tree is **not** an automatic island fixture — it is grown
from a **rare super-tree seed** with its own mechanic, separate from
the common forestry loop. Properties:

- **Rare.** One (or very few) per island. Not bench-craftable from
  bloom like common seeds.
- **Two acquisition sources (LOCKED):**
  - **Rare scan roll:** drops on a rare roll while Expanding into new
    land (mirrors the rare pure/core material rolls in
    `scan-economy.md`) — this is how a *first* super tree is found.
  - **Ancient drop:** an ancient-stage super tree drops a single seed,
    making super trees a heritable lineage as well as a scan find.
  - (Not from Void purge.)
- **Planting is a commitment.** Placing a super-tree seed sets the
  island's super-tree origin and starts the scan→roots→canopy loop
  below. Likely worker-assisted (a crew event), not a casual drop.
- **Workers do not autonomously plant super-tree seeds** — too
  consequential; this stays a deliberate player act.

### Carrying capacity (the safety valve)

Worker + passive spread is **capped per biome/island** by a density
ceiling. This is non-negotiable for the **iOS VRAM budget**
(`reference: tinyworld_ios_gpu_budget`): unbounded forestry crashes the
device via GPU OOM. The cap is also the lever the super-tree mechanic
pushes on (below). Light/space competition (Dynamic-Trees style) can
thin overcrowded clusters so the cap is reached gracefully, not by a
hard stop.

## The Super Tree: scan → roots → canopy

Each island has exactly **one** super tree, grown with space
colonization. Its defining mechanic ties directly to the scan economy:

```
scan new land  →  roots extend into the new area  →  THEN canopy grows
```

The unifying insight: **scanned land cells are root attractors.** The
super tree's roots use the same space-colonization algorithm with
**newly scanned tiles as the attractor cloud**. So:

- **Scanning increases the growth cap.** Covered (scanned) island area
  sets the **ceiling** the super tree can grow to. More land = higher
  cap. Uses **scan-seconds / Expand** from `scan-economy.md` — no new
  currency.
- **Sequenced cause→effect.** A fresh scan first drives **root growth**
  into the new cells (visible spread across the ground/surfaces), and
  *then* the **canopy** advances toward the new, higher cap over time.
- **Super tree fills over time, NOT directly (LOCKED).** A scan raises
  the super tree's cap and extends its roots immediately, but the
  **canopy fills toward the new cap over time** — it does not jump on
  the scan. The super tree is the one exception to the direct-canopy
  rule below.

**Note — regular land gets canopy directly (LOCKED).** For everything
*except* the super tree, newly scanned land **arrives already forested**
with mature-skewed L-tree canopy on the new tiles (immediate, so the
world is never barren). Direct add for the ambient forest; time-fill for
the super tree.

This makes the super tree a living readout of how much of the island
the player has claimed from the Void.

### Growing on/around architecture (not just ground)

The super tree does **not** only grow up from flat ground. Its roots
and branches **climb and wrap vertical geometry** — walls, cliffs, and
player-built architecture — strangler-fig / cliff-vine style. The
attractor cloud therefore includes **surface cells of standing
geometry**, not only ground tiles:

- **Surface attractors.** Wall faces, cliff faces, and the outsides of
  built structures emit attractors, so space colonization naturally
  routes growth *over and around* them instead of phasing through.
- **Collision-aware voxelization.** Branch/root segments rasterize
  *onto* solid surfaces (hug the face) rather than into them; the tree
  conforms to the terrain and architecture silhouette.
- **Reads as ancient infrastructure.** Roots lacing a cliff and
  branches embracing a wall sell the "the island grew around what's
  here" feeling, and visually couple the super tree to the player's
  builds.
- **Constraint:** growth wraps architecture but must not break
  walkability/collision the player relies on — surface-hugging voxels
  are decorative/climbable, not new blocking walls, unless explicitly a
  game-system block (Zone 6 / Zone 2 boundary).

## Pruning (modular voxel removal)

Because the tree is voxels, branches can be **pruned**. Architecture:

- **Prune-mask overlay.** A cut removes branch segments by adding their
  ids to `pruneMask`. Rendered = `voxelize(genome, age) − pruneMask`.
  The procedural base stays deterministic; cuts persist as a sparse
  delta. (Same base+delta pattern as terrain edits.)
- **Regrowth, redirected (LOCKED).** A cut is not permanent and does
  not simply heal back the same — the tree **regrows in a different
  direction** from the cut point (like horticultural pruning redirecting
  growth to new buds). Pruning is therefore a **shaping** tool: cut to
  steer where the canopy goes next. Implementation: a pruned segment
  seeds a new attractor/branch bias away from the original axis on the
  next growth stage.
- **Pruned biomass returns to the ledger, by grade.** Cut **leaves**
  return as **Bloom** (low grade); cut **wood** returns as **metallic
  wood** — the highest-grade organic material (see below). Mass
  conserved per `WORLD + STOCKPILE + BUILT + VOID === baseline`. Pruning
  is a **premium harvest**, not free deletion — this is the main reason
  to prune at all.
- **Workers auto-trim.** Tiny People can prune to keep density at the
  carrying cap (Zone 4 GOAP), turning the cap into an in-world
  behavior, not just a clamp.
- **Root pruning decreases the cap (LOCKED).** Cutting super-tree roots
  is **consequential**: it **lowers the growth cap** (less rooted area =
  smaller possible tree), so the canopy will recede toward the new lower
  cap over time. This makes roots a real trade-off — harvest premium
  root wood now (see Metallic Wood) at the cost of future size. The cap
  can be re-grown by scanning/re-rooting more area.

## Metallic wood (premium organic material)

Tree wood is not ordinary biomass — mature wood is **metallic wood**,
the **highest-grade organic material in the game**, with density/grade
**equivalent to the hyper-dense artificial/inorganic top of the element
ladder** (Densium/Core tier in `mass-and-density.md`). Implications:

- **Growth is organic refinement.** A tree starts as cheap **Bloom**
  (leaves, sapling, grass-tuft grade, density 0.25) and, as it matures,
  its trunk/branches **upgrade into metallic wood**. Growth over time is
  the *organic equivalent of the press* — it climbs the grade ladder,
  paid for by the bloom fuel that gates each stage. The longer a tree
  grows, the more premium material it banks in its trunk.

### Conversion ratio (LOCKED): growth *is* the press

Metallic wood sits at the **Densium tier (density 64)** — the *organic
counterpart* to the press-made Densium slug. It is the **only density-64
material obtainable by growth** instead of the press. **Core (256) stays
press/scan-only** — trees never reach Core, so Core scarcity is
preserved.

Each growth stage upgrades the wood **one density tier** (the press's
4:1 step, mass-conserved), paid in **bloom + wall-clock time** (the
§9.3 idle-pacing knobs in `mass-and-density.md`):

| Stage | Wood grade | Element | Density |
|---|---|---|---|
| sapling | soft | Loam | 1 |
| young | firm | Stone | 4 |
| mature | hard | Metal | 16 |
| ancient | **metallic wood** | Densium | 64 |

- **Leaves/fruit are always Bloom (0.25)**, every stage — and they are
  the tree's *net bloom output* (the renewable engine, below).
- **Headline ratio:** one ancient metallic-wood voxel embodies **256
  bloom-equivalents** of mass (64 ÷ 0.25), exactly matching the press's
  `256 bloom → 1 Densium` climb. A trunk densifies ×64 from sapling
  (Loam) to ancient (Densium) over its lifetime.
- **So maturing a tree is expensive but renewable:** the bloom comes
  from the L-tree forest over wall-clock time, and the Void claws an
  equal amount back (ledger stays even). Exact bloom-cost-per-stage and
  stage durations are the idle-pacing tuning knobs, not new mechanics.
- **Pruning/harvest is the payout.** Cutting mature wood yields
  top-tier material for building and protection (`protection =
  Σ(mass×density)/(1+d²)` rewards density heavily — metallic wood is
  excellent armor against the Void).
- **The super tree is the motherlode.** Its island-scale trunk and
  roots are the largest store of metallic wood in the world — which is
  exactly why root pruning (cap-lowering) is a real trade-off.
- **Growth consumes bloom (LOCKED).** Each growth stage burns banked
  **bloom** to upgrade trunk/branch voxels into metallic wood. Bloom is
  consumed, not minted — growth converts mass *up* a grade.
- **Conservation note (integration).** The bloom consumed must balance
  the metallic-wood mass produced so the ledger
  (`WORLD + STOCKPILE + BUILT + VOID === baseline`) and the entropy law
  stay intact. Exact bloom→wood conversion ratio = TODO with the
  press/refine numbers in `mass-and-density.md`.

## Bloom cycle and the Void counterbalance

Growth burns bloom, but **bloom is renewable — the L-trees grow it.**
The everyday forest is the world's **bloom engine**: as L-trees mature
they produce Bloom-grade matter (leaves, fruit), which is the
"bloom-fed economy" referenced in `scan-economy.md`. The full engine:

```
L-trees grow (time)  →  produce BLOOM (renewable, low grade)
        ↓
BLOOM fuels: super-tree growth (Bloom → metallic wood),
             the scanner, the forge, food
        ↓
metallic wood + high-grade stock accumulates (climb the ladder)
```

This is why the common forestry loop matters mechanically, not just
visually: **more L-trees = more bloom = more fuel** for advancing the
super tree and the rest of the economy. Expansion competes with
refinement and survival for the same bloom (canon).

### The Void keeps the ledger even

The total ledger is fixed at baseline. As the player converts mass *up*
the grade ladder (banking metallic wood, Densium, Core), the **Void
works to pull it back down** — the `VOID` term rises and the entropy
law un-grades matter, dragging gains toward baseline. The Void is the
**balancing antagonist**: the more you advance, the harder it pushes.

- **Void elements escalate with progression.** As the player climbs the
  grade ladder, **more advanced Void elements arrive** — the Void tiers
  up to match the player's tech/grade tier. Climbing is a *provocation*,
  not free safety.
- **Metallic wood is both reward and defense.** Because `protection =
  Σ(mass×density)/(1+d²)` rewards density, the high-density metallic
  wood the player harvests is also the best armor against the escalating
  Void — the loop self-balances: you grow to fight what your growth
  summons.
- **Design tension:** grow bloom to fuel advancement → advancement
  raises the Void → spend metallic wood on defense/protection → repeat
  at a higher tier. Idle progress and threat scale together.

## The full cultivation loop

```
SCAN land  →  claim area (raises super-tree cap, roots spread)
   ↓
GROW passively  →  forest loads mature; super tree fills toward cap;
                   saplings mature over wall-clock time
   ↓
SEED  →  player + workers plant new trees up to carrying capacity
   ↓
PRUNE  →  shape canopy / harvest biomass back into the ledger;
          workers auto-trim to the cap
   ↓ (repeat)
```

## Persistence

Per `persistence-and-access.md`, persist only the genome records
(`species, seed, plantedAt, growthFuel, pruneMask`) — never voxel
blobs. Voxels are re-derived on load. This keeps saved worlds small and
makes offline growth free (recompute age on load).

## iOS / VRAM constraints

- Re-voxelize lazily (near camera / on stage change), not per-frame.
- The carrying-capacity cap is the primary defense against GPU OOM.
- One island = one super tree; super-tree voxel count is bounded by the
  scanned-area cap, which is itself bounded by what the device can hold.
- Background trees skew to a few shared species genomes for instancing.

## Locked decisions

- **Growth is time-based, online or offline.** Age = `plantedAt` vs
  world-time, re-derived on load.
- **Super tree grows on/around architecture** (walls, cliffs, builds),
  not only flat ground — surface attractors + collision-aware
  voxelization.
- **Seeds split into two classes:** common seeds → L-trees (player +
  worker forestry loop); rare super-tree seeds → the space-colonization
  super tree (own mechanic, no worker auto-planting).
- **Canopy fill:** regular scanned land gets mature canopy **directly**
  (arrives forested); the **super tree is the exception** — scan raises
  its cap, canopy **fills over time**.
- **Super-tree seed source:** **rare scan roll** (new land) **+
  ancient-tree drop** (heritable). Not from Void purge.
- **Prune regrowth:** **redirected** — cuts regrow in a new direction;
  pruning is a shaping tool.
- **Root pruning** **lowers the super-tree growth cap** (consequential
  trade-off; re-grow the cap by scanning more area).
- **Tree wood = metallic wood:** highest-grade organic material,
  Densium/Core-equivalent density; growth refines Bloom → metallic wood.
- **Bloom is renewable, grown by L-trees.** The common forest is the
  bloom engine; growth/scanner/forge/food all draw from it. More
  L-trees = more fuel.
- **The Void keeps the ledger even.** Advancing up the grade ladder
  raises the `VOID` term and summons **more advanced Void elements**;
  metallic wood (high density) is both the reward and the best defense.

- **Conversion ratio = growth is the press.** Metallic wood = Densium
  tier (64); each stage climbs one tier (4:1, bloom-paid); leaves stay
  Bloom; one ancient wood voxel = 256 bloom-equivalents. Core stays
  press/scan-only.

## Open / TODO before coding

- **Tuning numbers only:** exact bloom-cost-per-stage and stage
  durations (idle-pacing knobs in `mass-and-density.md` §9.3). No open
  mechanics remain.

## First prototype (after lock)

One species, end-to-end on staging:

- An L-system tree (e.g. honeylocust) with ~4 growth stages writing
  into the existing trunks/leaves layers.
- Wall-clock growth from `plantedAt`.
- Player seed-drop + one worker auto-plant.
- Verify on staging via the headless harness for load/render/counts;
  motion/feel and final framing confirmed on KJ's device.

---

*Project TinyWorld — internal spec, June 2026*
