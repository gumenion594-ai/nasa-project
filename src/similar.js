// "Find similar spots": which other places on the same world (Moon or Mars) are most like
// the selected area?
//
// Data: each characteristic's map tiles at zoom level 1 (1024 x 512 pixels for the whole
// world: ~21 km per pixel on Mars, ~11 km on the Moon). The tile pyramid is box-averaged
// from full resolution, so every pixel is the area mean of the detailed data (for
// logarithmic layers the mean of the log, i.e. the geometric mean). Values are compared
// on the tiles' own 0..1 colour-code scale, which is linear in the value - or in its log
// for slope, relief and thermal inertia - so no unit conversions are needed.
//
// For every pixel of the world, each characteristic is averaged over a circle of the
// selected radius around it (circles smaller than a pixel use the pixel itself). The site
// gets exactly the same treatment, so site and candidates are compared like with like.
//
// Score: for each characteristic, |candidate - site| divided by how much that
// characteristic varies across the world (5th-95th percentile by area), so °C, % and km
// become comparable. The weighted root-mean-square of these is the score; lower = more
// similar. Spots closer than MIN_DISTANCE_KM to the site are left out, and the results
// are kept at least that far apart from each other, so they are genuinely different places.
import { decode, loadImage } from './overlays.js';

export const MIN_DISTANCE_KM = 500;
export const DEFAULT_COUNT = 3;
export const MAX_COUNT = 10;

const BASE = `${import.meta.env.BASE_URL}overlays`;
const Z = 1;                 // tile level used for the search
const W = 512 * 2 ** Z;      // world width in pixels (equirectangular, 2:1)
const H = 256 * 2 ** Z;
const RES = 360 / W;         // degrees per pixel
const rad = (d) => (d * Math.PI) / 180;
const rowLat = (r) => 90 - (r + 0.5) * RES;
const colLon = (c) => -180 + (c + 0.5) * RES;
const COS_ROW = Float64Array.from({ length: H }, (_, r) => Math.cos(rad(rowLat(r))));
const SIN_ROW = Float64Array.from({ length: H }, (_, r) => Math.sin(rad(rowLat(r))));

/** Search grid cell size in km, for a world of radius `sphereKm`. */
export const cellKm = (sphereKm) => rad(RES) * sphereKm;

export function distanceKm(R, lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- One layer as a whole-world grid of 0..1 values (NaN = no data) -------------

const canvas = document.createElement('canvas');
canvas.width = canvas.height = 256;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const grids = new Map(); // `${body}/${layer}` -> Promise<Float32Array>
function layerGrid(body, layer, meta) {
  const key = `${body}/${layer}`;
  if (!grids.has(key)) {
    const p = (async () => {
      const out = new Float32Array(W * H).fill(NaN);
      const latMin = meta.lat_min ?? -90;
      const latMax = meta.lat_max ?? 90;
      const jobs = [];
      for (let ty = 0; ty < H / 256; ty++) {
        for (let tx = 0; tx < W / 256; tx++) {
          // tiles wholly outside a layer's latitude range were never written
          const top = 90 - ty * (256 * RES);
          const bottom = top - 256 * RES;
          if (bottom >= latMax || top <= latMin) continue;
          jobs.push(loadImage(`${BASE}/${body}/${layer}/${Z}/${ty}/${tx}.${meta.format}`).then((img) => {
            ctx.clearRect(0, 0, 256, 256);
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, 256, 256).data;
            for (let y = 0; y < 256; y++) {
              const row = ty * 256 + y;
              const lat = rowLat(row);
              if (lat < latMin || lat > latMax) continue;
              for (let x = 0; x < 256; x++) {
                const i = (y * 256 + x) * 4;
                if (data[i + 3] < 128 || data[i] === 0) continue;
                out[row * W + tx * 256 + x] = (data[i] - 1) / 254;
              }
            }
          }));
        }
      }
      await Promise.all(jobs);
      return out;
    })();
    p.catch(() => grids.delete(key)); // let a later search try again
    grids.set(key, p);
  }
  return grids.get(key);
}

// ---- Circle averages ---------------------------------------------------------------

// For a centre in row `row`: for each row offset d in -n..n, how many columns either side
// lie within the circle (-1 = none, >= W/2 = the whole row).
function circleShape(angle) {
  const n = Math.ceil(angle / rad(RES));
  const cosA = Math.cos(angle);
  const cache = new Map();
  return (row) => {
    if (cache.has(row)) return cache.get(row);
    const lim = new Int32Array(2 * n + 1).fill(-1);
    for (let d = -n; d <= n; d++) {
      const r = row + d;
      if (r < 0 || r >= H) continue;
      const den = COS_ROW[row] * COS_ROW[r];
      const x = den > 1e-12 ? (cosA - SIN_ROW[row] * SIN_ROW[r]) / den : (d === 0 ? -2 : 2);
      if (x <= -1) lim[d + n] = W;                       // the circle spans this whole row
      else if (x <= 1) lim[d + n] = Math.floor((Math.acos(x) * 180) / Math.PI / RES + 1e-9);
      if (d === 0) lim[n] = Math.max(0, lim[n]);         // the centre pixel itself, always
    }
    cache.set(row, lim);
    return lim;
  };
}

/**
 * Mean of `grid` over a circle around every pixel; NaN where less than half of the circle
 * has data. Uses per-row running sums, so each circle costs one step per row it spans.
 */
function circleMeans(grid, shapeOf) {
  const sum = new Float64Array(W + 1);
  const cnt = new Float64Array(W + 1);
  // running sums of every row, computed once
  const rowSum = new Float64Array(H * (W + 1));
  const rowCnt = new Float64Array(H * (W + 1));
  for (let r = 0; r < H; r++) {
    sum[0] = 0; cnt[0] = 0;
    for (let c = 0; c < W; c++) {
      const v = grid[r * W + c];
      const ok = v === v; // not NaN
      sum[c + 1] = sum[c] + (ok ? v : 0);
      cnt[c + 1] = cnt[c] + (ok ? 1 : 0);
    }
    rowSum.set(sum, r * (W + 1));
    rowCnt.set(cnt, r * (W + 1));
  }
  // sum over columns [a, b] of row r, wrapping around in longitude
  const seg = (arr, r, a, b) => {
    const o = r * (W + 1);
    if (a < 0) return arr[o + W] - arr[o + W + a] + arr[o + b + 1];
    if (b >= W) return arr[o + W] - arr[o + a] + arr[o + b - W + 1];
    return arr[o + b + 1] - arr[o + a];
  };
  const out = new Float32Array(W * H);
  for (let row = 0; row < H; row++) {
    const lim = shapeOf(row);
    const n = (lim.length - 1) / 2;
    for (let col = 0; col < W; col++) {
      let s = 0; let wValid = 0; let wAll = 0;
      for (let d = -n; d <= n; d++) {
        const dc = lim[d + n];
        if (dc < 0) continue;
        const r = row + d;
        const w = COS_ROW[r];
        let rs; let rc; let len;
        if (2 * dc + 1 >= W) {
          const o = r * (W + 1);
          rs = rowSum[o + W]; rc = rowCnt[o + W]; len = W;
        } else {
          rs = seg(rowSum, r, col - dc, col + dc);
          rc = seg(rowCnt, r, col - dc, col + dc);
          len = 2 * dc + 1;
        }
        s += w * rs; wValid += w * rc; wAll += w * len;
      }
      out[row * W + col] = wValid >= 0.5 * wAll && wValid > 0 ? s / wValid : NaN;
    }
  }
  return out;
}

// Value below which a share q of the world's area lies (histogram over 0..1 codes)
function areaQuantiles(values, qs) {
  const BINS = 2048;
  const hist = new Float64Array(BINS);
  let total = 0;
  for (let r = 0; r < H; r++) {
    const w = COS_ROW[r];
    for (let c = 0; c < W; c++) {
      const v = values[r * W + c];
      if (v !== v) continue;
      hist[Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)))] += w;
      total += w;
    }
  }
  return qs.map((q) => {
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      acc += hist[b];
      if (acc >= q * total) return (b + 0.5) / BINS;
    }
    return 1;
  });
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/**
 * Find the spots most like a site.
 *   body: 'mars' | 'moon'; sphereKm: its radius; layers: {layer: meta} (from index.json)
 *   weights: {layer: weight}; site: {lat, lon}; radiusKm: circle radius; count: 1-10
 *   onProgress(text): optional status updates
 * Resolves to { results: [{lat, lon, km, score, values}], site: {layer: value}, used, skipped }
 * with values in the layers' own units.
 */
export async function findSimilar({ body, sphereKm, layers, weights, site, radiusKm, count = DEFAULT_COUNT, onProgress }) {
  const wanted = Object.keys(weights).filter((k) => weights[k] > 0 && layers[k]);
  onProgress?.('Loading the map data…');
  const raw = await Promise.all(wanted.map((k) => layerGrid(body, k, layers[k])));

  const shapeOf = circleShape(radiusKm / sphereKm);
  const siteRow = Math.min(H - 1, Math.max(0, Math.floor((90 - site.lat) / RES)));
  const siteCol = ((Math.floor((site.lon + 180) / RES) % W) + W) % W;
  const siteIdx = siteRow * W + siteCol;

  const used = [];
  const skipped = [];
  const means = {};
  const spreads = {};
  const siteT = {};
  for (let i = 0; i < wanted.length; i++) {
    const k = wanted[i];
    onProgress?.(`Comparing every area of the surface… (${i + 1}/${wanted.length})`);
    await nextFrame(); // let the status message show
    const m = circleMeans(raw[i], shapeOf);
    const v = m[siteIdx];
    if (!Number.isFinite(v)) { skipped.push(k); continue; } // no data at the site
    const [p5, p95] = areaQuantiles(m, [0.05, 0.95]);
    used.push(k);
    means[k] = m;
    spreads[k] = Math.max(1e-3, p95 - p5);
    siteT[k] = v;
  }
  if (!used.length) return { results: [], site: {}, used, skipped };

  onProgress?.('Ranking…');
  await nextFrame();
  const totalW = used.reduce((a, k) => a + weights[k], 0);
  const scores = new Float32Array(W * H).fill(Infinity);
  const sinS = Math.sin(rad(site.lat));
  const cosS = Math.cos(rad(site.lat));
  const minAngle = MIN_DISTANCE_KM / sphereKm;
  const cosMin = Math.cos(minAngle);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const j = r * W + c;
      // too close to the site?
      const cosD = sinS * SIN_ROW[r] + cosS * COS_ROW[r] * Math.cos(rad(colLon(c) - site.lon));
      if (cosD > cosMin) continue;
      let s = 0;
      let ok = true;
      for (const k of used) {
        const v = means[k][j];
        if (v !== v) { ok = false; break; }
        const d = (v - siteT[k]) / spreads[k];
        s += weights[k] * d * d;
      }
      if (ok) scores[j] = Math.sqrt(s / totalW);
    }
  }

  // best first; keep a spot only if it's far enough from every spot already kept
  const order = [];
  for (let j = 0; j < scores.length; j++) if (scores[j] !== Infinity) order.push(j);
  order.sort((a, b) => scores[a] - scores[b]);
  const toValue = (k, t) => decode(layers[k], 1 + t * 254);
  const results = [];
  for (const j of order) {
    const lat = rowLat(Math.floor(j / W));
    const lon = colLon(j % W);
    if (results.some((p) => distanceKm(sphereKm, p.lat, p.lon, lat, lon) < MIN_DISTANCE_KM)) continue;
    results.push({
      lat, lon, score: scores[j],
      km: distanceKm(sphereKm, site.lat, site.lon, lat, lon),
      values: Object.fromEntries(used.map((k) => [k, toValue(k, means[k][j])])),
    });
    if (results.length === count) break;
  }
  return {
    results,
    site: Object.fromEntries(used.map((k) => [k, toValue(k, siteT[k])])),
    used,
    skipped,
  };
}

// ---- Earth -> Moon / Mars: the places on a world most like given target values -------------

/** A value in a layer's units -> its 0..1 tile code scale (the inverse of decode). */
function encodeT(meta, v) {
  const lo = meta.enc_min ?? meta.min;
  const hi = meta.enc_max ?? meta.max;
  if (meta.log) return (Math.log10(Math.max(v, 1e-9)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return (v - lo) / (hi - lo);
}

/**
 * The spots on `body` most like a place elsewhere (an Earth site), compared like with like:
 * every spot's values are circle means of `radiusKm`, as in findSimilar.
 *   targets: {layer: { value, pct }}: the place's value in the layer's units, and its percentile
 *     (0..1, by area) on its own world. A value beyond anything on `body` (Earth is far warmer
 *     than Mars at night) is matched relatively: to `body`'s value at the same percentile.
 *     always: layers matched by value only (slope, relief).
 * Resolves to { results: [{lat, lon, score, values}], used, targets: {layer: value}, relative: {layer: pct} }.
 */
export async function findMatches({ body, sphereKm, layers, weights, targets, always = [], radiusKm, count = DEFAULT_COUNT, onProgress }) {
  const wanted = Object.keys(weights).filter((k) => weights[k] > 0 && layers[k] && targets[k] && Number.isFinite(targets[k].value));
  onProgress?.(`Loading the ${body === 'moon' ? 'Moon' : 'Mars'} data…`);
  const raw = await Promise.all(wanted.map((k) => layerGrid(body, k, layers[k])));
  const shapeOf = circleShape(radiusKm / sphereKm);
  const used = []; const means = {}; const spreads = {}; const goal = {}; const relative = {};
  for (let i = 0; i < wanted.length; i++) {
    const k = wanted[i];
    onProgress?.(`Comparing every area of the ${body === 'moon' ? 'Moon' : 'Mars'}… (${i + 1}/${wanted.length})`);
    await nextFrame();
    const m = circleMeans(raw[i], shapeOf);
    const [lo, p5, p95, hi] = areaQuantiles(m, [0.001, 0.05, 0.95, 0.999]);
    const t = encodeT(layers[k], targets[k].value);
    if (always.includes(k) || (t >= lo && t <= hi)) goal[k] = Math.min(1, Math.max(0, t));
    else {
      const pct = Math.min(1, Math.max(0, targets[k].pct ?? (t < lo ? 0 : 1)));
      [goal[k]] = areaQuantiles(m, [Math.min(0.999, Math.max(0.001, pct))]);
      relative[k] = pct;
    }
    used.push(k); means[k] = m; spreads[k] = Math.max(1e-3, p95 - p5);
  }
  if (!used.length) return { results: [], used, targets: {}, relative };
  onProgress?.('Ranking…');
  await nextFrame();
  const totalW = used.reduce((a, k) => a + weights[k], 0);
  const scores = new Float32Array(W * H).fill(Infinity);
  for (let j = 0; j < W * H; j++) {
    let s = 0; let ok = true;
    for (const k of used) {
      const v = means[k][j];
      if (v !== v) { ok = false; break; }
      const d = (v - goal[k]) / spreads[k];
      s += weights[k] * d * d;
    }
    if (ok) scores[j] = Math.sqrt(s / totalW);
  }
  const order = [];
  for (let j = 0; j < scores.length; j++) if (scores[j] !== Infinity) order.push(j);
  order.sort((a, b) => scores[a] - scores[b]);
  const toValue = (k, t) => decode(layers[k], 1 + t * 254);
  const results = [];
  for (const j of order) {
    const lat = rowLat(Math.floor(j / W));
    const lon = colLon(j % W);
    if (results.some((p) => distanceKm(sphereKm, p.lat, p.lon, lat, lon) < MIN_DISTANCE_KM)) continue;
    results.push({ lat, lon, score: scores[j], values: Object.fromEntries(used.map((k) => [k, toValue(k, means[k][j])])) });
    if (results.length === count) break;
  }
  return { results, used, targets: Object.fromEntries(used.map((k) => [k, toValue(k, goal[k])])), relative };
}
