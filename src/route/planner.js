// Route planner for Mars and the Moon: pick who travels (an astronaut or a rover), click a
// start (A) and a destination (B), and get three routes: the shortest, the most efficient and the
// safest, each with what makes it dangerous and why it goes the way it does.
// The terrain grid comes from grid.js, the search runs in search.worker.js, the rovers'
// specs and the model's assumptions about them are in rovers.js.
import L from 'leaflet';
import { buildGrid, cellOf, cellLatLon, craterDepthKm, haversineKm, MAX_LAT, RADIUS } from './grid.js';
import { isCylindrical, routeBounds, unwrapLons, zoomToRoute } from './zoom.js';
import { ROVERS, MOON_ROVERS, roverOf, travellerModel, travellerName, roverIcon } from './rovers.js';
import { formatLatLon } from '../geo.js';
import { compareHtml } from './compare.js';
import { CLOSE_MATCH } from '../equivalents.js';

// Mars seasons by solar longitude (Ls); northern-hemisphere names. Ls 180-360 is the
// dusty season (Mars is closest to the Sun).
export const SEASONS = [
  { name: 'Northern spring', short: 'N. spring', ls: 'Ls 0–90°' },
  { name: 'Northern summer', short: 'N. summer', ls: 'Ls 90–180°' },
  { name: 'Northern autumn (dust season)', short: 'N. autumn', ls: 'Ls 180–270°' },
  { name: 'Northern winter (dust season)', short: 'N. winter', ls: 'Ls 270–360°' },
];
export const KINDS = {
  safest: { name: 'Safest', colour: '#ffb02e', about: 'Avoids steep ground, crater rims, rough, rocky and loose terrain and dust-storm areas, as far as this traveller needs to, even if that takes longer.',
    aboutMoon: 'Avoids steep ground, crater rims, rough, rocky and loose terrain, as far as this traveller needs to, even if that takes longer.',
    aboutEarth: 'Avoids steep and rough ground, as far as this traveller needs to, even if that takes longer (Earth has no crater, dust or rock data here).' },
  efficient: { name: 'Efficient', colour: '#4cd387', about: 'The energy-efficient route, from NASA\'s precise MOLA elevation (1 m steps): as little climbing energy as possible within the slope limits. Dust, rocks and cold can tip the choice between similar routes but never add more than 25%.',
    aboutMoon: 'The energy-efficient route, from NASA\'s precise LRO LOLA elevation: as little climbing energy as possible within the slope limits. Loose dust, rocks and the coldest craters can tip the choice between similar routes but never add more than 25%.',
    aboutEarth: 'Least effort: as little climbing as possible within the slope limit (ETOPO elevation from the map tiles, as at the site).' },
  shortest: { name: 'Shortest', colour: '#6ec6ff', about: 'Fewest kilometres while staying under the slope limit.' },
};

// What differs between the worlds: who can travel, which data the hazards come from and
// how the surface (thermal inertia) values read. Mars TES values run ~30-1000 TIU; the
// Moon's (from Diviner) ~25-60, so "loose" and "rocky" are the ends of each world's range.
const WORLD_CFG = {
  mars: {
    name: 'Mars',
    travellers: ['walk', ...Object.keys(ROVERS)],
    traveller: 'curiosity',
    seasons: true,
    ti: { softHi: 150, softSpan: 100, rockLo: 600, rockSpan: 900 },
    record: { km: 45.16, text: 'longer than any rover has ever driven (Opportunity\'s record: 45.16 km in 14 years)' },
    slopeSrc: 'MOLA',
    dem: 'MOLA', // precise 16-bit elevation for the efficient route (src/route/engine/)
    dust: 'Very low thermal inertia: fine dust or sand where wheels sink and slip (MGS TES, measured). Spirit got stuck in soft sand in 2009; Curiosity once hit 98.7% wheel slip.',
    crater: (c, measured) => `${measured ? 'Rim-to-floor depth measured from MOLA' : 'Depth estimated (~1/5 of the width); not measured'} (Robbins & Hynek crater catalog).`
      + `${measured && c.d < 10 ? ' MOLA depths of craters under 10 km are only rough.' : ''}`,
    coldSrc: 'model',
    note: `Measured = spacecraft data (MOLA, TES); catalog = Robbins crater database;
      observed = dust storms mapped from orbit (MDAD); model / estimate = calculated here from assumptions
      (rover limits and weights: src/route/rovers.js). The data is 2–300 km per pixel,
      so this compares corridors; it can't see single boulders or small cliffs.`,
  },
  moon: {
    name: 'Moon',
    travellers: ['walk', ...Object.keys(MOON_ROVERS)],
    traveller: 'lrv',
    seasons: false, // no seasons and no weather on the Moon
    ti: { softHi: 34, softSpan: 8, rockLo: 50, rockSpan: 20 },
    record: { km: 35.9, text: 'longer than NASA has ever driven on the Moon (Apollo 17\'s LRV: 35.9 km in three drives, 1972)' },
    slopeSrc: 'LOLA',
    dem: 'LRO LOLA',
    dust: 'Unusually low thermal inertia: especially fine, fluffy soil where wheels and boots sink deeper (LRO Diviner, measured). The whole Moon is covered in loose dust; this marks the loosest.',
    crater: (c, measured) => `${measured ? 'Rim-to-floor depth measured here from LRO LOLA heights' : 'Depth estimated from its width (Pike 1977, fresh lunar craters); not measured'} (Robbins lunar crater catalog).`
      + `${measured && c.d < 30 ? ' LOLA depths of craters under ~30 km are only rough.' : ''}`,
    coldSrc: 'measured',
    note: `Measured = spacecraft data (LRO LOLA heights, Diviner temperatures and thermal inertia); catalog = Robbins
      lunar crater database; model / estimate = calculated here from assumptions (rover limits and weights:
      src/route/rovers.js). The data is ~2–15 km per pixel, so this compares corridors; it can't see single
      boulders or small craters.`,
  },
  // Earth: only at an Earth analog of a Moon / Mars site, to drive the same traveller there
  // (src/route/compare.js). Elevation and slope from ETOPO 2022, at the same ~1.9 km slope
  // scale as the Moon / Mars maps; no thermal inertia, crater or dust-storm data.
  earth: {
    name: 'Earth',
    travellers: ['walk', ...Object.keys(ROVERS)], // replaced by the site's world's travellers
    traveller: 'curiosity',
    seasons: false,
    ti: { softHi: 150, softSpan: 100, rockLo: 600, rockSpan: 900 }, // unused: no thermal inertia on Earth
    record: null,
    slopeSrc: 'ETOPO 2022',
    dust: '',
    crater: () => '',
    coldSrc: 'NASA POWER',
    missing: ['crater rims (no crater catalog)', 'loose dust and rocky ground (no thermal-inertia map)', 'dust storms'],
    note: `Measured = NOAA ETOPO 2022 elevation and slope (from NASA SRTM and other data), at the same ~1.9 km
      slope scale as the Moon and Mars maps; roughness worked out here from that elevation; coldest night from
      NASA POWER. <strong>Not on Earth in this app:</strong> crater rims, loose dust / rocky ground (thermal inertia)
      and dust storms, so those hazards are simply absent here, not zero. Model / estimate = calculated from
      assumptions (rover limits and weights: src/route/rovers.js).`,
  },
};

/** Fires 'update' whenever the route (or its endpoints) change; the 3D view listens. */
export const routeEvents = new EventTarget();

const $ = (id) => document.getElementById(id);
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`);
const fmtM = (km) => `${Math.round(km * 1000).toLocaleString()} m`;
const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const pct = (x) => `${Math.round(x * 100)}%`;
const fromA = (km) => (km < 0.1 ? 'at A' : `${fmtKm(km)} from A`);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lr0 = Math.log10(0.02);
const lr1 = Math.log10(0.4);
const roughOf = (relief) => (Number.isNaN(relief) ? 0
  : Math.min(1, Math.max(0, (Math.log10(Math.max(relief, 1e-4)) - lr0) / (lr1 - lr0))));

let worker = null;
function runSearch(grid, opts, start, goal) {
  worker ??= new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
  const id = Math.random();
  const transfer = {
    R: grid.R, rows: grid.rows, cols: grid.cols, dLat: grid.dLat, dLon: grid.dLon, latMax: grid.latMax,
    elev: grid.elev, slopeMax: grid.slopeMax, relief: grid.relief, ti: grid.ti, storm: grid.storm,
    crater: grid.crater, valid: grid.valid,
  };
  return new Promise((resolve, reject) => {
    const onMsg = ({ data }) => {
      if (data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      resolve(data);
    };
    worker.addEventListener('message', onMsg);
    worker.onerror = reject;
    worker.postMessage({ grid: transfer, opts, start, goal, id });
  });
}

/** Planner options for a traveller (see rovers.js) on 'mars' or 'moon'. */
export function optsFor(traveller, world = 'mars') {
  const m = travellerModel(traveller);
  return { traveller, world, noGoDeg: m.noGoDeg, cautionDeg: m.cautionDeg, weights: m.weights, ti: WORLD_CFG[world].ti };
}

// ---- The precise route (src/route/engine/): a Web Worker on NASA's 16-bit MOLA / LOLA blocks ----

export const DEFAULT_SETTINGS = { roverMaxSlope: 20, footMaxSlope: 15, kUp: 8, weights: { dust: 1, rock: 1, cold: 0.5 } };
let preciseWorker = null;
const PRECISE = { mars: 1, moon: 1 }; // worlds with a precise elevation engine (src/route/engine/)
let preciseId = 0;
/** Run the precise search; a newer call cancels the running one. Resolves to the engine's result. */
function runPrecise(a, b, traveller, settings, onProgress, world = 'mars') {
  preciseWorker ??= new Worker(new URL('./engine/route.worker.js', import.meta.url), { type: 'module' });
  const id = ++preciseId;
  preciseWorker.postMessage({ type: 'cancel', id: id - 1 });
  const engineSettings = {
    roverMaxSlope: settings.roverMaxSlope, footMaxSlope: settings.footMaxSlope,
    kUpRover: settings.kUp, kUpFoot: settings.kUp === 8 ? 10 : settings.kUp, kDown: 1,
    weights: settings.weights,
    modes: traveller === 'walk' ? ['foot'] : ['rover', 'foot'],
  };
  return new Promise((resolve, reject) => {
    const onMsg = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === 'progress') { onProgress(data); return; }
      preciseWorker.removeEventListener('message', onMsg);
      if (data.type === 'result') resolve(data.result);
      else if (data.type === 'unavailable-data') resolve(null);
      else reject(new Error(data.message));
    };
    preciseWorker.addEventListener('message', onMsg);
    preciseWorker.postMessage({ type: 'search', id, a, b, world, settings: engineSettings, base: new URL(import.meta.env.BASE_URL, location.href).href });
  });
}

// Turn the engine's result (points with precise elevation) into the planner's route object, and
// add what the map's data layers say along it (craters, dust, storms, cold) via describe().
function fromPrecise(result, g, a, opts, res) {
  const P = result.points;
  const pts = P.map(([lat, lon]) => [lat, lon]);
  // the cells of the coarse map grid the route passes through, for describe()
  const path = [];
  for (let k = 0; k < P.length; k++) {
    const [la0, lo0] = k ? P[k - 1] : P[0]; const [la1, lo1] = P[k];
    const n = k ? Math.max(1, Math.ceil(haversineKm(la0, lo0, la1, lo1) / (g.cellKm * 0.5))) : 1;
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const i = cellOf(g, la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t);
      if (path[path.length - 1] !== i) path.push(i);
    }
  }
  if (path.length === 1) path.push(path[0]);
  const d = describe(g, path, a, opts, res);
  // precise numbers replace the map-tile ones
  const seg = [0]; const slope = [result.segments[0]?.slope_deg ?? 0];
  let hours = 0; let steepKm = 0;
  for (let k = 1; k < P.length; k++) {
    const s = result.segments[k - 1];
    seg.push(seg[k - 1] + s.length_km);
    slope.push(s.slope_deg);
    const L0 = s.length_km; const dz = (P[k][2] - P[k - 1][2]) / 1000;
    hours += L0 / (6 * Math.exp(-3.5 * Math.abs(dz / Math.max(L0, 1e-6) + 0.05)));
    if (s.slope_deg > opts.cautionDeg) steepKm += L0;
  }
  const elev = P.map((p) => p[2] / 1000);
  const hard = new Uint8Array(P.length);
  const nearestPoint = (lat, lon) => {
    let best = 0; let bd = Infinity;
    P.forEach(([la, lo], k) => { const dd = haversineKm(lat, lon, la, lo); if (dd < bd) { bd = dd; best = k; } });
    return best;
  };
  P.forEach(([lat, lon], k) => {
    const i = cellOf(g, lat, lon);
    hard[k] = slope[k] > opts.cautionDeg || (g.craterId[i] >= 0 && g.crater[i] > 0.15) || res.soft[i] > 0.5 || res.rocky[i] > 0.5 ? 1 : 0;
  });
  // the dangers found along the cells, placed on the nearest precise point; the slope one is redone
  const dangers = d.dangers.filter((x) => x.type !== 'slope').map((x) => {
    const [lat, lon] = cellLatLon(g, path[Math.min(x.k, path.length - 1)]);
    return { ...x, k: nearestPoint(lat, lon) };
  });
  const steep = slope.reduce((bi, v, k) => (v > slope[bi] ? k : bi), 0);
  dangers.push({ type: 'slope', k: steep, title: `${slope[steep] > opts.cautionDeg ? 'Steep' : 'Steepest point'}: ${slope[steep].toFixed(1)}° slope`,
    text: `Steepest stretch of this route, from NASA's precise ${WORLD_CFG[g.world].dem} elevation (${result.finest}, ~${fmtKm(result.finest_km)} cells). Steepest slope inside any cell it crosses: ${result.totals.max_slope_deg}°.` });
  dangers.sort((x, y) => x.k - y.k);
  return {
    ...d, pts, seg, slope, elev, hard, dangers, hours, steepKm,
    dist: result.totals.length_km, up: result.totals.climb_m / 1000, down: result.totals.descent_m / 1000,
    maxSlope: result.totals.max_slope_deg, lo: Math.min(...elev), hi: Math.max(...elev),
    points: pts, bounds: routeBounds(pts), precise: result,
  };
}

/**
 * Builds the grid and finds the three routes for one traveller. Kept separate from the UI so
 * two rovers can later be compared on the same A and B (call it twice, reuse the grid).
 */
export async function computeRoutes(a, b, season, traveller, onProgress = () => {}, grid = null, world = 'mars', settings = DEFAULT_SETTINGS) {
  const opts = optsFor(traveller, world);
  // on Mars and the Moon the precise route (16-bit MOLA / LOLA) runs in its own worker meanwhile
  const usePrecise = world in PRECISE && !!settings;
  const precisePromise = !usePrecise ? Promise.resolve(null)
    : runPrecise(a, b, traveller, settings, (p) => onProgress(`Precise route (NASA ${WORLD_CFG[world].dem}, ${p.level}${p.mode === 'foot' ? ', on foot' : ''}): ${Math.round((p.fraction ?? 0) * 100)}%…`), world)
      .catch((err) => { console.error(err); return null; });
  const g = grid ?? await buildGrid(a, b, season, onProgress, world);
  onProgress(`Searching ${(g.rows * g.cols).toLocaleString()} terrain cells (${g.cellKm.toFixed(1)} km each)…`);
  const start = cellOf(g, a.lat, a.lon);
  const goal = cellOf(g, b.lat, b.lon);
  const res = await runSearch(g, opts, start, goal);
  const bLon = g.lonMin + ((goal % g.cols) + 0.5) * g.dLon;
  const routes = {};
  for (const k of ['safest', 'easiest', 'shortest']) {
    const r = res.routes[k];
    // A and B in the same terrain cell: the route is just A -> B
    const path = r.path && r.path.length === 1 ? [r.path[0], r.path[0]] : r.path;
    routes[k] = path ? describe(g, path, a, opts, res) : null;
    if (routes[k]) {
      const pts = routes[k].pts;
      pts[pts.length - 1] = [b.lat, b.lon + Math.round((bLon - b.lon) / 360) * 360];
      // what the zoom (and anything else) needs: every point, and the short-way bounds
      routes[k].points = pts;
      routes[k].bounds = routeBounds(pts);
    }
  }
  // the efficient route: precise if the MOLA / LOLA blocks are built, else the map-tile estimate
  let preciseState = usePrecise ? 'missing' : 'none';
  const precise = await precisePromise;
  if (precise?.status === 'ok' || precise?.status === 'foot-only') {
    routes.efficient = fromPrecise(precise, g, a, opts, res);
    preciseState = precise.status;
  } else if (precise?.status === 'unavailable') {
    routes.efficient = null;
    preciseState = 'unavailable';
  } else if (routes.easiest) {
    routes.efficient = preciseState === 'missing' ? { ...routes.easiest, approximate: true } : routes.easiest;
  }
  delete routes.easiest;
  return { g, routes, opts, traveller, season, precise, preciseState };
}

// ---- What a route goes through --------------------------------------------------------

function describe(g, path, a, opts, res) {
  const { soft, rocky, z } = res;
  const cfg = WORLD_CFG[g.world];
  const pts = path.map((i) => cellLatLon(g, i));
  pts[0] = [a.lat, a.lon];
  const seg = [0];
  let dist = 0;
  let up = 0; let down = 0;
  let hours = 0;
  let steepKm = 0; let softKm = 0; let rockyKm = 0; let roughKm = 0;
  let maxSlope = -1; let maxSlopeAt = 0;
  let maxStorm = -1; let maxStormAt = 0; let stormSum = 0;
  let coldest = Infinity;
  let lo = Infinity; let hi = -Infinity;
  let hazardSum = 0;
  let terrainSum = 0; let slopeSum = 0; let reliefSum = 0; let reliefKm = 0; let steep15Km = 0;
  const craterHits = new Map(); // crater index -> first point on the route
  const dangers = [];
  const hard = new Uint8Array(path.length); // difficult points (for the 3D view)
  let softStart = -1;
  for (let k = 0; k < path.length; k++) {
    const i = path[k];
    const rough = roughOf(g.relief[i]);
    const isSteep = g.slopeMax[i] > opts.cautionDeg;
    const isCrater = g.craterId[i] >= 0 && g.crater[i] > 0.15;
    hard[k] = isSteep || isCrater || soft[i] > 0.5 || rocky[i] > 0.5 ? 1 : 0;
    if (k > 0) {
      const L0 = haversineKm(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], g.R);
      dist += L0;
      const dz = z[i] - z[path[k - 1]];
      if (dz > 0) up += dz; else down -= dz;
      hours += L0 / (6 * Math.exp(-3.5 * Math.abs(dz / Math.max(L0, 1e-6) + 0.05)));
      if (isSteep) steepKm += L0;
      if (soft[i] > 0.5) softKm += L0;
      if (rocky[i] > 0.5) rockyKm += L0;
      if (rough > 0.6) roughKm += L0;
      stormSum += g.storm[i] * L0;
      const terrain = Math.min(1, (g.slopeMax[i] / opts.cautionDeg) ** 2) + rough * 0.5; // slope + roughness only
      hazardSum += L0 * (terrain + g.crater[i] + soft[i] + rocky[i]);
      terrainSum += L0 * terrain;
      slopeSum += L0 * g.slopeMean[i];
      if (g.slopeMax[i] > 15) steep15Km += L0;
      if (Number.isFinite(g.relief[i])) { reliefSum += L0 * g.relief[i]; reliefKm += L0; }
    }
    seg.push(dist);
    if (g.slopeMax[i] > maxSlope) { maxSlope = g.slopeMax[i]; maxSlopeAt = k; }
    if (g.storm[i] > maxStorm) { maxStorm = g.storm[i]; maxStormAt = k; }
    if (g.tmin[i] < coldest) coldest = g.tmin[i];
    lo = Math.min(lo, g.elev[i]); hi = Math.max(hi, g.elev[i]);
    if (isCrater && !craterHits.has(g.craterId[i])) craterHits.set(g.craterId[i], k);
    // stretches of loose dust longer than ~5 km
    if (soft[i] > 0.5 && softStart < 0) softStart = k;
    if ((soft[i] <= 0.5 || k === path.length - 1) && softStart >= 0) {
      const len = seg[k] - seg[softStart];
      if (len >= 5) {
        dangers.push({ type: 'dust', k: softStart, title: `Loose dust for ${fmtKm(len)}`,
          text: cfg.dust });
      }
      softStart = -1;
    }
  }
  if (maxSlope > 0) {
    const level = maxSlope > opts.cautionDeg ? 'Steep' : 'Steepest point';
    dangers.push({ type: 'slope', k: maxSlopeAt, title: `${level}: ${maxSlope.toFixed(1)}° slope`,
      text: `Steepest ground on this route, averaged over ~2 km (${cfg.slopeSrc}, measured). Local slopes, e.g. on a crater wall or boulder field, can be much steeper. Limit used for ${travellerName(opts.traveller)}: ${opts.noGoDeg}°.` });
  }
  const craters = [...craterHits.entries()].map(([idx, k]) => ({ c: g.craters[idx], k }))
    .sort((p, q) => craterDepthKm(q.c, g.world) - craterDepthKm(p.c, g.world));
  for (const { c, k } of craters.slice(0, 6)) {
    const measured = c.depthKm != null;
    dangers.push({ type: 'crater', k, title: `Crater rim: ${c.d.toFixed(c.d < 10 ? 1 : 0)} km wide, ${measured ? '' : '~'}${fmtM(craterDepthKm(c, g.world))} deep`,
      text: cfg.crater(c, measured) +
        `${c.rimKm != null ? ` Rim stands ${fmtM(c.rimKm)} above the plains.` : ''}${c.degradation ? ` Preservation: ${['', 'heavily eroded', 'eroded', 'fairly fresh', 'fresh'][c.degradation]}.` : ''}` });
  }
  if (maxStorm >= 0.05) {
    dangers.push({ type: 'storm', k: maxStormAt, title: `Dust storms on ${pct(maxStorm)} of sols here`,
      text: `In this season, a dust storm covered this area on ${pct(maxStorm)} of the sols mapped from orbit in 2001–2015 (Mars Dust Activity Database, observed). Storms cut sunlight for solar power and visibility.` });
  }
  dangers.sort((p, q) => p.k - q.k);
  return {
    pts, seg, dist, up, down, hours, steepKm, softKm, rockyKm, roughKm, maxSlope, maxStorm, coldest, lo, hi,
    avgStorm: dist > 0 ? stormSum / dist : 0, hazardSum, craters, dangers, hard,
    // for comparing worlds: slope and roughness only (Earth has no crater, dust or rock data)
    terrainSum, steep15Km, avgSlope: dist > 0 ? slopeSum / dist : 0, avgRelief: reliefKm > 0 ? reliefSum / reliefKm : NaN,
    elev: path.map((i) => g.elev[i]), slope: path.map((i) => g.slopeMax[i]),
  };
}

// ---- Explaining a route ------------------------------------------------------------------

function travelTime(r, traveller, world = 'mars') {
  if (traveller === 'walk') {
    const h = r.hours;
    const evas = Math.ceil(h / 8);
    return {
      short: h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(h < 10 ? 1 : 0)} h walk`,
      long: `~${h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(h < 10 ? 1 : 0)} h`} walking${evas > 1 ? ` (${evas} eight-hour spacewalks)` : ''}`,
      src: 'model',
    };
  }
  const pace = roverOf(traveller).model.pace;
  if (pace?.kmh) { // a crewed car (Apollo LRV): hours of driving
    const h = r.dist / pace.kmh;
    const t = h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(h < 10 ? 1 : 0)} h`;
    return { short: `${t} drive`, long: `~${t} driving at ${pace.text}`, src: 'estimate' };
  }
  if (pace) {
    const sols = Math.max(1, Math.ceil((r.dist * 1000) / pace.mPerSol));
    const unit = world === 'earth' ? 'driving days' : 'sols'; // the same daily pace, on Earth
    return { short: `${sols.toLocaleString()} ${world === 'earth' ? 'days' : 'sols'}`, long: `~${sols.toLocaleString()} ${unit} at ${pace.text}`, src: 'estimate' };
  }
  return { short: 'no estimate', long: 'Not estimated: no published average pace for this rover', src: '' };
}

/** Plain-language reasons: why this route, what it avoids, where it's hard, can it be done. */
function explain(result, kind) {
  const { routes, opts, traveller, g } = result;
  const cfg = WORLD_CFG[g.world];
  const cell = `~${g.cellKm.toFixed(1)} km`;
  const r = routes[kind];
  const s = routes.shortest;
  const name = travellerName(traveller);
  const model = travellerModel(traveller);
  const out = { why: [], avoided: [], difficult: [], verdict: null, warnings: [] };

  if (kind === 'shortest' || !s) {
    out.why.push(`The most direct line that keeps every ${cell} cell below ${name}'s ${opts.noGoDeg}° slope limit.`);
  } else {
    const extra = r.dist - s.dist;
    out.why.push(kind === 'safest'
      ? `${extra > 0.5 ? `${fmtKm(extra)} (${Math.round((extra / s.dist) * 100)}%) longer than the shortest route, to stay` : 'Almost as short as the shortest route, while staying'} away from the hazards that matter most for ${name}.`
      : `${extra > 0.5 ? `${fmtKm(extra)} longer than the shortest route, but` : 'About as long as the shortest route, and'} with ${fmtM(Math.max(0, s.up - r.up))} less climbing (↑ ${fmtM(r.up)} instead of ↑ ${fmtM(s.up)}).`);
    if (kind === 'safest') out.why.push(model.why);
    const diff = (label, a, b, count = false) => {
      if (b - a > (count ? 0.5 : 0.9)) out.avoided.push(`${label}: ${count ? `${a} instead of ${b}` : `${fmtKm(a)} instead of ${fmtKm(b)}`}`);
    };
    diff(`Slopes over ${opts.cautionDeg}°`, r.steepKm, s.steepKm);
    diff('Crater rims crossed', r.craters.length, s.craters.length, true);
    diff('Loose dust / sand', r.softKm, s.softKm);
    diff('Rocky ground', r.rockyKm, s.rockyKm);
    diff('Rough ground', r.roughKm, s.roughKm);
    if (s.maxSlope - r.maxSlope > 2) out.avoided.push(`Steepest slope: ${r.maxSlope.toFixed(1)}° instead of ${s.maxSlope.toFixed(1)}°`);
    if (!out.avoided.length) out.avoided.push('Nothing major: the direct line is already about as safe as it gets at this map scale.');
  }
  if (r.steepKm > 0) out.difficult.push(`${fmtKm(r.steepKm)} of slopes over ${opts.cautionDeg}° (steepest ${r.maxSlope.toFixed(1)}°)`);
  if (r.craters.length) out.difficult.push(`${r.craters.length} crater rim${r.craters.length > 1 ? 's' : ''} (deepest ~${fmtM(craterDepthKm(r.craters[0].c, g.world))})`);
  if (r.softKm > 0) out.difficult.push(`${fmtKm(r.softKm)} of loose dust or sand`);
  if (r.rockyKm > 0) out.difficult.push(`${fmtKm(r.rockyKm)} of rocky ground (high thermal inertia)`);
  if (r.maxStorm >= 0.05) out.difficult.push(`dust storms on up to ${pct(r.maxStorm)} of sols this season`);

  // can it be done (under the model's assumptions)?
  const tooFar = model.rangeKm != null && r.dist > model.rangeKm;
  if (kind === 'efficient' && r.precise) {
    const p = r.precise;
    const lim = p.mode === 'foot' ? result.settings.footMaxSlope : result.settings.roverMaxSlope;
    out.why.unshift(`Least energy: ${p.totals.energy_km_equiv.toLocaleString()} km-equivalent of flat ${p.mode === 'foot' ? 'walking' : 'driving'} (distance plus ${p.mode === 'foot' ? result.settings.kUp === 8 ? 10 : result.settings.kUp : result.settings.kUp}× every km climbed), found coarse to fine on NASA ${cfg.dem} (${p.levels.filter((l) => l.mode === p.mode).map((l) => l.level).join(' → ')}).`);
    if (p.totals.extra_cost_from_secondary_pct > 0.1) out.why.push(`Dust, rocks and cold add ${p.totals.extra_cost_from_secondary_pct}% to its energy (capped at 25%).`);
    out.verdict = {
      ok: !tooFar,
      text: tooFar
        ? `Beyond ${name}'s capabilities: ${fmtKm(r.dist)} is far more than it could manage (${model.rangeWhy}). The route is shown only to compare terrain.`
        : `${p.mode === 'foot' ? 'Walkable' : 'Drivable'} under the limits: no step and no cell crossed steeper than ${lim}° (steepest ${p.totals.max_slope_deg}°), checked on ${cfg.dem} at ~${fmtKm(p.finest_km)}. Not checked: boulders${g.world === 'mars' ? ', dunes' : ''} and metre-scale slopes.`,
    };
    if (result.preciseState === 'foot-only') out.warnings.push(`No rover route within ${result.settings.roverMaxSlope}°: this is the on-foot route (limit ${result.settings.footMaxSlope}°).`);
    if (traveller !== 'walk' && cfg.record && r.dist > cfg.record.km && !tooFar) out.warnings.push(`At ${fmtKm(r.dist)}, this is ${cfg.record.text}.`);
    return out;
  }
  out.verdict = {
    ok: !tooFar,
    text: tooFar
      ? `Beyond ${name}'s capabilities: ${fmtKm(r.dist)} is far more than it could manage (${model.rangeWhy}). The route is shown only to compare terrain.`
      : `Passable under this model: every ${cell} cell is below ${name}'s ${opts.noGoDeg}° limit (steepest ${r.maxSlope.toFixed(1)}°). Not checked: single rocks, small scarps and sand ripples, which are too small for this data.`,
  };
  if (traveller !== 'walk' && cfg.record && r.dist > cfg.record.km && !tooFar) {
    out.warnings.push(`At ${fmtKm(r.dist)}, this is ${cfg.record.text}.`);
  }
  return out;
}

// ---- The planner ---------------------------------------------------------------------

/**
 * Sets up the route planner on a Mars, Moon or (at an Earth analog) Earth map. Returns
 * { open, close, isOpen, click, query, result, setRoute }.
 * `onChange` is called when the route's endpoints/options change (to save them in the URL).
 * Earth: `extra.compare` = the Moon / Mars site route { world, a, b, season, crossing } to compare
 * with (same traveller, same kind of route); the travellers are those of that world.
 */
export function createRoutePlanner(map, params, onChange, world = 'mars', extra = {}) {
  const cmp = extra.compare ?? null;
  // (on Earth, the travellers are those of the Moon / Mars site compared with)
  const cfg = world === 'earth' && cmp && cmp.world !== 'earth'
    ? { ...WORLD_CFG[world], travellers: WORLD_CFG[cmp.world].travellers, traveller: WORLD_CFG[cmp.world].traveller } : WORLD_CFG[world];
  const TRAVELLER_KEYS = cfg.travellers;
  const state = {
    open: false,
    a: null, b: null,
    turned: undefined, // Earth analog: how far the same-length line was turned to stay on land
    traveller: TRAVELLER_KEYS.includes(params.get('tr')) ? params.get('tr') : cfg.traveller,
    season: cfg.seasons ? Math.min(3, Math.max(0, parseInt(params.get('ss'), 10) || 0)) : 0,
    kind: KINDS[params.get('rk')] ? params.get('rk') : params.get('rk') === 'easiest' ? 'efficient' : 'safest',
    settings: structuredClone(DEFAULT_SETTINGS),
    result: null,
    busy: false,
    fresh: false, // a route was just calculated (the views zoom to it once)
  };
  if (!map.getPane('route')) map.createPane('route').style.zIndex = 450;
  const layer = L.layerGroup().addTo(map);
  const dangerLayer = L.layerGroup().addTo(map);
  let hover = null;
  const markers = { a: null, b: null };
  let token = 0;
  const emit = () => routeEvents.dispatchEvent(new CustomEvent('update', { detail: api.result() }));

  // ---- panel: which world, who travels
  const panel = $('route-panel');
  $('route-world').textContent = cmp ? `Earth analog vs ${WORLD_CFG[cmp.world].name} site` : cfg.name;
  $('route-note').innerHTML = cfg.note;
  panel.querySelector('.season-pick').hidden = !cfg.seasons;
  panel.querySelector('.route-settings').hidden = !(world in PRECISE); // the settings tune the precise (MOLA / LOLA) route
  $('route-traveller').replaceChildren(...TRAVELLER_KEYS.map((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'traveller-btn';
    b.dataset.value = k;
    b.dataset.group = 'traveller';
    b.setAttribute('role', 'radio');
    b.title = travellerName(k);
    b.innerHTML = `<span class="t-icon">${roverIcon(k, 34)}</span><span class="t-label">${k === 'walk' ? 'On foot' : esc(roverOf(k).name)}</span>`;
    b.onclick = () => { state.traveller = k; refreshChips(); plan(); };
    return b;
  }));
  // season: a dropdown next to the A / B coordinates
  const seasonSelect = $('route-season');
  seasonSelect.replaceChildren(...SEASONS.map((s, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = s.short;
    o.title = `${s.name}, ${s.ls}`;
    return o;
  }));
  seasonSelect.onchange = () => { state.season = Number(seasonSelect.value); refreshChips(); plan(); };
  function refreshChips() {
    for (const b of panel.querySelectorAll('[data-group="traveller"]')) b.setAttribute('aria-checked', b.dataset.value === state.traveller);
    seasonSelect.value = String(state.season);
    seasonSelect.title = `${SEASONS[state.season].name}, ${SEASONS[state.season].ls}`;
    renderProfileCard();
  }

  // ---- route settings (the efficient route): slope limits, climbing penalty, secondary weights
  let settingsTimer = 0;
  const replanSoon = () => { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => plan(), 350); };
  function setupSettings() {
    const S = state.settings;
    const slider = (id, key, fmt) => {
      const el = $(id);
      el.value = key();
      const out = el.parentElement.querySelector('output');
      const show = () => { out.textContent = fmt(Number(el.value)); };
      show();
      el.oninput = show;
      return el;
    };
    slider('rs-rover', () => S.roverMaxSlope, (v) => `${v}°`).onchange = (e) => { S.roverMaxSlope = Number(e.target.value); replanSoon(); };
    slider('rs-foot', () => S.footMaxSlope, (v) => `${v}°`).onchange = (e) => { S.footMaxSlope = Number(e.target.value); replanSoon(); };
    for (const k of ['dust', 'rock', 'cold']) {
      slider(`rs-${k}`, () => S.weights[k], (v) => `×${v}`).onchange = (e) => { S.weights[k] = Number(e.target.value); replanSoon(); };
    }
    $('rs-kup').replaceChildren(...[[3, 'Low'], [8, 'Normal'], [20, 'High']].map(([v, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = `${label} (${v})`; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', S.kUp === v);
      b.onclick = () => { S.kUp = v; for (const x of $('rs-kup').children) x.setAttribute('aria-checked', x === b); replanSoon(); };
      return b;
    }));
    $('rs-reset').onclick = () => { state.settings = structuredClone(DEFAULT_SETTINGS); setupSettings(); replanSoon(); };
  }
  setupSettings();

  // compact profile of the chosen rover, with sources
  function renderProfileCard() {
    const box = $('route-rover');
    const m = travellerModel(state.traveller);
    const modelHtml = `<p class="rv-model"><span class="tag tag-model">Model assumption</span> Slope limit ${m.noGoDeg}° at ~2 km scale (${esc(m.noGoWhy)}); caution above ${m.cautionDeg}°. ${esc(m.why)}</p>`;
    if (state.traveller === 'walk') {
      box.innerHTML = `<details class="rv-card">
        <summary><span class="rv-icon">${roverIcon('walk', 44)}</span><span class="rv-head"><strong>Astronaut on foot</strong>
          <span class="sub">NASA xEVA spacesuit concept of operations</span></span></summary>
        ${modelHtml}</details>`;
      return;
    }
    const r = roverOf(state.traveller);
    const rows = Object.entries({ Mass: r.specs.mass, Size: r.specs.size, Wheels: r.specs.wheels, Obstacles: r.specs.obstacles,
      Speed: r.specs.speed, Navigation: r.specs.navigation, Record: r.specs.distance })
      .map(([label, v]) => `<tr><td>${label}</td><td>${esc(v.text)}${v.src.length ? ` <span class="src-dot" title="Source: ${esc(v.src.join('; '))}">ⓘ</span>` : ''}</td></tr>`).join('');
    box.innerHTML = `<details class="rv-card">
      <summary><span class="rv-icon">${roverIcon(state.traveller, 44)}</span><span class="rv-head"><strong>${esc(r.name)}</strong>
        <span class="sub">${esc(r.mission)} · ${esc(r.period)}</span></span></summary>
      <table class="route-table rv-specs"><tbody>${rows}</tbody></table>
      <p class="sub rv-note">Published specs (hover ⓘ for the source). Silhouettes are drawn to scale by wheel size.</p>
      ${modelHtml}
      </details>`;
  }

  refreshChips();
  $('route-close').onclick = () => close();
  $('route-swap').onclick = () => {
    if (!state.a || !state.b) return;
    [state.a, state.b] = [state.b, state.a];
    placeMarkers();
    plan();
  };
  $('route-clear').onclick = () => {
    state.a = state.b = null;
    state.result = null;
    placeMarkers();
    render();
    onChange();
    emit();
  };

  function status(text) { $('route-status').textContent = text; }

  function placeMarkers() {
    for (const k of ['a', 'b']) {
      if (markers[k]) { markers[k].remove(); markers[k] = null; }
      const p = state[k];
      if (!p) continue;
      markers[k] = L.marker([p.lat, p.lon], {
        draggable: true, pane: 'route', keyboard: false, title: k === 'a' ? 'Start (A) – drag to move' : 'Destination (B) – drag to move',
        icon: L.divIcon({ className: '', html: `<span class="route-pin route-pin-${k}">${k.toUpperCase()}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
      }).addTo(map);
      markers[k].on('dragend', (e) => {
        const ll = e.target.getLatLng();
        state[k] = { lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, ll.lat)), lon: wrap(ll.lng) };
        state.turned = 'moved';
        plan();
      });
    }
  }

  function click(latlng) {
    const p = { lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, latlng.lat)), lon: wrap(latlng.lng) };
    if (!state.a || (state.a && state.b)) {
      state.a = p; state.b = null; state.result = null;
      layer.clearLayers(); dangerLayer.clearLayers();
      placeMarkers(); render();
      onChange();
      emit();
      return;
    }
    state.b = p;
    state.turned = 'moved';
    placeMarkers();
    plan();
  }

  async function plan() {
    onChange();
    if (!state.a || !state.b) { render(); emit(); return; }
    const my = ++token;
    layer.clearLayers(); dangerLayer.clearLayers();
    $('route-results').hidden = true;
    panel.classList.add('busy');
    state.busy = true;
    emit();
    try {
      const prev = state.result;
      // same points and season: reuse the terrain grid, only the search changes
      const reuse = prev && prev.a === state.a && prev.b === state.b && prev.season === state.season ? prev.g : null;
      const res = await computeRoutes(state.a, state.b, state.season, state.traveller, (s) => { if (my === token) status(s); }, reuse, world, state.settings);
      if (my !== token) return;
      state.result = { ...res, a: state.a, b: state.b, settings: structuredClone(state.settings) };
      render();
      fitRoute();
      state.fresh = true;
    } catch (err) {
      console.error(err);
      if (my === token) status('Could not load the terrain data for this route.');
    } finally {
      if (my === token) { panel.classList.remove('busy'); state.busy = false; emit(); state.fresh = false; }
    }
  }

  // Zoom the 2D map so the whole route (A, B and everything between) fills the part of the
  // screen the panels leave free. See zoom.js.
  function fitRoute() {
    const r = state.result?.routes?.[state.kind] ?? Object.values(state.result?.routes ?? {}).find(Boolean);
    if (!r) return;
    let pts = r.points ?? r.pts;
    // A flat map ends at 180 deg longitude and doesn't repeat, so a route crossing it is drawn in
    // two pieces at opposite edges. Frame the bigger piece (the note in the panel suggests a
    // polar view, where the route is in one piece).
    if (isCylindrical(map) && r.bounds?.crosses180) {
      // The map can't scroll past its edge, so a piece always ends up against it. With the
      // planner panel on the right, use the piece at the west (-180) edge so it isn't under the
      // panel; on phones (panel at the bottom) use the bigger piece.
      const parts = splitAtEdge(pts);
      const length = (part) => part.reduce((s, p, i) => (i ? s + haversineKm(part[i - 1][0], part[i - 1][1], p[0], p[1]) : 0), 0);
      const west = parts.filter((part) => part.some(([, lon]) => lon < 0));
      const wide = map.getSize().x > 600;
      pts = wide && west.length ? west[0] : parts.reduce((best, part) => (length(part) > length(best) ? part : best), parts[0]);
    }
    zoomToRoute(map, pts, RADIUS[world]);
  }

  // Leaflet lines can't cross a cylindrical map's edge at +/-180: split them there.
  // Polar maps have no such edge: the line stays in one piece.
  function splitAtEdge(pts) {
    if (!isCylindrical(map)) return [pts.map(([lat, lon]) => [lat, wrap(lon)])];
    const parts = [[]];
    let prev = null;
    for (const [lat, lon0] of pts) {
      const lon = wrap(lon0);
      if (prev !== null && Math.abs(lon - prev) > 180) parts.push([]);
      parts[parts.length - 1].push([lat, lon]);
      prev = lon;
    }
    return parts;
  }

  // Small arrows along the chosen route showing the direction of travel, about every 110 px on
  // screen (so they stay readable at any zoom). Redrawn after every zoom.
  const arrowLayer = L.layerGroup().addTo(map);
  function drawArrows() {
    arrowLayer.clearLayers();
    const r = state.result?.routes?.[state.kind];
    if (!r || !state.open) return;
    const z = map.getZoom();
    const cyl = isCylindrical(map);
    const pts = cyl ? unwrapLons(r.pts) : r.pts.map(([lat, lon]) => [lat, wrap(lon)]);
    const px = pts.map(([lat, lon]) => map.project(L.latLng(lat, lon), z));
    const SPACING = 110;
    let next = SPACING * 0.6;
    let walked = 0;
    for (let i = 1; i < px.length; i++) {
      const dx = px[i].x - px[i - 1].x; const dy = px[i].y - px[i - 1].y;
      const len = Math.hypot(dx, dy);
      if (cyl && Math.abs(wrap(pts[i][1]) - wrap(pts[i - 1][1])) > 180) { walked += len; continue; } // the map's edge
      while (walked + len >= next && len > 0) {
        const t = (next - walked) / len;
        const p = L.point(px[i - 1].x + dx * t, px[i - 1].y + dy * t);
        const ll = map.unproject(p, z);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        L.marker([ll.lat, wrap(ll.lng)], {
          pane: 'route', interactive: false, keyboard: false,
          icon: L.divIcon({ className: '', html: `<span class="route-arrow" style="transform:rotate(${angle.toFixed(1)}deg)">➤</span>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
        }).addTo(arrowLayer);
        next += SPACING;
      }
      walked += len;
    }
  }
  map.on('zoomend', drawArrows);

  // While a route is shown, dim the imagery and data layers a little (20%) so the route
  // stands out; restored when the route is cleared.
  function dimImagery(on) {
    for (const name of ['layer0', 'layer1', 'layer2', 'layer3', 'overlay']) {
      const pane = map.getPane(name);
      if (!pane) continue;
      if (pane.dataset.baseFilter === undefined) pane.dataset.baseFilter = pane.style.filter || '';
      const base = pane.dataset.baseFilter;
      pane.style.filter = on ? `${base} brightness(0.8)`.trim() : base;
    }
  }
  function clearRouteLook() {
    arrowLayer.clearLayers();
    dimImagery(false);
    $('route-zoom').hidden = true;
    $('route-edge-note').hidden = true;
  }
  $('route-zoom').onclick = () => fitRoute();

  function render() {
    layer.clearLayers();
    dangerLayer.clearLayers();
    clearRouteLook();
    const has = state.a && state.b && state.result;
    // Moon / Mars: find Earth analogs for this route; Earth: its Mars / Moon equivalents
    $('route-analogs').hidden = !has || world === 'earth';
    $('route-eq').hidden = !has || world !== 'earth' || !!cmp;
    if (!has) $('route-eq-status').textContent = '';
    $('route-hint').textContent = !state.a ? 'Click the map to set the start (A).'
      : !state.b ? 'Now click the destination (B).' : 'Drag A or B to change the route. Click the map to start over.';
    $('route-swap').disabled = !(state.a && state.b);
    $('route-ab').innerHTML = state.a
      ? `<span class="ab-line"><span class="route-pin route-pin-a">A</span> ${formatLatLon(state.a.lat, state.a.lon)}</span>` +
        (state.b ? `<span class="ab-line"><span class="route-pin route-pin-b">B</span> ${formatLatLon(state.b.lat, state.b.lon)}</span>` : '')
      : '';
    if (!has) { $('route-results').hidden = true; if (!state.b) status(''); return; }
    const { routes, g, opts, traveller } = state.result;
    const found = Object.keys(KINDS).filter((k) => routes[k]);
    if (!found.length) {
      status(`No route possible for ${travellerName(traveller)}: every way from A to B crosses ground steeper than its ${opts.noGoDeg}° limit (averaged over ~2 km). Try another traveller or other points.`);
      $('route-results').hidden = true;
      return;
    }
    status(`${travellerName(traveller)} · straight-line distance ${fmtKm(g.distKm)} · terrain cells ${g.cellKm.toFixed(1)} km`);
    renderPreciseNote();
    if (!routes[state.kind]) state.kind = found[0];
    for (const k of [...found.filter((x) => x !== state.kind), state.kind]) {
      const chosen = k === state.kind;
      for (const part of splitAtEdge(routes[k].pts)) {
        // a dark halo under a bright line, so the route shows on any imagery or data layer
        L.polyline(part, { pane: 'route', color: '#000', weight: chosen ? 9 : 5, opacity: chosen ? 0.8 : 0.5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
        L.polyline(part, { pane: 'route', color: KINDS[k].colour, weight: chosen ? 4.5 : 2.5, opacity: chosen ? 1 : 0.75, dashArray: chosen ? null : '6 6', lineCap: 'round', lineJoin: 'round' })
          .on('click', (e) => { L.DomEvent.stop(e); state.kind = k; onChange(); render(); emit(); })
          .addTo(layer);
      }
    }
    drawArrows();
    dimImagery(true);
    $('route-zoom').hidden = false;
    $('route-edge-note').hidden = !(isCylindrical(map) && routes[state.kind].bounds?.crosses180);
    $('route-tabs').replaceChildren(...Object.entries(KINDS).map(([k, info]) => {
      const r = routes[k];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'route-tab';
      b.setAttribute('aria-pressed', k === state.kind);
      b.disabled = !r;
      const none = k === 'efficient' && state.result.preciseState === 'unavailable' ? 'Path unavailable' : 'no route';
      b.innerHTML = `<span class="dot" style="background:${info.colour}"></span><span class="t-name">${info.name}${r?.approximate ? ' <span class="sub">(estimate)</span>' : ''}</span>` +
        `<span class="t-sub">${r ? `${fmtKm(r.dist)} · ${travelTime(r, traveller, world).short}` : none}</span>`;
      b.onclick = () => { state.kind = k; onChange(); render(); emit(); };
      return b;
    }));
    const r = routes[state.kind];
    $('route-about').textContent = (world === 'moon' && KINDS[state.kind].aboutMoon) || (world === 'earth' && KINDS[state.kind].aboutEarth) || KINDS[state.kind].about;
    renderExplanation(explain(state.result, state.kind));
    $('route-stats').innerHTML = statsHtml(r, opts, traveller);
    drawProfile(r, opts);
    const icons = { slope: '⛰', crater: '◎', dust: '≋', storm: '🌪' };
    $('route-dangers').replaceChildren(...r.dangers.map((d) => {
      const [lat, lon] = r.pts[d.k];
      const m = L.marker([lat, wrap(lon)], {
        pane: 'route', keyboard: false, title: d.title,
        icon: L.divIcon({ className: '', html: `<span class="danger-pin danger-${d.type}">${icons[d.type]}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      }).bindPopup(`<strong>${esc(d.title)}</strong><br>${esc(d.text)}<br><span class="sub">${formatLatLon(lat, wrap(lon))} · ${fromA(r.seg[d.k])}</span>`)
        .addTo(dangerLayer);
      const li = document.createElement('li');
      li.innerHTML = `<button type="button"><span class="danger-pin danger-${d.type}">${icons[d.type]}</span><span><strong></strong><br><span class="sub"></span></span></button>`;
      li.querySelector('strong').textContent = d.title;
      li.querySelector('.sub').textContent = fromA(r.seg[d.k]);
      li.querySelector('button').onclick = () => {
        routeEvents.dispatchEvent(new CustomEvent('focus', { detail: { k: d.k, danger: d } }));
        map.flyTo([lat, wrap(lon)], Math.max(map.getZoom(), 5), { duration: 0.6 });
        m.openPopup();
      };
      return li;
    }));
    $('route-no-dangers').hidden = r.dangers.length > 0;
    $('route-results').hidden = false;
    renderCompare();
  }

  // ---- Earth analog: the same route at the Moon / Mars site, side by side
  // The site's grid uses the same cell size as the Earth route's (Earth's map tiles are a little
  // coarser), so both are measured at the same scale. Cached per cell size and traveller.
  const siteGrids = new Map(); // cell size -> Promise of the site's grid
  const siteRuns = new Map();  // traveller|cell size -> Promise of computeRoutes() at the site
  function siteRoutes(traveller, cellKm) {
    const ck = Math.round(cellKm * 10) / 10;
    const key = `${traveller}|${ck}`;
    if (!siteRuns.has(key)) {
      if (!siteGrids.has(ck)) siteGrids.set(ck, buildGrid(cmp.a, cmp.b, cmp.season ?? 0, () => {}, cmp.world, { minCellKm: ck }));
      siteRuns.set(key, siteGrids.get(ck).then((g) => computeRoutes(cmp.a, cmp.b, cmp.season ?? 0, traveller, () => {}, g, cmp.world, null)));
    }
    return siteRuns.get(key);
  }
  // This map's side at the comparison's cell size (only needed off Earth: the displayed route
  // may be the precise one, or on finer cells than Earth's tiles allow)
  const hereRuns = new Map();
  function hereRoutes(traveller, cellKm) {
    const ck = Math.round(cellKm * 10) / 10;
    const key = `${state.a.lat},${state.a.lon};${state.b.lat},${state.b.lon}|${traveller}|${ck}|${state.season}`;
    if (!hereRuns.has(key)) {
      hereRuns.set(key, buildGrid(state.a, state.b, state.season, () => {}, world, { minCellKm: ck })
        .then((g) => computeRoutes(state.a, state.b, state.season, traveller, () => {}, g, world, null)));
    }
    return hereRuns.get(key);
  }
  let cmpToken = 0;
  async function renderCompare() {
    const box = $('route-compare');
    if (!cmp || !state.result) { box.hidden = true; return; }
    const my = ++cmpToken;
    const { traveller } = state.result;
    const kind = state.kind;
    const fromEarth = cmp.world === 'earth';
    const other = WORLD_CFG[cmp.world].name;
    const matchNote = fromEarth && Number.isFinite(cmp.match)
      ? (cmp.match >= CLOSE_MATCH ? ` · <span class="equiv-badge ok">${cmp.match}% match</span>` : ` · <span class="equiv-badge far">no close equivalent (best ${cmp.match}%)</span>`) : '';
    const head = `<span class="eyebrow">${fromEarth ? `${WORLD_CFG[world].name} equivalent of your Earth route` : `Compared with the ${other} site`}</span>${matchNote}`;
    box.hidden = false;
    box.innerHTML = `${head}<p class="sub">${fromEarth ? 'Finding the same route on Earth…' : `Finding the same route at the ${other} site…`}</p>`;
    let there; let here = state.result;
    try {
      there = await siteRoutes(traveller, state.result.g.cellKm);
      const cell = Math.max(there.g.cellKm, state.result.g.cellKm);
      if (world !== 'earth') here = await hereRoutes(traveller, cell);
    } catch (err) {
      console.error(err);
      if (my === cmpToken) box.innerHTML = `${head}<p class="sub">Could not load the ${other} terrain data.</p>`;
      return;
    }
    if (my !== cmpToken || !state.result) return;
    const t = there.routes[kind];
    const h = here.routes[kind];
    const kindName = KINDS[kind].name.toLowerCase();
    if (!t || !h) {
      box.innerHTML = `${head}<p class="verdict warn">${!t
        ? `No ${kindName} route ${fromEarth ? 'on your Earth route' : `at the ${other} site`} for ${esc(travellerName(traveller))}: every way crosses ground steeper than its ${there.opts.noGoDeg}° limit.`
        : `No ${kindName} route here.`}</p>`;
      return;
    }
    const planet = fromEarth ? world : cmp.world;
    box.innerHTML = `${head}${compareHtml({
      there: t, here: h, thereWorld: cmp.world, hereWorld: world, kindName: KINDS[kind].name, travellerName: travellerName(traveller),
      walking: traveller === 'walk', crossing: !!cmp.crossing, turned: state.turned,
      missing: WORLD_CFG.earth.missing.filter((m) => planet === 'mars' || m !== 'dust storms'), // (no storms on the Moon)
      cellKm: Math.max(there.g.cellKm, here.g.cellKm),
    })}`;
  }

  // What happened to the precise (efficient) route: unavailable / on foot only / not built here
  function renderPreciseNote() {
    const box = $('route-precise-note');
    const R = state.result;
    const S = R.settings;
    box.className = 'verdict route-precise-note';
    if (R.preciseState === 'unavailable') {
      const bl = R.precise.blocked;
      box.classList.add('bad');
      box.innerHTML = `<strong>Path unavailable.</strong> ${R.traveller === 'walk' ? 'On foot' : 'Neither a rover'} (max ${R.traveller === 'walk' ? S.footMaxSlope : `${S.roverMaxSlope}°) nor on foot (max ${S.footMaxSlope}`}°) can get from A to B.` +
        (bl?.slope_deg != null ? ` The gentlest way still has a ${bl.slope_deg}° stretch, at ${formatLatLon(bl.where[0], wrap(bl.where[1]))} (⛔ on the map).` : '');
      if (bl?.where) {
        L.marker([bl.where[0], wrap(bl.where[1])], {
          pane: 'route', keyboard: false, title: 'Steepest unavoidable stretch',
          icon: L.divIcon({ className: '', html: '<span class="danger-pin danger-blocked">⛔</span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).bindPopup(`<strong>Steepest unavoidable stretch: ${bl.slope_deg}°</strong><br>Every way from A to B crosses ground at least this steep (NASA ${cfg.dem}).`).addTo(dangerLayer);
      }
    } else if (R.preciseState === 'foot-only' && R.traveller !== 'walk') {
      box.classList.add('warn');
      box.innerHTML = `<strong>On foot only.</strong> No rover route within ${S.roverMaxSlope}°; the efficient route is the on-foot route (max ${S.footMaxSlope}°).`;
    } else if (R.preciseState === 'missing') {
      box.classList.add('warn');
      box.innerHTML = `The efficient route is an <strong>estimate from the map tiles</strong>: the precise NASA ${cfg.dem} grids aren't built in this copy (see tools/build_route_grids.py${world === 'moon' ? ' --body moon' : ''}).`;
    } else {
      box.hidden = true;
      return;
    }
    box.hidden = false;
  }

  function renderExplanation(x) {
    const list = (items) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
    $('route-explain').innerHTML = `
      <p class="verdict ${x.verdict.ok ? 'ok' : 'bad'}">${x.verdict.ok ? '✓' : '✕'} ${esc(x.verdict.text)}</p>
      ${x.warnings.map((w) => `<p class="verdict warn">! ${esc(w)}</p>`).join('')}
      <span class="eyebrow">Why this route</span>${list(x.why)}
      ${x.avoided.length ? `<span class="eyebrow">Compared with the shortest route</span>${list(x.avoided)}` : ''}
      <span class="eyebrow">Difficult sections</span>${list(x.difficult.length ? x.difficult : ['None found at this map scale.'])}`;
  }

  function statsHtml(r, opts, traveller) {
    const row = (label, value, src) => `<tr><td>${label}</td><td>${value}</td><td class="src">${src}</td></tr>`;
    const storm = r.maxStorm >= 0 ? `${pct(r.avgStorm)} of sols on average, up to ${pct(r.maxStorm)}` : '–';
    const deepest = r.craters[0];
    const t = travelTime(r, traveller, world);
    const difficulty = r.dist > 0 ? r.hazardSum / r.dist : 0; // 0 = easy, ~1+ = hard
    const diffText = difficulty < 0.15 ? 'Easy' : difficulty < 0.4 ? 'Moderate' : difficulty < 0.8 ? 'Hard' : 'Very hard';
    return `<table class="route-table"><tbody>
      ${row('Distance', fmtKm(r.dist), '')}
      ${row('Terrain difficulty', `${diffText} <span class="sub">(${difficulty.toFixed(2)} hazard per km)</span>`, 'model')}
      ${row('Time', t.long, t.src)}
      ${row('Climb / descent', `↑ ${fmtM(r.up)} · ↓ ${fmtM(r.down)}`, 'measured')}
      ${row('Elevation', `${fmtM(r.lo)} to ${fmtM(r.hi)}`, 'measured')}
      ${row('Steepest slope', `${r.maxSlope.toFixed(1)}°${r.steepKm > 0 ? ` · ${fmtKm(r.steepKm)} over ${opts.cautionDeg}°` : ''}`, 'measured')}
      ${world === 'earth' ? row('Craters, dust, rock', '<span class="sub">no Earth data</span>', '') : ''}
      ${world === 'earth' ? '' : `${row('Crater rims crossed', r.craters.length ? `${r.craters.length}${deepest ? ` · deepest ${craterDepthKm(deepest.c, world) >= 1 ? `${craterDepthKm(deepest.c, world).toFixed(1)} km` : fmtM(craterDepthKm(deepest.c, world))}` : ''}` : 'none', 'catalog')}
      ${row(world === 'moon' ? 'Loose dust' : 'Loose dust / sand', r.softKm > 0 ? fmtKm(r.softKm) : 'none', 'measured')}
      ${row('Rocky ground', r.rockyKm > 0 ? fmtKm(r.rockyKm) : 'none', 'measured')}`}
      ${cfg.seasons ? row('Dust storms (season)', storm, 'observed') : ''}
      ${row('Coldest night', Number.isFinite(r.coldest) ? `${Math.round(r.coldest)} °C` : '–', cfg.coldSrc)}
    </tbody></table>`;
  }

  // Elevation profile, coloured by slope; hovering shows the spot on the map (and in 3D).
  function drawProfile(r, opts) {
    const cv = $('route-profile');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 300;
    const H = 90;
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, W, H);
    const elev = r.elev;
    const lo = Math.min(...elev); const hi = Math.max(...elev);
    const span = Math.max(0.2, hi - lo);
    const x = (k) => 4 + (r.seg[k] / Math.max(r.dist, 1e-6)) * (W - 8);
    const y = (e) => H - 14 - ((e - lo) / span) * (H - 26);
    for (let k = 1; k < elev.length; k++) {
      const s = r.slope[k];
      c.fillStyle = s > opts.cautionDeg ? '#e5484d' : s > 8 ? '#ffb02e' : '#4cd387';
      c.beginPath();
      c.moveTo(x(k - 1) - 0.5, H - 12); c.lineTo(x(k - 1) - 0.5, y(elev[k - 1])); c.lineTo(x(k) + 0.5, y(elev[k])); c.lineTo(x(k) + 0.5, H - 12);
      c.fill();
    }
    c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    c.beginPath();
    elev.forEach((e, k) => (k ? c.lineTo(x(k), y(e)) : c.moveTo(x(k), y(e))));
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,.75)';
    c.font = '10px system-ui, sans-serif';
    c.textAlign = 'right';
    c.fillText(`${fmtM(hi)}`, W - 4, 10);
    c.fillText(`${fmtM(lo)}`, W - 4, H - 16);
    c.textAlign = 'left';
    c.fillText('A', 2, H - 1);
    c.fillText('B', W - 9, H - 1);
    c.fillText(fmtKm(r.dist), W / 2 - 14, H - 1);
    cv.onmousemove = (e) => {
      const px = e.offsetX;
      let k = 0;
      while (k < r.seg.length - 1 && x(k + 1) < px) k++;
      const [lat, lon] = r.pts[k];
      if (!hover) hover = L.circleMarker([lat, wrap(lon)], { pane: 'route', radius: 6, color: '#fff', weight: 2, fillColor: KINDS[state.kind].colour, fillOpacity: 1, interactive: false }).addTo(map);
      else hover.setLatLng([lat, wrap(lon)]);
      routeEvents.dispatchEvent(new CustomEvent('hover', { detail: { k } }));
      $('route-profile-note').textContent = `${fromA(r.seg[k])} · ${fmtM(elev[k])} · slope ${r.slope[k].toFixed(1)}°`;
    };
    cv.onmouseleave = () => {
      if (hover) { hover.remove(); hover = null; }
      routeEvents.dispatchEvent(new CustomEvent('hover', { detail: { k: -1 } }));
      $('route-profile-note').textContent = 'Hover to find a spot on the map. Green < 8°, amber < 15°, red steeper.';
    };
    cv.onmouseleave();
  }

  function open() {
    state.open = true;
    panel.hidden = false;
    render();
    onChange();
    emit();
  }
  function close() {
    state.open = false;
    panel.hidden = true;
    clearRouteLook();
    state.a = state.b = null;
    state.result = null;
    placeMarkers();
    layer.clearLayers(); dangerLayer.clearLayers();
    if (hover) { hover.remove(); hover = null; }
    onChange();
    emit();
  }

  /** Set A and B (e.g. the same route at an Earth analog) and plan. */
  function setRoute(a, b, { turned } = {}) {
    state.a = a; state.b = b; state.turned = turned;
    if (!state.open) open();
    placeMarkers();
    plan();
  }

  const api = {
    open, close, click, setRoute,
    isOpen: () => state.open,
    /** current state for the 3D view: endpoints, route and which one is chosen */
    result: () => ({
      open: state.open, a: state.a, b: state.b, busy: state.busy, kind: state.kind, fresh: state.fresh,
      traveller: state.traveller, season: state.season,
      route: state.result?.routes?.[state.kind] ?? null,
      opts: state.result?.opts ?? null, colour: KINDS[state.kind].colour,
    }),
    /** this planner's part of the page address */
    query(q) {
      if (!state.open) return;
      const f = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      q.set('route', [state.a, state.b].filter(Boolean).map(f).join(';'));
      if (state.traveller !== cfg.traveller) q.set('tr', state.traveller);
      if (state.season) q.set('ss', state.season);
      if (state.kind !== 'safest') q.set('rk', state.kind);
    },
  };

  // restore from the address: route=latA,lonA;latB,lonB
  const saved = (params.get('route') ?? '').split(';').map((s) => s.split(',').map(Number));
  if (params.has('route')) {
    if (saved[0]?.length === 2 && saved[0].every(Number.isFinite)) state.a = { lat: saved[0][0], lon: saved[0][1] };
    if (saved[1]?.length === 2 && saved[1].every(Number.isFinite)) state.b = { lat: saved[1][0], lon: saved[1][1] };
    if (world === 'mars' && params.get('tr') === 'rover') state.traveller = 'curiosity'; // links from the first version
    open();
    placeMarkers();
    if (state.a && state.b) {
      map.fitBounds(L.latLngBounds([[state.a.lat, state.a.lon], [state.b.lat, state.b.lon]]), { padding: [120, 120], maxZoom: 7 });
      plan();
    }
  }
  return api;
}
