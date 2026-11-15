// Logic of tools/validate-analogs.html (see there). Runs every check for each weight set, so
// default weights can be compared: ?sets=default,before (names below) or ?w=tmax:2,slope:1,...
import { BODIES } from '../src/bodies.js';
import { loadIndex } from '../src/overlays.js';
import { siteValues, findAnalogs, loadEarthGrid, DEFAULT_WEIGHTS, parseAnalogWeights } from '../src/analogs.js';
import { KNOWN_ANALOGS, KNOWN_REGION_KM, inKnownRegion } from '../src/knownAnalogs.js';

const RADIUS = 25; // km, as in the README checks
const WEIGHT_SETS = {
  default: DEFAULT_WEIGHTS,
  // the defaults before sunlight, bare ground, frozen ground and dust were added
  before: { tmax: 2, tmin: 1, swing: 1, slope: 2, relief: 2, dry: 2 },
};
// [world, site name, lat, lon, known analog name (start of KNOWN_ANALOGS name), why the pair is known]
const PAIRS = [
  ['mars', 'Phoenix landing site', 68.22, -125.75, 'McMurdo Dry Valleys', 'ice-cemented polar ground'],
  ['mars', 'Viking 1, Chryse Planitia', 22.27, -47.95, 'Atacama', 'Viking-like soil experiments in the Atacama'],
  ['mars', 'Opportunity, Meridiani Planum', -1.95, -5.53, 'Río Tinto', 'jarosite from acid water'],
  ['moon', 'Apollo 14, Fra Mauro', -3.645, -17.471, 'Nördlinger Ries', 'Apollo 14 crew trained there'],
  ['moon', 'Apollo 16, Descartes', -8.973, 15.5, 'Sudbury Basin', 'Apollo 16 crew studied its rocks'],
  ['moon', 'Apollo 15, Hadley', 26.132, 3.634, 'Askja', 'Apollo crews trained there'],
];
// Sites for "are results new?" and "do different sites get different places?"
const SITES = [
  ['mars', 'Gale', -4.59, 137.44], ['mars', 'Meridiani', -1.95, -5.53], ['mars', 'Jezero', 18.44, 77.45],
  ['mars', 'Hellas', -42.4, 70.5], ['mars', 'Argyre', -49.7, -43.4], ['mars', 'Utopia', 49.7, 118.0],
  ['mars', 'North pole', 85, 0], ['mars', 'South pole', -85, 0], ['mars', 'Olympus Mons', 18.65, -133.8],
  ['mars', 'Valles Marineris', -13.9, -59.2], ['mars', 'InSight', 4.5, 135.6], ['mars', 'Phoenix', 68.22, -125.75],
  ['moon', 'Apollo 11', 0.674, 23.473], ['moon', 'Apollo 15', 26.132, 3.634], ['moon', 'Apollo 16', -8.973, 15.5],
  ['moon', 'Apollo 17', 20.191, 30.772], ['moon', 'Shackleton', -89.67, 129.78], ['moon', "Chang'e 4", -45.44, 177.6],
  ['moon', 'Tycho', -43.3, -11.2], ['moon', 'Aristarchus', 23.7, -47.4],
];
const SHARED_KM = 400; // a site's top-3 result is "shared" if another site has one this close

const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

const index = await loadIndex();
const grid = await loadEarthGrid();
// 300 random land points (fixed seed), for the baseline
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const randomPts = [];
while (randomPts.length < 300) {
  const c = grid.idx[Math.floor(rand() * grid.idx.length)];
  if (grid.dense.land[c] < 0.8) continue;
  randomPts.push([90 - (Math.floor(c / grid.width) + 0.5) * grid.res, -180 + ((c % grid.width) + 0.5) * grid.res]);
}
const siteCache = new Map();
const siteOf = async (world, lat, lon) => {
  const key = `${world}/${lat}/${lon}`;
  if (!siteCache.has(key)) siteCache.set(key, await siteValues(world, BODIES[world].radiusKm, index[world] ?? {}, lat, lon, RADIUS));
  return siteCache.get(key);
};

const params = new URLSearchParams(location.search);
const sets = params.getAll('w').length ? Object.fromEntries(params.getAll('w').map((w) => [w, parseAnalogWeights(w)]))
  : Object.fromEntries((params.get('sets') ?? 'default,before').split(',').map((s) => [s, WEIGHT_SETS[s]]));
const summary = {};
for (const [setName, weights] of Object.entries(sets)) {
  log(`===== weights "${setName}": ${JSON.stringify(weights)}`);
  const rows = [];
  for (const [world, name, lat, lon, knownName, why] of PAIRS) {
    const known = KNOWN_ANALOGS.find((a) => a.name.startsWith(knownName));
    const found = await findAnalogs({ site: await siteOf(world, lat, lon), weights, mode: 'match', radiusKm: RADIUS, count: 10 });
    const k = found.rankNear(known.lat, known.lon, KNOWN_REGION_KM);
    const base = median(randomPts.map(([la, lo]) => found.rankNear(la, lo, KNOWN_REGION_KM)?.top).filter((x) => x !== undefined));
    rows.push({ name, known: known.name, why, top: k?.top, base });
    log(`${name} -> ${known.name}: top ${k ? pct(k.top) : '–'} (random land point: top ${pct(base)})`);
  }
  let total = 0; let knownHits = 0; let leaks = 0;
  const top3 = [];
  for (const [world, name, lat, lon] of SITES) {
    const site = await siteOf(world, lat, lon);
    const a = await findAnalogs({ site, weights, mode: 'match', radiusKm: RADIUS, count: 10 });
    const b = await findAnalogs({ site, weights, mode: 'match', radiusKm: RADIUS, count: 10, exclude: inKnownRegion });
    total += a.results.length;
    knownHits += a.results.filter((r) => inKnownRegion(r.lat, r.lon)).length;
    leaks += b.results.filter((r) => inKnownRegion(r.lat, r.lon)).length;
    top3.push({ name, results: a.results.slice(0, 3) });
    log(`  ${name}: ${a.results.slice(0, 3).map((r) => `${r.lat.toFixed(1)},${r.lon.toFixed(1)}`).join(' | ')}`);
  }
  let shared = 0; let n3 = 0;
  for (const s of top3) {
    for (const r of s.results) {
      n3++;
      if (top3.some((o) => o !== s && o.results.some((q) => km(r, q) < SHARED_KM))) shared++;
    }
  }
  summary[setName] = {
    pairsAboveRandom: rows.filter((r) => r.top < r.base).length,
    medianKnownTop: median(rows.map((r) => r.top ?? 1)),
    knownRegionResults: `${knownHits}/${total}`,
    leaksWithOnlyNew: leaks,
    sharedTop3: `${shared}/${n3}`,
    pairs: rows.map((r) => `${r.name}: ${pct(r.top ?? 1)} vs ${pct(r.base)}`),
  };
  log(`known analogs better than a random place: ${summary[setName].pairsAboveRandom}/6, median rank top ${pct(summary[setName].medianKnownTop)}; ` +
    `results in known regions ${knownHits}/${total}; with "only new places" ${leaks} (must be 0); ` +
    `top-3 results shared with another site (< ${SHARED_KM} km): ${shared}/${n3}\n`);
}
log('JSON ' + JSON.stringify(summary));
document.getElementById('status').textContent = 'Done.';
document.title = 'done';
