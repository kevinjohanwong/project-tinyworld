# Project Quantum — NYC Temperate Biome Spec

**Location basis:** New York City (lat ~40.71°N, lon ~74.0°W)  
**Köppen classification:** Cfa — Humid continental (borderline subtropical)  
**Arnis biome mapping:** `minecraft:plains` (built-up), `minecraft:forest` (tree cover), `minecraft:river` / `minecraft:ocean` (water)

---

## 1. Block Palette by Surface Type

Arnis derives block type from ESA WorldCover land cover class. For NYC, the dominant classes and their Project Quantum block palettes:

### LC_BUILT_UP (urban, roads, buildings) — dominant in NYC
| Surface | Block | Notes |
|---|---|---|
| Sidewalk | `smooth_stone_slab` | NYC concrete sidewalk feel |
| Road | `gray_concrete` | Asphalt |
| Brownstone façade | `brown_terracotta` + `red_sandstone` | Pre-war residential |
| Modern building | `smooth_stone` + `gray_concrete` + `glass_pane` | Midtown/downtown |
| Industrial | `stone_bricks` + `iron_bars` | Outer boroughs |
| Interior floor | `oak_planks` | Default residential |

### LC_GRASSLAND / LC_TREE_COVER (parks — Central Park, Prospect Park, etc.)
| Surface | Block | Notes |
|---|---|---|
| Ground | `grass_block` | Base turf |
| Tree (summer) | `oak_log` + `oak_leaves` | Full canopy |
| Tree (fall) | `oak_log` + `dark_oak_leaves` | Orange/brown shift |
| Tree (winter) | `oak_log` (no leaves) | Bare deciduous |
| Path | `gravel` + `stone_slab` | Park walkways |
| Rocks | `mossy_cobblestone` | Central Park outcroppings |

### LC_WATER (Hudson River, East River, harbor)
| Surface | Block | Notes |
|---|---|---|
| Deep water | `water` | River body |
| Shoreline | `sand` → `gravel` | Beach/bank gradient |
| Winter edge | `ice` (within 3 blocks of shore) | Jan-Feb only |
| Dock/pier | `dark_oak_planks` + `dark_oak_fence` | Harbor infrastructure |

### LC_CROPLAND / LC_BARE (rare in NYC — Bronx, Staten Island fringe)
| Surface | Block | Notes |
|---|---|---|
| Soil | `coarse_dirt` | Community gardens |
| Rock | `stone` + `cobblestone` | Bare outcrops |

---

## 2. Seasonal Modifiers

Seasons follow **real-world date** at scan time. NYC seasonal boundaries:

| Season | Months | Modifier |
|---|---|---|
| **Winter** | Dec 1 – Feb 28 | Snow layer on all outdoor LC_BUILT_UP / LC_GRASSLAND; `ice` within 3 blocks of LC_WATER shore; bare tree trunks; gray sky palette |
| **Spring** | Mar 1 – May 31 | Full green leaves; `wet` texture feel (no mechanic, color palette shift); rain probability 40% |
| **Summer** | Jun 1 – Aug 31 | Dry grass patches on LC_GRASSLAND (grass → `dead_bush` / `yellow` tint 20% of tiles); heat shimmer above roads (particle effect) |
| **Fall** | Sep 1 – Nov 30 | Oak leaves → dark oak / orange tinted; scattered `dead_bush` on ground; leaf particle effects |

**Winter snow logic (mirrors Arnis `ground_generation.rs` snow layer placement):**
- Outdoor surfaces: 1 layer `snow` on top of block if `is_outdoor == true` and `month in [12, 1, 2]`
- Heavy snow event (triggered by real temp < -5°C from Open-Meteo API): 2-3 layers
- Underground / interior spaces: no snow

---

## 3. Void Rules — NYC Temperate

### Base hostility: **Medium** (urban density = high anchor infrastructure)

NYC's dense built environment creates natural resistance. Scanning a room gives you stone/concrete walls that are naturally more void-resistant than an open field scan.

### Day/night cycle
Follows **real local time (America/New_York)**:

| Time | Void state |
|---|---|
| 06:00 – 20:00 | Passive — void creatures exist but do not actively expand |
| 20:00 – 23:00 | Active — void begins consuming exposed edges |
| 23:00 – 06:00 | Aggressive — void at peak expansion rate |

### Seasonal void amplification
| Season | Void multiplier | Reason |
|---|---|---|
| Winter (Dec-Feb) | +25% aggression | Cold = thermodynamic drain; snow weakens anchor points |
| Spring | Baseline | |
| Summer | -10% (easier) | Long days, short nights |
| Fall | +10% | Days shortening, pre-winter pressure |

### Void creature archetypes for NYC
NYC void creatures should feel urban/industrial:

| Type | Behavior | Rarity |
|---|---|---|
| **Soot Crawler** | Eats LC_BUILT_UP road/sidewalk blocks; slow, high volume | Common |
| **Girder Shade** | Tall, targets building walls; leaves structural voids | Uncommon |
| **Steam Wraith** | Emerges from water-adjacent tiles; dissolves ice/water blocks | Uncommon |
| **Concrete Null** | Rare; fast; consumes reinforced/upgraded anchor points | Rare |

---

## 4. Anchor Infrastructure (void resistance by block type)

| Block | Void resistance | Reasoning |
|---|---|---|
| `gray_concrete` (road) | Low | Thin surface layer |
| `smooth_stone` (building wall) | Medium | Solid structure |
| `stone_bricks` (reinforced wall) | High | Thick masonry |
| `iron_bars` / `iron_block` | Very high | Metal anchor |
| Tiny people's LiDAR towers | Very high (special) | Active scanner = active defense |

LiDAR scan quality matters:
- User scan at scan-time: **full resistance** for 7 real-world days before decay begins
- Tiny people rescan with pocket scanners: **partial resistance**, extends by 24h per rescan
- Unscanned areas (void-side of a bridge): **no resistance**, decays immediately

---

## 5. Real-World Data Sources

| Data | Source | Update frequency |
|---|---|---|
| Land cover class | ESA WorldCover (already in Arnis `land_cover.rs`) | Static (2021 dataset) |
| Current temperature | Open-Meteo API (free, no key) | At scan time |
| Season | Derived from `Date.now()` + NYC timezone | Runtime |
| Precipitation | Open-Meteo hourly | At scan time |
| Day/night | Sun position by lat/lon (SunCalc or simple formula) | Realtime |

---

## 6. Open-Meteo Query (no API key required)

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=40.71
  &longitude=-74.00
  &current=temperature_2m,precipitation,snowfall,weathercode
  &timezone=America%2FNew_York
```

Response fields used:
- `temperature_2m` → snow layer thickness (< -5°C = heavy snow)
- `snowfall` → real-time snow event trigger
- `weathercode` → rain/storm → void precipitation bonus

---

## 7. Arnis Integration Points

| Arnis module | Change needed |
|---|---|
| `biome.rs` → `biome_for_class()` | Add `LC_BUILT_UP` → `minecraft:plains` (already returns plains; no change) |
| `land_cover.rs` | Add seasonal block palette layer on top of base class |
| `ground_generation.rs` | Add snow layer placement gated on `month + temp` |
| `retrieve_data.rs` | Add Open-Meteo fetch alongside OSM; pass weather into `GenerationOptions` |
| New: `void_rules.rs` | NYC hostility rules, day/night cycle, creature spawn rates |

---

## 8. Next Steps

1. Add `WeatherData` struct to `GenerationOptions` (temp, precipitation, snowfall, season)
2. Extend `biome_for_class()` to accept season + weather → adjust block palette
3. Add snow layer pass in `ground_generation.rs` (conditional on winter + outdoor)
4. Design `void_rules.rs` with NYC archetype tables above
5. iOS prototype: capture LiDAR → POST mesh + GPS coords to backend → receive world chunk

---

*Project Quantum — internal spec, June 2026*
