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

## 2. Density table

Density reuses the void-resistance tiers from `biome-nyc-temperate.md` —
a block's resistance to being eaten and its contribution to shielding
others are the same property.

| Tier | Blocks | Density |
|---|---|---|
| Organic | leaves, fruit, sapling, snow | 0.2 |
| Loose | dirt, grass, sand, gravel | 0.5 |
| Surface | concrete, planks, terracotta | 1.0 |
| Masonry | stone, smooth_stone, stone_bricks | 2.5 |
| Metal | iron_bars, iron_block | 6.0 |
| **Core block** | compressed matter (see §5) | **250** |

Effective mass of a region = Σ (block count × density). A world of 50k
stone outweighs a world of 80k leaves.

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
2. **Compressed** — crafted at a press/forge structure by crushing
   ordinary matter: **1,000 stone (2,500 mass) → 1 core block (density
   250, ~10:1 concentration)**. No mass is created — the ledger logs a
   `compress` block_event moving mass between pools. Density is
   concentration, not creation.

**Trade-offs (what keeps them from being a win button):**

- **All eggs, one basket** — a core block is a vault of mass at a single
  point. Its field collapses the instant it's taken or destroyed, and
  everything it was shielding is suddenly naked.
- **Lighthouses attract ships** — rare void creatures (the Concrete Null
  archetype from the biome spec) preferentially hunt concentrated mass.
  A core block far from your settlement needs its own defense.
- **Compression is lossy in utility** — 1,000 stone can build walls,
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
| Density table | material meta |
| Compression ratio (1,000:1 blocks, 10:1 mass) | core block economy |
| Cell size (8³) | precision vs cost |
| Concrete Null aggro radius on cores | risk of concentrating mass |

## Sequencing

Builds on Chunk 1 (ledger — done). The local-pressure field lands with
**Chunk 3 (void creatures)**, since that's when pressure becomes visible
behavior. Core block acquisition rolls land with **Chunk 4 (scan
economy)**.

---

*Project TinyWorld — internal spec, June 2026*
