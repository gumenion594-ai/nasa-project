// Earth analog search: which places on Earth are most like an area on Mars or the Moon?
//
// Earth side: a precomputed grid (public/search, made by tools/build_search_grid.py) with,
// for every 0.5° cell that has land, the land-area mean of each characteristic. For the
// chosen radius, neighbouring cells are combined into circles centred on every land cell,
// and all of them are scored - nothing is sampled at random.
//
// Score: for each characteristic, the distance between the Earth value and a target,
// divided by how much that characteristic varies across Earth's land (so °C, mm and
// degrees of slope become comparable). The weighted root-mean-square of these is the
// score; lower = more similar.
//   * "Match my site": target = the site's own value. Where the site is beyond anything on
//     Earth (Mars nights are far colder than anywhere here), it is matched *relatively*:
//     a site that is cold for Mars (say its 20th percentile) is matched to places that are
//     equally cold for Earth (Earth's 20th percentile, by area). Otherwise every Mars site
//     would get the same target (Earth's extreme) and the same results.
//   * "Most extreme": target = Earth's extreme on the site's side, for the temperatures.
//   * Slope and relief are always matched: rougher than the site isn't "better".
//   * Dryness, UV and altitude (thin air) have no Mars/Moon equivalent in our data, so they
//     are one-sided. Dryness counts any desert (under 250 mm of rain a year) as dry enough, so
//     not every search ends in the driest place on Earth; for UV / altitude, higher is better.
// Finally the best circles (3 by default, 1-10) that are at least 800 km apart are kept.
import { summarize } from './areastats.js';

const BASE = `${import.meta.env.BASE_URL}search`;
export const MIN_SEPARATION_KM = 800;
export const DEFAULT_COUNT = 3;   // how many places to show (the user can choose 1-10)
export const MAX_COUNT = 10;
const EARTH_R = 6371.0;

// Search characteristics, in dialog order.
//   site: data layer on the Moon/Mars and which statistic of it  (none = one-sided)
//   field: Earth grid field; better: direction that wins for one-sided ones
export const PARAMS = {
  tmax: { name: 'Max. temperature', unit: '°C', site: ['temp_max', 'mean'], field: 'tmax',
    help: 'Hottest month’s average daily maximum of the ground' },
  tmin: { name: 'Min. temperature', unit: '°C', site: ['temp_min', 'mean'], field: 'tmin',
    help: 'Coldest month’s average night minimum of the ground' },
  swing: { name: 'Daily temp. swing', unit: '°C', site: ['temp_range', 'mean'], field: 'swing',
    help: 'Typical day–night difference' },
  slope: { name: 'Terrain slope', unit: '°', site: ['slope', 'logMean'], field: 'logslope', log: true, always: true,
    help: 'Typical steepness, between points ~1.9 km apart (geometric mean)' },
  relief: { name: 'Terrain relief', unit: 'm', site: ['relief', 'mean'], field: 'relief', toUnit: 1000, always: true,
    help: 'How much the height varies within ~9 km' },
  dry: { name: 'Dryness', unit: 'mm/yr', field: 'dry', better: 'low', log: true, offset: 1,
    limit: Math.log10(250 + 1), // desert: under 250 mm of rain a year
    help: 'Desert-dry (under 250 mm of rain a year) counts fully; wetter places count against' },
  uv: { name: 'UV radiation', unit: 'UV index', field: 'uv', better: 'high',
    help: 'Average UV index; no Mars/Moon value, so the highest wins' },
  alt: { name: 'Altitude (thin air)', unit: 'km', field: 'alt', better: 'high',
    help: 'Height above sea level: thinner air, closer to Mars; the highest wins' },
  // Matched by rank: Mars gets ~40% of Earth's sunlight, so absolute matching would favour
  // Earth's cloudiest mid-latitudes (Mars's equator gets as much as Britain).
  sun: { name: 'Sunlight', unit: 'W/m²', site: ['sunlight', 'mean'], field: 'sun', relativeOnly: true,
    help: 'As sunny for Earth as the site is for its world (yearly average solar power on the ground)' },
  bare: { name: 'Bare ground', unit: '%', field: 'bare', toUnit: 100, better: 'high', limit: 0.5,
    help: 'Share of the land that is bare rock, sand or soil (MODIS); half or more counts fully' },
  frozen: { name: 'Frozen ground', unit: '°C', site: ['ice', 'mean'], field: 'tmean', worlds: ['mars'],
    // the Mars ice map says whether the site has ice in the ground; Earth's yearly mean ground
    // temperature says whether the ground stays frozen (below 0 °C: permafrost)
    siteFormat: (v) => `${Math.round(v)}% ground-ice signal`,
    rule: (ice) => (ice >= ICE_RICH ? { better: 'low', limit: 0 } : { better: 'high', limit: 0 }),
    help: 'Ice-rich Mars ground (Odyssey) looks for permafrost (yearly mean ground temperature below 0 °C), dry ground for unfrozen' },
  dust: { name: 'Dust in the air', unit: 'µg/m³', site: ['storms', 'mean'], field: 'dust', log: true, worlds: ['mars'],
    relativeOnly: true, siteFormat: (v) => `dust storms on ${Math.round(v * 100)}% of days`,
    help: 'As dusty for Earth (MERRA-2 dust near the ground) as the site is for Mars (how often dust storms cover it)' },
};
// Mars ice map value (% fewer neutrons than the driest ground) from which the ground counts as
// ice-rich. Odyssey's map reads 20-40% at the equator (mostly water bound in minerals) and over
// 60% poleward of ~60°, where ground ice lies within ~1 m (e.g. Phoenix 77%)
export const ICE_RICH = 50;
// how a parameter is compared for this site: { better, limit } (one-sided) or {} (matched)
export const ruleFor = (k, siteValue) => {
  const p = PARAMS[k];
  if (p.rule) return Number.isFinite(siteValue) ? p.rule(siteValue) : {};
  return { better: p.better, limit: p.limit };
};
export const WEIGHT_STEPS = [0, 0.5, 1, 2, 3];
// Defaults, tested on 18 Moon and Mars sites so that different sites get different places
// (only 9% of results shared between sites): the characteristics that differ between sites
// count most. UV and altitude are off: they have no Mars/Moon value, so they would pull every
// search towards the same few highlands (Tibet, the Andes).
export const DEFAULT_WEIGHTS = { tmax: 2, tmin: 1, swing: 1, slope: 2, relief: 2, dry: 2, uv: 0, alt: 0, sun: 1, bare: 1, frozen: 1, dust: 1 };

// Earth value of a parameter in display units (fields are stored as log10, km, ...)
export function displayValue(key, v) {
  const p = PARAMS[key];
  if (!Number.isFinite(v)) return NaN;
  if (p.log) return 10 ** v - (p.offset ?? 0);
  return v * (p.toUnit ?? 1);
}

// ---- Earth grid --------------------------------------------------------------

let gridPromise = null;
export function loadEarthGrid() {
  gridPromise ??= Promise.all([
    fetch(`${BASE}/earth.json`).then((r) => r.json()),
    fetch(`${BASE}/earth.bin`).then((r) => r.arrayBuffer()),
  ]).then(([meta, buf]) => {
    const n = meta.cells;
    const W = meta.width;
    const H = meta.height;
    const idx = new Uint32Array(buf, 0, n);
    const dense = {};
    meta.fields.forEach((f, i) => {
      const col = new Int16Array(buf, n * 4 + i * n * 2, n);
      const arr = new Float32Array(W * H).fill(NaN);
      const s = meta.scales[f];
      for (let j = 0; j < n; j++) arr[idx[j]] = col[j] * s;
      dense[f] = arr;
    });
    return { ...meta, idx, dense };
  });
  return gridPromise;
}

const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Values of every field over circles of `radiusKm` around every land cell.
 * Circles smaller than a cell use the cell itself. Returns
 * { cells: Uint32Array, lat, lon, land, values: {field: Float32Array} }.
 */
function circles(grid, radiusKm, fields) {
  const { width: W, height: H, res, dense } = grid;
  const cellKm = rad(res) * EARTH_R;
  const n = grid.idx.length;
  const out = { cells: grid.idx, lat: new Float32Array(n), lon: new Float32Array(n), land: new Float32Array(n), values: {} };
  for (const f of fields) out.values[f] = new Float32Array(n);
  const own = radiusKm < cellKm / 2;
  const dRows = Math.ceil(radiusKm / cellKm);
  const nf = fields.length;
  const cols = fields.map((f) => dense[f]);
  const sums = new Float64Array(nf);
  const cosRow = Float64Array.from({ length: H }, (_, r) => Math.cos(rad(90 - (r + 0.5) * res)));
  // For a centre in row `row`: in each nearby row, how many columns either side are within
  // the radius (-1 = none). Distance only depends on the rows and the column offset.
  const limitCache = new Map();
  const limits = (row) => {
    if (limitCache.has(row)) return limitCache.get(row);
    const lat0 = 90 - (row + 0.5) * res;
    const lim = new Int32Array(2 * dRows + 1).fill(-1);
    for (let d = -dRows; d <= dRows; d++) {
      const r = row + d;
      if (r < 0 || r >= H) continue;
      const lat = 90 - (r + 0.5) * res;
      let dc = -1;
      while (dc + 1 <= W / 2 && distanceKm(lat0, 0, lat, (dc + 1) * res) <= radiusKm) dc++;
      lim[d + dRows] = dc;
    }
    limitCache.set(row, lim);
    return lim;
  };
  for (let j = 0; j < n; j++) {
    const c = grid.idx[j];
    const row = Math.floor(c / W);
    const col = c % W;
    const lat0 = 90 - (row + 0.5) * res;
    const lon0 = -180 + (col + 0.5) * res;
    // circle centre: the cell's land centroid when the circle is smaller than the cell
    out.lat[j] = own ? lat0 + dense.clat[c] : lat0;
    out.lon[j] = own ? lon0 + dense.clon[c] : lon0;
    if (own) {
      out.land[j] = dense.land[c];
      for (const f of fields) out.values[f][j] = dense[f][c];
      continue;
    }
    // combine all cells whose centre is inside the circle, weighted by land area
    let wAll = 0; let wLand = 0;
    sums.fill(0);
    const lim = limits(row);
    for (let r = Math.max(0, row - dRows); r <= Math.min(H - 1, row + dRows); r++) {
      const dCols = r === row ? Math.max(0, lim[r - row + dRows]) : lim[r - row + dRows];
      if (dCols < 0) continue;
      const cos = cosRow[r];
      for (let dc = -dCols; dc <= dCols; dc++) {
        let cc = col + dc;
        if (cc < 0) cc += W; else if (cc >= W) cc -= W;
        wAll += cos;
        const k = r * W + cc;
        const land = dense.land[k];
        if (!(land > 0)) continue;
        const w = cos * land;
        wLand += w;
        for (let i = 0; i < nf; i++) sums[i] += w * cols[i][k];
      }
    }
    out.land[j] = wLand / wAll;
    for (let i = 0; i < nf; i++) out.values[fields[i]][j] = sums[i] / wLand;
  }
  return out;
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

// ---- Site values ---------------------------------------------------------------

/** The site's value of every two-sided parameter, in Earth-grid units (log10 for slope, km for relief). */
export async function siteValues(body, bodyRadiusKm, index, lat, lon, radiusKm) {
  const out = {};
  const quantiles = {}; // the body's own percentiles 0..100 of each parameter
  await Promise.all(Object.entries(PARAMS).map(async ([k, p]) => {
    if (!p.site) return;
    const [layer, stat] = p.site;
    if (layer === 'storms') {
      if (body !== 'mars') return;
      const d = await marsDustAt(lat, lon, radiusKm);
      out[k] = d.value;
      quantiles[k] = d.quantiles;
      return;
    }
    const meta = index[layer];
    if (!meta) return;
    const res = await summarize(body, layer, meta, lat, lon, radiusKm, bodyRadiusKm);
    if (!res.none) out[k] = res[stat];
    if (meta.quantiles) quantiles[k] = meta.quantiles;
  }));
  Object.defineProperty(out, 'quantiles', { value: quantiles, enumerable: false });
  return out;
}

// ---- The search ----------------------------------------------------------------

/**
 * weights: {param: weight}; mode: 'match' | 'extreme'; site: from siteValues().
 * Resolves to { results: [{lat, lon, score, values, targets}], targets, spreads, used }.
 */
export async function findAnalogs({ site, weights, mode, radiusKm, count = DEFAULT_COUNT, exclude = null }) {
  const grid = await loadEarthGrid();
  // parameters that take part: weight > 0, and for two-sided ones a site value
  const used = Object.keys(PARAMS).filter((k) => weights[k] > 0 && (!PARAMS[k].site || Number.isFinite(site[k])));
  const rules = Object.fromEntries(used.map((k) => [k, ruleFor(k, site[k])]));
  if (!used.length) return { results: [], used };
  const fields = used.map((k) => PARAMS[k].field);
  const c = circles(grid, radiusKm, fields);
  const n = c.cells.length;
  const candidate = (j) => c.land[j] >= 0.5;
  // `exclude(lat, lon)`: places that may not be a result (e.g. known analog regions). They still
  // count for Earth's spread and percentiles, so the scores don't change.
  const allowed = exclude ? Uint8Array.from({ length: n }, (_, j) => !exclude(c.lat[j], c.lon[j])) : null;

  // per parameter: Earth's spread (5th-95th percentile of the circles) and the target
  const targets = {};
  const spreads = {};
  const extremes = {};
  const relative = {}; // params matched relatively: the site's percentile on its own world
  const areaW = Float32Array.from(c.lat, (la) => Math.cos(rad(la)));
  for (const k of used) {
    const v = c.values[PARAMS[k].field];
    const sorted = Float32Array.from({ length: n }, (_, j) => (candidate(j) ? v[j] : NaN))
      .filter(Number.isFinite).sort();
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    spreads[k] = Math.max(1e-6, percentile(sorted, 0.95) - percentile(sorted, 0.05));
    extremes[k] = [lo, hi];
    const p = PARAMS[k];
    const rule = rules[k];
    if (rule.limit !== undefined) targets[k] = rule.limit; // good enough beyond a limit (e.g. any desert)
    else if (rule.better) targets[k] = rule.better === 'low' ? lo : hi;
    else if (mode === 'extreme' && !p.always && !p.relativeOnly) {
      targets[k] = site[k] < percentile(sorted, 0.5) ? lo : hi;
    } else if (!p.relativeOnly && site[k] >= lo && site[k] <= hi) {
      targets[k] = site[k];
    } else {
      // beyond anything on Earth: same percentile of Earth (by area) as the site has on its world
      const q = site.quantiles?.[k];
      const pct = q ? rankIn(q, site[k]) : (site[k] < lo ? 0 : 1);
      targets[k] = weightedQuantile(v, areaW, candidate, pct);
      relative[k] = pct;
    }
  }

  const totalW = used.reduce((a, k) => a + weights[k], 0);
  const scores = new Float32Array(n).fill(Infinity);
  for (let j = 0; j < n; j++) {
    if (!candidate(j)) continue;
    let s = 0;
    let ok = true;
    for (const k of used) {
      const v = c.values[PARAMS[k].field][j];
      if (!Number.isFinite(v)) { ok = false; break; }
      s += weights[k] * gapOf(k, v, targets[k], spreads[k], rules[k]) ** 2;
    }
    if (ok) scores[j] = Math.sqrt(s / totalW);
  }

  // best first; keep a place only if it's far enough from every place already kept
  const order = Array.from({ length: n }, (_, j) => j).filter((j) => Number.isFinite(scores[j]))
    .sort((a, b) => scores[a] - scores[b]);
  const results = [];
  for (const j of order) {
    if (allowed && !allowed[j]) continue;
    if (results.some((r) => distanceKm(r.lat, r.lon, c.lat[j], c.lon[j]) < MIN_SEPARATION_KM)) continue;
    results.push({
      lat: c.lat[j], lon: c.lon[j], score: scores[j],
      values: Object.fromEntries(used.map((k) => [k, c.values[PARAMS[k].field][j]])),
    });
    if (results.length === count) break;
  }

  // How well the best circle near a point ranks among all of Earth's circles: used to check
  // whether the search finds known analogs. top = share of circles scoring better (0..1).
  function rankNear(lat, lon, withinKm) {
    for (let i = 0; i < order.length; i++) {
      const j = order[i];
      if (distanceKm(lat, lon, c.lat[j], c.lon[j]) <= withinKm) {
        return { lat: c.lat[j], lon: c.lon[j], score: scores[j], top: i / order.length };
      }
    }
    return null;
  }
  return { results, targets, spreads, extremes, relative, used, rules, rankNear };
}

// A parameter's value (in Earth-grid units) as text with its unit, e.g. "-35°C", "120 mm/yr"
export function formatValue(key, v) {
  const d = displayValue(key, v);
  if (!Number.isFinite(d)) return '–';
  const p = PARAMS[key];
  const digits = Math.abs(d) >= 100 || ['°C', 'm', '%', 'W/m²'].includes(p.unit) ? 0 : Math.abs(d) >= 10 ? 1 : 2;
  return `${d.toFixed(digits)}${['°C', '°', '%'].includes(p.unit) ? p.unit : ` ${p.unit}`}`;
}

// A site's value as text: in the Earth unit, or the site's own unit where they differ (ice, dust)
export function formatSite(key, v) {
  const p = PARAMS[key];
  if (!Number.isFinite(v)) return '–';
  return p.siteFormat ? p.siteFormat(v) : formatValue(key, v);
}

/** How far a value is from its target, in Earth spreads (as in the score). 0 = on target. */
// With a limit, only the wrong side counts (any desert is dry enough).
export function gapOf(key, value, target, spread, rule = ruleFor(key)) {
  const diff = rule.limit === undefined ? value - target
    : rule.better === 'low' ? Math.max(0, value - target) : Math.min(0, value - target);
  return Math.abs(diff) / spread;
}

// ---- Mars dust storms at a site (public/route/storms.bin) ------------------------
// 4 seasons x 90 x 180 cells of 2°, uint8: share of observed sols with a dust storm, in 1/250
// steps (Mars Dust Activity Database). The site value is the yearly mean over the circle;
// its quantiles (area-weighted, 0..100) place it among all of Mars.
let stormsPromise = null;
function loadStorms() {
  stormsPromise ??= fetch(`${import.meta.env.BASE_URL}route/storms.bin`).then((r) => r.arrayBuffer()).then((buf) => {
    const raw = new Uint8Array(buf);
    const year = new Float32Array(90 * 180);
    for (let i = 0; i < year.length; i++) {
      year[i] = (raw[i] + raw[i + 16200] + raw[i + 32400] + raw[i + 48600]) / 4 / 250;
    }
    const idx = Array.from(year.keys()).sort((a, b) => year[a] - year[b]);
    const w = (i) => Math.cos(rad(90 - (Math.floor(i / 180) + 0.5) * 2));
    const total = idx.reduce((a, i) => a + w(i), 0);
    const quantiles = [];
    let acc = 0; let q = 0;
    for (const i of idx) {
      acc += w(i);
      while (q <= 100 && acc >= (q / 100) * total) { quantiles.push(year[i]); q++; }
    }
    while (quantiles.length < 101) quantiles.push(year[idx[idx.length - 1]]);
    return { year, quantiles };
  });
  return stormsPromise;
}
async function marsDustAt(lat, lon, radiusKm) {
  const { year, quantiles } = await loadStorms();
  const R = 3389.5;
  let sum = 0; let sw = 0;
  for (let r = 0; r < 90; r++) {
    const la = 90 - (r + 0.5) * 2;
    for (let c = 0; c < 180; c++) {
      const lo = -180 + (c + 0.5) * 2;
      const a = Math.sin(rad(la - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(la)) * Math.sin(rad(lo - lon) / 2) ** 2;
      if (2 * R * Math.asin(Math.min(1, Math.sqrt(a))) > radiusKm) continue;
      const w = Math.cos(rad(la));
      sum += w * year[r * 180 + c]; sw += w;
    }
  }
  if (!sw) { // circle smaller than a cell: the cell under the centre
    const r = Math.min(89, Math.floor((90 - lat) / 2));
    const c = Math.min(179, Math.floor((lon + 180) / 2));
    return { value: year[r * 180 + c], quantiles };
  }
  return { value: sum / sw, quantiles };
}

// Where a value falls among a body's percentiles 0..100: 0..1
function rankIn(q, x) {
  if (x <= q[0]) return 0;
  if (x >= q[q.length - 1]) return 1;
  let i = 1;
  while (q[i] < x) i++;
  const f = q[i] > q[i - 1] ? (x - q[i - 1]) / (q[i] - q[i - 1]) : 0.5;
  return (i - 1 + f) / (q.length - 1);
}

// The value below which a share `pct` of the (weighted) candidates lie
function weightedQuantile(values, weights, include, pct) {
  const idx = [];
  let total = 0;
  for (let j = 0; j < values.length; j++) {
    if (include(j) && Number.isFinite(values[j])) { idx.push(j); total += weights[j]; }
  }
  idx.sort((a, b) => values[a] - values[b]);
  let acc = 0;
  for (const j of idx) {
    acc += weights[j];
    if (acc >= pct * total) return values[j];
  }
  return values[idx[idx.length - 1]];
}

// Similarity in % for display: 100 % = on target; 0 % = a whole Earth spread away (or more).
export const similarity = (score) => Math.max(0, Math.round((1 - score) * 100));

// "a:1,b:0.5" <-> {a: 1, b: 0.5}, only search parameters and allowed steps
export function parseAnalogWeights(text) {
  const out = {};
  for (const part of (text ?? '').split(',')) {
    const [k, v] = part.split(':');
    if (PARAMS[k] && WEIGHT_STEPS.includes(Number(v))) out[k] = Number(v);
  }
  return out;
}

// ---- Earth -> Moon / Mars: an Earth place's own values --------------------------------------

const EARTH_FIELDS = ['tmax', 'tmin', 'swing', 'logslope', 'relief', 'dry'];
let earthRanks = null; // field -> { v: sorted values, w: cumulative land area }
async function earthDistributions() {
  if (earthRanks) return earthRanks;
  const g = await loadEarthGrid();
  earthRanks = {};
  for (const f of EARTH_FIELDS) {
    const items = [];
    for (const c of g.idx) {
      const v = g.dense[f][c];
      if (!Number.isFinite(v)) continue;
      const row = Math.floor(c / g.width);
      items.push([v, Math.cos(rad(90 - (row + 0.5) * g.res)) * (g.dense.land[c] || 0)]);
    }
    items.sort((a, b) => a[0] - b[0]);
    const w = new Float64Array(items.length);
    let acc = 0;
    items.forEach(([, x], i) => { acc += x; w[i] = acc; });
    earthRanks[f] = { v: Float64Array.from(items, (x) => x[0]), w, total: acc };
  }
  return earthRanks;
}

/**
 * The characteristics an Earth place shares with the Moon / Mars maps, averaged over the land
 * within `radiusKm` (the cell itself for small circles), and where each ranks on Earth's land
 * (0..1, by area). Resolves to null for a place with no land data (open sea, ice sheets).
 *   { tmax, tmin, swing (°C), slope (°), relief (km), land, pct: {...} }
 */
export async function earthPlace(lat, lon, radiusKm) {
  const g = await loadEarthGrid();
  const [dist] = await Promise.all([earthDistributions()]);
  const { width: W, height: H, res, dense } = g;
  const cellKm = rad(res) * EARTH_R;
  const row0 = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / res)));
  const col0 = ((Math.floor((lon + 180) / res) % W) + W) % W;
  const dRows = Math.max(0, Math.ceil(radiusKm / cellKm));
  const sums = Object.fromEntries(EARTH_FIELDS.map((f) => [f, 0]));
  let wLand = 0; let wAll = 0;
  for (let r = Math.max(0, row0 - dRows); r <= Math.min(H - 1, row0 + dRows); r++) {
    const la = 90 - (r + 0.5) * res;
    const cos = Math.cos(rad(la));
    const dCols = Math.min(W / 2, Math.ceil(dRows / Math.max(0.05, cos)));
    for (let dc = -dCols; dc <= dCols; dc++) {
      const c = (((col0 + dc) % W) + W) % W;
      const lo = -180 + (c + 0.5) * res;
      const own = r === row0 && c === col0;
      if (!own && distanceKm(lat, lon, la, lo) > Math.max(radiusKm, cellKm / 2)) continue;
      wAll += cos;
      const k = r * W + c;
      const land = dense.land[k];
      if (!(land > 0) || EARTH_FIELDS.some((f) => !Number.isFinite(dense[f][k]))) continue;
      const w = cos * land;
      wLand += w;
      for (const f of EARTH_FIELDS) sums[f] += w * dense[f][k];
    }
  }
  if (!(wLand > 0)) return null;
  const mean = Object.fromEntries(EARTH_FIELDS.map((f) => [f, sums[f] / wLand]));
  const rank = (f, v) => {
    const { v: vs, w, total } = dist[f];
    let lo = 0; let hi = vs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vs[m] < v) lo = m + 1; else hi = m; }
    return total > 0 ? w[lo] / total : 0.5;
  };
  // dryness (stored as log10 of rain in mm + 1): how much wetter than a desert (under 250 mm a
  // year) this place is, in units of Earth's spread; 0 for any desert. Moon and Mars are bone dry.
  const d = dist.dry;
  const q = (p) => { let i = 0; while (i < d.w.length - 1 && d.w[i] < p * d.total) i++; return d.v[i]; };
  const wetness = Math.max(0, mean.dry - PARAMS.dry.limit) / Math.max(1e-6, q(0.95) - q(0.05));
  return {
    tmax: mean.tmax, tmin: mean.tmin, swing: mean.swing,
    slope: 10 ** mean.logslope, relief: mean.relief,
    rainMm: 10 ** mean.dry - 1, wetness,
    land: wLand / wAll,
    pct: { tmax: rank('tmax', mean.tmax), tmin: rank('tmin', mean.tmin), swing: rank('swing', mean.swing),
      slope: rank('logslope', mean.logslope), relief: rank('relief', mean.relief) },
  };
}
