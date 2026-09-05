// tw-sky — time-of-day sky dome (rung 1 of the Sep 5 lighting rework).
// A camera-following backside sphere that replaces the flat scene.background
// with: a vertical horizon→zenith gradient, a horizon glow banked around the
// sun's real azimuth (strongest at dawn/dusk via the palette's gloI), a sun
// disc + halo, a moon disc, and procedural hash stars that fade in with
// nightness. Purely presentational: it reads the palette + solar geometry the
// app already computes and draws behind everything (depthWrite off, z pushed
// to the far plane), so lighting, fog, water and clouds are untouched.
// scene.background stays live underneath — voxel clouds keep sampling it.

export type SkyPalette = {
  zen: number;   // zenith color (sRGB hex)
  hor: number;   // horizon color
  glo: number;   // glow color banked at the sun's azimuth
  gloI: number;  // glow intensity (phase-authored: dawn/dusk high)
  night: number; // 0..1 star/moon visibility
};

export function createSkyDome(opts: {
  THREE: any;
  scene: any;
  camera: any;
  radius?: number;
}) {
  const { THREE, scene, camera } = opts;
  const R = opts.radius ?? Math.max(60, (camera?.far ?? 500) * 0.92);

  const uniforms = {
    uZenith: { value: new THREE.Color(0x3f86e0) },
    uHorizon: { value: new THREE.Color(0xb4d7f2) },
    uGlowColor: { value: new THREE.Color(0xfff0d8) },
    uGlowI: { value: 0.18 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // Pin to the far plane so the dome always sits behind the scene.
        gl_Position.z = gl_Position.w * 0.99995;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGlowColor;
      uniform float uGlowI;
      uniform vec3 uSunDir;
      uniform vec3 uMoonDir;
      uniform float uNight;
      uniform float uTime;
      varying vec3 vDir;

      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;

        // Vertical gradient: horizon band easing into the zenith.
        float g = pow(smoothstep(-0.02, 0.62, h), 0.75);
        vec3 col = mix(uHorizon, uZenith, g);
        // Below the horizon line the dome darkens (seen past island edges).
        col *= 1.0 - 0.35 * smoothstep(0.0, -0.35, h);

        // Horizon glow banked around the sun's azimuth. azFac concentrates it
        // toward the sun bearing; bank hugs the horizon and fades with height.
        vec3 sunN = normalize(uSunDir + vec3(1e-5));
        vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5));
        vec3 dirH = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-5));
        float az = max(dot(sunH, dirH), 0.0);
        float bank = exp(-max(h, 0.0) * 5.0) * smoothstep(-0.30, 0.02, h);
        col += uGlowColor * (uGlowI * pow(az, 3.0) * bank);
        // Wider, subtler forward-scatter that climbs a little higher.
        col += uGlowColor * (uGlowI * 0.15 * pow(az, 8.0) * exp(-max(h, 0.0) * 2.0));

        // Sun disc + halo (fades out as the sun sinks below the horizon).
        float sd = dot(dir, sunN);
        float sunVis = smoothstep(-0.06, 0.0, uSunDir.y);
        col += vec3(1.0, 0.92, 0.78) * smoothstep(0.99960, 0.99985, sd) * 3.0 * sunVis;
        col += uGlowColor * pow(max(sd, 0.0), 180.0) * 0.5 * sunVis;

        // Moon disc — cool, tied to nightness (moonDir rides the anti-solar arc).
        float md = dot(dir, normalize(uMoonDir + vec3(1e-5)));
        float mdisc = smoothstep(0.99965, 0.99988, md);
        col += vec3(0.86, 0.90, 1.00) * mdisc * 1.6 * uNight;
        col += vec3(0.50, 0.60, 0.90) * pow(max(md, 0.0), 220.0) * 0.35 * uNight;

        // Procedural stars: hashed cells on the direction sphere, magnitude
        // variation + slow twinkle, fading near the horizon and vs the glow.
        float starVis = uNight * smoothstep(0.03, 0.18, h);
        if (starVis > 0.003) {
          vec3 sp = dir * 92.0;
          vec3 cell = floor(sp);
          vec3 f = fract(sp);
          float hsh = hash13(cell);
          if (hsh > 0.80) {
            vec3 spos = vec3(hash13(cell + 11.0), hash13(cell + 23.0), hash13(cell + 37.0));
            float d = length(f - spos);
            float star = smoothstep(0.16, 0.02, d);
            float tw = 0.72 + 0.28 * sin(uTime * (1.5 + hsh * 3.0) + hsh * 41.0);
            float mag = 0.35 + 0.65 * smoothstep(0.80, 0.995, hsh);
            col += vec3(0.90, 0.94, 1.00) * (star * tw * mag * starVis * 1.4);
          }
        }

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const geo = new THREE.SphereGeometry(R, 48, 24);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  scene.add(mesh);

  return {
    mesh,
    uniforms,
    // Palette + celestial state. sunDir must be the RAW (unclamped) solar
    // direction so the glow banks where the sun actually is, including below
    // the horizon at dusk.
    update(p: SkyPalette, sunDir: { x: number; y: number; z: number }, moonDir: { x: number; y: number; z: number }) {
      uniforms.uZenith.value.setHex(p.zen);
      uniforms.uHorizon.value.setHex(p.hor);
      uniforms.uGlowColor.value.setHex(p.glo);
      uniforms.uGlowI.value = p.gloI;
      uniforms.uNight.value = p.night;
      uniforms.uSunDir.value.set(sunDir.x, sunDir.y, sunDir.z).normalize();
      uniforms.uMoonDir.value.set(moonDir.x, moonDir.y, moonDir.z).normalize();
    },
    // Per-frame: dome follows the camera; time drives star twinkle.
    frame(camPos: { x: number; y: number; z: number }, timeSec: number) {
      mesh.position.set(camPos.x, camPos.y, camPos.z);
      uniforms.uTime.value = timeSec;
    },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
