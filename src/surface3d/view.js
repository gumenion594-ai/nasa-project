// "Stand here in 3D" on the Moon, Mars or Earth: stand at a point, 1.8 m eye height, look
// around, change the time and watch the light, shadows and sky. Loaded only when opened.
import * as THREE from 'three';
import { WORLDS } from './worlds.js';
import { loadFar, loadDetail, loadColours, groundImage } from './dem.js';
import { levelsFor, buildLevels, levelGeometry, heightTexture, heightAt, sunVisibility, rng, projector } from './terrain.js';
import { skyAt, azEl, nextSunCrossing } from './sky.js';

const EYE_M = 1.8;
const DAY_EXPOSURE = 1.0;
const NIGHT_EXPOSURE = 9.0; // eyes adapted to earthshine (Moon)
const SKY_D = 1000;         // distance of sky objects in the sky scene

// local east/north/up -> three.js (x = east, y = up, z = -north)
const toThree = (v) => new THREE.Vector3(v.x, v.z, -v.y);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- terrain shadows on the GPU: march towards the Sun through the four heightfields ----

const SHADOW_GLSL = /* glsl */`
uniform sampler2D uH0; uniform sampler2D uH1; uniform sampler2D uH2; uniform sampler2D uH3;
uniform vec4 uHalf; uniform vec4 uN; uniform vec3 uSunDir; uniform float uMaxZ; uniform float uSunTan;
varying vec3 vTW;
float hLevel(sampler2D tex, float hs, float n, vec2 xy) {
  vec2 g = clamp((xy + hs) / (2.0 * hs) * (n - 1.0), vec2(0.0), vec2(n - 1.001));
  vec2 i = floor(g); vec2 f = g - i; ivec2 p = ivec2(i);
  float a = texelFetch(tex, p, 0).r;               float b = texelFetch(tex, p + ivec2(1, 0), 0).r;
  float c = texelFetch(tex, p + ivec2(0, 1), 0).r; float d = texelFetch(tex, p + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float tHeight(vec2 xy) {
  float m = max(abs(xy.x), abs(xy.y));
  if (m < uHalf.x) return hLevel(uH0, uHalf.x, uN.x, xy);
  if (m < uHalf.y) return hLevel(uH1, uHalf.y, uN.y, xy);
  if (m < uHalf.z) return hLevel(uH2, uHalf.z, uN.z, xy);
  return hLevel(uH3, uHalf.w, uN.w, xy);
}
float tCell(vec2 xy) {
  float m = max(abs(xy.x), abs(xy.y));
  vec4 cell = 2.0 * uHalf / (uN - 1.0);
  return m < uHalf.x ? cell.x : m < uHalf.y ? cell.y : m < uHalf.z ? cell.z : cell.w;
}
// 0..1: share of the Sun's disc visible from world point w (soft edge = the disc's size)
float terrainSun(vec3 w) {
  vec2 dir = vec2(uSunDir.x, -uSunDir.z); float sz = uSunDir.y;
  if (sz < -0.06) return 0.0;
  vec2 p0 = vec2(w.x, -w.z);
  float cell = tCell(p0);
  float z0 = w.y + 0.04 * cell + 0.01;
  float vis = 1.0; float t = cell;
  for (int k = 0; k < 320; k++) {
    vec2 p = p0 + dir * t; float pz = z0 + sz * t;
    if (max(abs(p.x), abs(p.y)) > uHalf.w) break;
    vis = min(vis, (pz - tHeight(p)) / (t * uSunTan));
    if (vis < -1.0) return 0.0;
    if (pz > uMaxZ && sz > 0.0) break;
    t += max(0.12, t * 0.045);
  }
  return smoothstep(-1.0, 1.0, vis);
}
`;

function patchLights() {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const at = chunk.indexOf('NUM_DIR_LIGHTS > 0');
  const re = chunk.indexOf('RE_Direct(', at);
  return `float terrainSunVis = terrainSun(vTW);\n${chunk.slice(0, re)}` +
    '#if UNROLLED_LOOP_INDEX == 0\n\t\tdirectLight.color *= terrainSunVis;\n\t\t#endif\n\t\t' + chunk.slice(re);
}

/** A standard material whose first directional light (the Sun) is blocked by the terrain. */
function shadowedMaterial(uniforms, opts) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, ...opts });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = `varying vec3 vTW;\n${sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vec4 tw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        tw = instanceMatrix * tw;
      #endif
      vTW = (modelMatrix * tw).xyz;`)}`;
    sh.fragmentShader = SHADOW_GLSL + sh.fragmentShader.replace('#include <lights_fragment_begin>', patchLights());
  };
  return mat;
}

// ---- Mars sky: dusty air -----------------------------------------------------------------
// Fine dust scatters red light out of the sky (butterscotch by day) and scatters blue light
// forwards, so the sky round the Sun turns blue at sunset. A simple analytic model of that.
const SKY_GLSL_V = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_GLSL_F = /* glsl */`
uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGlow;
uniform float uDay; uniform float uTwi; uniform float uScale;
varying vec3 vDir;
void main() {
  vec3 v = normalize(vDir);
  float h = max(v.y, 0.0);
  vec3 base = mix(uHorizon, uZenith, pow(h, 0.45));
  float th = acos(clamp(dot(v, uSun), -1.0, 1.0));
  vec3 col = base * uDay * (1.0 + 1.3 * exp(-th * 2.2));
  col += uGlow * (1.8 * exp(-th * 7.0) + 0.45 * exp(-th * 2.0)) * uTwi * (0.45 + 0.55 * exp(-h * 5.0));
  gl_FragColor = vec4(col * uScale, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// three.js' ACES filmic tone mapping + sRGB encoding, so the haze colour (applied after tone
// mapping) matches the sky drawn behind the terrain
function displayColour([r, g, b], exposure) {
  const k = exposure / 0.6;
  const c = [r * k, g * k, b * k];
  const i = [0.59719 * c[0] + 0.35458 * c[1] + 0.04823 * c[2], 0.076 * c[0] + 0.90834 * c[1] + 0.01566 * c[2],
    0.0284 * c[0] + 0.13383 * c[1] + 0.83777 * c[2]];
  const f = i.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081));
  const o = [1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2], -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2],
    -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2]];
  return o.map((v) => { v = Math.min(1, Math.max(0, v)); return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; });
}

// ---- made-up rocks ---------------------------------------------------------------------------

function rockGeometries(random) {
  return [0, 1, 2].map((v) => {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position;
    const bumps = Array.from({ length: 6 }, () => new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize());
    for (let i = 0; i < p.count; i++) {
      const d = new THREE.Vector3().fromBufferAttribute(p, i);
      let s = 0.85;
      for (const b of bumps) s += 0.12 * Math.max(0, d.dot(b)) ** 3;
      s += 0.06 * (random() - 0.5);
      p.setXYZ(i, d.x * s * (1 + 0.2 * v), d.y * s * (0.55 + 0.1 * v), d.z * s);
    }
    g.computeVertexNormals();
    return g;
  });
}

// ---- sky textures ---------------------------------------------------------------------------

const CORE = 0.085; // the Sun's disc as a share of its glow sprite
function sunTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(CORE, 'rgba(255,255,250,1)');
  grad.addColorStop(0.1, 'rgba(255,250,235,0.55)');
  grad.addColorStop(0.25, 'rgba(255,240,220,0.12)');
  grad.addColorStop(1, 'rgba(255,240,220,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function starTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.15)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function earthTexture() {
  // a stand-in: ocean blue with white cloud swirls
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(512, 256);
  const random = rng(42);
  const blobs = Array.from({ length: 70 }, () => [random() * 512, random() * 256, 6 + random() * 30]);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      let cloud = 0;
      for (const [bx, by, r] of blobs) {
        const dx = Math.min(Math.abs(x - bx), 512 - Math.abs(x - bx)); const dy = (y - by) * 1.6;
        cloud += Math.exp(-(dx * dx + dy * dy) / (r * r));
      }
      cloud = Math.min(1, cloud * 0.8 + (Math.abs(y - 128) > 108 ? 0.8 : 0));
      const k = (y * 512 + x) * 4;
      img.data[k] = 30 + 215 * cloud; img.data[k + 1] = 70 + 180 * cloud; img.data[k + 2] = 150 + 100 * cloud; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Phobos / Deimos: lumpy potatoes (Phobos 27 x 22 x 18 km, Deimos 15 x 12 x 11 km)
function moonGeometry(random, axes) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const d = new THREE.Vector3().fromBufferAttribute(p, i);
    const s = 1 + 0.06 * Math.sin(d.x * 7 + random()) * Math.cos(d.y * 5) - 0.05 * Math.max(0, d.dot(new THREE.Vector3(0.6, 0.5, 0.6)) - 0.8) * 8;
    p.setXYZ(i, d.x * s * axes[0], d.y * s * axes[1], d.z * s * axes[2]);
  }
  g.computeVertexNormals();
  return g;
}

// ---- the view ---------------------------------------------------------------------------------

/**
 * Open the 3D view on `world` ('moon' | 'mars'). `els` = the page's elements; `onBack()` leaves;
 * `onTime(date)` reports time changes (for the address). Returns a function that closes it.
 */
export function open3D(els, { world: key, lat, lon, date: startDate, onBack, onTime }) {
  const W = WORLDS[key];
  const air = W.atmosphere;
  const LEVELS = levelsFor(W);
  const { canvas, hud } = els;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, LEVELS[3].half * 1.6);
  camera.rotation.order = 'YXZ';
  const skyScene = new THREE.Scene();
  const skyCam = new THREE.PerspectiveCamera(60, 1, 1, 5000);
  skyCam.rotation.order = 'YXZ';
  const fog = air ? new THREE.FogExp2(0x000000, 0.833 / (air.hazeKm * 1000)) : null;
  scene.fog = fog;

  // lights: the Sun (casts rock shadows near you; terrain shadows come from the shader),
  // earthshine (Moon) or skylight (Mars), and fill for light bounced off sunlit ground
  const sunLight = new THREE.DirectionalLight(0xfffaf2, 3.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  Object.assign(sunLight.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 2000 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.03;
  scene.add(sunLight, sunLight.target);
  const earthLight = new THREE.DirectionalLight(0xbcd2ff, 0);
  scene.add(earthLight, earthLight.target);
  const fill = new THREE.AmbientLight(0xffffff, 0);
  scene.add(fill);
  const skyLight = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
  scene.add(skyLight);

  const uniforms = {
    uH0: { value: null }, uH1: { value: null }, uH2: { value: null }, uH3: { value: null },
    uHalf: { value: new THREE.Vector4(...LEVELS.map((l) => l.half)) },
    uN: { value: new THREE.Vector4(...LEVELS.map((l) => l.n)) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMaxZ: { value: 0 },
    uSunTan: { value: 0.00466 },
  };
  const groundMat = shadowedMaterial(uniforms, { vertexColors: true });
  const rockMat = shadowedMaterial(uniforms, { color: W.rock });

  // ---- sky scene: (Mars) the sky dome, then the Sun, Earth and moons
  const skyUniforms = air ? {
    uSun: { value: new THREE.Vector3() }, uZenith: { value: new THREE.Color(...air.zenith) },
    uHorizon: { value: new THREE.Color(...air.horizon) }, uGlow: { value: new THREE.Color(...air.glow) },
    uDay: { value: 0 }, uTwi: { value: 0 }, uScale: { value: 0.5 },
  } : null;
  if (air) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_D * 2, 64, 32),
      new THREE.ShaderMaterial({ uniforms: skyUniforms, vertexShader: SKY_GLSL_V, fragmentShader: SKY_GLSL_F,
        side: THREE.BackSide, depthWrite: false }));
    dome.renderOrder = -1;
    skyScene.add(dome);
  }
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTexture(), blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
  sunSprite.renderOrder = 3;
  skyScene.add(sunSprite);
  const skySun = new THREE.DirectionalLight(0xffffff, 3); // lights Earth (from the Moon) and Phobos/Deimos
  skyScene.add(skySun, skySun.target, new THREE.AmbientLight(0xffffff, 0.02));
  // Earth: a disc from the Moon, a bright star from Mars
  const earthDisc = key === 'moon' ? new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32),
    new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: 0.9, metalness: 0 })) : null;
  if (earthDisc) skyScene.add(earthDisc);
  const star = (color) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
    s.renderOrder = 2;
    skyScene.add(s);
    return s;
  };
  const earthStar = key === 'mars' ? star(0xbfd8ff) : null;
  const moonRandom = rng(5);
  const moonMeshes = key === 'mars' ? [[1, 0.83, 0.68], [1, 0.8, 0.73]].map((axes) => {
    const m = new THREE.Mesh(moonGeometry(moonRandom, axes), new THREE.MeshStandardMaterial({ color: 0x6b6058, roughness: 1 }));
    m.renderOrder = 1;
    skyScene.add(m);
    return { mesh: m, star: star(0xfff0e0) };
  }) : [];
  // from Earth: the Moon, a plain grey globe lit by the Sun (so it shows its phase)
  if (key === 'earth') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshStandardMaterial({ color: 0xb8b4ae, roughness: 1 }));
    m.renderOrder = 1;
    skyScene.add(m);
    moonMeshes.push({ mesh: m, star: star(0xffffff) });
  }

  // ---- state
  const seed = (Math.round(lat * 1000) * 73856093) ^ (Math.round(lon * 1000) * 19349663);
  let levels = null;
  let proj = null;
  let meshes = [];
  let rocks = [];
  let eyeZ = EYE_M;
  let yaw = 0; let pitch = 0; // degrees: yaw from north, clockwise
  let base = startDate;       // slider 0
  let offsetH = 0;
  let playing = 0;            // hours per second (0 = paused)
  let sky = null;
  let closed = false;
  let dirty = true;
  const sources = {};
  const colours = {};
  const textures = [];  // Earth: a satellite-image texture per level (foot, near, mid, far)
  const materials = []; // ... and the ground material that uses it
  const status = (text) => { els.status.textContent = text; els.status.hidden = !text; };

  // ground colour of a level: the world's colour, made darker or brighter by the map mosaic.
  // Only the mosaic's brightness is used (dark basalt vs bright dust): its colour balance is
  // not true colour (the Viking mosaic turns dark ground purple-grey).
  const colourFor = (i) => {
    const sampler = [colours.near, colours.near, colours.mid, colours.far][i];
    if (!sampler || !proj) return () => W.ground;
    const { meanLum } = W.imagery;
    return (x, y) => {
      const [la, lo] = proj(x, y);
      const c = sampler(la, lo);
      if (!c) return W.ground;
      const f = Math.min(1.5, Math.max(0.45, 0.4 + 0.6 * ((0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / meanLum)));
      return W.ground.map((v) => v * f);
    };
  };

  function rebuild() {
    const built = buildLevels(W, lat, lon, sources, seed);
    levels = built.levels;
    proj = built.proj;
    for (const m of meshes) { scene.remove(m); m.geometry.dispose(); }
    meshes = levels.map((L, i) => {
      // Earth: white vertex colours under the satellite image (once it has arrived)
      const geo = textures[i] ? levelGeometry(L, levels[i - 1], seed + i, () => [1, 1, 1], { plain: true })
        : levelGeometry(L, levels[i - 1], seed + i, colourFor(i));
      const mesh = new THREE.Mesh(geo, materials[i] ?? groundMat);
      mesh.receiveShadow = i <= 1;
      scene.add(mesh);
      return mesh;
    });
    for (const [i, L] of levels.entries()) {
      uniforms[`uH${i}`].value?.dispose();
      uniforms[`uH${i}`].value = heightTexture(L);
    }
    uniforms.uMaxZ.value = Math.max(...levels.map((L) => L.zMax)) + 1;
    placeRocks();
    eyeZ = heightAt(levels, 0, 0) + EYE_M;
    camera.position.set(0, eyeZ, 0);
    els.where.textContent = `${W.name} · ${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ` +
      `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'} · ground ${(built.h0 / 1000).toFixed(2)} km`;
    updateSky();
  }

  const rockGeos = rockGeometries(rng(seed + 7));
  function placeRocks() {
    for (const r of rocks) scene.remove(r);
    const random = rng(seed + 11);
    const per = Math.round(W.rocks / 3);
    const foot = levels[0];
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e = new THREE.Euler();
    rocks = rockGeos.map((g) => {
      const inst = new THREE.InstancedMesh(g, rockMat, per);
      for (let k = 0; k < per; k++) {
        const r = 1.5 + 93 * Math.sqrt(random()); const a = random() * Math.PI * 2;
        const x = r * Math.sin(a); const y = r * Math.cos(a);
        const D = 0.05 * (1 - random() * (1 - (0.05 / 1.8) ** 2.4)) ** (-1 / 2.4); // many pebbles, few boulders
        const s = D / 2;
        e.set(random() * 6.3, random() * 6.3, random() * 0.6);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, foot.sample(x, y) - 0.3 * s, -y), q, new THREE.Vector3(s, s, s));
        inst.setMatrixAt(k, m);
        const c = 0.8 + 0.35 * random();
        inst.setColorAt(k, new THREE.Color(c, c * 0.98, c * 0.95));
      }
      inst.castShadow = true;
      inst.receiveShadow = true;
      scene.add(inst);
      return inst;
    });
  }

  function now() { return new Date(base.getTime() + offsetH * 3600e3); }

  function updateSky() {
    if (!levels) return;
    const date = now();
    sky = skyAt(key, W.radius, date, lat, lon);
    const s = sky.sun.dir;
    const sun3 = toThree(s);
    uniforms.uSunDir.value.copy(sun3);
    uniforms.uSunTan.value = Math.tan((sky.sun.radiusDeg * Math.PI) / 180);
    sunLight.position.copy(camera.position).addScaledVector(sun3, 1000);
    sunLight.target.position.set(0, eyeZ, 0);
    const sunEl = azEl(s).el;
    const vis = sunVisibility(levels, s, 0, 0, eyeZ, sky.sun.radiusDeg);
    const sunUp = smoothstep(-sky.sun.radiusDeg, sky.sun.radiusDeg, sunEl);
    let exposure;
    if (air) {
      // dust dims and reddens the low Sun; the bright sky fills the shadows
      const ext = Math.exp(-air.tau * (1 / Math.max(s.z, 0.03) - 1));
      sunLight.intensity = 3.0 * sunUp * ext;
      sunLight.color.setRGB(1, 0.93 + 0.07 * ext, 0.85 + 0.15 * ext);
      const day = smoothstep(-0.07, 0.2, s.z);
      const twi = smoothstep(-0.3, -0.02, s.z) * (1 - 0.6 * smoothstep(0.1, 0.5, s.z));
      skyUniforms.uSun.value.copy(sun3);
      skyUniforms.uDay.value = day;
      skyUniforms.uTwi.value = twi;
      skyLight.color.setRGB(...air.zenith);
      skyLight.groundColor.setRGB(0.25, 0.15, 0.1);
      skyLight.intensity = 0.45 * day + 0.02;
      fill.intensity = 0.1 * sunUp;
      earthLight.intensity = 0;
      // eyes adapt to the sky's brightness; the haze takes the colour of the sky near the horizon
      exposure = 1 + 6 * (1 - Math.min(1, day * 1.5 + twi * 0.3));
      // the sky shader at the horizon, away from the Sun: horizon colour x day (+ a little glow)
      const h = air.horizon.map((v, i) => (v * day * 1.04 + air.glow[i] * twi * 0.03) * skyUniforms.uScale.value);
      fog.color.setRGB(...displayColour(h, exposure), THREE.LinearSRGBColorSpace);
    } else {
      sunLight.intensity = 3.2 * sunUp;
      fill.intensity = 0.14 * sunUp; // light bounced off the sunlit ground: shadows are dark, not black
      const earthEl = azEl(sky.earth.dir).el;
      earthLight.position.copy(toThree(sky.earth.dir)).multiplyScalar(1000);
      earthLight.intensity = earthEl > -1 ? 0.06 * sky.earth.lit : 0; // earthshine
      const day = Math.min(1, Math.max(0, (sunEl + 1) / 2)) * Math.max(vis, 0.15);
      exposure = NIGHT_EXPOSURE + (DAY_EXPOSURE - NIGHT_EXPOSURE) * Math.min(1, day * 1.4);
    }
    renderer.toneMappingExposure = exposure;
    skySun.intensity = 2.5 / exposure; // sky objects look the same whatever the eyes adapt to
    skySun.position.copy(sun3).multiplyScalar(10);

    // Sun
    sunSprite.position.copy(sun3).multiplyScalar(SKY_D);
    sunSprite.scale.setScalar((2 * SKY_D * Math.tan((sky.sun.radiusDeg * Math.PI) / 180)) / CORE);
    sunSprite.visible = sunEl > -2;
    // Earth (seen from the Moon or Mars)
    const e3 = sky.earth ? toThree(sky.earth.dir).multiplyScalar(SKY_D) : null;
    if (earthDisc) {
      earthDisc.position.copy(e3);
      earthDisc.scale.setScalar(SKY_D * Math.tan((sky.earth.radiusDeg * Math.PI) / 180));
    }
    if (earthStar) {
      earthStar.position.copy(e3);
      // a bright star, fading out against the daytime sky
      const fade = 1 - smoothstep(-0.12, 0.05, s.z);
      earthStar.material.opacity = (0.35 + 0.65 * sky.earth.lit) * fade;
      earthStar.scale.setScalar(0.022);
    }
    // Phobos and Deimos
    sky.moons.forEach((m, i) => {
      const { mesh, star: st } = moonMeshes[i];
      mesh.position.copy(toThree(m.dir)).multiplyScalar(SKY_D);
      mesh.scale.setScalar(SKY_D * Math.tan((m.radiusDeg * Math.PI) / 180));
      mesh.lookAt(0, 0, 0); // keeps its long axis pointing at Mars, as it really does (roughly)
      // too small to see as a disc: a point of light, brightest when fully lit
      const fade = 1 - smoothstep(-0.12, 0.08, s.z);
      st.position.copy(mesh.position);
      st.scale.setScalar(m.radiusDeg < 0.05 ? 0.012 : 0.0001);
      st.material.opacity = m.lit * fade * 0.9;
    });
    showInfo(date, sunEl, vis);
    dirty = true;
  }

  // ---- info panel and controls
  const pad = (n) => String(n).padStart(2, '0');
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDuration = (h) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h < 10 ? h.toFixed(1) : Math.round(h)} h` : `${(h / 24).toFixed(1)} days`);
  const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
  const clock = (h) => `${pad(Math.floor(h))}:${pad(Math.floor((h % 1) * 60))}`;
  let crossingTimer = null;
  function showInfo(date, sunEl, vis) {
    els.date.value = localInput(date);
    els.slider.value = offsetH;
    els.offset.textContent = Math.abs(offsetH) < 1e-6 ? 'chosen time' : `${offsetH > 0 ? '+' : '−'}${fmtDuration(Math.abs(offsetH))}`;
    const sAz = Math.round(azEl(sky.sun.dir).az);
    let sunText;
    if (sunEl < -sky.sun.radiusDeg) {
      sunText = air && sunEl > -18 ? `<b>Twilight.</b> The Sun is ${(-sunEl).toFixed(1)}° below the horizon.`
        : `<b>Night.</b> The Sun is ${(-sunEl).toFixed(1)}° below the horizon.`;
    } else if (vis < 0.02) sunText = `<b>In shadow.</b> The Sun is ${sunEl.toFixed(1)}° up (${compass(sAz)}) but hidden behind terrain.`;
    else {
      sunText = `<b>Day.</b> Sun ${sunEl.toFixed(1)}° above the horizon, ${compass(sAz)} (${sAz}°)` +
        (vis < 0.98 ? `, partly hidden (${Math.round(vis * 100)}% visible)` : '') + '.';
    }
    els.sun.innerHTML = `${sunText} Local solar time ${clock(sky.solarTime)}${key === 'mars' ? ' (Mars hours)' : ''}.`;
    const e = sky.earth; const ee = e && azEl(e.dir);
    if (key === 'earth') {
      const m = sky.moons[0]; const a = azEl(m.dir);
      els.earth.innerHTML = a.el > 0
        ? `<b>Moon</b> ${a.el.toFixed(1)}° up, ${compass(a.az)} · ${Math.round(m.lit * 100)}% lit · ${Math.round(m.km).toLocaleString()} km away`
        : `<b>Moon</b> below the horizon now (${Math.round(m.lit * 100)}% lit).`;
    } else if (key === 'moon') {
      els.earth.innerHTML = ee.el > -1
        ? `<b>Earth</b> ${ee.el.toFixed(1)}° up, ${compass(ee.az)} · ${Math.round(e.lit * 100)}% lit · ${Math.round(e.km).toLocaleString()} km away`
        : '<b>Earth</b> is below the horizon here (always, on the far side of the Moon).';
    } else {
      const earthText = ee.el > 0
        ? `<b>Earth</b> ${ee.el.toFixed(1)}° up, ${compass(ee.az)}: ` +
          `${sunEl > 3 ? 'a star, lost in the daylight' : sunEl > -18 ? 'a bright star in the twilight' : 'a bright star'}` +
          ` · ${Math.round(e.km / 1e6)} million km away`
        : `<b>Earth</b> is below the horizon now (${Math.round(e.km / 1e6)} million km away).`;
      const moonText = sky.moons.map((m) => {
        const a = azEl(m.dir);
        return a.el > 0 ? `<b>${m.name}</b> ${a.el.toFixed(0)}° up, ${compass(a.az)} · ${Math.round(m.lit * 100)}% lit`
          : `<b>${m.name}</b> below the horizon`;
      }).join('<br>');
      els.earth.innerHTML = `${earthText}<br>${moonText}<br><span class="sub">Phobos and Deimos: positions approximate (a few degrees).</span>`;
    }
    clearTimeout(crossingTimer);
    crossingTimer = setTimeout(() => {
      // a day of about 24 h (Mars, Earth): search 2 days in quarter hours; the Moon: a month, hourly
      const c = key !== 'moon' ? nextSunCrossing(key, W.radius, date, lat, lon, 2, 0.25) : nextSunCrossing(key, W.radius, date, lat, lon);
      els.next.textContent = c ? `Next ${c.rising ? 'sunrise' : 'sunset'} (flat horizon): in ${fmtDuration((c.date - date) / 3600e3)}` +
        ` · ${c.date.toLocaleString()}` : '';
    }, 120);
  }

  els.slider.min = -W.range.hours; els.slider.max = W.range.hours; els.slider.step = W.range.step;
  els.slider.setAttribute('aria-label', `Move time, up to ${fmtDuration(W.range.hours)} either way`);
  els.note.textContent = key === 'earth'
    ? `Drag to look around, scroll to zoom. Hills larger than ~${W.dem.detailM} m are real (${W.dem.label}; north of 60° N ` +
      'and south of 56° S: AWS Terrain Tiles, partly coarser). The ground is a satellite image (Esri, Maxar, Earthstar ' +
      'Geographics) with its own shadows from when it was taken. Rocks and small bumps are made up. Stars and planets are not shown yet.'
    : `Drag to look around, scroll to zoom. Hills and craters larger than ~${W.dem.detailM} m are real ` +
      `(${W.dem.label})${W.imagery ? '; ground colours from Viking orbiter images' : ''}. Smaller craters, rocks and the ground ` +
      `texture are made up.${key === 'moon' ? ' The Earth is a stand-in globe; stars and planets are not shown yet.' : ' Stars and planets are not shown yet.'}`;
  els.slider.oninput = () => { offsetH = Number(els.slider.value); updateSky(); onTime?.(now()); };
  els.date.onchange = () => {
    const d = new Date(els.date.value);
    if (!Number.isNaN(d.getTime())) { base = d; offsetH = 0; updateSky(); onTime?.(now()); }
  };
  els.now.onclick = () => { base = new Date(); offsetH = 0; updateSky(); onTime?.(now()); };
  const SPEEDS = W.speeds;
  let speedIdx = 0;
  const speedLabel = (h) => (h < 1 ? `${Math.round(h * 60)} min/s` : `${h} h/s`);
  els.play.onclick = () => {
    playing = playing ? 0 : SPEEDS[speedIdx];
    els.play.textContent = playing ? '❚❚ Pause' : '▶ Play';
    if (!playing) onTime?.(now());
  };
  els.speed.onclick = () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    els.speed.textContent = speedLabel(SPEEDS[speedIdx]);
    if (playing) playing = SPEEDS[speedIdx];
  };
  els.speed.textContent = speedLabel(SPEEDS[speedIdx]);
  els.play.textContent = '▶ Play';
  els.back.onclick = () => onBack();

  // looking around: drag, wheel / pinch to zoom, arrow keys
  const zoomTo = (fov) => {
    camera.fov = Math.max(4, Math.min(100, fov));
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const pointers = new Map();
  let pinch = null;
  canvas.onpointerdown = (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    canvas.setPointerCapture(ev.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: camera.fov };
    }
  };
  canvas.onpointermove = (ev) => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      zoomTo(pinch.fov * (pinch.d / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))));
      return;
    }
    const k = camera.fov / canvas.clientHeight;
    yaw = (yaw - (ev.clientX - prev.x) * k + 360) % 360;
    pitch = Math.max(-89, Math.min(89, pitch + (ev.clientY - prev.y) * k));
    dirty = true;
  };
  canvas.onpointerup = canvas.onpointercancel = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  canvas.onwheel = (ev) => {
    ev.preventDefault();
    zoomTo(camera.fov * 1.1 ** Math.sign(ev.deltaY));
  };
  const onKey = (ev) => {
    if (ev.target.closest?.('input, button, select')) return; // the time controls use the keys themselves
    const step = camera.fov / 12;
    if (ev.key === 'ArrowLeft') yaw = (yaw - step + 360) % 360;
    else if (ev.key === 'ArrowRight') yaw = (yaw + step) % 360;
    else if (ev.key === 'ArrowUp') pitch = Math.min(89, pitch + step);
    else if (ev.key === 'ArrowDown') pitch = Math.max(-89, pitch - step);
    else if (ev.key === '+' || ev.key === '=') return zoomTo(camera.fov / 1.25);
    else if (ev.key === '-') return zoomTo(camera.fov * 1.25);
    else return;
    dirty = true;
  };
  window.addEventListener('keydown', onKey);

  function resize() {
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = skyCam.aspect = w / h;
    camera.updateProjectionMatrix();
    hud.width = w * devicePixelRatio; hud.height = 40 * devicePixelRatio;
    dirty = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // compass strip along the top
  function drawHud() {
    const g = hud.getContext('2d');
    const w = hud.width; const h = hud.height; const s = devicePixelRatio;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, w, h);
    const half = Math.tan((camera.fov * camera.aspect * Math.PI) / 360);
    const xOf = (az) => {
      const d = ((az - yaw + 540) % 360) - 180;
      if (Math.abs(d) >= 89) return null;
      const x = Math.tan((d * Math.PI) / 180) / half;
      return Math.abs(x) <= 1.05 ? (x * 0.5 + 0.5) * w : null;
    };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let az = 0; az < 360; az += 5) {
      const x = xOf(az); if (x === null) continue;
      const major = az % 45 === 0;
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = s;
      g.beginPath(); g.moveTo(x, h); g.lineTo(x, h - (major ? 10 : az % 15 === 0 ? 6 : 3) * s); g.stroke();
      if (major) { g.fillStyle = '#fff'; g.font = `${600} ${12 * s}px system-ui`; g.fillText(compass(az), x, 14 * s); }
      else if (az % 15 === 0) { g.fillStyle = 'rgba(255,255,255,.6)'; g.font = `${10 * s}px system-ui`; g.fillText(String(az), x, 14 * s); }
    }
    if (sky) {
      const marks = [[sky.sun.dir, '☀', '#ffd27a'], ...(sky.earth ? [[sky.earth.dir, '● Earth', '#9cc4ff']] : []),
        ...sky.moons.map((m) => [m.dir, `● ${m.name}`, '#e8d2c0'])];
      for (const [dir, label, color] of marks) {
        const { az, el } = azEl(dir);
        if (el < -1) continue; // below the horizon
        const x = xOf(az); if (x === null) continue;
        g.fillStyle = color; g.font = `${600} ${11 * s}px system-ui`; g.fillText(label, x, 29 * s);
      }
    }
    g.fillStyle = '#ffb347'; g.beginPath(); g.moveTo(w / 2 - 5 * s, h); g.lineTo(w / 2 + 5 * s, h); g.lineTo(w / 2, h - 6 * s); g.fill();
  }

  // ---- render loop (draws only when something changed, or while playing)
  let last = performance.now();
  function frame(t) {
    if (closed) return;
    const dt = (t - last) / 1000; last = t;
    if (playing) { offsetH += playing * dt; updateSky(); }
    if (dirty && levels) {
      camera.rotation.set((pitch * Math.PI) / 180, (-yaw * Math.PI) / 180, 0);
      skyCam.rotation.copy(camera.rotation);
      skyCam.fov = camera.fov; skyCam.updateProjectionMatrix();
      renderer.clear();
      renderer.render(skyScene, skyCam);
      renderer.clearDepth();
      renderer.render(scene, camera);
      drawHud();
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  resize();
  if (camera.aspect < 1) zoomTo(85); // portrait phones: wider view so there's more than a slit sideways
  requestAnimationFrame(frame);

  // Earth: the satellite image of each level's square as its texture (image pixels: foot
  // ~0.2 m (the images go to ~1 m), near ~5 m, mid ~80 m, far ~300 m)
  async function loadGroundTextures() {
    const proj0 = projector(lat, lon, W.radius);
    const sizes = [1024, 2048, 1024, 1024];
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    await Promise.all([1, 0, 2, 3].map(async (i) => {
      const data = await groundImage(W, lat, lon, proj0, LEVELS[i].half, sizes[i]);
      if (closed) return;
      // imagery server unreachable (tiles come back empty): keep the plain ground colours
      // rather than a black ground
      let lit = 0;
      for (let k = 0; k < data.length; k += 4 * 97) if (data[k] + data[k + 1] + data[k + 2] > 6) lit++;
      if (lit < 0.5 * (data.length / (4 * 97))) return;
      const tex = new THREE.DataTexture(data, sizes[i], sizes[i], THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = maxAniso; // sharp ground towards the horizon
      tex.needsUpdate = true;
      textures[i] = tex;
      materials[i] = shadowedMaterial(uniforms, { vertexColors: true, map: tex });
    }));
  }

  // ---- load: coarse terrain first, then ground colours and the detailed rings as they arrive
  (async () => {
    status(`Loading ${W.name}’s terrain…`);
    sources.far = await loadFar(W, lat, lon);
    if (closed) return;
    rebuild();
    const colourJob = W.imagery?.texture ? loadGroundTextures().catch((err) => console.error(err)) : W.imagery ? Promise.all([
      loadColours(W, lat, lon, LEVELS[3].half, LEVELS[3].half / 120).then((c) => { colours.far = c; }),
      loadColours(W, lat, lon, LEVELS[2].half, LEVELS[2].half / 150).then((c) => { colours.mid = c; }),
      loadColours(W, lat, lon, LEVELS[1].half, 100).then((c) => { colours.near = c; }),
    ]).catch((err) => console.error(err)) : Promise.resolve();
    try {
      status('Loading detailed terrain around you…');
      sources.near = await loadDetail(W, lat, lon, LEVELS[1].half * 1.06, 1,
        (d, n) => status(`Loading detailed terrain around you… ${Math.round((100 * d) / n)}%`));
      if (W.imagery?.texture) status('Loading satellite images…');
      // don't wait forever for the imagery server: the terrain is shown either way
      await Promise.race([colourJob, new Promise((r) => setTimeout(r, 30000))]);
      if (closed) return;
      rebuild();
      status('Loading the surrounding landscape…');
      sources.mid = await loadDetail(W, lat, lon, LEVELS[2].half * 1.03, W.dem.midStep,
        (d, n) => status(`Loading the surrounding landscape… ${Math.round((100 * d) / n)}%`));
      if (closed) return;
      rebuild();
      status('');
    } catch (err) {
      console.error(err);
      if (!closed) status(`Could not load the detailed terrain (${key === 'earth' ? 'NASADEM' : 'NASA/USGS'} server unreachable); showing coarse terrain.`);
    }
  })().catch((err) => {
    console.error(err);
    if (!closed) status('Could not load the terrain.');
  });

  return function close() {
    closed = true;
    clearTimeout(crossingTimer);
    window.removeEventListener('keydown', onKey);
    ro.disconnect();
    for (const m of meshes) m.geometry.dispose();
    rockGeos.forEach((g) => g.dispose());
    for (let i = 0; i < 4; i++) uniforms[`uH${i}`].value?.dispose();
    textures.forEach((t) => t?.dispose());
    materials.forEach((m) => m?.dispose());
    renderer.dispose();
    renderer.forceContextLoss(); // hand the WebGL context back (browsers allow only ~16 at once)
  };
}
