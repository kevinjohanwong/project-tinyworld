#!/usr/bin/env python3
from collections import defaultdict

from glb_to_world_payload import decorate_vegetation, prune_floating


def count(layers):
    return sum(len(points) for points in layers.values())


layers = defaultdict(list)
for x in range(-5, 6):
    for z in range(-5, 6):
        layers["dryGrass"].append((x, 0, z))
        layers["dirt"].append((x, -1, z))
layers["wall"].extend([(0, 1, 0), (0, 2, 0), (18, 9, 18), (18, 10, 18)])
layers["stone"].extend([(19, 9, 18), (19, 10, 18)])

before = count(layers)
cleaned = prune_floating(layers)
after = count(cleaned)
assert (0, 2, 0) in cleaned["wall"], "grounded structure was removed"
assert (18, 9, 18) not in cleaned["wall"], "floating wall survived"
assert (19, 9, 18) not in cleaned["stone"], "floating stone survived"
assert after < before, "floater cleanup removed nothing"

floor = {(x, z): 0 for x in range(-5, 6) for z in range(-5, 6)}
occupied = {tuple(point) for points in cleaned.values() for point in points}
stats = decorate_vegetation(cleaned, floor, occupied, set())
assert stats["trees"] > 0, "vegetation was not authored after structural cleanup"
assert cleaned["trunks"], "tree trunks missing after post-prune vegetation pass"
assert cleaned["leaves"], "tree leaves missing after post-prune vegetation pass"

print({"before": before, "after_prune": after, "trees": stats["trees"], "trunks": len(cleaned["trunks"]), "leaves": len(cleaned["leaves"])})
