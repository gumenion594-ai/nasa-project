// A* route search over the terrain grid (runs in a Web Worker so the map stays smooth).
//
// Three routes from one search engine, differing only in what a step "costs":
//   shortest - kilometres
//   easiest  - on foot: walking hours (Tobler's hiking function on the uphill/downhill
//              grade); rover: driving effort (distance, extra for climbing and loose dust)
//   safest   - kilometres made longer by every hazard on the way (steep slopes, crater
//              rims, rough ground, loose dust, frequent dust storms)
// All three respect the same hard limit: no cell steeper than the traveller can manage.
//
// 16 neighbours per cell (the 8 around it plus knight's moves), so routes can run at
// angles other than 0/45/90 degrees without zig-zagging.

let R = 3389.5; // the world's radius, km (sent with each grid)
const rad = (d) => (d * Math.PI) / 180;
const MOVES = [
  [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2],
];

// Tobler (1993) hiking speed, km/h, on a grade dh/dx. Fitted to people walking on
// Earth, so on Mars and the Moon it's a relative measure of effort more than a real speed.
const tobler = (grade) => 6 * Math.exp(-3.5 * Math.abs(grade + 0.05));

class Heap {
  constructor(n) { this.idx = new Int32Array(n); this.key = new Float64Array(n); this.size = 0; }
  push(i, k) {
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
    const li = this.idx[--this.size];
    const lk = this.key[this.size];
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

// Light 3x3 smoothing of elevation before taking grades: the tiles store elevation in
// ~115 m steps, which would otherwise show up as fake little climbs.
function smooth(g) {
  const { rows, cols, elev, valid } = g;
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0; let k = 0;
      for (let y = Math.max(0, r - 1); y <= Math.min(rows - 1, r + 1); y++) {
        for (let x = Math.max(0, c - 1); x <= Math.min(cols - 1, c + 1); x++) {
          const i = y * cols + x;
          if (valid[i]) { s += elev[i]; k++; }
        }
      }
      out[r * cols + c] = k ? s / k : elev[r * cols + c];
    }
  }
  return out;
}

// Per-cell hazard factor for the safest route (>= 1) and loose-dust share (0..1).
function cellFactors(g, opts) {
  const n = g.rows * g.cols;
  const hazard = new Float32Array(n);
  const soft = new Float32Array(n);
  const rocky = new Float32Array(n);
  const w = opts.weights;
  const lr0 = Math.log10(0.02);
  const lr1 = Math.log10(0.4);
  for (let i = 0; i < n; i++) {
    const s = Math.min(3, (g.slopeMax[i] / opts.cautionDeg) ** 2);
    const rough = Number.isNaN(g.relief[i]) ? 0
      : Math.min(1, Math.max(0, (Math.log10(Math.max(g.relief[i], 1e-4)) - lr0) / (lr1 - lr0)));
    // thresholds per world (planner.js WORLD_CFG): Mars TES values run ~30-1000, the Moon's ~25-60
    const t = opts.ti;
    soft[i] = Number.isNaN(g.ti[i]) ? 0 : Math.min(1, Math.max(0, (t.softHi - g.ti[i]) / t.softSpan));
    // high thermal inertia = rock and bedrock at the surface (sharp rocks wear wheels)
    rocky[i] = Number.isNaN(g.ti[i]) ? 0 : Math.min(1, Math.max(0, (g.ti[i] - t.rockLo) / t.rockSpan));
    const storm = Math.min(1, g.storm[i] / 0.15);
    hazard[i] = 1 + w.slope * s + w.crater * g.crater[i] + w.rough * rough + w.soft * soft[i]
      + (w.rocky ?? 0) * rocky[i] + w.storm * storm;
  }
  return { hazard, soft, rocky };
}

function search(g, kind, opts, wall, f, z, start, goal) {
  const { rows, cols, dLat, dLon, latMax } = g;
  const n = rows * cols;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new Heap(n * 4);
  const cosRow = new Float64Array(rows);
  for (let r = 0; r < rows; r++) cosRow[r] = Math.cos(rad(latMax - (r + 0.5) * dLat));
  const kmLat = rad(dLat) * R;
  const kmLon = rad(dLon) * R;
  const gr = Math.floor(goal / cols);
  const gc = goal % cols;
  // admissible lower bound: straight-line km x the cheapest possible cost per km
  const perKm = kind === 'easiest' && opts.traveller === 'walk' ? 1 / 6 : 1;
  const h = (i) => {
    const r = Math.floor(i / cols);
    const dy = (r - gr) * kmLat;
    const dx = ((i % cols) - gc) * kmLon * Math.min(cosRow[r], cosRow[gr]);
    return Math.sqrt(dx * dx + dy * dy) * perKm * 0.999;
  };
  cost[start] = 0;
  heap.push(start, h(start));
  let expanded = 0;
  while (heap.size) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    expanded++;
    if (i === goal) break;
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (const [dr, dc] of MOVES) {
      const r2 = r + dr;
      const c2 = c + dc;
      if (r2 < 0 || r2 >= rows || c2 < 0 || c2 >= cols) continue;
      const j = r2 * cols + c2;
      if (done[j] || wall[j]) continue;
      // knight's moves also pass through two in-between cells
      let mid1 = -1; let mid2 = -1;
      if (Math.abs(dr) === 2) { mid1 = (r + dr / 2) * cols + c; mid2 = (r + dr / 2) * cols + c2; }
      if (Math.abs(dc) === 2) { mid1 = r * cols + c + dc / 2; mid2 = r2 * cols + c + dc / 2; }
      if (mid1 >= 0 && (wall[mid1] || wall[mid2])) continue;
      const cosL = (cosRow[r] + cosRow[r2]) / 2;
      const dx = dc * kmLon * cosL;
      const dy = dr * kmLat;
      const L = Math.sqrt(dx * dx + dy * dy);
      let step;
      if (kind === 'shortest') {
        step = L;
      } else {
        const avg = (arr) => (mid1 >= 0 ? (arr[i] + arr[j] + arr[mid1] + arr[mid2]) / 4 : (arr[i] + arr[j]) / 2);
        if (kind === 'safest') {
          step = L * avg(f.hazard);
        } else { // easiest
          const grade = (z[j] - z[i]) / L;
          if (opts.traveller === 'walk') {
            step = L / tobler(grade) * (1 + 0.3 * avg(f.soft));
          } else {
            step = L * (1 + 10 * Math.max(0, grade) + 0.5 * avg(f.soft));
          }
        }
      }
      const nc = cost[i] + step;
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

self.onmessage = ({ data }) => {
  const { grid: g, opts, start, goal, id } = data;
  R = g.R;
  const n = g.rows * g.cols;
  const wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) wall[i] = !g.valid[i] || g.slopeMax[i] > opts.noGoDeg ? 1 : 0;
  wall[start] = 0;
  wall[goal] = 0;
  const z = smooth(g);
  const f = cellFactors(g, opts);
  const routes = {};
  for (const kind of ['shortest', 'easiest', 'safest']) {
    const t0 = performance.now();
    routes[kind] = search(g, kind, opts, wall, f, z, start, goal);
    routes[kind].ms = Math.round(performance.now() - t0);
  }
  self.postMessage({ id, routes, soft: f.soft, rocky: f.rocky, z });
};
