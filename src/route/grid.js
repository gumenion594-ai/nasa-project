// Builds the terrain grid the route planner searches: a lat/lon box around the two
// points, cut into cells, each holding the real NASA values read from the same data
// tiles the map's views show (public/overlays), plus craters and (Mars) dust storms
// (public/route, made by tools/build_route_data.py; the Moon's craters in public/route/moon,
// made by tools/build_moon_route_data.mjs).
import { decode, loadIndex, loadImage } from '../overlays.js';

const BASE = import.meta.env.BASE_URL;
export const MARS_R = 3389.5;
export const MOON_R = 1737.4;
/** Mean radius (km) of the worlds the planner works on. */
export const EARTH_R = 6371.0;
export const RADIUS = { mars: MARS_R, moon: MOON_R, earth: EARTH_R };
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const MAX_CELLS = 220_000; // keeps a search under ~1 s on a laptop
export const MAX_LAT = 86;        // the equirectangular grid gets too distorted closer to a pole

export function haversineKm(lat1, lon1, lat2, lon2, R = MARS_R) {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// ---- Reading the data tiles ---------------------------------------------------

const canvas = document.createElement('canvas');
canvas.width = canvas.height = 256;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const tileCache = new Map();
function tilePixels(url) {
  if (!tileCache.has(url)) {
    if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(url, loadImage(url).then((img) => {
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, 256, 256).data;
    }).catch(() => null));
  }
  return tileCache.get(url);
}

const MERC_LAT = 85.0511;
/**
 * Reads one layer's values (in real units) at its most detailed tile level. Moon and Mars tiles
 * are equirectangular (2:1 levels); Earth's are Web Mercator (square levels, ocean transparent,
 * all-ocean tiles missing).
 */
export async function layerSampler(layer, meta, latMin, latMax, lonMin, lonMax, zoom = meta.max_zoom, world = 'mars') {
  const z = Math.min(meta.max_zoom, zoom); // a coarser level reads fewer tiles for big areas
  const merc = meta.crs === 'EPSG3857';
  const W = (merc ? 256 : 512) * 2 ** z;
  const H = 256 * 2 ** z;
  // fractional pixel row of a latitude
  const yOf = merc
    ? (lat) => {
      const p = rad(Math.max(-MERC_LAT, Math.min(MERC_LAT, lat)));
      return ((1 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / Math.PI) / 2) * H;
    }
    : (lat) => ((90 - lat) / 180) * H;
  const r0 = Math.max(0, Math.floor(yOf(latMax)));
  const r1 = Math.min(H - 1, Math.floor(yOf(latMin)));
  const c0 = Math.floor(((lonMin + 180) / 360) * W);
  const c1 = Math.floor(((lonMax + 180) / 360) * W);
  const tiles = new Map();
  const jobs = [];
  for (let tr = Math.floor(r0 / 256); tr <= Math.floor(r1 / 256); tr++) {
    for (let tc = Math.floor(c0 / 256); tc <= Math.floor(c1 / 256); tc++) {
      const col = ((tc % (W / 256)) + W / 256) % (W / 256);
      const key = `${tr}/${col}`;
      if (!tiles.has(key)) {
        tiles.set(key, null);
        jobs.push(tilePixels(`${BASE}overlays/${world}/${layer}/${z}/${key}.${meta.format}`).then((px) => tiles.set(key, px)));
      }
    }
  }
  await Promise.all(jobs);
  const lut = new Float32Array(256);
  for (let v = 1; v < 256; v++) lut[v] = decode(meta, v);
  const latLo = meta.lat_min ?? -90;
  const latHi = meta.lat_max ?? 90;
  return {
    pxDeg: 180 / H,
    /** value at a point, or NaN where there's no data */
    at(lat, lon) {
      if (lat < latLo || lat > latHi) return NaN;
      const row = Math.min(H - 1, Math.max(0, Math.floor(yOf(lat))));
      const col = ((Math.floor(((lon + 180) / 360) * W) % W) + W) % W;
      const px = tiles.get(`${row >> 8}/${col >> 8}`);
      if (!px) return NaN;
      const i = ((row & 255) * 256 + (col & 255)) * 4;
      return px[i + 3] >= 128 && px[i] > 0 ? lut[px[i]] : NaN;
    },
    /** value at a point, interpolated between the 4 nearest data pixels (NaN where none) */
    smooth(lat, lon) {
      if (lat < latLo || lat > latHi) return NaN;
      const fy = Math.min(H - 1, Math.max(0, yOf(lat) - 0.5));
      const fx = ((lon + 180) / 360) * W - 0.5;
      const r0 = Math.floor(fy); const c0 = Math.floor(fx);
      const ty = fy - r0; const tx = fx - c0;
      let sum = 0; let wsum = 0;
      for (let dy = 0; dy < 2; dy++) {
        const row = Math.min(H - 1, r0 + dy);
        for (let dx = 0; dx < 2; dx++) {
          const col = (((c0 + dx) % W) + W) % W;
          const px = tiles.get(`${row >> 8}/${col >> 8}`);
          if (!px) continue;
          const i = ((row & 255) * 256 + (col & 255)) * 4;
          if (px[i + 3] < 128 || px[i] === 0) continue;
          const w = (dy ? ty : 1 - ty) * (dx ? tx : 1 - tx);
          sum += lut[px[i]] * w; wsum += w;
        }
      }
      return wsum > 1e-6 ? sum / wsum : NaN;
    },
  };
}

// ---- Craters and dust storms ------------------------------------------------------

// Mars data in public/route/, the Moon's in public/route/moon/
const routeDir = (world) => (world === 'mars' ? `${BASE}route/` : `${BASE}route/${world}/`);
const routeIndex = new Map();
const loadRouteIndex = (world = 'mars') => {
  if (!routeIndex.has(world)) routeIndex.set(world, fetch(`${routeDir(world)}index.json`).then((r) => r.json()));
  return routeIndex.get(world);
};
const craterBlocks = new Map();
let stormsPromise = null;

/** Craters (Mars: Robbins & Hynek 2012; Moon: Robbins 2019) whose rims reach into the box. */
export async function cratersIn(latMin, latMax, lonMin, lonMax, world = 'mars') {
  const R = RADIUS[world];
  const index = await loadRouteIndex(world);
  const B = index.craters.block_deg;
  const found = [];
  const lonRanges = [];
  // the box may run past +/-180 (unwrapped longitudes): look in both copies
  for (const shift of [-360, 0, 360]) {
    const lo = Math.max(-180, lonMin + shift);
    const hi = Math.min(180, lonMax + shift);
    if (lo < hi) lonRanges.push([lo, hi, shift]);
  }
  // big craters' rims reach out of their own block: look one block further out
  const pad = 6; // degrees; Hellas-sized basins are handled by their rim test below
  const jobs = [];
  for (const [lo, hi, shift] of lonRanges) {
    for (let bl = Math.floor((latMin - pad + 90) / B) * B - 90; bl < latMax + pad; bl += B) {
      for (let bo = Math.floor((lo - pad + 180) / B) * B - 180; bo < hi + pad; bo += B) {
        const la = Math.max(-90, Math.min(90 - B, bl));
        const lo2 = ((bo + 180 + 360) % 360) - 180;
        const key = `${la}_${lo2}`;
        if (!index.craters.blocks[key]) continue;
        const url = `${routeDir(world)}craters/${key}.bin`;
        if (!craterBlocks.has(url)) {
          craterBlocks.set(url, fetch(url).then((r) => r.arrayBuffer()));
        }
        jobs.push(craterBlocks.get(url).then((buf) => ({ buf, shift, key })));
      }
    }
  }
  const seen = new Set();
  for (const { buf, shift, key } of await Promise.all(jobs)) {
    if (seen.has(`${key}${shift}`)) continue;
    seen.add(`${key}${shift}`);
    const v = new DataView(buf);
    for (let o = 0; o + 12 <= buf.byteLength; o += 12) {
      const lat = v.getInt16(o, true) / 100;
      const lon = v.getInt16(o + 2, true) / 100 - shift;
      const d = v.getUint16(o + 4, true) / 10;
      const rKm = d / 2;
      const dLat = deg((rKm * 1.3) / R);
      const dLon = dLat / Math.max(0.05, Math.cos(rad(lat)));
      if (lat + dLat < latMin || lat - dLat > latMax || lon + dLon < lonMin || lon - dLon > lonMax) continue;
      const depth = v.getUint16(o + 6, true);
      const rim = v.getUint16(o + 8, true);
      found.push({
        lat, lon, d,
        depthKm: depth === 65535 ? null : depth / 1000,
        rimKm: rim === 65535 ? null : rim / 1000,
        degradation: v.getUint8(o + 10) || null,
      });
    }
  }
  return found;
}

/** Share of mapped sols with a dust storm overhead, for one season (MDAD). */
export async function stormGrid(season) {
  stormsPromise ??= Promise.all([loadRouteIndex('mars'), fetch(`${BASE}route/storms.bin`).then((r) => r.arrayBuffer())]);
  const [index, buf] = await stormsPromise;
  const { rows, cols, cell_deg: cd, scale } = index.storms;
  const data = new Uint8Array(buf, season * rows * cols, rows * cols);
  return (lat, lon) => {
    const r = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / cd)));
    const c = Math.min(cols - 1, Math.max(0, Math.floor((wrapLon(lon) + 180) / cd)));
    return data[r * cols + c] / scale;
  };
}

// ---- The grid -----------------------------------------------------------------------

/**
 * Builds the search grid between a and b ({lat, lon}) on 'mars', 'moon' or 'earth'. Longitudes are
 * unwrapped so the box takes the short way round. Returns typed arrays, one value per cell.
 * (The Moon has no dust storms and no seasons: its storm values are all 0. Earth: see earthRelief.)
 */
export async function buildGrid(a, b, season, onProgress = () => {}, world = 'mars', { minCellKm = 0 } = {}) {
  const R = RADIUS[world];
  let lonB = b.lon;
  if (lonB - a.lon > 180) lonB -= 360;
  if (a.lon - lonB > 180) lonB += 360;
  const distKm = haversineKm(a.lat, a.lon, b.lat, lonB, R);
  // room to go round obstacles: a third of the distance on every side (at least 25 km)
  const marginKm = Math.max(25, distKm * 0.35);
  const mDeg = deg(marginKm / R);
  const latMin = Math.max(-MAX_LAT, Math.min(a.lat, b.lat) - mDeg);
  const latMax = Math.min(MAX_LAT, Math.max(a.lat, b.lat) + mDeg);
  const midLat = (latMin + latMax) / 2;
  const cosMid = Math.max(0.1, Math.cos(rad(midLat)));
  const lonPad = Math.min(170, mDeg / cosMid);
  const lonMin = Math.min(a.lon, lonB) - lonPad;
  const lonMax = Math.max(a.lon, lonB) + lonPad;

  const index = await loadIndex();
  const metas = index[world];
  // Cells: as fine as the slope data (~2.6 km per tile pixel at its top level), coarser
  // only when the box would hold too many cells.
  // (Earth's tiles are Web Mercator: square levels, pixels shrink towards the poles)
  const merc = metas.slope.crs === 'EPSG3857';
  const slopePxDeg = (merc ? 360 * cosMid : 180) / (256 * 2 ** metas.slope.max_zoom);
  const heightKm = rad(latMax - latMin) * R;
  const widthKm = rad(lonMax - lonMin) * R * cosMid;
  // (minCellKm: to compare two worlds at the same cell size)
  let cellKm = Math.max(rad(slopePxDeg) * R, Math.sqrt((heightKm * widthKm) / MAX_CELLS), minCellKm);
  const rows = Math.max(3, Math.ceil(heightKm / cellKm));
  const cols = Math.max(3, Math.ceil(widthKm / cellKm));
  cellKm = heightKm / rows;
  const dLat = (latMax - latMin) / rows;
  const dLon = (lonMax - lonMin) / cols;

  onProgress('Reading NASA terrain data…');
  const box = [latMin, latMax, lonMin, lonMax];
  // Earth has no relief, thermal-inertia, crater or dust-storm data: those stay empty (NaN / 0)
  // and the planner says so; Earth's relief is worked out below from its elevation.
  const none = { at: () => NaN, smooth: () => NaN };
  const [slope, elev, relief, surface, tmin, storm] = await Promise.all([
    ...['slope', 'elevation', 'relief', 'surface', 'temp_min'].map((k) => (metas[k] ? layerSampler(k, metas[k], ...box, undefined, world) : none)),
    world === 'mars' ? stormGrid(season) : () => 0,
  ]);

  const n = rows * cols;
  const g = {
    world, R, rows, cols, cellKm, latMin, latMax, lonMin, lonMax, dLat, dLon, distKm,
    elev: new Float32Array(n),      // km above the MOLA / LOLA datum (mean)
    slopeMax: new Float32Array(n),  // steepest 1.9 km slope inside the cell, degrees
    slopeMean: new Float32Array(n),
    relief: new Float32Array(n),    // km, terrain roughness (elevation spread in ~9 km blocks)
    ti: new Float32Array(n),        // thermal inertia (TIU): low = loose dust, high = rock
    tmin: new Float32Array(n),      // coldest night temperature, deg C (Mars: model; Moon: Diviner)
    storm: new Float32Array(n),     // share of sols with a dust storm overhead (MDAD; Moon: 0)
    crater: new Float32Array(n),    // 0..1 crater rim / wall hazard
    craterId: new Int32Array(n).fill(-1),
    valid: new Uint8Array(n),
  };
  // sample each cell on a small sub-grid of data pixels: up to 4 x 4
  const sub = Math.max(1, Math.min(4, Math.round(dLat / slopePxDeg)));
  for (let r = 0; r < rows; r++) {
    const lat0 = latMax - r * dLat;
    for (let c = 0; c < cols; c++) {
      const lon0 = lonMin + c * dLon;
      const i = r * cols + c;
      let sMax = 0; let sSum = 0; let eSum = 0; let k = 0;
      for (let y = 0; y < sub; y++) {
        const lat = lat0 - ((y + 0.5) / sub) * dLat;
        for (let x = 0; x < sub; x++) {
          const lon = wrapLon(lon0 + ((x + 0.5) / sub) * dLon);
          const s = slope.at(lat, lon);
          const e = elev.at(lat, lon);
          if (Number.isNaN(s) || Number.isNaN(e)) continue;
          if (s > sMax) sMax = s;
          sSum += s; eSum += e; k++;
        }
      }
      const latC = lat0 - dLat / 2;
      const lonC = wrapLon(lon0 + dLon / 2);
      if (k) {
        g.valid[i] = 1;
        g.slopeMax[i] = sMax;
        g.slopeMean[i] = sSum / k;
        g.elev[i] = eSum / k;
      }
      g.relief[i] = relief.at(latC, lonC);
      g.ti[i] = surface.at(latC, lonC);
      g.tmin[i] = tmin.at(latC, lonC);
      g.storm[i] = storm(latC, lonC);
    }
  }

  if (world === 'earth') earthRelief(g);

  onProgress(world === 'earth' ? 'Measuring the terrain…' : 'Mapping craters…');
  const craters = world === 'earth' ? [] : await cratersIn(latMin, latMax, lonMin, lonMax, world);
  markCraters(g, craters);
  g.craters = craters;
  return g;
}

/**
 * Earth's terrain roughness, the same measure as the Moon / Mars relief maps: the standard
 * deviation of elevation inside ~9.3 km blocks (5 x 5 pixels of ~1.9 km there). Here: the cells'
 * mean elevations (each ~2.5 km, from ETOPO 2022) in a block of cells ~9.3 km wide around each
 * cell. The tiles store Earth's height in ~34 m steps; averaging several pixels per cell keeps
 * that rounding mostly below 20 m, where the planner counts ground as smooth anyway.
 */
function earthRelief(g) {
  const half = Math.max(1, Math.round((9.3 / g.cellKm - 1) / 2)); // block of (2 half + 1) cells, closest to 9.3 km
  const { rows, cols, elev, valid } = g;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!valid[i]) { g.relief[i] = NaN; continue; }
      let s = 0; let s2 = 0; let k = 0;
      for (let y = Math.max(0, r - half); y <= Math.min(rows - 1, r + half); y++) {
        for (let x = Math.max(0, c - half); x <= Math.min(cols - 1, c + half); x++) {
          const j = y * cols + x;
          if (!valid[j]) continue;
          s += elev[j]; s2 += elev[j] * elev[j]; k++;
        }
      }
      g.relief[i] = k > 1 ? Math.sqrt(Math.max(0, s2 / k - (s / k) ** 2)) : NaN;
    }
  }
}

/**
 * Estimated depth when the catalog has none: fresh simple craters are ~1/5 as deep as wide.
 * Moon: Pike (1977) for fresh lunar craters, 0.196 D (simple, D < 15 km), else 1.044 D^0.301.
 */
export const craterDepthKm = (c, world = 'mars') => c.depthKm ?? (world === 'moon'
  ? (c.d < 15 ? 0.196 * c.d : 1.044 * c.d ** 0.301)
  : Math.min(0.2 * c.d, 1.5 + 0.02 * c.d));

// Crater hazard: the rim and inner wall (0.7-1.15 x the radius) are steep and rocky; small
// bowl-shaped craters are a hazard all the way across. Only craters at least half a cell
// wide are marked, smaller ones are invisible at this grid size anyway.
function markCraters(g, craters) {
  const minD = Math.max(1, g.cellKm * 0.5);
  // Moon: the catalog also lists the giant impact basins (Imbrium, Serenitatis, ... 300-2,500 km).
  // Their "rims" are broad mountain rings, hundreds of km across, not one wall: the slope data
  // already shows those mountains, so basins are not marked as crater rims.
  const maxD = g.world === 'moon' ? 300 : Infinity;
  craters.forEach((cr, idx) => {
    if (cr.d < minD || cr.d > maxD) return;
    const R = cr.d / 2;
    const depth = craterDepthKm(cr, g.world);
    const bowl = cr.d < 7; // simple craters: steep everywhere inside
    const hazard = Math.min(1, depth / 1.0) * (cr.degradation === 1 ? 0.6 : 1); // worn-down rims are gentler
    const outer = R * 1.15;
    const inner = bowl ? 0 : R * 0.7;
    const dLatC = deg(outer / g.R);
    const r0 = Math.max(0, Math.floor((g.latMax - (cr.lat + dLatC)) / g.dLat));
    const r1 = Math.min(g.rows - 1, Math.floor((g.latMax - (cr.lat - dLatC)) / g.dLat));
    for (let r = r0; r <= r1; r++) {
      const lat = g.latMax - (r + 0.5) * g.dLat;
      const cosL = Math.max(0.05, Math.cos(rad(lat)));
      const dLonC = dLatC / cosL;
      const c0 = Math.max(0, Math.floor((cr.lon - dLonC - g.lonMin) / g.dLon));
      const c1 = Math.min(g.cols - 1, Math.floor((cr.lon + dLonC - g.lonMin) / g.dLon));
      for (let c = c0; c <= c1; c++) {
        const lon = g.lonMin + (c + 0.5) * g.dLon;
        const dKm = haversineKm(lat, lon, cr.lat, cr.lon, g.R);
        if (dKm > outer + g.cellKm / 2 || dKm < inner - g.cellKm / 2) continue;
        const i = r * g.cols + c;
        if (hazard > g.crater[i]) { g.crater[i] = hazard; g.craterId[i] = idx; }
      }
    }
  });
}

/** Centre of a cell. */
export function cellLatLon(g, i) {
  const r = Math.floor(i / g.cols);
  const c = i % g.cols;
  return [g.latMax - (r + 0.5) * g.dLat, g.lonMin + (c + 0.5) * g.dLon];
}

/** Cell holding a point (longitude in the grid's unwrapped range). */
export function cellOf(g, lat, lon) {
  let l = lon;
  while (l < g.lonMin) l += 360;
  while (l > g.lonMax) l -= 360;
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor((g.latMax - lat) / g.dLat)));
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor((l - g.lonMin) / g.dLon)));
  return r * g.cols + c;
}
