// Shared "liquid surface" material treatment for TinyWorld water.
//
// Design unlock (KJ, Jul 25): water is never a pick-up/move target, so it does
// NOT need to render as independent editable cubes — it can read as a liquid
// surface. This is a PURE RENDERING layer: it only rewrites a water material's
// shader. It never touches authoritative world data (the water slotMap that
// settleWaterNear owns, the spring reservoir, or the RayGI occupancy volume,
// which still excludes water because water transmits light).
//
// Two water paths share this so all water reads the same:
//   1. scan / saved-world water  → addLayer(layers.water) in tw-staging-app.tsx
//   2. runtime spring water      → water-spring-runtime.ts (still lake + falls)
//
// Effects (on an existing MeshStandardMaterial, instanced cubes):
//   • surface emphasis  — top faces stay crisp/reflective; side faces drop to
//     ~0.55 alpha, so the stack reads as a surface with a translucent body
//     instead of a solid blue box.
//   • animated ripples  — three crossing cosine wave trains over world XZ (two
//     coarse swells + one fine chop) perturb the shading normal on the TOP
//     face → moving glints (uTime driven).
//   • moving sun spec   — a DUAL-lobe highlight (broad sheen + tight sparkle)
//     that slides with the ripples, using the live sun direction (uSunDir),
//     world→view transformed. Reads wet, not plastic.
//   • sky reflection    — at grazing angles the top face reflects the live sky
//     palette (uSkyCol), so water reads reflective/alive instead of flat matte
//     blue. Localised to the water surface (fresnel × top), so it never washes
//     the scene. Doctrine-compliant: the sky is a real light source.
//   • depth tint        — deeper water (lower world Y vs the column top,
//     uWaterTopY) reads darker teal; shallows stay clear and brighter.
//   • Schlick fresnel   — alpha ramps to opaque at grazing angles (kept).
//   • flow foam (V3)    — per-instance `aFlow` attribute (dirX, dirZ, foam01)
//     drives white-water: foam is a HIGH-ALBEDO surface (near-white diffuse,
//     still lit only by the real scene lights — never additive emission, so it
//     stays doctrine-compliant), with a fast chop train stretched ALONG the
//     flow direction, damped sun sparkle (foam is rough), and opaque alpha.
//     Geometry without the attribute (scan water) or momentum-off reads
//     aFlow = 0 → bit-identical calm V2 look.
//
// NOTE: three's fragment prefix declares `viewMatrix` but NOT `normalMatrix`,
// so world→view direction transforms go through `viewMatrix`.

export interface WaterSurfaceUniforms {
  uTime: { value: number };
  uSunDir: { value: any };            // THREE.Vector3, world space
  uWaterTopY: { value: number };      // world Y of the water surface (for depth tint)
  uSkyCol: { value: any };            // THREE.Color, live sky-half palette (sky reflection)
}

// three r154+ renamed <output_fragment> -> <opaque_fragment>; this patch was
// authored against the old name and silently matched nothing on three@0.165
// (scan-water sun glint / fresnel alpha never ran). ?fxanchor=0 restores the
// dead anchor for an on-device A/B, same switch as the tw-staging-app patches.
const WATER_OUT_ANCHOR =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("fxanchor") === "0"
    ? "#include <output_fragment>"
    : "#include <opaque_fragment>";

export function installWaterSurface(
  THREE: any,
  material: any,
  opts: { waterTopY?: number; sunDir?: any; skyCol?: any } = {},
): WaterSurfaceUniforms {
  const uniforms: WaterSurfaceUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: (opts.sunDir && opts.sunDir.clone)
      ? opts.sunDir.clone()
      : new THREE.Vector3(0.4, 1.0, 0.3).normalize() },
    uWaterTopY: { value: typeof opts.waterTopY === "number" ? opts.waterTopY : 0 },
    uSkyCol: { value: (opts.skyCol && opts.skyCol.clone)
      ? opts.skyCol.clone()
      : new THREE.Color(0.32, 0.46, 0.66) },
  };
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uWaterTopY = uniforms.uWaterTopY;
    shader.uniforms.uSkyCol = uniforms.uSkyCol;
    shader.vertexShader =
      "attribute vec3 aFlow;\nvarying vec3 vWaterWorld;\nvarying vec3 vWaterFaceN;\nvarying vec3 vWaterFlow;\n"
      + shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vWaterWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         vWaterFaceN = normalize(mat3(instanceMatrix) * normal);
         vWaterFlow = aFlow;`,
      );
    shader.fragmentShader =
      "uniform float uTime;\nuniform vec3 uSunDir;\nuniform float uWaterTopY;\nuniform vec3 uSkyCol;\nvarying vec3 vWaterWorld;\nvarying vec3 vWaterFaceN;\nvarying vec3 vWaterFlow;\n"
      + shader.fragmentShader
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          // Depth tint: deep water pulls toward a saturated teal, shallow water
          // stays clear and slightly brighter, so the pool reads with body.
          // V3 foam: white-water is a rough high-albedo SURFACE — near-white
          // diffuse lit by the real lights, patterned by a fast chop train
          // running ALONG the per-instance flow direction. foam01 = 0 (calm,
          // scan water, momentum off) leaves the V2 look untouched.
          `float _wDepth = clamp((uWaterTopY - vWaterWorld.y) * 0.5, 0.0, 1.0);
           vec3 _wDeep = diffuse * vec3(0.30, 0.55, 0.72);
           vec3 _wShallow = mix(diffuse, diffuse * vec3(0.62, 0.86, 0.98), 0.35);
           vec3 _wCol = mix(_wShallow, _wDeep, _wDepth);
           float _fTop = smoothstep(0.35, 0.85, vWaterFaceN.y);
           vec2 _wFlowDir = vWaterFlow.xy;
           float _wFlowMag = length(_wFlowDir);
           _wFlowDir = _wFlowMag > 0.001 ? _wFlowDir / _wFlowMag : vec2(1.0, 0.0);
           float _wAlong = dot(vWaterWorld.xz, _wFlowDir);
           float _wCross = dot(vWaterWorld.xz, vec2(-_wFlowDir.y, _wFlowDir.x));
           float _foamN = 0.5 + 0.5 * cos(_wAlong * 9.0 - uTime * 7.0) * cos(_wCross * 12.0 + uTime * 3.5)
                        + 0.25 * cos(_wAlong * 17.0 - uTime * 11.0);
           float _wFoam = clamp(vWaterFlow.z, 0.0, 1.0) * mix(0.45, 1.0, smoothstep(0.35, 0.8, _foamN)) * _fTop;
           _wCol = mix(_wCol, vec3(0.85, 0.91, 0.94), _wFoam);
           vec4 diffuseColor = vec4( _wCol, opacity );`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          // Two coarse swells + one fine chop. Coarse trains give slow rolling
          // glints; the fine, faster train adds sparkle without muddying.
          `#include <normal_fragment_begin>
           float _wTop = smoothstep(0.35, 0.85, vWaterFaceN.y);
           float _rx = 0.5 * cos(vWaterWorld.x * 2.3 + uTime * 1.6)
                     + 0.5 * cos((vWaterWorld.x + vWaterWorld.z) * 3.1 + uTime * 2.2)
                     + 0.28 * cos(vWaterWorld.x * 5.9 - uTime * 3.4);
           float _rz = 0.5 * cos(vWaterWorld.z * 1.9 - uTime * 1.1)
                     + 0.5 * cos((vWaterWorld.x - vWaterWorld.z) * 2.7 + uTime * 1.8)
                     + 0.28 * cos(vWaterWorld.z * 6.4 + uTime * 3.0);
           float _chop = cos(_wAlong * 14.0 - uTime * 9.0) * _wFoam;
           _rx += _chop * _wFlowDir.x * 0.9;
           _rz += _chop * _wFlowDir.y * 0.9;
           normal = normalize(normal + (viewMatrix * vec4(vec3(_rx, 0.0, _rz) * 0.26 * _wTop, 0.0)).xyz);`,
        )
        .replace(
          WATER_OUT_ANCHOR,
          // Dual-lobe sun specular: a broad sheen (pow 22) reads as a wet
          // gloss across the surface, a tight sparkle (pow 130) is the moving
          // sun glint. Then a sky-reflection sheen at grazing angles.
          `vec3 _sunV = normalize((viewMatrix * vec4(normalize(uSunDir), 0.0)).xyz);
           vec3 _refl = reflect(-_sunV, normalize(normal));
           float _rDot = max(dot(_refl, normalize(vViewPosition)), 0.0);
           float _specBroad = pow(_rDot, 22.0);
           float _specTight = pow(_rDot, 130.0);
           float _specDamp = 1.0 - _wFoam * 0.75;
           outgoingLight += vec3(1.0, 0.97, 0.88) * (_specBroad * 0.22 + _specTight * 0.9) * _wTop * _specDamp;
           float _dotNV = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
           float _fresnel = exp2((-5.55473 * _dotNV - 6.98316) * _dotNV);
           outgoingLight += uSkyCol * _fresnel * _wTop * 0.75 * _specDamp;
           ${WATER_OUT_ANCHOR}
           gl_FragColor.a = mix(gl_FragColor.a, 1.0, _fresnel);
           gl_FragColor.a *= mix(0.55, 1.0, _wTop);
           gl_FragColor.a = max(gl_FragColor.a, _wFoam * 0.92);`,
        );
    material.userData.waterShader = shader;
  };
  material.customProgramCacheKey = () => "tinyworldWaterSurfaceV4";
  material.userData.waterUniforms = uniforms;
  return uniforms;
}
