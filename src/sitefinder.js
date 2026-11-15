// "Find sites": search a whole world (Moon or Mars) for areas that meet a set of criteria,
// instead of clicking one. A criterion is a data layer (or latitude) with optional limits
// (min / max, in the layer's own units), an optional preference (lower or higher is better)
// and an importance.
//
// Uses the same data as "Find similar spots" (src/similar.js): every layer's map tiles at
// zoom level 1 (~21 km pixels on Mars, ~11 km on the Moon), averaged over a circle of the
// chosen radius around every pixel. Then:
//   1. Limits: an area passes only if every limited value is inside its limits (and has data).
//   2. Ranking among the areas that pass: each preference gives a fit of 0..1, where the value
//      sits among the passing areas (best of them = 1, worst = 0); the importance-weighted mean
//      is the area's fit. Limits without a preference
//      only filter. With no preference at all, areas are ranked by how comfortably they meet
//      the limits (a fifth of the world's spread from the nearest limit, or more, = 1).
//   3. The best areas at least MIN_SEPARATION_KM apart are kept.
import { decode } from './overlays.js';
import { W, H, RES, rowLat, colLon, COS_ROW, layerGrid, circleShape, circleMeans, areaQuantiles, distanceKm } from './similar.js';

export const MIN_SEPARATION_KM = 300;
export const DEFAULT_COUNT = 5;
export const MAX_COUNT = 10;
export const LATITUDE = 'latitude'; // a criterion without a layer
const COMFORT = 0.2; // share of the spread inside the limits that counts as "comfortably inside"
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/**
 * criteria: { key: { min?, max?, prefer?: 'low'|'high', weight } } with key a layer or LATITUDE.
 * Resolves to { results: [{lat, lon, fit, values}], used, missing, passShare, shares }:
 *   passShare: share of the world's area meeting every limit; shares: per criterion, the
 *   share of the area meeting that limit alone (to see which limit rules most places out).
 */
export async function findSites({ body, sphereKm, layers, criteria, radiusKm, count = DEFAULT_COUNT, onProgress }) {
  const keys = Object.keys(criteria).filter((k) => k === LATITUDE || layers[k]);
  const missing = Object.keys(criteria).filter((k) => !keys.includes(k));
  const layerKeys = keys.filter((k) => k !== LATITUDE);
  onProgress?.('Loading the map data…');
  const raw = await Promise.all(layerKeys.map((k) => layerGrid(body, k, layers[k])));
  const shapeOf = circleShape(radiusKm / sphereKm);

  // values over the circle around every pixel, in the layer's own units
  const values = {};
  const spread = {};
  for (let i = 0; i < layerKeys.length; i++) {
    const k = layerKeys[i];
    onProgress?.(`Measuring every area of the surface… (${i + 1}/${layerKeys.length})`);
    await nextFrame();
    const m = circleMeans(raw[i], shapeOf);
    const [p5, p95] = areaQuantiles(m, [0.05, 0.95]).map((t) => decode(layers[k], 1 + t * 254));
    const v = new Float32Array(m.length);
    for (let j = 0; j < m.length; j++) v[j] = m[j] === m[j] ? decode(layers[k], 1 + m[j] * 254) : NaN;
    values[k] = v;
    spread[k] = { p5, p95, size: Math.max(1e-9, p95 - p5) };
  }
  spread[LATITUDE] = { p5: -90, p95: 90, size: 180 };

  onProgress?.('Checking the limits and ranking…');
  await nextFrame();
  const valueAt = (k, j) => (k === LATITUDE ? rowLat(Math.floor(j / W)) : values[k][j]);
  // 1. limits: which areas pass every limit (and how much of the surface passes each one)
  const pass = new Uint8Array(W * H);
  const passArea = Object.fromEntries(keys.map((k) => [k, 0]));
  let allArea = 0; let worldArea = 0;
  for (let r = 0; r < H; r++) {
    const a = COS_ROW[r];
    for (let c = 0; c < W; c++) {
      const j = r * W + c;
      worldArea += a;
      let ok = true;
      for (const k of keys) {
        const { min, max } = criteria[k];
        const v = valueAt(k, j);
        if (v === v && !(min !== undefined && v < min) && !(max !== undefined && v > max)) passArea[k] += a;
        else ok = false;
      }
      if (ok) { pass[j] = 1; allArea += a; }
    }
  }
  // 2. ranking among the areas that pass: by the preferences (each scaled from the worst to the
  // best value among the passing areas, so "higher is better" ranks within them); with no
  // preference at all, by how comfortably the limits are met
  const prefs = keys.filter((k) => criteria[k].prefer);
  const ranked = prefs.length ? prefs : keys;
  const scale = {};
  for (const k of ranked) {
    const v = [];
    for (let j = 0; j < pass.length; j++) if (pass[j]) v.push(valueAt(k, j));
    v.sort((a, b) => a - b);
    scale[k] = v.length ? { lo: v[0], hi: v[v.length - 1] } : { lo: 0, hi: 1 };
    scale[k].size = Math.max(1e-9, scale[k].hi - scale[k].lo);
  }
  const totalW = ranked.reduce((a, k) => a + (criteria[k].weight ?? 1), 0) || 1;
  const fit = new Float32Array(W * H).fill(-1);
  // tie-break (e.g. many areas at the flattest slope the data resolves): how comfortably the
  // limits are met
  const limited = keys.filter((k) => criteria[k].min !== undefined || criteria[k].max !== undefined);
  const comfort = new Float32Array(W * H);
  for (let j = 0; j < pass.length; j++) {
    if (!pass[j]) continue;
    let cs = 0;
    for (const k of limited) {
      const { min, max } = criteria[k];
      const v = valueAt(k, j);
      const m = Math.min(min !== undefined ? v - min : Infinity, max !== undefined ? max - v : Infinity);
      cs += Math.min(1, Math.max(0, m / (COMFORT * spread[k].size)));
    }
    comfort[j] = limited.length ? cs / limited.length : 0;
    let s = 0;
    for (const k of ranked) {
      const { min, max, prefer, weight = 1 } = criteria[k];
      const v = valueAt(k, j);
      let g;
      if (prefer === 'low') g = (scale[k].hi - v) / scale[k].size;
      else if (prefer === 'high') g = (v - scale[k].lo) / scale[k].size;
      else {
        const m = Math.min(min !== undefined ? v - min : Infinity, max !== undefined ? max - v : Infinity);
        g = m === Infinity ? 1 : m / (COMFORT * spread[k].size);
      }
      s += weight * Math.min(1, Math.max(0, g));
    }
    fit[j] = s / totalW;
  }

  // best first; keep an area only if it is far enough from every area already kept
  const order = [];
  for (let j = 0; j < fit.length; j++) if (fit[j] >= 0) order.push(j);
  order.sort((a, b) => (Math.abs(fit[b] - fit[a]) > 1e-4 ? fit[b] - fit[a] : comfort[b] - comfort[a]));
  const results = [];
  for (const j of order) {
    const lat = rowLat(Math.floor(j / W));
    const lon = colLon(j % W);
    if (results.some((p) => distanceKm(sphereKm, p.lat, p.lon, lat, lon) < MIN_SEPARATION_KM)) continue;
    results.push({ lat, lon, fit: fit[j], values: Object.fromEntries(keys.map((k) => [k, valueAt(k, j)])) });
    if (results.length === count) break;
  }
  return {
    results, used: keys, missing,
    passShare: allArea / worldArea,
    shares: Object.fromEntries(keys.map((k) => [k, passArea[k] / worldArea])),
    cellKm: (RES * Math.PI / 180) * sphereKm,
  };
}
