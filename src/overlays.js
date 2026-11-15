// Coloured data overlays (elevation, slope, temperature, ...) drawn over a map.
//
// The data comes as 8-bit tiles made by tools/build_layers.py: grey value 1..255 =
// position between enc_min and enc_max (linear or log, see public/overlays/index.json);
// alpha = where there is data (Earth's oceans are transparent). The browser turns the
// values into colours: low = blue, high = red (or the reverse, e.g. for dryness).
import L from 'leaflet';
import { warpTile, sourceGrid } from './reproject.js';

const BASE = `${import.meta.env.BASE_URL}overlays`;
export const OVERLAY_OPACITY = 0.6;

// The views, in menu order. Each body's own description (data source,
// resolution) comes from public/overlays/index.json.
// `short` is the label on the menu button; `name` is used in the legend and tooltip.
export const VIEWS = {
  elevation: { name: 'Elevation', short: 'Elevation' },
  slope: { name: 'Terrain slope', short: 'Slope' },
  surface: { name: 'Dusty or rocky terrain', short: 'Dust / rock' },
  iron: { name: 'Minerals: iron content', short: 'Iron' },
  ice: { name: 'Underground ice', short: 'Underground ice' },
  temperature: { name: 'Average temperature', short: 'Avg. temperature' },
  temp_range: { name: 'Daily temperature variation', short: 'Daily temp. swing' },
  temp_yearly: { name: 'Yearly temperature range', short: 'Yearly temp. range' },
  temp_max: { name: 'Maximum temperature', short: 'Max. temperature' },
  temp_min: { name: 'Minimum temperature', short: 'Min. temperature' },
  dryness: { name: 'Dryness (yearly rainfall)', short: 'Dryness' },
  uv: { name: 'UV radiation', short: 'UV radiation' },
  sunlight: { name: 'Sunlight', short: 'Sunlight' },
};

let indexPromise = null;
export function loadIndex() {
  indexPromise ??= fetch(`${BASE}/index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return indexPromise;
}

// Colour palettes. Default: blue -> light grey -> red ("cool-warm"), easy to read over
// imagery. 'terrain': a relief-map palette for Earth's land elevation, so low land
// doesn't look like water: green lowlands -> yellow -> tan -> brown -> white peaks.
const PALETTES = {
  coolwarm: [
    [0.0, [49, 54, 149]], [0.15, [69, 117, 180]], [0.3, [116, 173, 209]], [0.45, [224, 243, 248]],
    [0.55, [254, 224, 144]], [0.7, [253, 174, 97]], [0.85, [244, 109, 67]], [1.0, [165, 0, 38]],
  ],
  // Moon / Mars elevation: relief colours like NASA's MOLA maps (deep blue low -> green ->
  // yellow -> orange -> red -> white peaks), so the map isn't mostly one colour.
  topo: [
    [0.0, [38, 26, 104]], [0.07, [42, 84, 186]], [0.15, [48, 160, 214]], [0.25, [62, 178, 128]],
    [0.4, [170, 206, 84]], [0.55, [240, 205, 70]], [0.7, [236, 140, 52]], [0.84, [196, 74, 48]],
    [0.93, [150, 104, 92]], [1.0, [248, 248, 248]],
  ],
  // Moon elevation: the same relief colours with a wider blue range, so the low maria and
  // basins read blue and only the highlands turn green, yellow and red.
  topoBlue: [
    [0.0, [30, 22, 96]], [0.18, [38, 70, 176]], [0.34, [46, 130, 212]], [0.46, [92, 186, 224]],
    [0.56, [86, 184, 140]], [0.66, [190, 210, 96]], [0.76, [240, 196, 72]], [0.86, [226, 120, 52]],
    [0.94, [176, 70, 52]], [1.0, [248, 248, 248]],
  ],
  terrain: [
    [0.0, [52, 128, 70]], [0.1, [104, 160, 82]], [0.25, [186, 196, 116]], [0.4, [226, 205, 140]],
    [0.55, [204, 158, 98]], [0.7, [163, 105, 64]], [0.85, [128, 86, 70]], [1.0, [245, 245, 245]],
  ],
};
const SUMMARY_PALETTE = [[0, [111, 66, 193]], [1, [255, 255, 255]]];
const stopsFor = (meta) => PALETTES[meta?.palette] ?? PALETTES.coolwarm;
function colourAt(t, stops = PALETTES.coolwarm) {
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return stops[stops.length - 1][1];
}
/** CSS gradient of a layer's colour palette (for legends and swatches). */
export const gradientCss = (meta) =>
  `linear-gradient(to right, ${stopsFor(meta).map(([t, c]) => `rgb(${c}) ${t * 100}%`).join(', ')})`;
export const GRADIENT_CSS = gradientCss(null);
export const SUMMARY_GRADIENT_CSS =
  `linear-gradient(to right, ${SUMMARY_PALETTE.map(([t, c]) => `rgb(${c}) ${t * 100}%`).join(', ')})`;

// Tile values 1..255 cover the layer's full data range (enc_min..enc_max, linear or
// log); 0 never occurs. decode() turns a tile value back into real units.
export function decode(meta, code) {
  const lo = meta.enc_min ?? meta.min;
  const hi = meta.enc_max ?? meta.max;
  const t = (code - 1) / 254;
  if (meta.log) return 10 ** (Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo)));
  return lo + t * (hi - lo);
}

// Lookup table per layer: tile value -> RGBA, using the layer's colour range (min..max).
// Entry 0 stays fully transparent (used to cut layers at their latitude limits).
const luts = new WeakMap();
function lutFor(meta) {
  if (!luts.has(meta)) {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let v = 1; v < 256; v++) {
      const t = colourPos(meta, decode(meta, v));
      lut.set([...colourAt(t, stopsFor(meta)), 255], v * 4);
    }
    luts.set(meta, lut);
  }
  return luts.get(meta);
}

// Decoded data tiles, shared between zoom levels (small cache).
const images = new Map();
// Tile servers (NASA Trek especially) sometimes fail or time out on a single tile: try
// again a few times, waiting a little longer each time. A failure is not remembered, so
// the next request for that tile tries afresh instead of leaving a permanent hole.
const RETRY_DELAYS_MS = [600, 1500, 4000];
function fetchImage(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => {
      if (attempt >= RETRY_DELAYS_MS.length) { reject(e); return; }
      setTimeout(() => fetchImage(url, attempt + 1).then(resolve, reject), RETRY_DELAYS_MS[attempt]);
    };
    img.src = url;
  });
}
export function loadImage(url) {
  if (!images.has(url)) {
    if (images.size > 400) images.delete(images.keys().next().value);
    const p = fetchImage(url);
    p.catch(() => { if (images.get(url) === p) images.delete(url); });
    images.set(url, p);
  }
  return images.get(url);
}

/** Make a Leaflet tile layer retry tiles that fail to load (same delays as loadImage). */
export function retryFailedTiles(layer) {
  layer.on('tileerror', ({ tile }) => {
    const tries = Number(tile.dataset.tries ?? 0);
    if (tries >= RETRY_DELAYS_MS.length) return;
    tile.dataset.tries = tries + 1;
    const src = tile.src;
    setTimeout(() => {
      if (!tile.isConnected) return; // scrolled away meanwhile
      tile.src = '';
      tile.src = src;
    }, RETRY_DELAYS_MS[tries]);
  });
  return layer;
}

const DataTiles = L.GridLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    // Past the data's own detail, take the matching part of a coarser tile and
    // enlarge it smoothly *before* colouring, so it doesn't turn into squares.
    const dz = Math.max(0, coords.z - this.options.nativeZoom);
    const n = 2 ** dz;
    const size = 256 / n;
    const src = `${this.options.url}/${coords.z - dz}/${Math.floor(coords.y / n)}/${Math.floor(coords.x / n)}.${this.options.format}`;
    loadImage(src).then((img) => {
      const ctx = tile.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (coords.x % n) * size, (coords.y % n) * size, size, size, 0, 0, 256, 256);
      const data = ctx.getImageData(0, 0, 256, 256);
      const px = data.data;
      // Layers covering only part of the globe are cut at a clean latitude line;
      // the tile's own alpha marks where there's no data at all (Earth's oceans).
      const { latMin, latMax, lut: LUT, mercator } = this.options;
      const rows = 256 * 2 ** coords.z;
      for (let r = 0; r < 256; r++) {
        const y = (coords.y * 256 + r + 0.5) / rows; // 0 = top of the map, 1 = bottom
        const lat = mercator ? (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI : 90 - y * 180;
        const inside = lat >= latMin && lat <= latMax;
        for (let i = r * 1024, end = i + 1024; i < end; i += 4) {
          const a = px[i + 3];
          const v = inside && a > 0 ? px[i] * 4 : 0; // LUT entry 0 is fully transparent
          px[i] = LUT[v]; px[i + 1] = LUT[v + 1]; px[i + 2] = LUT[v + 2];
          px[i + 3] = (LUT[v + 3] * a) / 255;
        }
      }
      ctx.putImageData(data, 0, 0);
      done(null, tile);
    }).catch(() => done(null, tile)); // missing tile: leave it transparent
    return tile;
  },
});

// Data tiles in a projection other than their own: warp the grey value tiles first,
// then colour them (our tiles are same-site, so their pixels can be read).
const WarpedData = L.GridLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    const ctx = tile.getContext('2d', { willReadFrequently: true });
    const { proj, src, latMin, latMax, lut: LUT } = this.options;
    warpTile(ctx, coords, proj, src, this.options).then((drawn) => {
      if (!drawn) { done(null, tile); return; }
      const data = ctx.getImageData(0, 0, 256, 256);
      const px = data.data;
      const nx = proj.world[0] * 2 ** coords.z;
      const ny = proj.world[1] * 2 ** coords.z;
      const clip = latMin > -90 || latMax < 90;
      for (let r = 0; r < 256; r++) {
        for (let c = 0; c < 256; c++) {
          const i = (r * 256 + c) * 4;
          const a = px[i + 3];
          let v = a > 0 ? px[i] * 4 : 0;
          if (v && clip) {
            const lat = proj.fromWorld((coords.x * 256 + c + 0.5) / nx, (coords.y * 256 + r + 0.5) / ny)[0];
            if (lat < latMin || lat > latMax) v = 0;
          }
          px[i] = LUT[v]; px[i + 1] = LUT[v + 1]; px[i + 2] = LUT[v + 2];
          px[i + 3] = (LUT[v + 3] * a) / 255;
        }
      }
      ctx.putImageData(data, 0, 0);
      done(null, tile);
    }, () => done(null, tile));
    return tile;
  },
});

/** A coloured data layer, shown in projection `proj` (see projections.js). */
export function createOverlay(body, view, meta, pane, proj) {
  const own = meta.crs === 'EPSG3857' ? 'mercator' : 'equirect';
  const common = {
    pane,
    opacity: OVERLAY_OPACITY,
    latMin: meta.lat_min ?? -90,
    latMax: meta.lat_max ?? 90,
    lut: lutFor(meta),
    maxZoom: 30,
    noWrap: true,
  };
  if (proj && proj.id !== own) {
    return new WarpedData({
      ...common,
      proj,
      radiusKm: { moon: 1737.4, mars: 3389.5, earth: 6371 }[body],
      src: sourceGrid({ kind: own, url: `${BASE}/${body}/${view}/{z}/{y}/{x}.${meta.format ?? 'png'}`, maxLevel: meta.max_zoom }),
    });
  }
  return new DataTiles({
    ...common,
    url: `${BASE}/${body}/${view}`,
    format: meta.format ?? 'png',
    nativeZoom: meta.max_zoom, // deepest level that has its own data tiles
    mercator: own === 'mercator',
    bounds: [[-90, -180], [90, 180]],
  });
}

// Tick values for the legend.
function ticks(meta) {
  const inner = [];
  if (meta.log) {
    for (let e = Math.floor(Math.log10(meta.min)); 10 ** e <= meta.max; e++) {
      inner.push(Number((10 ** e).toPrecision(2))); // powers of ten only, so labels don't crowd
    }
  } else {
    // linear: a "nice" step giving about 4 labels
    const span = meta.max - meta.min;
    const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((st) => span / st <= 4) ?? span;
    for (let v = Math.ceil(meta.min / step) * step; v <= meta.max + 1e-9; v += step) inner.push(Number(v.toPrecision(6)));
  }
  // Always label both ends (they carry the ≤ / + markers); drop in-between labels too close to them.
  const gap = 0.22;
  const middle = inner.filter((v) => position(meta, v) > gap && position(meta, v) < 1 - gap);
  return [meta.min, ...middle, meta.max];
}

// Where a value sits on the colour bar (0 = blue end, 1 = red end).
export function colourPos(meta, v) {
  const t = Math.min(1, Math.max(0, position(meta, v)));
  return meta.reverse ? 1 - t : t;
}

// Area summary swatches: one simple scale for every layer - blue = low, white = middle,
// red = high within the layer's colour range - whatever the layer's own map palette is
// (relief colours, reversed dryness, ...), so high and low read the same on every row.
export function levelColour(meta, v) {
  const t = Math.min(1, Math.max(0, position(meta, v)));
  return `rgb(${colourAt(t, PALETTES.coolwarm).join(',')})`;
}

export function position(meta, v) {
  if (meta.log) return (Math.log10(v) - Math.log10(meta.min)) / (Math.log10(meta.max) - Math.log10(meta.min));
  return (v - meta.min) / (meta.max - meta.min);
}

export function summaryColour(meta, v) {
  const raw = position(meta, v);
  const t = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
  return `rgb(${colourAt(t, SUMMARY_PALETTE)})`;
}

export function legendHtml(view, meta) {
  // Short symbols (°, %) stay on the numbers; longer units go once in the title.
  const inline = meta.unit === '°' || meta.unit === '%';
  const all = ticks(meta);
  const marks = all.map((v, i) => {
    // mark the ends of the scale when values beyond them are drawn in the end colour
    const above = meta.above_max ?? meta.log;
    const prefix = i === 0 && v === meta.min && meta.below_min ? '≤' : '';
    const suffix = i === all.length - 1 && v === meta.max && above ? '+' : '';
    const label = `${prefix}${v}${inline ? meta.unit : ''}${suffix}`;
    const pos = meta.reverse ? 1 - position(meta, v) : position(meta, v);
    // keep the end labels inside the bar instead of centred on its edge
    const align = pos < 0.06 ? 'start' : pos > 0.94 ? 'end' : '';
    return `<span class="${align}" style="left:${(pos * 100).toFixed(1)}%">${label}</span>`;
  }).join('');
  const unit = inline ? '' : ` <span class="legend-unit">(${meta.unit})</span>`;
  return `
    <div class="legend-title">${VIEWS[view].name}${unit}</div>
    <div class="legend-bar" style="background:${gradientCss(meta)}"></div>
    <div class="legend-ticks">${marks}</div>
    <div class="legend-note">${meta.log ? 'Logarithmic' : 'Linear'} scale · ~${meta.pixel_km >= 10 ? Math.round(meta.pixel_km) : meta.pixel_km} km pixels</div>`;
}
