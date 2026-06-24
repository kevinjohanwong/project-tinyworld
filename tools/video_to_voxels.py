#!/usr/bin/env python3
"""
video_to_voxels.py — depth + RGB-D odometry → TSDF → voxel-grid pipeline.

Goal: produce a voxel world from a phone video that actually resembles the
scanned space, replacing the Gemini-vibes generator currently in
/api/tinyworld-infer (which makes "a room that vibes like the scan" not
"your room").

Pipeline:

  video
    → ffmpeg keyframes (RGB)
    → per-frame metric depth (Depth Anything V2, metric variant)
    → per-frame RGB-D image (Open3D)
    → frame-to-frame pose estimation (Open3D RGB-D odometry,
                                      chained cumulatively from identity)
    → ScalableTSDFVolume.integrate(rgbd, intrinsic, extrinsic) per frame
    → extract voxel grid from the fused TSDF
    → solidify (flood-fill exterior, invert → interior fill with stone)
    → palette-map averaged voxel color → Tinyworld block layer
    → emit JSON in the same {layers, blockCount, span, meta} shape that
      /api/tinyworld-infer's generateLayers() currently produces, so the
      route can spawnSync this script and persist the result unchanged.

Capture guidance (must match the /tinyworld/capture instructions):
  - Walk slowly, hold the phone at chest height, point slightly down.
  - Avoid spins — RGB-D odometry tracks motion well but loses pure
    rotation. Translate, then turn, then translate again.
  - Keep textured surfaces in view. Bare walls = no parallax features.
  - 30–90 seconds of capture is plenty for a room.

Dependencies (heavy, ~3-5 GB on first run):
    pip install torch torchvision pillow numpy open3d transformers
    # ffmpeg must be on PATH (already installed in this workspace)

CLI:
    python video_to_voxels.py <video_path> <output_json> [--frames N]
                              [--voxel CM] [--device cpu|cuda] [--no-slam]
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

# Lazy imports: torch + transformers + open3d are slow to import; defer until
# we actually need them so --help stays snappy.


# ---------------------------------------------------------------------------
# Tinyworld block layers (must match the existing TS generator's keys exactly)
# ---------------------------------------------------------------------------

LAYERS = ("dirt", "stone", "metal", "grass", "dryGrass", "snow", "leaves", "fruit", "wall", "ceiling", "hidden_dirt")


# ---------------------------------------------------------------------------
# 1. Keyframe extraction (same approach as the existing TS route's ffmpeg call)
# ---------------------------------------------------------------------------

def extract_keyframes(video_path: Path, out_dir: Path, n_frames: int) -> List[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    duration = max(2.0, float(probe.stdout.strip() or "2"))
    fps = n_frames / duration
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path),
         "-vf", f"fps={fps:.4f},scale=512:-2",
         "-frames:v", str(n_frames), "-q:v", "3",
         str(out_dir / "f_%04d.jpg")],
        check=True,
    )
    return sorted(out_dir.glob("f_*.jpg"))


def select_by_motion(
    candidates: List[Path],
    target_n: int,
    imu_samples: List[Tuple[float, float, float, float]] | None = None,
    candidate_times_s: List[float] | None = None,
    rotation_weight: float = 1.5,
) -> Tuple[List[Path], List[int]]:
    """Pick target_n frames from a denser candidate pool by sampling uniformly
    along cumulative inter-frame motion. Returns (kept_paths, kept_indices)
    where kept_indices[i] is the position of kept_paths[i] in the original
    candidates list — used downstream to recover per-frame timestamps for
    IMU alignment.

    Motion is approximated by L1 pixel difference between consecutive
    candidates downscaled to 64x36 grayscale (cheap, no cv2 dep). The
    cumulative motion array acts like an arc-length parameterization, so
    sampling uniformly along it gives dense coverage of walking/panning
    sections and prunes near-stationary stretches. Always keeps the first
    and last candidate.

    When IMU samples + candidate timestamps are provided, per-transition
    rotation magnitude (rad) is added to the motion weight, scaled so it
    contributes ~rotation_weight * mean(pixel_motion). This concentrates
    frames during head-pan / look-up-down segments, where monocular RGB-D
    odometry is weakest and needs the IMU rotation prior to track cleanly.
    """
    from PIL import Image
    if len(candidates) <= target_n:
        return candidates, list(range(len(candidates)))
    grays = []
    for fp in candidates:
        g = Image.open(fp).convert("L").resize((64, 36), Image.BILINEAR)
        grays.append(np.asarray(g, dtype=np.int16))
    # per-transition L1 motion, with a tiny epsilon so a fully static capture
    # still yields uniform-in-time sampling rather than dividing by zero.
    diffs = np.array(
        [float(np.abs(grays[i] - grays[i - 1]).mean()) + 1e-3
         for i in range(1, len(grays))],
        dtype=np.float64,
    )
    # IMU-aware augmentation: add per-transition rotation magnitude (rad)
    # to the pixel-motion weight, scaled so rotation can meaningfully bias
    # sampling without erasing translation signal.
    if (imu_samples and candidate_times_s
            and len(candidate_times_s) == len(candidates)):
        rot_diffs = np.array([
            _rotation_angle(imu_relative_rotation(
                imu_samples,
                candidate_times_s[i - 1],
                candidate_times_s[i],
            ))
            for i in range(1, len(candidates))
        ], dtype=np.float64)
        mean_pix = float(np.mean(diffs))
        mean_rot = float(np.mean(rot_diffs))
        if mean_rot > 1e-6:
            scale = (mean_pix / mean_rot) * rotation_weight
            diffs = diffs + scale * rot_diffs
            print(f"      imu-aware sampling: rot mean {mean_rot:.3f} rad, "
                  f"scale {scale:.2f}, pix mean {mean_pix:.3f}", file=sys.stderr)
    cum = np.concatenate(([0.0], np.cumsum(diffs)))
    total = cum[-1]
    # sample target_n positions uniformly in cumulative-motion space
    targets = np.linspace(0.0, total, target_n)
    # for each target motion value, find the candidate index whose cumulative
    # motion is closest (np.searchsorted on the right keeps ordering stable).
    idxs = np.searchsorted(cum, targets, side="left").clip(0, len(cum) - 1)
    # dedupe while preserving order
    seen, kept_idx = set(), []
    for i in idxs.tolist():
        if i not in seen:
            seen.add(i)
            kept_idx.append(i)
    # if dedupe shrank the set (lots of near-still segments collapsing onto
    # one candidate), pad with evenly spaced candidates we haven't taken yet
    # so we still hand TSDF a reasonable number of frames.
    if len(kept_idx) < target_n:
        remaining_idx = [j for j in range(len(candidates)) if j not in seen]
        step = max(1, len(remaining_idx) // max(1, target_n - len(kept_idx)))
        kept_idx.extend(remaining_idx[::step][: target_n - len(kept_idx)])
        kept_idx.sort()
    return [candidates[i] for i in kept_idx], kept_idx


# ---------------------------------------------------------------------------
# 2. Metric depth per frame (Depth Anything V2 metric variant)
# ---------------------------------------------------------------------------

_DEPTH_PIPE = None

def get_depth_pipe(device: str):
    global _DEPTH_PIPE
    if _DEPTH_PIPE is not None:
        return _DEPTH_PIPE
    from transformers import pipeline
    _DEPTH_PIPE = pipeline(
        task="depth-estimation",
        model="depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",
        device=device,
    )
    return _DEPTH_PIPE


def depth_for_frame(pipe, frame_path: Path) -> Tuple[np.ndarray, Tuple[int, int]]:
    from PIL import Image
    img = Image.open(frame_path).convert("RGB")
    out = pipe(img)
    depth_tensor = out["predicted_depth"]
    depth = depth_tensor.squeeze().cpu().numpy().astype(np.float32)
    return depth, img.size  # depth (H,W), size (W,H)


# ---------------------------------------------------------------------------
# 3. Build per-frame RGB-D + camera intrinsics for Open3D
# ---------------------------------------------------------------------------

def make_intrinsic(width: int, height: int, hfov_deg: float):
    import open3d as o3d
    fx = (width / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
    fy = fx  # square pixels
    cx, cy = width / 2.0, height / 2.0
    return o3d.camera.PinholeCameraIntrinsic(width, height, fx, fy, cx, cy)


def make_rgbd(rgb: np.ndarray, depth: np.ndarray, depth_trunc: float = 4.0):
    """Build an Open3D RGBDImage from a uint8 RGB array and a float32 depth (metres)."""
    import open3d as o3d
    color = o3d.geometry.Image(np.ascontiguousarray(rgb))
    depth_o3d = o3d.geometry.Image(np.ascontiguousarray(depth.astype(np.float32)))
    # depth_scale=1.0 because our depth is already in metres.
    return o3d.geometry.RGBDImage.create_from_color_and_depth(
        color, depth_o3d,
        depth_scale=1.0,
        depth_trunc=depth_trunc,
        convert_rgb_to_intensity=False,
    )


# ---------------------------------------------------------------------------
# 4. Frame-to-frame pose estimation (Open3D RGB-D odometry, chained)
# ---------------------------------------------------------------------------

def estimate_poses(
    rgbds: list,
    intrinsic,
    init_odos: List[np.ndarray] | None = None,
    max_step_m: float = 0.8,
) -> Tuple[List[np.ndarray], int]:
    """Chain frame-to-frame RGB-D odometry → cumulative world->camera extrinsics.

    Frame 0 defines the world origin (extrinsic = identity). For each
    subsequent frame i we compute the relative transform from frame i-1 to
    frame i with Open3D's hybrid-term RGB-D odometry, then compose it onto
    the cumulative extrinsic at i-1.

    ``init_odos[i]`` (when supplied) is the initial guess for the transform
    taking points from frame (i-1) to frame i — typically an IMU-derived
    rotation prior with zero translation. The solver still refines both
    rotation and translation; the prior just keeps it out of bad basins on
    fast rotations / blank walls where visual gradients are weak.

    Tracking failures (low overlap, motion blur, blank wall) fall back to
    reusing the previous extrinsic for that frame, so a bad transition
    doesn't poison the rest of the chain. Returns (poses, n_lost).
    """
    import open3d as o3d
    option = o3d.pipelines.odometry.OdometryOption()
    jacobian = o3d.pipelines.odometry.RGBDOdometryJacobianFromHybridTerm()
    poses: List[np.ndarray] = [np.eye(4)]
    n_lost = 0
    for i in range(1, len(rgbds)):
        init = init_odos[i - 1] if (init_odos is not None and i - 1 < len(init_odos)) else np.eye(4)
        success, trans, _info = o3d.pipelines.odometry.compute_rgbd_odometry(
            rgbds[i - 1], rgbds[i], intrinsic, init, jacobian, option,
        )
        if success:
            step_m = float(np.linalg.norm(trans[:3, 3]))
            if (not np.isfinite(step_m)) or step_m > max_step_m:
                success = False
        if success:
            # trans takes points from frame (i-1) to frame i, so the view
            # matrix for camera i is trans @ (view matrix for i-1).
            poses.append(trans @ poses[i - 1])
        else:
            n_lost += 1
            poses.append(poses[-1].copy())
    return poses, n_lost


# ---------------------------------------------------------------------------
# 4b. IMU rotation prior
# ---------------------------------------------------------------------------

def load_imu(path: Path) -> List[Tuple[float, float, float, float]]:
    """Read the IMU sidecar JSON written by the capture page.

    Returns a list of (t_s, omega_x, omega_y, omega_z) tuples in the CAMERA
    frame (right-down-forward, OpenCV-style), with t in seconds since
    recording start and angular velocity in rad/s.

    Device → camera frame mapping for a rear-camera phone held in portrait:
      • device x (right of screen)         → camera x (right)     [+]
      • device y (up the screen)           → camera y (down)      [-]
      • device z (out of screen, to user)  → camera z (forward)   [-]
    DeviceMotion.rotationRate uses (alpha, beta, gamma) = rate about device
    (z, x, y) in deg/s, so the camera-frame angular velocity is:
      omega_x =  +beta
      omega_y =  -gamma
      omega_z =  -alpha
    converted from deg/s to rad/s.
    """
    blob = json.loads(path.read_text())
    samples = blob.get("samples") or []
    out: List[Tuple[float, float, float, float]] = []
    d2r = math.pi / 180.0
    for s in samples:
        try:
            t = float(s["t"]) / 1000.0
            rx_dev = float(s.get("ry", 0.0))   # beta  (about device x)
            ry_dev = float(s.get("rz", 0.0))   # gamma (about device y)
            rz_dev = float(s.get("rx", 0.0))   # alpha (about device z)
        except (KeyError, TypeError, ValueError):
            continue
        out.append((t, rx_dev * d2r, -ry_dev * d2r, -rz_dev * d2r))
    out.sort(key=lambda r: r[0])
    return out


def _rotation_angle(R: np.ndarray) -> float:
    """Geodesic angle of a 3x3 rotation matrix, in radians (always >= 0)."""
    cos = (float(np.trace(R)) - 1.0) / 2.0
    return math.acos(max(-1.0, min(1.0, cos)))


def _rodrigues(omega: np.ndarray) -> np.ndarray:
    """Rotation matrix exp(skew(omega))."""
    theta = float(np.linalg.norm(omega))
    if theta < 1e-9:
        return np.eye(3)
    k = omega / theta
    K = np.array([
        [0.0, -k[2], k[1]],
        [k[2], 0.0, -k[0]],
        [-k[1], k[0], 0.0],
    ])
    return np.eye(3) + math.sin(theta) * K + (1.0 - math.cos(theta)) * (K @ K)


def imu_relative_rotation(
    samples: List[Tuple[float, float, float, float]],
    t_start_s: float,
    t_end_s: float,
) -> np.ndarray:
    """Integrate camera-frame angular velocity over [t_start_s, t_end_s] to
    get the rotation taking points from camera_t_start into camera_t_end.

    Returns a 3x3 rotation matrix. Empty interval / no samples → identity.
    """
    if t_end_s <= t_start_s or not samples:
        return np.eye(3)
    # Clip the integration window to the IMU sample range.
    R_cam = np.eye(3)  # cumulative rotation of the CAMERA in world frame over the interval
    prev_t = max(samples[0][0], t_start_s)
    for t, ox, oy, oz in samples:
        if t <= t_start_s:
            continue
        if t >= t_end_s:
            break
        dt = max(0.0, t - prev_t)
        if dt > 0:
            R_cam = R_cam @ _rodrigues(np.array([ox, oy, oz]) * dt)
        prev_t = t
    # Final partial interval to t_end_s.
    if prev_t < t_end_s:
        # Find the most recent angular velocity (use the last sample before t_end_s
        # we already integrated, falling back to zero if we never entered the loop).
        last = None
        for s in samples:
            if s[0] >= t_end_s:
                break
            last = s
        if last is not None:
            _, ox, oy, oz = last
            dt = t_end_s - prev_t
            R_cam = R_cam @ _rodrigues(np.array([ox, oy, oz]) * dt)
    # `trans` in compute_rgbd_odometry maps frame (i-1) → frame i, which is the
    # inverse of the camera's own rotation between those frames.
    return R_cam.T


def build_imu_init_odos(
    samples: List[Tuple[float, float, float, float]],
    frame_times_s: List[float],
) -> List[np.ndarray]:
    """Per-transition 4x4 init guess for compute_rgbd_odometry, IMU-derived
    rotation with zero translation. Returns one entry per transition i→i+1.
    """
    init_odos: List[np.ndarray] = []
    for i in range(len(frame_times_s) - 1):
        R = imu_relative_rotation(samples, frame_times_s[i], frame_times_s[i + 1])
        T = np.eye(4)
        T[:3, :3] = R
        init_odos.append(T)
    return init_odos


# ---------------------------------------------------------------------------
# 5. TSDF fusion → voxel grid
# ---------------------------------------------------------------------------

def fuse_tsdf(rgbds: list, poses: List[np.ndarray], intrinsic, voxel_m: float):
    """Integrate all frames into a ScalableTSDFVolume and extract a VoxelGrid."""
    import open3d as o3d
    sdf_trunc = max(0.04, 4.0 * voxel_m)
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel_m,
        sdf_trunc=sdf_trunc,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
    )
    for rgbd, pose in zip(rgbds, poses):
        # Open3D's integrate() takes world->camera (the camera's view matrix).
        # Our chained poses are already in that convention.
        volume.integrate(rgbd, intrinsic, pose)
    pcd = volume.extract_point_cloud()
    if len(pcd.points) == 0:
        return None, pcd
    # Aggressive outlier prune — monocular depth is noisy at object edges
    # and specular highlights, and pose drift produces ghost surfaces. Two
    # passes (statistical + radius) eliminate most of the "confetti in space"
    # floaters before voxelization.
    pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=30, std_ratio=1.0)
    if len(pcd.points) > 0:
        pcd, _ = pcd.remove_radius_outlier(nb_points=16, radius=voxel_m * 3.0)
    vg = o3d.geometry.VoxelGrid.create_from_point_cloud(pcd, voxel_size=voxel_m)
    return vg, pcd


# ---------------------------------------------------------------------------
# 6. Open3D VoxelGrid → integer grid {(ix,iy,iz): rgb}
# ---------------------------------------------------------------------------

def voxelgrid_to_dict(vg) -> Tuple[Dict[Tuple[int, int, int], Tuple[float, float, float]],
                                    Tuple[int, int, int],
                                    Tuple[int, int, int]]:
    if vg is None:
        return {}, (0, 0, 0), (0, 0, 0)
    voxels = vg.get_voxels()
    if not voxels:
        return {}, (0, 0, 0), (0, 0, 0)
    grid: Dict[Tuple[int, int, int], Tuple[float, float, float]] = {}
    mins = [10**9, 10**9, 10**9]
    maxs = [-10**9, -10**9, -10**9]
    for v in voxels:
        ix, iy, iz = int(v.grid_index[0]), int(v.grid_index[1]), int(v.grid_index[2])
        grid[(ix, iy, iz)] = (float(v.color[0]), float(v.color[1]), float(v.color[2]))
        for i, val in enumerate((ix, iy, iz)):
            if val < mins[i]: mins[i] = val
            if val > maxs[i]: maxs[i] = val
    return grid, tuple(mins), tuple(maxs)


# ---------------------------------------------------------------------------
# 6b. Connected-component filter (drop floaters from depth noise / pose drift)
# ---------------------------------------------------------------------------

def keep_largest_components(
    grid: Dict[Tuple[int, int, int], Tuple[float, float, float]],
    keep_top: int = 3,
    min_fraction: float = 0.01,
) -> Dict[Tuple[int, int, int], Tuple[float, float, float]]:
    """Keep only the largest connected components of the voxel grid.

    Monocular depth produces many small isolated clusters (edges, specular
    highlights, depth jumps); pose drift produces ghost copies of real
    surfaces offset in space. Both look like floating confetti once
    voxelized. We label 6-connected components and keep:
      - the top `keep_top` largest, AND
      - any component whose size is at least `min_fraction` of the largest.
    """
    if not grid:
        return grid
    coords = np.array(list(grid.keys()), dtype=np.int64)
    mins = coords.min(axis=0)
    shifted = coords - mins
    sx, sy, sz = (shifted.max(axis=0) + 1).tolist()
    # Cheap iterative flood-fill using a dict-of-set per component.
    occupied = set(map(tuple, shifted.tolist()))
    visited: set = set()
    components: List[List[Tuple[int, int, int]]] = []
    NEIGH = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
    for start in occupied:
        if start in visited:
            continue
        stack = [start]
        comp: List[Tuple[int, int, int]] = []
        while stack:
            v = stack.pop()
            if v in visited or v not in occupied:
                continue
            visited.add(v)
            comp.append(v)
            for dx, dy, dz in NEIGH:
                stack.append((v[0] + dx, v[1] + dy, v[2] + dz))
        components.append(comp)
    components.sort(key=len, reverse=True)
    if not components:
        return grid
    biggest = len(components[0])
    keep_sizes = [c for c in components
                  if len(c) >= max(1, int(biggest * min_fraction))]
    keep_sizes = keep_sizes[:keep_top] if keep_top > 0 else keep_sizes
    keep_voxels = set()
    for comp in keep_sizes:
        for v in comp:
            orig = (v[0] + int(mins[0]), v[1] + int(mins[1]), v[2] + int(mins[2]))
            keep_voxels.add(orig)
    sizes = ", ".join(str(len(c)) for c in components[:5])
    print(f"  components: {len(components)} total, top sizes [{sizes}], "
          f"kept {len(keep_sizes)} ({len(keep_voxels)}/{len(grid)} voxels)",
          file=sys.stderr)
    return {k: v for k, v in grid.items() if k in keep_voxels}


# ---------------------------------------------------------------------------
# 6c. Indoor rectification (ground + smooth noisy monocular TSDF output)
# ---------------------------------------------------------------------------

def _median_int(vals: List[int]) -> int:
    vals = sorted(vals)
    return int(vals[len(vals) // 2])


def rectify_indoor_grid(
    grid: Dict[Tuple[int, int, int], Tuple[float, float, float]],
    voxel_m: float,
    max_room_height_m: float = 3.2,
) -> Tuple[Dict[Tuple[int, int, int], Tuple[float, float, float]], dict]:
    """Ground and smooth camera-derived indoor geometry.

    The old mesh/GLB path has explicit floor median smoothing and wall
    rectification. The camera TSDF path does not know semantics, so odometry
    drift and monocular-depth floaters can create vertical scatter that is
    technically connected but physically implausible. This pass keeps columns
    attached to the dominant floor, caps impossible indoor height, and lays a
    smoothed floor skin so the runtime can rebuild a sane ground map.
    """
    if not grid:
        return grid, {"rectified": False, "reason": "empty"}

    columns: Dict[Tuple[int, int], List[int]] = {}
    colors: Dict[Tuple[int, int], List[Tuple[float, float, float]]] = {}
    for (x, y, z), c in grid.items():
        k = (x, z)
        columns.setdefault(k, []).append(y)
        colors.setdefault(k, []).append(c)
    if not columns:
        return grid, {"rectified": False, "reason": "no-columns"}

    bottoms = [min(v) for v in columns.values()]
    hist: Dict[int, int] = {}
    for y in bottoms:
        hist[y] = hist.get(y, 0) + 1
    dominant_floor_y, dominant_count = max(hist.items(), key=lambda kv: kv[1])
    p20_floor_y = sorted(bottoms)[max(0, int(len(bottoms) * 0.20) - 1)]
    floor_y = dominant_floor_y if dominant_count >= max(8, int(len(bottoms) * 0.12)) else p20_floor_y

    ground_tol = max(2, int(round(0.32 / max(voxel_m, 1e-6))))
    max_height_cells = max(8, int(round(max_room_height_m / max(voxel_m, 1e-6))))
    cap_y = floor_y + max_height_cells

    grounded = {k for k, ys in columns.items() if min(ys) <= floor_y + ground_tol}
    if not grounded:
        return grid, {"rectified": False, "reason": "no-grounded-columns"}

    floor_map: Dict[Tuple[int, int], int] = {}
    for k in grounded:
        floor_map[k] = min(columns[k])

    # Two median passes flatten sub-voxel floor jitter but preserve steps.
    neigh = ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    for _ in range(2):
        smoothed: Dict[Tuple[int, int], int] = {}
        for (x, z), y in floor_map.items():
            vals = []
            for dx, dz in neigh:
                ny = floor_map.get((x + dx, z + dz))
                if ny is not None and abs(ny - y) <= ground_tol:
                    vals.append(ny)
            smoothed[(x, z)] = _median_int(vals or [y])
        floor_map = smoothed

    out: Dict[Tuple[int, int, int], Tuple[float, float, float]] = {}
    dropped_columns = 0
    dropped_voxels = 0
    capped_voxels = 0
    floor_added = 0
    floor_color = (0.48, 0.43, 0.34)

    for k, ys in columns.items():
        if k not in grounded:
            dropped_columns += 1
            dropped_voxels += len(ys)
            continue
        x, z = k
        local_floor = floor_map.get(k, min(ys))
        has_floor = False
        for y in ys:
            if y > cap_y:
                capped_voxels += 1
                continue
            c = grid[(x, y, z)]
            if abs(y - local_floor) <= 1:
                has_floor = True
            out[(x, y, z)] = c
        if not has_floor:
            cs = colors.get(k) or [floor_color]
            avg = (
                float(sum(c[0] for c in cs) / len(cs)),
                float(sum(c[1] for c in cs) / len(cs)),
                float(sum(c[2] for c in cs) / len(cs)),
            )
            out[(x, local_floor, z)] = avg if sum(avg) > 0.15 else floor_color
            floor_added += 1

    meta = {
        "rectified": True,
        "floor_y": int(floor_y),
        "ground_tol": int(ground_tol),
        "cap_y": int(cap_y),
        "dropped_columns": int(dropped_columns),
        "dropped_voxels": int(dropped_voxels),
        "capped_voxels": int(capped_voxels),
        "floor_added": int(floor_added),
        "columns_in": int(len(columns)),
        "columns_out": int(len({(x, z) for x, _, z in out})),
    }
    print("  rectification: "
          f"floor_y={floor_y}, cap_y={cap_y}, "
          f"dropped {dropped_columns}/{len(columns)} cols, "
          f"capped {capped_voxels} voxels, floor +{floor_added}",
          file=sys.stderr)
    return out, meta


# ---------------------------------------------------------------------------
# 6d. Structural decomposition: snap to straight vertical walls + flat planes
# ---------------------------------------------------------------------------

def decompose_structure(
    grid: Dict[Tuple[int, int, int], Tuple[float, float, float]],
    voxel_m: float,
    max_room_height_m: float = 3.2,
    min_wall_height_m: float = 0.8,
    ceiling_tol_m: float = 0.25,
    min_wall_component: int = 6,
    floor_y_anchor: int | None = None,
    cap_y_anchor: int | None = None,
) -> Tuple[
    Dict[Tuple[int, int, int], Tuple[float, float, float]],
    Dict[Tuple[int, int, int], str],
    dict,
]:
    """Snap a rectified camera grid to straight vertical walls + flat planes and
    tag structural voxels so the runtime rebuilds a clean room (matching the
    legacy GLB/Scaniverse output: explicit `wall`, `ceiling`, `hidden_dirt`,
    grass/dirt floor) instead of a color-classified blob.

    Returns (full, override, meta):
      full     - complete voxel grid: original kept voxels (furniture/accents,
                 color-classified) + floor skin + straight solid wall runs +
                 flat ceiling + hidden_dirt interior volume fill.
      override - {coord: layer} for every structural/hidden voxel; coords not
                 present fall through to rgb_to_layer color classification.
    """
    empty_override: Dict[Tuple[int, int, int], str] = {}
    if not grid:
        return dict(grid), empty_override, {"decomposed": False, "reason": "empty"}

    cols: Dict[Tuple[int, int], Dict[int, Tuple[float, float, float]]] = {}
    for (x, y, z), c in grid.items():
        cols.setdefault((x, z), {})[y] = c
    if not cols:
        return dict(grid), empty_override, {"decomposed": False, "reason": "no-cols"}

    cells_per_m = 1.0 / max(voxel_m, 1e-6)
    ground_tol = max(2, int(round(0.32 * cells_per_m)))

    if floor_y_anchor is not None:
        floor_y = int(floor_y_anchor)
    else:
        bottoms = [min(ys) for ys in cols.values()]
        bhist: Dict[int, int] = {}
        for y in bottoms:
            bhist[y] = bhist.get(y, 0) + 1
        floor_y, floor_n = max(bhist.items(), key=lambda kv: kv[1])
        if floor_n < max(8, int(len(bottoms) * 0.12)):
            floor_y = sorted(bottoms)[max(0, int(len(bottoms) * 0.20) - 1)]

    floor_map: Dict[Tuple[int, int], int] = {
        k: min(ys) for k, ys in cols.items() if min(ys) <= floor_y + ground_tol
    }
    if not floor_map:
        floor_map = {k: min(ys) for k, ys in cols.items()}

    if cap_y_anchor is not None:
        cap_y = int(cap_y_anchor)
    else:
        cap_y = floor_y + max(8, int(round(max_room_height_m * cells_per_m)))

    min_wall_h = max(4, int(round(min_wall_height_m * cells_per_m)))
    ceiling_tol = max(2, int(round(ceiling_tol_m * cells_per_m)))

    # Ceiling = HIGHEST well-supported cluster of tall column tops (>=5% of tall
    # columns, or >=5), defaulting to the room height cap. Picks the real
    # ceiling plane over tall furniture.
    high: List[int] = []
    for k, ys in cols.items():
        top = max(ys)
        if top - floor_map.get(k, floor_y) >= min_wall_h:
            high.append(top)
    ceiling_y = cap_y
    if high:
        bsize = max(1, ceiling_tol)
        chist: Dict[int, int] = {}
        for t in high:
            b = round(t / bsize)
            chist[b] = chist.get(b, 0) + 1
        thresh = max(5, int(len(high) * 0.05))
        supported = [b for b, c in chist.items() if c >= thresh]
        if supported:
            ceiling_y = min(max(supported) * bsize, cap_y)
    ceiling_y = int(ceiling_y)
    if ceiling_y <= floor_y + min_wall_h:
        ceiling_y = floor_y + min_wall_h + 1

    # Wall columns: reach the ceiling plane with a tall vertical run.
    wall_cols = {k for k, ys in cols.items()
                 if max(ys) >= ceiling_y - ceiling_tol
                 and (max(ys) - floor_map.get(k, floor_y)) >= min_wall_h}

    # Connectivity: drop isolated false walls (keep components of size >= N).
    if wall_cols and min_wall_component > 1:
        kept_walls = set()
        seen = set()
        for start in wall_cols:
            if start in seen:
                continue
            comp = [start]
            seen.add(start)
            stk = [start]
            while stk:
                cx, cz = stk.pop()
                for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nb = (cx + dx, cz + dz)
                    if nb in wall_cols and nb not in seen:
                        seen.add(nb)
                        comp.append(nb)
                        stk.append(nb)
            if len(comp) >= min_wall_component:
                kept_walls.update(comp)
        wall_cols = kept_walls
    wall_set = set(wall_cols)

    full: Dict[Tuple[int, int, int], Tuple[float, float, float]] = dict(grid)
    override: Dict[Tuple[int, int, int], str] = {}
    hidden_color = (0.40, 0.36, 0.30)
    wall_color = (0.55, 0.52, 0.48)
    ceil_color = (0.72, 0.72, 0.74)

    # Floor skin (grass/dirt by color) — guarantee a floor voxel per column.
    for k, fl in floor_map.items():
        x, z = k
        c = cols.get(k, {}).get(fl, (0.45, 0.43, 0.34))
        coord = (x, fl, z)
        full[coord] = c
        override[coord] = rgb_to_layer(c[0], c[1], c[2], 0.0)

    # Walls: solid straight vertical run floor -> ceiling.
    wall_added = 0
    for k in wall_cols:
        x, z = k
        fl = floor_map.get(k, floor_y)
        for y in range(fl, ceiling_y + 1):
            coord = (x, y, z)
            full[coord] = wall_color
            override[coord] = "wall"
            wall_added += 1

    # Ceiling: flat plane at ceiling_y over wall columns.
    ceil_added = 0
    for k in wall_cols:
        x, z = k
        coord = (x, ceiling_y, z)
        full[coord] = ceil_color
        override[coord] = "ceiling"
        ceil_added += 1

    # Interior hidden_dirt: fill grounded non-wall columns floor+1..ceiling-1
    # (the solid interior volume; invisible to the renderer, matches the legacy
    # Scaniverse hidden_dirt). Skip coords already occupied by walls/floor/kept.
    occupied = set(override.keys())
    hidden_added = 0
    for k, fl in floor_map.items():
        if k in wall_set:
            continue
        x, z = k
        for y in range(fl + 1, ceiling_y):
            coord = (x, y, z)
            if coord in occupied:
                continue
            full[coord] = hidden_color
            override[coord] = "hidden_dirt"
            occupied.add(coord)
            hidden_added += 1

    meta = {
        "decomposed": True,
        "floor_y": int(floor_y),
        "ceiling_y": int(ceiling_y),
        "cap_y": int(cap_y),
        "wall_cols": len(wall_cols),
        "wall_added": int(wall_added),
        "ceil_added": int(ceil_added),
        "hidden_added": int(hidden_added),
        "floor_cells": len(floor_map),
    }
    print(f"  decompose: floor_y={int(floor_y)} ceiling_y={int(ceiling_y)} "
          f"wall_cols={len(wall_cols)} +{wall_added} wall +{ceil_added} ceiling "
          f"+{hidden_added} hidden_dirt floor {len(floor_map)}", file=sys.stderr)
    return full, override, meta


# ---------------------------------------------------------------------------
# 7. Solidify (flood-fill exterior on a padded volume → invert = interior)
# ---------------------------------------------------------------------------

def solidify(grid: Dict[Tuple[int, int, int], Tuple[float, float, float]],
             mins: Tuple[int, int, int], maxs: Tuple[int, int, int],
             max_cells: int = 5_000_000,
             ) -> Dict[Tuple[int, int, int], Tuple[float, float, float]]:
    if not grid:
        return grid
    pad = 1
    sx = maxs[0] - mins[0] + 1 + 2 * pad
    sy = maxs[1] - mins[1] + 1 + 2 * pad
    sz = maxs[2] - mins[2] + 1 + 2 * pad
    volume_cells = sx * sy * sz
    if volume_cells > max_cells:
        print(f"  solidify: skipped huge bbox {sx}x{sy}x{sz} "
              f"({volume_cells} cells > {max_cells})", file=sys.stderr)
        return grid
    vol = np.zeros((sx, sy, sz), dtype=np.uint8)
    for (ix, iy, iz) in grid:
        vol[ix - mins[0] + pad, iy - mins[1] + pad, iz - mins[2] + pad] = 1

    stack = [(0, 0, 0)]
    while stack:
        x, y, z = stack.pop()
        if x < 0 or y < 0 or z < 0 or x >= sx or y >= sy or z >= sz:
            continue
        if vol[x, y, z] != 0:
            continue
        vol[x, y, z] = 2
        stack.extend([(x+1, y, z), (x-1, y, z),
                      (x, y+1, z), (x, y-1, z),
                      (x, y, z+1), (x, y, z-1)])

    out = dict(grid)
    interior_color = (0.45, 0.45, 0.45)
    interior_count = 0
    for x in range(sx):
        for y in range(sy):
            for z in range(sz):
                if vol[x, y, z] == 0:
                    ix = x - pad + mins[0]
                    iy = y - pad + mins[1]
                    iz = z - pad + mins[2]
                    out[(ix, iy, iz)] = interior_color
                    interior_count += 1
    print(f"  solidify: filled {interior_count} interior voxels", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# 8. Palette mapping: averaged voxel RGB → Tinyworld block layer
# ---------------------------------------------------------------------------

def rgb_to_layer(r: float, g: float, b: float, y_norm: float) -> str:
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    is_warm = r > b + 0.08
    is_green = g > r + 0.06 and g > b + 0.06
    is_bright = lum > 0.78

    if r > 0.65 and r > g + 0.2 and r > b + 0.2:
        return "fruit"
    if is_bright and not is_warm:
        return "snow"
    if is_green:
        return "leaves" if y_norm > 0.55 else "grass"
    sat = max(r, g, b) - min(r, g, b)
    if lum < 0.35 and sat < 0.12 and not is_warm:
        return "metal"
    if is_warm and lum > 0.55:
        return "dryGrass"
    if is_warm:
        return "dirt"
    return "stone"


# ---------------------------------------------------------------------------
# 9. Serialize to the exact JSON shape /api/tinyworld-infer already persists
# ---------------------------------------------------------------------------

def serialize_layers(grid: Dict[Tuple[int, int, int], Tuple[float, float, float]],
                     layer_override: Dict[Tuple[int, int, int], str] = None,
                     ) -> Tuple[Dict[str, str], int, int]:
    if not grid:
        return {}, 0, 0

    layer_override = layer_override or {}
    ys = [k[1] for k in grid]
    y_min, y_max = min(ys), max(ys)
    y_span = max(1, y_max - y_min)

    xs = [k[0] for k in grid]
    zs = [k[2] for k in grid]
    x_center = (min(xs) + max(xs)) // 2
    z_center = (min(zs) + max(zs)) // 2
    y_floor = y_min

    buckets: Dict[str, List[int]] = {layer: [] for layer in LAYERS}
    for (ix, iy, iz), (r, g, b) in grid.items():
        layer = layer_override.get((ix, iy, iz))
        if layer is None:
            y_norm = (iy - y_min) / y_span
            layer = rgb_to_layer(r, g, b, y_norm)
        if layer not in buckets:
            buckets[layer] = []
        buckets[layer].extend([ix - x_center, iy - y_floor, iz - z_center])

    serialized: Dict[str, str] = {}
    total = 0
    for layer, coords in buckets.items():
        if not coords:
            continue
        arr = np.asarray(coords, dtype=np.int32)
        serialized[layer] = base64.b64encode(arr.tobytes()).decode("ascii")
        total += len(coords) // 3

    span = max(max(xs) - min(xs), max(zs) - min(zs))
    return serialized, total, span


# ---------------------------------------------------------------------------
# 10. Progressive (windowed) emit
# ---------------------------------------------------------------------------
#
# The single-shot path above computes depth for every frame, *then* fuses,
# *then* emits one world — so the user waits for the whole video (~150 s) before
# seeing anything. The progressive path instead processes frames in temporal
# order into ONE persistent TSDF volume, and emits the newly-formed voxels at
# each window boundary. Because RGB-D odometry is chained cumulatively (frame 0
# = origin), every window already lives in the same coordinate frame, so the
# "1 s crossover" between windows is implicit: frames near a seam fuse into the
# same volume that both the prior and next zone are extracted from. No
# inter-chunk alignment / ICP is needed.
#
# Output: a zone_dir containing zone_0000.json, zone_0001.json, ... plus a
# manifest.json the orchestrator polls. Each zone holds only the voxels that
# became newly present at that boundary, serialized against a single shared
# origin so the zones stack into one world as they arrive.


def voxelize_points(pcd, voxel_m: float,
                    origin_m: Tuple[float, float, float] = (0.0, 0.0, 0.0)
                    ) -> Dict[Tuple[int, int, int], Tuple[float, float, float]]:
    """Voxelize an Open3D point cloud onto a FIXED integer lattice.

    Unlike o3d.geometry.VoxelGrid.create_from_point_cloud (whose grid origin
    follows the cloud's min-bound and therefore shifts as the cloud grows
    between progressive emits), this snaps points to floor((p - origin_m) /
    voxel_m). With a fixed origin the same physical voxel keeps the same
    integer key across every emit, which is what makes the "new voxels since
    the last zone" diff well-defined.
    """
    pts = np.asarray(pcd.points)
    if pts.shape[0] == 0:
        return {}
    cols = np.asarray(pcd.colors)
    if cols.shape[0] != pts.shape[0]:
        cols = np.full((pts.shape[0], 3), 0.5, dtype=np.float64)
    origin = np.asarray(origin_m, dtype=np.float64)
    idx = np.floor((pts - origin) / voxel_m).astype(np.int64)
    keys, inv = np.unique(idx, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    sums = np.zeros((len(keys), 3), dtype=np.float64)
    counts = np.zeros(len(keys), dtype=np.float64)
    np.add.at(sums, inv, cols)
    np.add.at(counts, inv, 1.0)
    counts[counts == 0.0] = 1.0
    avg = sums / counts[:, None]
    out: Dict[Tuple[int, int, int], Tuple[float, float, float]] = {}
    for k, c in zip(keys.tolist(), avg.tolist()):
        out[(int(k[0]), int(k[1]), int(k[2]))] = (float(c[0]), float(c[1]), float(c[2]))
    return out


def grid_from_volume(volume, voxel_m: float
                     ) -> Dict[Tuple[int, int, int], Tuple[float, float, float]]:
    """Extract + prune + voxelize the current state of a persistent TSDF volume
    onto the fixed global lattice. Mirrors fuse_tsdf's outlier passes so a
    progressive world looks the same as the single-shot one."""
    pcd = volume.extract_point_cloud()
    if len(pcd.points) == 0:
        return {}
    pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=30, std_ratio=1.0)
    if len(pcd.points) > 0:
        pcd, _ = pcd.remove_radius_outlier(nb_points=16, radius=voxel_m * 3.0)
    if len(pcd.points) == 0:
        return {}
    return voxelize_points(pcd, voxel_m)


def serialize_subset(
    subset: Dict[Tuple[int, int, int], Tuple[float, float, float]],
    context: Dict[Tuple[int, int, int], Tuple[float, float, float]],
    origin: Tuple[int, int, int],
    layer_override: Dict[Tuple[int, int, int], str] = None,
) -> Tuple[Dict[str, str], int, int]:
    """Like serialize_layers, but emits only `subset` voxels offset by a SHARED
    `origin` (x_center, y_floor, z_center) so every zone lines up in one world.
    `context` (the full accumulated grid) supplies the y-extent used for the
    grass-vs-leaves / snow layer decisions, so layering is stable across zones.
    `layer_override` (optional) forces a layer for given coords (structural
    wall/ceiling/hidden_dirt tagging), bypassing rgb_to_layer.
    """
    layer_override = layer_override or {}
    if not subset:
        return {}, 0, 0
    xc, y_floor, zc = origin
    ys_ctx = [k[1] for k in context] or [y_floor]
    y_min_c, y_max_c = min(ys_ctx), max(ys_ctx)
    y_span_c = max(1, y_max_c - y_min_c)

    buckets: Dict[str, List[int]] = {layer: [] for layer in LAYERS}
    for (ix, iy, iz), (r, g, b) in subset.items():
        layer = layer_override.get((ix, iy, iz))
        if layer is None:
            y_norm = (iy - y_min_c) / y_span_c
            layer = rgb_to_layer(r, g, b, y_norm)
        if layer not in buckets:
            buckets[layer] = []
        buckets[layer].extend([ix - xc, iy - y_floor, iz - zc])

    serialized: Dict[str, str] = {}
    total = 0
    for layer, coords in buckets.items():
        if not coords:
            continue
        arr = np.asarray(coords, dtype=np.int32)
        serialized[layer] = base64.b64encode(arr.tobytes()).decode("ascii")
        total += len(coords) // 3

    xs = [k[0] for k in subset]
    zs = [k[2] for k in subset]
    span = max(max(xs) - min(xs), max(zs) - min(zs)) if xs else 0
    return serialized, total, span


def run_progressive(args) -> int:
    import open3d as o3d
    from PIL import Image

    t0 = time.time()
    zone_dir = Path(args.zone_dir) if args.zone_dir else \
        args.output_json.parent / (args.output_json.stem + "_zones")
    zone_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = zone_dir / "manifest.json"

    zones: List[dict] = []
    origin_box: List[Tuple[int, int, int] | None] = [None]
    rectifications: List[dict] = []
    decompositions: List[dict] = []

    def write_manifest(status: str, extra: dict | None = None) -> None:
        m = {
            "status": status,
            "voxel": args.voxel,
            "first_window_s": args.first_window,
            "window_s": args.window,
            "overlap_s": args.overlap,
            "fps": args.fps,
            "origin": list(origin_box[0]) if origin_box[0] else None,
            "zone_count": len(zones),
            "zones": zones,
            "total_blocks": sum(z["blockCount"] for z in zones),
            "elapsed_s": round(time.time() - t0, 1),
        }
        if extra:
            m["meta"] = extra
        manifest_path.write_text(json.dumps(m))

    write_manifest("running")

    tmp_root = Path(tempfile.mkdtemp(prefix="v2vprog_"))
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(args.video)],
            capture_output=True, text=True, check=True,
        )
        duration_s = max(2.0, float(probe.stdout.strip() or "2"))
        n_frames = max(2, int(round(duration_s * args.fps)))
        print(f"[prog] {duration_s:.1f}s video → {n_frames} frames @ {args.fps} fps",
              file=sys.stderr)
        frames = extract_keyframes(args.video, tmp_root / "frames", n_frames)
        n = len(frames)
        frame_times = [(i + 0.5) * duration_s / n for i in range(n)]

        imu_samples: List[Tuple[float, float, float, float]] = []
        if args.imu is not None and args.imu.exists():
            try:
                imu_samples = load_imu(args.imu)
                print(f"[prog] IMU: {len(imu_samples)} samples", file=sys.stderr)
            except Exception as e:
                print(f"[prog] IMU load failed ({e!r})", file=sys.stderr)
        init_odos = build_imu_init_odos(imu_samples, frame_times) if imu_samples else None

        # Emit boundaries (window END times). A small first window lands the
        # first island fast; subsequent windows advance by (window - overlap).
        step = max(0.5, args.window - args.overlap)
        bounds: List[float] = []
        b = min(args.first_window, duration_s)
        while b < duration_s - 0.5:
            bounds.append(b)
            b += step
        bounds.append(duration_s)
        print(f"[prog] emit boundaries (s): {[round(x, 1) for x in bounds]}",
              file=sys.stderr)

        print(f"[prog] loading depth model (device={args.device}) ...", file=sys.stderr)
        pipe = get_depth_pipe(args.device)
        print(f"[prog] depth model ready ({time.time()-t0:.1f}s)", file=sys.stderr)

        sdf_trunc = max(0.04, 4.0 * args.voxel)
        volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=args.voxel, sdf_trunc=sdf_trunc,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        )
        option = o3d.pipelines.odometry.OdometryOption()
        jacobian = o3d.pipelines.odometry.RGBDOdometryJacobianFromHybridTerm()

        intrinsic = None
        prev_rgbd = None
        cur_pose = np.eye(4)
        n_lost = 0
        emitted: set = set()
        last_grid: Dict[Tuple[int, int, int], Tuple[float, float, float]] = {}
        bi = 0  # next boundary index

        def emit_zone(t_end: float, kind: str = "scan") -> None:
            nonlocal last_grid
            grid_all = grid_from_volume(volume, args.voxel)
            grid_all = keep_largest_components(grid_all, keep_top=4, min_fraction=0.01)
            grid_all, rect_meta = rectify_indoor_grid(
                grid_all,
                args.voxel,
                max_room_height_m=args.max_room_height_m,
            )
            rectifications.append(rect_meta)
            full_all, override_all, dec_meta = decompose_structure(
                grid_all,
                args.voxel,
                max_room_height_m=args.max_room_height_m,
                floor_y_anchor=rect_meta.get("floor_y") if rect_meta else None,
                cap_y_anchor=rect_meta.get("cap_y") if rect_meta else None,
            )
            decompositions.append(dec_meta)
            grid_all = full_all
            last_grid = grid_all
            if origin_box[0] is None and grid_all:
                xs = [k[0] for k in grid_all]
                ys = [k[1] for k in grid_all]
                zs = [k[2] for k in grid_all]
                origin_box[0] = ((min(xs) + max(xs)) // 2, min(ys), (min(zs) + max(zs)) // 2)
            origin = origin_box[0]
            if origin is None:
                return
            new = {k: v for k, v in grid_all.items() if k not in emitted}
            if not new:
                return
            layers, bc, span = serialize_subset(new, grid_all, origin, layer_override=override_all)
            emitted.update(new.keys())
            idx = len(zones)
            zfile = f"zone_{idx:04d}.json"
            (zone_dir / zfile).write_text(json.dumps({
                "index": idx, "file": zfile, "kind": kind,
                "layers": layers, "blockCount": bc, "span": span,
                "origin": list(origin),
                "t_start": round(max(0.0, t_end - args.window), 2),
                "t_end": round(t_end, 2),
            }))
            zones.append({
                "index": idx, "file": zfile, "kind": kind, "blockCount": bc,
                "t_start": round(max(0.0, t_end - args.window), 2),
                "t_end": round(t_end, 2),
                "elapsed_s": round(time.time() - t0, 1),
            })
            write_manifest("running")
            print(f"[prog] zone {idx} ({kind}): +{bc} blocks @ t_end={t_end:.1f}s "
                  f"(elapsed {time.time()-t0:.1f}s, world {len(emitted)} voxels)",
                  file=sys.stderr)

        for i, fp in enumerate(frames):
            depth, _ = depth_for_frame(pipe, fp)
            H, W = depth.shape
            rgb_img = Image.open(fp).convert("RGB")
            if rgb_img.size != (W, H):
                rgb_img = rgb_img.resize((W, H), Image.BILINEAR)
            rgb = np.asarray(rgb_img)
            rgbd = make_rgbd(rgb, depth)
            if intrinsic is None:
                intrinsic = make_intrinsic(W, H, args.hfov)

            if i == 0:
                cur_pose = np.eye(4)
            else:
                init = init_odos[i - 1] if (init_odos is not None and i - 1 < len(init_odos)) else np.eye(4)
                ok, trans, _info = o3d.pipelines.odometry.compute_rgbd_odometry(
                    prev_rgbd, rgbd, intrinsic, init, jacobian, option,
                )
                if ok:
                    step_m = float(np.linalg.norm(trans[:3, 3]))
                    if (not np.isfinite(step_m)) or step_m > args.max_step_m:
                        ok = False
                if ok:
                    cur_pose = trans @ cur_pose
                else:
                    n_lost += 1  # reuse previous pose
            volume.integrate(rgbd, intrinsic, cur_pose)
            prev_rgbd = rgbd

            t_i = frame_times[i]
            is_last = (i == n - 1)
            # collapse any boundaries this frame satisfies into a single emit
            due_end = None
            while bi < len(bounds) and bounds[bi] <= t_i + 1e-9:
                due_end = bounds[bi]
                bi += 1
            if is_last:
                while bi < len(bounds):
                    due_end = bounds[bi]
                    bi += 1
            if due_end is not None:
                emit_zone(due_end)

        # Final interior fill is now handled inside emit_zone: decompose_structure
        # column-fills hidden_dirt for every grounded column each window, so by
        # the last zone the full interior volume is already emitted. (The old
        # flood-fill solidify pass is dropped — it leaked through the leaky TSDF
        # shell and produced 0 interior or spurious voxels.)
        write_manifest("done", extra={
            "frames": n, "lost_transitions": n_lost, "device": args.device,
            "imu_used": bool(init_odos), "duration_s": round(duration_s, 2),
            "rectification": rectifications[-1] if rectifications else None,
            "source": "video_to_voxels.py:progressive",
        })
        print(f"[prog] done: {len(zones)} zones, {sum(z['blockCount'] for z in zones)} "
              f"blocks, {time.time()-t0:.1f}s total", file=sys.stderr)
        return 0
    except Exception as e:
        write_manifest("error", extra={"error": repr(e)})
        print(f"[prog] ERROR: {e!r}", file=sys.stderr)
        raise
    finally:
        if not args.keep_tmp:
            shutil.rmtree(tmp_root, ignore_errors=True)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video", type=Path)
    ap.add_argument("output_json", type=Path)
    ap.add_argument("--frames", type=int, default=150,
                    help="target keyframes after motion-adaptive pruning "
                         "(default 150 ≈ 5 fps over a 30 s walk-through)")
    ap.add_argument("--voxel", type=float, default=0.08,
                    help="voxel size in meters (smaller = denser, slower)")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    ap.add_argument("--hfov", type=float, default=70.0,
                    help="assumed horizontal FoV in degrees (phone-ish)")
    ap.add_argument("--no-slam", action="store_true",
                    help="skip RGB-D odometry (assume identity pose per frame). "
                         "Use for stand-still pan captures with very low parallax.")
    ap.add_argument("--no-adaptive", action="store_true",
                    help="disable motion-adaptive frame pruning; extract exactly "
                         "--frames at uniform time spacing.")
    ap.add_argument("--candidate-mult", type=int, default=2,
                    help="size of the candidate pool relative to --frames when "
                         "adaptive pruning is on (default 2x).")
    ap.add_argument("--imu", type=Path, default=None,
                    help="path to the DeviceMotion JSON sidecar produced by "
                         "the capture page (used as a rotation prior in RGB-D "
                         "odometry).")
    ap.add_argument("--keep-tmp", action="store_true")
    ap.add_argument("--progressive", action="store_true",
                    help="stream zones as the video is processed: one "
                         "persistent TSDF volume, frames in temporal order, "
                         "emit new voxels at each window boundary into "
                         "--zone-dir (manifest.json + zone_NNNN.json).")
    ap.add_argument("--zone-dir", type=Path, default=None,
                    help="output dir for progressive zones (default: "
                         "<output_json stem>_zones next to output_json).")
    ap.add_argument("--first-window", type=float, default=3.0,
                    help="seconds of video in the first window (kept small so "
                         "the first island lands fast).")
    ap.add_argument("--window", type=float, default=5.0,
                    help="window length in seconds for progressive emit.")
    ap.add_argument("--overlap", type=float, default=1.0,
                    help="overlap in seconds between consecutive windows "
                         "(the '1 s crossover'); advance = window - overlap.")
    ap.add_argument("--fps", type=float, default=4.0,
                    help="frames per second to extract in progressive mode.")
    ap.add_argument("--max-step-m", type=float, default=0.8,
                    help="reject RGB-D odometry transitions above this many "
                         "metres per extracted frame; prevents impossible "
                         "scale drift from stretching a room into open space.")
    ap.add_argument("--max-solidify-cells", type=int, default=5_000_000,
                    help="skip interior flood-fill when the voxel bbox is "
                         "larger than this many cells.")
    ap.add_argument("--max-room-height-m", type=float, default=3.2,
                    help="camera-pipeline indoor rectifier height cap in "
                         "metres above the inferred dominant floor.")
    args = ap.parse_args()

    if not args.video.exists():
        print(f"video not found: {args.video}", file=sys.stderr)
        return 2

    if args.progressive:
        return run_progressive(args)

    t0 = time.time()
    tmp_root = Path(tempfile.mkdtemp(prefix="v2v_"))
    try:
        # 1. Frames (extract candidate pool, then motion-adaptive prune)
        # We also compute per-kept-frame timestamps in seconds (relative to
        # capture start) so the IMU prior can integrate over the right window.
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(args.video)],
            capture_output=True, text=True, check=True,
        )
        video_duration_s = max(2.0, float(probe.stdout.strip() or "2"))

        # Load IMU early so the motion-adaptive selector can use it to bias
        # toward rotation segments (the case where odometry needs the most help).
        imu_samples_pre: List[Tuple[float, float, float, float]] = []
        if args.imu is not None and args.imu.exists():
            try:
                imu_samples_pre = load_imu(args.imu)
                print(f"[1/6] IMU sidecar loaded: {len(imu_samples_pre)} samples",
                      file=sys.stderr)
            except Exception as e:
                print(f"[1/6] IMU load failed ({e!r}); proceeding without IMU prior",
                      file=sys.stderr)

        if args.no_adaptive:
            print(f"[1/6] extracting {args.frames} keyframes (uniform) ...",
                  file=sys.stderr)
            frames = extract_keyframes(args.video, tmp_root / "frames", args.frames)
            kept_idx = list(range(len(frames)))
            pool_n = len(frames)
            imu_aware_sampling = False
        else:
            pool_n = max(args.frames, args.frames * args.candidate_mult)
            print(f"[1/6] extracting {pool_n} candidates → motion-adaptive prune "
                  f"to {args.frames} ...", file=sys.stderr)
            candidates = extract_keyframes(args.video, tmp_root / "frames", pool_n)
            dt_per_candidate = video_duration_s / max(1, pool_n)
            candidate_times_s = [(i + 0.5) * dt_per_candidate for i in range(len(candidates))]
            imu_aware_sampling = bool(imu_samples_pre)
            frames, kept_idx = select_by_motion(
                candidates,
                args.frames,
                imu_samples=imu_samples_pre if imu_aware_sampling else None,
                candidate_times_s=candidate_times_s if imu_aware_sampling else None,
            )
        # ffmpeg fps=N samples one frame every (duration/N) seconds, starting
        # near t=0. We map kept frame i back to a timestamp via its candidate index.
        if pool_n > 0:
            dt_per_candidate = video_duration_s / pool_n
            frame_times_s = [(i + 0.5) * dt_per_candidate for i in kept_idx]
        else:
            frame_times_s = []
        print(f"      kept {len(frames)} frames in {time.time()-t0:.1f}s "
              f"({'imu-aware' if imu_aware_sampling else 'pixel-only'} sampling)",
              file=sys.stderr)

        # 2. Depth + 3. RGB-D
        print(f"[2/6] loading depth model (device={args.device}) ...", file=sys.stderr)
        pipe = get_depth_pipe(args.device)
        from PIL import Image
        rgbds = []
        intrinsic = None
        for i, fp in enumerate(frames):
            t_f = time.time()
            depth, _ = depth_for_frame(pipe, fp)
            H, W = depth.shape
            rgb_img = Image.open(fp).convert("RGB")
            if rgb_img.size != (W, H):
                rgb_img = rgb_img.resize((W, H), Image.BILINEAR)
            rgb = np.asarray(rgb_img)
            rgbd = make_rgbd(rgb, depth)
            rgbds.append(rgbd)
            if intrinsic is None:
                intrinsic = make_intrinsic(W, H, args.hfov)
            print(f"      frame {i+1}/{len(frames)}: depth {W}x{H} "
                  f"({time.time()-t_f:.1f}s)", file=sys.stderr)

        if not rgbds:
            print("no frames produced", file=sys.stderr)
            return 3

        # 4. Poses
        if args.no_slam:
            print("[3/6] pose estimation: SKIPPED (--no-slam, identity poses)", file=sys.stderr)
            poses = [np.eye(4) for _ in rgbds]
            n_lost = 0
            imu_used = False
            imu_n_samples = 0
        else:
            init_odos = None
            imu_used = False
            imu_n_samples = len(imu_samples_pre)
            if imu_n_samples > 0 and len(frame_times_s) == len(rgbds):
                init_odos = build_imu_init_odos(imu_samples_pre, frame_times_s)
                imu_used = True
                print(f"[3/6] IMU prior: {imu_n_samples} samples → "
                      f"{len(init_odos)} per-transition rotation guesses",
                      file=sys.stderr)
            elif args.imu is not None and imu_n_samples == 0:
                print(f"[3/6] IMU file empty or unreadable; using identity init",
                      file=sys.stderr)
            elif args.imu is not None:
                print(f"[3/6] IMU samples ({imu_n_samples}) / frame_times "
                      f"({len(frame_times_s)}) / rgbds ({len(rgbds)}) mismatch; "
                      "falling back to identity init", file=sys.stderr)
            print(f"[3/6] RGB-D odometry: chaining {len(rgbds)-1} transitions "
                  f"({'IMU-primed' if imu_used else 'identity init'}) ...",
                  file=sys.stderr)
            t_p = time.time()
            poses, n_lost = estimate_poses(
                rgbds,
                intrinsic,
                init_odos,
                max_step_m=args.max_step_m,
            )
            # Quick sanity print: end-to-end translation magnitude in metres.
            t_final = poses[-1][:3, 3]
            t_mag = float(np.linalg.norm(t_final))
            print(f"      done in {time.time()-t_p:.1f}s; "
                  f"end-to-end translation {t_mag:.2f} m; "
                  f"lost {n_lost}/{len(rgbds)-1} transitions",
                  file=sys.stderr)

        # 5. TSDF fusion
        print(f"[4/6] TSDF fusion at {args.voxel*100:.1f} cm ...", file=sys.stderr)
        t_t = time.time()
        vg, _pcd = fuse_tsdf(rgbds, poses, intrinsic, voxel_m=args.voxel)
        grid, mins, maxs = voxelgrid_to_dict(vg)
        print(f"      {len(grid)} surface voxels, bbox {mins} → {maxs} "
              f"({time.time()-t_t:.1f}s)", file=sys.stderr)

        if not grid:
            print("TSDF produced no voxels (try --no-slam, or check capture)",
                  file=sys.stderr)
            return 4

        # 6b. Connected-component filter (drop confetti from depth noise)
        print("[4b/6] connected-component filter ...", file=sys.stderr)
        grid = keep_largest_components(grid, keep_top=3, min_fraction=0.02)
        print("[4c/6] indoor rectification ...", file=sys.stderr)
        grid, rect_meta = rectify_indoor_grid(
            grid,
            args.voxel,
            max_room_height_m=args.max_room_height_m,
        )
        # 6d. Structural decomposition: snap to straight vertical walls + flat
        # planes and tag wall/ceiling/floor/hidden_dirt so the runtime rebuilds
        # a clean room (matching the legacy Scaniverse/GLB output) instead of a
        # color blob. Column-based interior fill replaces the leaky flood-fill.
        print("[4d/6] structural decomposition (walls/ceiling/floor) ...", file=sys.stderr)
        full, override, dec_meta = decompose_structure(
            grid, args.voxel, max_room_height_m=args.max_room_height_m,
            floor_y_anchor=rect_meta.get("floor_y"),
            cap_y_anchor=rect_meta.get("cap_y"),
        )
        print(f"      now {len(full)} total voxels", file=sys.stderr)

        # 7+8. Palette map + serialize (structural voxels keep their tagged layer)
        print("[6/6] palette-mapping + serializing ...", file=sys.stderr)
        layers, block_count, span = serialize_layers(full, layer_override=override)
        per_layer = {k: len(base64.b64decode(v)) // 12 for k, v in layers.items()}
        print(f"      per-layer counts: {per_layer}", file=sys.stderr)

        payload = {
            "layers": layers,
            "blockCount": block_count,
            "span": span,
            "meta": {
                "voxel": args.voxel,
                "source": "video_to_voxels.py",
                "frames": len(frames),
                "adaptive": not args.no_adaptive,
                "device": args.device,
                "hfov": args.hfov,
                "slam": not args.no_slam,
                "imu_used": bool(imu_used),
                "imu_samples": int(imu_n_samples),
                "imu_aware_sampling": bool(imu_aware_sampling),
                "lost_transitions": int(n_lost),
                "rectification": rect_meta,
                "decomposition": dec_meta,
                "elapsed_s": round(time.time() - t0, 1),
            },
        }
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(json.dumps(payload))
        print(f"wrote {args.output_json} "
              f"({block_count} blocks, {time.time()-t0:.1f}s total)", file=sys.stderr)
        return 0
    finally:
        if not args.keep_tmp:
            shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
