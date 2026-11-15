// Terrain for the route engine in the browser (runs inside the Web Worker): reads the precise
// elevation blocks made by tools/build_route_grids.py (Mars: public/route/grid/ from MOLA;
// Moon: public/route/moon/grid/ from LRO LOLA) and the map's "Dusty or rocky terrain" and
// "Min. temperature" tiles for the secondary factors.
import { makeGrid } from './engine.js';

const BLOCK = 256;

/** Decode a WebP/PNG image into RGBA bytes, exactly (no colour management, no premultiplying). */
async function pixels(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

/**
 * The resolution ladder available in this build: [{ name, band, optional, window(s, n, w, e) }].
 * base: the app's base URL (import.meta.env.BASE_URL of the page).
 */
export const gridDir = (world) => (world === 'moon' ? 'route/moon/grid' : 'route/grid');
export async function createLevels(base, world = 'mars') {
  const dir = gridDir(world);
  const index = await fetch(`${base}${dir}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!index?.levels?.L0) return null; // precise grids not built
  const overlays = await fetch(`${base}overlays/index.json`).then((r) => r.json()).catch(() => ({}));
  const sec = secondary(base, overlays[world] ?? {}, world);
  const cache = new Map();
  const block = (name, br, bc) => {
    const key = `${name}/${br}_${bc}`;
    if (!cache.has(key)) {
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      cache.set(key, index.levels[name].blockSet.has(`${br}_${bc}`) ? pixels(`${base}${dir}/${key}.webp`).catch(() => null) : Promise.resolve(null));
    }
    return cache.get(key);
  };
  for (const L of Object.values(index.levels)) L.blockSet = new Set(L.blocks);

  const level = (name, band, optional) => {
    const info = index.levels[name];
    const ppd = info.ppd;
    const W = 360 * ppd;
    return {
      name, band, optional, ppd,
      async window(south, north, west, east) {
        const r0 = Math.max(0, Math.floor((90 - north) * ppd));
        const r1 = Math.min(180 * ppd - 1, Math.ceil((90 - south) * ppd));
        const c0 = Math.floor((west + 180) * ppd);
        const c1 = Math.ceil((east + 180) * ppd);
        const rows = r1 - r0 + 1; const cols = c1 - c0 + 1;
        // the blocks the window touches (columns wrap around the planet)
        const need = new Map();
        for (let br = Math.floor(r0 / BLOCK); br <= Math.floor(r1 / BLOCK); br++) {
          for (let bcu = Math.floor(c0 / BLOCK); bcu <= Math.floor(c1 / BLOCK); bcu++) {
            const bc = ((bcu % (W / BLOCK)) + W / BLOCK) % (W / BLOCK);
            need.set(`${br}_${bc}`, [br, Math.floor(bc)]);
          }
        }
        const got = new Map();
        await Promise.all([...need].map(async ([k, [br, bc]]) => got.set(k, await block(name, br, bc))));
        if (optional && [...got.values()].every((v) => !v)) return null; // no data here at this level
        const n = rows * cols;
        const elev = new Float32Array(n); const smax = new Float32Array(n); const valid = new Uint8Array(n);
        const offset = info.offset_m; const step = info.slope_step_deg;
        let any = false;
        for (let r = 0; r < rows; r++) {
          const gr = r0 + r; const br = Math.floor(gr / BLOCK); const rr = gr % BLOCK;
          for (let c = 0; c < cols; c++) {
            const gc = ((c0 + c) % W + W) % W; const bc = Math.floor(gc / BLOCK); const cc = gc % BLOCK;
            const px = got.get(`${br}_${bc}`);
            if (!px) continue;
            const o = (rr * BLOCK + cc) * 4;
            const code = (px[o] << 8) | px[o + 1];
            if (code === 0) continue; // outside the data
            const i = r * cols + c;
            elev[i] = code - offset;
            smax[i] = px[o + 2] * step;
            valid[i] = 1; any = true;
          }
        }
        if (optional && !any) return null;
        const north0 = 90 - r0 / ppd; const west0 = -180 + c0 / ppd;
        const g = makeGrid({ rows, cols, north: north0, west: west0, dDeg: 1 / ppd, elev, smax, valid, name });
        await sec.fill(g);
        return g;
      },
    };
  };
  const levels = [level('L0', null, false)];
  if (index.levels.L1) levels.push(level('L1', 30, false));
  if (index.levels.L2) levels.push(level('L2', 8, true));
  if (index.levels.L3) levels.push(level('L3', 1, true));
  levels.radiusKm = index.radius_km ?? 3389.5;
  return { levels, index };
}

// Secondary factors per cell, from the map's data tiles (8-bit is fine for these):
//   f_dust: rising as thermal inertia falls below ~150 TIU (deep fine dust)
//   f_rock: rising above ~600 TIU (boulder fields)
//   f_cold: rising as the coldest night falls below -90 C
// The Moon's thermal inertia (Diviner) only spans ~25-60 TIU and all its nights are far below
// -90 C, so there the ends of the Moon's own ranges are used (as in the planner): dust below
// ~34 TIU, rock above ~50 TIU, cold below -200 C (the permanently shadowed polar craters).
// No data (e.g. thermal inertia beyond 70 deg) -> 0.
const SECONDARY = {
  mars: { dustHi: 150, dustSpan: 100, rockLo: 600, rockSpan: 600, coldBelow: -90, coldSpan: 30 },
  moon: { dustHi: 34, dustSpan: 8, rockLo: 50, rockSpan: 20, coldBelow: -200, coldSpan: 30 },
};
function secondary(base, metas, world = 'mars') {
  const T = SECONDARY[world] ?? SECONDARY.mars;
  const tileCache = new Map();
  const sampler = async (layer, south, north, west, east) => {
    const meta = metas[layer];
    if (!meta) return () => NaN;
    const z = meta.max_zoom; const W = 512 * 2 ** z; const H = 256 * 2 ** z;
    const r0 = Math.max(0, Math.floor(((90 - north) / 180) * H)); const r1 = Math.min(H - 1, Math.floor(((90 - south) / 180) * H));
    const c0 = Math.floor(((west + 180) / 360) * W); const c1 = Math.floor(((east + 180) / 360) * W);
    const tiles = new Map();
    const jobs = [];
    for (let tr = r0 >> 8; tr <= r1 >> 8; tr++) {
      for (let tcu = c0 >> 8; tcu <= c1 >> 8; tcu++) {
        const tc = ((tcu % (W / 256)) + W / 256) % (W / 256);
        const key = `${layer}/${z}/${tr}/${tc}`;
        if (!tileCache.has(key)) tileCache.set(key, pixels(`${base}overlays/${world}/${key}.${meta.format}`).catch(() => null));
        jobs.push(tileCache.get(key).then((px) => tiles.set(`${tr}/${tc}`, px)));
      }
    }
    await Promise.all(jobs);
    const lo = meta.enc_min ?? meta.min; const hi = meta.enc_max ?? meta.max;
    const decode = (code) => {
      const t = (code - 1) / 254;
      return meta.log ? 10 ** (Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo))) : lo + t * (hi - lo);
    };
    const latLo = meta.lat_min ?? -90; const latHi = meta.lat_max ?? 90;
    return (lat, lon) => {
      if (lat < latLo || lat > latHi) return NaN;
      const row = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
      const col = ((Math.floor(((lon + 180) / 360) * W) % W) + W) % W;
      const px = tiles.get(`${row >> 8}/${col >> 8}`);
      if (!px) return NaN;
      const i = ((row & 255) * 256 + (col & 255)) * 4;
      return px[i + 3] >= 128 && px[i] > 0 ? decode(px[i]) : NaN;
    };
  };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  return {
    async fill(g) {
      const south = g.north - g.rows * g.dDeg; const east = g.west + g.cols * g.dDeg;
      const [ti, tmin] = await Promise.all([
        sampler('surface', south, g.north, g.west, east),
        sampler('temp_min', south, g.north, g.west, east),
      ]);
      const n = g.rows * g.cols;
      g.dust = new Float32Array(n); g.rock = new Float32Array(n); g.cold = new Float32Array(n);
      // the secondary layers are coarse (3-60 km): sample them on a coarser stride and fill in
      // (thermal inertia has ~11 px/deg at its most detailed: reuse a value across finer cells)
      const stride = Math.max(1, Math.floor(1 / (11 * g.dDeg)));
      for (let r = 0; r < g.rows; r++) {
        const lat = g.latOf(r);
        for (let c = 0; c < g.cols; c++) {
          const i = r * g.cols + c;
          if (c % stride && c > 0) { g.dust[i] = g.dust[i - 1]; g.rock[i] = g.rock[i - 1]; g.cold[i] = g.cold[i - 1]; continue; }
          const lon = ((((g.lonOf(c) + 180) % 360) + 360) % 360) - 180;
          const t = ti(lat, lon); const m = tmin(lat, lon);
          g.dust[i] = Number.isNaN(t) ? 0 : clamp01((T.dustHi - t) / T.dustSpan);
          g.rock[i] = Number.isNaN(t) ? 0 : clamp01((t - T.rockLo) / T.rockSpan);
          g.cold[i] = Number.isNaN(m) ? 0 : clamp01((T.coldBelow - m) / T.coldSpan);
        }
      }
    },
  };
}
