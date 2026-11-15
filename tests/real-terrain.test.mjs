// Acceptance tests on real Mars terrain (NASA MOLA MEGDR 32 px/deg). Skipped unless the raw file
// is present: data/raw/megt90n000fb.img (132 MB, see tools/build_route_grids.py).
// The grids are built here in JS the same way the build script builds the WebP blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeGrid, findRoute, MODES, segmentOk, distToPolylineKm, haversineKm } from '../src/route/engine/engine.js';

const FILE = new URL('../data/raw/megt90n000fb.img', import.meta.url);
const have = fs.existsSync(FILE);
const RAD = Math.PI / 180; const R = 3389.5;

let dem = null; // Int16 elevation, rows from 90N, cols from 180W (rolled), 32 px/deg
function load() {
  if (dem) return dem;
  const buf = fs.readFileSync(FILE);
  const W = 11520; const H = 5760;
  dem = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const src = (r * W + c) * 2;
      const v = buf.readInt16BE(src);
      dem[r * W + ((c + W / 2) % W)] = v; // 0..360E -> 180W..180E
    }
  }
  return dem;
}

// steepest slope from each pixel to its 8 neighbours (like build_route_grids.py)
function slopeAt(r, c, ppd, get) {
  const pxKm = (2 * Math.PI * R) / (360 * ppd);
  const lat = 90 - (r + 0.5) / ppd;
  const dx = Math.max(Math.cos(lat * RAD), 0.01) * pxKm * 1000; const dy = pxKm * 1000;
  let s = 0; const e = get(r, c);
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const d = Math.hypot(dc * dx, dr * dy);
    s = Math.max(s, Math.atan(Math.abs(get(r + dr, c + dc) - e) / d) / RAD);
  }
  return s;
}

function level(name, f, band) {
  const ppd = 32 / f;
  return {
    name, band, ppd,
    window(south, north, west, east) {
      const D = load(); const W = 11520; const H = 5760;
      const get32 = (r, c) => D[Math.min(H - 1, Math.max(0, r)) * W + ((c % W) + W) % W];
      const r0 = Math.max(0, Math.floor((90 - north) * ppd)); const r1 = Math.min(180 * ppd - 1, Math.ceil((90 - south) * ppd));
      const c0 = Math.floor((west + 180) * ppd); const c1 = Math.ceil((east + 180) * ppd);
      const rows = r1 - r0 + 1; const cols = c1 - c0 + 1;
      const elev = new Float32Array(rows * cols); const smax = new Float32Array(rows * cols);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        let s = 0; let m = 0; let mx = 0;
        for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) {
          const R32 = (r0 + r) * f + y; const C32 = (c0 + c) * f + x;
          s += get32(R32, C32); m++;
          mx = Math.max(mx, slopeAt(R32, C32, 32, get32));
        }
        elev[r * cols + c] = s / m; smax[r * cols + c] = mx;
      }
      return makeGrid({ rows, cols, north: 90 - r0 / ppd, west: -180 + c0 / ppd, dDeg: 1 / ppd, elev, smax, name });
    },
  };
}
const ladder = () => [level('L0', 4, null), level('L1', 1, 30)];

test('Jezero: floor to rim through a gentle breach, not the steep wall', { skip: !have && 'needs data/raw/megt90n000fb.img' }, async () => {
  // Jezero crater floor (18.4N 77.6E) to the rim area to the north-west, where Perseverance climbed out
  const res = await findRoute({ lat: 18.44, lon: 77.45 }, { lat: 18.95, lon: 76.9 }, ladder(), { trace: true });
  assert.equal(res.status, 'ok');
  assert.ok(res.totals.max_slope_deg <= MODES.rover.maxSlope, `max slope ${res.totals.max_slope_deg}`);
  console.log('Jezero', res.totals, res.levels.map((l) => `${l.level} ${l.ms} ms`));
});

test('crossing Valles Marineris: a ramp, or foot-only / unavailable at 20 deg', { skip: !have && 'needs data/raw/megt90n000fb.img' }, async () => {
  const res = await findRoute({ lat: -3.5, lon: -75 }, { lat: -12, lon: -72 }, ladder());
  assert.ok(['ok', 'foot-only', 'unavailable'].includes(res.status));
  if (res.status !== 'unavailable') assert.ok(res.totals.max_slope_deg <= (res.mode === 'rover' ? 20 : 15) + 1e-6, `max ${res.totals.max_slope_deg}`);
  console.log('Valles', res.status, res.totals ?? res.blocked);
});

test('Gale -> Jezero (~3,700 km) completes, coarse to fine', { skip: !have && 'needs data/raw/megt90n000fb.img' }, async () => {
  const t0 = Date.now();
  const res = await findRoute({ lat: -4.59, lon: 137.44 }, { lat: 18.44, lon: 77.45 }, ladder(), { trace: true });
  const ms = Date.now() - t0;
  console.log('Gale->Jezero', res.status, res.totals, res.levels.map((l) => `${l.level} ${l.ms} ms`), `total ${ms} ms (Node, grids built from the raw file inside the timing)`);
  assert.ok(['ok', 'foot-only'].includes(res.status));
  const l1 = res.levels.find((l) => l.level === 'L1');
  if (l1?.line) for (const [la, lo] of l1.line) assert.ok(distToPolylineKm(la, lo, l1.prevLine) <= 2 * 30 + 2 || haversineKm(la, lo, -4.59, 137.44) < 5 || haversineKm(la, lo, 18.44, 77.45) < 5);
});
