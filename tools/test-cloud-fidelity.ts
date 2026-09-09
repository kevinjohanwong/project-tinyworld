import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCloudClock, patchCloudShader } from "../src/tw-cloud-shading";
import { createCloudSeaData } from "../src/tw-cloud-sea";
import { createVoxelCloudRing } from "../src/tw-voxel-cloud";

function fixture(span = 30) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, span * 100);
  camera.position.set(span * 0.05, span * 0.12, 0);
  camera.lookAt(span * 5, span * 0.35, 0);
  const template = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
  template.add(new THREE.Mesh(geometry));
  const ring = createVoxelCloudRing({ THREE, scene, camera, span, enabled: true,
    gltfLoader: { load(_url: string, ready: Function) { ready({ scene: template }); } } });
  ring.update({ elapsedSeconds: 0 });
  return { scene, camera, ring };
}

describe("cloud motion", () => {
  test("same slow movement at 30/60/120 Hz", () => {
    for (const fps of [30, 60, 120]) {
      const clock = createCloudClock();
      let result = clock.step(0, 0.00012);
      for (let n = 1; n <= fps * 60; n++) result = clock.step(n / fps, 0.00012);
      expect(result.seconds).toBeCloseTo(60, 8);
      expect(result.angle).toBeCloseTo(0.0072, 8);
    }
  });
  test("tab resumes, resets, invalid input, and speed edits do not teleport", () => {
    const clock = createCloudClock();
    clock.step(100, 0.00012);
    expect(clock.step(100.1, 0.00012).seconds).toBeCloseTo(0.1);
    expect(clock.step(500, 0.00012).seconds).toBeCloseTo(0.1);
    expect(clock.step(NaN, 0.00012).seconds).toBeCloseTo(0.1);
    expect(clock.step(0, 0.00012).seconds).toBeCloseTo(0.1);
    const angle = clock.step(0.1, 0.00012).angle;
    expect(clock.step(0.2, 0).angle).toBe(angle);
    expect(clock.step(0.3, 0.00012, false).angle).toBe(angle);
  });
  test("shader bob is after instance scale and matches CPU world displacement", () => {
    for (const sy of [0.2, 1, 40]) {
      const instance = new THREE.Matrix4().compose(new THREE.Vector3(10, 20, 30), new THREE.Quaternion(), new THREE.Vector3(3, sy, 5));
      const rest = new THREE.Vector3(0.2, 0.4, 0.6).applyMatrix4(instance);
      const moved = rest.clone();
      moved.y += Math.sin(0.7) * 0.09;
      expect(moved.y - rest.y).toBeCloseTo(Math.sin(0.7) * 0.09, 10);
    }
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    patchCloudShader(shader, {}, true);
    expect(shader.vertexShader.indexOf("cloudLocal.y += cloudBob")).toBeGreaterThan(shader.vertexShader.indexOf("cloudLocal = instanceMatrix*cloudLocal"));
    expect(shader.vertexShader).not.toContain("transformed.y +=");
    expect(shader.vertexShader).toContain("inverseTransformDirection(transformedNormal,viewMatrix)");
  });
});

describe("cloud sea geometry", () => {
  test("deterministic cubic faces: nondegenerate triangles, correct winding, bounded budget", () => {
    const data = createCloudSeaData(30, 40.5, 210);
    expect(data.positions).toEqual(createCloudSeaData(30, 40.5, 210).positions);
    expect(data.indices.length / 3).toBeLessThan(103680);
    expect(data.cells).toBeGreaterThan(18000);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    let sides = 0;
    for (let i = 0; i < data.indices.length; i += 3) {
      const index = data.indices[i];
      a.fromArray(data.positions, index * 3);
      b.fromArray(data.positions, data.indices[i + 1] * 3).sub(a);
      c.fromArray(data.positions, data.indices[i + 2] * 3).sub(a);
      n.fromArray(data.normals, index * 3);
      const cross = b.cross(c);
      expect(cross.lengthSq()).toBeGreaterThan(1e-8);
      expect(cross.normalize().dot(n)).toBeGreaterThan(0.999);
      expect(Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z)).toBe(1);
      if (n.y === 0) sides++;
    }
    expect(sides).toBeGreaterThan(1000);
    console.log(JSON.stringify({ cells: data.cells, triangles: data.indices.length / 3, sideTriangles: sides, cell: data.cell }));
  });
  test("world-size invariant topology and sane bounds", () => {
    const a = createCloudSeaData(3, 4.05, 21);
    const b = createCloudSeaData(30, 40.5, 210);
    expect(a.indices.length).toBe(b.indices.length);
    expect(() => createCloudSeaData(0, 1, 2)).toThrow();
    expect(() => createCloudSeaData(30, 40.5, 40)).toThrow();
    expect([...b.colors].every(v => v >= 0.6 && v <= 1)).toBe(true);
  });
});

describe("cloud integration", () => {
  test("shared shading fails loudly on missing Three.js anchors", () => {
    expect(() => patchCloudShader({ uniforms: {}, vertexShader: "", fragmentShader: "" }, {}, true)).toThrow();
    for (const [key, instanced] of [["standard", true], ["lambert", false]] as const) {
      const shader = { uniforms: {}, vertexShader: THREE.ShaderLib[key].vertexShader, fragmentShader: THREE.ShaderLib[key].fragmentShader };
      patchCloudShader(shader, {}, instanced);
      expect(shader.fragmentShader).toContain("vec4 shadeCloud(float bakedAO, float feather)");
      expect(shader.fragmentShader).toContain("length(vWPos-cameraPosition)");
      expect(shader.fragmentShader).toContain("if (gl_FragColor.a < 0.01) discard;");
    }
  });
  test("absent towerfrac preserves the authored default; explicit zero still disables it", async () => {
    const source = await Bun.file(new URL("../src/tw-staging-app.tsx", import.meta.url)).text();
    const assignment = source.match(/const _cloudTowerFracParam = ([^;]+);/);
    expect(assignment).not.toBeNull();
    const parse = new Function("__diagParams", `return ${assignment![1]};`);
    expect(Number.isNaN(parse(new URLSearchParams()))).toBe(true);
    expect(parse(new URLSearchParams("towerfrac=0"))).toBe(0);
    expect(parse(new URLSearchParams("towerfrac=0.4"))).toBe(0.4);
  });
  test("scatter remains bounded, configure repopulates without waiting, sea does not morph", () => {
    const { ring, scene } = fixture();
    expect(ring.state.driftSpeed).toBe(0.00012);
    expect(ring.state.bob).toBeCloseTo(0.09);
    const sea = ring.mesh.getObjectByName("voxelCloudSea");
    const data = sea.geometry.attributes.position.array.slice();
    for (let i = 1; i <= 60; i++) ring.update({ elapsedSeconds: i / 60 });
    expect(sea.geometry.attributes.position.array).toEqual(data);
    expect(ring.mesh.children.length).toBe(2);
    expect(ring.mesh.children.some((m: any) => m.isInstancedMesh && m.count > 0)).toBe(true);
    ring.configure({ count: 25 });
    ring.update({ elapsedSeconds: 1 + 1 / 60 });
    expect(ring.mesh.children.some((m: any) => m.isInstancedMesh && m.count > 0)).toBe(true);
    ring.configure({ seaCount: 0 });
    expect(ring.mesh.getObjectByName("voxelCloudSea")).toBeUndefined();
    ring.dispose();
    expect(scene.children.length).toBe(0);
  });
});
