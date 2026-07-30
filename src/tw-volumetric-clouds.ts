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

  const int PRIMARY_STEPS = 28;
  const int LIGHT_STEPS = 2;
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
    vec2 wind = vec2(uTime * 0.006, uTime * 0.0025);

    // --- Irregular ring boundary: break the perfect circle ---
    // Sample noise around the ring (a function of DIRECTION, so it is periodic
    // around the circle) and drift it slowly. Inner/outer edges undulate into
    // bays and headlands instead of reading as a clean annulus.
    float lobeA = valueNoise(vec3(dir * 1.6, uTime * 0.010 + 4.0));
    float lobeB = valueNoise(vec3(dir * 3.7 + 9.0, uTime * 0.007));
    float wob = ((lobeA - 0.5) * 0.70 + (lobeB - 0.5) * 0.30) * uWobble;
    float innerR = uInnerRadius * (1.0 + wob);
    float outerR = uOuterRadius * (1.0 + wob * 0.60);
    float ring = smoothstep(innerR, innerR * 1.14, radius)
      * (1.0 - smoothstep(outerR * 0.80, outerR, radius));

    // --- Intruder clouds: a sparse, slow-drifting field permitted anywhere
    // inside the ring (incl. over the island center), gated high so only ~1-2
    // clumps exist at once — reads as a cloud that wandered in over the land.
    float intrField = valueNoise(vec3(p.xz / uOuterRadius * 0.85 - vec2(uTime * 0.012, uTime * 0.006), 21.0));
    float intruder = smoothstep(0.70, 0.90, intrField) * uIntruder
      * (1.0 - smoothstep(uOuterRadius * 0.76, uOuterRadius, radius));
    float ringMask = max(ring, intruder);
    if (ringMask <= 0.0) return 0.0;

    // --- Per-region variable height: flat base, cumulus towers of varied top ---
    // Low-freq field per xz decides how tall each region billows, so some
    // clouds stay low and others tower up (Ghibli cumulus), on a common base.
    float towerField = valueNoise(vec3(p.xz / uOuterRadius * 1.4 + wind * 2.4, 2.2));
    float baseY = uBaseHeight * 0.62;
    float topY = mix(uBaseHeight + (uTopHeight - uBaseHeight) * 0.34, uTopHeight, mix(0.5, towerField, uTower));
    float band = max(topY - baseY, 0.001);
    float h = (p.y - baseY) / band;
    if (h <= 0.0 || h >= 1.0) return 0.0;

    float weatherValue = weather(p.xz / uOuterRadius * 3.2 + wind);
    float vertical = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.70, 1.0, h));
    vertical *= mix(0.82, 1.24, smoothstep(0.06, 0.50, h));
    float coverageThreshold = 1.0 - uCoverage * vertical;
    float organized = smoothstep(coverageThreshold - 0.16, coverageThreshold + 0.10, weatherValue);
    if (organized <= 0.001) return 0.0;

    vec3 advected = p / uOuterRadius * vec3(4.4, 7.2, 4.4)
      + vec3(wind.x * 1.8, -uTime * 0.0015, wind.y * 1.8);
    float shape = baseShape(advected);
    float d = smoothstep(0.32, 0.62, shape + organized * 0.60) * organized * vertical * ringMask;
    if (detail && d > 0.01) {
      float erosion = valueNoise(advected * 4.7 + vec3(19.0, -7.0, 3.0));
      float heightErosion = mix(1.0 - erosion, pow(erosion, 4.0), smoothstep(0.28, 0.64, h));
      d = smoothstep(0.08 + heightErosion * 0.18, 0.92, d);
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
    return exp(-opticalDepth * 0.34);
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
        float powder = 1.0 - exp(-density * 4.5);
        vec3 ambient = uSkyColor * (0.18 + 0.34 * powder);
        vec3 direct = uKeyColor * uKeyIntensity * keyT * (0.16 + phase * 2.8) * (0.38 + 0.62 * powder);
        float extinction = density * 0.42;
        float stepT = exp(-extinction * stepLength);
        vec3 source = ambient + direct;
        radiance += transmittance * source * (1.0 - stepT);
        transmittance *= stepT;
        accumulatedDensity += density * stepLength;
      }
      t += stepLength;
    }

    float alpha = clamp(1.0 - transmittance, 0.0, 0.94);
    if (alpha < 0.006) discard;
    vec3 color = radiance / max(alpha, 0.02);
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
  const baseHeight = -span * 0.24;
  // Raised top so cumulus towers have vertical room to billow (was span*0.38).
  const topHeight = Math.max(span * 0.60, baseHeight + 8);
  const bounds = new THREE.Vector3(outerRadius, (topHeight - baseHeight) * 0.5, outerRadius);
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
    uCoverage: { value: 0.58 },
    uDensity: { value: 0.90 },
    uInnerRadius: { value: innerRadius },
    uOuterRadius: { value: outerRadius },
    uBaseHeight: { value: -bounds.y },
    uTopHeight: { value: bounds.y },
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
