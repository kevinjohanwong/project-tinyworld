# Mass, Density & the Void — physics spec (June 2026)

The conservation ledger (Chunk 1) tracks *how much* matter a world has.
This spec defines what that matter *does*: mass is the world's defense
against the void, and the same law governs settlements, bridges, spindles,
and core blocks. One formula, no special cases.

## 1. The law

**Void pressure at any exposed point = base pressure ÷ local protection.**

```
protection(p) = Σ over nearby cells: (cell mass × cell density) / (1 + d²)
voidPressure(p) = basePressure × nightMod × seasonMod / max(protection(p), ε)
```

- `d` = distance from point `p` to the cell center
- Inverse-square falloff: protection is gravity-flavored — dense matter
  shields its neighborhood, weakly at range
- `basePressure × nightMod × seasonMod` reuses the existing day/night and
  seasonal void modifiers from the biome spec (unchanged)

## 2. Density table — the element ladder

Density follows the simplified periodic table (§9): six elements, each
4× denser than the last. A block's resistance to being eaten and its
contribution to shielding others are the same property.

| Element | Blocks | Density |
|---|---|---|
| **Bloom** | leaves, fruit, sapling, snow, grass tufts | 0.25 |
| **Loam** | dirt, grass block, sand, gravel | 1 |
| **Stone** | stone, concrete, planks, terracotta, brick | 4 |
| **Metal** | iron_bars, iron_block, rebar | 16 |
| **Densium** | compressed slug (press-made only) | 64 |
| **Core** | gravity lighthouse (see §5) | **256** |

Effective mass of a region = Σ (block count × density). A world of 50k
stone outweighs a world of 80k leaves. Powers of 4 are deliberate: each
element compresses 4:1 into the next with mass conserved exactly (§9.1).

## 3. Emergent behaviors (why one law is enough)

- **Square-cube safety** — perimeter grows slower than volume, so large
  worlds bleed proportionally less. Fresh small scans feel fragile.
  Correct.
- **Death spiral** — void steals blocks → local mass drops → pressure
  rises → faster theft. Neglect compounds; comeback urgency without
  timers.
- **Self-shielding core** — deep inside a settlement, protection from all
  directions ⇒ pressure ≈ 0. The void only ever gnaws edges.
- **Spindles & necking** — a long thin span has high perimeter and low
  local mass; the core can't protect it at range. The void eats the
  *thinnest* point first (lowest local mass), severing the span at its
  weakest neck.
- **Islanding** — a severed far piece loses all connection to any center
  of mass; its protection collapses and the void takes it fast. Lose the
  neck, lose the limb.
- **Bridge decay is emergent** — the old "8 pts/day" bridge rule and the
  anchor decay-factor table become *consequences* of this law, not lookup
  tables.

## 4. Bridge strategy (the player's honest choice)

| Strategy | Cost | Result |
|---|---|---|
| **Dense material** | blocks (stone vs dirt) | ~3–4× lifespan; still necks eventually — density buys *time* |
| **Pylons** | anchors every N meters | overlapping protection fields ⇒ effectively permanent — pylons buy *permanence* |
| **Maintenance** | re-scan the path physically | original bridge mechanic; cheap in blocks, expensive in legs |

Optimal pylon spacing is not a tuned constant — it falls out of where two
pylons' falloff curves stop overlapping. The falloff exponent is the one
global knob: tighten it and every bridge in the world gets more demanding.

## 5. Core blocks — gravity lighthouses

Super-dense matter (density 250) whose protection field reaches far enough
to anchor a bridge midpoint or shield a small outpost on its own.

**Acquisition — conservation holds either way:**

1. **Found** — rare roll when scanning new land (ties into the scan
   economy: more land → chance of rare materials). Found cores enter the
   ledger as part of the new land's mass budget.
2. **Compressed** — crafted at a press by climbing the element ladder
   (§9.1): 4 pure stone → 1 metal, 4 pure metal → 1 densium, 4 pure
   densium → 1 core. Full chain: **64 pure stone (mass 256) → 1 core
   block (mass 256)** — conserved exactly. Every press logs a `compress`
   block_event. Density is concentration, never creation.

**Trade-offs (what keeps them from being a win button):**

- **All eggs, one basket** — a core block is a vault of mass at a single
  point. Its field collapses the instant it's taken or destroyed, and
  everything it was shielding is suddenly naked.
- **Lighthouses attract ships** — rare void creatures (the Concrete Null
  archetype from the biome spec) preferentially hunt concentrated mass.
  A core block far from your settlement needs its own defense.
- **Compression is lossy in utility** — 64 stone can build walls,
  pylons, and structures; 1 core block can only sit and shine. You trade
  flexibility for field strength.

**Visual/lore:** a faint glow and hum; dust particles drift toward it.
Node lore: core blocks are what lidar towers are built around — a tower
is a core block taught to *broadcast* (discovery range) instead of just
*shield* (protection range).

## 6. Implementation notes

- **No per-block O(n²).** Bucket the world into coarse cells (8×8×8).
  Each cell stores Σ (count × density) of its contents. Protection at a
  point = weighted sum over nearby cell centers (cutoff radius ~6 cells).
- Cell totals update incrementally via the existing ledger hooks
  (`spawnBlockInto` / `removeBlockFrom` already fire on every
  place/remove) — nearly free.
- `removePressure` in the state tick and `estimateCatchUp` (offline
  erosion) replace their flat rates with the local-pressure formula,
  sampled at perimeter cells.
- Offline catch-up picks the lowest-protection perimeter cell as the rift
  site — "void creatures took 1,240 blocks from the NE edge" becomes a
  deterministic consequence of geometry.
- HUD: add a `mass` readout next to the W·S·B·V ledger line.
- Stockpiles count as mass at the stockpile's location: hoarding makes a
  *vault* (protects its surroundings), building makes a *territory*.
  Both are valid strategies.

## 7. Tuning knobs

| Knob | Effect |
|---|---|
| Falloff exponent (default 2) | global bridge/spindle difficulty |
| Element density base (×4 per tier) | material meta |
| Compression ratio (4:1 per tier) | press economy / core scarcity |
| Refine time + bloom cost per grade (§9.3) | idle-loop pacing |
| Blast strain per slug (§9.4) | bomb economy |
| Cell size (8³) | precision vs cost |
| Concrete Null aggro radius on cores & slugs | risk of concentrating mass |

## 8. Ships — keel cores and flight

The third use of a core block. A **shield core** protects a place, a
**lidar core** broadcasts from a place, a **keel core** *forgets its
place* — it binds nearby blocks to itself instead of to the earth, and
the bound group moves as one rigid body.

**Hull vs. Cargo (Stuck vs. Loose):**
- **The Hull (Stuck)**: Any block physically *placed* within the Keel Core's field is bound. This forms the armor, decks, and walls. It contributes to the ship's effective mass (which determines void pressure and speed).
- **The Cargo (Loose)**: Blocks in the *stockpile* resting on the deck are not magically bound—they obey gravity and inertia. If a ship takes a hit or makes a violent maneuver, unsecured stockpile cargo can spill off the deck into the void. Safe transport requires physically building a walled cargo hold out of hull blocks.

**The Helm (Piloting):**
A keel makes mass float, but requires a pilot to navigate and feed the engine.
- **Tiny Person Pilot (Idle/Long-haul)**: Assigned to the helm, they plot the course and manage the long transit offline. They must physically carry fuel (loose blocks, ideally cheap loam or bloom) from the cargo hold to the keel to burn. If boarded by void creatures, the pilot must leave the helm to fight—stopping the ship mid-air.
- **User Pilot (Active/Tactical)**: The player can take direct control for high-stakes maneuvers (threading tight void pressure, manual bomb-drops, or precise docking). Active piloting consumes the User's attention and is strictly for real-time play.

**Binding (all emergent from the field math):**

- **Ship size = field radius.** Every block must sit inside the keel's
  protection field. Bigger ship ⇒ more keels, spaced like pylons — a
  capital ship is a flying bridge, with the same necking risk between
  cores. Overload the field and outer blocks shear off in flight
  (visible debris — the feedback *is* the failure).
- **Mass = speed.** Heavy armor protects but slows. Density becomes a
  third trade-off in ship design.

**Travel rule (protects geography-as-auth):**

Ships can only cross **perceived space** — the node's perception radius
plus along live bridges. Unperceived void is unnavigable darkness. So
the range hierarchy is strict: **feet → bridges → ships**, each layer
extending the one below, never bypassing it. Bridges become shipping
lanes; lidar towers become ports.

**Costs — flight feeds the void.** The keel stays aloft by burning mass,
and conservation demands a sink: burned mass transfers **directly to the
void pool**. One rule, three consequences:

1. **Susceptibility** — a ship is islanded by definition (no ground
   connection) *and* it streams mass into the void as it flies. That
   stream is a beacon: void pressure on a ship in flight gets a flight
   multiplier (~×3), worse at night, and creatures preferentially
   intercept ships over gnawing settled edges.
2. **Burn rate** — fuel cost scales with bound mass × distance. The
   burned mass is gone from your budget until you raid it back from the
   void. Every flight measurably strengthens the antagonist.
3. **No repairs aloft** — reclamation requires an anchored ground
   connection. Blocks lost in flight scatter where they fall or go
   straight to the void pool. Repairs and refits happen only docked at
   an anchored settlement.

Net effect: ships are endgame, occasional, and expensive — a deliberate
expedition with a real bill, not a traversal upgrade. Walking is free,
bridges are cheap-but-maintained, flight is powerful-but-costly. The
idle loop stays grounded.

## 9. The simplified periodic table — elements, grades, and the Return

Everything material in the game reduces to **six elements, two dopants,
three grades, and one failure mode**. Mass is always conserved; *order*
is not. The void cannot destroy a single block — but it un-works
everything it touches. The void is entropy; refinement is order paid for
in bloom. The whole game is a terrarium fighting the second law.

### 9.1 The ladder (density axis)

The six elements of §2, each 4× the density of the last. The only way
up is **compression** at a press structure:

```
4 × pure[tier k]  →  1 × raw[tier k+1]     (mass conserved exactly)
```

- Only **pure**-grade matter compresses cleanly (see 9.3).
- The output arrives **raw** — climbing a tier drops you at the bottom
  of the next tier's grades. Every summit is false; aspiration ladders.
- Full climb: 256 loam → 64 stone → 16 metal → 4 densium → 1 core,
  all mass 256. The press never creates or destroys, only concentrates.

### 9.2 Dopants (function axis)

Alloys never get new density numbers — alloy mass = sum of inputs,
density tier stays the host's. Only the *function* changes:

| Dopant | Meaning | Examples |
|---|---|---|
| **+ Bloom** | mobility / handling | **Wattle** (stone + bloom): stone's mass, carried at loam speed. **Weaveplate** (metal + bloom): one-person-portable metal, ship refit material. **Keel** (core + bloom): a core taught to *move* (§8). |
| **+ Metal** | signal / broadcast | **Lidar core** (core + metal): broadcast instead of shield — discovery range (§5). |

Handling affects **logistics only** — carry speed, build speed, docked
refit speed. It never touches void pressure, protection, or fuel cost.
Mass is mass; the void doesn't care about handles. Doping requires
**worked**-grade or better hosts, and every alloy consumes bloom or
metal from the same budget that feeds growth and forges — mobility
literally eats your garden.

### 9.3 Grades (order axis)

Each element holds three grades: **raw → worked → pure**. Same density,
same protection, same fuel value — grade changes only what the matter is
*eligible* for:

| Grade | Unlocks |
|---|---|
| **Raw** | building, fuel — what scans mostly yield |
| **Worked** | doping (alloys require worked+ hosts) |
| **Pure** | compression up the ladder |

- **Refining costs work + bloom, never mass.** Workers run mills/forges
  over real elapsed time — the core idle resource. Return tomorrow to
  200 worked stone.
- **Scans roll mostly raw**, with rare biome-flavored pure finds (a vein
  of pure metal in an industrial scan is a jackpot worth defending).
  Biomes bias the rolls — urban skews stone/metal, parks skew bloom —
  so no region has everything, and bridges/ships become *trade routes*
  driven by element scarcity.
- **The void un-grades.** Stolen matter raided back from a rift returns
  **raw**. Mass conserved, work destroyed. This is the entropy law made
  mechanical: void losses sting beyond the ledger because they erase
  labor, not matter.

Ledger events: `refine` (grade up), `alloy` (dope), `compress` (tier
up) — all mass-neutral, all auditable.

### 9.4 The Return — unstable slugs and bombs

The grade rules have a deliberate loophole: the press *will* accept
raw or worked matter. The imperfections store strain. The output is an
**unstable slug** — correct density, correct mass, ledger-balanced,
wound like a spring.

Strike it with enough force — dropped, struck, shot, **bitten by a void
creature** — and it **Returns**:

1. **The slug decompresses violently**, cascading back down the ladder
   into its constituent raw blocks, scattered outward. 4 raw stone went
   in; 4 raw stone rain out. One `detonate` block_event, mass exact.
2. **The shockwave un-makes everything in radius** — alloys split back
   into host + dopant, compressed matter steps down a tier, worked/pure
   grades revert to raw, placed blocks shake loose into scatter.
   Nothing is destroyed. Everything is disordered.

**Blast math reuses the protection law.** Blast force at distance
`d = totalStrain / (1 + d²)`, and a target Returns only where incident
force ≥ its density. So bomb *size* matters twice:

| Assembly | Strain | Cracks |
|---|---|---|
| 1 slug | 1× | bloom, loam |
| 2×2×2 (8 slugs) | 8× | stone, worked metal |
| 3×3×3 (27 slugs) | 27× | densium, core-adjacent matter |

Bigger bombs aren't just wider — they're the only way to un-make denser
matter. Weapon aspiration falls out of the same ×4 ladder.

**Against the void.** The Return attacks *structure* and doesn't care
whose. Void creatures are the void's only ordered things — coherent
forms hauling bound stolen mass. A blast dissipates the creature and
scatters everything it carried back into the WORLD pool as raw blocks
(ledger: void → world via `detonate`). Bombs are the one tool that
works on both sides of the war: bait a Concrete Null with a slug (it
hunts concentrated mass), or sever your own bridge neck before
something crosses it.

**Counterweights (no clean bomb):**

- **Slugs leak a beacon** like ship-burn — storing them raises local
  void pressure. An armory is a lighthouse for monsters.
- **Chain reactions** — slugs inside a blast radius also Return. A
  careless stockpile is a crater (of perfectly conserved raw blocks).
- **Friendly entropy** — the shockwave un-grades *your* nearby matter
  too. Every detonation destroys work, including yours.
- **Noise at night** — a detonation during aggressive void hours draws
  creatures toward the site.

Legitimate uses: demolition mining (scatter a dense vein into haulable
raw), clearing void-occupied ruins, trap warfare, bridge denial, and —
expensively — ship-dropped charges, paying burn mass to deliver
disorder.

## Sequencing

Builds on Chunk 1 (ledger — done). The local-pressure field lands with
**Chunk 3 (void creatures)**, since that's when pressure becomes visible
behavior. Core block acquisition rolls land with **Chunk 4 (scan
economy)**. Ships are **Chunk 5** — they require the pressure field,
core blocks, and the scan economy all in place.

---

*Project TinyWorld — internal spec, June 2026*
