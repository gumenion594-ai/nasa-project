// Elevation for the 3D surface view. Heights are metres above the world's reference sphere
// (Moon), areoid (Mars) or sea level (Earth: see the Earth section at the end).
//
//  * Far: public/surface3d/<world>_8ppd.bin (8 px/degree; tools/build_far_dem.mjs), loaded once.
//  * Near / middle: the world's global DEM on the USGS Astrogeology server (worlds.js). These
//    files are uncompressed with one strip per image row, so a window is read with one small
//    HTTP range request per row - only the bytes needed, not whole rows.
import { fromUrl } from 'geotiff';

const PARALLEL = 6; // browsers open ~6 connections per server

/** A lat/lon grid: rows from north, columns from west; `get(lat, lon)` samples it bilinearly. */
function grid({ data, rows, cols, lat0, lon0, dLat, dLon, wrap }) {
  const get = (lat, lon) => {
    let x = (lon - lon0) / dLon - 0.5;
    const y = (lat0 - lat) / dLat - 0.5;
    if (wrap) x = ((x % cols) + cols) % cols;
    const c0 = Math.floor(x); const r0 = Math.floor(y);
    const fx = x - c0; const fy = y - r0;
    const at = (r, c) => {
      r = Math.min(rows - 1, Math.max(0, r));
      c = wrap ? ((c % cols) + cols) % cols : Math.min(cols - 1, Math.max(0, c));
      return data[r * cols + c];
    };
    return (at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx) * (1 - fy) +
      (at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx) * fy;
  };
  return { get, lat0, lon0, dLat, dLon, rows, cols };
}

/** Rejects if `p` hasn't settled within `ms`. */
function timeLimit(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms); })])
    .finally(() => clearTimeout(timer));
}
const flat = () => ({ get: () => 0 });

const farCache = new Map();
export function loadFar(world, lat, lon) {
  // Earth: no bundled file; coarse heights around the point (~1 km) from the AWS terrain tiles:
  // small PNGs that load in a second or two, so the landscape appears quickly (NASADEM's
  // big GeoTIFFs are used for the detailed rings, where they matter)
  if (!world.far) {
    return timeLimit(loadTerrarium(world, lat, lon, world.farHalf * 1.05, 960), 30000, 'terrain tiles')
      .catch(() => flat()); // offline: a flat plain rather than a black screen
  }
  if (!farCache.has(world.far)) {
    const p = (async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}surface3d/${world.far}`);
      if (!res.ok) throw new Error(`far DEM: HTTP ${res.status}`);
      const stream = res.body.pipeThrough(new DecompressionStream('deflate'));
      const delta = new Int16Array(await new Response(stream).arrayBuffer());
      const cols = 2880; const rows = 1440;
      const data = new Float32Array(cols * rows);
      for (let i = 0; i < data.length; i++) data[i] = i < cols ? delta[i] : data[i - cols] + delta[i];
      return grid({ data, rows, cols, lat0: 90, lon0: -180, dLat: 1 / 8, dLon: 1 / 8, wrap: true });
    })();
    p.catch(() => farCache.delete(world.far));
    farCache.set(world.far, p);
  }
  return farCache.get(world.far);
}

const stripCache = new Map();
function strips(url) {
  if (!stripCache.has(url)) {
    const p = fromUrl(url).then((t) => t.getImage(0)).then((img) => Float64Array.from(img.fileDirectory.StripOffsets, Number));
    p.catch(() => stripCache.delete(url));
    stripCache.set(url, p);
  }
  return stripCache.get(url);
}

/**
 * Heights around (lat, lon) from the world's detailed DEM: a square of ±halfM metres (at
 * least), keeping every `step`-th row and column. `onRow(done, total)` reports progress.
 */
export async function loadDetail(world, lat, lon, halfM, step, onRow) {
  if (world.dem.source === 'nasadem') return loadNasadem(world, lat, lon, halfM, step, onRow); // (time limit and fallback inside)
  const { url, width: DW, height: DH, scale } = world.dem;
  const offsets = await strips(url);
  const ppd = DW / 360; // square pixels: DH = DW / 2
  const halfLat = (halfM / world.radius) * (180 / Math.PI) * 1.05;
  const cosLat = Math.cos(((Math.min(89.9, Math.abs(lat) + halfLat)) * Math.PI) / 180);
  const halfLon = Math.min(180, halfLat / Math.max(cosLat, 1e-3));
  const r0 = Math.max(0, Math.floor((90 - lat - halfLat) * ppd));
  const r1 = Math.min(DH - 1, Math.ceil((90 - lat + halfLat) * ppd));
  // columns: one span, possibly wrapping around 180°
  let c0 = Math.floor((lon - halfLon + 180) * ppd);
  let c1 = Math.ceil((lon + halfLon + 180) * ppd);
  if (c1 - c0 >= DW) { c0 = 0; c1 = DW - 1; }
  c0 -= ((c0 % step) + step) % step; // keep columns on a common step grid
  const rowIdx = [];
  for (let r = r0 - (r0 % step); r <= r1; r += step) rowIdx.push(r);
  const nCols = Math.floor((c1 - c0) / step) + 1;
  const data = new Float32Array(rowIdx.length * nCols);

  // byte ranges of one row: [start, end, position in row], split where the span wraps around
  const spans = [];
  const a = ((c0 % DW) + DW) % DW;
  const len = nCols * step - (step - 1);
  if (a + len <= DW) spans.push([a, a + len - 1, 0]);
  else { spans.push([a, DW - 1, 0]); spans.push([0, a + len - 1 - DW, DW - a]); }

  let next = 0; let done = 0;
  const readRow = async (i) => {
    const r = rowIdx[i];
    const row = new Int16Array(len);
    for (const [s, e, at] of spans) {
      const from = offsets[r] + s * 2;
      row.set(new Int16Array(await fetchRange(url, from, from + (e - s + 1) * 2 - 1)), at);
    }
    for (let k = 0; k < nCols; k++) {
      const v = row[k * step];
      data[i * nCols + k] = v === -32768 ? NaN : v * scale;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < rowIdx.length) {
      const i = next++;
      await readRow(i);
      onRow?.(++done, rowIdx.length);
    }
  }));
  fillGaps(data, nCols);
  // grid() puts cell i's centre at edge + (i + 0.5) * d; pixel k's centre is at (k + 0.5) / ppd
  const d = step / ppd;
  const shift = (0.5 - 0.5 * step) / ppd;
  return grid({ data, rows: rowIdx.length, cols: nCols, lat0: 90 - rowIdx[0] / ppd - shift,
    lon0: c0 / ppd + shift - 180, dLat: d, dLon: d, wrap: false });
}

// "No data" pixels (rare): take the nearest value along the row, else 0
function fillGaps(data, cols) {
  if (!data.some(Number.isNaN)) return;
  for (let r = 0; r < data.length / cols; r++) {
    let last = NaN;
    for (let c = 0; c < cols; c++) { const k = r * cols + c; if (Number.isNaN(data[k])) data[k] = last; else last = data[k]; }
    last = NaN;
    for (let c = cols - 1; c >= 0; c--) { const k = r * cols + c; if (Number.isNaN(data[k])) data[k] = last; else last = data[k]; }
  }
  for (let k = 0; k < data.length; k++) if (Number.isNaN(data[k])) data[k] = 0;
}

async function fetchRange(url, from, to, tries = 3) {
  for (let k = 0; ; k++) {
    try {
      // no-store: Chrome otherwise queues requests for the same URL behind its cache lock,
      // one at a time (~4x slower)
      const res = await fetch(url, { cache: 'no-store', headers: { Range: `bytes=${from}-${to}` } });
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (k >= tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** k));
    }
  }
}

// ---- ground colours from a map mosaic (Mars: Viking colour) ---------------------------------

const tileCanvas = document.createElement('canvas');
tileCanvas.width = tileCanvas.height = 256;
const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true });

function loadTile(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      tileCtx.clearRect(0, 0, 256, 256);
      tileCtx.drawImage(img, 0, 0);
      resolve(tileCtx.getImageData(0, 0, 256, 256).data);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Colour sampler (lat, lon) -> [r, g, b] 0..1 over a box of ±halfM around (lat, lon), from the
 * equirectangular tile set at the zoom level where a pixel is about `pxM` metres.
 */
export async function loadColours(world, lat, lon, halfM, pxM) {
  const im = world.imagery;
  const circ = 2 * Math.PI * world.radius;
  let z = Math.round(Math.log2(circ / (512 * pxM)));
  z = Math.max(0, Math.min(im.maxZoom, z));
  const W = 512 * 2 ** z; const H = 256 * 2 ** z;
  const ppd = W / 360;
  const halfLat = (halfM / world.radius) * (180 / Math.PI) * 1.05;
  const cosLat = Math.cos(((Math.min(89, Math.abs(lat) + halfLat)) * Math.PI) / 180);
  const halfLon = Math.min(180, halfLat / Math.max(cosLat, 0.02));
  const ty0 = Math.max(0, Math.floor(((90 - lat - halfLat) * ppd) / 256));
  const ty1 = Math.min(H / 256 - 1, Math.floor(((90 - lat + halfLat) * ppd) / 256));
  const tx0 = Math.floor(((lon - halfLon + 180) * ppd) / 256);
  const tx1 = Math.floor(((lon + halfLon + 180) * ppd) / 256);
  const nx = W / 256;
  const tiles = new Map();
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= Math.min(tx1, tx0 + nx - 1); tx++) {
      const x = ((tx % nx) + nx) % nx;
      const url = im.url.replace('{z}', z).replace('{y}', ty).replace('{x}', x);
      jobs.push(loadTile(url).then((d) => tiles.set(`${ty}/${x}`, d)));
    }
  }
  await Promise.all(jobs);
  const px = (row, col) => {
    row = Math.min(H - 1, Math.max(0, row));
    col = ((col % W) + W) % W;
    const d = tiles.get(`${Math.floor(row / 256)}/${Math.floor(col / 256)}`);
    if (!d) return null;
    const i = ((row % 256) * 256 + (col % 256)) * 4;
    return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
  };
  return (la, lo) => {
    const y = (90 - la) * ppd - 0.5; const x = (lo + 180) * ppd - 0.5;
    const r = Math.floor(y); const c = Math.floor(x); const fy = y - r; const fx = x - c;
    const a = px(r, c); const b = px(r, c + 1); const cc = px(r + 1, c); const d = px(r + 1, c + 1);
    if (!a || !b || !cc || !d) return a ?? b ?? cc ?? d;
    return [0, 1, 2].map((k) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (cc[k] * (1 - fx) + d[k] * fx) * fy);
  };
}

// ---- Earth ----------------------------------------------------------------------------------
//
//  * Detailed heights: NASA NASADEM (the Space Shuttle radar mission SRTM, reprocessed), 1 arc
//    second (~30 m), 60° N to 56° S, one cloud-optimised GeoTIFF per 1° x 1° tile on Microsoft
//    Planetary Computer. Reading needs a free anonymous access token (a URL query string).
//    No file = no land in that tile (sea level).
//    (Planetary Computer's copy lacks a few tiles, e.g. on the 180° meridian in Fiji: shown as sea.)
//  * Outside NASADEM (the polar regions): AWS Terrain Tiles ("terrarium" PNGs, web-Mercator;
//    SRTM and other sources), height = R * 256 + G + B / 256 - 32768.
//  * Ground: Esri World Imagery tiles, turned into one texture per terrain level.

const NASADEM = 'https://nasademeuwest.blob.core.windows.net/nasadem-cog/v001/';
const NASADEM_TOKEN = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/nasadem';
const NASADEM_LAT = [-56, 60];
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

let token = null; // { query, until }
async function nasademToken() {
  if (token && token.until > Date.now() + 5 * 60e3) return token.query;
  const res = await fetch(NASADEM_TOKEN);
  if (!res.ok) throw new Error(`NASADEM token: HTTP ${res.status}`);
  const j = await res.json();
  token = { query: j.token, until: Date.parse(j['msft:expiry']) || Date.now() + 30 * 60e3 };
  return token.query;
}

const tifCache = new Map(); // tile name + token -> Promise<GeoTIFF | null> (null: no file = sea)
function nasademTile(name, query) {
  const key = `${name}?${query}`;
  if (!tifCache.has(key)) {
    const p = (async () => {
      const url = `${NASADEM}${name}?${query}`;
      // a missing tile is sea: check with one tiny request before opening it
      const head = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      if (head.status === 404) return null;
      if (!head.ok) throw new Error(`NASADEM ${name}: HTTP ${head.status}`);
      return fromUrl(url);
    })();
    p.catch(() => tifCache.delete(key));
    tifCache.set(key, p);
  }
  return tifCache.get(key);
}
const tileName = (s, w) => `NASADEM_HGT_${s < 0 ? 's' : 'n'}${String(Math.abs(s)).padStart(2, '0')}` +
  `${w < 0 ? 'w' : 'e'}${String(Math.abs(w)).padStart(3, '0')}.tif`;

/** Lat/lon box of ±halfM metres around a point. */
function box(R, lat, lon, halfM) {
  const halfLat = (halfM / R) * (180 / Math.PI) * 1.05;
  const cosLat = Math.cos(((Math.min(89.9, Math.abs(lat) + halfLat)) * Math.PI) / 180);
  const halfLon = Math.min(179, halfLat / Math.max(cosLat, 1e-3));
  return { s: Math.max(-89.9, lat - halfLat), n: Math.min(89.9, lat + halfLat), w: lon - halfLon, e: lon + halfLon };
}

/**
 * Earth heights (m above sea level) around (lat, lon) from NASADEM, every `step`-th arc second;
 * outside its coverage from the AWS terrain tiles. `onTile(done, total)` reports progress.
 */
async function loadNasadem(world, lat, lon, halfM, step, onTile) {
  const b = box(world.radius, lat, lon, halfM);
  if (b.s < NASADEM_LAT[0] || b.n > NASADEM_LAT[1]) return loadTerrarium(world, lat, lon, halfM, 30 * step);
  // NASADEM can fail (the shared access token expiring mid-read, a slow or unreachable server):
  // retry once with a fresh token, then fall back to the AWS terrain tiles (SRTM-based, ~30 m+)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await withTimeout(readNasadem(world, b, step, onTile), NASADEM_TIMEOUT_MS);
    } catch (err) {
      console.warn(`NASADEM (attempt ${attempt + 1}):`, err);
      token = null;
      tifCache.clear();
    }
  }
  const g = await loadTerrarium(world, lat, lon, halfM, 30 * step);
  return { ...g, source: 'terrarium' };
}

const NASADEM_TIMEOUT_MS = 40000;
const withTimeout = (promise, ms) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms))]);

async function readNasadem(world, b, step, onTile) {
  const query = await nasademToken();
  // the overview (full, 1/2, 1/4, 1/8 resolution) that is just fine enough for the step
  const level = Math.min(3, Math.max(0, Math.floor(Math.log2(step))));
  const tiles = [];
  for (let s = Math.floor(b.s); s < b.n; s++) {
    // w0: the tile's west edge as used in the box (may run past ±180); w: its real longitude
    for (let w0 = Math.floor(b.w); w0 < b.e; w0++) tiles.push({ s, w0, w: ((w0 + 180) % 360 + 360) % 360 - 180 });
  }
  let done = 0;
  await Promise.all(tiles.map(async (t) => {
    const tif = await nasademTile(tileName(t.s, t.w), query);
    if (tif) {
      const img = await tif.getImage(Math.min(level, (await tif.getImageCount()) - 1));
      const W = img.getWidth(); const H = img.getHeight();
      const k = W - 1; // pixels per degree; pixel centres run from edge to edge (SRTM layout)
      const c0 = Math.max(0, Math.floor((b.w - t.w0) * k) - 1); const c1 = Math.min(W - 1, Math.ceil((b.e - t.w0) * k) + 1);
      const r0 = Math.max(0, Math.floor((t.s + 1 - b.n) * k) - 1); const r1 = Math.min(H - 1, Math.ceil((t.s + 1 - b.s) * k) + 1);
      if (c1 >= c0 && r1 >= r0) {
        const [data] = await img.readRasters({ window: [c0, r0, c1 + 1, r1 + 1] });
        Object.assign(t, { data, k, c0, r0, cols: c1 - c0 + 1, rows: r1 - r0 + 1 });
      }
    }
    onTile?.(++done, tiles.length);
  }));

  // resample onto one regular grid (rows from north)
  const d = step / 3600;
  const lat0 = Math.ceil(b.n / d) * d; const lon0 = Math.floor(b.w / d) * d;
  const rows = Math.ceil((lat0 - b.s) / d) + 1; const cols = Math.ceil((b.e - lon0) / d) + 1;
  const out = new Float32Array(rows * cols);
  const byKey = new Map(tiles.map((t) => [`${t.s}/${t.w0}`, t]));
  for (let r = 0; r < rows; r++) {
    const la = lat0 - r * d;
    for (let c = 0; c < cols; c++) {
      const lo = lon0 + c * d;
      const t = byKey.get(`${Math.floor(la)}/${Math.floor(lo)}`);
      let v = 0; // no tile: sea level
      if (t?.data) {
        const x = Math.min(t.cols - 1.001, Math.max(0, (lo - t.w0) * t.k - t.c0));
        const y = Math.min(t.rows - 1.001, Math.max(0, (t.s + 1 - la) * t.k - t.r0));
        const i = Math.floor(x); const j = Math.floor(y); const fx = x - i; const fy = y - j;
        const at = (jj, ii) => { const h = t.data[jj * t.cols + ii]; return h === -32768 ? NaN : h; };
        v = (at(j, i) * (1 - fx) + at(j, i + 1) * fx) * (1 - fy) + (at(j + 1, i) * (1 - fx) + at(j + 1, i + 1) * fx) * fy;
      }
      out[r * cols + c] = v;
    }
  }
  fillGaps(out, cols);
  // grid() puts cell i's centre at edge + (i + 0.5) * d; sample r, c sits at lat0 - r d, lon0 + c d
  const g = grid({ data: out, rows, cols, lat0: lat0 + d / 2, lon0: lon0 - d / 2, dLat: d, dLon: d, wrap: false });
  // the box may run past ±180°: take each longitude as its copy east of the box's west edge
  const get = g.get;
  return { ...g, get: (la, lo) => get(la, b.w + ((((lo - b.w) % 360) + 360) % 360)) };
}

// ---- web-Mercator tile mosaics (terrain tiles, satellite images) ----

const mercY = (lat) => {
  const p = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2;
};
const mercCanvas = document.createElement('canvas');
mercCanvas.width = mercCanvas.height = 256;
const mercCtx = mercCanvas.getContext('2d', { willReadFrequently: true });
/** RGBA bytes of a 256 px tile image, unaltered (no colour management), or null if missing. */
async function tilePixels(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    mercCtx.clearRect(0, 0, 256, 256);
    mercCtx.drawImage(bmp, 0, 0, 256, 256);
    bmp.close();
    return mercCtx.getImageData(0, 0, 256, 256).data;
  } catch { return null; } // missing tiles come without CORS headers: a network error
}

/** Zoom level at which a tile pixel is about pxM metres, at latitude lat. */
function zoomFor(R, lat, pxM, maxZoom) {
  const z = Math.round(Math.log2((2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)) / (256 * pxM)));
  return Math.max(0, Math.min(maxZoom, z));
}

/**
 * The tiles covering a ±halfM box, as one RGBA mosaic. A missing tile is filled from the
 * next coarser one that exists (up to `back` levels), else left transparent.
 * Returns { z, n (tiles across the world), X0, Y0 (pixel origin, world pixels at z), W, H, rgba }.
 */
async function mosaic(template, R, lat, lon, halfM, pxM, maxZoom, back = 0, maxTiles = 144) {
  const b = box(R, lat, lon, halfM);
  let z = zoomFor(R, lat, pxM, maxZoom);
  const span = (zz) => {
    const n = 2 ** zz;
    return { tx0: Math.floor(((b.w + 180) / 360) * n), tx1: Math.floor(((b.e + 180) / 360) * n),
      ty0: Math.max(0, Math.floor(mercY(b.n) * n)), ty1: Math.min(n - 1, Math.floor(mercY(b.s) * n)) };
  };
  let sp = span(z);
  while (z > 0 && (sp.tx1 - sp.tx0 + 1) * (sp.ty1 - sp.ty0 + 1) > maxTiles) sp = span(--z); // e.g. at most 12 x 12 tiles
  const nx = sp.tx1 - sp.tx0 + 1; const ny = sp.ty1 - sp.ty0 + 1;
  const W = nx * 256; const H = ny * 256;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const n = 2 ** z;
  const url = (zz, x, y) => {
    const nn = 2 ** zz;
    return template.replace('{z}', zz).replace('{x}', ((x % nn) + nn) % nn).replace('{y}', y);
  };
  const jobs = [];
  for (let ty = sp.ty0; ty <= sp.ty1; ty++) {
    for (let tx = sp.tx0; tx <= sp.tx1; tx++) {
      jobs.push(async () => {
        // this tile, or a coarser one containing it (enlarged)
        for (let k = 0; k <= back && z - k >= 0; k++) {
          const f = 2 ** k;
          const px = await tilePixels(url(z - k, Math.floor(tx / f), Math.floor(ty / f)));
          if (!px) continue;
          const ox = (((tx % f) + f) % f) * (256 / f); const oy = (ty % f) * (256 / f);
          for (let y = 0; y < 256; y++) {
            const dst = ((ty - sp.ty0) * 256 + y) * W * 4 + (tx - sp.tx0) * 256 * 4;
            if (k === 0) { rgba.set(px.subarray(y * 1024, y * 1024 + 1024), dst); continue; }
            const row = (oy + Math.floor(y / f)) * 256;
            for (let x = 0; x < 256; x++) {
              const s = (row + ox + Math.floor(x / f)) * 4;
              rgba.set(px.subarray(s, s + 4), dst + x * 4);
            }
          }
          return;
        }
      });
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < jobs.length) await jobs[next++](); }));
  return { z, n, X0: sp.tx0 * 256, Y0: sp.ty0 * 256, W, H, rgba };
}

/** (lat, lon) -> fractional [x, y] in a mosaic's pixels (pixel centres at whole numbers). */
function mosaicXY(m) {
  const size = 256 * m.n;
  return (lat, lon) => {
    let x = ((lon + 180) / 360) * size - m.X0 - 0.5;
    // across the 180° meridian: the copy of the longitude that falls in the mosaic
    if (x < -size / 2) x += size; else if (x > m.W + size / 2) x -= size;
    return [x, mercY(lat) * size - m.Y0 - 0.5];
  };
}

/** Earth heights from the AWS terrain tiles around (lat, lon), at about pxM metres. */
async function loadTerrarium(world, lat, lon, halfM, pxM) {
  const m = await mosaic(TERRARIUM, world.radius, lat, lon, halfM, pxM, 15, 4);
  const h = new Float32Array(m.W * m.H);
  for (let i = 0; i < h.length; i++) {
    const k = i * 4;
    // the tiles include the sea floor: below sea level counts as sea (these tiles are used only
    // for the polar regions, where land below sea level is rare)
    h[i] = m.rgba[k + 3] ? Math.max(0, m.rgba[k] * 256 + m.rgba[k + 1] + m.rgba[k + 2] / 256 - 32768) : 0;
  }
  const xy = mosaicXY(m);
  return {
    get(la, lo) {
      const [x0, y0] = xy(la, lo);
      const x = Math.min(m.W - 1.001, Math.max(0, x0)); const y = Math.min(m.H - 1.001, Math.max(0, y0));
      const i = Math.floor(x); const j = Math.floor(y); const fx = x - i; const fy = y - j;
      const k = j * m.W + i;
      return (h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fy) + (h[k + m.W] * (1 - fx) + h[k + m.W + 1] * fx) * fy;
    },
  };
}

/** Where Earth heights come from at a box of ±halfM around a point (for credits). */
export function earthDemSource(world, lat, lon, halfM) {
  const b = box(world.radius, lat, lon, halfM);
  return b.s < NASADEM_LAT[0] || b.n > NASADEM_LAT[1] ? 'terrarium' : 'nasadem';
}

/**
 * Satellite image of a lat/lon box (south..north, west..east; west may be < -180 or east > 180),
 * as W x H RGBA bytes with rows evenly spaced in latitude and columns in longitude (row 0 = north).
 * Used by the bird's-eye 3D terrain view (src/terrain3d/).
 */
export async function boxImage(world, south, north, west, east, W, H) {
  const im = world.imagery;
  const R = world.radius;
  const lat = (south + north) / 2; const lon = (west + east) / 2;
  const cos = Math.cos((lat * Math.PI) / 180);
  const halfM = Math.max(((north - south) / 2) * (Math.PI / 180) * R, ((east - west) / 2) * (Math.PI / 180) * R * cos);
  const pxM = ((east - west) * (Math.PI / 180) * R * cos) / W;
  const m = await mosaic(im.url, R, lat, lon, halfM, pxM, im.maxZoom, 5, 256); // up to 16 x 16 tiles
  const xy = mosaicXY(m);
  const out = new Uint8ClampedArray(W * H * 4);
  const { rgba } = m;
  // in a lat/lon box the mosaic column depends only on longitude and the row only on latitude
  const colX = new Float64Array(W); const rowY = new Float64Array(H);
  for (let c = 0; c < W; c++) {
    const lo = west + ((c + 0.5) / W) * (east - west);
    colX[c] = Math.min(m.W - 1.001, Math.max(0, xy(lat, ((((lo + 180) % 360) + 360) % 360) - 180)[0]));
  }
  for (let r = 0; r < H; r++) rowY[r] = Math.min(m.H - 1.001, Math.max(0, xy(north - ((r + 0.5) / H) * (north - south), lon)[1]));
  for (let r = 0; r < H; r++) {
    const j = Math.floor(rowY[r]); const ay = rowY[r] - j;
    for (let c = 0; c < W; c++) {
      const i = Math.floor(colX[c]); const ax = colX[c] - i;
      const k = (j * m.W + i) * 4; const o = (r * W + c) * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = (rgba[k + ch] * (1 - ax) + rgba[k + 4 + ch] * ax) * (1 - ay) +
          (rgba[k + m.W * 4 + ch] * (1 - ax) + rgba[k + m.W * 4 + 4 + ch] * ax) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Satellite image of the square ±half metres around the observer, in the local frame
 * (`proj`: local x east, y north -> [lat, lon]), as `size` x `size` RGBA bytes (row 0 = north).
 */
export async function groundImage(world, lat, lon, proj, half, size) {
  const im = world.imagery;
  const m = await mosaic(im.url, world.radius, lat, lon, half * 1.02, (2 * half) / size, im.maxZoom, 5);
  const xy = mosaicXY(m);
  const out = new Uint8ClampedArray(size * size * 4);
  const cell = (2 * half) / size;
  const { rgba, W, H } = m;
  for (let r = 0; r < size; r++) {
    const y = half - (r + 0.5) * cell;
    for (let c = 0; c < size; c++) {
      const [la, lo] = proj(-half + (c + 0.5) * cell, y);
      const [fx0, fy0] = xy(la, lo);
      const fx = Math.min(W - 1.001, Math.max(0, fx0)); const fy = Math.min(H - 1.001, Math.max(0, fy0));
      const i = Math.floor(fx); const j = Math.floor(fy); const ax = fx - i; const ay = fy - j;
      const k = (j * W + i) * 4; const o = (r * size + c) * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = (rgba[k + ch] * (1 - ax) + rgba[k + 4 + ch] * ax) * (1 - ay) +
          (rgba[k + W * 4 + ch] * (1 - ax) + rgba[k + W * 4 + 4 + ch] * ax) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
