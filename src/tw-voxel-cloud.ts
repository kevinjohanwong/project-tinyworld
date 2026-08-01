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
  towerFrac?: number; // fraction of clouds built as tall stacked nimbus towers
  towerLevels?: number; // vertical stack count per tower
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
    glbUrl = "/cloud-pieces.glb", // full-res: crisp voxels + baked vertex-AO the shading needs
  } = opts;

  const state = {
    enabled: opts.enabled ?? false,
    // count reduced (120→76→50) and the ring pushed out (outer 1.7→2.4, top
    // 2.0→2.6) so the big billowing cauliflower TOWERS read as hero formations
    // against open sky (the Ghibli day reference), not a maxed-out overhead wall.
    // The towers are now broad continuous masses, so fewer clouds is fuller.
    // Push back up via ?cloudcount= if a denser bank is wanted.
    count: opts.count ?? 50,
    sizeScale: opts.sizeScale ?? 1,
    inner: opts.innerScale ?? 0.7,
    outer: opts.outerScale ?? 2.6,
    top: opts.topScale ?? 2.6,
    opacity: 0.94,
    edgeFade: 0.26,
    // VOXEL-SIZE VARIATION: a fraction of clouds are built as CLUSTERS of small
    // pieces (same footprint, finer voxels) instead of one big piece (coarse
    // voxels). Mixing coarse + fine in one bank is the "variation is key" look.
    fineFrac: 0.5, // fraction of clouds rendered fine (cluster of small pieces)
    fineScale: 0.46, // per-sub-piece scale (× the cloud's footprint) → voxel fineness
    fineSpread: 0.3, // how tightly the sub-pieces pack within the footprint
    // TALL NIMBUS TOWERS: a fraction of clouds are built by STACKING pieces
    // vertically into one large billowing mass (wide fluffy base → bulging mid
    // → tapering crown). This is the only formation with real VERTICAL
    // development — cumulonimbus grandeur, not a low puff.
    towerFrac: opts.towerFrac ?? 0.4, // fraction of clouds built as tall stacked towers
    towerLevels: opts.towerLevels ?? 6, // vertical stack count (more = taller)
    towerStep: 0.42, // vertical rise per level (× level width; <1 = overlapping/continuous)
    towerWidth: 1.95, // base footprint multiplier for towers (broad billowing mass)
    towerLean: 0.35, // horizontal wander/lean of the stack (billow, not a straight column)
    fuzz: 0.35, // fuzzy shading power (0 = flat faces)
    fuzzTiling: 0.55, // fuzzy noise scale
    backlight: 0.6, // "play to light": sun-through glow strength
    backSharp: 3.5, // backlight falloff sharpness
    driftSpeed: 0.012, // radians/sec of ring orbit
    bob: 0.6, // vertical bob amplitude (world units)
  };

  const group = new THREE.Group();
  group.name = "voxelCloudRing";
  group.visible = state.enabled;
  scene.add(group);

  // Cloud material reproducing the CloudPack "Cloud Shading" model (Style 01):
  //   colour = heightGradient(secColor bottom → baseColor top) × FuzzyShading
  //            (lavender rim shine + core darkening) × bakedVertexAO
  //   shading = toonRamp(NdotL): dark blue-purple shadow → lavender → white-blue
  //   × the REAL sun colour/intensity (doctrine: light from the world's sun).
  // Fully custom fragment colour so it's toon-banded, not smooth PBR. Opaque
  // (reference clouds are solid) → crisp voxel silhouette + cheap (no overdraw).
  const uSunDir = { value: new THREE.Vector3(0.35, 0.9, 0.2).normalize() };
  const uLight = { value: new THREE.Color(1, 1, 1) };
  const uBaseColor = { value: new THREE.Color(0.98, 0.965, 0.925) }; // top — warm near-white (cream), not cool blue
  const uSecColor = { value: new THREE.Color(0.60, 0.66, 0.76) }; // bottom — bright cool blue-GREY shadow (not purple)
  const uRimColor = { value: new THREE.Color(0.82, 0.62, 0.72) }; // lavender edge (only shows at low sun via rimGate)
  const uParams = { value: new THREE.Vector4(0.7, 0.1, 0.14, 1.6) }; // edgeBright, coreDark, aoStrength, rimPow
  const uGrad = { value: new THREE.Vector2(1.25, -0.12) }; // heightFalloff, heightOffset
  const uNoise = { value: new THREE.Vector2(0.55, 0.5) }; // fuzz: tiling(×span), power
  const uBack = { value: new THREE.Vector2(0.6, 3.5) }; // backlight: strength, sharpness
  const uSpanRef = { value: Math.max(1e-3, span) };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
    transparent: true, depthWrite: true, // depthWrite keeps the opaque core sorted; only silhouette edges blend
  });
  material.customProgramCacheKey = () => "tinyworldVoxelCloudVBfineface";
  material.onBeforeCompile = (shader: any) => {
    Object.assign(shader.uniforms, {
      uSunDir, uLight, uBaseColor, uSecColor, uRimColor, uParams, uGrad, uNoise, uBack, uSpanRef,
    });
    shader.vertexShader =
      "attribute float aY01;\nvarying float vY01;\nvarying vec3 vWN;\nvarying vec3 vVDir;\nvarying vec3 vWPos;\n" +
      shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n" +
          "  vec3 _wp = (modelMatrix * vec4(transformed, 1.0)).xyz;\n" +
          "  vWN = normalize(mat3(modelMatrix) * objectNormal);\n" +
          "  vVDir = normalize(cameraPosition - _wp);\n" +
          "  vWPos = _wp;\n" +
          "  vY01 = aY01;",
      );
    shader.fragmentShader =
      "uniform vec3 uSunDir;\nuniform vec3 uLight;\nuniform vec3 uBaseColor;\nuniform vec3 uSecColor;\nuniform vec3 uRimColor;\nuniform vec4 uParams;\nuniform vec2 uGrad;\nuniform vec2 uNoise;\nuniform vec2 uBack;\nuniform float uSpanRef;\n" +
      "varying float vY01;\nvarying vec3 vWN;\nvarying vec3 vVDir;\nvarying vec3 vWPos;\n" +
      "vec3 cloudRamp(float t){\n" +
      "  vec3 c0 = vec3(0.56,0.61,0.69); vec3 c1 = vec3(0.82,0.84,0.88); vec3 c2 = vec3(1.0,1.0,0.99);\n" +
      "  t = clamp(t,0.0,1.0);\n" +
      "  return t < 0.5 ? mix(c0, c1, smoothstep(0.05,0.5,t)) : mix(c1, c2, smoothstep(0.5,0.9,t));\n" +
      "}\n" +
      "float _h(vec3 p){ p = fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\n" +
      "float _vn(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);\n" +
      "  return mix(mix(mix(_h(i+vec3(0,0,0)),_h(i+vec3(1,0,0)),f.x),mix(_h(i+vec3(0,1,0)),_h(i+vec3(1,1,0)),f.x),f.y),\n" +
      "             mix(mix(_h(i+vec3(0,0,1)),_h(i+vec3(1,0,1)),f.x),mix(_h(i+vec3(0,1,1)),_h(i+vec3(1,1,1)),f.x),f.y),f.z); }\n" +
      "float _fbm(vec3 x){ return 0.6*_vn(x)+0.3*_vn(x*2.03+11.1)+0.15*_vn(x*4.01+23.7); }\n" +
      shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        "  vec3 N = normalize(vWN);\n" +
          // DE-BLOCK: perturb the flat cube-face normal with 3D noise so lighting
          // varies smoothly ACROSS voxel faces/edges instead of a hard per-face
          // plane — the single biggest 'reads soft not Minecraft' lever.
          "  float nf = uNoise.x / uSpanRef * 6.0;\n" +
          "  vec3 nz = vec3(_fbm(vWPos*nf+3.1), _fbm(vWPos*nf+9.7), _fbm(vWPos*nf+21.3)) - 0.5;\n" +
          // finer octave: break the FLAT cube faces themselves into micro-variation
          "  vec3 nz2 = vec3(_fbm(vWPos*nf*3.3+51.0), _fbm(vWPos*nf*3.3+63.0), _fbm(vWPos*nf*3.3+77.0)) - 0.5;\n" +
          "  N = normalize(N + nz * 1.1 + nz2 * 0.55);\n" +
          "  float ao = mix(1.0, clamp(vColor.r,0.0,1.0), uParams.z);\n" +
          "  float g = clamp((vY01 + uGrad.y) * uGrad.x, 0.0, 1.0);\n" +
          // large-scale billow: soft light/dark lobes so the mass has volume, not flat tone
          "  float billow = _fbm(vWPos * (nf * 0.35) + 41.0);\n" +
          "  vec3 col = mix(uSecColor, uBaseColor, clamp(g + (billow-0.5)*0.6, 0.0, 1.0));\n" +
          // FUZZY: 3D value-noise (fbm) over world pos perturbs the shading value so
          // the flat voxel faces get soft cloud-like variation instead of a hard tone.
          "  float fuzz = (_fbm(vWPos * (uNoise.x / uSpanRef * 8.0)) - 0.5) * uNoise.y;\n" +
          "  float ndl = clamp(dot(N, normalize(uSunDir)) * 0.5 + 0.5 + fuzz, 0.0, 1.0);\n" +
          "  col *= cloudRamp(ndl);\n" +
          // DAWN/DUSK two-tone: at a low sun, the shaded side is filled by cool sky
          // light → lavender-cool shadows against warm-lit tops (reference look).
          "  float lowSun = smoothstep(0.55, 0.1, normalize(uSunDir).y);\n" +
          "  col *= mix(vec3(1.0), vec3(0.82,0.84,1.02), (1.0 - ndl) * lowSun * 0.7);\n" +
          "  float ndv = clamp(dot(N, normalize(vVDir)), 0.0, 1.0);\n" +
          // Lavender rim is a DAWN/DUSK phenomenon — gate it by sun elevation so a
          // high noon sun gives ~no lavender (day cumulus read white, not sunset).
          "  float rimGate = smoothstep(0.55, 0.08, normalize(uSunDir).y);\n" +
          "  float rim = pow(1.0 - ndv, uParams.w) * uParams.x * rimGate;\n" +
          "  col = mix(col, uRimColor, rim);\n" +
          "  col *= (1.0 - uParams.y * ndv);\n" +
          "  col *= ao;\n" +
          "  col *= uLight;\n" +
          // PLAY TO LIGHT: sun BEHIND the cloud (toward viewer) → transmitted glow on
          // the edges, using the real sun colour. Thin/edge parts (low ndv) glow most.
          "  float back = pow(clamp(dot(normalize(uSunDir), -normalize(vVDir)), 0.0, 1.0), uBack.y);\n" +
          "  back *= uBack.x * (0.35 + 0.65 * (1.0 - ndv));\n" +
          "  col += uLight * back;\n" +
          "  gl_FragColor.rgb = col;\n" +
          // SOFT SILHOUETTE: fade alpha at grazing angles (the outline) so the hard
          // voxel edge feathers into the sky instead of a crisp Minecraft cube edge.
          // uGrad.x reused? no — use a fixed feather; 'ndvRaw' is the un-perturbed view dot.
          "  float ndvRaw = clamp(dot(normalize(vWN), normalize(vVDir)), 0.0, 1.0);\n" +
          // NOISE-ERODED edge: subtract fbm near the silhouette so the outline breaks
          // into irregular fluff (real cloud wisps), not a clean geometric fade.
          "  float edgeN = _fbm(vWPos * (nf * 1.6) + 61.0);\n" +
          "  gl_FragColor.a = smoothstep(0.0, 0.6, ndvRaw - (1.0 - ndvRaw) * (0.5 - edgeN) * 1.35);\n" +
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
      // Densely wrap the ring: small angular jitter so pieces overlap into a
      // continuous bank rather than reading as evenly-spaced dots.
      const angle = (i / state.count) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
      const radius = innerR + rnd() * Math.max(0.001, outerR - innerR);
      // Tall, dense, overlapping cumulus WALLS (matching KJ's reference): pieces
      // span a large vertical range (from just below island level up high) so
      // they stack into a curtain of cloud filling the frame, not a thin low
      // band of separated blobs. topY = span*top(=2) is the tall envelope.
      let baseY = topY * (rnd() * 0.5 - 0.06);
      // The cloud's overall footprint (screen size). Voxel granularity is what
      // we VARY per cloud below — coarse clouds use one piece at this footprint,
      // fine clouds pack several smaller pieces into it.
      const footprint = state.sizeScale * (0.8 + rnd() * 1.1) * (span * 0.34);
      const roll = rnd();

      let obj: any;
      if (roll < state.towerFrac) {
        // TOWER (cumulus congestus, the Ghibli day reference): a BROAD billowing
        // cauliflower MASS — roughly as wide as it is tall — not a thin totem.
        // Each level is a CLUSTER of overlapping pieces filling the level's width
        // (a wide billowing band), stacked with heavy vertical overlap so the body
        // reads as one continuous dense mass. Profile: spreading base → slight
        // waist → bulging round head → domed crown.
        obj = new THREE.Group();
        const levels = Math.max(3, Math.round(state.towerLevels));
        const leanA = rnd() * Math.PI * 2;
        const leanX = Math.cos(leanA) * footprint * state.towerLean;
        const leanZ = Math.sin(leanA) * footprint * state.towerLean;
        let y = 0;
        for (let j = 0; j < levels; j++) {
          const f = j / (levels - 1); // 0 base → 1 crown
          // cumulus profile (the Ghibli day reference): BROAD grounded base and
          // wide lower body (the widest bulk sits LOW, ~0.3), gentle waist, then
          // the rounded cauliflower head domes off. Heavy pile on the ground —
          // NOT a narrow pinched foot.
          let prof: number;
          if (f < 0.12) prof = 1.16 + f * 1.0; // broad flat foot (~1.16→1.28)
          else if (f < 0.4) prof = 1.28 + (f - 0.12) * 0.25; // widest lower body (~1.28→1.35)
          else if (f < 0.72) prof = 1.35 - (f - 0.4) * 0.9; // gentle waist up (~1.35→1.06)
          else if (f < 0.9) prof = 1.06 - (f - 0.72) * 0.5; // round the head shoulders (~0.97)
          else prof = 0.97 - (f - 0.9) * 3.5; // dome the crown down to ~0.6
          prof = Math.max(0.5, prof);
          const lw = footprint * state.towerWidth * prof;
          // fill the level's WIDTH with a DENSE cluster of big rounded lobes —
          // more pieces where it's wider, bigger scale + tighter packing so the
          // body reads as one solid rounded mass (not scattered cubes).
          const nSub = Math.max(4, Math.round(4 + prof * 3.2));
          for (let p = 0; p < nSub; p++) {
            const sub = pieces[Math.floor(rnd() * pieces.length)].clone(true);
            sub.scale.setScalar(lw * (0.6 + rnd() * 0.4)); // bigger rounder lobes
            sub.rotation.y = rnd() * Math.PI * 2;
            const pa = rnd() * Math.PI * 2;
            const pr = lw * 0.4 * Math.sqrt(rnd()); // tighter → denser core, less scatter
            sub.position.set(
              Math.cos(pa) * pr + leanX * f,
              y + (rnd() - 0.5) * lw * 0.14,
              Math.sin(pa) * pr + leanZ * f,
            );
            obj.add(sub);
          }
          // step is mostly FIXED (not proportional to the wide head) so no vertical
          // gap opens beneath the bulge — keeps the body one continuous mass.
          y += footprint * state.towerWidth * state.towerStep * (0.34 + 0.42 * prof);
        }
        // anchor the tower LOW so it rises up through the frame
        baseY = topY * (rnd() * 0.12 - 0.14);
      } else if (rnd() < state.fineFrac) {
        // FINE: cluster of small pieces → same footprint, finer voxels. Each
        // sub-piece is fineScale× the footprint, so its voxels read ~2× smaller;
        // packing 3–5 of them overlapping rebuilds a cloud of similar size out
        // of finer cubes. Slight per-sub-piece scale jitter keeps it organic.
        obj = new THREE.Group();
        const k = 3 + Math.floor(rnd() * 3); // 3..5 sub-pieces
        const spread = footprint * state.fineSpread;
        for (let j = 0; j < k; j++) {
          const sub = pieces[Math.floor(rnd() * pieces.length)].clone(true);
          const ss = footprint * state.fineScale * (0.72 + rnd() * 0.62);
          sub.scale.setScalar(ss);
          sub.rotation.y = rnd() * Math.PI * 2;
          const oa = rnd() * Math.PI * 2;
          const orr = spread * Math.sqrt(rnd()); // area-uniform → packed, not ring
          sub.position.set(Math.cos(oa) * orr, (rnd() - 0.5) * spread * 0.9, Math.sin(oa) * orr);
          obj.add(sub);
        }
      } else {
        // COARSE: one piece at full footprint (the current chunky look).
        obj = pieces[i % pieces.length].clone(true);
        obj.scale.setScalar(footprint);
        obj.rotation.y = rnd() * Math.PI * 2;
      }
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
          m.geometry = n.geometry;
          // Bake per-piece object-space height (0 bottom → 1 top) for the
          // colour gradient (secColor → baseColor).
          const geo = m.geometry;
          if (!geo.getAttribute("aY01")) {
            geo.computeBoundingBox();
            const y0 = geo.boundingBox.min.y;
            const h = Math.max(1e-4, geo.boundingBox.max.y - y0);
            const pos = geo.getAttribute("position");
            const arr = new Float32Array(pos.count);
            for (let k = 0; k < pos.count; k++) arr[k] = (pos.getY(k) - y0) / h;
            geo.setAttribute("aY01", new THREE.BufferAttribute(arr, 1));
          }
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
    // Drive the toon shading from the world's REAL sun/moon (doctrine).
    if (input.keyDirection) uSunDir.value.copy(input.keyDirection).normalize();
    if (input.keyColor) {
      uLight.value.copy(input.keyColor);
      // clamp so a bright app sun can't blow the clouds out; night dims them
      if (input.keyIntensity != null)
        uLight.value.multiplyScalar(Math.min(1.5, Math.max(0.25, input.keyIntensity)));
    }
    const t = input.elapsedSeconds;
    group.rotation.y = t * state.driftSpeed;
    for (const inst of instances) {
      inst.obj.position.y = inst.baseY + Math.sin(t * inst.bobRate + inst.bobPhase) * state.bob;
    }
  };

  const applyState = () => {
    group.visible = state.enabled;
    uNoise.value.set(state.fuzzTiling, Math.max(0, state.fuzz));
    uBack.value.set(Math.max(0, state.backlight), Math.max(0.5, state.backSharp));
  };

  const configure = (next: Partial<typeof state>) => {
    const needsScatter =
      (next.count !== undefined && next.count !== state.count) ||
      (next.sizeScale !== undefined && next.sizeScale !== state.sizeScale) ||
      (next.inner !== undefined && next.inner !== state.inner) ||
      (next.outer !== undefined && next.outer !== state.outer) ||
      (next.top !== undefined && next.top !== state.top) ||
      (next.fineFrac !== undefined && next.fineFrac !== state.fineFrac) ||
      (next.fineScale !== undefined && next.fineScale !== state.fineScale) ||
      (next.fineSpread !== undefined && next.fineSpread !== state.fineSpread) ||
      (next.towerFrac !== undefined && next.towerFrac !== state.towerFrac) ||
      (next.towerLevels !== undefined && next.towerLevels !== state.towerLevels) ||
      (next.towerStep !== undefined && next.towerStep !== state.towerStep) ||
      (next.towerWidth !== undefined && next.towerWidth !== state.towerWidth) ||
      (next.towerLean !== undefined && next.towerLean !== state.towerLean);
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
