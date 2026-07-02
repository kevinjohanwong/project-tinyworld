# Worker Growth, Food Sources & Mech Piloting

**Status:** Draft spec — KJ + Claude, 2026-07-02
**Depends on:** `tiny-people.md`, `scan-economy.md` (conservation ledger), `sentinel-supplier.md`, the live worker loop in staging (`tw-staging-app.tsx`).

## 1. Problem

The worker loop is complete but **closed**. A mote harvests, builds a hut, rests, repeats — but nothing accumulates. Energy (0..1) only modulates pace (`paceMul = 1.6 − 0.8·energy`); a zero-energy mote still works, just slowly. A day-10 mote is identical to a day-1 mote. There is no progression axis and no food chain: fruit is player-only satiation plus refine-press fuel.

This spec adds three interlocking systems: **size as growth**, **food as the growth input**, and **mechs as the size payoff**.

## 2. Size = Max Energy

A mote's **size** is its single progression stat. Size determines energy *capacity*, not pace.

| Tier | Name  | Scale | Energy capacity | Visual |
|------|-------|-------|-----------------|--------|
| 1    | Speck | 0.7×  | 1.0             | small soot ball, big eyes |
| 2    | Mote  | 1.0×  | 2.0             | current sprite (default) |
| 3    | Puff  | 1.4×  | 4.0             | visibly plump, denser fuzz |
| 4    | Elder | 1.9×  | 8.0             | fills a cockpit porthole edge-to-edge |

- Energy becomes an **absolute pool** (`energy` in 0..capacity). Work drain per ms is unchanged, so a Puff works ~4× longer per day than a Speck before slowing down. Pace derives from *fill fraction* (`energy / capacity`), so the existing pace/animation/fumes thresholds keep working untouched.
- Night rest refills toward capacity, still **only when sheltered under a roof** (unchanged). Bigger motes need proportionally longer to fully recharge — an Elder that skips shelter feels it for days.
- Visual: sprite group scale + eye spacing scale with tier. Tier must be readable at a glance in the world and through mech portholes.
- New spawns are always Speck. Size never decreases (see §3 — starvation halts growth, it doesn't shrink; shrinking reads as punishment and creates death-spiral loops).

## 3. Growth System

Growth is **earned through the existing loop plus food**. A mote accumulates hidden **growth points (GP)** and tiers up at thresholds.

GP sources, per day:

1. **Sheltered rest streak** — completing a full night under a roof: +1 GP. Consecutive-night streaks add +1 bonus at 3 and 7 nights. (Rewards the shelter loop we already have.)
2. **Work throughput** — every 24 blocks moved through the ledger (one HUT_COST worth): +1 GP. (Rewards actually contributing.)
3. **Food eaten** — each fruit consumed: +2 GP *and* is the gate: **a mote cannot bank more than 3 GP past its last meal.** No food → growth stalls, mote keeps working (soft gate, same philosophy as energy/pace).

Tier thresholds (cumulative GP): Speck→Mote **10**, Mote→Puff **30**, Puff→Elder **80**. Elder is the cap.

Tier-up moment: brief glow + a one-block "molt" — the mote sheds a `fluff` block onto the ground (VOID → WORLD, so growth *returns* matter to the world rather than minting it; keeps the ledger honest and gives molts a collectible feel).

### 3.1 Comfort — the growth multiplier

A slow-moving **Comfort** stat (0..1) per mote, distinct from energy. Energy is *daily* (drains/refills, sets pace); comfort is *long-term* and multiplies GP gain (**0.5×–1.5×**). Happy motes grow faster; miserable ones stagnate but never regress.

Inputs (weighted average, drifts over days, not minutes):
- **Home warmth** — the §6 shell average. A leaf-lined nest isn't just faster rest, it's a happier mote.
- **Housemate compat** — the existing MBTI `compat` math finally affects outcomes: a hut of clashing personalities grows slowly. Gives the pairing system mechanical teeth.
- **Meal regularity** — fed *on time*, not just fed (streak of on-schedule meals).
- **Beam coverage** — living inside tower light (§7) feels safe; motes in beamed zones gain comfort.

Zero new rendering: the 5-frame expression atlas (open/half/closed/happy/focused) already exists — comfort drives the resting face, so colony morale is readable at a glance.

## 4. Food Sources

Constraints: conservation ledger (`WORLD + STOCKPILE + BUILT + VOID === baseline`), decision #11 (stockpile is visible matter, no hidden inventories), and the existing organic lifecycle (leaf → fruit → drop → rot → seed → sapling → tree; fruit layer is deliberately outside strict conservation).

### 4.1 Fruit — the staple

- Workers gain an **Eat** behavior: when hungry (satiation timer expired) and GP-gated, a mote walks to the **visible stockpile**, takes 1 fruit, eats it. Ledger: `STOCKPILE → VOID` — *identical* to the player-eat path at tw-staging-app.tsx:6314, so no new ledger math.
- Workers can already carry fruit (`SOFT_WORKER_LAYERS`); harvesting fruit to the stockpile becomes a standard chore alongside blocks.
- This creates deliberate **competition for fruit** between three sinks: player satiation, refine press (1 fruit/grade-step, already "starves" and waits), and now worker growth. Scarcity is the point — it drives orcharding.

### 4.2 Orcharding — closing the loop

- New worker chore: **plant seeds**. Motes carry dropped seeds to open dirt/grass and plant them (seed → sapling → tree via the existing lifecycle). More mouths → need more trees → workers plant trees.
- This is the on-ramp to KJ's **super-tree** idea: one tree per island can be nurtured into the island's "engine" — a fruit-abundance anchor and the organic counterforce to the Void. Super-tree gets its own spec; this doc only reserves the hook (a tree that receives N sustained seasons of worker tending flags as super-tree candidate).

### 4.3 Forage graze — the survival trickle

- A hungry mote with **no stockpiled fruit** can graze clover/grass blocks: slow satiation trickle, **zero GP**, does not consume the block (reads as nibbling, no ledger movement). Prevents dumb starvation deadlocks while keeping fruit strictly necessary for *growth*.

### 4.4 Nectar — the premium food (press recipe)

- New refine-press recipe: **3 fruit → 1 nectar** (pressed, jar-like block in the stockpile). Eating nectar: +8 GP and full energy refill. This is the intended way to push a Puff to Elder without weeks of fruit-by-fruit feeding — and it makes the press strategically interesting beyond fuel-burning.
- Ledger: 3 `STOCKPILE → VOID` (fruit) + 1 `VOID → STOCKPILE` (nectar). Net −2 to stockpile; conservation holds.

## 5. Mech Piloting Tiers

Mechs are the payoff for size. Gate = **crew size points ≥ mech requirement**, where a mote contributes its tier number (Speck 1 … Elder 4). Every crewed porthole shows its mote (the carved-cockpit system already renders spirits through portholes).

| Class    | Requirement | Portholes | Role (unique utility) |
|----------|-------------|-----------|------------------------|
| Drone    | 1 (any Speck+) | 1 | scouting, light hauling — the starter |
| Sentinel | 4 (one Elder, or Puff+Mote…) | 1–2 | void defense patrol |
| Titan    | 10 (multi-mote crew) | 3+ | heavy terraforming, void reclamation |

- **Multi-mote crews:** requirement can be met by any combination whose tiers sum to it, capped by porthole count. A Titan might fly with Elder+Elder+Mote (4+4+2). Crew visibly fills portholes; empty portholes read as "under-crewed."
- **Mech energy = crew pool.** The mech drains the crew's combined energy pool while active; sortie length scales with crew size. When the pool runs low the mech limps home (pace multiplier applies to the mech).
- **Opportunity cost is the balance lever:** every pilot is a mote *not* harvesting, building, or planting. Mechs must therefore do things motes physically can't. If a mech only does what 3 motes on foot could do, it's mis-designed.
- Crews still need shelter: a docked mech's cockpit counts as a roof for the crew at night (mechs are the mobile hut).

### 5.1 What mechs can actually do

Baseline on foot: carry 1 soft-layer block (`SOFT_WORKER_LAYERS`: grass, dryGrass, leaves, fruit, dirt, snow), build huts/homesteads, plant seeds, graze. Mechs never compete with the domestic economy — they extend it along three pillars:

1. **Bulk & hard matter.** Motes can only lift soft layers. Mechs grip **stone, metal, wall** — and carry bundles: Drone 4 blocks, Sentinel 8, Titan 24 (one HUT_COST per trip). Terraforming, moving scan rubble, clearing collapsed walls: mech-only.
2. **Construction at scale.** Huts stay mote-built. Mechs place *blueprint-scale* structures — watchtowers, perimeter walls, bridges between scan islands — feasible because a Titan places 24-block bundles.
3. **Void work (the exclusive).** Only a mech can operate at the void frontier. Two verbs:
   - **Hold** (Sentinel): patrol the frontier, stop void encroachment on world edges.
   - **Reclaim** (Titan): mine matter back out of the void — `VOID → STOCKPILE`. Every eaten fruit, press-burn, and consumed block flows one-way into the void; reclamation is the only counter-flow, making mechs the sole engine of net world growth besides new scans. Conservation holds exactly — nothing minted, matter pulled back from the reservoir.

Thematic pairing with the super-tree: the tree fights the void *organically* (growth, fruit, seeds), mechs fight it *mechanically* (hold the line, reclaim mass). Island health = both working. This also resolves the opportunity cost: an Elder leaves the orchard economy because reclaimed void-matter is worth more than what its hands could harvest.

## 6. Materials: Warmth vs Resilience

Shelter is currently material-blind (capacity = enclosed air volume ÷ 2, any 24 blocks). Materials become a two-stat tradeoff — living materials nurture, industrial materials protect:

| Material | Warmth (rest quality) | Resilience (vs void) | Feel |
|----------|----------------------|----------------------|------|
| leaves   | 1.25× | 0.2  | cozy nest, void eats it |
| grass    | 1.15× | 0.25 | thatch |
| snow     | 1.2×  | 0.3  | igloo (seasonal?) |
| dirt     | 1.0×  | 0.5  | baseline sod hut |
| trunks   | 1.15× | 0.6  | log cabin |
| stone    | 0.9×  | 0.85 | solid but drafty |
| metal    | 0.75× | 1.0  | void-proof, sterile |

- **Warmth → rest.** The enclosure flood-fill already enumerates the shell; average warmth of shell blocks multiplies `restMult`. Warm homes recover energy faster overnight → better pace and GP streaks. A leaf-lined hut is genuinely the best *starter* home.
- **Resilience → void erosion.** Structures inside the void's influence radius lose blocks at a rate scaled by (1 − resilience), ledger-clean as `BUILT → VOID`. This gives the mech verbs concrete function: **Hold** (Sentinel) suppresses erosion pressure in its patrol zone; **Reclaim** (Titan) pulls the eaten mass back. The void chews soft buildings; mechs win the matter back.
- **Hybrid building emerges free:** composition is a shell average, so "metal outer wall, leaf-lined interior" is a real strategy — frontier bunkers vs. cozy inner-village nests.
- **Material progression = tech progression:** motes lift only soft layers (§5.1), so the mote era builds warm-but-fragile organic huts; stone halls and metal frontier walls require mechs.
- **Refine grades pay off:** worked/pure grades multiply *both* stats (+15% / +30%) — the press's output becomes premium building material, not a curio.

## 7. Towers: Recognized, Not Blueprinted

Static void defense to complement mobile mechs. Core principle (KJ): **the player designs and builds towers freely — the game *recognizes* one, it never places one.** Same grain as the enclosure flood-fill deciding "this is shelter" from raw geometry. Towers are the second structural recognizer.

### 7.1 What qualifies

A structure ignites as a tower the moment its shape qualifies — no menu, no prefab:
- contiguous vertical stack of built blocks,
- compact cross-section (fits within 3×3 at every level),
- rises **≥6 blocks above local terrain**,
- **open sky directly above** (reuses the fruit sunlit-check style),
- capped with a **lens**: a refined pure-grade block from the press.

When the last block lands and the check passes: a beam of light rises from the lens. The player *discovers* they built a tower.

### 7.2 Line of sight — why height wins naturally

Beam coverage = what the lens can *see*: radius scales like a real horizon (`~k·√(height above local terrain)`), occluded by hills, trees, and buildings. Nothing forces building high — a valley tower is just a lamp. Rolling hills become strategic: hilltops are prime beacon real estate; beam shadows behind ridges are where the void lingers.

### 7.3 What the beam does

- **Suppresses void erosion** (§6) on every block the lens can see.
- **Comfort aura** (§3.1): motes living in beamed zones feel safe.
- Coverage doesn't stack — overlapping beams waste light, encouraging a spread network.

### 7.4 Towers vs mechs — different currencies

Towers convert **matter** into standing defense (cost: blocks + a pure lens, no crew). Mechs convert **motes** into active defense (cost: your best workers). Permanent mech coverage would strangle the colony via crew opportunity cost; beacons hold the interior cheaply, Sentinels patrol the shadows beams can't reach, Titans reclaim what the void already took.

### 7.5 Materials matter here too

- Shaft **resilience** (§6 average) = tower durability at the frontier — a dirt spire with a pure lens works, but the void gnaws it.
- **Lens grade** (worked vs pure) multiplies beam radius.
- Motes lift only soft layers, so tall stone/metal towers need mech-hauled bundles — the endgame beacon network is a whole-colony project.

## 8. Telemetry & Debug

Extend `window.__tw`:
- `growthReport()` — per mote: tier, GP, comfort, last meal, streak.
- `feed(n)` / `setTier(name, tier)` / `setComfort(n)` — test levers, mirroring `setEnergy(n)`.
- `towerReport()` — recognized towers: lens position, height, beam radius, covered-block count.
- Worker HUD chip adds tier glyph and GP-to-next progress; fumes/energy display switches to fill-fraction (no visual change for tier-2 motes).

## 9. Implementation Phases (staging first)

1. **Size/energy refactor** — capacity per tier, fill-fraction pace, sprite scaling, `growthReport`. No food yet (all motes Speck→Mote via rest/work GP only). Smallest testable slice.
2. **Worker eating + fruit chore** — Eat behavior, GP food gate, harvest-fruit chore, HUD.
3. **Orcharding** — seed-planting chore.
4. **Warmth + comfort** — shell-composition warmth into `restMult` (piggybacks on the enclosure flood-fill); comfort stat + GP multiplier + expression wiring (erosion waits for phase 7).
5. **Nectar recipe** — press extension.
6. **Tower recognition** — shape check + lens + beam visual + LOS coverage map. (Independent of mechs; can land before them and be immediately fun for the player.)
7. **Mech gating + void erosion** — crew points, porthole crews, crew energy pool, erosion/Hold/Reclaim; beams and Sentinels both suppress. (Biggest; lands after growth is proven fun.)

## 10. Open Design Calls

1. **Population vs. size:** should big motes also *spawn* new Specks (colony growth), or is population strictly scan/void-driven? Currently unspecified.
2. **Elder cap:** is Elder truly terminal, or does an Elder + super-tree interaction unlock a 5th state (tree-bonded guardian)?
3. **Player feeding:** may the player hand-feed a carried fruit directly to a mote (E on mote while carrying fruit)? Cute, but bypasses the stockpile — proposal: allowed, still ledger-logged as stockpile→void since carried items are stockpile.
4. **Graze visual:** does grazing nibble the grass sprite temporarily (regrows) or no visual at all?
5. **Mech roster:** which mechs exist at launch — is the current Sentinel the tier-2 mech, with Drone below and Titan later?
6. **Void resistance:** does reclamation have a resistance mechanic (rate scales with crew points; void "pushes back" harder in winter per the thermodynamic-drain lore in `tiny-people.md`), or flat rate to start?
7. **Seasonal warmth:** does warmth weight heavier in winter (thermodynamic drain), making insulation a seasonal scramble?
8. **Snow melt:** do snow structures melt out of season (blocks return `BUILT → WORLD` as wet/water), or is snow stable once built?
9. **Erosion scope:** is void erosion frontier-only (influence radius), or also a slow global trickle that makes *all* soft structures need upkeep?
10. **Lens requirement:** must the cap be pure-grade, or does raw metal work as a weak early-game lens (pure = radius multiplier)? Pure-only makes the press mandatory before any tower exists.
11. **Beam at night:** does the beam double as actual light at night (safe outdoor zone — unsheltered motes in a beam go dormant but don't lose comfort)?
12. **Comfort floor:** can low comfort ever do more than slow growth (e.g., a deeply miserable mote refuses to pilot mechs), or is growth-rate the only lever?
