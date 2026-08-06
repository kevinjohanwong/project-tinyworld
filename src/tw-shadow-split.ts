// ── TinyWorld static/dynamic shadow split ────────────────────────────────────
// The big directional shadow maps (sun 7168², moon 3072²) contain ONLY static
// world geometry and are repainted ONLY on real invalidations (block edits,
// quantized sun steps, follow-box deadband commits). The handful of moving
// casters — Sentinel, drone, workers, carried blocks — render into a small
// dedicated map every frame (~a dozen depth draws), owned by an intensity-0
// DirectionalLight whose map is painted MANUALLY here (its shadow.autoUpdate
// stays false so three's shadow pass never touches it; we allocate the render
// target ourselves because three's lazy alloc lives inside the pass we skip).
//
// The two maps are combined in the shader by patching the r165
// `lights_fragment_begin` chunk: the LAST casting directional (this rig's
// light — it is added to the scene after every other directional, and three's
// casting-first sort is stable, so it is always index NUM_DIR_LIGHT_SHADOWS-1)
// has its shadow term multiplied into every OTHER casting directional. A mover
// therefore darkens the real key light (sun by day, moon by night) to full
// shadow depth, while contributing zero light of its own.
//
// Invariants: fidelity-neutral by construction — same shadow filtering (the
// patch calls the same getShadow), movers get a DENSER map than the world box
// gave them, and statics are pixel-identical between repaints because the
// deadband already holds the shadow camera bit-identical. Kill: ?shadowsplit=0
// (restores stock caster set + unpatched chunk; page reload required).

export const TW_DYN_SHADOW_MAP = 2048;

// Patch three's lights_fragment_begin so the last casting directional acts as
// a pure "shadow modifier" for all the others. Must run before any material
// compiles. Returns false (and leaves three stock) if the chunk text doesn't
// match r165 — the app then falls back to legacy full-repaint behavior.
export function patchDynShadowChunk(THREE: any): boolean {
  const key = "lights_fragment_begin";
  const src: string = THREE.ShaderChunk?.[key];
  if (typeof src !== "string") return false;
  if (src.includes("twDynShadow")) return true; // already patched
  const decl =
    "\tDirectionalLight directionalLight;\n" +
    "\t#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0\n" +
    "\tDirectionalLightShadow directionalLightShadow;\n" +
    "\t#endif";
  const apply =
    "\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;";
  if (!src.includes(decl) || !src.includes(apply)) return false;
  const declPatched =
    "\tDirectionalLight directionalLight;\n" +
    "\t#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0\n" +
    "\tDirectionalLightShadow directionalLightShadow;\n" +
    "\tfloat twDynShadow = 1.0;\n" +
    "\t#if ( NUM_DIR_LIGHT_SHADOWS > 1 )\n" +
    "\t{\n" +
    "\t\tDirectionalLightShadow twDynLS = directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS - 1 ];\n" +
    "\t\ttwDynShadow = receiveShadow ? getShadow( directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS - 1 ], twDynLS.shadowMapSize, twDynLS.shadowBias, twDynLS.shadowRadius, vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS - 1 ] ) : 1.0;\n" +
    "\t}\n" +
    "\t#endif\n" +
    "\t#endif";
  const applyPatched =
    apply +
    "\n\t\t#if ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS - 1 )\n" +
    "\t\tdirectLight.color *= twDynShadow;\n" +
    "\t\t#endif";
  THREE.ShaderChunk[key] = src.replace(decl, declPatched).replace(apply, applyPatched);
  return true;
}

export interface DynShadowRig {
  light: any;
  enabled: boolean;
  register(root: any, radius?: number): void;
  updateCamera(focus: any, dir: any): void;
  paint(renderer: any): void;
  stats: { dynPaints: number; dynSkips: number; movers: number; half: number };
}

export function createDynShadowRig(
  THREE: any,
  opts: {
    scene: any;
    dist: number;       // light standoff along the sun/moon direction
    minHalf?: number;   // tightest mover box half-extent (world units)
    maxHalf?: number;   // widest — movers beyond focus+maxHalf go unshadowed
    mapSize?: number;
  },
): DynShadowRig {
  const size = opts.mapSize ?? TW_DYN_SHADOW_MAP;
  const minHalf = opts.minHalf ?? 10;
  const maxHalf = opts.maxHalf ?? 90;
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.name = "twDynShadowLight";
  light.castShadow = true; // three wires uniforms/matrix; the map itself is ours
  light.shadow.autoUpdate = false;
  light.shadow.needsUpdate = false;
  light.shadow.mapSize.set(size, size);
  // 2048 over a ~14-24u mover box ≈ 0.014-0.023 u/texel — DENSER than the 7168
  // world box gave the mech (0.031 u/texel), so mover shadows gain fidelity.
  // Bias tuned like the old fine hero map: near-zero so feet fuse to shadows.
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = 0.0012;
  light.shadow.radius = 1;
  light.shadow.map = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  light.shadow.map.texture.name = "twDynShadow";
  opts.scene.add(light);
  opts.scene.add(light.target);

  // Scratch scene: children are set to the collected caster MESHES (flat, real
  // parents untouched) each paint; matrixWorldAutoUpdate off so the render
  // uses the matrixWorld we refreshed from the REAL tree.
  const scratch = new THREE.Scene();
  scratch.matrixWorldAutoUpdate = false;
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMat.side = THREE.BackSide; // match three's FrontSide→BackSide shadow convention
  scratch.overrideMaterial = depthMat;

  const movers: { root: any; radius: number }[] = [];
  const stats = { dynPaints: 0, dynSkips: 0, movers: 0, half: 0 };
  let half = minHalf;
  const _clr = new THREE.Color();
  const _p = new THREE.Vector3();
  const _meshes: any[] = [];
  const _m = new THREE.Matrix4();
  const _mi = new THREE.Matrix4();
  const _zero = new THREE.Vector3(0, 0, 0);
  const _upY = new THREE.Vector3(0, 1, 0);
  const _upZ = new THREE.Vector3(0, 0, 1);
  let _lastSignature = -1;

  const signature = () => {
    let h = 2166136261 >>> 0;
    const note = (v: number, scale: number) => {
      h ^= Math.round(v * scale) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    const sm = light.shadow.matrix.elements;
    for (let i = 0; i < 16; i++) note(sm[i], 1e6);
    for (const mesh of _meshes) {
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < 16; i++) note(e[i], (i === 12 || i === 13 || i === 14) ? size / (2 * half) : 2048);
    }
    note(_meshes.length, 1);
    return h;
  };

  const collect = (o: any) => {
    if (o.visible === false) return;
    if (o.isMesh && o.userData?.twDynCast) _meshes.push(o);
    const c = o.children;
    for (let i = 0; i < c.length; i++) collect(c[i]);
  };

  return {
    light,
    enabled: true,
    stats,
    register(root: any, radius = 2.5) {
      if (!movers.some((m) => m.root === root)) movers.push({ root, radius });
    },
    // Fit the box around the registered movers each frame: centered on the
    // focus, expanded to reach every mover (capped), texel-snapped, with step
    // hysteresis so the projection doesn't swim per-frame.
    updateCamera(focus: any, dir: any) {
      let reach = minHalf;
      for (let i = movers.length - 1; i >= 0; i--) {
        const m = movers[i];
        if (!m.root.parent) { movers.splice(i, 1); continue; } // disposed
        if (m.root.visible === false) continue;
        m.root.getWorldPosition(_p);
        const d = Math.hypot(_p.x - focus.x, _p.z - focus.z) + m.radius;
        if (d > reach) reach = d;
      }
      reach = Math.min(reach + 1.5, maxHalf);
      // hysteresis: grow to the next 1.3× step, shrink only below 60% of it
      if (reach > half || reach < half * 0.6) {
        let h = minHalf;
        while (h < reach) h *= 1.3;
        half = Math.min(h, maxHalf);
      }
      const cam = light.shadow.camera;
      if (cam.right !== half) {
        cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
        cam.near = opts.dist * 0.25; cam.far = opts.dist * 2;
        cam.updateProjectionMatrix();
      }
      // texel-snap the center in light space (same discipline as the world box)
      const texel = (2 * half) / size;
      const up = Math.abs(dir.y) > 0.99 ? _upZ : _upY;
      _m.lookAt(_zero, dir, up);
      _mi.copy(_m).invert();
      _p.copy(focus).applyMatrix4(_mi);
      _p.x = Math.round(_p.x / texel) * texel;
      _p.y = Math.round(_p.y / texel) * texel;
      _p.applyMatrix4(_m);
      light.target.position.copy(_p);
      light.position.copy(_p).addScaledVector(dir, opts.dist);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
      light.shadow.updateMatrices(light);
      stats.half = half;
    },
    // Paint the mover map: clear to "no caster" white, then ~a dozen depth
    // draws. Runs after all poses are final, before the main render.
    paint(renderer: any) {
      _meshes.length = 0;
      for (const m of movers) {
        if (!m.root.parent || m.root.visible === false) continue;
        m.root.updateMatrixWorld(true); // fresh pose (mixer wrote locals this frame)
        collect(m.root);
      }
      stats.movers = _meshes.length;
      const sig = signature();
      if (sig === _lastSignature) {
        stats.dynSkips++;
        return;
      }
      _lastSignature = sig;
      renderer.getClearColor(_clr);
      const a = renderer.getClearAlpha();
      const auto = renderer.autoClear;
      renderer.setRenderTarget(light.shadow.map);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, true, false);
      if (_meshes.length) {
        renderer.autoClear = false;
        scratch.children = _meshes;
        renderer.render(scratch, light.shadow.camera);
        scratch.children = [];
      }
      renderer.setRenderTarget(null);
      renderer.setClearColor(_clr, a);
      renderer.autoClear = auto;
      stats.dynPaints++;
    },
  };
}
