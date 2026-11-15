// Country lookup grid for the Earth analog search (public/search/countries.bin + .json).
//
// Source: Natural Earth 1:50m country boundaries (public domain), from the `world-atlas`
// npm package. Natural Earth draws de facto boundaries; disputed areas follow its choices.
//
// Output: a 0.25 degree grid (1440 x 720, row 0 at 90N, column 0 at 180W), one byte per
// cell = index into the country list (0 = no country: ocean or unclaimed), deflate-compressed.
// Antarctica is in the list, flagged `noCountry` (governed by the Antarctic Treaty).
//
// Run:  node tools/build_country_grid.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { feature } from 'topojson-client';

const RES = 0.25;
const W = 360 / RES;
const H = 180 / RES;
const topo = JSON.parse(readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)));
const countries = feature(topo, topo.objects.countries).features
  .sort((a, b) => a.properties.name.localeCompare(b.properties.name));

const grid = new Uint8Array(W * H);
// Fill one polygon (outer ring + holes) by scanline, even-odd rule, at cell centres.
function fill(ringsIn, value) {
  // Outlines that cross the 180° meridian jump from +180 to -180: make every ring's
  // longitudes continuous (they may then run past ±180; columns wrap around below).
  const ref = ringsIn[0][0][0];
  const rings = ringsIn.map((ring) => {
    let prev = ref;
    return ring.map(([x, y]) => {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
      prev = x;
      return [x, y];
    });
  });
  let latMin = 90; let latMax = -90;
  for (const [, lat] of rings[0]) { latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat); }
  const r0 = Math.max(0, Math.floor((90 - latMax) / RES));
  const r1 = Math.min(H - 1, Math.floor((90 - latMin) / RES));
  for (let r = r0; r <= r1; r++) {
    const lat = 90 - (r + 0.5) * RES;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i]; const [x2, y2] = ring[i + 1];
        if ((y1 > lat) !== (y2 > lat)) xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.ceil((xs[k] + 180) / RES - 0.5);
      const c1 = Math.floor((xs[k + 1] + 180) / RES - 0.5);
      for (let c = c0; c <= c1; c++) grid[r * W + (((c % W) + W) % W)] = value;
    }
  }
}
countries.forEach((f, i) => {
  // Antarctica's outline wraps around the pole, which a flat scanline can't fill: instead,
  // everything south of 60°S not claimed by a country polygon is the Antarctic Treaty area.
  if (f.properties.name === 'Antarctica') return;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const rings of polys) fill(rings, i + 1);
});
const antarctica = countries.findIndex((f) => f.properties.name === 'Antarctica') + 1;
for (let r = Math.round((90 + 60) / RES); r < H; r++) {
  for (let c = 0; c < W; c++) if (!grid[r * W + c]) grid[r * W + c] = antarctica;
}

const list = countries.map((f) => ({
  name: f.properties.name,
  ...(f.id ? { iso: f.id } : {}),
  ...(f.properties.name === 'Antarctica' ? { noCountry: true } : {}),
}));
const out = new URL('../public/search/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('countries.bin', out), deflateSync(grid, { level: 9 }));
writeFileSync(new URL('countries.json', out), JSON.stringify({
  res: RES, width: W, height: H,
  source: 'Natural Earth 1:50m admin-0 countries (public domain), via the world-atlas package',
  countries: list,
}));
const cells = new Map();
for (const v of grid) cells.set(v, (cells.get(v) ?? 0) + 1);
console.log(`${list.length} countries; ${((1 - cells.get(0) / grid.length) * 100).toFixed(1)}% of cells have one`);
const at = (lat, lon) => list[grid[Math.floor((90 - lat) / RES) * W + Math.floor((lon + 180) / RES)] - 1]?.name ?? '-';
for (const [n, la, lo] of [['Atacama', -23.5, -68.5], ['Devon Island', 75.4, -89.8], ['Dry Valleys', -77.5, 162],
  ['Tibet', 33, 88], ['Death Valley', 36.5, -117], ['Sahara', 23, 12], ['Iceland', 65, -18], ['mid-Pacific', 0, -150],
  ['Yakutia', 67.25, 127.25], ['Chukotka', 66, -172], ['Fiji', -17.8, 178], ['Alaska', 65, -150]]) {
  console.log(`  ${n}: ${at(la, lo)}`);
}
