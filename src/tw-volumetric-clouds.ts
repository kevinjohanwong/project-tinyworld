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

  const int PRIMARY_STEPS = 56;
  const int LIGHT_STEPS = 8;
  const float PI = 3.141592653589793;

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

  float baseShape(vec3 p) {
    float a = valueNoise(p);
    float b = valueNoise(p * 2.03 + vec3(11.7, 3.1, -8.2));
    float c = valueNoise(p * 4.07 + vec3(-4.3, 8.8, 2.9));
    return a * 0.625 + b * 0.25 + c * 0.125;
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
    vec2 wind = vec2(uTime * 0.004, uTime * 0.0018);

    // --- Irregular ring boundary: break the perfect circle ---
    // Sample noise around the ring (a function of DIRECTION, so it is periodic
    // around the circle) and drift it slowly. Inner/outer edges undulate into
    // bays and headlands instead of reading as a clean annulus.
    float lobeA = valueNoise(vec3(dir * 1.6, uTime * 0.010 + 4.0));
    float lobeB = valueNoise(vec3(dir * 3.7 + 9.0, uTime * 0.007));
    float wob = ((lobeA - 0.5) * 0.70 + (lobeB - 0.5) * 0.30) * uWobble;
    float innerR = uInnerRadius * (1.0 + wob);
    float outerR = uOuterRadius * (1.0 + wob * 0.60);
    float ring = smoothstep(innerR, innerR * 1.18, radius)
      * (1.0 - smoothstep(outerR * 0.78, outerR, radius));

    // --- Intruder clouds: a sparse, slow-drifting field permitted anywhere
    // inside the ring (incl. over the island center), gated high so only ~1-2
    // clumps exist at once — reads as a cloud that wandered in over the land.
    float intrField = valueNoise(vec3(p.xz / uOuterRadius * 0.85 - vec2(uTime * 0.012, uTime * 0.006), 21.0));
    float intruder = smoothstep(0.70, 0.90, intrField) * uIntruder
      * (1.0 - smoothstep(uOuterRadius * 0.76, uOuterRadius, radius));
    float ringMask = max(ring, intruder);
    if (ringMask <= 0.0) return 0.0;

    // --- Discrete cumulus cells with blue-sky gaps (not a continuous sheet) ---
    // Product of two octaves makes rounder, isolated blobs; threshold high so
    // distinct puffs separate with real sky between them.
    float cLarge = weather(p.xz / uOuterRadius * 2.0 + wind);
    float cSmall = valueNoise(vec3(p.xz / uOuterRadius * 3.6 + wind * 1.5, 5.0));
    float cellField = cLarge * (0.65 + 0.35 * cSmall);
    float cellThresh = 1.0 - uCoverage;
    float cell = smoothstep(cellThresh - 0.02, cellThresh + 0.22, cellField);
    if (cell <= 0.001) return 0.0;

    // --- Per-cell tower height: TALL by default, a few short — fill the ceiling.
    float towerField = valueNoise(vec3(p.xz / uOuterRadius * 2.0 + wind * 2.4, 2.2));
    float heightFrac = mix(0.55, 1.0, pow(mix(0.5, towerField, uTower), 1.3)) * mix(0.60, 1.0, cell);
    float baseY = uBaseHeight;                       // flat cumulus base
    float topY = uBaseHeight + (uTopHeight - uBaseHeight) * heightFrac;
    float band = max(topY - baseY, 0.001);
    float h = (p.y - baseY) / band;                  // 0 at base → 1 at tower top
    if (h <= 0.0 || h >= 1.0) return 0.0;

    // --- Dome silhouette: the cloud narrows toward the top so a tower reads as
    // a rounded billowing mass, not a flat slab — but gently, so the tower still
    // FILLS its height instead of pinching off low.
    // Full body low-down, dome only near the crown → bulging cumulus, not a
    // triangular peak.
    float need = mix(cellThresh - 0.06, cellThresh + 0.30, smoothstep(0.35, 1.0, h));
    float column = smoothstep(need - 0.05, need + 0.22, cellField);
    if (column <= 0.001) return 0.0;

    // Vertical density profile: sharp flat cumulus base, full body, soft top.
    float vertical = smoothstep(0.0, 0.025, h) * (1.0 - smoothstep(0.88, 1.0, h));

    // Cauliflower surface: BILLOWED noise (1-|2n-1|) makes rounded ridged lobes
    // at several scales, so the cloud stacks into puffy cauliflower bumps that
    // the self-shadow pass reveals as real cumulus form (not a smooth meringue).
    vec3 advected = p / uOuterRadius * vec3(3.2, 3.2, 3.2)
      + vec3(wind.x * 1.4, -uTime * 0.0012, wind.y * 1.4);
    float b1 = 1.0 - abs(valueNoise(advected * 2.1) * 2.0 - 1.0);
    float b2 = 1.0 - abs(valueNoise(advected * 4.6 + vec3(3.1, 1.7, 8.2)) * 2.0 - 1.0);
    float b3 = 1.0 - abs(valueNoise(advected * 10.0 + vec3(-4.3, 8.8, 2.9)) * 2.0 - 1.0);
    float caul = b1 * 0.55 + b2 * 0.30 + b3 * 0.15;
    float d = column * vertical * ringMask;
    // Cauliflower dominates the silhouette so SIDES bulge with lobes too (not
    // just the crown); column just sets the overall mass.
    float surface = caul * 0.88 + column * 0.34;
    d *= smoothstep(0.40, 0.60, surface);   // tighter band → crisp defined edges
    // …and modulates lobe DENSITY through the body so the self-shadow pass
    // reveals rounded bumps everywhere (more contrast = more lobe definition).
    d *= 0.40 + 0.60 * caul;
    if (detail && d > 0.01) {
      float e = 1.0 - abs(valueNoise(advected * 12.0 + vec3(3.0, 5.0, -9.0)) * 2.0 - 1.0);
      d = smoothstep(0.05, 0.80, d * (0.86 + 0.28 * e));
    }
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
    return exp(-opticalDepth * 0.65);
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
    float t = nearT + jitter * stepLength;
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
        vec3 ambient = uSkyColor * (0.20 + 0.34 * powder);
        vec3 direct = uKeyColor * uKeyIntensity * keyT * (0.48 + phase * 3.8) * (0.40 + 0.60 * powder);
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
    float alpha = smoothstep(0.05, 0.50, rawAlpha) * 0.97;
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
  const topHeight = Math.max(span * 1.70, baseHeight + 18);
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
    uCoverage: { value: 0.72 },
    uDensity: { value: 2.40 },
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
