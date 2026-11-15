// Unit tests for the route engine (src/route/engine/engine.js) on synthetic terrain.
// Run: npm test   (Node's built-in test runner, no extra packages)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeGrid, astar, findRoute, cellAt, routeCost, haversineKm, MODES, cellMultipliers, segmentOk, distToPolylineKm,
} from '../src/route/engine/engine.js';

const RAD = Math.PI / 180;

// A grid built from functions of (lat, lon): elevation (m) and extra steepness (deg).
// smax = steepest slope inside the cell, from the elevation sampled 4x finer (like the real builder).
function synth({ north = 2, west = 0, rows = 40, cols = 60, dDeg = 0.1, elev, wall = () => 0, dust, rock, cold, name = 'T' }) {
  const n = rows * cols;
  const e = new Float32Array(n); const smax = new Float32Array(n);
  const f = (k) => (k ? new Float32Array(n) : null);
  const du = f(dust); const ro = f(rock); const co = f(cold);
  const kmDeg = RAD * 3389.5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = north - (r + 0.5) * dDeg; const lon = west + (c + 0.5) * dDeg;
      const i = r * cols + c;
      e[i] = elev(lat, lon);
      // steepest finite-difference slope inside the cell on a 4x finer grid
      let s = 0; const h = dDeg / 4;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const la = north - r * dDeg - (y + 0.5) * h; const lo = west + c * dDeg + (x + 0.5) * h;
          const ex = (elev(la, lo + h / 2) - elev(la, lo - h / 2)) / (h * kmDeg * Math.cos(la * RAD) * 1000);
          const ey = (elev(la + h / 2, lo) - elev(la - h / 2, lo)) / (h * kmDeg * 1000);
          s = Math.max(s, Math.atan(Math.hypot(ex, ey)) / RAD);
        }
      }
      smax[i] = Math.max(s, wall(lat, lon));
      if (du) du[i] = dust(lat, lon);
      if (ro) ro[i] = rock(lat, lon);
      if (co) co[i] = cold(lat, lon);
    }
  }
  return makeGrid({ rows, cols, north, west, dDeg, elev: e, smax, dust: du, rock: ro, cold: co, name });
}

// A level provider from a terrain description: any window, at a given cell size.
function provider(name, dDeg, terrain, band = null) {
  return {
    name, band,
    window: (south, north, west, east) => {
      const n0 = Math.ceil(north / dDeg) * dDeg; const w0 = Math.floor(west / dDeg) * dDeg;
      const rows = Math.ceil((n0 - south) / dDeg); const cols = Math.ceil((east - w0) / dDeg);
      return synth({ north: n0, west: w0, rows, cols, dDeg, name, ...terrain });
    },
  };
}

const lim = (mode = 'rover', extra = {}) => ({ ...MODES[mode], ...extra });
const flat = () => 0;
const pathCells = (g, path) => path.map((i) => [Math.floor(i / g.cols), i % g.cols]);

test('flat ground: a straight line', async () => {
  const res = await findRoute({ lat: 0, lon: 1 }, { lat: 0, lon: 4 }, [provider('L0', 0.1, { elev: flat })]);
  assert.equal(res.status, 'ok');
  assert.equal(res.mode, 'rover');
  // smoothed to a single straight segment, as long as the straight line
  assert.equal(res.points.length, 2);
  assert.ok(Math.abs(res.totals.length_km - res.totals.straight_km) < 0.01);
});

test('a wall above the limit with one gap: the route goes through the gap', () => {
  // wall along lon 3.0-3.1, 40 deg steep, except a gap at lat 0.55..0.65
  const wall = (lat, lon) => (lon > 3.0 && lon < 3.1 && !(lat > 0.5 && lat < 0.7) ? 40 : 0);
  const g = synth({ north: 2, west: 0, rows: 40, cols: 60, elev: flat, wall });
  const a = cellAt(g, 1.5, 1); const b = cellAt(g, 1.5, 5);
  const res = astar(g, a, b, lim());
  assert.ok(res.path, 'route found');
  const crossing = pathCells(g, res.path).filter(([, c]) => g.lonOf(c) > 3.0 && g.lonOf(c) < 3.1);
  assert.ok(crossing.length > 0);
  for (const [r] of crossing) assert.ok(g.latOf(r) > 0.5 && g.latOf(r) < 0.7, `crosses at lat ${g.latOf(r)}`);
});

test('a hill: around it with a high climbing penalty, over it with k_up = 0', () => {
  // a gentle round hill (2 km high, ~6 deg max) right between A and B
  const hill = (lat, lon) => 2000 * Math.exp(-(((lat - 1) ** 2 + (lon - 3) ** 2) / (2 * 0.35 ** 2)));
  const g = synth({ north: 2, west: 0, rows: 20, cols: 60, elev: hill });
  const a = cellAt(g, 1, 0.6); const b = cellAt(g, 1, 5.4);
  const peakOf = (res) => Math.max(...res.path.map((i) => g.elev[i]));
  const over = astar(g, a, b, lim('rover', { kUp: 0, kDown: 0 }));
  const around = astar(g, a, b, lim('rover', { kUp: 20 }));
  assert.ok(peakOf(over) > 1500, `k_up = 0 goes over the top (${peakOf(over)} m)`);
  assert.ok(peakOf(around) < peakOf(over) * 0.5, `k_up = 20 goes around (${peakOf(around)} m)`);
});

test('a closed wall: unavailable, and it says where and how steep', async () => {
  const wall = (lat, lon) => (lon > 3.0 && lon < 3.15 ? 35 : 0);
  const res = await findRoute({ lat: 0, lon: 1 }, { lat: 0, lon: 5 }, [provider('L0', 0.1, { elev: flat, wall })]);
  assert.equal(res.status, 'unavailable');
  assert.equal(res.mode, null);
  assert.ok(res.blocked && res.blocked.slope_deg >= 35, JSON.stringify(res.blocked));
  assert.ok(res.blocked.where[1] > 2.9 && res.blocked.where[1] < 3.25);
});

test('rover limit too strict: falls back to on foot', async () => {
  // a 12-deg wall everywhere between A and B: over a 10-deg rover limit, under the 15-deg foot limit
  const wall = (lat, lon) => (lon > 3.0 && lon < 3.15 ? 12 : 0);
  const res = await findRoute({ lat: 0, lon: 1 }, { lat: 0, lon: 5 }, [provider('L0', 0.1, { elev: flat, wall })], { roverMaxSlope: 10 });
  assert.equal(res.status, 'foot-only');
  assert.equal(res.mode, 'foot');
});

test('A* finds the same cost as Dijkstra (the heuristic is admissible)', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const rnd = mulberry(seed);
    const bumps = Array.from({ length: 12 }, () => [rnd() * 4, rnd() * 6, (rnd() - 0.3) * 2500, 0.2 + rnd() * 0.5]);
    const elev = (lat, lon) => bumps.reduce((s, [la, lo, h, w]) => s + h * Math.exp(-(((lat - la) ** 2 + (lon - lo) ** 2) / (2 * w * w))), 0);
    const dust = (lat, lon) => Math.max(0, Math.sin(lat * 7 + lon * 3));
    const g = synth({ north: 4, west: 0, rows: 40, cols: 60, elev, dust });
    const mult = cellMultipliers(g);
    const a = cellAt(g, 3.5, 0.3); const b = cellAt(g, 0.4, 5.7);
    const L = lim('rover');
    const fast = astar(g, a, b, L, { mult });
    const slow = astar(g, a, b, L, { mult, heuristic: false });
    assert.equal(!!fast.path, !!slow.path);
    if (fast.path) assert.ok(Math.abs(fast.cost - slow.cost) < 1e-6 * slow.cost, `seed ${seed}: ${fast.cost} vs ${slow.cost}`);
  }
});

test('secondary layers can never make the route more than 25% longer', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const rnd = mulberry(100 + seed);
    const field = () => { const ph = rnd() * 10; const k = 2 + rnd() * 8; return (lat, lon) => (Math.sin(lat * k + ph) * Math.cos(lon * k) > 0 ? 1 : 0); };
    const g = synth({ north: 4, west: 0, rows: 40, cols: 60, elev: flat, dust: field(), rock: field(), cold: field() });
    const a = cellAt(g, 3.6, 0.2); const b = cellAt(g, 0.3, 5.8);
    const L = lim('rover', { kUp: 0, kDown: 0 });
    const plain = astar(g, a, b, L);
    const heavy = astar(g, a, b, L, { mult: cellMultipliers(g, { dust: 2, rock: 2, cold: 2 }) });
    const lenP = routeCost(g, plain.path, L); const lenH = routeCost(g, heavy.path, L);
    assert.ok(lenH <= lenP * 1.25 + 1e-9, `seed ${seed}: ${lenH} vs ${lenP}`);
  }
});

test('coarse to fine: each level stays inside the previous level\'s band, and respects the limits', async () => {
  const bumps = [[1.2, 2.0, 1800, 0.3], [0.2, 3.5, -1500, 0.4], [1.6, 4.4, 1200, 0.25]];
  const elev = (lat, lon) => bumps.reduce((s, [la, lo, h, w]) => s + h * Math.exp(-(((lat - la) ** 2 + (lon - lo) ** 2) / (2 * w * w))), 0);
  const seen = [];
  const L0 = provider('L0', 0.12, { elev }); const L1 = provider('L1', 0.03, { elev }, 30);
  const wrap = (P) => ({ ...P, window: (...box) => { const g = P.window(...box); seen.push(g); return g; } });
  const res = await findRoute({ lat: 0, lon: 0.5 }, { lat: 1.8, lon: 5.5 }, [wrap(L0), wrap(L1)], { smooth: false, trace: true });
  assert.equal(res.status, 'ok');
  // every L1 point lies inside the +-30 km band around the L0 route it refined
  const l1 = res.levels.find((l) => l.level === 'L1');
  const cellKm = 0.03 * RAD * 3389.5;
  for (const [la, lo] of l1.line) {
    const d = distToPolylineKm(la, lo, l1.prevLine);
    assert.ok(d <= l1.band + cellKm + 0.01 || haversineKm(la, lo, 0, 0.5) < 3 || haversineKm(la, lo, 1.8, 5.5) < 3, `L1 point ${d.toFixed(1)} km from the L0 route`);
  }
  assert.equal(res.finest, 'L1');
  assert.ok(res.levels.some((l) => l.level === 'L1'));
  // the final (L1) route respects the rover limit everywhere (checked on one L1 window around it)
  const [[s0, w0], [n0, e0]] = res.bounds;
  const g1 = L1.window(s0 - 0.3, n0 + 0.3, w0 - 0.3, e0 + 0.3);
  for (let k = 1; k < res.points.length; k++) {
    assert.ok(segmentOk(g1, res.points[k - 1], res.points[k], MODES.rover), `segment ${k}`);
  }
  assert.ok(res.totals.max_slope_deg <= MODES.rover.maxSlope);
});

test('output contract', async () => {
  const res = await findRoute({ lat: 0, lon: 1 }, { lat: 1, lon: 4 }, [provider('L0', 0.1, { elev: (la, lo) => 300 * lo })]);
  for (const k of ['status', 'mode', 'points', 'bounds', 'totals', 'segments', 'blocked', 'levels']) assert.ok(k in res, k);
  for (const k of ['length_km', 'straight_km', 'climb_m', 'descent_m', 'max_slope_deg', 'energy_km_equiv', 'extra_cost_from_secondary_pct']) assert.ok(k in res.totals, k);
  assert.equal(res.points[0].length, 3);
  assert.ok(res.totals.climb_m > 800, `climbs ~900 m (${res.totals.climb_m})`);
  assert.deepEqual(res.bounds.length, 2);
  assert.ok(Math.abs(res.points[0][0] - 0) < 1e-9 && Math.abs(res.points.at(-1)[1] - 4) < 1e-9, 'starts at A, ends at B');
  assert.ok(haversineKm(0, 1, 1, 4) <= res.totals.length_km + 1e-6);
});

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
