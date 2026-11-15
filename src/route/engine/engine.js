// Mars route engine: a drivable / walkable, energy-efficient route from A to B.
//
// Pure code (no DOM, no fetch): runs in the Web Worker (search.worker.js) and in Node unit tests
// (tests/engine.test.mjs). Terrain comes in as "grids" (see makeGrid); where they come from is the
// caller's business (precise MOLA blocks in the app, synthetic terrain in the tests).
//
// The algorithm follows docs/route-algorithm.md (the "Route algorithm" issue):
//   1. modes and hard limits: rover (max slope 20 deg) then on foot (15 deg); else unavailable
//   3. cost of a step = d * m_cell + k_up * climb + k_down * descent   ("km of flat driving")
//      m_cell = 1 + min(0.25, w_dust f_dust + w_rock f_rock + w_cold f_cold)
//   4. coarse to fine: L0 whole window (3 corridors) -> L1 bands +-30 km -> L2 bands +-8 km
//      -> string-pull smoothing (+ optional Catmull-Rom), always re-checking the limits
//   6. output contract for the UI (status, mode, points, bounds, totals, segments, blocked, levels)

// Radius of the world searched (km): Mars by default; findRoute sets it from the levels
// (the Moon's precise grids say radius_km: 1737.4). One search runs at a time per worker.
export let R_KM = 3389.5;
export const setRadius = (km) => { R_KM = km; };
export const CAP = 0.25;
const RAD = Math.PI / 180;

export const MODES = {
  rover: { maxSlope: 20, maxCross: 20, kUp: 8, kDown: 1 },
  foot: { maxSlope: 15, maxCross: 15, kUp: 10, kDown: 1 },
};
export const DEFAULT_WEIGHTS = { dust: 1, rock: 1, cold: 0.5 };

// 16 neighbours: the 8 around a cell plus knight's moves (less zig-zag)
const MOVES = [
  [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2],
];

export function haversineKm(lat1, lon1, lat2, lon2) {
  const h = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- Grids --------------------------------------------------------------------------------

/**
 * A terrain grid over a lat/lon window. Row 0 is the northern edge; columns run east and may go
 * past 180 (unwrapped longitudes). Cells are dDeg x dDeg.
 *   elev  Float32Array, metres (precise)          smax  Float32Array, steepest slope inside (deg)
 *   dust / rock / cold  Float32Array 0..1 or null valid Uint8Array (1 = data)
 */
export function makeGrid({ rows, cols, north, west, dDeg, elev, smax, dust = null, rock = null, cold = null, valid = null, name = '' }) {
  const n = rows * cols;
  const g = { rows, cols, north, west, dDeg, elev, smax, dust, rock, cold, name };
  g.valid = valid ?? new Uint8Array(n).fill(1);
  g.latOf = (r) => north - (r + 0.5) * dDeg;
  g.lonOf = (c) => west + (c + 0.5) * dDeg;
  g.cellKm = dDeg * RAD * R_KM;
  // east-west and north-south spacing per row (km) and the elevation gradient (m per m)
  g.dx = new Float64Array(rows);
  for (let r = 0; r < rows; r++) g.dx[r] = g.cellKm * Math.max(0.01, Math.cos(g.latOf(r) * RAD));
  // exact great-circle length of every move from every row (the heuristic relies on it)
  g.stepKm = new Float64Array(rows * MOVES.length);
  for (let r = 0; r < rows; r++) {
    for (let m = 0; m < MOVES.length; m++) {
      const [dr, dc] = MOVES[m];
      const r2 = Math.min(rows - 1, Math.max(0, r + dr));
      g.stepKm[r * MOVES.length + m] = haversineKm(g.latOf(r), 0, g.latOf(r) - dr * dDeg, dc * dDeg) * (r2 === r + dr ? 1 : 1);
    }
  }
  g.gx = new Float32Array(n); g.gy = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const cl = Math.max(0, c - 1); const cr = Math.min(cols - 1, c + 1);
      const ru = Math.max(0, r - 1); const rd = Math.min(rows - 1, r + 1);
      g.gx[i] = (elev[r * cols + cr] - elev[r * cols + cl]) / (Math.max(1, cr - cl) * g.dx[r] * 1000); // east
      g.gy[i] = (elev[ru * cols + c] - elev[rd * cols + c]) / (Math.max(1, rd - ru) * g.cellKm * 1000); // north
    }
  }
  return g;
}

/** Cell index of a point (longitude unwrapped into the grid's range), or -1 outside. */
export function cellAt(g, lat, lon) {
  let l = lon;
  while (l < g.west) l += 360;
  while (l >= g.west + 360) l -= 360;
  const r = Math.floor((g.north - lat) / g.dDeg);
  const c = Math.floor((l - g.west) / g.dDeg);
  if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) return -1;
  return r * g.cols + c;
}

/** Elevation (m) at a point, bilinear between cell centres. */
export function elevAt(g, lat, lon) {
  let l = lon;
  while (l < g.west) l += 360;
  while (l >= g.west + 360) l -= 360;
  const fy = Math.min(g.rows - 1, Math.max(0, (g.north - lat) / g.dDeg - 0.5));
  const fx = Math.min(g.cols - 1, Math.max(0, (l - g.west) / g.dDeg - 0.5));
  const r0 = Math.floor(fy); const c0 = Math.floor(fx);
  const r1 = Math.min(g.rows - 1, r0 + 1); const c1 = Math.min(g.cols - 1, c0 + 1);
  const ty = fy - r0; const tx = fx - c0;
  const e = (r, c) => g.elev[r * g.cols + c];
  return (e(r0, c0) * (1 - tx) + e(r0, c1) * tx) * (1 - ty) + (e(r1, c0) * (1 - tx) + e(r1, c1) * tx) * ty;
}

/** m_cell for every cell: 1 + min(CAP, weighted secondary factors). */
export function cellMultipliers(g, weights = DEFAULT_WEIGHTS) {
  const n = g.rows * g.cols;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = (weights.dust ?? 0) * (g.dust ? g.dust[i] : 0)
      + (weights.rock ?? 0) * (g.rock ? g.rock[i] : 0)
      + (weights.cold ?? 0) * (g.cold ? g.cold[i] : 0);
    m[i] = 1 + Math.min(CAP, s);
  }
  return m;
}

// ---- Steps ---------------------------------------------------------------------------------

/**
 * One step from cell i (r, c) by (dr, dc). Returns null if it breaks a hard limit, else
 * { d, climb, descent, slope, cross } (km, m, m, deg, deg).
 */
function step(g, r, c, dr, dc, lim, m) {
  const r2 = r + dr; const c2 = c + dc;
  if (r2 < 0 || r2 >= g.rows || c2 < 0 || c2 >= g.cols) return null;
  const { cols } = g;
  const i = r * cols + c; const j = r2 * cols + c2;
  if (!g.valid[j] || g.smax[j] > lim.maxSlope || g.smax[i] > lim.maxSlope) return null;
  // knight's moves pass two in-between cells: they must be passable too
  if (Math.abs(dr) === 2 || Math.abs(dc) === 2) {
    const a = Math.abs(dr) === 2 ? (r + dr / 2) * cols + c : r * cols + c + dc / 2;
    const b = Math.abs(dr) === 2 ? (r + dr / 2) * cols + c2 : r2 * cols + c + dc / 2;
    if (!g.valid[a] || !g.valid[b] || g.smax[a] > lim.maxSlope || g.smax[b] > lim.maxSlope) return null;
  }
  const ex = dc * (g.dx[r] + g.dx[r2]) / 2;  // km east (direction only)
  const ny = -dr * g.cellKm;                  // km north
  const d = g.stepKm[r * MOVES.length + m];   // exact great-circle length
  const dz = g.elev[j] - g.elev[i];           // m
  const slope = Math.atan(Math.abs(dz) / (d * 1000)) / RAD;
  if (slope > lim.maxSlope) return null;
  // sideways slope: the terrain gradient across the direction of travel (average of both cells)
  const len = Math.hypot(ex, ny);
  const ux = ex / len; const uy = ny / len;
  const gx = (g.gx[i] + g.gx[j]) / 2; const gy = (g.gy[i] + g.gy[j]) / 2;
  const cross = Math.atan(Math.abs(-uy * gx + ux * gy)) / RAD;
  if (cross > lim.maxCross) return null;
  return { d, climb: Math.max(0, dz), descent: Math.max(0, -dz), slope, cross, j };
}

// ---- A* -------------------------------------------------------------------------------------

class Heap {
  constructor(cap = 1024) { this.idx = new Int32Array(cap); this.key = new Float64Array(cap); this.size = 0; }
  push(i, k) {
    if (this.size === this.idx.length) {
      const idx = new Int32Array(this.size * 2); idx.set(this.idx); this.idx = idx;
      const key = new Float64Array(this.size * 2); key.set(this.key); this.key = key;
    }
    let p = this.size++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q]; this.key[p] = this.key[q]; p = q;
    }
    this.idx[p] = i; this.key[p] = k;
  }
  pop() {
    const top = this.idx[0];
    const li = this.idx[--this.size]; const lk = this.key[this.size];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c]; p = c;
    }
    this.idx[p] = li; this.key[p] = lk;
    return top;
  }
}

/**
 * A* (or Dijkstra with heuristic: false) on one grid. Options:
 *   lim      { maxSlope, maxCross, kUp, kDown }
 *   mult     Float32Array m_cell (null = all 1)
 *   mask     Uint8Array, only cells with 1 may be used (null = all)
 *   penalty  Float32Array, extra cost multiplier per cell (corridor diversity; null = none)
 *   onProgress(fraction), shouldStop()
 * Returns { path: [cell...], cost, expanded } or { path: null, expanded }.
 */
export function astar(g, start, goal, lim, { mult = null, mask = null, penalty = null, heuristic = true, onProgress = null, shouldStop = null } = {}) {
  const n = g.rows * g.cols;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap(4096);
  const gr = Math.floor(goal / g.cols); const gc = goal % g.cols;
  const gLat = g.latOf(gr); const gLon = g.lonOf(gc); const gElev = g.elev[goal];
  const kUpKm = lim.kUp / 1000; const kDownKm = lim.kDown / 1000;
  // admissible: the straight great-circle distance (m_cell >= 1) plus the climb to B's height
  const h = heuristic
    ? (i) => {
      const r = Math.floor(i / g.cols); const c = i % g.cols;
      return haversineKm(g.latOf(r), g.lonOf(c), gLat, gLon) * 0.9999 + kUpKm * Math.max(0, gElev - g.elev[i]);
    }
    : () => 0;
  cost[start] = 0;
  heap.push(start, h(start));
  let expanded = 0;
  const total = mask ? mask.reduce((a, b) => a + b, 0) : n;
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue; // lazy deletion
    closed[i] = 1;
    expanded++;
    if (i === goal) break;
    if (onProgress && (expanded & 8191) === 0) onProgress(Math.min(1, expanded / total));
    if (shouldStop && (expanded & 4095) === 0 && shouldStop()) return { path: null, expanded, cancelled: true };
    const r = Math.floor(i / g.cols); const c = i % g.cols;
    for (let m = 0; m < MOVES.length; m++) {
      const s = step(g, r, c, MOVES[m][0], MOVES[m][1], lim, m);
      if (!s) continue;
      const j = s.j;
      if (closed[j] || (mask && !mask[j])) continue;
      const mc = mult ? (mult[i] + mult[j]) / 2 : 1;
      const p = penalty ? (penalty[i] + penalty[j]) / 2 : 1;
      const nc = cost[i] + (s.d * mc + kUpKm * s.climb + kDownKm * s.descent) * p;
      if (nc < cost[j]) {
        cost[j] = nc;
        from[j] = i;
        heap.push(j, nc + h(j));
      }
    }
  }
  if (!Number.isFinite(cost[goal])) return { path: null, expanded };
  const path = [];
  for (let i = goal; i >= 0; i = from[i]) path.push(i);
  return { path: path.reverse(), cost: cost[goal], expanded };
}

/**
 * When no route exists: the best you could do (the path whose steepest step is as gentle as
 * possible), and where that steepest, unavoidable stretch is.
 */
export function steepestUnavoidable(g, start, goal, mask = null) {
  const n = g.rows * g.cols;
  const worst = new Float32Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap(4096);
  const free = { maxSlope: 90, maxCross: 90 };
  worst[start] = 0; heap.push(start, 0);
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) break;
    const r = Math.floor(i / g.cols); const c = i % g.cols;
    for (let m = 0; m < 8; m++) {
      const s = step(g, r, c, MOVES[m][0], MOVES[m][1], free, m);
      if (!s || closed[s.j] || (mask && !mask[s.j])) continue;
      const v = Math.max(worst[i], s.slope, g.smax[s.j]);
      if (v < worst[s.j]) { worst[s.j] = v; from[s.j] = i; heap.push(s.j, v); }
    }
  }
  if (!Number.isFinite(worst[goal])) return null;
  // the step where the worst slope happens
  let at = goal; let best = -1;
  for (let i = goal; i >= 0 && from[i] >= 0; i = from[i]) {
    const v = Math.max(g.smax[i], g.smax[from[i]]);
    if (v >= best) { best = v; at = i; }
  }
  const r = Math.floor(at / g.cols); const c = at % g.cols;
  return { where: [g.latOf(r), g.lonOf(c)], slope_deg: Math.round(worst[goal] * 10) / 10 };
}

// ---- Corridors and bands -----------------------------------------------------------------------

const pathLatLon = (g, path) => path.map((i) => [g.latOf(Math.floor(i / g.cols)), g.lonOf(i % g.cols)]);

/** Distance (km) from a point to a polyline [[lat, lon]...] (local flat approximation). */
export function distToPolylineKm(lat, lon, line) {
  let best = Infinity;
  const kx = Math.cos(lat * RAD) * RAD * R_KM; const ky = RAD * R_KM;
  for (let k = 1; k < line.length; k++) {
    let [ay, ax] = line[k - 1]; let [by, bx] = line[k];
    ax += Math.round((lon - ax) / 360) * 360; bx += Math.round((ax - bx) / 360) * 360;
    const px = (lon - ax) * kx; const py = (lat - ay) * ky;
    const vx = (bx - ax) * kx; const vy = (by - ay) * ky;
    const L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / L2)) : 0;
    best = Math.min(best, Math.hypot(px - t * vx, py - t * vy));
  }
  if (line.length === 1) best = haversineKm(lat, lon, line[0][0], line[0][1]);
  return best;
}

/** Mask of the cells within `km` of a polyline. */
export function bandMask(g, line, km) {
  const mask = new Uint8Array(g.rows * g.cols);
  // only test cells inside the polyline's box (+ band), quickly
  let la0 = 90; let la1 = -90; let lo0 = Infinity; let lo1 = -Infinity;
  for (const [lat, lon] of line) { la0 = Math.min(la0, lat); la1 = Math.max(la1, lat); lo0 = Math.min(lo0, lon); lo1 = Math.max(lo1, lon); }
  const padLat = km / (RAD * R_KM);
  const r0 = Math.max(0, Math.floor((g.north - (la1 + padLat)) / g.dDeg));
  const r1 = Math.min(g.rows - 1, Math.ceil((g.north - (la0 - padLat)) / g.dDeg));
  for (let r = r0; r <= r1; r++) {
    const lat = g.latOf(r);
    for (let c = 0; c < g.cols; c++) {
      const lon = g.lonOf(c);
      if (distToPolylineKm(lat, lon, line) <= km + g.cellKm * 0.5) mask[r * g.cols + c] = 1;
    }
  }
  return mask;
}

/** Up to `k` distinct corridors on one grid: best route, then penalise its surroundings x3 and search again. */
export function corridors(g, start, goal, lim, { mult, mask = null, k = 3, nearKm = null, ...rest } = {}) {
  const out = [];
  const penalty = new Float32Array(g.rows * g.cols).fill(1);
  const near = nearKm ?? Math.max(3 * g.cellKm, haversineKm(g.latOf(Math.floor(start / g.cols)), g.lonOf(start % g.cols), g.latOf(Math.floor(goal / g.cols)), g.lonOf(goal % g.cols)) * 0.06);
  for (let t = 0; t < k; t++) {
    const res = astar(g, start, goal, lim, { mult, mask, penalty: t ? penalty : null, ...rest });
    if (res.cancelled) return { cancelled: true, list: out };
    if (!res.path) break;
    const line = pathLatLon(g, res.path);
    // true cost without the diversity penalty
    const real = routeCost(g, res.path, lim, mult);
    // distinct? (most of it outside the previous corridors)
    const dup = out.some((o) => line.filter(([la, lo]) => distToPolylineKm(la, lo, o.line) < near).length > line.length * 0.8);
    if (!dup) out.push({ path: res.path, line, cost: real });
    const band = bandMask(g, line, near);
    for (let i = 0; i < band.length; i++) if (band[i]) penalty[i] *= 3;
  }
  out.sort((a, b) => a.cost - b.cost);
  return { list: out };
}

/** Cost of a path of cells (km of flat driving). */
export function routeCost(g, path, lim, mult = null) {
  let s = 0;
  for (let k = 1; k < path.length; k++) {
    const i = path[k - 1]; const j = path[k];
    const ri = Math.floor(i / g.cols); const rj = Math.floor(j / g.cols);
    const d = haversineKm(g.latOf(ri), g.lonOf(i % g.cols), g.latOf(rj), g.lonOf(j % g.cols));
    const dz = g.elev[j] - g.elev[i];
    const m = mult ? (mult[i] + mult[j]) / 2 : 1;
    s += d * m + (lim.kUp / 1000) * Math.max(0, dz) + (lim.kDown / 1000) * Math.max(0, -dz);
  }
  return s;
}

// ---- Smoothing -------------------------------------------------------------------------------

/** Does the straight line between two points stay within the limits? Sampled every half cell. */
export function segmentOk(g, a, b, lim) {
  const dKm = haversineKm(a[0], a[1], b[0], b[1]);
  const n = Math.max(1, Math.ceil(dKm / (g.cellKm * 0.5)));
  let prevE = elevAt(g, a[0], a[1]);
  let prev = a;
  const bl = b[1] + Math.round((a[1] - b[1]) / 360) * 360;
  for (let s = 1; s <= n; s++) {
    const t = s / n;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (bl - a[1]) * t];
    const i = cellAt(g, p[0], p[1]);
    if (i < 0 || !g.valid[i] || g.smax[i] > lim.maxSlope) return false;
    const e = elevAt(g, p[0], p[1]);
    const d = haversineKm(prev[0], prev[1], p[0], p[1]);
    if (d > 0 && Math.atan(Math.abs(e - prevE) / (d * 1000)) / RAD > lim.maxSlope) return false;
    prevE = e; prev = p;
  }
  return true;
}

/** String-pull: drop points while the straight segment between their neighbours stays legal. */
export function stringPull(g, line, lim) {
  if (line.length <= 2) return line.slice();
  const out = [line[0]];
  let i = 0;
  while (i < line.length - 1) {
    let j = line.length - 1;
    while (j > i + 1 && !segmentOk(g, line[i], line[j], lim)) j--;
    out.push(line[j]);
    i = j;
  }
  return out;
}

/** Catmull-Rom through the points; kept only if every piece passes the limits. */
export function catmullRom(g, line, lim, perSeg = 6) {
  if (line.length < 3) return line;
  const P = (k) => line[Math.max(0, Math.min(line.length - 1, k))];
  const out = [line[0]];
  for (let k = 0; k < line.length - 1; k++) {
    const p0 = P(k - 1); const p1 = P(k); const p2 = P(k + 1); const p3 = P(k + 2);
    for (let s = 1; s <= perSeg; s++) {
      const t = s / perSeg;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  for (let k = 1; k < out.length; k++) if (!segmentOk(g, out[k - 1], out[k], lim)) return line;
  return out;
}

// ---- The whole search ---------------------------------------------------------------------------

/**
 * Find the route. `levels` is an array of grid providers, coarse to fine:
 *   [{ name: 'L0', window: (south, north, west, east) => grid | Promise<grid>, band: null },
 *    { name: 'L1', window, band: 30 }, { name: 'L2', window, band: 8 }, ...]
 * (L0 searches the whole window; finer levels only within `band` km of the previous route.)
 * settings: { roverMaxSlope, footMaxSlope, kUpRover, kUpFoot, kDown, weights, smooth }
 */
export async function findRoute(a, b, levels, settings = {}, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const t0 = Date.now();
  setRadius(settings.radiusKm ?? levels.radiusKm ?? 3389.5);
  const allModes = [
    ['rover', { ...MODES.rover, maxSlope: settings.roverMaxSlope ?? MODES.rover.maxSlope, maxCross: settings.roverMaxSlope ?? MODES.rover.maxCross, kUp: settings.kUpRover ?? MODES.rover.kUp, kDown: settings.kDown ?? 1 }],
    ['foot', { ...MODES.foot, maxSlope: settings.footMaxSlope ?? MODES.foot.maxSlope, maxCross: settings.footMaxSlope ?? MODES.foot.maxCross, kUp: settings.kUpFoot ?? MODES.foot.kUp, kDown: settings.kDown ?? 1 }],
  ];
  // which modes to try, in order (default: rover, then on foot)
  const modes = allModes.filter(([m]) => (settings.modes ?? ['rover', 'foot']).includes(m));
  // the search window: A-B box + 30% (at least 300 km), longitudes the short way round
  let bLon = b.lon + Math.round((a.lon - b.lon) / 360) * 360;
  const distKm = haversineKm(a.lat, a.lon, b.lat, bLon);
  const marginKm = Math.max(300, distKm * 0.3);
  const mDeg = marginKm / (RAD * R_KM);
  const south = Math.max(-89, Math.min(a.lat, b.lat) - mDeg);
  const north = Math.min(89, Math.max(a.lat, b.lat) + mDeg);
  const midLat = (south + north) / 2;
  const lonPad = Math.min(179, mDeg / Math.max(0.1, Math.cos(midLat * RAD)));
  const west = Math.min(a.lon, bLon) - lonPad;
  const east = Math.max(a.lon, bLon) + lonPad;

  const levelLog = [];
  let blocked = null;
  const L0 = levels[0];
  const g0 = await L0.window(south, north, west, east);
  const mult0 = cellMultipliers(g0, settings.weights ?? DEFAULT_WEIGHTS);
  for (const [mode, lim] of modes) {
    onProgress({ level: L0.name, mode, fraction: 0 });
    const s0 = cellAt(g0, a.lat, a.lon); const e0 = cellAt(g0, b.lat, bLon);
    const tL = Date.now();
    const cor = corridors(g0, s0, e0, lim, { mult: mult0, k: 3, onProgress: (f) => onProgress({ level: L0.name, mode, fraction: f }), shouldStop });
    if (cor.cancelled) return { status: 'cancelled' };
    if (!cor.list.length) {
      blocked ??= steepestUnavoidable(g0, s0, e0);
      levelLog.push({ level: L0.name, mode, cost: null, ms: Date.now() - tL });
      continue;
    }
    levelLog.push({ level: L0.name, mode, cost: cor.list[0].cost, ms: Date.now() - tL, ...(settings.trace ? { line: cor.list[0].line } : {}) });
    // refine coarse -> fine inside bands around the surviving corridors
    let cands = cor.list.map((c) => ({ line: c.line, cost: c.cost, pieces: [{ grid: g0, mult: mult0, line: c.line }], cellKm: g0.cellKm }));
    let ok = true;
    for (let li = 1; li < levels.length; li++) {
      const L = levels[li];
      const keep = li === 1 ? 2 : 1;
      const next = [];
      let noData = false;
      for (const cand of cands) {
        const res = await refine(cand, L, lim, a, { lat: b.lat, lon: bLon }, settings, onProgress, shouldStop, mode);
        if (res === 'cancelled') return { status: 'cancelled' };
        if (res === 'nodata') { noData = true; continue; }
        if (res) next.push({ ...res, prevCost: cand.cost, prevLine: cand.line });
        if (next.length >= keep) break;
      }
      if (!next.length) {
        if (noData && L.optional) break; // an optional level with no data here: keep the coarser route
        ok = false; break;
      }
      next.sort((x, y) => x.cost - y.cost);
      for (const n of next.slice(0, 1)) levelLog.push({ level: L.name, mode, cost: n.cost, ms: n.ms, ...(settings.trace ? { line: n.line, prevLine: n.prevLine, band: L.band } : {}) });
      // stop early: cost changed < 1% and the route moved < 1 cell
      const best = next[0];
      const moved = Math.max(...best.line.map(([la, lo]) => distToPolylineKm(la, lo, best.prevLine)));
      cands = next.slice(0, keep);
      if (Math.abs(best.cost - best.prevCost) / best.prevCost < 0.01 && moved < best.cellKm) break;
    }
    if (!ok) {
      blocked ??= { where: [a.lat, a.lon], slope_deg: null, note: 'impassable at finer resolution' };
      continue;
    }
    const best = cands[0];
    return finish(a, { lat: b.lat, lon: bLon }, best, mode, lim, settings, levelLog, t0, mode === 'rover' ? 'ok' : 'foot-only');
  }
  return { status: 'unavailable', mode: null, points: [], bounds: null, totals: null, segments: [], blocked, levels: levelLog, ms: Date.now() - t0 };
}

// Refine one corridor at a finer level, inside a band of L.band km around it. Long corridors
// are refined in pieces of ~CHUNK_KM, each in its own small window (a single window around a
// 3,000 km diagonal route would hold millions of cells), then joined end to end. A piece
// that's impassable inside its band is retried once with the band doubled.
const CHUNK_KM = 300;
async function refine(cand, L, lim, a, b, settings, onProgress, shouldStop, mode) {
  const t0 = Date.now();
  const line = cand.line;
  // split the corridor into pieces of about CHUNK_KM (by length along it)
  const cuts = [0];
  let acc = 0;
  for (let k = 1; k < line.length; k++) {
    acc += haversineKm(line[k - 1][0], line[k - 1][1], line[k][0], line[k][1]);
    if (acc >= CHUNK_KM && k < line.length - 1) { cuts.push(k); acc = 0; }
  }
  cuts.push(line.length - 1);
  const pieces = [];
  let total = 0;
  let from = [a.lat, a.lon];
  for (let p = 1; p < cuts.length; p++) {
    const part = line.slice(cuts[p - 1], cuts[p] + 1);
    part[0] = from;
    const to = p === cuts.length - 1 ? [b.lat, b.lon] : part[part.length - 1];
    part[part.length - 1] = to;
    let found = null;
    for (let attempt = 0, band = L.band; attempt < 2 && !found; attempt++, band *= 2) {
      const box = boxOf(part, band);
      const g = await L.window(box.south, box.north, box.west, box.east);
      if (!g) return 'nodata';
      const m = cellMultipliers(g, settings.weights ?? DEFAULT_WEIGHTS);
      const mask = bandMask(g, part, band);
      const s = cellAt(g, from[0], from[1]); const e = cellAt(g, to[0], to[1]);
      if (s < 0 || e < 0) return null;
      mask[s] = 1; mask[e] = 1;
      const res = astar(g, s, e, lim, { mult: m, mask, onProgress: (f) => onProgress({ level: L.name, mode, fraction: (p - 1 + f) / (cuts.length - 1) }), shouldStop });
      if (res.cancelled) return 'cancelled';
      if (res.path) found = { res, g, m };
    }
    if (!found) return null; // impassable at this resolution (a cliff hidden at the coarser scale)
    const pts = pathLatLon(found.g, found.res.path);
    pts[0] = from; pts[pts.length - 1] = to;
    pieces.push({ grid: found.g, mult: found.m, line: pts });
    total += found.res.cost;
    from = to;
  }
  const joined = pieces.flatMap((pc, k) => (k ? pc.line.slice(1) : pc.line));
  return { line: joined, cost: total, pieces, cellKm: pieces[0].grid.cellKm, ms: Date.now() - t0 };
}

function boxOf(line, km) {
  let south = 90; let north = -90; let west = Infinity; let east = -Infinity;
  let prev = null;
  for (const [lat, lon0] of line) {
    const lon = prev === null ? lon0 : lon0 + Math.round((prev - lon0) / 360) * 360;
    prev = lon;
    south = Math.min(south, lat); north = Math.max(north, lat); west = Math.min(west, lon); east = Math.max(east, lon);
  }
  const dLat = (km * 1.2) / (RAD * R_KM);
  const midLat = (south + north) / 2;
  const dLon = Math.min(179, dLat / Math.max(0.05, Math.cos(midLat * RAD)));
  return { south: Math.max(-89.5, south - dLat), north: Math.min(89.5, north + dLat), west: west - dLon, east: east + dLon };
}

function finish(a, b, best, mode, lim, settings, levelLog, t0, status) {
  // smooth each piece on its own terrain window, then join them
  const pieces = best.pieces.map((pc) => ({ ...pc, line: pc.line.slice() }));
  pieces[0].line[0] = [a.lat, a.lon];
  pieces[pieces.length - 1].line[pieces[pieces.length - 1].line.length - 1] = [b.lat, b.lon];
  const points = [];
  const where = []; // which piece each point belongs to (for terrain lookups)
  pieces.forEach((pc, k) => {
    let line = pc.line;
    if (settings.smooth !== false) {
      line = stringPull(pc.grid, line, lim);
      if (settings.curve !== false) line = catmullRom(pc.grid, line, lim);
    }
    line.forEach(([lat, lon], n) => {
      if (k && n === 0) return; // the join is the previous piece's last point
      points.push([lat, lon, Math.round(elevAt(pc.grid, lat, lon) * 10) / 10]);
      where.push(k);
    });
  });
  // totals and segments
  let length = 0; let climb = 0; let descent = 0; let maxSlope = 0; let energy = 0; let energyPlain = 0;
  const segments = [];
  for (let k = 1; k < points.length; k++) {
    const pc = pieces[where[k]];
    const g = pc.grid;
    const [la0, lo0, e0] = points[k - 1]; const [la1, lo1, e1] = points[k];
    const d = haversineKm(la0, lo0, la1, lo1);
    const dz = e1 - e0;
    const slope = d > 0 ? Math.atan(Math.abs(dz) / (d * 1000)) / RAD : 0;
    const i = cellAt(g, (la0 + la1) / 2, (lo0 + lo1) / 2);
    const cellSlope = i >= 0 ? g.smax[i] : 0;
    const m = i >= 0 ? pc.mult[i] : 1;
    length += d; climb += Math.max(0, dz); descent += Math.max(0, -dz);
    maxSlope = Math.max(maxSlope, slope, cellSlope);
    const up = (lim.kUp / 1000) * Math.max(0, dz); const down = (lim.kDown / 1000) * Math.max(0, -dz);
    energy += d * m + up + down; energyPlain += d + up + down;
    const dust = i >= 0 && g.dust ? g.dust[i] : 0; const rock = i >= 0 && g.rock ? g.rock[i] : 0;
    segments.push({ from: k - 1, to: k, length_km: round(d, 3), slope_deg: round(slope, 1),
      terrain: dust > 0.5 ? 'dusty' : rock > 0.5 ? 'rocky' : 'normal' });
  }
  return {
    status, mode, points,
    bounds: boundsOf(points),
    totals: {
      length_km: round(length, 2), straight_km: round(haversineKm(a.lat, a.lon, b.lat, b.lon), 2),
      climb_m: Math.round(climb), descent_m: Math.round(descent), max_slope_deg: round(maxSlope, 1),
      energy_km_equiv: round(energy, 2), extra_cost_from_secondary_pct: round(energyPlain > 0 ? ((energy - energyPlain) / energyPlain) * 100 : 0, 1),
    },
    segments, blocked: null, levels: levelLog, finest: pieces[0].grid.name,
    finest_km: round(pieces[0].grid.cellKm, 3), ms: Date.now() - t0,
  };
}

const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

function boundsOf(points) {
  let south = 90; let north = -90; let west = Infinity; let east = -Infinity; let prev = null;
  for (const [lat, lon0] of points) {
    const lon = prev === null ? lon0 : lon0 + Math.round((prev - lon0) / 360) * 360;
    prev = lon;
    south = Math.min(south, lat); north = Math.max(north, lat); west = Math.min(west, lon); east = Math.max(east, lon);
  }
  return [[south, west], [north, east]];
}
