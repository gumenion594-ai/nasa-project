// Earth -> Moon / Mars: "Where on Mars (or the Moon) is most like this place on Earth?"
// The reverse of the Earth analog search (analogs.js), with the same idea of similarity:
//
// - The Earth place: its land-area means over the selected circle (from the analog search's
//   Earth grid: hottest-month maximum, coldest-month minimum, day-night swing, slope, relief).
// - Every spot on the Moon / Mars: circle means of the same characteristics from the maps
//   (similar.js, the "Find similar spots" machinery), so they are compared like with like.
// - Slope and relief are matched by value. Temperatures are matched by value where the Earth
//   value exists on that world; where it doesn't (Earth is far warmer at night than Mars, and
//   its day-night swing far smaller than the Moon's), relatively: a place that is cold for Earth
//   (say its 20th percentile) is matched to places equally cold for that world.
// - Score: weighted root-mean-square of the differences, each divided by how much that
//   characteristic varies across the world; shown as a % match like the analog search
//   (100% = identical, 0% = a whole world's spread apart). Rain beyond a desert's lowers the %
//   (the Moon and Mars are bone dry). Below CLOSE_MATCH the panel says there is no close
//   equivalent and gives the nearest one with its %.
import { earthPlace, similarity } from './analogs.js';
import { findMatches } from './similar.js';
import { LANDMARKS } from './landmarks.js';
import { BODIES } from './bodies.js';

// % match from which a spot counts as a close equivalent. Calibrated on known places: the classic
// Mars analogs (Atacama, Devon Island, the Antarctic Dry Valleys, Mongolian steppe) score 92-96% on
// Mars, deserts 88%; wet or green places (London 80%, Iceland 78%, Hawaii and the Amazon 70%) don't.
export const CLOSE_MATCH = 86;
export const WORLDS = ['mars', 'moon'];

// Earth place characteristic -> the Moon / Mars map layer
export const SHARED = {
  tmax: { layer: 'temp_max', name: 'Max. temperature', fmt: (v) => `${Math.round(v)} °C` },
  tmin: { layer: 'temp_min', name: 'Min. temperature', fmt: (v) => `${Math.round(v)} °C` },
  swing: { layer: 'temp_range', name: 'Daily temp. swing', fmt: (v) => `${Math.round(v)} °C` },
  slope: { layer: 'slope', name: 'Terrain slope', fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)}°` },
  relief: { layer: 'relief', name: 'Terrain relief', fmt: (v) => `${Math.round(v * 1000).toLocaleString()} m` },
};
// as in the analog search's defaults: the shape of the land counts as much as the temperatures
const WEIGHTS = { temp_max: 2, temp_min: 1, temp_range: 1, slope: 2, relief: 2 };
// ... and the rain: the Moon and Mars are bone dry, so rain beyond a desert's (250 mm a year)
// counts against every spot alike (it lowers the % match, not the ranking)
const WET_WEIGHT = 2;

const rad = (d) => (d * Math.PI) / 180;
function km(R, lat1, lon1, lat2, lon2) {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest named place on the map within ~400 km, e.g. { name: 'Jezero', km: 120 }. */
export function nearestLandmark(world, lat, lon) {
  let best = null;
  for (const [name, la, lo] of LANDMARKS[world] ?? []) {
    const d = km(BODIES[world].radiusKm, lat, lon, la, lo);
    if (d <= 400 && (!best || d < best.km)) best = { name, km: d };
  }
  return best;
}

/**
 * Finds the Moon and Mars spots most like an Earth place.
 * index: the overlays index.json. Resolves to null for a place without land data, else
 * { place, worlds: { mars: { results, best, close, relative, targets }, moon: {...} } }
 * with results [{ lat, lon, match (%), values: {tmax, ...}, landmark }].
 */
export async function findEquivalents({ lat, lon, radiusKm, index, count = 3, onProgress, worlds: only = WORLDS }) {
  onProgress?.('Reading this place on Earth…');
  const place = await earthPlace(lat, lon, radiusKm);
  if (!place) return null;
  const worlds = {};
  for (const world of only) {
    const layers = index[world] ?? {};
    const targets = Object.fromEntries(Object.entries(SHARED).map(([k, s]) => [s.layer, { value: place[k], pct: place.pct[k] }]));
    const found = await findMatches({
      body: world, sphereKm: BODIES[world].radiusKm, layers, weights: WEIGHTS, targets,
      always: ['slope', 'relief'], radiusKm, count, onProgress,
    });
    const back = (vals) => Object.fromEntries(Object.entries(SHARED).map(([k, s]) => [k, vals[s.layer]]));
    const totalW = found.used.reduce((a, k) => a + WEIGHTS[k], 0);
    const withRain = (score) => Math.sqrt((score ** 2 * totalW + WET_WEIGHT * place.wetness ** 2) / (totalW + WET_WEIGHT));
    const results = found.results.map((r) => ({
      lat: r.lat, lon: r.lon, match: similarity(withRain(r.score)), values: back(r.values), landmark: nearestLandmark(world, r.lat, r.lon),
    }));
    const best = results[0]?.match ?? 0;
    worlds[world] = {
      results, best, close: best >= CLOSE_MATCH,
      relative: Object.fromEntries(Object.entries(SHARED).filter(([, s]) => s.layer in found.relative).map(([k, s]) => [k, found.relative[s.layer]])),
      targets: back(found.targets),
    };
  }
  return { place, worlds };
}
