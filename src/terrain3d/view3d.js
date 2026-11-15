// Interactive 3D view of Mars terrain, built from real NASA elevation data (MOLA, the same
// tiles the map's Elevation view uses), drawn with three.js (already used for the home-page
// globes). Rotate, tilt down to a low angle, pan and zoom; pick the route's A and B on the
// terrain; the planner's route is draped over the surface with its difficult parts in red.
//
// Honest limits: MOLA elevation here is ~2.6 km per pixel (stored in ~115 m steps, smoothed
// when drawn), so big craters and canyons show their real shape but small craters (< ~10 km)
// are blurred. The surface is drawn flat (no planet curvature) around the area's centre.
// Heights can be exaggerated to read the shape better; the factor is always shown.
//
// Moon (open({ world: 'moon', planner })): the same for the Moon's route planner, from LRO LOLA
// elevation (~1.9 km per pixel) with LRO WAC / Kaguya images.
//
// Earth (open({ world: 'earth', region })): an analog area from the Earth map, with heights
// from NASA NASADEM (~30 m; polar regions: AWS Terrain Tiles) and the satellite image draped
// on the area's tile (both loaded by src/surface3d/dem.js); the area is marked by a ring.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadIndex } from '../overlays.js';
import { layerSampler, MARS_R, RADIUS } from '../route/grid.js';
import { BODIES } from '../bodies.js';
import { formatLatLon } from '../geo.js';
// Earth (analog areas): NASADEM heights and satellite images, as in the Earth "Stand here in 3D"
import { WORLDS } from '../surface3d/worlds.js';
import { loadDetail, boxImage, earthDemSource } from '../surface3d/dem.js';

const DEG = Math.PI / 180;
let KM_PER_DEG = MARS_R * DEG; // of the world shown (set when the view opens)
const MAX_SIDE = 420;          // mesh vertices along the longer side
const MAX_REGION_KM = 1000;    // biggest middle tile (the whole model is 3 x 3 tiles)
const MIN_REGION_KM = 12;
const EXAGGERATIONS = [5, 10];
const TILES = 3;               // 3 x 3 tiles: the route's tile in the middle, its 8 neighbours around
const GRID = 3 * 256 + 1;      // vertices per side (769: ~256 per tile, the highest detail we draw)
const FOG = '#2b1f19';         // haze colour at the horizon (matches the sky's lower edge)
const IMG_W = 2050; // draped image width (2048 + a 1-pixel border on each side)
const SHOWCASE = {
  mars: { lat: -5.4, lon: 137.8, wKm: 180, hKm: 180, name: 'Gale Crater (Curiosity)' },
  moon: { lat: -43.3, lon: -11.2, wKm: 180, hKm: 180, name: 'Tycho crater' },
};
const $ = (id) => document.getElementById(id);
const fmtM = (km) => `${Math.round(km * 1000).toLocaleString()} m`;

// Elevation colours: Mars rust reds, deeper in low ground, a little lighter on high ground
const ELEV_STOPS = [
  [0.0, [66, 22, 13]], [0.3, [104, 34, 18]], [0.55, [140, 48, 25]], [0.8, [166, 64, 34]], [1.0, [186, 84, 48]],
];
// Moon: dark grey lowland (maria) -> pale grey highland
const MOON_ELEV_STOPS = [
  [0.0, [52, 52, 54]], [0.35, [92, 91, 90]], [0.7, [138, 136, 132]], [1.0, [184, 182, 176]],
];
// Earth: green lowland -> tan -> brown -> grey-white peaks (used around the satellite image)
const EARTH_ELEV_STOPS = [
  [0.0, [72, 104, 60]], [0.3, [150, 140, 92]], [0.6, [160, 118, 78]], [0.85, [128, 104, 90]], [1.0, [220, 216, 210]],
];
// What differs between the worlds
const STYLE = {
  mars: {
    title: '3D terrain · Mars',
    help: 'Drag to rotate · right-drag (or Ctrl/⌘-drag) to pan · scroll or pinch to zoom · click the ground to set A and B.',
    sky: ['#060609', '#120e11', FOG], hemi: [0xffe0cc, 0x2a100a], skirt: 0x3a140b,
    elevStops: null, // ELEV_STOPS
    colours: [['elevation', 'Elevation'], ['slope', 'Slope']], exag: [5, 10], exag0: 5,
    dem: 'MGS MOLA', slopeSrc: 'MOLA', images: 'Viking, CTX', ti: { src: 'TES', mid: 250, span: 0.6 },
  },
  moon: {
    title: '3D terrain · Moon',
    help: 'Drag to rotate · right-drag (or Ctrl/⌘-drag) to pan · scroll or pinch to zoom · click the ground to set A and B.',
    sky: ['#000000', '#030304', '#0b0b0e'], hemi: [0xf4f4f4, 0x161616], skirt: 0x2e2e30,
    elevStops: MOON_ELEV_STOPS,
    colours: [['elevation', 'Elevation'], ['slope', 'Slope']], exag: [5, 10], exag0: 5,
    // Diviner thermal inertia on the Moon only spans ~25-60 TIU
    dem: 'LRO LOLA', slopeSrc: 'LOLA', images: 'LRO WAC, Kaguya TC', ti: { src: 'Diviner', mid: 42, span: 0.15 },
  },
  earth: {
    title: '3D terrain · Earth',
    help: 'Drag to rotate · right-drag (or Ctrl/⌘-drag) to pan · scroll or pinch to zoom. The orange ring is the analog area.',
    sky: ['#0d2547', '#4f86c0', '#b9d2e8'], hemi: [0xe4f0ff, 0x4a3c2c], skirt: 0x4a3a2a,
    elevStops: EARTH_ELEV_STOPS,
    colours: [['imagery', 'Satellite'], ['elevation', 'Elevation'], ['slope', 'Slope']], exag: [1, 2, 5], exag0: 2,
  },
};
// slope colours: green (gentle) -> amber -> red (steep)
const SLOPE_STOPS = [[0, [76, 160, 110]], [0.33, [215, 190, 90]], [0.6, [230, 130, 60]], [1, [200, 50, 50]]];
function ramp(stops, t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]; const [t1, c1] = stops[i];
      const f = (x - t0) / (t1 - t0);
      return c0.map((c, k) => (c + (c1[k] - c) * f) / 255);
    }
  }
  return stops[stops.length - 1][1].map((c) => c / 255);
}

/**
 * Creates the 3D view (once per page). open({ getLeafletView, planner, onClose }):
 * `getLeafletView()` gives the 2D map's centre and size (km) so the 3D view opens on the same
 * area; `planner` is the route planner (or null).
 */
export function createView3D({ routeEvents }) {
  let getLeafletView = () => ({ lat: 0, lon: 0, wKm: 600, hKm: 600 });
  let planner = null;
  let onClose = null;
  const root = $('terrain3d');
  const canvasHost = $('terrain3d-canvas');
  let renderer = null; let scene = null; let camera = null; let controls = null;
  let terrain = null;      // { mesh, heights, rows, cols, lat0, lon0, wKm, hKm, kx, slope }
  let routeGroup = null; let markerGroup = null; let hoverDot = null;
  let exaggeration = 5;
  let userExaggeration = false; // the user picked one: don't change it automatically
  let colourMode = 'elevation';
  let world = 'mars';     // 'mars' / 'moon' (route planner) or 'earth' (analog areas)
  let style = STYLE.mars;
  const elevStops = () => style.elevStops ?? ELEV_STOPS;
  // elevation colour of a height (km); on Earth the sea (NASADEM stores it as exactly 0 m) is blue
  const SEA = [0.16, 0.3, 0.45];
  const elevColour = (h, lo, span) => (world === 'earth' && Math.abs(h) < 0.0005 ? SEA : ramp(elevStops(), (h - lo) / span));
  // One continuous mesh to the horizon: vertices packed densely around the chosen area and
  // spread out further away (a sinh-shaped spacing), so there is no square edge anywhere.
  let animId = 0;
  let building = 0;
  let isOpen = false;
  const raycaster = new THREE.Raycaster();

  function setStatus(t) { $('terrain3d-status').textContent = t; }

  // Sky, light, panel texts and buttons of the world shown. Mars: dusky sky, dark overhead,
  // a faint butterscotch glow at the horizon. Earth: blue sky, paler towards the horizon.
  function setWorld(w) {
    world = w;
    style = STYLE[w];
    KM_PER_DEG = (w === 'earth' ? WORLDS.earth.radius / 1000 : RADIUS[w] ?? MARS_R) * DEG;
    const sky = document.createElement('canvas');
    sky.width = 2; sky.height = 256;
    const sc = sky.getContext('2d');
    const sg = sc.createLinearGradient(0, 0, 0, 256);
    sg.addColorStop(0, style.sky[0]); sg.addColorStop(0.55, style.sky[1]); sg.addColorStop(0.8, style.sky[2]); sg.addColorStop(1, style.sky[2]);
    sc.fillStyle = sg; sc.fillRect(0, 0, 2, 256);
    scene.background?.dispose?.();
    scene.background = new THREE.CanvasTexture(sky);
    scene.background.colorSpace = THREE.SRGBColorSpace;
    scene.userData.hemi.color.setHex(style.hemi[0]);
    scene.userData.hemi.groundColor.setHex(style.hemi[1]);
    $('terrain3d-title').textContent = style.title;
    $('terrain3d-help').textContent = style.help;
    exaggeration = style.exag0;
    userExaggeration = false;
    colourMode = style.colours[0][0];
    makeButtons();
  }
  // The draped image: Mars, the middle tile (2048 px wide); Earth, the whole 3 x 3 model
  // (4096 px wide, so the analog area still gets ~1300 px). Plus a 1-pixel white border.
  const imgBox = () => (world === 'earth' ? { w: terrain.ex, h: terrain.ez } : { w: terrain.wKm, h: terrain.hKm });
  const imgW = () => (world === 'earth' ? Math.min(4096, renderer.capabilities.maxTextureSize - 2) + 2 : IMG_W);
  const imgH = () => Math.max(258, Math.round(((imgW() - 2) * imgBox().h) / imgBox().w) + 2);

  // ---- three.js setup (once)
  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(3, window.devicePixelRatio || 1)); // full screen sharpness
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    canvasHost.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e5);
    scene.userData.hemi = new THREE.HemisphereLight(0xffe0cc, 0x2a100a, 0.6);
    scene.add(scene.userData.hemi);
    const sun = new THREE.DirectionalLight(0xffeedd, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);
    scene.userData.sun = sun;
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;       // pan along the ground
    controls.maxPolarAngle = Math.PI * 0.497;  // down to just above the horizon
    controls.zoomToCursor = true;
    controls.zoomSpeed = 1.2;
    controls.addEventListener('change', updateClip);
    new ResizeObserver(resize).observe(canvasHost);
    resize();
    // click (not drag) on the terrain: pick A / B
    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => { tween = null; down = { x: e.clientX, y: e.clientY, b: e.button }; });
    renderer.domElement.addEventListener('wheel', () => { tween = null; }, { passive: true });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || down.b !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const hit = pick(e);
      if (!hit || !planner) return;
      if (!planner.isOpen()) planner.open();
      planner.click({ lat: hit.lat, lng: hit.lon });
    });
    renderer.domElement.addEventListener('pointermove', throttle((e) => {
      const hit = pick(e);
      $('terrain3d-cursor').textContent = hit ? `${formatLatLon(hit.lat, hit.lon)} · elevation ${fmtM(hit.h)}` : '';
    }, 60));
  }

  function throttle(fn, ms) {
    let t = 0;
    return (e) => { const now = performance.now(); if (now - t > ms) { t = now; fn(e); } };
  }

  function resize() {
    if (!renderer) return;
    const w = canvasHost.clientWidth || 1;
    const h = canvasHost.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // near/far planes follow the camera so zooming right in doesn't clip the ground
  function updateClip() {
    if (!terrain) return;
    const d = camera.position.distanceTo(controls.target);
    camera.near = Math.max(0.002, d / 5000);
    camera.far = d * 20 + Math.max(terrain.ex, terrain.ez) * 1.5;
    camera.updateProjectionMatrix();
  }

  let tween = null; // { from: {pos, target}, to: {pos, target}, t0, ms }

  // The panels cover the left and right of the screen: centre the view (and the point the
  // camera orbits around) in the free space between them.
  let free = { frac: 1, shift: 0 };
  function updateViewOffset() {
    const W = canvasHost.clientWidth; const H = canvasHost.clientHeight;
    if (!W || !H) return;
    let left = 0; let right = W;
    if (W > 600) {
      const bar = root.querySelector('.terrain3d-bar')?.getBoundingClientRect();
      const rp = document.getElementById('route-panel');
      if (bar && bar.width) left = Math.max(left, bar.right);
      if (rp && !rp.hidden) { const r = rp.getBoundingClientRect(); if (r.width) right = Math.min(right, r.left); }
    }
    if (right - left < W * 0.3) { left = 0; right = W; }
    const shift = Math.round(W / 2 - (left + right) / 2);
    const frac = (right - left) / W;
    if (shift !== free.shift || Math.abs(frac - free.frac) > 0.01) {
      free = { frac, shift };
      if (shift) camera.setViewOffset(W, H, shift, 0, W, H); else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }
  }

  function loop() {
    animId = requestAnimationFrame(loop);
    updateViewOffset();
    if (tween) {
      const t = Math.min(1, (performance.now() - tween.t0) / tween.ms);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
      camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
      controls.target.lerpVectors(tween.from.target, tween.to.target, e);
      if (t >= 1) tween = null;
      updateClip();
    }
    controls.update();
    renderer.render(scene, camera);
  }

  // ---- coordinates: local km on a flat plane around the area's centre
  const toLocal = (lat, lon) => {
    const l = lon + Math.round((terrain.lon0 - lon) / 360) * 360;
    return [(l - terrain.lon0) * terrain.kx, -(lat - terrain.lat0) * KM_PER_DEG];
  };
  const toLatLon = (x, z) => {
    const lat = terrain.lat0 - z / KM_PER_DEG;
    const lon = terrain.lon0 + x / terrain.kx;
    return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
  };
  // terrain height (km, not exaggerated) at local x, z, interpolated from the mesh grid
  function heightAt(x, z) {
    const { rows, cols, heights, ax, az } = terrain;
    const fx = Math.min(cols - 1, Math.max(0, ((invAxis(ax, x) + 1) / 2) * (cols - 1)));
    const fz = Math.min(rows - 1, Math.max(0, ((invAxis(az, z) + 1) / 2) * (rows - 1)));
    const c0 = Math.floor(fx); const r0 = Math.floor(fz);
    const c1 = Math.min(cols - 1, c0 + 1); const r1 = Math.min(rows - 1, r0 + 1);
    const tx = fx - c0; const tz = fz - r0;
    const h = (r, c) => heights[r * cols + c];
    return (h(r0, c0) * (1 - tx) + h(r0, c1) * tx) * (1 - tz) + (h(r1, c0) * (1 - tx) + h(r1, c1) * tx) * tz;
  }

  function pick(e) {
    if (!terrain) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(terrain.mesh, false)[0];
    if (!hit) return null;
    const ll = toLatLon(hit.point.x, hit.point.z);
    return { ...ll, h: heightAt(hit.point.x, hit.point.z) };
  }

  // ---- building the terrain
  // build() never leaves the view stuck on "Reading…": a failure shows in the status line
  function build(region) {
    const my = building + 1;
    return buildTerrain(region).catch((err) => {
      console.error(err);
      if (my !== building) return;
      root.classList.remove('busy');
      setStatus(`Could not load the elevation data (${err.message || err}). Close the 3D view and open it again to retry.`);
    });
  }
  async function buildTerrain(region) {
    const my = ++building;
    setStatus(world === 'earth' ? 'Reading NASA elevation data (NASADEM)…' : 'Reading NASA elevation data…');
    root.classList.add('busy');
    const wKm = Math.min(MAX_REGION_KM, Math.max(MIN_REGION_KM, region.wKm));
    const hKm = Math.min(MAX_REGION_KM, Math.max(MIN_REGION_KM, region.hKm));
    const lat0 = Math.max(-84, Math.min(84, region.lat));
    const lon0 = region.lon;
    const kx = KM_PER_DEG * Math.max(0.05, Math.cos(lat0 * DEG));
    const dLat = hKm / 2 / KM_PER_DEG;
    const dLon = wKm / 2 / kx;
    const size = Math.max(wKm, hKm);
    // the model: 3 x 3 tiles of the area's size, the area (route) in the middle tile
    const ex = wKm * TILES;
    const ez = Math.min(hKm * TILES, 2 * (89.5 - Math.abs(lat0)) * KM_PER_DEG + hKm);
    const ax = makeAxis(ex); const az = makeAxis(ez);
    const rows = GRID; const cols = GRID;
    const n = rows * cols;
    const raw = new Float32Array(n);
    const slopes = new Float32Array(n);
    const surface = new Float32Array(n).fill(NaN); // thermal inertia (Mars TES, Moon Diviner): low = dust, high = rock
    const fine = new Float32Array(n).fill(1);
    let missing = 0;
    let pxKm; let demSource = world === 'moon' ? 'lola' : 'mola';
    const latOf = (r) => Math.max(-89.9, Math.min(89.9, lat0 - az.pos[r] / KM_PER_DEG));
    const lonOf = (c) => ((((lon0 + ax.pos[c] / kx) + 180) % 360) + 360) % 360 - 180;
    if (world === 'earth') {
      // NASADEM (~30 m), read at the step that just covers the mesh's spacing (~ex / 768)
      const W = WORLDS.earth;
      const cellM = (Math.max(ex, ez) * 1000) / (GRID - 1);
      const step = Math.max(1, Math.min(32, 2 ** Math.floor(Math.log2(Math.max(1, cellM / 30)))));
      const halfM = (Math.max(ex, ez) / 2) * 1000 * 1.02;
      demSource = earthDemSource(W, lat0, lon0, halfM);
      const dem = await loadDetail(W, lat0, lon0, halfM, step,
        (d, t) => setStatus(`Reading NASA elevation data (NASADEM)… ${Math.round((100 * d) / t)}%`));
      if (my !== building) return;
      if (dem.source) demSource = dem.source; // NASADEM unreachable: AWS terrain tiles instead
      for (let r = 0; r < rows; r++) {
        const lat = latOf(r);
        for (let c = 0; c < cols; c++) raw[r * cols + c] = dem.get(lat, lonOf(c)) / 1000; // km
      }
      // slope from the heights themselves (degrees)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const r0 = Math.max(0, r - 1); const r1 = Math.min(rows - 1, r + 1);
          const c0 = Math.max(0, c - 1); const c1 = Math.min(cols - 1, c + 1);
          const gx = (raw[r * cols + c1] - raw[r * cols + c0]) / (ax.pos[c1] - ax.pos[c0]);
          const gz = (raw[r1 * cols + c] - raw[r0 * cols + c]) / (az.pos[r1] - az.pos[r0]);
          slopes[r * cols + c] = Math.atan(Math.hypot(gx, gz)) / DEG;
        }
      }
      pxKm = demSource === 'nasadem' ? 0.03 * step : 0.04;
    } else {
      const index = await loadIndex();
      const metas = index[world];
      // the most detailed elevation, slope and surface tiles over the whole model
      const box = [Math.max(-89.9, lat0 - ez / 2 / KM_PER_DEG), Math.min(89.9, lat0 + ez / 2 / KM_PER_DEG),
        lon0 - Math.min(179, ex / 2 / kx), lon0 + Math.min(179, ex / 2 / kx)];
      const [fe, fs, fu] = await Promise.all([
        layerSampler('elevation', metas.elevation, ...box, undefined, world),
        layerSampler('slope', metas.slope, ...box, undefined, world),
        layerSampler('surface', metas.surface, ...box, undefined, world),
      ]);
      if (my !== building) return;
      setStatus('Removing the storage steps from the elevation data…');
      await new Promise((r) => setTimeout(r, 0));
      const dem = dequantizedGrid(fe, metas.elevation, box);
      for (let r = 0; r < rows; r++) {
        const lat = latOf(r);
        for (let c = 0; c < cols; c++) {
          const lon = lonOf(c);
          const i = r * cols + c;
          let h = dem.at(lat, lon);
          if (Number.isNaN(h)) { h = 0; missing++; }
          raw[i] = h;
          slopes[i] = fs.smooth(lat, lon);
          surface[i] = fu.smooth(lat, lon);
        }
      }
      // no extra blur: the dequantized grid is already free of the storage steps
      pxKm = (180 / (256 * 2 ** metas.elevation.max_zoom)) * KM_PER_DEG;
    }
    const heights = raw;
    const cellKm = ax.step[(cols - 1) / 2];
    terrain?.mesh.geometry.dispose();
    if (terrain) scene.remove(terrain.mesh);
    terrain = { rows, cols, wKm, hKm, ex, ez, ax, az, lat0, lon0, kx, heights, slopes, surface, fine, cellKm, pxKm, missing, size,
      demSource, ringKm: region.ringKm ?? 0 };
    // heights x5 unless x10 was chosen
    refreshButtons();
    makeMesh();
    await applyColours();
    if (my !== building) return;
    placeSun();
    scene.fog = null; // no haze: everything in the model stays sharp
    makeSkirt();
    resetCamera();
    drawRoute();
    if (planner?.result()?.route) frameRoute();
    root.classList.remove('busy');
    const { lo, hi } = areaRange();
    setStatus(`${region.name ? `${region.name} · ` : ''}${Math.round(terrain.ex).toLocaleString()} × ${Math.round(terrain.ez).toLocaleString()} km (3 × 3 tiles of ${Math.round(wKm).toLocaleString()} km) · elevation ${fmtM(lo)} to ${fmtM(hi)}${region.note ? ` · ${region.note}` : ''}`);
    updateInfo();
    // try the spacecraft images in the background; switch to them if the servers allow it

  }

  let triedImagery = false;
  async function tryImagery(my) {
    const tex = await Promise.race([imageryTexture(), new Promise((r) => setTimeout(() => r(null), world === 'earth' ? 30000 : 12000))]).catch(() => null);
    if (!tex || my !== building || colourMode !== 'elevation') return;
    colourMode = 'imagery';
    refreshButtons();
    await applyColours(tex);
  }

  // Heights exaggerated so the relief reads well: the tallest features become ~7% of the
  // area's width (rounded to one of the offered factors, at most x5; x10 only by hand).
  // Always shown on screen.
  function autoExaggeration(heights, fine, size) {
    const sorted = Float32Array.from(heights.filter((_, i) => fine[i] > 0.99)).sort();
    const relief = Math.max(0.05, sorted[Math.floor(sorted.length * 0.99)] - sorted[Math.floor(sorted.length * 0.01)]);
    const ideal = (0.07 * size) / relief;
    let best = 1;
    for (const x of EXAGGERATIONS) if (x <= 5 && Math.abs(Math.log(x / ideal)) < Math.abs(Math.log(best / ideal))) best = x;
    return best;
  }

  // Positions along one axis: dense around the area (about its size / 400 apart), spreading out
  // smoothly to the far edge: pos(u) = E/2 * sinh(k u) / sinh(k), u in [-1, 1].
  function makeAxis(extent) {
    const du = 2 / (GRID - 1);
    const k = 0; // evenly spaced
    const f = (u) => (k < 1e-6 ? u : Math.sinh(k * u) / Math.sinh(k)) * (extent / 2);
    const pos = new Float64Array(GRID); const step = new Float64Array(GRID);
    for (let i = 0; i < GRID; i++) pos[i] = f(-1 + i * du);
    for (let i = 0; i < GRID; i++) step[i] = i < GRID - 1 ? pos[i + 1] - pos[i] : pos[i] - pos[i - 1];
    return { k, extent, pos, step };
  }
  // the axis position u in [-1, 1] of a coordinate
  function invAxis(axis, x) {
    const t = Math.max(-1, Math.min(1, x / (axis.extent / 2)));
    return axis.k < 1e-6 ? t : Math.asinh(t * Math.sinh(axis.k)) / axis.k;
  }
  // elevation range inside the chosen area (for colours and the status line)
  function areaRange() {
    let lo = Infinity; let hi = -Infinity;
    terrain.heights.forEach((h, i) => { if (terrain.fine[i] > 0.99) { if (h < lo) lo = h; if (h > hi) hi = h; } });
    return { lo, hi };
  }

  // The elevation tiles store heights in steps of ~115 m (8 bits). The true height of each
  // data pixel lies somewhere inside its step. Find the smoothest surface that stays inside
  // every pixel's step: repeated smoothing, each time clamped back into the allowed range.
  // Flat plains lose their fake terraces, while cliffs and crater walls (which span many
  // steps) stay sharp. Nothing is invented: every height stays within what NASA measured.
  function dequantizedGrid(sampler, meta, [south, north, west, east]) {
    const z = meta.max_zoom;
    const W = 512 * 2 ** z; const H = 256 * 2 ** z;
    const r0 = Math.max(0, Math.floor(((90 - north) / 180) * H) - 3);
    const r1 = Math.min(H - 1, Math.ceil(((90 - south) / 180) * H) + 3);
    const c0 = Math.floor(((west + 180) / 360) * W) - 3;
    const c1 = Math.ceil(((east + 180) / 360) * W) + 3;
    const rows = r1 - r0 + 1; const cols = c1 - c0 + 1;
    const q = new Float32Array(rows * cols);
    const known = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const lat = 90 - ((r0 + r + 0.5) / H) * 180;
      for (let c = 0; c < cols; c++) {
        const lon = ((c0 + c + 0.5) / W) * 360 - 180;
        const v = sampler.at(lat, ((((lon + 180) % 360) + 360) % 360) - 180);
        if (!Number.isNaN(v)) { q[r * cols + c] = v; known[r * cols + c] = 1; }
      }
    }
    const half = ((meta.enc_max - meta.enc_min) / 254) / 2; // half a storage step, km
    let h = Float32Array.from(q);
    // coarse-to-fine smoothing, clamped into each pixel's step after every pass
    for (const sigma of [16, 12, 8, 6, 5, 4, 3, 2.5, 2, 1.6, 1.3, 1, 1, 0.8, 0.8, 0.7, 0.7]) {
      h = blur(h, rows, cols, sigma);
      for (let i = 0; i < h.length; i++) {
        if (!known[i]) continue;
        const lo = q[i] - half; const hi = q[i] + half;
        if (h[i] < lo) h[i] = lo; else if (h[i] > hi) h[i] = hi;
      }
    }
    // a final light pass (under one data pixel) takes the corners off what's left of the steps
    h = blur(h, rows, cols, 0.9);
    // Catmull-Rom (bicubic) interpolation between data pixels: smooth curves, no facets
    const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    const get = (r, c) => h[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
    return {
      at(lat, lon) {
        let l = lon;
        const ref = ((c0 + c1) / 2 / W) * 360 - 180;
        l += Math.round((ref - l) / 360) * 360; // same side of the map as the grid
        const fy = ((90 - lat) / 180) * H - 0.5 - r0;
        const fx = ((l + 180) / 360) * W - 0.5 - c0;
        const ry = Math.floor(fy); const rx = Math.floor(fx);
        const ty = fy - ry; const tx = fx - rx;
        const row = (rr) => cr(get(rr, rx - 1), get(rr, rx), get(rr, rx + 1), get(rr, rx + 2), tx);
        return cr(row(ry - 1), row(ry), row(ry + 1), row(ry + 2), ty);
      },
    };
  }

  function blur(src, rows, cols, sigma) {
    const rad = Math.ceil(sigma * 2.5);
    const k = []; let ks = 0;
    for (let i = -rad; i <= rad; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); ks += w; }
    const tmp = new Float32Array(src.length); const out = new Float32Array(src.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0; let ws = 0;
        for (let i = -rad; i <= rad; i++) { const cc = c + i; if (cc < 0 || cc >= cols) continue; s += src[r * cols + cc] * k[i + rad]; ws += k[i + rad]; }
        tmp[r * cols + c] = s / ws;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0; let ws = 0;
        for (let i = -rad; i <= rad; i++) { const rr = r + i; if (rr < 0 || rr >= rows) continue; s += tmp[rr * cols + c] * k[i + rad]; ws += k[i + rad]; }
        out[r * cols + c] = s / ws;
      }
    }
    return ks ? out : src;
  }

  // Separable Gaussian blur with its own width for every column and row.
  function blurVar(src, rows, cols, sigX, sigZ) {
    const tmp = new Float32Array(src.length); const out = new Float32Array(src.length);
    const pass = (from, to, n, m, sig, at) => {
      for (let a = 0; a < m; a++) {
        for (let b = 0; b < n; b++) {
          const sg = sig[b]; const rad = Math.min(50, Math.ceil(sg * 2.5));
          let s = 0; let ws = 0;
          for (let i = -rad; i <= rad; i++) {
            const bb = b + i; if (bb < 0 || bb >= n) continue;
            const w = Math.exp(-(i * i) / (2 * sg * sg));
            s += from[at(a, bb)] * w; ws += w;
          }
          to[at(a, b)] = s / ws;
        }
      }
    };
    pass(src, tmp, cols, rows, sigX, (r, c) => r * cols + c);
    pass(tmp, out, rows, cols, sigZ, (c, r) => r * cols + c);
    return out;
  }

  // Side walls down to a flat base, so the model looks like a solid block of terrain.
  let skirt = null;
  function makeSkirt() {
    if (skirt) { scene.remove(skirt); skirt.geometry.dispose(); skirt.material.dispose(); skirt = null; }
    const { rows, cols, ax, az, heights } = terrain;
    let lo = Infinity;
    for (const h of heights) lo = Math.min(lo, h);
    const base = lo * exaggeration - Math.max(terrain.ex, terrain.ez) * 0.02;
    const edge = [];
    for (let c = 0; c < cols; c++) edge.push([0, c]);
    for (let r = 1; r < rows; r++) edge.push([r, cols - 1]);
    for (let c = cols - 2; c >= 0; c--) edge.push([rows - 1, c]);
    for (let r = rows - 2; r >= 0; r--) edge.push([r, 0]);
    const pos = [];
    for (let i = 0; i < edge.length; i++) {
      const [r1, c1] = edge[i]; const [r2, c2] = edge[(i + 1) % edge.length];
      const x1 = ax.pos[c1]; const z1 = az.pos[r1]; const y1 = heights[r1 * cols + c1] * exaggeration;
      const x2 = ax.pos[c2]; const z2 = az.pos[r2]; const y2 = heights[r2 * cols + c2] * exaggeration;
      pos.push(x1, y1, z1, x1, base, z1, x2, y2, z2, x2, y2, z2, x1, base, z1, x2, base, z2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    skirt = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: style.skirt, roughness: 1, side: THREE.DoubleSide }));
    scene.add(skirt);
  }

  function makeMesh() {
    const { rows, cols, heights, ax, az } = terrain;
    const geo = new THREE.PlaneGeometry(1, 1, cols - 1, rows - 1);
    geo.rotateX(-Math.PI / 2); // now x = east, z = south, y = up
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const box = imgBox(); const iw = imgW(); const ih = imgH();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        pos.setXYZ(i, ax.pos[c], heights[i] * exaggeration, az.pos[r]);
        // texture coordinates for draped images: the area maps to the image's inner part,
        // everything outside to its white border (so outside, the vertex colours show)
        const u = (ax.pos[c] + box.w / 2) / box.w;
        const v = 1 - (az.pos[r] + box.h / 2) / box.h;
        const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
        uv.setXY(i, inside ? (1 + u * (iw - 2)) / iw : 0.5 / iw, inside ? (1 + v * (ih - 2)) / ih : 0.5 / ih);
      }
    }
    geo.computeBoundingSphere();
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    terrain.mesh = mesh;
  }

  function setExaggeration(x) {
    exaggeration = x;
    if (!terrain) return;
    const pos = terrain.mesh.geometry.attributes.position;
    const { heights } = terrain;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i] * exaggeration);
    pos.needsUpdate = true;
    terrain.mesh.geometry.computeVertexNormals();
    terrain.mesh.geometry.computeBoundingSphere();
    terrain.mesh.geometry.computeBoundingBox();
    makeSkirt();
    drawRoute();
    updateInfo();
  }

  async function applyColours(readyTexture = null) {
    const { heights, slopes, surface, mesh, fine } = terrain;
    const col = mesh.geometry.attributes.color;
    const { lo, hi } = areaRange();
    const span = Math.max(0.05, hi - lo);
    mesh.material.map = null;
    if (colourMode === 'imagery') {
      const tex = readyTexture ?? await Promise.race([imageryTexture(), new Promise((r) => setTimeout(() => r(null), world === 'earth' ? 30000 : 12000))]).catch(() => null);
      if (tex) {
        // images inside the area; elevation colours outside (multiplied by the white border)
        const { ax, az, cols } = terrain;
        const { w: wKm, h: hKm } = imgBox();
        for (let i = 0; i < col.count; i++) {
          const inTile = Math.abs(ax.pos[i % cols]) <= wKm / 2 && Math.abs(az.pos[Math.floor(i / cols)]) <= hKm / 2;
          if (inTile && fine[i] > 0.99) { col.setXYZ(i, 1, 1, 1); continue; }
          const c = elevColour(heights[i], lo, span);
          col.setXYZ(i, c[0], c[1], c[2]);
        }
        mesh.material.map = tex;
        col.needsUpdate = true;
        mesh.material.needsUpdate = true;
        $('terrain3d-legend').textContent = world === 'earth'
          ? 'Colour: satellite image (Esri, Maxar, Earthstar Geographics) draped on the terrain'
          : `Colour: spacecraft images (${style.images}) draped on the terrain`;
        return;
      }
      colourMode = 'elevation';
      refreshButtons();
      setStatus('The image servers don\'t allow their pictures to be used in 3D here, so the terrain is coloured by elevation.');
    }
    for (let i = 0; i < col.count; i++) {
      let c;
      if (colourMode === 'slope') {
        c = Number.isNaN(slopes[i]) ? [0.5, 0.5, 0.5] : ramp(SLOPE_STOPS, slopes[i] / 25);
      } else {
        c = elevColour(heights[i], lo, span);
        // real surface type (thermal inertia): fine bright dust lighter, rock and bedrock darker
        const ti = surface[i];
        if (!Number.isNaN(ti)) {
          const t = Math.min(1, Math.max(-1, (Math.log10(ti) - Math.log10(style.ti.mid)) / style.ti.span));
          const f = 1 - 0.12 * t;
          c = [c[0] * f, c[1] * f, c[2] * f];
        }
      }
      col.setXYZ(i, c[0], c[1], c[2]);
    }
    col.needsUpdate = true;
    mesh.material.needsUpdate = true;
    $('terrain3d-legend').innerHTML = colourMode === 'slope'
      ? `Colour: slope (${world === 'earth' ? 'from NASADEM' : style.slopeSrc}) · <span style="color:#4ca06e">■</span> flat · <span style="color:#d7be5a">■</span> 8° · <span style="color:#e6823c">■</span> 15° · <span style="color:#c83232">■</span> 25°+`
      : world === 'earth'
        ? `Colour: elevation (green = ${fmtM(lo)}, brown to white = ${fmtM(hi)})`
        : `Colour: elevation (dark = ${fmtM(lo)}, pale = ${fmtM(hi)}), lighter where the ground is dusty and darker where it's rocky (${style.ti.src} thermal inertia)`;
  }

  // Spacecraft images for the texture, read from the same tile servers as the 2D map.
  // Only works if the server allows cross-site use of its images (CORS).
  async function imageryTexture() {
    const { lat0, lon0, kx } = terrain;
    const { w: wKm, h: hKm } = imgBox();
    const dLat = hKm / 2 / KM_PER_DEG; const dLon = wKm / 2 / kx;
    const south = lat0 - dLat; const north = lat0 + dLat; const west = lon0 - dLon; const east = lon0 + dLon;
    const W = imgW() - 2; const H = imgH() - 2;
    const cv = document.createElement('canvas');
    cv.width = imgW(); cv.height = imgH();
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(1, 1); // keep a 1-pixel white border (used outside the area)
    let drawn = 0;
    if (world === 'earth') {
      // Esri World Imagery, resampled onto the area's lat/lon box (as the Earth 3D view's ground)
      const px = await boxImage(WORLDS.earth, south, north, west, east, W, H);
      ctx.putImageData(new ImageData(px, W, H), 1, 1); // (putImageData ignores the translate)
      drawn = 1;
    }
    for (const layer of world === 'earth' ? [] : BODIES[world].layers) {
      const tile = layer.tileSize ?? 256;
      // a mosaic that only covers part of the globe (Kaguya: 70 S - 70 N) is left out beyond it
      if (layer.bounds && (north > layer.bounds[1][0] || south < layer.bounds[0][0])) continue;
      const worldPxNeeded = (W / (east - west)) * 360;
      let z = Math.ceil(Math.log2(worldPxNeeded / 512));
      z = Math.min(layer.maxNativeZoom, Math.max(0, z));
      if (layer.minZoom && z < layer.minZoom) continue;
      const worldPx = 512 * 2 ** z;
      const nTx = worldPx / tile;
      const x0 = Math.floor(((west + 180) / 360) * nTx); const x1 = Math.floor(((east + 180) / 360) * nTx);
      const y0 = Math.max(0, Math.floor(((90 - north) / 180) * (nTx / 2))); const y1 = Math.min(nTx / 2 - 1, Math.floor(((90 - south) / 180) * (nTx / 2)));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 160) continue; // too many tiles
      ctx.filter = layer.filter ?? 'none';
      const jobs = [];
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const txw = ((tx % nTx) + nTx) % nTx;
          const url = layer.url.replace('{z}', z + (layer.zoomOffset ?? 0)).replace('{y}', ty).replace('{x}', txw);
          jobs.push(new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              const lonA = (tx / nTx) * 360 - 180; const lonB = ((tx + 1) / nTx) * 360 - 180;
              const latA = 90 - (ty / (nTx / 2)) * 180; const latB = 90 - ((ty + 1) / (nTx / 2)) * 180;
              const px = ((lonA - west) / (east - west)) * W; const py = ((north - latA) / (north - south)) * H;
              const pw = ((lonB - lonA) / (east - west)) * W; const ph = ((latA - latB) / (north - south)) * H;
              ctx.drawImage(img, px, py, pw + 0.5, ph + 0.5);
              drawn++;
              resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
          }));
        }
      }
      await Promise.all(jobs);
    }
    if (!drawn) throw new Error('no imagery');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.minFilter = THREE.LinearFilter; // no mipmaps: they'd smear the white border into the image
    tex.generateMipmaps = false;
    return tex;
  }

  function placeSun() {
    const sun = scene.userData.sun;
    const size = Math.max(terrain.ex, terrain.ez);
    // afternoon sun from the north-west, 35 degrees up: long shadows show the relief
    const el = 35 * DEG; const az = 315 * DEG;
    sun.position.set(Math.sin(az) * Math.cos(el) * size, Math.sin(el) * size, -Math.cos(az) * Math.cos(el) * size);
    sun.target.position.set(0, 0, 0);
    const cam = sun.shadow.camera;
    const half = Math.max(terrain.ex, terrain.ez) * 0.55;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0.01; cam.far = size * 10;
    cam.updateProjectionMatrix();
  }

  function centreHeight() { return heightAt(0, 0) * exaggeration; }

  function resetCamera() {
    const size = Math.max(terrain.wKm, terrain.hKm);
    const h = centreHeight();
    controls.target.set(0, h, 0);
    // looking north, tilted 55 degrees down from the horizon
    const d = Math.max(terrain.ex, terrain.ez) * 0.95;
    camera.position.set(0, h + d * Math.sin(55 * DEG), d * Math.cos(55 * DEG));
    controls.minDistance = Math.max(0.05, terrain.cellKm * 0.25);
    controls.maxDistance = Math.max(terrain.ex, terrain.ez) * 2.5;
    controls.update();
    updateClip();
  }

  // Fly the camera so the whole route fills the screen, seen from above at a tilt
  // (keeping the current compass direction).
  function frameRoute() {
    const pts = terrain?.routePts;
    if (!pts?.length) return;
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity; let ySum = 0;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); ySum += p.y; }
    // at least the middle tile: closer than that the ~2.6 km data shows no more detail
    const span = Math.max(x1 - x0, z1 - z0, terrain.wKm * 0.9);
    const target = new THREE.Vector3((x0 + x1) / 2, ySum / pts.length, (z0 + z1) / 2);
    // fit the route both in height and in the free width between the panels
    const fitH = span / 2 / Math.tan((camera.fov / 2) * DEG);
    const fitW = fitH / Math.max(0.2, camera.aspect * free.frac);
    const dist = Math.max(fitH, fitW) * 1.25;
    const dir = camera.position.clone().sub(controls.target).setY(0);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
    dir.normalize();
    const tilt = 55 * DEG; // degrees above the horizon
    const pos = target.clone().add(new THREE.Vector3(dir.x * Math.cos(tilt) * dist, Math.sin(tilt) * dist, dir.z * Math.cos(tilt) * dist));
    tween = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to: { pos, target }, t0: performance.now(), ms: 1100 };
  }

  function topView() {
    const d = camera.position.distanceTo(controls.target);
    camera.position.set(controls.target.x, controls.target.y + d, controls.target.z + d * 0.001);
    controls.update();
  }

  // ---- the route on the terrain
  function drawRoute() {
    if (!terrain) return;
    if (routeGroup) { scene.remove(routeGroup); disposeGroup(routeGroup); }
    if (markerGroup) { scene.remove(markerGroup); disposeGroup(markerGroup); }
    routeGroup = new THREE.Group();
    markerGroup = new THREE.Group();
    scene.add(routeGroup, markerGroup);
    hoverDot = null;
    if (terrain.ringKm) {
      // the analog area (Earth): an orange ring lying on the ground
      const size0 = Math.max(terrain.wKm, terrain.hKm);
      const ring = [];
      for (let k = 0; k < 180; k++) {
        const a = (k / 180) * 2 * Math.PI;
        const x = terrain.ringKm * Math.sin(a); const z = -terrain.ringKm * Math.cos(a);
        ring.push(new THREE.Vector3(x, heightAt(x, z) * exaggeration + size0 * 0.0015 + 0.01, z));
      }
      const curve = new THREE.CatmullRomCurve3(ring, true, 'centripetal');
      routeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 360, size0 * 0.0016, 8, true),
        new THREE.MeshBasicMaterial({ color: 0xffb347 })));
    }
    const state = planner?.result();
    if (!state) return;
    const size = Math.max(terrain.wKm, terrain.hKm);
    const lift = size * 0.0015 + 0.01;
    const pin = (p, colour) => {
      const [x, z] = toLocal(p.lat, p.lon);
      const y = heightAt(x, z) * exaggeration;
      const hgt = size * 0.04;
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.0012, size * 0.0012, hgt, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      stick.position.set(x, y + hgt / 2, z);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(size * 0.007, 16, 12), new THREE.MeshBasicMaterial({ color: colour }));
      ball.position.set(x, y + hgt, z);
      markerGroup.add(stick, ball);
    };
    if (state.a) pin(state.a, 0x7fd4ff);
    if (state.b) pin(state.b, 0xff7a7a);
    const r = state.route;
    if (!r) return;
    // draped line: densify between points so it follows the ground, then lift it a little
    const pts = []; const hardFlags = [];
    for (let k = 0; k < r.pts.length; k++) {
      const [x, z] = toLocal(r.pts[k][0], r.pts[k][1]);
      if (k > 0) {
        const [px, pz] = toLocal(r.pts[k - 1][0], r.pts[k - 1][1]);
        const steps = Math.max(1, Math.ceil(Math.hypot(x - px, z - pz) / (terrain.cellKm * 0.7)));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const xx = px + (x - px) * t; const zz = pz + (z - pz) * t;
          pts.push(new THREE.Vector3(xx, heightAt(xx, zz) * exaggeration + lift, zz));
          hardFlags.push(r.hard[k]);
        }
      }
      pts.push(new THREE.Vector3(x, heightAt(x, z) * exaggeration + lift, z));
      hardFlags.push(r.hard[k]);
    }
    terrain.routePts = pts;
    terrain.routeIndex = []; // route point k -> index into pts
    { let j = 0; for (let k = 0; k < r.pts.length; k++) { const [x, z] = toLocal(r.pts[k][0], r.pts[k][1]); while (j < pts.length - 1 && Math.hypot(pts[j].x - x, pts[j].z - z) > 1e-6) j++; terrain.routeIndex.push(j); } }
    const radius = size * 0.0016;
    const runs = [];
    let start = 0;
    for (let i = 1; i <= pts.length; i++) {
      if (i === pts.length || hardFlags[i] !== hardFlags[start]) {
        runs.push({ from: Math.max(0, start - 1), to: i - 1, hard: hardFlags[start] });
        start = i;
      }
    }
    for (const run of runs) {
      const seg = pts.slice(run.from, run.to + 1);
      if (seg.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(seg, false, 'centripetal');
      const geo = new THREE.TubeGeometry(curve, Math.max(2, seg.length * 3), radius, 8, false);
      const mat = new THREE.MeshBasicMaterial({ color: run.hard ? 0xe5484d : new THREE.Color(state.colour), depthTest: true });
      routeGroup.add(new THREE.Mesh(geo, mat));
    }
    // danger markers: small floating labels
    const icons = { slope: '⛰', crater: '◎', dust: '≋', storm: '🌪' };
    for (const d of r.dangers) {
      const p = pts[terrain.routeIndex[d.k]];
      if (!p) continue;
      const sprite = labelSprite(icons[d.type]);
      sprite.position.set(p.x, p.y + size * 0.02, p.z);
      sprite.scale.set(size * 0.025, size * 0.025, 1);
      markerGroup.add(sprite);
    }
  }

  function labelSprite(text) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(17,17,17,.9)';
    c.beginPath(); c.arc(32, 32, 28, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#ffb02e'; c.lineWidth = 5; c.stroke();
    c.fillStyle = '#fff'; c.font = '30px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  }

  function disposeGroup(g) {
    g.traverse((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
  }

  function showHover(k) {
    if (!terrain?.routePts) return;
    if (k < 0) { if (hoverDot) hoverDot.visible = false; return; }
    const p = terrain.routePts[terrain.routeIndex[k]];
    if (!p) return;
    if (!hoverDot) {
      const size = Math.max(terrain.wKm, terrain.hKm);
      hoverDot = new THREE.Mesh(new THREE.SphereGeometry(size * 0.006, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      markerGroup.add(hoverDot);
    }
    hoverDot.visible = true;
    hoverDot.position.copy(p);
  }

  // fly the camera to look at a point of the route from a low angle
  function focusOn(k) {
    const p = terrain?.routePts?.[terrain.routeIndex[k]];
    if (!p) return;
    const size = Math.max(terrain.wKm, terrain.hKm);
    const d = Math.max(terrain.cellKm * 6, size * 0.12);
    const dir = camera.position.clone().sub(controls.target).setY(0).normalize();
    controls.target.copy(p);
    camera.position.set(p.x + dir.x * d * 0.9, p.y + d * 0.45, p.z + dir.z * d * 0.9);
    controls.update();
  }

  // ---- what area to show
  function regionFromRoute(state) {
    const pts = state?.route?.pts ?? [state?.a, state?.b].filter(Boolean).map((p) => [p.lat, p.lon]);
    if (pts.length < 2) return null;
    const ref = pts[0][1];
    let la0 = Infinity; let la1 = -Infinity; let lo0 = Infinity; let lo1 = -Infinity;
    for (const [lat, lon0] of pts) {
      const lon = lon0 + Math.round((ref - lon0) / 360) * 360;
      la0 = Math.min(la0, lat); la1 = Math.max(la1, lat); lo0 = Math.min(lo0, lon); lo1 = Math.max(lo1, lon);
    }
    const lat = (la0 + la1) / 2; const lon = (lo0 + lo1) / 2;
    const kx = KM_PER_DEG * Math.max(0.05, Math.cos(lat * DEG));
    const span = Math.max((la1 - la0) * KM_PER_DEG, (lo1 - lo0) * kx);
    // the route's tile: the route with a small margin (the 8 tiles around it add the surroundings)
    // at least 80 km: below that the ~2.6 km elevation data is only a few dozen pixels across
    const side = Math.max(80, span * 1.25);
    return { lat, lon, wKm: side, hKm: side };
  }
  function routeInside(state) {
    if (!terrain || !state?.route) return true;
    return state.route.pts.every(([lat, lon]) => {
      const [x, z] = toLocal(lat, lon);
      return Math.abs(x) < terrain.wKm / 2 && Math.abs(z) < terrain.hKm / 2;
    });
  }

  function updateInfo() {
    const pxKm = terrain ? terrain.pxKm : 2.6;
    const scale = `heights <strong>×${exaggeration}</strong>${exaggeration > 1 ? ' (exaggerated to show the shape)' : ' (true scale)'} · drawn flat, without the planet's curvature.`;
    if (world === 'earth') {
      const src = terrain?.demSource === 'terrarium'
        ? '<strong>Elevation</strong> (AWS Terrain Tiles, from SRTM and other sources; NASADEM stops at 60° N / 56° S)'
        : '<strong>Real NASA elevation</strong> (NASADEM, from the Space Shuttle’s radar)';
      $('terrain3d-info').innerHTML = `${src} · ~${Math.round(pxKm * 1000)} m per data pixel · ${scale}`;
      return;
    }
    $('terrain3d-info').innerHTML = `<strong>Real NASA elevation</strong> (${style.dem}) · ~${pxKm.toFixed(1)} km per data pixel, smoothed ·
      ${scale}
      Craters smaller than ~10 km are blurred at this data resolution.`;
  }

  // ---- buttons
  function refreshButtons() {
    for (const b of root.querySelectorAll('[data-exag]')) b.setAttribute('aria-checked', Number(b.dataset.exag) === exaggeration);
    for (const b of root.querySelectorAll('[data-colour]')) b.setAttribute('aria-checked', b.dataset.colour === colourMode);
  }
  // the height and colour choices of the world shown (made again when the world changes)
  function makeButtons() {
    $('terrain3d-exag').replaceChildren(...style.exag.map((x) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = `×${x}`; b.dataset.exag = x; b.setAttribute('role', 'radio');
      b.title = x === 1 ? 'Heights at true scale' : `Heights exaggerated ${x} times`;
      b.onclick = () => { userExaggeration = true; setExaggeration(x); refreshButtons(); };
      return b;
    }));
    $('terrain3d-colour').replaceChildren(...style.colours.map(([k, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.dataset.colour = k; b.setAttribute('role', 'radio');
      b.onclick = async () => { colourMode = k; triedImagery = true; refreshButtons(); if (terrain) await applyColours(); };
      return b;
    }));
    refreshButtons();
  }
  makeButtons();
  $('terrain3d-reset').onclick = () => terrain && resetCamera();
  $('terrain3d-top').onclick = () => terrain && topView();
  $('terrain3d-close').onclick = () => close();

  routeEvents?.addEventListener('update', ({ detail }) => {
    if (!isOpen || !terrain || detail.busy) { if (isOpen && terrain) drawRoute(); return; }
    if (detail.route && detail.fresh) {
      // a new route: rebuild around it if it's outside the area or tiny in it, then zoom to it
      const reg = regionFromRoute(detail);
      if (!routeInside(detail) || reg.wKm < terrain.wKm * 0.3) build(reg);
      else { drawRoute(); frameRoute(); }
    } else {
      drawRoute();
    }
  });
  routeEvents?.addEventListener('hover', ({ detail }) => { if (isOpen) showHover(detail.k); });
  routeEvents?.addEventListener('focus', ({ detail }) => { if (isOpen) focusOn(detail.k); });

  /**
   * opts: world ('mars' default, 'moon' or 'earth'); region { lat, lon, wKm, hKm, ringKm?, name? } to
   * show (else the route, else the 2D map's view); planner; getLeafletView; onClose.
   */
  function open(opts = {}) {
    if (opts.getLeafletView) getLeafletView = opts.getLeafletView;
    planner = opts.planner ?? null;
    onClose = opts.onClose ?? null;
    if (!renderer) {
      try { init(); } catch (err) {
        console.error(err);
        alert('3D view needs WebGL, which this browser has turned off.');
        return;
      }
    }
    setWorld(opts.world ?? 'mars');
    isOpen = true;
    root.hidden = false;
    document.body.classList.add('in-3d');
    resize();
    cancelAnimationFrame(animId);
    loop();
    const state = planner?.result();
    let reg = opts.region ?? regionFromRoute(state);
    if (!reg) {
      const v = getLeafletView();
      reg = v.wKm > MAX_REGION_KM
        ? { ...(SHOWCASE[world] ?? SHOWCASE.mars), note: 'zoom the 2D map in on any area, or plan a route, to see it here' }
        : v;
    }
    triedImagery = false;
    build(reg);
  }
  function close() {
    isOpen = false;
    root.hidden = true;
    document.body.classList.remove('in-3d');
    cancelAnimationFrame(animId);
    onClose?.();
  }
  return { open, close, isOpen: () => isOpen };
}
