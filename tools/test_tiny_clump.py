#!/usr/bin/env python3
"""Strict isolated-voxel / tiny-clump pass (KJ 2026-07-19).

prune_tiny_components removes any 6-connected component < min_size (default 3)
regardless of grounding, and must run before vegetation so trees survive.
"""
from collections import defaultdict

from glb_to_world_payload import decorate_vegetation, prune_floating, prune_tiny_components


def count(layers):
    return sum(len(points) for points in layers.values())


# --- 1. Isolation: tiny clumps go, real mass stays, grounding is irrelevant ---
layers = defaultdict(list)
# A real 5x5x1 ground slab (25 blocks) — the legitimate mass.
for x in range(5):
    for z in range(5):
        layers["dryGrass"].append((x, 0, z))
# A lone speck floating high (0 neighbours) — must go.
layers["stone"].append((40, 20, 40))
# A grounded lone speck at floor level (0 neighbours) — must go despite grounding.
layers["stone"].append((40, 0, 60))
# A 2-block clump floating high — must go.
layers["stone"].extend([(50, 25, 50), (51, 25, 50)])
# A 2-block clump grounded at floor level but separate from the slab — must go
# (independent of grounding).
layers["stone"].extend([(30, 0, 60), (30, 1, 60)])
# An exactly-3 clump — the boundary case, must SURVIVE (>= min_size).
layers["stone"].extend([(70, 30, 70), (71, 30, 70), (72, 30, 70)])

cleaned = prune_tiny_components(layers, min_size=3)
solid = {tuple(p) for pts in cleaned.values() for p in pts}

assert (0, 0, 0) in solid, "real ground slab was removed"
assert count({"g": cleaned["dryGrass"]}) == 25, "ground slab lost blocks"
assert (40, 20, 40) not in solid, "high isolated speck survived"
assert (40, 0, 60) not in solid, "grounded isolated speck survived (grounding must not save it)"
assert (50, 25, 50) not in solid and (51, 25, 50) not in solid, "2-block floating clump survived"
assert (30, 0, 60) not in solid and (30, 1, 60) not in solid, "2-block grounded clump survived"
assert (70, 30, 70) in solid, "3-block component was wrongly removed (boundary)"

# --- 2. Composition with prune_floating + vegetation preservation ---
world = defaultdict(list)
for x in range(-5, 6):
    for z in range(-5, 6):
        world["dryGrass"].append((x, 0, z))
        world["dirt"].append((x, -1, z))
# Floating wall (caught by prune_floating) + a 1-block speck (caught by tiny pass).
world["wall"].extend([(18, 9, 18), (18, 10, 18)])
world["stone"].append((30, 15, 30))

before = count(world)
step1 = prune_floating(world)
step2 = prune_tiny_components(step1, min_size=3)
after = count(step2)
solid2 = {tuple(p) for pts in step2.values() for p in pts}
assert (18, 9, 18) not in solid2, "floating wall survived prune_floating"
assert (30, 15, 30) not in solid2, "isolated speck survived tiny-clump pass"
assert after < before, "cleanup removed nothing"

floor = {(x, z): 0 for x in range(-5, 6) for z in range(-5, 6)}
occupied = {tuple(p) for pts in step2.values() for p in pts}
stats = decorate_vegetation(step2, floor, occupied, set())
assert stats["trees"] > 0, "vegetation was not authored after cleanup"
assert step2["trunks"], "tree trunks missing after tiny-clump pass"
assert step2["leaves"], "tree leaves (sparse canopy) were eaten by the tiny-clump pass"

print({"before": before, "after_cleanup": after, "trees": stats["trees"],
       "trunks": len(step2["trunks"]), "leaves": len(step2["leaves"])})
print("OK")
