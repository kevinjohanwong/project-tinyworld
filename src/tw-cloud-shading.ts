export function createCloudClock() {
  let last: number | undefined;
  const state = { seconds: 0, angle: 0 };
  return {
    step(elapsed: number, speed: number, active = true) {
      if (!Number.isFinite(elapsed)) return state;
      const gap = last === undefined ? 0 : elapsed - last;
      last = elapsed;
      const dt = active && gap >= 0 && gap <= 0.25 ? gap : 0;
      state.seconds += dt;
      state.angle += dt * (Number.isFinite(speed) ? speed : 0);
      return state;
    },
  };
}

const CLOUD_FRAGMENT = `
uniform vec3 uSunDir, uLight, uBaseColor, uSecColor, uRimColor;
uniform vec4 uParams;
uniform vec2 uGrad, uNoise, uBack, uHaze;
uniform float uSpanRef, uNight;
varying float vY01;
varying vec3 vWN, vWPos, vCloudRest;
vec3 cloudRamp(float t) {
  vec3 c0 = vec3(0.56,0.61,0.69), c1 = vec3(0.82,0.84,0.88), c2 = vec3(1.0,1.0,0.99);
  t = clamp(t,0.0,1.0);
  return t < 0.5 ? mix(c0,c1,smoothstep(0.05,0.5,t)) : mix(c1,c2,smoothstep(0.5,0.9,t));
}
float _h(vec3 p) { p = fract(p*0.3183099+0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float _vn(vec3 x) {
  vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(_h(i),_h(i+vec3(1,0,0)),f.x),mix(_h(i+vec3(0,1,0)),_h(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(_h(i+vec3(0,0,1)),_h(i+vec3(1,0,1)),f.x),mix(_h(i+vec3(0,1,1)),_h(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float _fbm(vec3 x) { return 0.6*_vn(x)+0.3*_vn(x*2.03+11.1)+0.15*_vn(x*4.01+23.7); }
vec4 shadeCloud(float bakedAO, float feather) {
  vec3 P = vCloudRest;
  vec3 N = normalize(vWN), V = normalize(cameraPosition-vWPos);
  float nf = uNoise.x / uSpanRef * 6.0;
  vec3 nz = vec3(_fbm(P*nf+3.1),_fbm(P*nf+9.7),_fbm(P*nf+21.3))-0.5;
  vec3 nz2 = vec3(_fbm(P*nf*3.3+51.0),_fbm(P*nf*3.3+63.0),_fbm(P*nf*3.3+77.0))-0.5;
  float footprint = max(length(dFdx(P*nf*3.3)),length(dFdy(P*nf*3.3)));
  float detail = 1.0-smoothstep(0.15,0.65,footprint);
  N = normalize(N+nz*1.1+nz2*0.55*detail);
  float ao = mix(1.0,clamp(bakedAO,0.0,1.0),uParams.z);
  float g = clamp((vY01+uGrad.y)*uGrad.x,0.0,1.0);
  float billow = _fbm(P*(nf*0.35)+41.0);
  vec3 col = mix(uSecColor,uBaseColor,clamp(g+(billow-0.5)*0.6,0.0,1.0));
  float fuzz = (_fbm(P*(uNoise.x/uSpanRef*8.0))-0.5)*uNoise.y;
  float ndl = clamp(dot(N,normalize(uSunDir))*0.5+0.5+fuzz,0.0,1.0);
  col *= cloudRamp(ndl);
  float lowSun = 1.0-smoothstep(0.1,0.55,normalize(uSunDir).y);
  col *= mix(vec3(1.0),vec3(0.82,0.84,1.02),(1.0-ndl)*lowSun*0.7);
  float ndv = clamp(dot(N,V),0.0,1.0);
  float rimGate = 1.0-smoothstep(0.08,0.55,normalize(uSunDir).y);
  float rim = pow(1.0-ndv,uParams.w)*uParams.x*rimGate;
  col = mix(col,uRimColor,rim);
  col *= (1.0-uParams.y*ndv)*ao;
  vec3 skyFill = vec3(0.58,0.68,0.88);
  float keyShare = ndl*(1.0-0.48*lowSun);
  col *= mix(mix(skyFill,uLight,0.28),uLight,keyShare);
  float back = pow(clamp(dot(normalize(uSunDir),-V),0.0,1.0),uBack.y);
  back *= uBack.x*(0.35+0.65*(1.0-ndv));
  col += uLight*back;
  float tone = smoothstep(0.42,0.60,_fbm(P*(0.4/uSpanRef)+7.7));
  col *= mix(0.70,1.10,tone);
  col = mix(col,col*vec3(0.80,0.88,1.08),(1.0-smoothstep(0.3,0.7,tone))*0.6);
  float hd = smoothstep(uHaze.x,uHaze.y,length(vWPos-cameraPosition));
  col = mix(col,mix(vec3(0.80,0.87,0.96),uLight,0.4),hd*0.85);
  float luma = dot(col,vec3(0.2126,0.7152,0.0722));
  vec3 moon = mix(vec3(luma),col,0.18)*vec3(0.085,0.14,0.27);
  float moonFace = smoothstep(0.55,0.92,ndl);
  float moonRim = pow(1.0-ndv,2.4)*smoothstep(0.30,0.82,ndl);
  moon += vec3(0.16,0.24,0.48)*(moonFace*0.22+moonRim*0.18);
  col = mix(col,moon,uNight*0.97);
  float ndvRaw = clamp(dot(normalize(vWN),V),0.0,1.0);
  float edgeN = _fbm(P*(nf*1.6)+61.0);
  float alpha = smoothstep(0.0,0.6,ndvRaw-(1.0-ndvRaw)*(0.5-edgeN)*1.35);
  return vec4(col,mix(1.0,alpha,feather));
}
`;

export function patchCloudShader(shader: any, uniforms: Record<string, any>, instanced: boolean) {
  const project = "#include <project_vertex>";
  const output = "#include <dithering_fragment>";
  if (!shader.vertexShader.includes(project) || !shader.fragmentShader.includes(output))
    throw new Error("Cloud shader anchors missing: check pinned Three.js chunks");
  Object.assign(shader.uniforms, uniforms);
  const motion = instanced ? "sin(uCloudMotion.x*aCloudBob.y+aCloudBob.x)*uCloudMotion.y" : "0.0";
  shader.vertexShader = `
attribute float aY01;
${instanced ? "attribute vec2 aCloudBob;" : ""}
uniform vec2 uCloudMotion;
varying float vY01;
varying vec3 vWN, vWPos, vCloudRest;
` + shader.vertexShader.replace(project, `${project}
  vec4 cloudLocal = vec4(transformed,1.0);
  #ifdef USE_INSTANCING
    cloudLocal = instanceMatrix*cloudLocal;
  #endif
  vCloudRest = cloudLocal.xyz;
  float cloudBob = ${motion};
  cloudLocal.y += cloudBob;
  mvPosition += modelViewMatrix*vec4(0.0,cloudBob,0.0,0.0);
  gl_Position = projectionMatrix*mvPosition;
  vWPos = (modelMatrix*cloudLocal).xyz;
  vWN = inverseTransformDirection(transformedNormal,viewMatrix);
  vY01 = aY01;
`);
  shader.fragmentShader = CLOUD_FRAGMENT + shader.fragmentShader.replace(output, `
  float cloudAO = 1.0;
  #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
    cloudAO = vColor.r;
  #endif
  gl_FragColor = shadeCloud(cloudAO,${instanced ? "1.0" : "0.0"});
  if (gl_FragColor.a < 0.01) discard;
  ${output}
`);
}
