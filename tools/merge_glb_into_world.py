#!/usr/bin/env python3
"""
merge_glb_into_world.py — mesh-level ICP registration + non-destructive block union.

Locked principle: Replace is banned; merge at most. GPS only nominates,
geometry decides. A directly-uploaded GLB (e.g. Scaniverse) may be merged INTO
an existing world only if ICP registers the new mesh against the old world's
block cloud with sufficient overlap fitness. Otherwise the merge is DECLINED
and the upload stays a separate world — old coverage is never dropped
(Greene St incident, 2026-07-01).

Unlike merge_capture_into_world.py (joint COLMAP reconstruction — could not
pass the 0.75 registration guard, see AGENTS.md), this path works directly on
meshes: no frames, no SfM. One file is enough: the existing world IS the
merge target.

Flow:
  1. Load the OLD world's saved blocks from world_blocks; structural layers
     become a metric point cloud (block centers x meta.voxel). This frame —
     gravity-aligned, dominant floor at y~0 — is the merge frame.
  2. Load + surface-sample the NEW GLB (assumed gravity-aligned, Y-up, meters).
  3. Register new -> old: yaw-sweep initialization (mesh is gravity aligned, so
     4-DOF init) + FPFH/RANSAC global candidate, each refined with ICP; the
     best-fitness pose wins.
  4. GATE ("geometry decides"): fitness >= --min-fitness AND inlier RMSE <=
     --max-rmse-vox voxels. Fail -> decision=declined_registration, exit 0,
     DB untouched.
  5. Voxelize the ALIGNED mesh on the OLD grid (same voxel size, same origin),
     with convert()-style floor/wall/ceiling classification. Floor columns near
     the old dominant plane get the OLD world's rolling-hills noise (same seed
     from meta) so terrain blends seamlessly.
  6. UNION ("old coverage never dropped"): old layers are kept verbatim; new
     blocks are added only into cells no old block occupies.
  7. Write through update_world_from_payload (prior payload backed up first),
     or --dry-write <file> for offline inspection.

Last stdout line is a single JSON object describing the decision.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import sqlite3
import sys
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from glb_to_world_payload import (  # noqa: E402
    HILL_AMPLITUDE,
    HILL_WAVELENGTH,
    b64_i32,
    connected_keep,
    decorate_vegetation,
    load_triangles,
    median_smooth_floor,
    prune_floating,
    prune_tiny_components,
    rolling_hills,
)
from old_path_from_capture import DB_PATH, update_world_from_payload  # noqa: E402

# Layers that are real scanned/built mass (ICP target + occupancy). Vegetation
# and decorative scatter are excluded from the ICP target (they float above
# the scanned surface) but still count as occupied for the union.
STRUCTURAL = {"dryGrass", "grass", "dirt", "hidden_dirt", "wall", "ceiling", "stone", "sand", "wood"}


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def log(msg: str) -> None:
    print(f"[merge-glb] {msg}", file=sys.stderr, flush=True)


def decode_payload(payload: dict) -> dict[str, np.ndarray]:
    layers = {}
    for name, b64 in (payload.get("layers") or {}).items():
        buf = base64.b64decode(b64)
        arr = np.frombuffer(buf, dtype="<i4")
        if arr.size % 3:
            arr = arr[: arr.size - arr.size % 3]
        layers[name] = arr.reshape(-1, 3).astype(np.int64)
    return layers


def load_old_world(world_id: str) -> tuple[dict, dict[str, np.ndarray]]:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT payload FROM world_blocks WHERE world_id = ?", (world_id,)
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise SystemExit(f"world {world_id} has no saved blocks")
    payload = json.loads(row[0])
    return payload, decode_payload(payload)


def sample_mesh_points(tris: list[np.ndarray], n: int, rng: np.random.Generator) -> np.ndarray:
    """Area-weighted barycentric surface sampling."""
    a = np.stack([t[0] for t in tris])
    b = np.stack([t[1] for t in tris])
    c = np.stack([t[2] for t in tris])
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    total = areas.sum()
    if total <= 0:
        raise SystemExit("degenerate mesh: zero surface area")
    idx = rng.choice(len(tris), size=n, p=areas / total)
    u = rng.random(n)
    v = rng.random(n)
    flip = u + v > 1
    u[flip] = 1 - u[flip]
    v[flip] = 1 - v[flip]
    w = 1 - u - v
    return a[idx] * u[:, None] + b[idx] * v[:, None] + c[idx] * w[:, None]


def yaw_matrix(deg: float) -> np.ndarray:
    r = math.radians(deg)
    cr, sr = math.cos(r), math.sin(r)
    T = np.eye(4)
    T[0, 0] = cr
    T[0, 2] = sr
    T[2, 0] = -sr
    T[2, 2] = cr
    return T


def register(new_pts: np.ndarray, old_pts: np.ndarray, voxel: float) -> dict:
    import open3d as o3d

    def cloud(pts):
        pc = o3d.geometry.PointCloud()
        pc.points = o3d.utility.Vector3dVector(pts)
        return pc

    old_pc = cloud(old_pts).voxel_down_sample(voxel)
    new_pc = cloud(new_pts).voxel_down_sample(voxel)
    old_pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=voxel * 3, max_nn=30))
    new_pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=voxel * 3, max_nn=30))

    old_np = np.asarray(old_pc.points)
    new_np = np.asarray(new_pc.points)
    # 4-DOF init anchors: horizontal centroids + floor levels (5th pct of Y).
    old_cxz = old_np[:, [0, 2]].mean(axis=0)
    new_cxz = new_np[:, [0, 2]].mean(axis=0)
    old_floor = np.percentile(old_np[:, 1], 5)
    new_floor = np.percentile(new_np[:, 1], 5)

    coarse = o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=40)
    fine = o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=80)
    p2p = o3d.pipelines.registration.TransformationEstimationPointToPoint()

    candidates = []
    for deg in range(0, 360, 15):
        T = yaw_matrix(deg)
        # rotate new centroid, then translate onto old anchors
        R = T[:3, :3]
        c_rot = R @ np.array([new_cxz[0], 0, new_cxz[1]])
        T[0, 3] = old_cxz[0] - c_rot[0]
        T[2, 3] = old_cxz[1] - c_rot[2]
        T[1, 3] = old_floor - new_floor
        res = o3d.pipelines.registration.registration_icp(
            new_pc, old_pc, voxel * 2.5, T, p2p, coarse
        )
        candidates.append(("yaw%d" % deg, res))

    # Global candidate: FPFH + RANSAC (catches poses the yaw sweep misses,
    # e.g. slight tilt or big offset).
    try:
        rad = voxel * 5
        f_old = o3d.pipelines.registration.compute_fpfh_feature(
            old_pc, o3d.geometry.KDTreeSearchParamHybrid(radius=rad, max_nn=100))
        f_new = o3d.pipelines.registration.compute_fpfh_feature(
            new_pc, o3d.geometry.KDTreeSearchParamHybrid(radius=rad, max_nn=100))
        ransac = o3d.pipelines.registration.registration_ransac_based_on_feature_matching(
            new_pc, old_pc, f_new, f_old, True, voxel * 2.0,
            p2p, 3,
            [o3d.pipelines.registration.CorrespondenceCheckerBasedOnEdgeLength(0.9),
             o3d.pipelines.registration.CorrespondenceCheckerBasedOnDistance(voxel * 2.0)],
            o3d.pipelines.registration.RANSACConvergenceCriteria(200000, 0.999),
        )
        res = o3d.pipelines.registration.registration_icp(
            new_pc, old_pc, voxel * 2.5, ransac.transformation, p2p, coarse)
        candidates.append(("ransac", res))
    except Exception as exc:  # pragma: no cover
        log(f"ransac candidate failed: {exc}")

    candidates.sort(key=lambda c: c[1].fitness, reverse=True)
    best_name, best = candidates[0]
    second_fit = candidates[1][1].fitness if len(candidates) > 1 else 0.0
    # Fine refinement of the winner at tight threshold.
    refined = o3d.pipelines.registration.registration_icp(
        new_pc, old_pc, voxel * 1.25, best.transformation, p2p, fine
    )
    final = o3d.pipelines.registration.evaluate_registration(
        new_pc, old_pc, voxel * 1.25, refined.transformation
    )
    inliers = int(round(final.fitness * len(new_np)))
    return {
        "transform": np.asarray(refined.transformation),
        "fitness": float(final.fitness),
        "rmse_m": float(final.inlier_rmse),
        "rmse_vox": float(final.inlier_rmse / voxel) if voxel else 0.0,
        "inliers": inliers,
        "init": best_name,
        "runner_up_fitness": float(second_fit),
        "new_points": int(len(new_np)),
        "old_points": int(len(old_np)),
    }


def voxelize_aligned(tris: list[np.ndarray], voxel: float, old_meta: dict,
                     old_floor_cols: dict, old_occupied: set, old_footprint: set):
    """convert()-style voxelization of the ALIGNED mesh on the OLD grid.

    No rotate_to_cardinal, no rebase: alignment already placed the mesh in the
    old world's frame (dominant floor ~ y=0). Returns (new_layers, new_floor,
    keep_cols) with only blocks that do NOT collide with old occupancy.
    """
    allv = np.vstack([t for t in tris])
    mn, mx = allv.min(axis=0), allv.max(axis=0)
    y_range = max(1e-9, float(mx[1] - mn[1]))

    floor_samples = defaultdict(list)
    wall = []
    ceil = []
    allsurf = []
    for tri in tris:
        a, b, c = tri
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n) or 1.0
        nx, ny, nz = n / ln
        avg_y = float((a[1] + b[1] + c[1]) / 3)
        rel = (avg_y - mn[1]) / y_range
        up = abs(ny) >= 0.55 and rel < 0.60
        down = abs(ny) >= 0.55 and rel >= 0.45
        e1 = np.linalg.norm(b - a)
        e2 = np.linalg.norm(c - a)
        steps = min(120, max(4, int(math.ceil(max(e1, e2) / (voxel * 0.5)))))
        for su in range(steps + 1):
            for sv in range(steps - su + 1):
                u = su / steps
                v = sv / steps
                w = 1 - u - v
                p = a * u + b * v + c * w
                vx = int(round(p[0] / voxel))
                vy = int(round(p[1] / voxel))
                vz = int(round(p[2] / voxel))
                allsurf.append((vx, vy, vz))
                if up:
                    floor_samples[(vx, vz)].append(vy)
                elif down:
                    ceil.append((vx, vy, vz))
                else:
                    wall.append((vx, vy, vz))
    if not floor_samples:
        raise SystemExit("no up-facing floor samples in aligned GLB")

    # Old dominant plane: pre-hill baseline is y=0 by construction (convert
    # rebases), but client-saved worlds may differ — use the modal floor height.
    dom_old = 0
    if old_floor_cols:
        dom_old = Counter(old_floor_cols.values()).most_common(1)[0][0]

    floor = {}
    snapped_cols = []
    for k, ys in floor_samples.items():
        uniq = sorted(set(ys))
        best = min(uniq, key=lambda y: (abs(y - dom_old), abs(y)))
        if abs(best - dom_old) <= 8:
            floor[k] = dom_old
            snapped_cols.append(k)
        else:
            floor[k] = best

    # Fill small floor gaps (as convert).
    for _ in range(2):
        additions = []
        for (x, z), y in list(floor.items()):
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nk = (x + dx, z + dz)
                if nk in floor:
                    continue
                vals = [floor[(x + dx + adx, z + dz + adz)]
                        for adx, adz in ((1, 0), (-1, 0), (0, 1), (0, -1))
                        if (x + dx + adx, z + dz + adz) in floor]
                if vals:
                    additions.append((nk, int(round(sum(vals) / len(vals)))))
        for k, y in additions:
            floor.setdefault(k, y)
    median_smooth_floor(floor)

    # Blend snapped-flat columns into the OLD world's rolling hills: same noise
    # seed + params -> heights continue seamlessly across the merge seam.
    hills = ((old_meta.get("inferredFrom") or {}).get("hills") or {})
    seed = int(hills.get("seed", 0))
    if seed:
        flat = {k: dom_old for k in floor if abs(floor[k] - dom_old) <= 1}
        rolling_hills(flat,
                      amplitude=int(hills.get("amplitude", HILL_AMPLITUDE)),
                      wavelength=float(hills.get("wavelength", HILL_WAVELENGTH)),
                      seed=seed)
        for k, y in flat.items():
            floor[k] = y

    # Anywhere the old world already has structural mass in the column, defer
    # to it entirely — union never restates old terrain, and vegetation is only
    # ever planted on genuinely new ground.
    for k in list(floor.keys()):
        if k in old_footprint:
            del floor[k]

    wall_cols = {}
    for x, y, z in wall:
        if y <= 0:
            continue
        k = (x, z)
        col = wall_cols.setdefault(k, [y, y, 0])
        col[0] = min(col[0], y)
        col[1] = max(col[1], y)
        col[2] += 1
    keep_cols = connected_keep([k for k, c in wall_cols.items() if c[2] >= 3], min_size=6)
    combined_floor = dict(old_floor_cols)
    combined_floor.update(floor)
    solid_wall = []
    for k in keep_cols:
        x, z = k
        _, maxy, _ = wall_cols[k]
        base = max(1, combined_floor.get(k, 0) + 1)
        for y in range(base, maxy + 1):
            solid_wall.append((x, y, z))

    ceil_cols = defaultdict(list)
    for x, y, z in ceil:
        if y > 2:
            ceil_cols[(x, z)].append(y)
    ceiling = []
    med_ceil = []
    for k, ys in ceil_cols.items():
        ys.sort()
        med_ceil.append((k, ys[len(ys) // 2]))
    for (x, z), y in med_ceil:
        if y >= 3:
            ceiling.append((x, y, z))

    layers = defaultdict(list)
    for (x, z), y in floor.items():
        layers["dryGrass"].append((x, y, z))
        layers["dirt"].append((x, y - 1, z))
    for p in solid_wall:
        layers["wall"].append(p)
    for p in ceiling:
        layers["ceiling"].append(p)

    # Dedup + drop anything colliding with the old world (old always wins).
    occupied = set(old_occupied)
    ordered = ["dryGrass", "dirt", "wall", "ceiling"]
    for name in ordered:
        uniq = []
        for p in layers[name]:
            if p in occupied:
                continue
            occupied.add(p)
            uniq.append(p)
        layers[name] = uniq

    veg_stats = decorate_vegetation(layers, floor, occupied, keep_cols)

    for x, y, z in set(allsurf):
        if y <= 0 or (x, y, z) in occupied:
            continue
        if (x, z) in keep_cols:
            continue
        if len(layers["stone"]) < 3000:
            layers["stone"].append((x, y, z))
            occupied.add((x, y, z))

    return dict(layers), floor, keep_cols, veg_stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("glb", help="new gravity-aligned GLB (Scaniverse/Polycam/pipeline)")
    ap.add_argument("--into-world-id", required=True)
    ap.add_argument("--min-fitness", type=float, default=0.25,
                    help="min fraction of new cloud within 1.25 voxel of old blocks")
    ap.add_argument("--max-rmse-vox", type=float, default=0.8)
    ap.add_argument("--sample-points", type=int, default=120000)
    ap.add_argument("--dry-write", metavar="FILE", default=None,
                    help="write merged payload to FILE instead of the DB")
    args = ap.parse_args()

    t0 = time.time()
    glb_path = Path(args.glb)
    if not glb_path.exists():
        emit({"ok": False, "decision": "error", "reason": f"GLB not found: {glb_path}"})
        sys.exit(1)

    old_payload, old_layers = load_old_world(args.into_world_id)
    old_meta = old_payload.get("meta") or {}
    voxel = float(old_meta.get("voxel") or 0.08)
    old_total = sum(len(v) for v in old_layers.values())
    old_occupied = set()
    for pts in old_layers.values():
        for p in pts:
            old_occupied.add((int(p[0]), int(p[1]), int(p[2])))
    struct_pts = [old_layers[n] for n in old_layers if n in STRUCTURAL and len(old_layers[n])]
    if not struct_pts:
        struct_pts = list(old_layers.values())
    old_cloud = np.vstack(struct_pts).astype(float) * voxel
    old_struct = {(int(x), int(y), int(z)) for arr in struct_pts for x, y, z in arr}
    old_footprint = {(x, z) for x, _, z in old_struct}
    # Old floor columns for terrain continuity (top dryGrass per column).
    old_floor_cols = {}
    for name in ("dryGrass", "grass", "sand"):
        for x, y, z in old_layers.get(name, []):
            k = (int(x), int(z))
            if k not in old_floor_cols or y > old_floor_cols[k]:
                old_floor_cols[k] = int(y)
    log(f"old world {args.into_world_id}: {old_total} blocks, voxel={voxel:.4f}m, "
        f"{len(old_cloud)} structural pts")

    tris, mn, mx = load_triangles(str(glb_path))
    rng = np.random.default_rng(1337)
    new_cloud = sample_mesh_points(tris, args.sample_points, rng)
    log(f"new GLB: {len(tris)} tris, sampled {len(new_cloud)} pts, "
        f"extent={np.round(mx - mn, 2).tolist()}m")

    reg = register(new_cloud, old_cloud, voxel)
    log(f"registration: init={reg['init']} fitness={reg['fitness']:.3f} "
        f"rmse={reg['rmse_vox']:.2f}vox runner_up={reg['runner_up_fitness']:.3f}")

    gate = {
        "fitness": reg["fitness"],
        "min_fitness": args.min_fitness,
        "rmse_vox": reg["rmse_vox"],
        "max_rmse_vox": args.max_rmse_vox,
        "inliers": reg["inliers"],
        "init": reg["init"],
        "runner_up_fitness": reg["runner_up_fitness"],
    }
    if reg["fitness"] < args.min_fitness or reg["rmse_vox"] > args.max_rmse_vox:
        emit({"ok": True, "decision": "declined_registration",
              "reason": "ICP gate failed — geometry does not confirm shared space",
              "gate": gate, "world_id": args.into_world_id,
              "elapsed_s": round(time.time() - t0, 1)})
        return

    T = reg["transform"]
    R, t = T[:3, :3], T[:3, 3]
    tris_aligned = [tri @ R.T + t for tri in tris]

    new_layers, new_floor, keep_cols, veg_stats = voxelize_aligned(
        tris_aligned, voxel, old_meta, old_floor_cols, old_occupied, old_footprint)

    # Overlap suppression: inside the old structural footprint the OLD geometry
    # is authoritative. Quantization jitter (~rmse 0.6 vox) otherwise re-states
    # old surfaces a cell or two over as a "double skin". A new structural block
    # in an old column is dropped when it is within 2 cells of old mass;
    # blocks outside the footprint — true coverage extension — are always kept.
    reach = [(dx, dy, dz) for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2)
             for dz in (-2, -1, 0, 1, 2) if (dx, dy, dz) != (0, 0, 0)]
    double_skin = 0
    for name in ("dryGrass", "dirt", "wall", "ceiling", "stone"):
        pts = new_layers.get(name)
        if not pts:
            continue
        kept = []
        for p in pts:
            x, y, z = p
            if (x, z) in old_footprint and any(
                    (x + dx, y + dy, z + dz) in old_struct for dx, dy, dz in reach):
                double_skin += 1
                continue
            kept.append(p)
        new_layers[name] = kept
    log(f"overlap suppression dropped {double_skin} double-skin blocks")

    # Prune floaters in the NEW blocks only; old mass is injected as support so
    # new geometry attached to the old world survives, then stripped back out.
    pruned = prune_floating({**new_layers, "__old": [list(p) for p in old_occupied]})
    pruned.pop("__old", None)
    new_layers = {k: v for k, v in pruned.items() if v}

    # Strict isolated-voxel / <3-block scatter removal (KJ 2026-07-19). Old mass
    # is injected as support again so a small NEW piece legitimately attached to
    # the existing world is not counted as a tiny floater and deleted.
    tiny = prune_tiny_components({**new_layers, "__old": [list(p) for p in old_occupied]})
    tiny.pop("__old", None)
    new_layers = {k: v for k, v in tiny.items() if v}

    # Visibility cull for new blocks against combined occupancy. Old blocks are
    # kept verbatim (never re-culled, never re-labeled).
    combined = set(old_occupied)
    for pts in new_layers.values():
        for p in pts:
            combined.add(tuple(p))
    dirs = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    final_new = defaultdict(list)
    hidden_new = []
    for name, pts in new_layers.items():
        for p in pts:
            x, y, z = p
            exposed = any((x + dx, y + dy, z + dz) not in combined for dx, dy, dz in dirs)
            if exposed:
                final_new[name].append(tuple(p))
            elif name == "dirt":
                hidden_new.append(tuple(p))
    if hidden_new:
        final_new["hidden_dirt"].extend(hidden_new)

    added = sum(len(v) for v in final_new.values())
    if added == 0:
        emit({"ok": True, "decision": "merged_noop",
              "reason": "registration passed but the new scan adds no blocks (full overlap)",
              "gate": gate, "world_id": args.into_world_id,
              "old_blocks": old_total, "elapsed_s": round(time.time() - t0, 1)})
        return

    # UNION: old layers verbatim + new blocks appended.
    merged_layers = {}
    all_names = set(old_layers) | set(final_new)
    for name in all_names:
        pts = [tuple(p) for p in old_layers.get(name, [])]
        pts.extend(final_new.get(name, []))
        merged_layers[name] = pts

    xs, zs = [], []
    for pts in merged_layers.values():
        for x, _, z in pts:
            xs.append(x)
            zs.append(z)
    span = int(max(max(xs) - min(xs), max(zs) - min(zs))) if xs else 0
    total = sum(len(v) for v in merged_layers.values())

    meta = dict(old_meta)
    meta["blockCount"] = total
    meta["resolution"] = span
    merges = list(meta.get("merges") or [])
    merges.append({
        "source": glb_path.name,
        "method": "icp-mesh-registration+block-union",
        "ts": int(time.time() * 1000),
        "transform": [[round(float(v), 6) for v in row] for row in T],
        "gate": gate,
        "added_blocks": added,
        "vegetation": veg_stats,
    })
    meta["merges"] = merges

    payload = {"layers": {k: b64_i32([list(p) for p in v]) for k, v in merged_layers.items() if v},
               "meta": meta}

    out = Path(args.dry_write) if args.dry_write else Path(tempfile.mkstemp(
        prefix=f"merge_glb_{args.into_world_id}_", suffix=".json")[1])
    out.write_text(json.dumps(payload))
    result = {
        "ok": True, "decision": "merged" if not args.dry_write else "dry_write",
        "world_id": args.into_world_id, "gate": gate,
        "old_blocks": old_total, "added_blocks": added, "block_count": total,
        "double_skin_dropped": double_skin,
        "resolution": span, "payload": str(out),
        "elapsed_s": round(time.time() - t0, 1),
    }
    if not args.dry_write:
        written = update_world_from_payload(args.into_world_id, out, "pre_glb_merge")
        result["backup"] = written["backup"]
    emit(result)


if __name__ == "__main__":
    main()
