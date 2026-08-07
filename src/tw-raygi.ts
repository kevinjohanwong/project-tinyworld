// ─── RayGI: hybrid ray-traced lighting prototype (staging) ─────────────────
// Secondary per-pixel ray pass over the voxel world: the raster pipeline is
// untouched; this traces Amanatides–Woo DDA rays through a downsampled RGBA8
// occupancy+albedo volume stored in a 3D texture (data-locality win — same
// storage change that took the reference traversal from 12→121 FPS) to get
// a jittered sun-visibility term and cosine-hemisphere bounce radiance at
// half resolution per axis, temporally accumulated with reprojection.
// Every photon has a real source: the active sun/moon key light and the live
// sky palette — no invented ambient (per the lighting doctrine).
// Kill: ?raygi=0 · live: __tw.raygi({...}) · state: window.__twRayGI.

// Per-surface bounce strength (KJ Jul 25): every material throws back a
// different fraction of the light that hits it, and stronger surfaces throw
// it FARTHER — the bounce is not uniform like the sun. Strength is encoded
// in the volume alpha channel: empty = 0, solid = 0.45–1.0 mapping to
// strength 0–1, so the DDA solid test (a > 0.4) is unchanged.
export const RAYGI_BOUNCE_STRENGTH: Record<string, number> = {
  snow: 0.9,
  wall: 0.7,
  ceiling: 0.7,
  leaves: 0.4,
  grass: 0.35,
  dryGrass: 0.35,
  trunks: 0.3,
  dirt: 0.3,
  hidden_dirt: 0.3,
  wet: 0.15,
};
const encodeStrength = (s: number) => 115 + Math.round(Math.min(1, Math.max(0, s)) * 140);

const FSQ_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const GI_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler3D tVol;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uVolOrigin;
uniform float uCell;
uniform vec3 uDims;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform float uAperture;
uniform float uFrame;
uniform float uMaxDist;
uniform float uSunMaxDist;
uniform float uReachMin;
uniform float uReachMax;
uniform float uBounces;
in vec2 vUv;
out vec4 outGI;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

bool inVol(ivec3 c) {
  return c.x >= 0 && c.y >= 0 && c.z >= 0
    && c.x < int(uDims.x) && c.y < int(uDims.y) && c.z < int(uDims.z);
}

bool traceVolN(vec3 ro, vec3 rd, float maxT, out vec4 mat, out float tHit, out vec3 hitN) {
  vec3 p = (ro - uVolOrigin) / uCell;
  ivec3 cell = ivec3(floor(p));
  vec3 inv = 1.0 / max(abs(rd), vec3(1e-6));
  ivec3 stp = ivec3(sign(rd));
  vec3 fr = p - floor(p);
  vec3 tMax = vec3(
    rd.x > 0.0 ? (1.0 - fr.x) * inv.x : fr.x * inv.x,
    rd.y > 0.0 ? (1.0 - fr.y) * inv.y : fr.y * inv.y,
    rd.z > 0.0 ? (1.0 - fr.z) * inv.z : fr.z * inv.z
  );
  float t = 0.0;
  int lastAxis = -1;
  for (int i = 0; i < 192; i++) {
    if (!inVol(cell)) return false;
    vec4 s = texelFetch(tVol, cell, 0);
    if (s.a > 0.4) {
      mat = s; tHit = t * uCell;
      // Face normal from the last DDA step axis (entry face of the hit cell).
      if (lastAxis == 0) hitN = vec3(-float(stp.x), 0.0, 0.0);
      else if (lastAxis == 1) hitN = vec3(0.0, -float(stp.y), 0.0);
      else if (lastAxis == 2) hitN = vec3(0.0, 0.0, -float(stp.z));
      else hitN = -rd;
      return true;
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) { cell.x += stp.x; t = tMax.x; tMax.x += inv.x; lastAxis = 0; }
    else if (tMax.y < tMax.z)               { cell.y += stp.y; t = tMax.y; tMax.y += inv.y; lastAxis = 1; }
    else                                     { cell.z += stp.z; t = tMax.z; tMax.z += inv.z; lastAxis = 2; }
    if (t * uCell > maxT) return false;
  }
  return false;
}

bool traceVol(vec3 ro, vec3 rd, float maxT, out vec4 mat, out float tHit) {
  vec3 _hn;
  return traceVolN(ro, rd, maxT, mat, tHit, _hn);
}

void main() {
  float d = texture(tDepth, vUv).x;
  if (d >= 0.9999) { outGI = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 nView = texture(tNormal, vUv).xyz * 2.0 - 1.0;
  vec3 n = normalize((uCamWorld * vec4(nView, 0.0)).xyz);
  vec3 ro = wp + n * (uCell * 0.6);

  // Jittered sun cone → soft penumbra after temporal accumulation.
  float r1 = hash13(vec3(vUv * 1531.7, uFrame));
  float r2 = hash13(vec3(vUv * 911.3, uFrame + 13.7));
  vec3 st1 = normalize(abs(uSunDir.y) < 0.95 ? cross(uSunDir, vec3(0, 1, 0)) : cross(uSunDir, vec3(1, 0, 0)));
  vec3 st2 = cross(uSunDir, st1);
  float sAng = r1 * 6.2831853;
  float sRad = sqrt(r2) * uAperture;
  vec3 sdir = normalize(uSunDir + (cos(sAng) * st1 + sin(sAng) * st2) * sRad);

  vec4 hm; float ht;
  float sunVis = 1.0;
  if (dot(n, uSunDir) > 0.02) {
    if (traceVol(ro + sdir * uCell * 0.25, sdir, uSunMaxDist, hm, ht)) sunVis = 0.0;
  }
  // Backfacing pixels keep vis=1: lambert already zeroes their direct light,
  // extra multiplication would double-darken.

  // Cosine-hemisphere bounce: radiance from real sunlit/skylit surfaces only.
  vec3 t1 = normalize(abs(n.y) < 0.95 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0)));
  vec3 t2 = cross(n, t1);
  vec3 rad = vec3(0.0);
  for (int b = 0; b < 2; b++) {
    float b1 = hash13(vec3(vUv * 3571.1, uFrame + float(b) * 71.3));
    float b2 = hash13(vec3(vUv * 6229.9, uFrame + float(b) * 29.1 + 5.0));
    float phi = b1 * 6.2831853;
    float sinT = sqrt(b2);
    float cosT = sqrt(1.0 - b2);
    vec3 bd = normalize(t1 * cos(phi) * sinT + t2 * sin(phi) * sinT + n * cosT);
    vec4 bmat; float bt; vec3 hn;
    if (traceVolN(ro, bd, uMaxDist, bmat, bt, hn)) {
      vec3 hp = ro + bd * bt;
      vec4 m2; float t2h;
      vec3 hro = hp - bd * (uCell * 0.2) + uSunDir * (uCell * 0.85);
      float hVis = traceVol(hro, sdir, uSunMaxDist, m2, t2h) ? 0.0 : 1.0;
      // Per-surface bounce: the hit material's strength (volume alpha) scales
      // BOTH the radiance it throws back and how far that light reaches —
      // snow carries across a courtyard, dark asphalt dies within a few cells.
      float str = clamp((bmat.a - 0.45) / 0.55, 0.0, 1.0);
      float reach = mix(uReachMin, uReachMax, str);
      float fall = 1.0 - smoothstep(reach * 0.3, reach, bt);
      rad += bmat.rgb * (str * fall) * (uSunCol * (hVis * 0.9) + uSkyCol * 0.25);
      // Experimental second hop (?gibounces=2): light that reaches the hit
      // surface via ONE MORE bounce (sun → B → A → pixel). Same energy rules:
      // both hops' albedo × strength × reach falloff, sun-lit at the far end,
      // sky/miss contributes nothing. Off (uBounces=1) costs zero extra rays.
      if (uBounces > 1.5) {
        vec3 h1 = normalize(abs(hn.y) < 0.95 ? cross(hn, vec3(0, 1, 0)) : cross(hn, vec3(1, 0, 0)));
        vec3 h2 = cross(hn, h1);
        float c1 = hash13(vec3(vUv * 7717.3, uFrame + float(b) * 47.9 + 11.0));
        float c2 = hash13(vec3(vUv * 4391.7, uFrame + float(b) * 83.1 + 3.0));
        float phi2 = c1 * 6.2831853;
        float sT2 = sqrt(c2);
        float cT2 = sqrt(1.0 - c2);
        vec3 bd2 = normalize(h1 * cos(phi2) * sT2 + h2 * sin(phi2) * sT2 + hn * cT2);
        vec3 ro2 = hp + hn * (uCell * 0.6);
        vec4 m3; float t3; vec3 hn3;
        if (traceVolN(ro2, bd2, uMaxDist, m3, t3, hn3)) {
          vec3 hp2 = ro2 + bd2 * t3;
          vec4 m4; float t4;
          vec3 hro2 = hp2 - bd2 * (uCell * 0.2) + uSunDir * (uCell * 0.85);
          float hVis2 = traceVol(hro2, sdir, uSunMaxDist, m4, t4) ? 0.0 : 1.0;
          float str2 = clamp((m3.a - 0.45) / 0.55, 0.0, 1.0);
          float reach2 = mix(uReachMin, uReachMax, str2);
          float fall2 = 1.0 - smoothstep(reach2 * 0.3, reach2, t3);
          rad += bmat.rgb * (str * fall) * (m3.rgb * (str2 * fall2) * uSunCol * (hVis2 * 0.9));
        }
      }
    }
    // Miss = open sky: contributes NOTHING. Sky ambient is already in the
    // raster image via the hemi bounce rig — adding it here double-counts
    // and washes the whole frame (KJ Jul 25).
  }
  rad *= 0.5;
  outGI = vec4(rad, sunVis);
}
`;

const TEMPORAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevVP;
uniform float uBlend;
in vec2 vUv;
out vec4 outAcc;
void main() {
  vec4 cur = texture(tCur, vUv);
  float d = texture(tDepth, vUv).x;
  if (d >= 0.9999 || uBlend <= 0.001) { outAcc = cur; return; }
  vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec4 pc = uPrevVP * vec4(wp, 1.0);
  if (pc.w <= 0.0) { outAcc = cur; return; }
  pc /= pc.w;
  vec2 puv = pc.xy * 0.5 + 0.5;
  if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) { outAcc = cur; return; }
  outAcc = mix(cur, texture(tHist, puv), uBlend);
}
`;

// Classic (GLSL1) composite for the EffectComposer ShaderPass slot:
// scene * softened ray-shadow, then + bounce radiance modulated by scene color.
// Bounce is FILL, not a blanket add: it is weighted toward ray-shadowed pixels
// (sunlit ground gets 25% of it), so it deepens occluded areas instead of
// lifting the already-lit frame.
export const RAYGI_COMPOSITE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as any },
    tGI: { value: null as any },
    uBounceI: { value: 0.55 },
    uShadowI: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tGI;
    uniform float uBounceI;
    uniform float uShadowI;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec4 gi = texture2D(tGI, vUv);
      vec3 c = base.rgb * mix(1.0, 0.45 + 0.55 * gi.a, uShadowI);
      float fill = mix(1.0, 0.25, gi.a);
      c += gi.rgb * uBounceI * fill * (0.25 + 0.75 * base.rgb);
      gl_FragColor = vec4(c, base.a);
    }
  `,
};

export type RayGIReport = {
  dims: [number, number, number];
  k: number;
  solid: number;
  bytes: number;
  cropped: boolean;
};

export function createRayGI(THREE: any, renderer: any) {
  const supported = !!renderer?.capabilities?.isWebGL2;

  let volTex: any = null;
  let counts: Uint16Array | null = null;
  let volData: Uint8Array | null = null;
  let dims = [0, 0, 0];
  let volMin = [0, 0, 0];
  let K = 1;
  let originScene = new THREE.Vector3();
  let cellScene = 1;
  let volDirty = false;
  let lastCommit = 0;
  let report: RayGIReport | null = null;

  const params = {
    aperture: 0.045,
    blend: 0.88,
    maxDist: 6.0,       // bounce ray reach, scene units — set vs span at build
    sunMaxDist: 30.0,
    div: 2,             // per-axis resolution divisor (2 → quarter the pixels)
    reachMin: 1.5,      // bounce-light reach of a strength-0 surface (scene units)
    reachMax: 6.0,      // reach of a strength-1 surface — both set vs cell at build
    bounces: 1,         // indirect hops; 2 = experimental second hop (?gibounces=2)
  };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(geo, null as any);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const giMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FSQ_VERT,
    fragmentShader: GI_FRAG,
    uniforms: {
      tDepth: { value: null }, tNormal: { value: null }, tVol: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uVolOrigin: { value: new THREE.Vector3() }, uCell: { value: 1 }, uDims: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(0xffffff) },
      uSkyCol: { value: new THREE.Color(0x88aaff) },
      uAperture: { value: params.aperture }, uFrame: { value: 0 },
      uMaxDist: { value: params.maxDist }, uSunMaxDist: { value: params.sunMaxDist },
      uReachMin: { value: params.reachMin }, uReachMax: { value: params.reachMax },
      uBounces: { value: params.bounces },
    },
    depthTest: false, depthWrite: false,
  });
  const temporalMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FSQ_VERT,
    fragmentShader: TEMPORAL_FRAG,
    uniforms: {
      tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() }, uBlend: { value: params.blend },
    },
    depthTest: false, depthWrite: false,
  });

  const mkRT = (w: number, h: number) =>
    new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
  let rtCur: any = null, rtA: any = null, rtB: any = null;
  let histWrite: any = null, histRead: any = null;
  let rtW = 0, rtH = 0;
  const prevVP = new THREE.Matrix4();
  let frame = 0;
  let historyValid = false;

  const cellIndex = (gx: number, gy: number, gz: number) => {
    const cx = Math.floor((gx - volMin[0]) / K);
    const cy = Math.floor((gy - volMin[1]) / K);
    const cz = Math.floor((gz - volMin[2]) / K);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= dims[0] || cy >= dims[1] || cz >= dims[2]) return -1;
    return cx + cy * dims[0] + cz * dims[0] * dims[1];
  };

  const buildVolume = (
    layerPairs: Array<[ArrayBuffer | Int32Array | undefined | null, number, number?]>,
    opts: { voxel: number; cxRound: number; czRound: number; maxDim?: number; kCap?: number },
  ) => {
    if (!supported) return null;
    const maxDim = opts.maxDim ?? 176;
    const kCap = opts.kCap ?? 4;
    const arrs: Array<[Int32Array, number, number]> = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const [buf, color, strength] of layerPairs) {
      if (!buf) continue;
      const a = buf instanceof Int32Array ? buf : new Int32Array(buf);
      if (!a.length) continue;
      arrs.push([a, color, strength ?? 0.5]);
      for (let i = 0; i < a.length; i += 3) {
        if (a[i] < minX) minX = a[i]; if (a[i] > maxX) maxX = a[i];
        if (a[i + 1] < minY) minY = a[i + 1]; if (a[i + 1] > maxY) maxY = a[i + 1];
        if (a[i + 2] < minZ) minZ = a[i + 2]; if (a[i + 2] > maxZ) maxZ = a[i + 2];
      }
    }
    if (!arrs.length) return null;
    let k = 1;
    const extent = Math.max(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1);
    while (Math.ceil(extent / k) > maxDim && k < kCap) k++;
    let cropped = false;
    const half = (k * maxDim) / 2;
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2, midZ = (minZ + maxZ) / 2;
    if (Math.ceil((maxX - minX + 1) / k) > maxDim) { minX = Math.floor(midX - half); maxX = Math.ceil(midX + half) - 1; cropped = true; }
    if (Math.ceil((maxY - minY + 1) / k) > maxDim) { minY = Math.floor(midY - half); maxY = Math.ceil(midY + half) - 1; cropped = true; }
    if (Math.ceil((maxZ - minZ + 1) / k) > maxDim) { minZ = Math.floor(midZ - half); maxZ = Math.ceil(midZ + half) - 1; cropped = true; }
    K = k;
    volMin = [minX, minY, minZ];
    dims = [
      Math.min(maxDim, Math.ceil((maxX - minX + 1) / k)),
      Math.min(maxDim, Math.ceil((maxY - minY + 1) / k)),
      Math.min(maxDim, Math.ceil((maxZ - minZ + 1) / k)),
    ];
    const n = dims[0] * dims[1] * dims[2];
    counts = new Uint16Array(n);
    volData = new Uint8Array(n * 4);
    const col = new THREE.Color();
    let solid = 0;
    for (const [a, hex, strength] of arrs) {
      col.setHex(hex);
      const r = Math.round(col.r * 255), g = Math.round(col.g * 255), b = Math.round(col.b * 255);
      const aByte = encodeStrength(strength);
      for (let i = 0; i < a.length; i += 3) {
        const idx = cellIndex(a[i], a[i + 1], a[i + 2]);
        if (idx < 0) continue;
        if (counts[idx] === 0) solid++;
        if (counts[idx] < 65535) counts[idx]++;
        const o = idx * 4;
        volData[o] = r; volData[o + 1] = g; volData[o + 2] = b; volData[o + 3] = aByte;
      }
    }
    if (volTex) volTex.dispose();
    volTex = new THREE.Data3DTexture(volData, dims[0], dims[1], dims[2]);
    volTex.format = THREE.RGBAFormat;
    volTex.type = THREE.UnsignedByteType;
    volTex.minFilter = THREE.NearestFilter;
    volTex.magFilter = THREE.NearestFilter;
    volTex.unpackAlignment = 1;
    volTex.needsUpdate = true;
    originScene.set(
      (minX - opts.cxRound - 0.5) * opts.voxel,
      (minY - 0.5) * opts.voxel,
      (minZ - opts.czRound - 0.5) * opts.voxel,
    );
    cellScene = K * opts.voxel;
    params.maxDist = Math.max(4.0, cellScene * 44);
    params.sunMaxDist = Math.max(20.0, cellScene * 200);
    params.reachMin = Math.max(1.0, cellScene * 10);
    params.reachMax = params.maxDist;
    giMat.uniforms.tVol.value = volTex;
    giMat.uniforms.uVolOrigin.value.copy(originScene);
    giMat.uniforms.uCell.value = cellScene;
    giMat.uniforms.uDims.value.set(dims[0], dims[1], dims[2]);
    giMat.uniforms.uMaxDist.value = params.maxDist;
    giMat.uniforms.uSunMaxDist.value = params.sunMaxDist;
    giMat.uniforms.uReachMin.value = params.reachMin;
    giMat.uniforms.uReachMax.value = params.reachMax;
    historyValid = false;
    volDirty = false;
    report = { dims: dims.slice() as [number, number, number], k: K, solid, bytes: volData.byteLength, cropped };
    return report;
  };

  const addVoxel = (gx: number, gy: number, gz: number, colorHex: number, strength = 0.5) => {
    if (!counts || !volData) return;
    const idx = cellIndex(gx, gy, gz);
    if (idx < 0) return;
    if (counts[idx] < 65535) counts[idx]++;
    const o = idx * 4;
    if (counts[idx] === 1 || volData[o + 3] === 0) {
      const c = new THREE.Color(colorHex);
      volData[o] = Math.round(c.r * 255);
      volData[o + 1] = Math.round(c.g * 255);
      volData[o + 2] = Math.round(c.b * 255);
      volData[o + 3] = encodeStrength(strength);
    }
    volDirty = true;
  };

  const removeVoxel = (gx: number, gy: number, gz: number) => {
    if (!counts || !volData) return;
    const idx = cellIndex(gx, gy, gz);
    if (idx < 0) return;
    if (counts[idx] > 0) counts[idx]--;
    if (counts[idx] === 0) {
      volData[idx * 4 + 3] = 0;
      volDirty = true;
    }
  };

  const ready = () => supported && !!volTex;

  // Runs the GI + temporal passes; returns the accumulated texture (or null).
  const update = (o: {
    camera: any;
    depthTexture: any;
    normalTexture: any;
    sunDir: any;
    sunColor: any;
    skyColor: any;
  }) => {
    if (!ready()) return null;
    const now = performance.now();
    if (volDirty && now - lastCommit > 400) {
      volTex.needsUpdate = true;
      volDirty = false;
      lastCommit = now;
    }
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(8, Math.floor(db.x / params.div));
    const h = Math.max(8, Math.floor(db.y / params.div));
    if (w !== rtW || h !== rtH) {
      rtCur?.dispose(); rtA?.dispose(); rtB?.dispose();
      rtCur = mkRT(w, h); rtA = mkRT(w, h); rtB = mkRT(w, h);
      histWrite = rtA; histRead = rtB;
      rtW = w; rtH = h;
      historyValid = false;
    }
    frame++;
    const cam = o.camera;
    const gu = giMat.uniforms;
    gu.tDepth.value = o.depthTexture;
    gu.tNormal.value = o.normalTexture;
    gu.uInvProj.value.copy(cam.projectionMatrixInverse);
    gu.uCamWorld.value.copy(cam.matrixWorld);
    gu.uSunDir.value.copy(o.sunDir);
    gu.uSunCol.value.copy(o.sunColor);
    gu.uSkyCol.value.copy(o.skyColor);
    gu.uAperture.value = params.aperture;
    gu.uFrame.value = frame % 4096;
    // Sync distance knobs every frame so __tw.raygi({maxDist,reachMin,...})
    // tunes live on the testbed (build-time-only left them dead after load).
    gu.uMaxDist.value = params.maxDist;
    gu.uSunMaxDist.value = params.sunMaxDist;
    gu.uReachMin.value = params.reachMin;
    gu.uReachMax.value = params.reachMax;
    gu.uBounces.value = params.bounces;

    const prevTarget = renderer.getRenderTarget();
    quad.material = giMat;
    renderer.setRenderTarget(rtCur);
    renderer.render(quadScene, quadCam);

    const tu = temporalMat.uniforms;
    tu.tCur.value = rtCur.texture;
    tu.tHist.value = histRead.texture;
    tu.tDepth.value = o.depthTexture;
    tu.uInvProj.value.copy(cam.projectionMatrixInverse);
    tu.uCamWorld.value.copy(cam.matrixWorld);
    tu.uPrevVP.value.copy(prevVP);
    tu.uBlend.value = historyValid ? params.blend : 0;
    quad.material = temporalMat;
    renderer.setRenderTarget(histWrite);
    renderer.render(quadScene, quadCam);
    renderer.setRenderTarget(prevTarget);

    prevVP.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    const out = histWrite.texture;
    const t = histWrite; histWrite = histRead; histRead = t;
    historyValid = true;
    return out;
  };

  const dispose = () => {
    rtCur?.dispose(); rtA?.dispose(); rtB?.dispose();
    volTex?.dispose();
    giMat.dispose(); temporalMat.dispose(); geo.dispose();
    counts = null; volData = null; volTex = null;
  };

  return { supported, params, buildVolume, addVoxel, removeVoxel, ready, update, dispose, getReport: () => report };
}
