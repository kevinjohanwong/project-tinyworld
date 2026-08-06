// Voxel cloud ring — artist-made voxel cumulus meshes (CloudPack) scattered
// around the island, lit by the world's REAL sun/moon (no raymarch). This is
// the cheap, mobile-safe alternative to the volumetric raymarch clouds: the 3D
// form (bright tops, shaded undersides) comes for free from the scene's actual
// directional light + shadow map, so headless frames match the device and it
// never trips the iOS GPU watchdog.
//
// PERF (Aug 5, fidelity-neutral round 2): the population is now INSTANCED.
// The scatter math is unchanged (same PRNG order → bit-identical layout), but
// instead of ~1,100 cloned meshes (each a draw call, a matrixWorld update, and
// a transparent-sort entry — twice per frame when the RayGI/GTAO normal
// prepass re-renders the scene), every sub-piece is recorded as an instance of
// one of the ≤9 GLB piece geometries → ≤9 InstancedMesh draws. Per frame we do
// our own CPU frustum culling (conservative sphere test — never over-culls)
// and write visible instances BACK-TO-FRONT so the feathered-edge alpha
// blending keeps the same sorted result three's per-object sort produced.
// Same pixels, ~2 orders of magnitude fewer draw calls.
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
  seaCount?: number; // cloud-sea pieces below the island (0 disables the sea)
  seaLevel?: number; // sea band center (× span; negative = below the island)
  seaInner?: number; // sea start radius (× span)
  seaOuter?: number; // sea reach toward the horizon (× span)
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
    count: opts.count ?? 26,
    sizeScale: opts.sizeScale ?? 1,
    // Distant scattered sky: clouds sit FAR from the player (inner 2.2 span) so
    // they read as cumulus on the horizon, not a wall looming overhead. Not a ring.
    inner: opts.innerScale ?? 3.4,
    outer: opts.outerScale ?? 8.0,
    top: opts.topScale ?? 3.0,
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
    towerStep: 0.30, // vertical rise per level (× level width; <1 = overlapping/continuous)
    towerWidth: 1.95, // base footprint multiplier for towers (broad billowing mass)
    towerLean: 0.35, // horizontal wander/lean of the stack (billow, not a straight column)
    // FREE SKY SCATTER (no longer a ring wall): a few BIG hero clouds dominate the
    // view like the reference, the rest scatter across a disc of sky at varied
    // distance/height. heroCount big towers, heroSize× the normal footprint.
    heroCount: 5, // number of big dominant hero clouds (varied sizes)
    heroSize: 2.6, // hero footprint multiplier (× the normal cloud footprint)
    // CLOUD SEA (KJ Aug 4, the floating-palace references): a dense FLATTENED
    // cloud layer BELOW the island rim spreading far toward the horizon, so the
    // island reads as land standing above a cloud ocean. Sea pieces are single
    // coarse clones (cheap), y-flattened into rolling swells, heavily
    // overlapped, and GROW with distance so the far sea stays dense without
    // more meshes. 0 disables.
    seaCount: opts.seaCount ?? 360,
    seaLevel: opts.seaLevel ?? -0.42, // sea band center (× span; negative = below the island)
    seaInner: opts.seaInner ?? 0.3, // sea tucks in under the island edge (× span)
    seaOuter: opts.seaOuter ?? 7.0, // sea reach toward the horizon (× span)
    seaFlat: 0.62, // y-scale of sea pieces (rounded rolling swells — billowing, not squashed)
    fuzz: 0.35, // fuzzy shading power (0 = flat faces)
    fuzzTiling: 0.55, // fuzzy noise scale
    backlight: 0.6, // "play to light": sun-through glow strength
    backSharp: 3.5, // backlight falloff sharpness
    driftSpeed: 0.0035, // radians/sec of ring orbit (much slower drift)
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
  // aerial haze band (world units): far clouds dissolve toward the sun-tinted
  // horizon instead of ending at a hard edge. Set from the sea reach at scatter.
  const uHaze = { value: new THREE.Vector2(span * 4.5, span * 9.0) };
  const uCloudMotion = { value: new THREE.Vector2(0, 0) };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
    transparent: true, depthWrite: true, // depthWrite keeps the opaque core sorted; only silhouette edges blend
  });
  material.customProgramCacheKey = () => "tinyworldVoxelCloudVEinstBobGPU";
  material.onBeforeCompile = (shader: any) => {
    Object.assign(shader.uniforms, {
      uSunDir, uLight, uBaseColor, uSecColor, uRimColor, uParams, uGrad, uNoise, uBack, uSpanRef, uHaze, uCloudMotion,
    });
    shader.vertexShader =
      "attribute float aY01;\nattribute vec2 aCloudBob;\nuniform vec2 uCloudMotion;\nvarying float vY01;\nvarying vec3 vWN;\nvarying vec3 vVDir;\nvarying vec3 vWPos;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n#ifdef USE_INSTANCING\n  transformed.y += sin(uCloudMotion.x * aCloudBob.y + aCloudBob.x) * uCloudMotion.y;\n#endif",
      ).replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n" +
          // INSTANCING: the per-piece transform now lives in instanceMatrix, so
          // fold it in before modelMatrix — the product equals the old per-mesh
          // modelMatrix exactly (bit-identical world pos/normal math).
          "  vec4 _lp4 = vec4(transformed, 1.0);\n" +
          "  vec3 _ln = objectNormal;\n" +
          "#ifdef USE_INSTANCING\n" +
          "  _lp4 = instanceMatrix * _lp4;\n" +
          "  _ln = mat3(instanceMatrix) * _ln;\n" +
          "#endif\n" +
          "  vec3 _wp = (modelMatrix * _lp4).xyz;\n" +
          "  vWN = normalize(mat3(modelMatrix) * _ln);\n" +
          "  vVDir = normalize(cameraPosition - _wp);\n" +
          "  vWPos = _wp;\n" +
          "  vY01 = aY01;",
      );
    shader.fragmentShader =
      "uniform vec3 uSunDir;\nuniform vec3 uLight;\nuniform vec3 uBaseColor;\nuniform vec3 uSecColor;\nuniform vec3 uRimColor;\nuniform vec4 uParams;\nuniform vec2 uGrad;\nuniform vec2 uNoise;\nuniform vec2 uBack;\nuniform float uSpanRef;\nuniform vec2 uHaze;\n" +
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
          // TONAL VARIATION (not flat white): a very low-frequency field shifts
          // tone mass-to-mass — some clouds brighter, some cooler blue-grey —
          // like a real sky's varied cloud depths. Texture, not invented light.
          "  float tone = smoothstep(0.42, 0.60, _fbm(vWPos * (0.4 / uSpanRef) + 7.7));\n" +
          "  col *= mix(0.70, 1.10, tone);\n" +
          "  col = mix(col, col * vec3(0.80, 0.88, 1.08), (1.0 - smoothstep(0.3, 0.7, tone)) * 0.6);\n" +
          // AERIAL HAZE: with the sea reaching far out, distant clouds dissolve
          // toward a sun-tinted horizon (real atmospherics — reads as scale, and
          // kills the hard far edge). Colour-only; alpha keeps the solid horizon.
          "  float hd = smoothstep(uHaze.x, uHaze.y, length(vWPos.xz));\n" +
          "  vec3 hazeCol = mix(vec3(0.80, 0.87, 0.96), uLight, 0.4);\n" +
          "  col = mix(col, hazeCol, hd * 0.85);\n" +
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

  const pieces: any[] = []; // template meshes from the GLB (geometry + aY01 baked)
  const pieceRadius: number[] = []; // conservative unit bounding radius per piece
  // INSTANCED population. Each logical "cloud" (sky cloud or sea swell) keeps
  // its bob params; each rendered sub-piece is a flat instance spec pointing at
  // its piece geometry, its cloud (for bob), and its group-local matrix.
  const cloudsMeta: { bobPhase: number; bobRate: number }[] = [];
  const specs: {
    piece: number;
    m: any; // Matrix4, group-local, at bob=0
    cloud: number;
    cx: number; cy: number; cz: number; // translation (== m elements 12..14)
    rad: number; // conservative world bounding radius
  }[] = [];
  let bucketMeshes: any[] = []; // one InstancedMesh per piece geometry (or null)
  let ready = false;
  const seaDiscs: any[] = [];
  // Sea-disc material — NOT flat white (KJ Aug 4): procedural cloud-ocean
  // shading modulates the diffuse under the scene's real lights — bright
  // rounded lobe tops against blue-grey crevices, two fbm scales, drifting
  // slowly via uSeaTime. Texture only (no invented light — the sun/hemi still
  // do all the lighting through the Lambert path).
  const uSeaTime = { value: 0 };
  const uSeaSpan = { value: Math.max(1e-3, span) };
  const seaDiscMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  seaDiscMat.customProgramCacheKey = () => "tinyworldSeaDiscV2";
  seaDiscMat.onBeforeCompile = (shader: any) => {
    Object.assign(shader.uniforms, { uSeaTime, uSeaSpan });
    shader.vertexShader =
      "varying vec3 vSeaW;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vSeaW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader =
      "uniform float uSeaTime;\nuniform float uSeaSpan;\nvarying vec3 vSeaW;\n" +
      "float _sh(vec3 p){ p = fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\n" +
      "float _svn(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);\n" +
      "  return mix(mix(mix(_sh(i+vec3(0,0,0)),_sh(i+vec3(1,0,0)),f.x),mix(_sh(i+vec3(0,1,0)),_sh(i+vec3(1,1,0)),f.x),f.y),\n" +
      "             mix(mix(_sh(i+vec3(0,0,1)),_sh(i+vec3(1,0,1)),f.x),mix(_sh(i+vec3(0,1,1)),_sh(i+vec3(1,1,1)),f.x),f.y),f.z); }\n" +
      "float _sfbm(vec3 x){ return 0.6*_svn(x)+0.3*_svn(x*2.03+11.1)+0.15*_svn(x*4.01+23.7); }\n" +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n" +
          // large rolling masses (lit lobes vs shadowed troughs)
          "  float _k1 = 1.1 / uSeaSpan;\n" +
          "  float _lump = _sfbm(vec3(vSeaW.x * _k1, uSeaTime * 0.014, vSeaW.z * _k1));\n" +
          "  float _lit = smoothstep(0.44, 0.57, _lump);\n" +
          // fine mottle so the surface reads puffy, not airbrushed
          "  float _k2 = 4.6 / uSeaSpan;\n" +
          "  float _mot = _sfbm(vec3(vSeaW.x * _k2 + 31.0, uSeaTime * 0.03, vSeaW.z * _k2));\n" +
          "  vec3 _crev = vec3(0.80, 0.85, 0.93);\n" +
          "  diffuseColor.rgb *= mix(_crev, vec3(1.03, 1.02, 1.0), _lit);\n" +
          "  diffuseColor.rgb *= mix(0.92, 1.10, smoothstep(0.40, 0.62, _mot));\n",
      );
  };

  // Record one rendered sub-piece as an instance (replaces piece.clone(true)).
  // Same transform semantics as the old scene-graph clones: group-local
  // position, Y-rotation, per-axis scale.
  const _rq = new THREE.Quaternion();
  const _re = new THREE.Euler();
  const _rv = new THREE.Vector3();
  const _rs = new THREE.Vector3();
  const record = (
    pieceIdx: number, cloudIdx: number,
    px: number, py: number, pz: number,
    rotY: number, sx: number, sy: number, sz: number,
  ) => {
    const m = new THREE.Matrix4();
    _re.set(0, rotY, 0);
    _rq.setFromEuler(_re);
    m.compose(_rv.set(px, py, pz), _rq, _rs.set(sx, sy, sz));
    specs.push({
      piece: pieceIdx, m, cloud: cloudIdx,
      cx: px, cy: py, cz: pz,
      rad: pieceRadius[pieceIdx] * Math.max(sx, sy, sz),
    });
  };

  const rebuildBuckets = () => {
    for (const bm of bucketMeshes) {
      if (!bm) continue;
      group.remove(bm);
      bm.dispose();
    }
    bucketMeshes = [];
    const byPiece: number[][] = pieces.map(() => []);
    for (let i = 0; i < specs.length; i++) byPiece[specs[i].piece].push(i);
    for (let p = 0; p < pieces.length; p++) {
      const list = byPiece[p];
      if (!list.length) { bucketMeshes.push(null); continue; }
      const im = new THREE.InstancedMesh(pieces[p].geometry, material, list.length);
      im.name = "voxelCloudBucket" + p;
      // We cull per-instance on the CPU each frame (the whole-population sphere
      // would never leave the frustum anyway — the sky surrounds the camera).
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const bob = new Float32Array(list.length * 2);
      for (let i = 0; i < list.length; i++) {
        const cm = cloudsMeta[specs[list[i]].cloud];
        bob[i * 2] = cm.bobPhase;
        bob[i * 2 + 1] = cm.bobRate;
      }
      const bobAttr = new THREE.InstancedBufferAttribute(bob, 2);
      bobAttr.setUsage(THREE.DynamicDrawUsage);
      im.geometry.setAttribute("aCloudBob", bobAttr);
      im.count = 0; // populated by update()
      (im as any).__specIdx = list;
      group.add(im);
      bucketMeshes.push(im);
    }
  };

  const scatter = () => {
    if (!pieces.length) return;
    // Clear existing population (buckets rebuilt below).
    specs.length = 0;
    cloudsMeta.length = 0;

    const rnd = mulberry32(0xc10d5); // stable seed
    const innerR = span * state.inner;
    const outerR = span * state.outer;
    const topY = span * state.top;

    for (let i = 0; i < state.count; i++) {
      // FREE SKY SCATTER (not a ring): the first heroCount clouds are BIG dominant
      // towers spread to different bearings (so one always faces the player); the
      // rest scatter over a disc of sky (area-uniform radius, random bearing) at
      // varied heights — a natural scattered sky, not a uniform ring wall.
      const isHero = i < state.heroCount;
      const span34 = span * 0.34;
      const angle = isHero
        ? (i / Math.max(1, state.heroCount)) * Math.PI * 2 + (rnd() - 0.5) * 0.5
        : rnd() * Math.PI * 2;
      const radius = isHero
        ? innerR + (0.72 + rnd() * 0.33) * Math.max(0.001, outerR - innerR) // FAR — huge masses on the horizon, gaps of open sky between
        : innerR + Math.sqrt(rnd()) * Math.max(0.001, outerR - innerR); // disc, not a ring
      // height band above the horizon; heroes sit low so the broad tower rises up
      // With the cloud SEA below, the sky band sits ABOVE it: non-heroes float
      // high (open air between sea and sky, like the reference), heroes keep a
      // low base so they rise OUT of the cloud ocean like the floating palaces.
      let baseY = isHero ? topY * (0.02 + rnd() * 0.08) : topY * (0.16 + rnd() * 0.45);
      // Hero clouds are much bigger so they dominate; heroes VARY in size (some
      // very big, some big — not all identical), others slightly larger so some
      // neighbours overlap.
      const heroVar = 0.82 + rnd() * 0.7; // 0.82–1.52× → mix of big & very-big heroes
      const footprint = (isHero ? state.heroSize * heroVar : 0.95 + rnd() * 1.15) * state.sizeScale * span34;
      // Heroes are always big billowing TOWERS; others mix tower/fine/coarse.
      const roll = isHero ? -1 : rnd();

      const cloudIdx = cloudsMeta.length;
      // sub-piece transforms are recorded RELATIVE to the cloud origin, then
      // offset by it — identical math to the old parent-Group hierarchy.
      const pending: { pieceIdx: number; px: number; py: number; pz: number; rotY: number; sx: number; sy: number; sz: number }[] = [];

      if (roll < state.towerFrac) {
        // TOWER (cumulus congestus, the Ghibli day reference): a BROAD billowing
        // cauliflower MASS — roughly as wide as it is tall — not a thin totem.
        // Each level is a CLUSTER of overlapping pieces filling the level's width
        // (a wide billowing band), stacked with heavy vertical overlap so the body
        // reads as one continuous dense mass. Profile: spreading base → slight
        // waist → bulging round head → domed crown.
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
          // Fitted to the CORRECTED reference silhouette (incl. its shadowed left
          // lobe): a BROAD cumulus, wider than tall — widest at the base, a full
          // body, a slight waist, then a broad rounded head that barely tapers
          // until the very crown. NOT a narrow spire.
          if (f < 0.18) prof = 1.45; // broad flat base — the widest part
          else if (f < 0.42) prof = 1.45 - (f - 0.18) * 0.6; // full wide body (~1.45→1.31)
          else if (f < 0.6) prof = 1.31 - (f - 0.42) * 0.9; // gentle waist (~1.31→1.15)
          else if (f < 0.85) prof = 1.15 + (f - 0.6) * 0.35; // head RE-WIDENS — broad bulging cauliflower (~1.15→1.24)
          else prof = 1.24 - (f - 0.85) * 4.2; // crown domes down (~1.24→0.61)
          prof = Math.max(0.5, prof);
          const lw = footprint * state.towerWidth * prof;
          // fill the level's WIDTH with a DENSE cluster of big rounded lobes —
          // more pieces where it's wider, bigger scale + tighter packing so the
          // body reads as one solid rounded mass (not scattered cubes).
          const isBase = j === 0;
          const isCrown = j === levels - 1;
          // base + crown get extra lobes spread WIDER (no vertical bias) so the
          // foot is a broad grounded mass and the head reads as a broad round
          // dome — both matching the reference (widest at ground, broad head).
          const nSub = Math.max(4, Math.round(4 + prof * 3.2)) + (isBase || isCrown ? 3 : 0);
          const prMul = isBase ? 0.66 : isCrown ? 0.6 : 0.4;
          for (let p = 0; p < nSub; p++) {
            const pieceIdx = Math.floor(rnd() * pieces.length);
            const ss = lw * (0.6 + rnd() * 0.4); // bigger rounder lobes
            // flatten crown lobes so tall GLB pieces dome over instead of spiking
            const sy = isCrown ? ss * 0.62 : ss;
            const rotY = rnd() * Math.PI * 2;
            const pa = rnd() * Math.PI * 2;
            const pr = lw * prMul * Math.sqrt(rnd());
            const yJit = (rnd() - 0.5) * lw * 0.14;
            pending.push({
              pieceIdx,
              px: Math.cos(pa) * pr + leanX * f,
              py: y + yJit,
              pz: Math.sin(pa) * pr + leanZ * f,
              rotY, sx: ss, sy, sz: ss,
            });
          }
          // step is mostly FIXED (not proportional to the wide head) so no vertical
          // gap opens beneath the bulge — keeps the body one continuous mass.
          y += footprint * state.towerWidth * state.towerStep * (0.34 + 0.42 * prof);
        }
        // non-hero towers float above the sea band; heroes keep their
        // sea-level base (set above) so the whole broad tower rises out of it.
        if (!isHero) baseY = topY * (0.08 + rnd() * 0.12);
      } else if (rnd() < state.fineFrac) {
        // FINE: cluster of small pieces → same footprint, finer voxels. Each
        // sub-piece is fineScale× the footprint, so its voxels read ~2× smaller;
        // packing 3–5 of them overlapping rebuilds a cloud of similar size out
        // of finer cubes. Slight per-sub-piece scale jitter keeps it organic.
        const k = 3 + Math.floor(rnd() * 3); // 3..5 sub-pieces
        const spread = footprint * state.fineSpread;
        for (let j = 0; j < k; j++) {
          const pieceIdx = Math.floor(rnd() * pieces.length);
          const ss = footprint * state.fineScale * (0.72 + rnd() * 0.62);
          const rotY = rnd() * Math.PI * 2;
          const oa = rnd() * Math.PI * 2;
          const orr = spread * Math.sqrt(rnd()); // area-uniform → packed, not ring
          pending.push({
            pieceIdx,
            px: Math.cos(oa) * orr,
            py: (rnd() - 0.5) * spread * 0.9,
            pz: Math.sin(oa) * orr,
            rotY, sx: ss, sy: ss, sz: ss,
          });
        }
      } else {
        // COARSE: one piece at full footprint (the current chunky look).
        pending.push({
          pieceIdx: i % pieces.length,
          px: 0, py: 0, pz: 0,
          rotY: rnd() * Math.PI * 2,
          sx: footprint, sy: footprint, sz: footprint,
        });
      }
      const ox = Math.cos(angle) * radius, oy = baseY, oz = Math.sin(angle) * radius;
      for (const s of pending)
        record(s.pieceIdx, cloudIdx, s.px + ox, s.py + oy, s.pz + oz, s.rotY, s.sx, s.sy, s.sz);
      cloudsMeta.push({
        bobPhase: rnd() * Math.PI * 2,
        bobRate: 0.04 + rnd() * 0.07, // much slower vertical bob
      });
    }

    // ---- CLOUD SEA: flattened rolling cloud ocean below the island ----
    const seaInnerR = span * state.seaInner;
    const seaOuterR = span * state.seaOuter;
    const seaY = span * state.seaLevel;
    // Base disc: a continuous soft cloud floor under the voxel swells so the
    // sea reads as an UNBROKEN ocean (the swells alone can't cover the disc
    // without thousands of meshes). Inner disc solid; outer ring fades its
    // vertex colour toward the horizon haze so the far edge dissolves. Lit by
    // the scene's real sun/hemi (plain Lambert — doctrine-clean).
    for (const d of seaDiscs) group.remove(d);
    seaDiscs.length = 0;
    if (state.seaCount > 0) {
      const discMat = seaDiscMat;
      const midR = seaOuterR * 0.55;
      const inner = new THREE.Mesh(new THREE.CircleGeometry(midR, 72), discMat);
      const innerCols: number[] = [];
      const nIn = inner.geometry.getAttribute("position").count;
      for (let i = 0; i < nIn; i++) innerCols.push(0.92, 0.94, 0.98);
      inner.geometry.setAttribute("color", new THREE.Float32BufferAttribute(innerCols, 3));
      const ringGeo = new THREE.RingGeometry(midR, seaOuterR, 72, 8);
      const rPos = ringGeo.getAttribute("position");
      const ringCols: number[] = [];
      for (let i = 0; i < rPos.count; i++) {
        const rr = Math.hypot(rPos.getX(i), rPos.getY(i));
        const f = Math.min(1, Math.max(0, (rr - midR) / Math.max(1e-3, seaOuterR - midR)));
        const e = f * f;
        ringCols.push(0.92 + (0.70 - 0.92) * e, 0.94 + (0.81 - 0.94) * e, 0.98 + (0.93 - 0.98) * e);
      }
      ringGeo.setAttribute("color", new THREE.Float32BufferAttribute(ringCols, 3));
      const ring = new THREE.Mesh(ringGeo, discMat);
      for (const m of [inner, ring]) {
        m.rotation.x = -Math.PI / 2;
        m.position.y = seaY - span * 0.05;
        m.castShadow = false;
        m.receiveShadow = false;
        group.add(m);
        seaDiscs.push(m);
      }
    }
    for (let i = 0; i < state.seaCount; i++) {
      const angle = rnd() * Math.PI * 2;
      const radius = seaInnerR + Math.sqrt(rnd()) * Math.max(0.001, seaOuterR - seaInnerR);
      const rFrac = (radius - seaInnerR) / Math.max(0.001, seaOuterR - seaInnerR);
      const footprint = span * 0.34 * (1.75 + rnd() * 0.95) * (1 + rFrac * 1.3) * state.sizeScale;
      const pieceIdx = Math.floor(rnd() * pieces.length);
      const syFlat = footprint * state.seaFlat * (0.8 + rnd() * 0.5);
      const rotY = rnd() * Math.PI * 2;
      const baseY = seaY + (rnd() - 0.5) * span * 0.06;
      const cloudIdx = cloudsMeta.length;
      record(
        pieceIdx, cloudIdx,
        Math.cos(angle) * radius, baseY, Math.sin(angle) * radius,
        rotY, footprint, syFlat, footprint,
      );
      cloudsMeta.push({
        bobPhase: rnd() * Math.PI * 2,
        bobRate: 0.02 + rnd() * 0.04, // the sea heaves even slower than the sky
      });
    }
    // aerial-haze band tracks the sea's reach (far clouds dissolve to horizon)
    uHaze.value.set(seaOuterR * 0.5, seaOuterR * 0.95);
    rebuildBuckets();
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
          // Conservative cull radius: sphere radius + center offset, so the
          // instance-translation-centered sphere test can never over-cull.
          geo.computeBoundingSphere();
          pieceRadius.push(geo.boundingSphere.radius + geo.boundingSphere.center.length());
          pieces.push(m);
        }
      });
      if (pieces.length) scatter();
      else console.warn("[voxel-clouds] GLB had no meshes:", glbUrl);
    },
    undefined,
    (err: any) => console.error("[voxel-clouds] failed to load", glbUrl, err),
  );

  // Per-frame scratch (no steady-state allocation beyond the visible lists).
  const _frustum = new THREE.Frustum();
  const _projView = new THREE.Matrix4();
  const _wpos = new THREE.Vector3();
  const _sphere = new THREE.Sphere();
  const _lastCullPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  const _lastCullQuat = new THREE.Quaternion();
  let _lastCullAngle = Infinity;
  let _lastCullMs = -Infinity;

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
    uSeaTime.value = t;
    uCloudMotion.value.set(t, state.bob);
    group.rotation.y = t * state.driftSpeed;
    group.updateMatrixWorld(true);
    const angle = group.rotation.y;
    const nowMs = t * 1000;
    const posMoved = camera.position.distanceToSquared(_lastCullPos) > Math.pow(Math.max(0.02, span * 0.005), 2);
    const viewMoved = 1 - Math.abs(camera.quaternion.dot(_lastCullQuat)) > 0.000002;
    const bankMoved = Math.abs(angle - _lastCullAngle) * span * state.outer > Math.max(0.02, span * 0.005);
    if (!posMoved && !viewMoved && !bankMoved && nowMs - _lastCullMs < 750) return;
    _lastCullPos.copy(camera.position);
    _lastCullQuat.copy(camera.quaternion);
    _lastCullAngle = angle;
    _lastCullMs = nowMs;
    // CPU frustum culling + back-to-front instance ordering. Replaces what
    // three.js did per-object (~1,100 matrixWorld updates + cull tests + a
    // 1,100-entry transparent sort + 1,100 draws) with ≤9 instanced draws.
    camera.updateMatrixWorld();
    _projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);
    const gm = group.matrixWorld;
    const camX = camera.position.x, camY = camera.position.y, camZ = camera.position.z;
    for (const im of bucketMeshes) {
      if (!im) continue;
      const idxs = (im as any).__specIdx as number[];
      const vis: { i: number; d: number }[] = [];
      for (let k = 0; k < idxs.length; k++) {
        const s = specs[idxs[k]];
        const cm = cloudsMeta[s.cloud];
        const by = Math.sin(t * cm.bobRate + cm.bobPhase) * state.bob;
        _wpos.set(s.cx, s.cy + by, s.cz).applyMatrix4(gm);
        _sphere.center.copy(_wpos);
        _sphere.radius = s.rad + Math.abs(state.bob);
        if (!_frustum.intersectsSphere(_sphere)) continue;
        const dx = _wpos.x - camX, dy = _wpos.y - camY, dz = _wpos.z - camZ;
        vis.push({ i: idxs[k], d: dx * dx + dy * dy + dz * dz });
      }
      vis.sort((a, b) => b.d - a.d); // far → near (back-to-front blending)
      const arr = im.instanceMatrix.array as Float32Array;
      const bobAttr = im.geometry.getAttribute("aCloudBob");
      const bobArr = bobAttr.array as Float32Array;
      for (let w = 0; w < vis.length; w++) {
        const s = specs[vis[w].i];
        arr.set(s.m.elements, w * 16);
        const cm = cloudsMeta[s.cloud];
        bobArr[w * 2] = cm.bobPhase;
        bobArr[w * 2 + 1] = cm.bobRate;
      }
      im.count = vis.length;
      im.instanceMatrix.needsUpdate = true;
      bobAttr.needsUpdate = true;
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
      (next.towerLean !== undefined && next.towerLean !== state.towerLean) ||
      (next.heroCount !== undefined && next.heroCount !== state.heroCount) ||
      (next.heroSize !== undefined && next.heroSize !== state.heroSize) ||
      (next.seaCount !== undefined && next.seaCount !== state.seaCount) ||
      (next.seaLevel !== undefined && next.seaLevel !== state.seaLevel) ||
      (next.seaInner !== undefined && next.seaInner !== state.seaInner) ||
      (next.seaOuter !== undefined && next.seaOuter !== state.seaOuter) ||
      (next.seaFlat !== undefined && next.seaFlat !== state.seaFlat);
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
      for (const bm of bucketMeshes) if (bm) bm.dispose();
      scene.remove(group);
      material.dispose();
    },
  };
}
