# Building Reference Portfolio

## Purpose

These voxel buildings are visual references for TinyWorld's worker construction grammar. They are not literal blueprints. Workers must rebuild their architectural ideas as functional structures with supported foundations, hollow rooms, real entrances, navigable doors, supported floors, weatherproof roofs, and no floating parts.

The ten supplied archives contain **nine unique designs**. The two `Small Building 03` archives are byte-identical duplicates.

## Shared dimensional convention

The source `.vox` files use a 0.1-unit grid relative to their `.obj` exports. Their source extents are therefore useful as proportions, not as TinyWorld construction dimensions. Before generation, normalize each design to TinyWorld's 0.5 m voxel grid and enforce:

- Worker clear height: at least 4 voxels (2 m)
- Door opening: at least 2 voxels wide × 4 voxels high
- Habitable floor-to-floor height: 5–7 voxels
- Exterior wall thickness: 1 voxel by default
- Supported floor/roof spans: structural wall, post, arch, or beam under every long span
- Interior volume: explicit air cells, never a solid decorative mass

## Portfolio

| ID | Source size (voxels) | Role | Invariants | Style grammar | Optional moves |
|---|---:|---|---|---|---|
| `large-01` | 88×46×41 | Civic hall / workshop | Broad rectangular footprint; central entrance; single enclosed main volume | Strong horizontal cornice; repeated façade bays; paired vertical red-orange posts; centered dark timber portal | Side door; raised stoop; rear work bay; shallow parapet |
| `small-01` | 34×28×46 | Compact two-story house | Narrow enclosed footprint; centered entrance; two usable floors | Heavy top parapet; vertical timber strips; asymmetric window group; warm trim on pale masonry | Corner balcony; roof court; side extension |
| `small-02` | 33×28×60 | Watch house / raised workshop | Supported upper room; accessible vertical circulation; enclosed top room | Open post-and-beam middle deck; broad dark eaves; compact rooftop lantern | Wraparound balcony; stair tower; lookout roof |
| `small-03` | 34×24×38 | Compact house | One enclosed room stack; valid doorway; stable rectangular foundation | Oversized parapet; recessed tall entrance bay; side window projection; vertical warm trim | Side bay; awning; roof court |
| `small-04` | 33×28×59 overall, two source models | Narrow stair/utility house | Continuous supported core; accessible entrance; enclosed upper room | Strong vertical entrance recess; stepped massing; small bright roof cap | Side plinth; stair tower; roof lantern |
| `tall-01` | 24×34×80 | Slender residential tower | Supported stacked floors; accessible stair core; entrance at grade | Base portal; central dark timber bay; repeated upper window rhythm; heavy crown | Projecting window bay; roof court; side buttress |
| `tall-02` | 34×28×100 | Balcony tower | Supported tall core; usable floors; protected entrance | Two-part vertical massing; open columned upper gallery; dark belt course; rooftop lantern | Wraparound balcony; setback; observation room |
| `tall-03` | 38×24×80 | Gatehouse / narrow tower | Stable base; continuous vertical circulation; enclosed upper floors | Asymmetric lower gateway; central timber balcony; deep crenellated crown | Side door; projecting balcony; roof court |
| `tiny-01` | 19×28×48 base model; 70-model animated kit | Minimal starter tower / transformable kit | One functional enclosed room minimum; supported core; real entrance | Narrow silhouette; dark timber entrance frame; exaggerated crown; sparse wall accents | Growth stages; attached arm/wing modules; rooftop expansion |

## Reusable grammar

### Invariants

Every generated plan must pass these before a worker starts building:

1. Foundation cells are supported by terrain or an explicit substructure.
2. Every occupied floor is reachable from the entrance without mining.
3. At least one enclosed room has a floor, walls, ceiling/roof, and navigable doorway.
4. All upper floors, balconies, cornices, and roofs have a support path to the foundation.
5. The roof sheds weather outward and does not seal the doorway or stairs.
6. No ornament is allowed to float; decoration attaches to a structural face.
7. Materials are visible and locally available before construction begins.

### Style grammar

- **Massing:** rectangular core; optional lower plinth; optional upper setback; crown as a distinct final tier.
- **Bay rhythm:** divide exposed façades into 2–5 consistent bays; never leave a narrow remainder bay.
- **Vertical rhythm:** base → body → crown. Towers may insert a gallery or belt between body tiers.
- **Frame rhythm:** dark timber at corners and entrance axes; warm red-orange trim marks major verticals and selected horizontals.
- **Openings:** one dominant entrance axis; windows align by bay and floor; one controlled asymmetric projection is allowed.
- **Roof family:** heavy parapet, roof court, or compact lantern. Roof moves belong only to the highest exposed tier.
- **Projection hierarchy:** entrance/porch deepest, balcony second, windows shallowest, surface trim minimal.

### Optional moves

Choose 0–3 after the functional core is valid:

- Balcony or gallery
- Roof court or lantern
- Side wing or bay projection
- Porch or stoop
- Chimney or vent stack
- Cross-axis entrance frame
- Upper setback
- Asymmetric lower extension

## Developmental generations

1. **Shelter:** `tiny-01` principles — one room, one door, one roof, minimal crown.
2. **House:** `small-03` / `small-04` — stronger entrance axis, second room or floor, restrained trim.
3. **Established house:** `small-01` / `small-02` — multiple floors, balcony/gallery, clearer base-body-crown composition.
4. **Tower:** `tall-01` / `tall-03` — stair core, repeated bays, structural vertical rhythm, distinct crown.
5. **Civic/advanced:** `tall-02` / `large-01` — compound massing, galleries, broad public room, more demanding material and support plan.

## Generation pipeline

```text
site + available materials + worker capability
  → choose developmental generation
  → create functional core plan
  → divide exposed façades into bays
  → apply base/body/crown style grammar
  → select 0–3 optional moves
  → validate support, circulation, enclosure, roof, and material ledger
  → emit staged worker construction plan
```

Randomness may choose among valid bay counts, roof families, opening patterns, and optional moves. It must never repair invalid support, circulation, or enclosure after the fact.

## Source inventory

Normalized source packages are stored under `assets/building-references/source/`. Each package retains its original `.vox`, `.obj`, `.mtl`, palette texture, and animated preview where present. `small-03` is stored once.
