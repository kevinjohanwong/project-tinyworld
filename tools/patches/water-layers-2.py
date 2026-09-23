P = "/home/workspace/project-tinyworld/src/pwater/fluid-hifi.ts"
s = open(P).read()
def rep(old, new, count=1):
    global s
    assert s.count(old) == count, f"expected {count} match(es) for: {old[:70]!r} got {s.count(old)}"
    s = s.replace(old, new)

# 1. fields type + allocation
rep("""  foam: Float32Array; // 0..1 foam/whitewater source
  imp: Float32Array; // 0..1 fall-impact
};
""", """  foam: Float32Array; // 0..1 foam/whitewater source
  imp: Float32Array; // 0..1 fall-impact
  // Falling-water layer (Sep 2): per column span of free-falling particles,
  // CELL units. fDen 0 = no fall in this column. Drawn by the curtain pass,
  // never by the height field.
  fTop: Float32Array;
  fBot: Float32Array;
  fDen: Float32Array; // 0..1 sheet density (particles per cell of height vs 1/D^2)
  fVy: Float32Array; // mean vertical speed, cells/s (negative = down)
};
""")
rep("""    foam: new Float32Array(n), imp: new Float32Array(n),
  };
""", """    foam: new Float32Array(n), imp: new Float32Array(n),
    fTop: new Float32Array(n), fBot: new Float32Array(n), fDen: new Float32Array(n), fVy: new Float32Array(n),
  };
""")

# 2. curtain pass, inserted before the group is assembled
rep("""  mist.frustumCulled = false;

  const group = new THREE.Group();
""", """  mist.frustumCulled = false;

  // ── Curtain pass: falling water as vertical ribbons ─────────────────────
  // One camera-facing card per column that holds free-falling particles,
  // spanning exactly the particles' vertical extent (fBot..fTop). Thickness
  // and whiteness come from the binned density; the aeration streaks scroll
  // at the column's real mean fall speed. Cards abut at 1 cell and fade at
  // their side edges so a wide sheet reads continuous. Sim-driven only.
  const curtTune = { curtain: 1, curtWidth: 1.25 };
  const curtGeo = new THREE.InstancedBufferGeometry();
  curtGeo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  curtGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  curtGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const curtCol = new Float32Array(n * 2);
  const curtSpan = new Float32Array(n * 2);
  const curtInfo = new Float32Array(n * 3);
  const aColAttr = new THREE.InstancedBufferAttribute(curtCol, 2);
  const aSpanAttr = new THREE.InstancedBufferAttribute(curtSpan, 2);
  const aInfoAttr = new THREE.InstancedBufferAttribute(curtInfo, 3);
  aColAttr.setUsage(THREE.DynamicDrawUsage);
  aSpanAttr.setUsage(THREE.DynamicDrawUsage);
  aInfoAttr.setUsage(THREE.DynamicDrawUsage);
  curtGeo.setAttribute("aCol", aColAttr);
  curtGeo.setAttribute("aSpan", aSpanAttr);
  curtGeo.setAttribute("aInfo", aInfoAttr);
  curtGeo.instanceCount = 0;
  let curtCount = 0;
  const curtMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: material.uniforms.uTime,
      uVoxel: material.uniforms.uVoxel,
      uSceneTex: { value: sceneRT.texture },
      uSceneDepth: { value: sceneRT.depthTexture },
      uScreen: material.uniforms.uScreen,
      uNearFar: material.uniforms.uNearFar,
      uSunDir: material.uniforms.uSunDir,
      uSunCol: material.uniforms.uSunCol,
      uSkyHi: material.uniforms.uSkyHi,
      uSkyLo: material.uniforms.uSkyLo,
      uShallow: material.uniforms.uShallow,
      uRefract: material.uniforms.uRefract,
      uCurtain: { value: curtTune.curtain },
      uCurtWidth: { value: curtTune.curtWidth },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aCol;
      attribute vec2 aSpan;
      attribute vec3 aInfo;
      uniform float uCurtWidth;
      varying vec3 vWorld;
      varying vec3 vCell;
      varying vec2 vUv;
      varying vec3 vInfo;
      varying float vAlong;
      void main() {
        // Camera right, projected to the ground plane (uniform group scale:
        // world and cell directions coincide).
        vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
        float rl = length(right);
        right = rl > 1e-4 ? right / rl : vec3(1.0, 0.0, 0.0);
        vec3 base = vec3(aCol.x + 0.5, aSpan.x, aCol.y + 0.5);
        vec3 p = base + right * (position.x * uCurtWidth) + vec3(0.0, position.y * aSpan.y, 0.0);
        vCell = p;
        vUv = uv;
        vInfo = aInfo;
        vAlong = dot(base.xz, right.xz);
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
      varying vec3 vInfo;
      varying float vAlong;
      uniform sampler2D uSceneTex, uSceneDepth;
      uniform vec2 uScreen, uNearFar;
      uniform float uTime, uVoxel, uRefract, uCurtain;
      uniform vec3 uSunDir, uSunCol, uSkyHi, uSkyLo, uShallow;
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
      void main() {
        vec2 screenUV = gl_FragCoord.xy / uScreen;
        float dHere = linDepth(gl_FragCoord.z);
        float dScene = linDepth(texture2D(uSceneDepth, screenUV).x);
        if (dScene < dHere - 0.03) discard;
        float den = vInfo.x;
        float speed = max(-vInfo.y, 1.0); // cells/s downward
        float seed = vInfo.z;
        // Aeration streaks: stretched along the fall, scrolling DOWN at the
        // column's real mean speed (feature at y0 appears at y0 - v*t).
        float down = vCell.y + uTime * speed * 0.55;
        vec2 sp1 = vec2(vAlong * 2.7 + seed * 11.0, down * 0.33);
        vec2 sp2 = vec2(vAlong * 5.1 + seed * 3.0, (vCell.y + uTime * speed * 0.8) * 0.55);
        float streaks = fbm(sp1) * 0.62 + vnoise(sp2 * vec2(2.4, 1.0)) * 0.38;
        float lip = smoothstep(0.0, 0.10, 1.0 - vUv.y);   // hand-off to the surface tongue
        float impact = smoothstep(0.28, 0.0, vUv.y);        // plunge whitening at the base
        float aer = smoothstep(0.30, 0.72, streaks) * (0.40 + 0.60 * den) + impact * 0.45 * den;
        aer = clamp(aer, 0.0, 1.0);
        float edge = 1.0 - smoothstep(0.30, 0.5, abs(vUv.x - 0.5));
        // Scene behind the sheet, refracted by the streak relief.
        vec2 refr = vec2(streaks - 0.5, vnoise(sp2 * 1.7) - 0.5) * uRefract * 0.9;
        vec2 uvR = screenUV + refr / max(dHere, 1.0);
        float dBedR = linDepth(texture2D(uSceneDepth, uvR).x);
        if (dBedR < dHere - 0.05) uvR = screenUV;
        vec3 bed = texture2D(uSceneTex, uvR).rgb;
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 0.05 + 0.35 * pow(1.0 - clamp(abs(V.y), 0.0, 1.0), 3.0);
        vec3 skyRefl = mix(uSkyLo, uSkyHi, 0.55);
        vec3 sheet = bed * mix(vec3(1.0), uShallow * 1.2, 0.30 * den) + skyRefl * fres;
        vec3 curtain = mix(sheet, vec3(0.95, 0.98, 1.0), aer);
        float sunUp = clamp(uSunDir.y, 0.0, 1.0);
        curtain += uSunCol * aer * 0.10 * sunUp;
        float a = edge * lip * (0.28 + 0.72 * den) * (0.50 + 0.50 * aer) * uCurtain;
        if (a < 0.02) discard;
        gl_FragColor = vec4(curtain, a);
      }
    `,
  });
  const curtMesh = new THREE.Mesh(curtGeo, curtMat);
  curtMesh.frustumCulled = false;
  curtMesh.renderOrder = 1;

  const group = new THREE.Group();
""")
rep("""  group.add(surfMesh);
  group.add(mist);
""", """  group.add(surfMesh);
  group.add(mist);
  group.add(curtMesh);
""")

# 3. commit(): fill curtain instances
rep("""    mistGeo.attributes.position.needsUpdate = true;
    mistGeo.attributes.aImp.needsUpdate = true;
  }
""", """    mistGeo.attributes.position.needsUpdate = true;
    mistGeo.attributes.aImp.needsUpdate = true;
    // Curtain instances: every column with a falling span.
    const { fTop, fBot, fDen, fVy } = fields;
    let c = 0;
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const k = z * nx + x;
        if (fDen[k] <= 0.004) continue;
        curtCol[c * 2] = x; curtCol[c * 2 + 1] = z;
        curtSpan[c * 2] = fBot[k]; curtSpan[c * 2 + 1] = Math.max(0.05, fTop[k] - fBot[k]);
        curtInfo[c * 3] = fDen[k]; curtInfo[c * 3 + 1] = fVy[k]; curtInfo[c * 3 + 2] = ((x * 73 + z * 151) % 97) / 97;
        c++;
      }
    curtCount = c;
    curtGeo.instanceCount = c;
    aColAttr.needsUpdate = true;
    aSpanAttr.needsUpdate = true;
    aInfoAttr.needsUpdate = true;
  }
""")

# 4. knob/state/dispose
rep("""    if (o.ssr !== undefined) u.uSSR.value = tune.ssr = o.ssr ? 1 : 0;
  }
""", """    if (o.ssr !== undefined) u.uSSR.value = tune.ssr = o.ssr ? 1 : 0;
    if (o.curtain !== undefined) curtMat.uniforms.uCurtain.value = curtTune.curtain = Number(o.curtain);
    if (o.curtWidth !== undefined) curtMat.uniforms.uCurtWidth.value = curtTune.curtWidth = Number(o.curtWidth);
  }
""")
rep("""    return { mode: "hifi", grid: [nx, nz], rt: [w, hgt], ...tune };
""", """    return { mode: "hifi", grid: [nx, nz], rt: [w, hgt], curtains: curtCount, ...tune, ...curtTune };
""")
rep("""    mistGeo.dispose();
    mistMat.dispose();
""", """    mistGeo.dispose();
    mistMat.dispose();
    curtGeo.dispose();
    curtMat.dispose();
""")
open(P, "w").write(s)
print("hifi patched")
