// Voxel cloud ring — artist-made voxel cumulus meshes (CloudPack) scattered
// around the island, lit by the world's REAL sun/moon (no raymarch). This is
// the cheap, mobile-safe alternative to the volumetric raymarch clouds: the 3D
// form (bright tops, shaded undersides) comes for free from the scene's actual
// directional light + shadow map, so headless frames match the device and it
// never trips the iOS GPU watchdog.
//
// Public API mirrors createVolumetricCloudRing so it drops into the same call
// site: { mesh, state, update(), configure(), dispose() }.

export interface VoxelCloudOptions {
  THREE: any;
  scene: any;
  camera: any;
  span: number;
  gltfLoader: any; // an instantiated GLTFLoader
  glbUrl?: string;
  enabled?: boolean;
  count?: number;
  sizeScale?: number;
  innerScale?: number; // clear-zone radius (× span)
  outerScale?: number; // band reach (× span)
  topScale?: number; // band height (× span)
}

export interface VoxelCloudUpdate {
  elapsedSeconds: number;
  keyDirection?: any;
  keyColor?: any;
  skyColor?: any;
  keyIntensity?: number;
}

// Deterministic PRNG so the scatter is stable frame-to-frame and reload-to-reload.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createVoxelCloudRing(opts: VoxelCloudOptions) {
  const {
    THREE, scene, camera, span, gltfLoader,
    glbUrl = "/cloud-pieces-lo.glb",
  } = opts;

  const state = {
    enabled: opts.enabled ?? false,
    count: opts.count ?? 120,
    sizeScale: opts.sizeScale ?? 1,
    inner: opts.innerScale ?? 0.7,
    outer: opts.outerScale ?? 1.7,
    top: opts.topScale ?? 2.0,
    opacity: 0.94,
    edgeFade: 0.26,
    driftSpeed: 0.012, // radians/sec of ring orbit
    bob: 0.6, // vertical bob amplitude (world units)
  };

  const group = new THREE.Group();
  group.name = "voxelCloudRing";
  group.visible = state.enabled;
  scene.add(group);

  // Shared cloud material: white, softly translucent, lit by the scene's real
  // lights. Fresnel edge-fade (from the water shader) softens the chunky voxel
  // silhouette into wispy edges.
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    opacity: state.opacity,
    depthWrite: false,
  });
  material.customProgramCacheKey = () => "tinyworldVoxelCloudV1";
  const uEdgeFade = { value: state.edgeFade };
  const uCloudOpacity = { value: state.opacity };
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.uEdgeFade = uEdgeFade;
    shader.uniforms.uCloudOpacity = uCloudOpacity;
    shader.vertexShader =
      "varying vec3 vCloudViewNormal;\nvarying vec3 vCloudViewPos;\n" +
      shader.vertexShader.replace(
        "#include <fog_vertex>",
        "#include <fog_vertex>\n  vCloudViewNormal = normalize(transformedNormal);\n  vCloudViewPos = -mvPosition.xyz;",
      );
    shader.fragmentShader =
      "uniform float uEdgeFade;\nuniform float uCloudOpacity;\nvarying vec3 vCloudViewNormal;\nvarying vec3 vCloudViewPos;\n" +
      shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        "  float _fres = 1.0 - abs(dot(normalize(vCloudViewNormal), normalize(vCloudViewPos)));\n" +
          "  gl_FragColor.a *= uCloudOpacity * (1.0 - uEdgeFade * _fres * _fres);\n" +
          "  #include <dithering_fragment>",
      );
  };

  const pieces: any[] = []; // template meshes from the GLB
  const instances: {
    obj: any;
    baseY: number;
    angle: number;
    radius: number;
    bobPhase: number;
    bobRate: number;
  }[] = [];
  let ready = false;

  const scatter = () => {
    if (!pieces.length) return;
    // Clear existing
    for (const inst of instances) group.remove(inst.obj);
    instances.length = 0;

    const rnd = mulberry32(0xc10d5); // stable seed
    const innerR = span * state.inner;
    const outerR = span * state.outer;
    const topY = span * state.top;

    for (let i = 0; i < state.count; i++) {
      const template = pieces[i % pieces.length];
      const obj = template.clone(true);
      // Densely wrap the ring: small angular jitter so pieces overlap into a
      // continuous bank rather than reading as evenly-spaced dots.
      const angle = (i / state.count) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
      const radius = innerR + rnd() * Math.max(0.001, outerR - innerR);
      // Tall, dense, overlapping cumulus WALLS (matching KJ's reference): pieces
      // span a large vertical range (from just below island level up high) so
      // they stack into a curtain of cloud filling the frame, not a thin low
      // band of separated blobs. topY = span*top(=2) is the tall envelope.
      const baseY = topY * (rnd() * 0.5 - 0.06);
      const s = state.sizeScale * (0.8 + rnd() * 1.1) * (span * 0.34);
      obj.scale.setScalar(s);
      obj.rotation.y = rnd() * Math.PI * 2;
      obj.position.set(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
      obj.traverse((n: any) => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = false; } });
      group.add(obj);
      instances.push({
        obj, baseY, angle, radius,
        bobPhase: rnd() * Math.PI * 2,
        bobRate: 0.12 + rnd() * 0.18,
      });
    }
    ready = true;
  };

  gltfLoader.load(
    glbUrl,
    (gltf: any) => {
      gltf.scene.traverse((n: any) => {
        if (n.isMesh) {
          const m = n.clone();
          m.material = material;
          m.position.set(0, 0, 0);
          m.rotation.set(0, 0, 0);
          m.scale.setScalar(1);
          // Center each piece on its own bbox so placement is predictable.
          m.geometry = n.geometry;
          pieces.push(m);
        }
      });
      if (pieces.length) scatter();
      else console.warn("[voxel-clouds] GLB had no meshes:", glbUrl);
    },
    undefined,
    (err: any) => console.error("[voxel-clouds] failed to load", glbUrl, err),
  );

  const update = (input: VoxelCloudUpdate) => {
    if (!state.enabled || !ready) return;
    const t = input.elapsedSeconds;
    group.rotation.y = t * state.driftSpeed;
    for (const inst of instances) {
      inst.obj.position.y = inst.baseY + Math.sin(t * inst.bobRate + inst.bobPhase) * state.bob;
    }
  };

  const applyState = () => {
    group.visible = state.enabled;
    uEdgeFade.value = Math.max(0, Math.min(1, state.edgeFade));
    uCloudOpacity.value = Math.max(0, Math.min(1, state.opacity));
  };

  const configure = (next: Partial<typeof state>) => {
    const needsScatter =
      (next.count !== undefined && next.count !== state.count) ||
      (next.sizeScale !== undefined && next.sizeScale !== state.sizeScale) ||
      (next.inner !== undefined && next.inner !== state.inner) ||
      (next.outer !== undefined && next.outer !== state.outer) ||
      (next.top !== undefined && next.top !== state.top);
    Object.assign(state, next);
    applyState();
    if (needsScatter) scatter();
    return { ...state };
  };

  applyState();

  return {
    mesh: group,
    material,
    state,
    update,
    configure,
    isVoxel: true,
    dispose() {
      scene.remove(group);
      material.dispose();
    },
  };
}
