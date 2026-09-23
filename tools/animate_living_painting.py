#!/usr/bin/env python3
import argparse
import math
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import map_coordinates


def soft_mask(mask: np.ndarray, radius: float) -> np.ndarray:
    image = Image.fromarray(np.uint8(np.clip(mask, 0, 1) * 255), "L")
    return np.asarray(image.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0


def polygon_mask(h: int, w: int, points: list[tuple[float, float]], radius: float = 0.0) -> np.ndarray:
    image = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(image)
    draw.polygon([(int(x * w), int(y * h)) for x, y in points], fill=255)
    if radius:
        image = image.filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(image, dtype=np.float32) / 255.0


def shifted_layer(rgb: np.ndarray, mask: np.ndarray, dx: float, dy: float = 0.0) -> np.ndarray:
    h, w = mask.shape
    layer_image = Image.fromarray(np.uint8(np.clip(rgb, 0, 1) * 255), "RGB")
    mask_image = Image.fromarray(np.uint8(np.clip(mask, 0, 1) * 255), "L")
    affine = (1.0, 0.0, -dx, 0.0, 1.0, -dy)
    shifted_rgb = np.asarray(
        layer_image.transform((w, h), Image.Transform.AFFINE, affine, resample=Image.Resampling.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    shifted_mask = np.asarray(
        mask_image.transform((w, h), Image.Transform.AFFINE, affine, resample=Image.Resampling.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    return rgb * (1.0 - shifted_mask[..., None]) + shifted_rgb * shifted_mask[..., None]


def grass_warp(rgb: np.ndarray, mask: np.ndarray, phase: float) -> np.ndarray:
    h, w = mask.shape
    y0 = int(h * 0.82)
    yy, xx = np.mgrid[y0:h, 0:w].astype(np.float32)
    bottom_weight = np.clip((yy - h * 0.84) / (h * 0.16), 0.0, 1.0)
    sway = math.sin(phase) * 1.25 + math.sin(phase * 2.0 + 0.7) * 0.25
    local = np.sin(xx * 0.045 + phase * 0.6) * 0.25
    dx = (sway + local) * bottom_weight
    coords = np.array([yy, xx - dx])
    cropped = rgb[y0:]
    local_coords = np.array([yy - y0, xx - dx])
    warped = np.stack(
        [map_coordinates(cropped[..., c], local_coords, order=1, mode="nearest") for c in range(3)], axis=-1
    )
    result = rgb.copy()
    cropped_mask = mask[y0:, ..., None]
    result[y0:] = cropped * (1.0 - cropped_mask) + warped * cropped_mask
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--fps", type=int, default=24)
    args = parser.parse_args()

    source = Image.open(args.input).convert("RGB")
    rgb = np.asarray(source, dtype=np.float32) / 255.0
    h, w = rgb.shape[:2]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    saturation = (mx - mn) / np.maximum(mx, 1e-4)
    brightness = rgb.mean(axis=2)
    yy = np.arange(h, dtype=np.float32)[:, None] / h

    cloud_color = np.clip((brightness - 0.54) / 0.25, 0, 1) * np.clip((0.40 - saturation) / 0.28, 0, 1)
    far_region = polygon_mask(h, w, [(0, 0.08), (1, 0.08), (1, 0.29), (0.67, 0.35), (0.42, 0.25), (0, 0.37)], 8.0)
    mid_region = polygon_mask(h, w, [(0, 0.12), (1, 0.12), (1, 0.48), (0.64, 0.42), (0.30, 0.37), (0, 0.43)], 8.0)
    front_region = polygon_mask(h, w, [(0, 0.67), (1, 0.64), (1, 0.94), (0, 0.94)], 10.0)
    far_mask = soft_mask(cloud_color * far_region, 2.5)
    mid_mask = soft_mask(cloud_color * mid_region, 2.5) * (1.0 - far_mask)
    front_mask = soft_mask(cloud_color * front_region, 3.0)

    castle_protect = polygon_mask(h, w, [
        (0.07, 0.34), (0.13, 0.22), (0.22, 0.20), (0.24, 0.03), (0.39, 0.03),
        (0.41, 0.16), (0.52, 0.12), (0.57, 0.27), (0.64, 0.16), (0.70, 0.33),
        (0.86, 0.26), (0.91, 0.43), (1.0, 0.38), (1.0, 0.58), (0.73, 0.48),
        (0.48, 0.40), (0.20, 0.36)
    ], 5.0)
    boy_protect = polygon_mask(h, w, [
        (0.43, 0.84), (0.48, 0.82), (0.54, 0.84), (0.56, 0.98), (0.43, 0.98)
    ], 4.0)
    ground_protect = polygon_mask(h, w, [(0, 0.94), (1, 0.88), (1, 1), (0, 1)], 5.0)
    front_protect = np.maximum(boy_protect, ground_protect)

    green = rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2])
    grass_mask = soft_mask(np.clip((green - 0.025) / 0.16, 0, 1) * (yy > 0.84), 2.0)

    frame_count = int(round(args.seconds * args.fps))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tinyworld-loop-") as tmp:
        tmp_path = Path(tmp)
        for i in range(frame_count):
            seconds = i / args.fps
            loop_phase = 2.0 * math.pi * seconds / args.seconds
            grass_phase = 2.0 * math.pi * seconds / 10.0
            frame = rgb.copy()
            frame = shifted_layer(frame, far_mask, math.sin(loop_phase - 0.35) * 5.0)
            frame = shifted_layer(frame, mid_mask, math.sin(loop_phase - 0.75) * 11.0)
            frame = frame * (1.0 - castle_protect[..., None]) + rgb * castle_protect[..., None]
            frame = shifted_layer(frame, front_mask, math.sin(loop_phase - math.pi / 2.0) * 24.0, math.sin(loop_phase) * 1.5)
            frame = frame * (1.0 - front_protect[..., None]) + rgb * front_protect[..., None]
            frame = grass_warp(frame, grass_mask, grass_phase)
            Image.fromarray(np.uint8(np.clip(frame, 0, 1) * 255)).save(tmp_path / f"{i:04d}.png")
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(args.fps),
                "-i", str(tmp_path / "%04d.png"), "-c:v", "libx264", "-preset", "slow",
                "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
            ],
            check=True,
        )
    print(output)


if __name__ == "__main__":
    main()
