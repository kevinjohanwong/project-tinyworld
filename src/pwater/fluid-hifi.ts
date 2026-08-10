// Hi-fi water surface presentation for the particle sim (KJ-approved look,
// ported from water-sim-sandbox swater-hifi.ts, Aug 10).
//
// Replaces the SSFR splat pipeline with a continuous surface: the sim's
// particles are binned per XZ column (height, depth, flow, foam, impact) into
// bilinear float textures; a static subdivided grid displaces by the height
// field. The fragment shader refracts the real scene render, absorbs by true
// view thickness (scene depth vs water depth), marches screen-space
// reflections against the scene, whitens only where the sim reports foam or
// impact, and detects waterfall curtains from real height-field slope.
// Sim-driven only: every channel derives from particle state — nothing is
// painted or hand-authored. Cost: one scene pass + blit + one surface draw
// (cheaper than SSFR's depth-splat/blur/thickness chain).
export type HiFiFields = {
  h: Float32Array; // surface height per column, CELL units (relaxed)
  mask: Float32Array; // 1 = wet column
  dep: Float32Array; // vertical water span, CELL units
  fx: Float32Array; // mean flow, cells/s
  fz: Float32Array;
  foam: Float32Array; // 0..1 foam/whitewater source
  imp: Float32Array; // 0..1 fall-impact
};

export type HiFiFluid = {
  fields: HiFiFields;
  commit: () => void;
  resize: (w: number, h: number) => void;
  render: (scene: any, camera: any, sunDir: any, key: any, hemiCol: any, fogCol: any) => void;
  knob: (o: any) => void;
  state: () => any;
  dispose: () => void;
};

export function createHiFiFluid(
  THREE: any,
  renderer: any,
  nx: number,
  nz: number,
  off: { x: number; y: number; z: number },
  voxel: number,
): HiFiFluid {
  const n = nx * nz;
  const fields: HiFiFields = {
    h: new Float32Array(n), mask: new Float32Array(n), dep: new Float32Array(n),
    fx: new Float32Array(n), fz: new Float32Array(n),
    foam: new Float32Array(n), imp: new Float32Array(n),
  };
  const tex0Data = new Float32Array(n * 4); // h, dep, mask, foam
  const tex1Data = new Float32Array(n * 4); // fx, fz, imp, speedT(unused)
  const tex0 = new THREE.DataTexture(tex0Data, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  const tex1 = new THREE.DataTexture(tex1Data, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [tex0, tex1]) {
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
  }

  // Scene prepass: color + depth (the refraction/SSR/occlusion source).
  const sceneRT = new THREE.WebGLRenderTarget(2, 2);
  sceneRT.depthTexture = new THREE.DepthTexture(2, 2);
  sceneRT.depthTexture.type = THREE.UnsignedIntType;

  // Fullscreen blit of the scene pass to the canvas.
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitScene = new THREE.Scene();
  const blitMat = new THREE.MeshBasicMaterial({ map: sceneRT.texture, depthTest: false, depthWrite: false });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
  blitScene.add(blitQuad);

  const S = 2; // verts per cell
  const geo = new THREE.PlaneGeometry(nx, nz, nx * S, nz * S);
  geo.rotateX(-Math.PI / 2);
  geo.translate(nx / 2, 0, nz / 2);

  const tune = {
    absorb: 0.55, // per world unit of view thickness
    refract: 0.35 * voxel,
    rippleAmp: 0.22,
    flowAdv: 0.055,
    ssr: 1,
  };

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uTex0: { value: tex0 },
      uTex1: { value: tex1 },
      uGrid: { value: new THREE.Vector2(nx, nz) },
      uVoxel: { value: voxel },
      uSceneTex: { value: sceneRT.texture },
      uSceneDepth: { value: sceneRT.depthTexture },
      uScreen: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.1, 400) },
      uPV: { value: new THREE.Matrix4() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1.0, 0.95, 0.86) },
      uSkyHi: { value: new THREE.Color(0.435, 0.647, 0.847) },
      uSkyLo: { value: new THREE.Color(0.812, 0.878, 0.925) },
      uShallow: { value: new THREE.Color(0.12, 0.62, 0.58) },
      uDeep: { value: new THREE.Color(0.04, 0.26, 0.42) },
      uAbsorb: { value: tune.absorb },
      uRefract: { value: tune.refract },
      uRippleAmp: { value: tune.rippleAmp },
      uFlowAdv: { value: tune.flowAdv },
      uSSR: { value: tune.ssr },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uTex0;
      uniform vec2 uGrid;
      varying vec3 vWorld;
      varying vec3 vCell;
      varying vec2 vUv;
      void main() {
        vUv = vec2(position.x / uGrid.x, position.z / uGrid.y);
        vec4 f = texture2D(uTex0, vUv);
        vec3 p = vec3(position.x, f.r, position.z);
        vCell = p;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorld;
      varying vec3 vCell;
      varying vec2 vUv;
      uniform sampler2D uTex0, uTex1, uSceneTex, uSceneDepth;
      uniform vec2 uGrid, uScreen, uNearFar;
      uniform mat4 uPV;
      uniform float uTime, uVoxel, uAbsorb, uRefract, uRippleAmp, uFlowAdv, uSSR;
      uniform vec3 uSunDir, uSunCol, uSkyHi, uSkyLo, uShallow, uDeep;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { return vnoise(p) * 0.56 + vnoise(p * 2.17 + 7.31) * 0.30 + vnoise(p * 4.31 + 19.4) * 0.14; }

      float linDepth(float d) {
        float zn = uNearFar.x, zf = uNearFar.y;
        float ndc = d * 2.0 - 1.0;
        return (2.0 * zn * zf) / (zf + zn - ndc * (zf - zn));
      }

      float ripple(vec2 xz, vec2 flowC) {
        float cycle = 1.7;
        float t1 = fract(uTime / cycle);
        float t2 = fract(uTime / cycle + 0.5);
        vec2 p = xz * 0.55;
        vec2 drift = flowC * uFlowAdv * cycle * 0.5;
        vec2 amb = vec2(uTime * 0.035, uTime * 0.021);
        float n1 = fbm(p - drift * t1 + amb);
        float n2 = fbm(p - drift * t2 + amb + 4.7);
        return mix(n1, n2, abs(t1 * 2.0 - 1.0));
      }

      float streamDetail(vec2 xz, vec2 flowC, float speedT) {
        vec2 d = normalize(flowC + vec2(0.0001, 0.0));
        vec2 across = vec2(-d.y, d.x);
        float along = dot(xz, d) * 1.55 - uTime * (0.45 + speedT * 2.2);
        float side = dot(xz, across) * 2.7;
        float bands = sin(along + fbm(vec2(side, along * 0.32)) * 3.1) * 0.5 + 0.5;
        return bands * fbm(xz * 1.35 - d * uTime * (0.18 + speedT * 0.42));
      }

      void main() {
        vec2 texel = 1.0 / uGrid;
        vec4 f0 = texture2D(uTex0, vUv);
        vec4 f1 = texture2D(uTex1, vUv);
        float mask = f0.b;
        if (mask < 0.03) discard;

        // Terrain in front of the water occludes it (the canvas depth buffer
        // holds only water fragments — the scene lives in the prepass).
        vec2 screenUV = gl_FragCoord.xy / uScreen;
        float dWater = linDepth(gl_FragCoord.z);
        float dSceneHere = linDepth(texture2D(uSceneDepth, screenUV).x);
        if (dSceneHere < dWater - 0.03) discard;

        float foamT = f0.a;
        float impactT = f1.b;
        vec2 flowC = f1.rg; // cells/s
        float speedT = clamp(length(flowC) / 8.0, 0.0, 1.0);

        // Macro normal from the interpolated height field (cell space; the
        // group scale is uniform so the direction carries to world).
        float hL = texture2D(uTex0, vUv - vec2(texel.x, 0.0)).r;
        float hR = texture2D(uTex0, vUv + vec2(texel.x, 0.0)).r;
        float hD = texture2D(uTex0, vUv - vec2(0.0, texel.y)).r;
        float hU = texture2D(uTex0, vUv + vec2(0.0, texel.y)).r;
        float dhdx = (hR - hL) * 0.5;
        float dhdz = (hU - hD) * 0.5;
        vec3 N = normalize(vec3(-dhdx, 1.0, -dhdz));
        float slope = length(vec2(dhdx, dhdz));
        float fallT = smoothstep(0.9, 2.6, slope);

        float rip, gx, gz;
        if (fallT > 0.5) {
          vec2 p = vec2((vCell.x + vCell.z) * 3.1, vCell.y * 0.13 + uTime * 2.6);
          rip = fbm(p) * 0.65 + vnoise(p * vec2(3.1, 1.0)) * 0.35;
          gx = 0.0; gz = 0.0;
        } else {
          float e = 0.45;
          rip = ripple(vCell.xz, flowC);
          gx = (ripple(vCell.xz + vec2(e, 0.0), flowC) - rip) / e;
          gz = (ripple(vCell.xz + vec2(0.0, e), flowC) - rip) / e;
          float stream = streamDetail(vCell.xz, flowC, speedT);
          float sx = (streamDetail(vCell.xz + vec2(e, 0.0), flowC, speedT) - stream) / e;
          float sz = (streamDetail(vCell.xz + vec2(0.0, e), flowC, speedT) - stream) / e;
          gx = mix(gx, gx + sx * 0.7, speedT);
          gz = mix(gz, gz + sz * 0.7, speedT);
        }
        float amp = uRippleAmp * (0.35 + 0.95 * speedT) * (1.0 - fallT * 0.7);
        vec3 Np = normalize(N + vec3(-gx, 0.0, -gz) * amp);

        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSunDir);

        // Refraction through the rippled surface, absorbed by view thickness.
        vec3 Nr = normalize(mix(N, Np, 0.5));
        vec2 refr = Nr.xz * uRefract * clamp(dWater * 0.08, 0.2, 1.0);
        vec2 uvR = screenUV + refr / max(dWater, 1.0);
        float dBedR = linDepth(texture2D(uSceneDepth, uvR).x);
        if (dBedR < dWater - 0.05) uvR = screenUV;
        float dBed = linDepth(texture2D(uSceneDepth, uvR).x);
        vec3 bedCol = texture2D(uSceneTex, uvR).rgb;
        float thick = max(dBed - dWater, 0.0);

        float trans = exp(-thick * uAbsorb);
        float od = 1.0 - trans;
        float sunUp = clamp(L.y, 0.0, 1.0);
        vec3 body = mix(uShallow, uDeep, clamp(od * 1.15, 0.0, 1.0));
        float diff = max(dot(Np, L), 0.0);
        vec3 refracted = bedCol * mix(vec3(1.0), uShallow * 1.35, clamp(od * 0.85, 0.0, 0.85)) * trans
                       + body * od * (0.75 + 0.55 * diff) * sunUp + uSkyHi * od * 0.14;

        // Fresnel reflection: SSR against the scene prepass, sky on miss.
        float f0r = 0.045;
        float fres = f0r + (1.0 - f0r) * pow(1.0 - clamp(dot(V, Np), 0.0, 1.0), 5.0);
        vec3 R = reflect(-V, normalize(mix(N, Np, 0.55)));
        float skyUp = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 skyRefl = mix(uSkyLo, uSkyHi, pow(skyUp, 0.7));
        if (uSSR > 0.5) {
          vec3 mp = vWorld;
          float stp = 0.5 * uVoxel;
          float ssrHit = 0.0;
          vec3 ssrCol = vec3(0.0);
          for (int i = 0; i < 16; i++) {
            mp += R * stp;
            stp *= 1.3;
            vec4 clipP = uPV * vec4(mp, 1.0);
            if (clipP.w <= 0.0) break;
            vec3 ndc = clipP.xyz / clipP.w;
            if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) break;
            vec2 suv = ndc.xy * 0.5 + 0.5;
            float sceneD = linDepth(texture2D(uSceneDepth, suv).x);
            float rayD = linDepth(ndc.z * 0.5 + 0.5);
            if (sceneD < rayD - 0.02) {
              if (rayD - sceneD < stp * 3.0) {
                float edgeF = (1.0 - smoothstep(0.72, 1.0, max(abs(ndc.x), abs(ndc.y))));
                ssrCol = texture2D(uSceneTex, suv).rgb;
                ssrHit = edgeF;
              }
              break;
            }
          }
          skyRefl = mix(skyRefl, ssrCol, ssrHit * 0.85);
        }
        vec3 H = normalize(L + V);
        float ndh = max(dot(Np, H), 0.0);
        float specCore = pow(ndh, 260.0);
        float specHalo = pow(ndh, 46.0);
        float glint = smoothstep(0.5, 0.92, vnoise(vCell.xz * 9.0 + uTime * vec2(1.7, 1.3)));
        float sunRefl = specCore * (2.2 + 6.0 * glint) + specHalo * 0.24;

        vec3 col = mix(refracted, skyRefl, clamp(fres, 0.0, 1.0));
        col += uSunCol * sunRefl;

        // Waterfall curtain: translucent falling water with aeration streaks.
        float aer = 0.0;
        if (fallT > 0.001) {
          vec2 sp1 = vec2((vCell.x + vCell.z) * 3.1, vCell.y * 0.13 + uTime * 2.6);
          vec2 sp2 = vec2((vCell.x - vCell.z) * 5.3 + 4.7, vCell.y * 0.21 + uTime * 3.4);
          float streaks = fbm(sp1) * 0.62 + vnoise(sp2 * vec2(2.6, 1.0)) * 0.38;
          float drop = clamp(1.0 - N.y, 0.0, 1.0);
          aer = smoothstep(0.32, 0.72, streaks) * (0.45 + 0.55 * clamp(impactT + foamT * 0.5 + drop * 0.4, 0.0, 1.0));
          aer = max(aer, 0.14);
          vec3 sheet = refracted * mix(vec3(1.0), uShallow * 1.25, 0.55) + skyRefl * (0.18 + fres * 0.8);
          vec3 curtain = mix(sheet, vec3(0.95, 0.98, 1.0), aer);
          col = mix(col, curtain, fallT);
        }

        // Foam: sim sources + depth-fade shoreline lace under advected breakup.
        float breakup = fbm(vCell.xz * 0.95 - flowC * uFlowAdv * uTime * 0.9 + 11.3);
        float lace = smoothstep(0.6, 0.95, foamT * 0.95 + (breakup - 0.5) * 0.55);
        float shore = 1.0 - smoothstep(0.0, 0.32 * uVoxel, thick);
        float shoreLace = shore * smoothstep(0.52, 0.85, breakup + foamT * 0.4) * 0.55;
        float impactFoam = smoothstep(0.25, 0.9, impactT) * smoothstep(0.35, 0.75, breakup + impactT * 0.3);
        float white = clamp(lace + shoreLace + impactFoam, 0.0, 0.92) * (1.0 - fallT * 0.5);
        col = mix(col, vec3(0.96, 0.98, 1.0), white);

        float edge = smoothstep(0.12, 0.55, mask);
        float film = smoothstep(0.0, 0.05 * uVoxel, thick + fallT);
        float a = edge * mix(0.35, 1.0, film);
        a = mix(a, 0.62 + 0.38 * aer, fallT);
        gl_FragColor = vec4(col, a);
      }
    `,
  });

  const surfMesh = new THREE.Mesh(geo, material);
  surfMesh.frustumCulled = false;

  // Spray mist at fall bases, fed by the binned impact field.
  const MIST_N = 96;
  const mistPos = new Float32Array(MIST_N * 3);
  const mistImp = new Float32Array(MIST_N);
  const mistSeed = new Float32Array(MIST_N);
  for (let i = 0; i < MIST_N; i++) mistSeed[i] = Math.random();
  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute("position", new THREE.BufferAttribute(mistPos, 3));
  mistGeo.setAttribute("aImp", new THREE.BufferAttribute(mistImp, 1));
  mistGeo.setAttribute("aSeed", new THREE.BufferAttribute(mistSeed, 1));
  const mistMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: voxel },
      uScreen: material.uniforms.uScreen,
      uNearFar: material.uniforms.uNearFar,
      uSceneDepth: { value: sceneRT.depthTexture },
    },
    vertexShader: /* glsl */ `
      attribute float aImp;
      attribute float aSeed;
      uniform float uTime, uScale;
      varying float vA;
      varying float vSeed;
      void main() {
        float phase = fract(uTime * (0.55 + aSeed * 0.35) + aSeed * 7.13);
        vec3 p = position;
        p.y += phase * 1.6;
        p.x += (aSeed - 0.5) * 0.8 * phase;
        p.z += (fract(aSeed * 13.7) - 0.5) * 0.8 * phase;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float grow = 0.55 + phase * 1.5;
        gl_PointSize = clamp(620.0 * uScale * grow * aImp / max(-mv.z, 1.0), 0.0, 110.0);
        vA = aImp * pow(1.0 - phase, 1.7) * smoothstep(0.0, 0.18, phase) * 0.45;
        vSeed = aSeed;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vA;
      varying float vSeed;
      uniform vec2 uScreen, uNearFar;
      uniform sampler2D uSceneDepth;
      float linDepth(float d) {
        float zn = uNearFar.x, zf = uNearFar.y;
        float ndc = d * 2.0 - 1.0;
        return (2.0 * zn * zf) / (zf + zn - ndc * (zf - zn));
      }
      void main() {
        vec2 screenUV = gl_FragCoord.xy / uScreen;
        float dScene = linDepth(texture2D(uSceneDepth, screenUV).x);
        float dMist = linDepth(gl_FragCoord.z);
        if (dScene < dMist - 0.03) discard;
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float soft = smoothstep(1.0, 0.1, r) * (0.55 + 0.45 * smoothstep(1.0, 0.0, r));
        if (vA * soft < 0.01) discard;
        gl_FragColor = vec4(vec3(0.93, 0.96, 1.0), vA * soft);
      }
    `,
  });
  const mist = new THREE.Points(mistGeo, mistMat);
  mist.frustumCulled = false;

  const group = new THREE.Group();
  group.scale.setScalar(voxel);
  group.position.set(off.x * voxel, off.y * voxel, off.z * voxel);
  group.add(surfMesh);
  group.add(mist);
  const waterScene = new THREE.Scene();
  waterScene.add(group);

  function commit() {
    const { h, mask, dep, fx, fz, foam, imp } = fields;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (mask[i] > 0) {
        tex0Data[o] = h[i]; tex0Data[o + 1] = dep[i]; tex0Data[o + 2] = 1; tex0Data[o + 3] = foam[i];
        tex1Data[o] = fx[i]; tex1Data[o + 1] = fz[i]; tex1Data[o + 2] = imp[i]; tex1Data[o + 3] = 0;
      } else {
        tex0Data[o + 2] = 0;
      }
    }
    // Dry cells copy the MIN wet-neighbor height (avg fans curtains onto
    // ledges) and the mean of the other fields, so shoreline bilinear
    // interpolation never drags in stale zeros.
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const k = z * nx + x;
        const o = k * 4;
        if (tex0Data[o + 2] === 1) continue;
        let cnt = 0, hMin = Infinity, dsum = 0, fsum = 0, fxs = 0, fzs = 0, isum = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx, pz = z + dz;
            if (px < 0 || px >= nx || pz < 0 || pz >= nz) continue;
            const ko = (pz * nx + px) * 4;
            if (tex0Data[ko + 2] !== 1) continue;
            cnt++;
            if (tex0Data[ko] < hMin) hMin = tex0Data[ko];
            dsum += tex0Data[ko + 1]; fsum += tex0Data[ko + 3];
            fxs += tex1Data[ko]; fzs += tex1Data[ko + 1]; isum += tex1Data[ko + 2];
          }
        if (cnt > 0) {
          const inv = 1 / cnt;
          tex0Data[o] = hMin; tex0Data[o + 1] = dsum * inv; tex0Data[o + 3] = fsum * inv;
          tex1Data[o] = fxs * inv; tex1Data[o + 1] = fzs * inv; tex1Data[o + 2] = isum * inv;
        } else {
          tex0Data[o] = 0; tex0Data[o + 1] = 0; tex0Data[o + 3] = 0;
          tex1Data[o] = 0; tex1Data[o + 1] = 0; tex1Data[o + 2] = 0;
        }
      }
    }
    tex0.needsUpdate = true;
    tex1.needsUpdate = true;
    // Mist emitters: strongest impact columns (cell space; group transforms).
    const emitters: Array<[number, number, number, number]> = [];
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const k = z * nx + x;
        if (mask[k] > 0 && imp[k] > 0.12) emitters.push([x, z, h[k], imp[k]]);
      }
    emitters.sort((a, b) => b[3] - a[3]);
    const nE = Math.min(emitters.length, 32);
    for (let i = 0; i < MIST_N; i++) {
      if (nE === 0) { mistImp[i] = 0; continue; }
      const e = emitters[i % nE];
      mistPos[i * 3] = e[0] + 0.5 + (mistSeed[i] - 0.5) * 1.4;
      mistPos[i * 3 + 1] = e[2] + 0.15;
      mistPos[i * 3 + 2] = e[1] + 0.5 + (((mistSeed[i] * 31.7) % 1) - 0.5) * 1.4;
      mistImp[i] = Math.min(1, e[3] * 1.6);
    }
    mistGeo.attributes.position.needsUpdate = true;
    mistGeo.attributes.aImp.needsUpdate = true;
  }

  let w = 2, hgt = 2;
  function resize(pw: number, ph: number) {
    const pr = renderer.getPixelRatio();
    w = Math.max(2, Math.round(pw * pr));
    hgt = Math.max(2, Math.round(ph * pr));
    sceneRT.setSize(w, hgt);
    material.uniforms.uScreen.value.set(w, hgt);
  }

  function render(scene: any, camera: any, sunDir: any, key: any, hemiCol: any, fogCol: any) {
    const u = material.uniforms;
    u.uTime.value = performance.now() / 1000;
    mistMat.uniforms.uTime.value = u.uTime.value;
    u.uNearFar.value.set(camera.near, camera.far);
    u.uPV.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uSunDir.value.copy(sunDir);
    u.uSunCol.value.copy(key.color);
    u.uSkyHi.value.copy(hemiCol);
    if (fogCol) u.uSkyLo.value.copy(fogCol);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(fogCol ?? new THREE.Color(0x9db8cf), 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.render(blitScene, fsCam);
    renderer.clearDepth();
    renderer.render(waterScene, camera);
    return true;
  }

  function knob(o: any) {
    const u = material.uniforms;
    if (o.absorb !== undefined) u.uAbsorb.value = tune.absorb = Number(o.absorb);
    if (o.refract !== undefined) u.uRefract.value = tune.refract = Number(o.refract);
    if (o.rippleAmp !== undefined) u.uRippleAmp.value = tune.rippleAmp = Number(o.rippleAmp);
    if (o.flowAdv !== undefined) u.uFlowAdv.value = tune.flowAdv = Number(o.flowAdv);
    if (o.ssr !== undefined) u.uSSR.value = tune.ssr = o.ssr ? 1 : 0;
  }

  function state() {
    return { mode: "hifi", grid: [nx, nz], rt: [w, hgt], ...tune };
  }

  function dispose() {
    geo.dispose();
    material.dispose();
    mistGeo.dispose();
    mistMat.dispose();
    blitQuad.geometry.dispose();
    blitMat.dispose();
    sceneRT.dispose();
    tex0.dispose();
    tex1.dispose();
  }

  return { fields, commit, resize, render, knob, state, dispose };
}
