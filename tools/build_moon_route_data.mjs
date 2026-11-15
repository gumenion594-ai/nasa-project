// Build the crater data the route planner needs on the Moon (public/route/moon/), in the
// same format as the Mars craters (tools/build_route_data.py).
//
// Inputs (data/raw/):
//   robbins_moon/.../lunar_crater_database_robbins_2018.csv
//       Robbins (2019) global lunar crater database: ~1.3 million craters, complete down to
//       ~1-2 km. Positions and diameters from LRO images; it has no depths.
//       Official source (USGS Astrogeology): https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins
//       (doi:10.1029/2018JE005592)
//   ldem_16.img
//       LRO LOLA elevation, 16 px/degree (~1.9 km), downloaded by tools/build_far_dem.mjs.
//
// Depths: measured here from LOLA for craters >= 15 km wide (rim = median of the highest
// point along 36 spokes between 0.8 and 1.25 radii; floor = lowest point inside 0.5 radii;
// surroundings = median at 2 radii). Smaller craters are too few LOLA pixels across:
// the app estimates their depth from their size instead (src/route/grid.js).
//
// Outputs:
//   public/route/moon/craters/{lat0}_{lon0}.bin  30 x 30 degree blocks, 12 bytes per crater
//                                                (see tools/build_route_data.py); largest first
//   public/route/moon/index.json
//
// Run: node tools/build_moon_route_data.mjs
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = join(ROOT, 'data/raw/robbins_moon/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv');
const LDEM = join(ROOT, 'data/raw/ldem_16.img');
const OUT = join(ROOT, 'public/route/moon');
const R = 1737.4;
const BLOCK = 30;
const MIN_D = 1.3;       // km: the planner marks craters >= half a cell, and Moon cells are >= ~2.7 km
const MEASURE_D = 15;    // km: measure depths from LOLA from this size up

for (const f of [CSV, LDEM]) if (!existsSync(f)) { console.error('missing', f); process.exit(1); }

// ---- LOLA heights (km), bilinear
const buf = readFileSync(LDEM);
const SW = 5760; const SH = 2880;
const dem = new Int16Array(buf.buffer, buf.byteOffset, SW * SH);
function height(lat, lon) {
  const y = Math.min(SH - 1.001, Math.max(0, (90 - lat) * 16 - 0.5));
  const x = (((lon % 360) + 360) % 360) * 16 - 0.5;
  const r0 = Math.floor(y); const c0 = Math.floor(x);
  const ty = y - r0; const tx = x - c0;
  const at = (r, c) => dem[r * SW + (((c % SW) + SW) % SW)];
  const v = (1 - ty) * ((1 - tx) * at(r0, c0) + tx * at(r0, c0 + 1)) + ty * ((1 - tx) * at(r0 + 1, c0) + tx * at(r0 + 1, c0 + 1));
  return (v * 0.5) / 1000;
}
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
// point at distance d (km) and bearing b from (lat, lon), flat approximation (fine for d << R)
function offset(lat, lon, dKm, b) {
  const dLat = ((dKm * Math.cos(b)) / R) * (180 / Math.PI);
  const dLon = ((dKm * Math.sin(b)) / (R * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))) * (180 / Math.PI);
  return [Math.max(-89.99, Math.min(89.99, lat + dLat)), lon + dLon];
}
function measure(lat, lon, D) {
  const rad = D / 2;
  const step = Math.min(rad / 6, 1.0); // km along each spoke (LOLA pixels are ~1.9 km)
  const rims = []; const outs = [];
  let floor = Infinity;
  for (let k = 0; k < 36; k++) {
    const b = (k / 36) * 2 * Math.PI;
    let rim = -Infinity;
    for (let d = 0.8 * rad; d <= 1.25 * rad; d += step) rim = Math.max(rim, height(...offset(lat, lon, d, b)));
    rims.push(rim);
    for (let d = 0; d <= 0.5 * rad; d += step) floor = Math.min(floor, height(...offset(lat, lon, d, b)));
    outs.push(height(...offset(lat, lon, 2 * rad, b)));
  }
  const rim = median(rims);
  return { depth: Math.max(0, rim - floor), rimH: Math.max(0, rim - median(outs)) };
}

// ---- read the catalog
const rl = createInterface({ input: createReadStream(CSV), crlfDelay: Infinity });
let cols = null;
const blocks = new Map();
let total = 0; let kept = 0; let measured = 0;
for await (const line of rl) {
  if (!cols) { cols = line.split(','); continue; }
  const f = line.split(',');
  total++;
  const lat = Number(f[cols.indexOf('LAT_CIRC_IMG')]);
  let lon = Number(f[cols.indexOf('LON_CIRC_IMG')]);
  const D = Number(f[cols.indexOf('DIAM_CIRC_IMG')]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(D >= MIN_D)) continue;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  let depthM = 65535; let rimM = 65535;
  if (D >= MEASURE_D) {
    const m = measure(lat, lon, D);
    depthM = Math.min(65534, Math.round(m.depth * 1000));
    rimM = Math.min(65534, Math.round(m.rimH * 1000));
    measured++;
  }
  const blat = Math.min(90 - BLOCK, Math.max(-90, Math.floor((lat + 90) / BLOCK) * BLOCK - 90));
  const blon = Math.min(180 - BLOCK, Math.max(-180, Math.floor((lon + 180) / BLOCK) * BLOCK - 180));
  const key = `${blat}_${blon}`;
  if (!blocks.has(key)) blocks.set(key, []);
  blocks.get(key).push({ lat, lon, D, depthM, rimM });
  kept++;
}

// ---- write the blocks
rmSync(join(OUT, 'craters'), { recursive: true, force: true });
mkdirSync(join(OUT, 'craters'), { recursive: true });
const counts = {};
let bytes = 0;
for (const [key, list] of blocks) {
  list.sort((p, q) => q.D - p.D);
  const out = Buffer.alloc(list.length * 12);
  list.forEach((c, i) => {
    const o = i * 12;
    out.writeInt16LE(Math.round(c.lat * 100), o);
    out.writeInt16LE(Math.round(c.lon * 100), o + 2);
    out.writeUInt16LE(Math.min(65535, Math.round(c.D * 10)), o + 4);
    out.writeUInt16LE(c.depthM, o + 6);
    out.writeUInt16LE(c.rimM, o + 8);
    out.writeUInt8(0, o + 10); // degradation: not in this catalog
  });
  writeFileSync(join(OUT, 'craters', `${key}.bin`), out);
  counts[key] = list.length;
  bytes += out.length;
}
const index = {
  craters: {
    count: kept, with_depth: measured, block_deg: BLOCK, record_bytes: 12, min_diameter_km: MIN_D,
    blocks: Object.fromEntries(Object.entries(counts).sort()),
    source: 'Robbins (2019) global lunar crater database, doi:10.1029/2018JE005592; depths of craters >= 15 km measured from LRO LOLA 16 px/degree',
  },
};
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`craters: ${kept.toLocaleString()} of ${total.toLocaleString()} (>= ${MIN_D} km) in ${blocks.size} blocks, ${(bytes / 1e6).toFixed(1)} MB;`,
  `${measured.toLocaleString()} with a depth measured from LOLA`);
console.log('files:', readdirSync(join(OUT, 'craters')).length);
