import { expect, test } from "bun:test";
import * as THREE from "three";
import { surfaceDensity, responseAlpha, smoothUnit, standingFraction } from "../src/pwater/surface-continuity";
import { buildLatentFillGeometry } from "../src/latent-fill-geometry";
import { createTerraceWater } from "../src/pwater/terrace-water";

test("shore density is continuous across the old film cutoff and preserves established pools", () => {
  expect(Math.abs(surfaceDensity(0.040001) - surfaceDensity(0.039999))).toBeLessThan(0.0001);
  expect(surfaceDensity(0)).toBe(0);
  let previous = 0;
  for (let m = 0; m < 1.2; m += 0.001) {
    const d = surfaceDensity(m);
    expect(d).toBeGreaterThanOrEqual(previous - 1e-10);
    previous = d;
    if (m >= 0.04) expect(d).toBeCloseTo(Math.min(1.1, Math.max(0.45, m)), 8);
  }
});

test("shore weights are continuous at both former lattice switches", () => {
  for (const cutoff of [0.02, 0.04]) {
    expect(smoothUnit((cutoff + 1e-6) / cutoff) - smoothUnit((cutoff - 1e-6) / cutoff)).toBeLessThan(0.0001);
  }
});

test("surface response agrees at 15, 30, 60 and 120 fps", () => {
  for (const fps of [15, 30, 60, 120]) {
    let value = 0;
    for (let i = 0; i < fps; i++) value += (1 - value) * responseAlpha(13, 1 / fps);
    expect(value).toBeCloseTo(1 - Math.exp(-13), 12);
  }
});

test("pool-to-fall surface transition has no binary switch at the lip", () => {
  expect(standingFraction(0.1, 0.2, true)).toBe(1);
  expect(standingFraction(0.1, 0.2, false)).toBe(0);
  expect(standingFraction(0.1, 0.01, false)).toBe(1);
  expect(Math.abs(standingFraction(0.1, 0.049999, false) - standingFraction(0.1, 0.050001, false))).toBeLessThan(0.0002);
});

test("joined fill has exact cell bounds, no buried shared faces and outward winding", () => {
  const data = buildLatentFillGeometry([{ x: 0, z: 0, y0: 0, y1: 2 }, { x: 1, z: 0, y0: 0, y1: 2 }]);
  expect(data.indices.length / 6).toBe(10);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < data.indices.length; i += 3) {
    const ia = data.indices[i] * 3;
    a.fromArray(data.positions, ia); b.fromArray(data.positions, data.indices[i + 1] * 3); c.fromArray(data.positions, data.indices[i + 2] * 3);
    normal.fromArray(data.normals, ia);
    expect(b.sub(a).cross(c.sub(a)).dot(normal)).toBeGreaterThan(0);
    expect(a.x === 0.5 && Math.abs(normal.x) === 1).toBe(false);
  }
  expect(Math.min(...data.positions)).toBe(-0.5);
});

test("carved gaps expose only the newly opened interval", () => {
  const data = buildLatentFillGeometry([{ x: 0, z: 0, y0: 0, y1: 4 }, { x: 1, z: 0, y0: 0, y1: 1 }, { x: 1, z: 0, y0: 3, y1: 4 }]);
  const exposed: number[] = [];
  for (let i = 0; i < data.positions.length; i += 12) {
    if (data.normals[i] === 1 && data.positions[i] === 0.5) {
      for (let k = 0; k < 4; k++) exposed.push(data.positions[i + k * 3 + 1]);
    }
  }
  expect(exposed.sort()).toEqual([1.5, 1.5, 2.5, 2.5]);
});

test("real water fills, pauses without adding mass, and accounts for terrain displacement once", () => {
  let now = 1000;
  const clock = performance.now;
  performance.now = () => now;
  const nx = 8, ny = 6, nz = 8;
  const solid = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) solid[nx * nz + z * nx + x] = 1;
  const noop = () => {};
  const renderer = { autoClear: true, getPixelRatio: () => 1, getRenderTarget: () => null,
    getClearColor: (c: THREE.Color) => c.set(0), getClearAlpha: () => 1,
    setRenderTarget: noop, setClearColor: noop, clear: noop, clearDepth: noop, render: noop };
  const water = createTerraceWater({ THREE, renderer, nx, ny, nz, solid,
    spring: { x: 4, y: 2, z: 4 }, off: { x: 0, y: 0, z: 0 }, cellV: 1, springRate: 0.09, warmSteps: 0, drops: false });
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const tick = () => { now += 1000 / 60; water.frame(scene, camera, new THREE.Vector3(0,1,0), { color: new THREE.Color(1,1,1) }, new THREE.Color(1,1,1), null); };
  try {
    for (let n = 0; n < 90; n++) tick();
    const before = water.stats();
    expect(before.tris).toBeGreaterThan(0);
    expect(before.volume).toBeGreaterThan(0);
    water.knob({ paused: true });
    for (let n = 0; n < 60; n++) tick();
    expect(water.stats().volume).toBe(before.volume);
    const i = 2 * nx * nz + 4 * nx + 4;
    const removed = water.massAt(i);
    solid[i] = 1; water.onCellSolidified(i); tick();
    const after = water.stats();
    expect(after.displaced).toBeCloseTo(removed, 6);
    expect(after.drained).toBe(before.drained);
    expect(after.emitted - after.volume - after.drained - after.displaced).toBeCloseTo(0, 4);
  } finally { water.dispose(); performance.now = clock; }
});
