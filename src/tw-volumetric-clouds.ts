type CloudRingOptions = {
  THREE: any;
  scene: any;
  camera: any;
  span: number;
  center?: any;
  enabled?: boolean;
};

type CloudUpdate = {
  elapsedSeconds: number;
  keyDirection: any;
  keyColor: any;
  skyColor: any;
  keyIntensity: number;
};

const vertexShader = `
  varying vec3 vWorldPosition;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = `
  precision highp float;
  varying vec3 vWorldPosition;
  uniform vec3 uCameraPosition;
  uniform vec3 uCenter;
  uniform vec3 uBounds;
  uniform vec3 uKeyDirection;
  uniform vec3 uKeyColor;
  uniform vec3 uSkyColor;
  uniform float uKeyIntensity;
  uniform float uTime;
  uniform float uCoverage;
  uniform float uDensity;
  uniform float uInnerRadius;
  uniform float uOuterRadius;
  uniform float uBaseHeight;
  uniform float uTopHeight;
  uniform float uWobble;
  uniform float uTower;
  uniform float uIntruder;
  uniform int uDebug;

  const int PRIMARY_STEPS = 100;
  const int LIGHT_STEPS = 8;
  const float PI = 3.141592653589793;

  // --- Cauliflower (packed-sphere METABALL) tuning — the mesh-first shape. ---
  // The cloud silhouette IS the isosurface of big packed spheres: between-lobe
  // valleys fall below ISO and carve to sky, so the outline bulges per-lobe.
  #define BASE_FREQ 0.072    // big cauliflower head size (lower = bigger heads)
  #define ISO 0.25           // metaball isosurface level (lower = fuller mass)
  #define ISO_W 0.22         // isosurface softness (wider = less speckle)

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float x00 = mix(n000, n100, f.x);
    float x10 = mix(n010, n110, f.x);
    float x01 = mix(n001, n101, f.x);
    float x11 = mix(n011, n111, f.x);
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
  }

  vec3 hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }

  // Worley / cellular F1: distance to the nearest jittered feature point in a 3D
  // grid. (1 - F1) is a rounded lobe centered on each point; unioned across the
  // grid it is a field of PACKED SPHERES — the structural cauliflower we build
  // the cloud FROM ("start from the mesh"), not surface noise painted on later.
  float worleyF1(vec3 p) {
    vec3 id = floor(p);
    vec3 fp = fract(p);
    float best = 9.0;
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 o = hash33(id + g);
      vec3 r = g + o - fp;
      best = min(best, dot(r, r));
    }
    return sqrt(best);
  }

  // Fractal packed-sphere lobes: a big lobe, medium sub-lobes riding on it, then
  // fine bumps — nested inverted-Worley = the broccoli/cauliflower stack of the
  // reference. Coarse-only when !detail (cheap light march).
  float lobeField(vec3 wp, bool detail) {
    float big = clamp(1.0 - worleyF1(wp), 0.0, 1.0);
    if (!detail) return big;                          // coarse-only (light march)
    float med = clamp(1.0 - worleyF1(wp * 2.1 + 31.7), 0.0, 1.0);
    float fin = clamp(1.0 - worleyF1(wp * 4.6 + 63.1), 0.0, 1.0);
    return clamp(big * 0.64 + med * 0.30 + fin * 0.06, 0.0, 1.0);  // fractal lobes
  }

  float weather(vec2 p) {
    float broad = valueNoise(vec3(p * 0.42, 1.7));
    float cells = valueNoise(vec3(p * 0.93 + vec2(7.1, -2.8), 8.4));
    return broad * 0.72 + cells * 0.28;
  }

  float densityAt(vec3 worldPosition, bool detail) {
    vec3 p = worldPosition - uCenter;
    float radius = length(p.xz);
    vec2 dir = radius > 0.001 ? p.xz / radius : vec2(1.0, 0.0);
    vec2 wind = vec2(uTime * 0.0075, uTime * 0.0032);

    // --- Irregular ring boundary: break the perfect circle (bays/headlands). ---
    float lobeA = valueNoise(vec3(dir * 1.6, uTime * 0.010 + 4.0));
    float lobeB = valueNoise(vec3(dir * 3.7 + 9.0, uTime * 0.007));
    float wob = ((lobeA - 0.5) * 0.70 + (lobeB - 0.5) * 0.30) * uWobble;
    float innerR = uInnerRadius * (1.0 + wob);
    float outerR = uOuterRadius * (1.0 + wob * 0.60);
    float ring = smoothstep(innerR, innerR * 1.18, radius)
      * (1.0 - smoothstep(outerR * 0.78, outerR, radius));

    // --- Sparse intruder clouds drifting in over the island center. ---
    float intrField = valueNoise(vec3(p.xz / uOuterRadius * 0.85 - vec2(uTime * 0.012, uTime * 0.006), 21.0));
    float intruder = smoothstep(0.70, 0.90, intrField) * uIntruder
      * (1.0 - smoothstep(uOuterRadius * 0.76, uOuterRadius, radius));
    float ringMask = max(ring, intruder);
    if (ringMask <= 0.0) return 0.0;

    // --- Large-scale coverage: which stretches of the ring host a cloud MASS,
    // with blue-sky gaps between separate masses. ---
    float cover = weather(p.xz / uOuterRadius * 1.7 + wind);
    float coverMask = smoothstep(1.0 - uCoverage - 0.16, 1.0 - uCoverage + 0.16, cover);
    if (coverMask <= 0.001) return 0.0;

    // --- Vertical band: flat cumulus base + generous ceiling. The TOP surface
    // is defined by the metaball lobes (below), NOT a smooth dome, so the crown
    // bulges into separate rounded towers. ---
    float baseY = uBaseHeight;
    float topY = uTopHeight;
    float band = max(topY - baseY, 0.001);
    float h = (p.y - baseY) / band;                  // 0 base → 1 ceiling
    if (h <= -0.10 || h >= 1.05) return 0.0;
    // Base undulation so the cumulus bottom is a soft rolling edge, not a ruler
    // line. Low-freq noise over XZ nudges the effective height a little.
    float baseWobble = (valueNoise(vec3(p.xz * 0.055, 7.3)) - 0.5) * 0.16;
    float hb = h + baseWobble;
    // Flat-ish cumulus base, and a height bias that thins the mass upward so
    // lobes MERGE at the base (one connected cloud) but SEPARATE into towers.
    float baseGate = smoothstep(0.0, 0.07, hb);
    float heightBias = 1.0 - smoothstep(0.55, 1.05, hb);

    // XZ placement: which stretches of the ring host a cloud mass (sky gaps).
    float placement = ringMask * coverMask;
    if (placement <= 0.001) return 0.0;

    // === CAULIFLOWER: ROUNDED MASS, LOBES ERODED INTO THE EDGES (the mesh) ===
    // Nubis-style build so the WHOLE body is cauliflower, not just the crown:
    //  1) a smooth rounded MASS (coarse packed spheres → distinct billowing piles),
    //  2) fine lobes SUBTRACTED from the mass's EDGES only — the solid core stays
    //     full while the silhouette bulges per-lobe at EVERY height. This replaces
    //     the old max(lobes, solidBase), whose flat 0.64 floor plateaued the lower
    //     body into a smooth wall (lobes only won at the peaks = flat body).
    // Churn: the lobe field scrolls through worley-space so lobes grow/shrink/roll
    // (cumulus "boil"), plus a slow domain-warp so masses evolve, not just slide.
    float churn = uTime * 0.0042;
    vec3 warp = vec3(valueNoise(worldPosition * BASE_FREQ * 0.5 + uTime * 0.003)) * 0.35;
    vec3 wp = worldPosition * BASE_FREQ + vec3(wind.x * 2.4, -churn, wind.y * 2.4) + warp;

    // Overall rounded mass: coarse packed-sphere field → several big billowing
    // piles, tapered UP so the crown separates into towers, full & merged low.
    float coarse = clamp(1.0 - worleyF1(wp), 0.0, 1.0);
    float heightProfile = baseGate * (0.62 + 0.55 * heightBias);
    float mass = coarse * placement * heightProfile;

    // Coverage remap opens blue-sky gaps between distinct masses.
    float cov = 1.0 - uCoverage;

    // Carve rounded cauliflower into the EDGES: fine lobes subtract from the mass
    // only in the boundary BAND (near the coverage threshold), nothing in the
    // solid core → bumpy rounded surface top-to-bottom. Done BEFORE the single
    // smoothstep so the isosurface stays smooth (no near-threshold grain flicker).
    float eroded = mass;
    if (detail) {
      float med = clamp(1.0 - worleyF1(wp * 2.15 + 31.7), 0.0, 1.0);
      float fin = clamp(1.0 - worleyF1(wp * 3.9 + 63.1), 0.0, 1.0);
      float lobeErode = med * 0.70 + fin * 0.30;
      // FUZZ: high-freq value-noise fbm breaks the smooth lobe edges into small
      // wisps so the silhouette reads soft/fuzzy, not clean-rounded. Value noise
      // (not worley) stays smooth per-step → wispier edge without salt-pepper grain.
      float fuzz = valueNoise(wp * 6.3 + 12.4) * 0.62 + valueNoise(wp * 11.7 + 47.2) * 0.38;
      // Boundary band: 1 near the surface, 0 deep in the core and out in sky.
      float band = smoothstep(cov - 0.14, cov + 0.02, mass)
        * (1.0 - smoothstep(cov + 0.14, cov + 0.42, mass));
      eroded = mass - (lobeErode * 0.22 + (fuzz - 0.35) * 0.20) * band;
    }
    float d = smoothstep(cov, cov + 0.40, eroded);
    return clamp(d * uDensity, 0.0, 1.0);
  }

  vec2 rayBox(vec3 ro, vec3 rd, vec3 boxMin, vec3 boxMax) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (boxMin - ro) * inv;
    vec3 t1 = (boxMax - ro) * inv;
    vec3 lo = min(t0, t1);
    vec3 hi = max(t0, t1);
    float nearT = max(max(lo.x, lo.y), lo.z);
    float farT = min(min(hi.x, hi.y), hi.z);
    return vec2(nearT, farT);
  }

  float phaseHG(float cosine, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosine, 0.001), 1.5));
  }

  float lightTransmittance(vec3 p, float stepLength) {
    float opticalDepth = 0.0;
    float stride = stepLength * 1.3;
    vec3 samplePosition = p;
    for (int i = 0; i < LIGHT_STEPS; i++) {
      samplePosition += uKeyDirection * stride;
      opticalDepth += densityAt(samplePosition, false) * stride;
      stride *= 1.7;
    }
    return exp(-opticalDepth * 0.88);
  }

  void main() {
    vec3 ro = uCameraPosition;
    vec3 rd = normalize(vWorldPosition - ro);
    vec2 hit = rayBox(ro, rd, uCenter - uBounds, uCenter + uBounds);
    float nearT = max(hit.x, 0.0);
    float farT = hit.y;
    if (farT <= nearT) discard;

    float segment = farT - nearT;
    float stepLength = segment / float(PRIMARY_STEPS);
    float jitter = hash31(vec3(gl_FragCoord.xy, mod(uTime * 17.0, 97.0)));
    float t = nearT + jitter * stepLength * 0.35;
    float transmittance = 1.0;
    vec3 radiance = vec3(0.0);
    float accumulatedDensity = 0.0;
    float phase = mix(phaseHG(dot(rd, uKeyDirection), 0.68), phaseHG(dot(rd, uKeyDirection), -0.18), 0.42);

    for (int i = 0; i < PRIMARY_STEPS; i++) {
      if (t >= farT || transmittance < 0.025) break;
      vec3 p = ro + rd * t;
      float density = densityAt(p, true);
      if (density > 0.002) {
        float keyT = lightTransmittance(p, stepLength);
        float powder = 1.0 - exp(-density * 5.5);
        // Sky-color fill so shadowed sides read the ambient sky (warm at dusk,
        // blue-ish shaded bases at noon) instead of going near-black. Kept low
        // so lit lobes stay bright white, not washed gray.
        // Desaturate the sky-fill toward white so shaded lobes read high-key
        // white (reference), keeping only a soft blue tint — not a blue body.
        vec3 fill = mix(uSkyColor, vec3(1.0), 0.42);
        vec3 ambient = fill * (0.34 + 0.34 * powder);
        vec3 direct = uKeyColor * uKeyIntensity * keyT * (0.95 + phase * 4.8) * (0.62 + 0.38 * powder);
        float extinction = density * 0.5;
        float stepT = exp(-extinction * stepLength);
        vec3 source = ambient + direct;
        radiance += transmittance * source * (1.0 - stepT);
        transmittance *= stepT;
        accumulatedDensity += density * stepLength;
      }
      t += stepLength;
    }

    float rawAlpha = clamp(1.0 - transmittance, 0.0, 0.97);
    vec3 color = radiance / max(rawAlpha, 0.02);
    // Sharpen coverage: push the thin hazy fringe toward transparent and let the
    // body go solid → crisp defined cumulus edges, no foggy skirt or box halo.
    float alpha = smoothstep(0.035, 0.60, rawAlpha) * 0.97;
    if (alpha < 0.02) discard;
    if (uDebug == 1) color = vec3(clamp(accumulatedDensity * 0.08, 0.0, 1.0));
    if (uDebug == 2) color = vec3(transmittance);
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createVolumetricCloudRing(options: CloudRingOptions) {
  const { THREE, scene, camera } = options;
  const span = Math.max(12, options.span);
  const center = options.center?.clone?.() ?? new THREE.Vector3();
  const innerRadius = span * 0.72;
  const outerRadius = span * 1.55;
  // Cloud BAND (where density lives). Flat base near island level, very tall
  // ceiling so cumulus can build dramatic vertical towers (not a flat layer).
  const baseHeight = -span * 0.12;
  const topHeight = Math.max(span * 2.05, baseHeight + 18);
  const bandHalf = (topHeight - baseHeight) * 0.5;
  // The marching BOX is wider AND taller than the band (×1.18 margin on every
  // axis) so wobbled edges and tall towers round off in free space instead of
  // clipping flat against the volume wall (which showed as hard straight cuts).
  const bounds = new THREE.Vector3(outerRadius * 1.18, bandHalf * 1.18, outerRadius * 1.18);
  const volumeCenter = center.clone();
  volumeCenter.y += (baseHeight + topHeight) * 0.5;

  const uniforms = {
    uCameraPosition: { value: new THREE.Vector3() },
    uCenter: { value: volumeCenter },
    uBounds: { value: bounds },
    uKeyDirection: { value: new THREE.Vector3(0.4, 0.8, 0.2).normalize() },
    uKeyColor: { value: new THREE.Color(0xffffff) },
    uSkyColor: { value: new THREE.Color(0x87b5e5) },
    uKeyIntensity: { value: 1 },
    uTime: { value: 0 },
    uCoverage: { value: 0.70 },
    uDensity: { value: 2.55 },
    uInnerRadius: { value: innerRadius },
    uOuterRadius: { value: outerRadius },
    uBaseHeight: { value: -bandHalf },
    uTopHeight: { value: bandHalf },
    uWobble: { value: 0.38 },
    uTower: { value: 0.85 },
    uIntruder: { value: 0.7 },
    uDebug: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    name: "TinyWorldVolumetricCloudRing",
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: true,
    fog: false,
  });
  const geometry = new THREE.BoxGeometry(bounds.x * 2, bounds.y * 2, bounds.z * 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "TinyWorldVolumetricCloudRing";
  mesh.position.copy(volumeCenter);
  mesh.frustumCulled = false;
  mesh.renderOrder = 850;
  mesh.visible = options.enabled !== false;
  scene.add(mesh);

  const state = {
    enabled: mesh.visible,
    coverage: uniforms.uCoverage.value,
    density: uniforms.uDensity.value,
    wobble: uniforms.uWobble.value,
    tower: uniforms.uTower.value,
    intruder: uniforms.uIntruder.value,
    debug: 0,
  };

  const applyState = () => {
    mesh.visible = state.enabled;
    uniforms.uCoverage.value = Math.max(0, Math.min(1, state.coverage));
    uniforms.uDensity.value = Math.max(0.05, Math.min(2, state.density));
    uniforms.uWobble.value = Math.max(0, Math.min(1, state.wobble));
    uniforms.uTower.value = Math.max(0, Math.min(1, state.tower));
    uniforms.uIntruder.value = Math.max(0, Math.min(1.5, state.intruder));
    uniforms.uDebug.value = Math.max(0, Math.min(2, Math.round(state.debug)));
  };

  const update = (input: CloudUpdate) => {
    if (!state.enabled) return;
    uniforms.uTime.value = input.elapsedSeconds;
    uniforms.uCameraPosition.value.copy(camera.position);
    uniforms.uKeyDirection.value.copy(input.keyDirection).normalize();
    uniforms.uKeyColor.value.copy(input.keyColor);
    uniforms.uSkyColor.value.copy(input.skyColor);
    uniforms.uKeyIntensity.value = Math.max(0.08, Math.min(2.5, input.keyIntensity));
  };

  const configure = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    applyState();
    return { ...state };
  };

  applyState();
  return {
    mesh,
    material,
    state,
    update,
    configure,
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
