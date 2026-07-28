// Screen-space fluid rendering (SSFR) for the particle sim.
// Pipeline per Truong & Yuksel 2018 (narrow-range filter) as used by the
// best-in-class real-time fluid demos (Splash / WebGPU-Ocean / Babylon.js):
//   1. scene -> color+depth targets
//   2. particle sphere depth splats (gl_FragDepth, terrain-occluded)
//   3. depth smoothing: 1 narrow-range separable pre-pass (sub-particle noise)
//      + N iterations of van der Laan curvature flow (mode/iters/dt live via
//      the smooth() knob; mode:"gauss" restores the old 3-pass blur for A/B)
//   4. half-res additive thickness + speed-weighted foam splats
//   5. composite: reconstructed normals give true 3D shape; SHADING is
//      Ghibli-style — hand-painted depth bands, two-tone toon light, crisp
//      highlight shapes, solid scalloped foam, white shoreline rim.
// The renderer is read-only over sim state: it never feeds back into physics.

export interface FluidRenderer {
  updateParticles(pos: Float32Array, speed: Float32Array, count: number): void;
  updateFoam(pos: Float32Array, fade: Float32Array, count: number): void;
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sunDirWorld: THREE.Vector3, sunLight?: THREE.DirectionalLight): void;
  resize(w: number, h: number): void;
  dispose(): void;
  smooth(cfg: Partial<{ mode: "curv" | "gauss"; curvIters: number; dtFrac: number; preGauss: number; gaussIters: number; div: number; warm: boolean; warmIters: number; warmBlend: number }>): Record<string, unknown>;
  shadows(on: boolean): boolean;
  setParticleD(d: number): void;
  markSceneDirty(): void;
  perf(): { mode: "full" | "static"; itersRun: number; staticFrames: number };
  _u: Record<string, { value: unknown }>;
}

const QUAD_VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute float iSpeed;
  uniform float uRadius;
  varying vec2 vUv;
  varying vec3 vViewCenter;
  varying float vSpeed;
  void main() {
    vUv = position.xy;
    vSpeed = iSpeed;
    vec4 vc = modelViewMatrix * vec4(iPos, 1.0);
    vViewCenter = vc.xyz;
    vc.xy += position.xy * uRadius;
    gl_Position = projectionMatrix * vc;
  }
`;

const DEPTH_FRAG = /* glsl */ `
  precision highp float;
  uniform mat4 uProj;
  uniform sampler2D uSceneDepth;
  uniform vec2 uInvRes;
  uniform float uRadius;
  varying vec2 vUv;
  varying vec3 vViewCenter;
  void main() {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    float nz = sqrt(1.0 - r2);
    vec3 surfView = vViewCenter + vec3(vUv * uRadius, nz * uRadius);
    vec4 clip = uProj * vec4(surfView, 1.0);
    float ndcZ = clip.z / clip.w;
    float winZ = ndcZ * 0.5 + 0.5;
    float sceneZ = texture2D(uSceneDepth, gl_FragCoord.xy * uInvRes).x;
    if (winZ > sceneZ) discard;
    gl_FragDepthEXT = winZ;
    gl_FragColor = vec4(-surfView.z, 0.0, 0.0, 1.0);
  }
`;

const THICK_FRAG = /* glsl */ `
  precision highp float;
  uniform mat4 uProj;
  uniform sampler2D uSceneDepth;
  uniform vec2 uInvRes;
  uniform float uRadius;
  varying vec2 vUv;
  varying vec3 vViewCenter;
  varying float vSpeed;
  void main() {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    vec4 clip = uProj * vec4(vViewCenter, 1.0);
    float winZ = (clip.z / clip.w) * 0.5 + 0.5;
    float sceneZ = texture2D(uSceneDepth, gl_FragCoord.xy * uInvRes).x;
    if (winZ > sceneZ) discard;
    float g = (1.0 - r2);
    float w = g * g * 0.55 * uRadius;
    gl_FragColor = vec4(w, w * vSpeed, 0.0, 1.0);
  }
`;

// Foam sprites: additive coverage into the thickness target's z channel.
// The shared Gaussian blur then merges overlapping sprites, and the
// composite thresholds the blurred field back to a solid edge — metaball
// clumps instead of individual dots. iSpeed carries the sprite's fade.
const FOAM_FRAG = /* glsl */ `
  precision highp float;
  uniform mat4 uProj;
  uniform sampler2D uSceneDepth;
  uniform vec2 uInvRes;
  varying vec2 vUv;
  varying vec3 vViewCenter;
  varying float vSpeed;
  void main() {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    vec4 clip = uProj * vec4(vViewCenter, 1.0);
    float winZ = (clip.z / clip.w) * 0.5 + 0.5;
    float sceneZ = texture2D(uSceneDepth, gl_FragCoord.xy * uInvRes).x;
    if (winZ > sceneZ) discard;
    float g = 1.0 - r2;
    gl_FragColor = vec4(0.0, 0.0, g * g * vSpeed, 1.0);
  }
`;

const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// 1D narrow-range filter: background samples ignored, foreground clamped.
const BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uDepth;
  uniform vec2 uDir;
  uniform vec2 uInvRes;
  uniform float uThresh;
  uniform float uWorldK;
  varying vec2 vUv;
  void main() {
    float d0 = texture2D(uDepth, vUv).x;
    if (d0 <= 0.0) { gl_FragColor = vec4(0.0); return; }
    float radiusPx = clamp(uWorldK / d0, 2.0, 22.0);
    float sigma = radiusPx * 0.5;
    float twoSigma2 = 2.0 * sigma * sigma;
    float sum = d0;
    float wsum = 1.0;
    for (float i = 1.0; i <= 22.0; i += 1.0) {
      if (i > radiusPx) break;
      float w = exp(-(i * i) / twoSigma2);
      for (float s = -1.0; s <= 1.0; s += 2.0) {
        float d = texture2D(uDepth, vUv + uDir * uInvRes * i * s).x;
        if (d <= 0.0) continue;
        if (d > d0 + uThresh) continue;
        d = max(d, d0 - uThresh);
        sum += d * w;
        wsum += w;
      }
    }
    gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
  }
`;

// Curvature flow smoothing (van der Laan, Green & Sainz, I3D 2009): evolve the
// linear-depth field along its screen-space mean curvature so sphere-splat
// bumps relax into a minimal-ish surface while silhouettes stay put (invalid /
// far neighbors are clamped to center => zero derivative across edges).
// Update is z -= dtLocal * H with dtLocal = uDtFrac * Cx * z — calibrated
// offline in tools/test-curvature-flow.ts: this scaling is stable at every
// tested resolution/depth (fixed dt diverges near / at high dpr), and the
// MINUS sign is the smoothing direction for positive view depth.
const CURV_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uDepth;
  uniform vec2 uInvRes;
  uniform vec2 uCxy;
  uniform float uDtFrac;
  uniform float uThresh;
  varying vec2 vUv;
  void main() {
    float z = texture2D(uDepth, vUv).x;
    if (z <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec2 dx = vec2(uInvRes.x, 0.0);
    vec2 dy = vec2(0.0, uInvRes.y);
    float zr = texture2D(uDepth, vUv + dx).x;
    float zl = texture2D(uDepth, vUv - dx).x;
    float zt = texture2D(uDepth, vUv + dy).x;
    float zb = texture2D(uDepth, vUv - dy).x;
    if (zr <= 0.0 || abs(zr - z) > uThresh) zr = z;
    if (zl <= 0.0 || abs(zl - z) > uThresh) zl = z;
    if (zt <= 0.0 || abs(zt - z) > uThresh) zt = z;
    if (zb <= 0.0 || abs(zb - z) > uThresh) zb = z;
    float ztr = texture2D(uDepth, vUv + dx + dy).x;
    float ztl = texture2D(uDepth, vUv - dx + dy).x;
    float zbr = texture2D(uDepth, vUv + dx - dy).x;
    float zbl = texture2D(uDepth, vUv - dx - dy).x;
    if (ztr <= 0.0 || abs(ztr - z) > uThresh) ztr = z;
    if (ztl <= 0.0 || abs(ztl - z) > uThresh) ztl = z;
    if (zbr <= 0.0 || abs(zbr - z) > uThresh) zbr = z;
    if (zbl <= 0.0 || abs(zbl - z) > uThresh) zbl = z;
    float dzx = (zr - zl) * 0.5;
    float dzy = (zt - zb) * 0.5;
    float dzxx = zr - 2.0 * z + zl;
    float dzyy = zt - 2.0 * z + zb;
    float dzxy = (ztr - ztl - zbr + zbl) * 0.25;
    float Cx = uCxy.x;
    float Cy = uCxy.y;
    float Cx2 = Cx * Cx;
    float Cy2 = Cy * Cy;
    float D = Cy2 * dzx * dzx + Cx2 * dzy * dzy + Cx2 * Cy2 * z * z;
    float dDx = 2.0 * Cy2 * dzx * dzxx + 2.0 * Cx2 * dzy * dzxy + 2.0 * Cx2 * Cy2 * z * dzx;
    float dDy = 2.0 * Cy2 * dzx * dzxy + 2.0 * Cx2 * dzy * dzyy + 2.0 * Cx2 * Cy2 * z * dzy;
    float Ex = 0.5 * dzx * dDx - dzxx * D;
    float Ey = 0.5 * dzy * dDy - dzyy * D;
    float Hc = (Cy * Ex + Cx * Ey) / (2.0 * pow(max(D, 1e-14), 1.5));
    gl_FragColor = vec4(z - uDtFrac * Cx * z * Hc, 0.0, 0.0, 1.0);
  }
`;

// Temporal warm-start seed (Lever 1): the smoothed depth surface barely
// changes frame-to-frame, so instead of re-converging curvature flow from the
// raw splat every frame (62 iterations cold), seed it with LAST frame's
// converged surface reprojected through the camera delta, then re-converge in
// far fewer iterations. uBlend anchors the seed toward the current raw splat
// each frame — that injection is what stops repeated curvature flow from
// flattening the surface without bound across frames (equilibrium where
// per-frame smoothing balances per-frame raw data). Disocclusions / fresh
// splat pixels fall back to the raw depth (cold) and converge over 2-3 frames.
const WARM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uRaw;
  uniform sampler2D uPrev;
  uniform float uThresh;
  uniform float uBlend;
  uniform vec2 uProjXY;
  uniform vec2 uPrevProjXY;
  uniform mat4 uCamWorld;
  uniform mat4 uView;
  uniform mat4 uPrevVP;
  uniform mat4 uPrevCamWorld;
  varying vec2 vUv;
  void main() {
    float d = texture2D(uRaw, vUv).x;
    if (d <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 view = vec3(ndc.x * d / uProjXY.x, ndc.y * d / uProjXY.y, -d);
    vec4 world = uCamWorld * vec4(view, 1.0);
    vec4 pc = uPrevVP * world;
    float seed = d;
    if (pc.w > 0.0) {
      vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;
      if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
        float pd = texture2D(uPrev, puv).x;
        if (pd > 0.0) {
          vec2 pndc = puv * 2.0 - 1.0;
          vec3 pview = vec3(pndc.x * pd / uPrevProjXY.x, pndc.y * pd / uPrevProjXY.y, -pd);
          vec4 cv = uView * (uPrevCamWorld * vec4(pview, 1.0));
          float zc = -cv.z;
          if (zc > 0.0 && abs(zc - d) < uThresh) seed = mix(d, zc, uBlend);
        }
      }
    }
    gl_FragColor = vec4(seed, 0.0, 0.0, 1.0);
  }
`;

const COPY_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(uTex, vUv); }
`;

// Plain separable Gaussian for the half-res thickness/foam target. Thickness
// is additive coverage, not a surface — no narrow-range logic needed. This
// kills the row-striping caused by the PBF rest lattice (layered particles
// make additive thickness oscillate row-wise, which the depth-band + clarity
// mixing turns into visible stripes).
const THICK_BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uDir;
  uniform vec2 uInvRes;
  varying vec2 vUv;
  void main() {
    vec4 sum = texture2D(uTex, vUv) * 0.227027;
    vec2 o1 = uDir * uInvRes * 1.3846154;
    vec2 o2 = uDir * uInvRes * 3.2307692;
    sum += (texture2D(uTex, vUv + o1) + texture2D(uTex, vUv - o1)) * 0.3162162;
    sum += (texture2D(uTex, vUv + o2) + texture2D(uTex, vUv - o2)) * 0.0702703;
    gl_FragColor = sum;
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uSceneDepth;
  uniform sampler2D uFluidDepth;
  uniform sampler2D uThick;
  uniform vec2 uInvRes;
  uniform vec2 uProjXY;
  uniform float uNear;
  uniform float uFar;
  uniform mat4 uCamWorld;
  uniform vec3 uSunView;
  uniform vec3 uSunColor;
  uniform vec3 uSkyCol;
  uniform vec3 uFogColor;
  uniform vec2 uFogRange;
  uniform float uTime;
  uniform float uThinLo;
  uniform float uThinHi;
  uniform float uCovScale;
  uniform float uDebugShadow;
  uniform vec3 uColShallow;
  uniform vec3 uColMid;
  uniform vec3 uColDeep;
  uniform vec3 uColAbyss;
  uniform vec3 uColShadowMul;
  uniform vec3 uColCastMul;
  uniform vec3 uColHighlight;
  uniform vec3 uColSSS;
  uniform float uBandWarp;
  uniform float uFoamTh;
  // World units per sandbox unit: normalizing Pw (as Pp) and thick by this
  // runs every hand-tuned band/frequency at sandbox numerics at any scale.
  uniform float uWorldScale;
  uniform sampler2D uShadowMap;
  uniform mat4 uShadowMat;
  uniform vec2 uShadowRes;
  uniform float uShadowOn;
  varying vec2 vUv;

  #include <packing>

  // sun visibility from the scene's shadow map: water inside a cliff's shadow
  // flips to the sky-tinted shade side (occlusion feeds the toon lit term)
  float sunVisAt(vec3 PwPos) {
    if (uShadowOn < 0.5) return 1.0;
    vec4 sc = uShadowMat * vec4(PwPos, 1.0);
    vec3 uvz = sc.xyz / sc.w;
    if (uvz.x < 0.0 || uvz.x > 1.0 || uvz.y < 0.0 || uvz.y > 1.0 || uvz.z > 1.0) return 1.0;
    vec2 px = 1.5 / uShadowRes;
    float vis = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2)) - 0.5;
      float d = unpackRGBAToDepth(texture2D(uShadowMap, uvz.xy + o * px));
      vis += step(uvz.z - 0.004, d);
    }
    return vis * 0.25;
  }

  vec3 viewPosAt(vec2 uv, float lin) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * lin / uProjXY.x, ndc.y * lin / uProjXY.y, -lin);
  }
  float linAt(vec2 uv) { return texture2D(uFluidDepth, uv).x; }
  float sceneLin(vec2 uv) {
    float z = texture2D(uSceneDepth, uv).x;
    return (uNear * uFar) / (uFar - z * (uFar - uNear));
  }
  vec3 skyColor(vec3 dirW) {
    float t = clamp(dirW.y, 0.0, 1.0);
    vec3 horizon = vec3(0.55, 0.65, 0.74);
    vec3 zenith  = vec3(0.13, 0.28, 0.48);
    vec3 sky = mix(horizon, zenith, pow(t, 0.55));
    sky += vec3(0.12, 0.10, 0.07) * pow(1.0 - t, 3.5); // warm horizon haze
    return sky;
  }

  void main() {
    vec3 sceneCol = texture2D(uScene, vUv).rgb;
    vec3 outCol = sceneCol;
    float lin = linAt(vUv);
    float sLin = sceneLin(vUv);
    if (lin > 0.0 && lin < sLin - 0.02 * uWorldScale) {

    vec3 P = viewPosAt(vUv, lin);

    vec2 dx = vec2(uInvRes.x, 0.0);
    vec2 dy = vec2(0.0, uInvRes.y);
    float dR = linAt(vUv + dx); float dL = linAt(vUv - dx);
    float dU = linAt(vUv + dy); float dD = linAt(vUv - dy);
    vec2 uvx = (dR > 0.0 && (dL <= 0.0 || abs(dR - lin) < abs(dL - lin))) ? vUv + dx : vUv - dx;
    float dxv = (uvx == vUv + dx) ? dR : dL;
    vec2 uvy = (dU > 0.0 && (dD <= 0.0 || abs(dU - lin) < abs(dD - lin))) ? vUv + dy : vUv - dy;
    float dyv = (uvy == vUv + dy) ? dU : dD;
    if (dxv <= 0.0) dxv = lin; if (dyv <= 0.0) dyv = lin;
    vec3 Px = viewPosAt(uvx, dxv) - P;
    vec3 Py = viewPosAt(uvy, dyv) - P;
    if (uvx == vUv - dx) Px = -Px;
    if (uvy == vUv - dy) Py = -Py;
    vec3 N = normalize(cross(Px, Py));
    if (N.z < 0.0) N = -N;

    vec4 ta = texture2D(uThick, vUv);
    float thick = ta.x / uWorldScale;
    float foamAvg = ta.y / max(ta.x, 1e-3);

    vec3 Pw = (uCamWorld * vec4(P, 1.0)).xyz;
    vec3 Pp = Pw / uWorldScale; // pattern space: sandbox-unit world coords
    vec3 Nw = normalize(mat3(uCamWorld) * N);
    float flatness = smoothstep(0.6, 0.95, Nw.y);
    float ripFade = flatness * (1.0 - clamp(foamAvg * 1.2, 0.0, 1.0));
    if (ripFade > 0.0) {
      float r1 = cos(Pp.x * 2.1 + uTime * 1.7) * cos(Pp.z * 1.7 - uTime * 1.3);
      float r2 = cos(Pp.x * 4.7 - uTime * 2.6 + Pp.z * 3.9);
      vec2 grad = vec2(
        -sin(Pp.x * 2.1 + uTime * 1.7) * cos(Pp.z * 1.7 - uTime * 1.3) * 2.1 - sin(Pp.x * 4.7 - uTime * 2.6 + Pp.z * 3.9) * 4.7 * 0.5,
        cos(Pp.x * 2.1 + uTime * 1.7) * sin(Pp.z * 1.7 - uTime * 1.3) * 1.7 - sin(Pp.x * 4.7 - uTime * 2.6 + Pp.z * 3.9) * 3.9 * 0.5
      );
      vec3 ripW = normalize(vec3(-grad.x * 0.032 * ripFade, 1.0, -grad.y * 0.032 * ripFade));
      Nw = normalize(mix(Nw, ripW, ripFade * 0.38));
      N = normalize(transpose(mat3(uCamWorld)) * Nw);
    }

    vec3 V = normalize(-P);
    float ndv = clamp(dot(N, V), 0.0, 1.0);

    vec3 sunW = normalize(mat3(uCamWorld) * uSunView);
    float sVis = sunVisAt(Pw);
    if (uDebugShadow > 0.5) {
      vec3 dbg = vec3(sVis);
      if (uDebugShadow > 1.5 && uDebugShadow < 2.5) dbg = fract(Pw * 0.25);
      if (uDebugShadow > 2.5) {
        vec4 sc2 = uShadowMat * vec4(Pw, 1.0);
        vec3 uvz2 = sc2.xyz / sc2.w;
        float d2 = unpackRGBAToDepth(texture2D(uShadowMap, uvz2.xy));
        dbg = uDebugShadow > 3.5 ? vec3(uvz2.z) : vec3(d2);
        if (uDebugShadow > 4.5) dbg = vec3(uvz2.xy, 0.0);
        if (uDebugShadow > 5.5) dbg = clamp((Pw - vec3(30.0, -4.0, 13.5)) / 40.0 + 0.5, 0.0, 1.0);
      }
      gl_FragColor = vec4(dbg, 1.0);
      return;
    }

    // --- hand-painted depth bands: the sim gives true 3D shape, the color is
    // flat Ghibli cels. Band edges wobble with a slow warp = brushwork, and the
    // steps are narrow smoothsteps = crisp but antialiased. ---
    float warp = (sin(Pp.x * 1.4 + uTime * 0.8) + sin(Pp.z * 1.15 - uTime * 0.6)
                + 0.5 * sin((Pp.x + Pp.z) * 2.6 + uTime * 1.2)) * uBandWarp;
    float tw = thick + warp;
    // fwidth-AA HARD band edges: flat cels that stay crisp at any distance
    float aa = fwidth(tw) * 1.4 + 1e-4;
    vec3 base = mix(uColShallow, uColMid, smoothstep(0.9 - aa, 0.9 + aa, tw));
    base = mix(base, uColDeep, smoothstep(2.8 - aa, 2.8 + aa, tw));
    base = mix(base, uColAbyss, smoothstep(6.8 - aa, 6.8 + aa, tw));

    // shallows: the ground reads through a flat aqua wash + a crisp caustic web
    vec2 refrUv = vUv + N.xy * clamp(thick, 0.0, 3.0) * 0.03;
    float refrLin = sceneLin(refrUv);
    if (refrLin < lin) refrUv = vUv;
    vec3 seen = texture2D(uScene, refrUv).rgb * mix(vec3(1.0), uColShallow * 1.5, 0.74);
    vec2 cp = Pp.xz * 0.9 + N.xz * 1.5;
    float c1 = sin(cp.x * 3.1 + uTime * 1.2) + sin(cp.y * 2.7 - uTime * 0.9) + sin((cp.x + cp.y) * 2.2 + uTime * 0.7);
    float web = smoothstep(0.60, 0.68, clamp(c1 * 0.33 + 0.5, 0.0, 1.0));
    seen = mix(seen, uColShallow * 1.2, 0.62) * 1.15;
    seen += uColHighlight * web * 0.5 * sVis;
    float clarity = 1.0 - smoothstep(0.2, 0.85, tw);
    vec3 water = mix(base, seen, clarity * 0.7);

    // --- two-tone toon light: shadow side goes cool blue-violet, never gray ---
    float litD = dot(Nw, sunW);
    float litAA = fwidth(litD) * 1.4 + 1e-4;
    float nl = smoothstep(0.31 - litAA, 0.31 + litAA, litD);
    float lit = nl * sVis;
    // Split responses: the N|L two-tone is the gentle cel shade for ripples
    // facing away from the sun; a CAST shadow (terrain blocking the sun) cuts
    // deeper — the water sits in real shade and must read like it, or a
    // canyon stream glows against its dark walls.
    water *= mix(uColShadowMul, vec3(1.0), nl);
    water *= mix(uColCastMul, vec3(1.0), sVis);

    // palette-driven whites: sun-image highlights carry the sun's color,
    // foam's shadow side is lit by the sky (cool at noon, warm at sunset).
    // Both dim under a CAST shadow — foam in shade is sky-lit only.
    vec3 castTint = mix(vec3(0.52, 0.58, 0.78), vec3(1.0), sVis);
    vec3 hlSun = uColHighlight * uSunColor * castTint;
    vec3 hlShade = uColHighlight * uSkyCol * castTint;

    // --- stylized subsurface glow: thin water lit toward the viewer reads as
    // translucent turquoise (the Black Flag / Ponyo crest glow). Mixed, not
    // added, so it stays a flat cel — and scaled by the toon lit term so the
    // glow still comes from the sun. ---
    float backlit = clamp(dot(normalize(-P), -uSunView) * 0.5 + 0.5, 0.0, 1.0);
    float crest = smoothstep(0.22, 0.55, 1.0 - Nw.y);
    float sssAmt = (1.0 - smoothstep(0.4, 1.9, thick + warp)) * crest * mix(0.45, 1.0, lit) * (0.35 + 0.65 * backlit);
    float sssAA = fwidth(sssAmt) * 1.4 + 1e-4;
    float sssQ = smoothstep(0.34 - sssAA, 0.34 + sssAA, sssAmt);
    water = mix(water, uColSSS, sssQ * 0.5);

    // --- flat pale sky band at grazing angles (quantized fresnel, no gradient) ---
    float skyBand = smoothstep(0.55, 0.62, pow(1.0 - ndv, 2.0) + warp * 0.08);
    water = mix(water, uSkyCol, skyBand * 0.22);

    // --- painted highlight SHAPES: hard threshold on the rippled half-vector,
    // so highlights are bold wiggling white forms, not smooth pow() glints ---
    vec3 Hv = normalize(uSunView + V);
    float ndh = max(dot(N, Hv), 0.0);
    float hi = smoothstep(0.977, 0.983, ndh);
    water = mix(water, hlSun, hi * 0.9 * sVis);

    // sparse solid sparkle specks on flat surface (cel version of sun glitter)
    if (flatness > 0.0) {
      float gx = sin(Pp.x * 11.0 + uTime * 3.1) + 0.7 * sin(Pp.z * 13.0 - uTime * 2.3);
      float gz = cos(Pp.z * 12.0 + uTime * 2.7) + 0.7 * cos(Pp.x * 10.0 - uTime * 3.4);
      vec3 gW = normalize(vec3(-gx * 0.06, 1.0, -gz * 0.06));
      vec3 Ng = normalize(mix(N, normalize(transpose(mat3(uCamWorld)) * gW), 0.6));
      vec3 Rg = normalize(mat3(uCamWorld) * reflect(-V, Ng));
      float glit = step(0.9962, dot(Rg, sunW));
      water = mix(water, hlSun, glit * flatness * 0.85 * sVis);
    }

    // --- whitewater: solid scalloped white shapes (hash breaks the edge into
    // hand-drawn clumps), fully opaque like painted foam ---
    float fh = fract(sin(dot(floor(Pp.xz * 7.0), vec2(12.98, 78.23))) * 43758.55 + uTime * 0.5);
    float fVal = foamAvg + (fh - 0.5) * 0.24;
    float fAA = fwidth(fVal) * 1.4 + 1e-4;
    float foam = smoothstep(0.53 - fAA, 0.53 + fAA, fVal);
    water = mix(water, mix(hlShade, hlSun, lit), foam);

    // --- foam SPRITES: persistent churn spawned by the sim's turbulence,
    // advected with the flow. Max-blended coverage (capped union, never
    // saturates) is carved by a slow world-space swirl so the INSIDE of a
    // big foam field keeps negative-space texture (the Ghibli boil), then
    // thresholded to a solid edge = merged metaball clumps with scalloped
    // boundaries + a faint dissolving lace skirt. Opaque, paint-white,
    // two-tone lit — never additive glow. ---
    float swirl = 0.5 + 0.3 * (sin(Pp.x * 2.6 + uTime * 0.6 + Pp.z * 1.7)
               + sin(Pp.z * 3.1 - uTime * 0.45) * 0.7
               + sin((Pp.x - Pp.z) * 4.4 + uTime * 0.8) * 0.5);
    float fc = ta.z * mix(0.5, 1.2, clamp(swirl, 0.0, 1.0));
    float fTh = uFoamTh + (fh - 0.5) * 0.2;
    float fcAA = fwidth(fc) * 1.4 + 1e-4;
    float clump = smoothstep(fTh - fcAA, fTh + fcAA, fc);
    float lace = smoothstep(fTh * 0.4 - fcAA, fTh * 0.4 + fcAA, fc) * 0.35;
    water = mix(water, mix(hlShade, hlSun, lit), max(clump * 0.95, lace));

    // --- crisp white shoreline rim, scallop-broken like brushwork ---
    float edgeM = 0.0;
    edgeM = max(edgeM, step(linAt(vUv + dx * 2.0), 0.0));
    edgeM = max(edgeM, step(linAt(vUv - dx * 2.0), 0.0));
    edgeM = max(edgeM, step(linAt(vUv + dy * 2.0), 0.0));
    edgeM = max(edgeM, step(linAt(vUv - dy * 2.0), 0.0));
    // steep scallop window: the shoreline rim breaks into lapping DASHES
    // instead of a continuous chalky bathtub ring
    float scallop = smoothstep(0.42, 0.6, 0.5 + 0.5 * sin(uTime * 1.8 + Pp.x * 4.2 + Pp.z * 3.6));
    float shore = edgeM * (1.0 - smoothstep(1.0, 3.0, thick)) * scallop;
    // contact ring: where the water surface nearly touches the ground behind
    // it (view-ray gap), a scalloped white lapping band — the Ghibli shoreline.
    float gap = sLin - lin;
    float ring = (1.0 - smoothstep(0.12, 0.85, gap)) * smoothstep(0.02, 0.1, gap);
    float ringScallop = smoothstep(0.35, 0.6, 0.5 + 0.5 * sin(uTime * 1.4 + Pp.x * 5.1 - Pp.z * 4.4) * cos(Pp.z * 3.3 + uTime * 0.9));
    water = mix(water, mix(hlShade, hlSun, lit), max(shore * 0.75, ring * ringScallop * 0.8));

    float dist = length(P);
    float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
    water = mix(water, uFogColor, fog);

    // --- surface (dense body) vs spray (thin AND fast/airborne) split ---
    // spray = solid painted droplets, mixed in (not additive) so they stay cel.
    float surfConf = smoothstep(uThinLo, uThinHi, thick);
    // airborne bar sits high on purpose: a thin FLOWING sheet must stay blue
    // water — only genuinely fast broken crests/droplets read as spray, else
    // a whole rapid paints itself solid white
    float airborne = smoothstep(0.52, 0.78, foamAvg);
    float sprayAmt = (1.0 - surfConf) * smoothstep(0.1 * uCovScale, uThinLo, thick) * airborne;

    // thin slow water shows as faint clear water, but a floor erases isolated
    // single-particle splats (settled droplets on terrain) so they don't fuzz.
    // The floors scale with drop size (uCovScale): they exist to erase
    // SUB-PARTICLE noise, so "one particle worth of water" must clear them at
    // any scale — at fine scales a real one-drop sheet reads ~scale x the
    // coarse thickness and would otherwise vanish. Depth COLOR bands above
    // stay absolute: physical depth keeps one meaning across scales.
    float bodyCov = smoothstep(0.06 * uCovScale, 0.3 * uCovScale, thick + foam * 0.3) * max(surfConf, (1.0 - airborne) * smoothstep(0.65 * uCovScale, 1.2 * uCovScale, thick));
    outCol = mix(sceneCol, water, bodyCov);
    // spray = SOLID painted droplet clusters: hash-scalloped hard edge, near
    // fully opaque, paint-white two-tone — never a translucent gray mist.
    float sprayM = sprayAmt + (fh - 0.5) * 0.2;
    float spAA = fwidth(sprayM) * 1.4 + 1e-4;
    float spray = smoothstep(0.42 - spAA, 0.42 + spAA, sprayM);
    outCol = mix(outCol, mix(hlShade, hlSun, lit), spray * 0.8);

    }
    gl_FragColor = vec4(outCol, 1.0);
    #include <colorspace_fragment>
  }
`;

// THREE is injected (TinyWorld loads three dynamically from esm.sh — a
// bundled "three" import here would be a second, incompatible instance).
// unitScale = world units per sandbox unit (1 in the sandbox; TinyWorld
// passes its voxel size so the tuned look carries over unchanged). Type
// annotations referencing THREE.* remain type-only — vite strips them.
export function createFluidRenderer(
  THREE: any,
  renderer: THREE.WebGLRenderer,
  maxN: number,
  particleD: number,
  unitScale = 1,
): FluidRenderer {
  // No MSAA on the scene target: a 4x multisampled sceneRT costs a full
  // resolve every frame plus 4x depth/color fill for the whole opaque scene,
  // and dpr>1 already supersamples the blocky terrain. Water edges never used
  // it (the fluid surface is reconstructed in the composite, not rasterized).
  const rtOpts: THREE.RenderTargetOptions = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  };
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, rtOpts);
  sceneRT.depthTexture = new THREE.DepthTexture(2, 2);
  sceneRT.depthTexture.type = THREE.UnsignedIntType;

  const depthOpts: THREE.RenderTargetOptions = {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.FloatType,
    depthBuffer: true,
  };
  const depthRT = new THREE.WebGLRenderTarget(2, 2, depthOpts);
  const blurA = new THREE.WebGLRenderTarget(2, 2, { ...depthOpts, depthBuffer: false });
  const blurB = new THREE.WebGLRenderTarget(2, 2, { ...depthOpts, depthBuffer: false });
  // Persistent home of the FINAL smoothed depth. The composite always reads
  // this target; next frame's warm-start seed reads it back; static frames
  // (Lever 3) reuse it wholesale. Invalidated on resize/rescale.
  const histRT = new THREE.WebGLRenderTarget(2, 2, { ...depthOpts, depthBuffer: false });
  let histValid = false;
  const thickRT = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const thickA = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const thickB = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });

  const quadGeo = new THREE.InstancedBufferGeometry();
  const corners = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  quadGeo.setAttribute("position", new THREE.BufferAttribute(corners, 3));
  quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(maxN * 3), 3);
  iPos.setUsage(THREE.DynamicDrawUsage);
  const iSpeed = new THREE.InstancedBufferAttribute(new Float32Array(maxN), 1);
  iSpeed.setUsage(THREE.DynamicDrawUsage);
  quadGeo.setAttribute("iPos", iPos);
  quadGeo.setAttribute("iSpeed", iSpeed);
  quadGeo.instanceCount = 0;

  // Threshold base = the SANDBOX base drop (0.6) scaled to world units, NOT
  // the construction particleD — so s in setParticleD equals the drop tier at
  // any world scale (sandbox behavior unchanged at unitScale 1, scale 1).
  const baseD = 0.6 * unitScale;
  const RADIUS = particleD * 0.85;
  const depthMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: DEPTH_FRAG,
    uniforms: {
      uRadius: { value: RADIUS },
      uProj: { value: new THREE.Matrix4() },
      uSceneDepth: { value: sceneRT.depthTexture },
      uInvRes: { value: new THREE.Vector2() },
    },
  });
  const thickMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: THICK_FRAG,
    uniforms: {
      uRadius: { value: RADIUS * 1.4 },
      uProj: { value: new THREE.Matrix4() },
      uSceneDepth: { value: sceneRT.depthTexture },
      uInvRes: { value: new THREE.Vector2() },
    },
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });

  const depthMesh = new THREE.Mesh(quadGeo, depthMat);
  depthMesh.frustumCulled = false;
  const depthScene = new THREE.Scene();
  depthScene.add(depthMesh);

  const thickMesh = new THREE.Mesh(quadGeo, thickMat);
  thickMesh.frustumCulled = false;
  const thickScene = new THREE.Scene();
  thickScene.add(thickMesh);

  const foamGeo = new THREE.InstancedBufferGeometry();
  foamGeo.setAttribute("position", new THREE.BufferAttribute(corners, 3));
  foamGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const foamPos = new THREE.InstancedBufferAttribute(new Float32Array(4096 * 3), 3);
  foamPos.setUsage(THREE.DynamicDrawUsage);
  const foamFade = new THREE.InstancedBufferAttribute(new Float32Array(4096), 1);
  foamFade.setUsage(THREE.DynamicDrawUsage);
  foamGeo.setAttribute("iPos", foamPos);
  foamGeo.setAttribute("iSpeed", foamFade);
  foamGeo.instanceCount = 0;
  const foamMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: FOAM_FRAG,
    uniforms: {
      uRadius: { value: particleD * 1.0 },
      uProj: { value: new THREE.Matrix4() },
      uSceneDepth: { value: sceneRT.depthTexture },
      uInvRes: { value: new THREE.Vector2() },
    },
    // MAX blending, not additive: coverage is the UNION of sprites capped at
    // 1, so dense churn can't saturate into one solid cap — the composite's
    // swirl carve keeps visible texture inside big foam fields.
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const foamMesh = new THREE.Mesh(foamGeo, foamMat);
  foamMesh.frustumCulled = false;
  thickScene.add(foamMesh);

  const fsGeo = new THREE.PlaneGeometry(2, 2);
  const blurMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: BLUR_FRAG,
    uniforms: {
      uDepth: { value: null as THREE.Texture | null },
      uDir: { value: new THREE.Vector2(1, 0) },
      uInvRes: { value: new THREE.Vector2() },
      uThresh: { value: particleD * 1.6 },
      uWorldK: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const curvMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: CURV_FRAG,
    uniforms: {
      uDepth: { value: null as THREE.Texture | null },
      uInvRes: { value: new THREE.Vector2() },
      uCxy: { value: new THREE.Vector2() },
      uDtFrac: { value: 0.6 },
      uThresh: { value: particleD * 1.6 },
    },
    depthTest: false,
    depthWrite: false,
  });
  // smoothing knobs, tunable live via __ws.fluid.smooth
  // div: the depth splat + smoothing chain runs on 1/div-res internal buffers
  // (output resolution untouched — composite shades every native pixel). At
  // div=2 each pass covers 4x fewer pixels AND bumps are half as many pixels
  // wide, so far fewer iterations reach the same world-space smoothness.
  // dtFrac: in the flat limit the per-iteration pixel-space diffusion coeff is
  // dtFrac/2 — keep dtFrac <= ~0.5 (coeff 0.25, the classic explicit-scheme
  // bound). 0.8 rings: verified live as blue stipple noise along shore bands
  // (stipple energy 0.70 -> 0.47 when dropped to 0.5 with more iterations).
  // curvIters: iterations needed for a given WORLD-space smoothness scale
  // with (pixels per particle bump)^2, i.e. with buffer resolution squared.
  // 110 was calibrated at dpr=2; the page now caps dpr at 1.5 (0.75x linear
  // res), so 110 * 0.75^2 ~= 62 reaches the same world-space smoothing for
  // ~44% of the per-pass pixels AND ~56% of the passes.
  // warm: temporal warm-start ON — curvIters (62) is the COLD count, used on
  // the first frame after any invalidation; warm frames re-converge from the
  // reprojected history in warmIters. warmBlend = seed weight toward history
  // (raw injection = 1-blend). A/B the old path live: smooth({warm:false}).
  const smoothCfg = { mode: "curv" as "curv" | "gauss", curvIters: 62, dtFrac: 0.5, preGauss: 2, gaussIters: 3, div: 2, warm: true, warmIters: 12, warmBlend: 0.85 };
  const warmMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: WARM_FRAG,
    uniforms: {
      uRaw: { value: null as THREE.Texture | null },
      uPrev: { value: histRT.texture },
      uThresh: { value: particleD * 1.6 },
      uBlend: { value: smoothCfg.warmBlend },
      uProjXY: { value: new THREE.Vector2(1, 1) },
      uPrevProjXY: { value: new THREE.Vector2(1, 1) },
      uCamWorld: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uPrevCamWorld: { value: new THREE.Matrix4() },
    },
    depthTest: false,
    depthWrite: false,
  });
  const copyMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: COPY_FRAG,
    uniforms: { uTex: { value: null as THREE.Texture | null } },
    depthTest: false,
    depthWrite: false,
  });
  const prevView = new THREE.Matrix4();
  const prevProj = new THREE.Matrix4();
  const prevCamWorld = new THREE.Matrix4();
  const compMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: COMPOSITE_FRAG,
    uniforms: {
      uScene: { value: sceneRT.texture },
      uSceneDepth: { value: sceneRT.depthTexture },
      uFluidDepth: { value: null as THREE.Texture | null },
      uThick: { value: thickRT.texture },
      uInvRes: { value: new THREE.Vector2() },
      uProjXY: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 400 },
      uCamWorld: { value: new THREE.Matrix4() },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1.0, 0.96, 0.89) },
      uSkyCol: { value: new THREE.Color(0.74, 0.86, 0.94) },
      uFogColor: { value: new THREE.Color("#0a141d") },
      uFogRange: { value: new THREE.Vector2(70 * unitScale, 160 * unitScale) },
      uTime: { value: 0 },
      uThinLo: { value: 0.9 },
      uThinHi: { value: 2.6 },
      uCovScale: { value: 1 },
      uColShallow: { value: new THREE.Color(0.45, 0.85, 0.85) },
      uColMid: { value: new THREE.Color(0.16, 0.55, 0.85) },
      uColDeep: { value: new THREE.Color(0.07, 0.31, 0.65) },
      uColAbyss: { value: new THREE.Color(0.04, 0.17, 0.45) },
      uColShadowMul: { value: new THREE.Color(0.62, 0.71, 0.97) },
      uColCastMul: { value: new THREE.Color(0.45, 0.52, 0.8) },
      uColHighlight: { value: new THREE.Color(0.96, 0.99, 1.0) },
      uColSSS: { value: new THREE.Color(0.45, 0.96, 0.95) },
      uBandWarp: { value: 0.22 },
      uFoamTh: { value: 0.34 },
      uWorldScale: { value: unitScale },
      uDebugShadow: { value: 0 },
      uShadowMap: { value: null as THREE.Texture | null },
      uShadowMat: { value: new THREE.Matrix4() },
      uShadowRes: { value: new THREE.Vector2(2048, 2048) },
      uShadowOn: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blurScene = new THREE.Scene();
  const blurMesh = new THREE.Mesh(fsGeo, blurMat);
  blurScene.add(blurMesh);
  const curvScene = new THREE.Scene();
  const curvMesh = new THREE.Mesh(fsGeo, curvMat);
  curvScene.add(curvMesh);
  const warmScene = new THREE.Scene();
  warmScene.add(new THREE.Mesh(fsGeo, warmMat));
  const copyScene = new THREE.Scene();
  copyScene.add(new THREE.Mesh(fsGeo, copyMat));
  const thickBlurMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: THICK_BLUR_FRAG,
    uniforms: {
      uTex: { value: null as THREE.Texture | null },
      uDir: { value: new THREE.Vector2(1, 0) },
      uInvRes: { value: new THREE.Vector2() },
    },
    depthTest: false,
    depthWrite: false,
  });
  const thickBlurScene = new THREE.Scene();
  thickBlurScene.add(new THREE.Mesh(fsGeo, thickBlurMat));
  const compScene = new THREE.Scene();
  const compMesh = new THREE.Mesh(fsGeo, compMat);
  compScene.add(compMesh);

  let shadowsOn = true;
  let W = 2;
  let H = 2;
  const t0 = performance.now();
  // Static-skip (Lever 3) bookkeeping: when nothing that feeds the offscreen
  // targets changed — particle positions, foam, camera, scene content — every
  // pass except the (time-animated) composite is skipped and the cached
  // targets are reused. The page opts in by simply not calling
  // updateParticles/updateFoam when the sim is fully asleep.
  let particlesDirty = true;
  let foamDirty = true;
  let sceneDirty = true;
  let lastCamSame = false;
  // Float64 — matrix elements are doubles; a float32 snapshot truncates and
  // the equality compare then fails on every frame.
  const camSnap = new Float64Array(32);
  let camSnapValid = false;
  const perfState = { mode: "full" as "full" | "static", itersRun: 0, staticFrames: 0 };

  function cameraUnchanged(camera: THREE.PerspectiveCamera): boolean {
    const a = camera.matrixWorld.elements;
    const b = camera.projectionMatrix.elements;
    let same = camSnapValid;
    for (let i = 0; i < 16; i++) {
      if (camSnap[i] !== a[i] || camSnap[16 + i] !== b[i]) { same = false; break; }
    }
    for (let i = 0; i < 16; i++) {
      camSnap[i] = a[i];
      camSnap[16 + i] = b[i];
    }
    camSnapValid = true;
    return same;
  }

  function resize(w: number, h: number) {
    W = w;
    H = h;
    const pr = renderer.getPixelRatio();
    const pw = Math.round(w * pr);
    const ph = Math.round(h * pr);
    // smoothing-chain buffers at 1/div res; scene + composite stay native
    const div = Math.max(1, smoothCfg.div | 0);
    const sw = Math.max(2, Math.round(pw / div));
    const sh = Math.max(2, Math.round(ph / div));
    sceneRT.setSize(pw, ph);
    depthRT.setSize(sw, sh);
    blurA.setSize(sw, sh);
    blurB.setSize(sw, sh);
    histRT.setSize(sw, sh);
    histValid = false;
    sceneDirty = true;
    thickRT.setSize(pw >> 1, ph >> 1);
    thickA.setSize(pw >> 1, ph >> 1);
    thickB.setSize(pw >> 1, ph >> 1);
    thickBlurMat.uniforms.uInvRes.value.set(1 / (pw >> 1), 1 / (ph >> 1));
    depthMat.uniforms.uInvRes.value.set(1 / sw, 1 / sh);
    blurMat.uniforms.uInvRes.value.set(1 / sw, 1 / sh);
    curvMat.uniforms.uInvRes.value.set(1 / sw, 1 / sh);
    // composite's uInvRes is only used to step between FLUID-depth texels
    // (normal reconstruction + edge mask), so it tracks the smoothing buffers
    compMat.uniforms.uInvRes.value.set(1 / sw, 1 / sh);
    thickMat.uniforms.uInvRes.value.set(1 / (pw >> 1), 1 / (ph >> 1));
    foamMat.uniforms.uInvRes.value.set(1 / (pw >> 1), 1 / (ph >> 1));
  }

  function updateParticles(pos: Float32Array, speed: Float32Array, count: number) {
    (iPos.array as Float32Array).set(pos.subarray(0, count * 3));
    const sp = iSpeed.array as Float32Array;
    for (let i = 0; i < count; i++) sp[i] = Math.min(1, speed[i] / 9);
    iPos.needsUpdate = true;
    iSpeed.needsUpdate = true;
    quadGeo.instanceCount = count;
    particlesDirty = true;
  }

  function updateFoam(pos: Float32Array, fade: Float32Array, count: number) {
    const n = Math.min(count, foamFade.array.length);
    (foamPos.array as Float32Array).set(pos.subarray(0, n * 3));
    (foamFade.array as Float32Array).set(fade.subarray(0, n));
    foamPos.needsUpdate = true;
    foamFade.needsUpdate = true;
    foamGeo.instanceCount = n;
    foamDirty = true;
  }

  function render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sunDirWorld: THREE.Vector3, sunLight?: THREE.DirectionalLight) {
    const prevTarget = renderer.getRenderTarget();
    camera.updateMatrixWorld();
    const camSame = cameraUnchanged(camera);
    lastCamSame = camSame;

    // Lever 3: fully static frame — every offscreen input is unchanged, so
    // reuse sceneRT / histRT / thickB and run only the composite (its ripples,
    // foam swirl and glints are time-animated there, so the water stays alive).
    if (camSame && !particlesDirty && !foamDirty && !sceneDirty && histValid) {
      perfState.mode = "static";
      perfState.itersRun = 0;
      perfState.staticFrames++;
      compMat.uniforms.uTime.value = (performance.now() - t0) / 1000;
      renderer.setRenderTarget(prevTarget);
      renderer.render(compScene, fsCam);
      return;
    }
    perfState.mode = "full";
    perfState.staticFrames = 0;

    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(compMat.uniforms.uFogColor.value as THREE.Color, 1);
    renderer.clear();
    renderer.render(scene, camera);

    depthMat.uniforms.uProj.value.copy(camera.projectionMatrix);
    thickMat.uniforms.uProj.value.copy(camera.projectionMatrix);
    foamMat.uniforms.uProj.value.copy(camera.projectionMatrix);
    renderer.setRenderTarget(depthRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(depthScene, camera);

    blurMat.uniforms.uWorldK.value = (depthRT.height / (2 * Math.tan((camera.fov * Math.PI) / 360))) * particleD * 0.7;
    let src: THREE.WebGLRenderTarget = depthRT;
    const gaussPasses = smoothCfg.mode === "gauss" ? smoothCfg.gaussIters : smoothCfg.preGauss;
    for (let it = 0; it < gaussPasses; it++) {
      blurMat.uniforms.uDepth.value = src.texture;
      blurMat.uniforms.uDir.value.set(1, 0);
      renderer.setRenderTarget(blurA);
      renderer.render(blurScene, fsCam);
      blurMat.uniforms.uDepth.value = blurA.texture;
      blurMat.uniforms.uDir.value.set(0, 1);
      renderer.setRenderTarget(blurB);
      renderer.render(blurScene, fsCam);
      src = blurB;
    }
    if (smoothCfg.mode === "curv" && smoothCfg.curvIters > 0) {
      curvMat.uniforms.uCxy.value.set(
        2 / (depthRT.width * camera.projectionMatrix.elements[0]),
        2 / (depthRT.height * camera.projectionMatrix.elements[5]),
      );
      curvMat.uniforms.uDtFrac.value = smoothCfg.dtFrac;
      let ping: THREE.WebGLRenderTarget = src === blurA ? blurB : blurA;
      const warmHot = smoothCfg.warm && histValid && smoothCfg.warmIters > 0;
      if (warmHot) {
        // Lever 1: seed from last frame's converged surface (reprojected),
        // then re-converge in warmIters instead of the cold curvIters.
        warmMat.uniforms.uRaw.value = src.texture;
        warmMat.uniforms.uThresh.value = curvMat.uniforms.uThresh.value;
        warmMat.uniforms.uBlend.value = smoothCfg.warmBlend;
        (warmMat.uniforms.uProjXY.value as THREE.Vector2).set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
        (warmMat.uniforms.uPrevProjXY.value as THREE.Vector2).set(prevProj.elements[0], prevProj.elements[5]);
        (warmMat.uniforms.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
        (warmMat.uniforms.uView.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
        (warmMat.uniforms.uPrevVP.value as THREE.Matrix4).multiplyMatrices(prevProj, prevView);
        (warmMat.uniforms.uPrevCamWorld.value as THREE.Matrix4).copy(prevCamWorld);
        renderer.setRenderTarget(ping);
        renderer.render(warmScene, fsCam);
        const swap = src === depthRT ? (ping === blurA ? blurB : blurA) : src;
        src = ping;
        ping = swap;
      }
      const iters = warmHot ? smoothCfg.warmIters : smoothCfg.curvIters;
      perfState.itersRun = iters;
      for (let it = 0; it < iters; it++) {
        curvMat.uniforms.uDepth.value = src.texture;
        renderer.setRenderTarget(ping);
        renderer.render(curvScene, fsCam);
        const swap = src === depthRT ? (ping === blurA ? blurB : blurA) : src;
        src = ping;
        ping = swap;
      }
    } else {
      perfState.itersRun = 0;
    }
    // Persist the final smoothed depth: composite reads it now, the warm seed
    // reads it next frame, static frames reuse it outright.
    copyMat.uniforms.uTex.value = src.texture;
    renderer.setRenderTarget(histRT);
    renderer.render(copyScene, fsCam);
    histValid = true;
    prevView.copy(camera.matrixWorldInverse);
    prevProj.copy(camera.projectionMatrix);
    prevCamWorld.copy(camera.matrixWorld);

    renderer.setRenderTarget(thickRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(thickScene, camera);
    for (let it = 0; it < 2; it++) {
      thickBlurMat.uniforms.uTex.value = (it === 0 ? thickRT : thickB).texture;
      thickBlurMat.uniforms.uDir.value.set(1, 0);
      renderer.setRenderTarget(thickA);
      renderer.render(thickBlurScene, fsCam);
      thickBlurMat.uniforms.uTex.value = thickA.texture;
      thickBlurMat.uniforms.uDir.value.set(0, 1);
      renderer.setRenderTarget(thickB);
      renderer.render(thickBlurScene, fsCam);
    }
    compMat.uniforms.uThick.value = thickB.texture;

    compMat.uniforms.uFluidDepth.value = histRT.texture;
    compMat.uniforms.uProjXY.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    compMat.uniforms.uNear.value = camera.near;
    compMat.uniforms.uFar.value = camera.far;
    compMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    compMat.uniforms.uSunView.value.copy(sunDirWorld).transformDirection(camera.matrixWorldInverse).normalize();
    const shadow = shadowsOn ? sunLight?.shadow : undefined;
    if (shadow?.map) {
      compMat.uniforms.uShadowMap.value = shadow.map.texture;
      (compMat.uniforms.uShadowMat.value as THREE.Matrix4).copy(shadow.matrix);
      (compMat.uniforms.uShadowRes.value as THREE.Vector2).set(shadow.mapSize.x, shadow.mapSize.y);
      compMat.uniforms.uShadowOn.value = 1;
    } else {
      compMat.uniforms.uShadowOn.value = 0;
    }
    compMat.uniforms.uTime.value = (performance.now() - t0) / 1000;
    renderer.setRenderTarget(prevTarget);
    renderer.render(compScene, fsCam);
    renderer.setClearColor(compMat.uniforms.uFogColor.value as THREE.Color, 1);
    particlesDirty = false;
    foamDirty = false;
    sceneDirty = false;
  }

  function dispose() {
    for (const rt of [sceneRT, depthRT, blurA, blurB, histRT, thickRT, thickA, thickB]) rt.dispose();
    quadGeo.dispose();
    foamGeo.dispose();
    fsGeo.dispose();
    for (const m of [depthMat, thickMat, foamMat, blurMat, curvMat, warmMat, copyMat, thickBlurMat, compMat]) m.dispose();
  }

  function smooth(cfg: Partial<typeof smoothCfg> = {}) {
    if (Object.keys(cfg).length === 0) return { ...smoothCfg };
    const prevDiv = smoothCfg.div;
    Object.assign(smoothCfg, cfg);
    if (smoothCfg.div !== prevDiv && W > 2) resize(W, H);
    histValid = false;
    sceneDirty = true;
    return { ...smoothCfg };
  }

  function shadows(on: boolean) {
    shadowsOn = on;
    sceneDirty = true;
    return shadowsOn;
  }

  // Force the next frame down the full path (scene/light/uniform changed
  // outside the renderer's view — e.g. the page's sky() presets).
  function markSceneDirty() {
    sceneDirty = true;
  }

  function perf() {
    return { ...perfState, flags: { particlesDirty, foamDirty, sceneDirty, histValid, lastCamSame } };
  }

  // Retune every splat/smoothing size derived from the particle diameter —
  // the drop-size control calls this when the sim rebuilds at a new scale.
  // Scale-invariance split: splat/smoothing radii track the drop (physics
  // footprint), coverage FLOORS track the drop (sub-particle noise gates),
  // foam sprite size stays BASE (cosmetic layer, its look is scale-free),
  // and the composite's depth-color bands stay absolute (physical depth).
  function setParticleD(d: number) {
    particleD = d;
    const s = d / baseD;
    depthMat.uniforms.uRadius.value = d * 0.85;
    thickMat.uniforms.uRadius.value = d * 0.85 * 1.4;
    blurMat.uniforms.uThresh.value = d * 1.6;
    curvMat.uniforms.uThresh.value = d * 1.6;
    warmMat.uniforms.uThresh.value = d * 1.6;
    histValid = false;
    sceneDirty = true;
    compMat.uniforms.uThinLo.value = 0.9 * s;
    compMat.uniforms.uThinHi.value = 2.6 * s;
    compMat.uniforms.uCovScale.value = s;
  }

  return { updateParticles, updateFoam, render, resize, dispose, smooth, shadows, setParticleD, markSceneDirty, perf, _u: compMat.uniforms as Record<string, { value: unknown }> };
}
