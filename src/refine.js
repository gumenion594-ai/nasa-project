// Fine-scale analogs: the search grid has 0.5° cells (~50 km), so for small selection circles a
// result is just "somewhere in this cell". This moves each result, within its cell, to the spot
// whose terrain matches the site best, using the Earth slope tiles (Web Mercator, zoom 5: ~5 km
// pixels at the equator, ~2.5 km at 60°). Climate data is ~50 km, so only the terrain is redone.
import { summarize } from './areastats.js';
import { gapOf } from './analogs.js';

export const REFINE_BELOW_KM = 25;  // refine results for selection radii under this
const SEARCH_DEG = 0.3;             // look this far around the cell centre (cells are ±0.25°)
const MAX_STEPS = 13;               // at most 13 x 13 candidate centres per result
const EARTH_R = 6371.0;

/**
 * Refine `results` (from findAnalogs) in place. Each result gets `refined` = { km } (how far it
 * moved) or stays as it was where nothing better is found. `slopeMeta`: the Earth slope layer's
 * index entry. Only the slope term of the score changes; relief stays at the cell value
 * (its ~9 km blocks don't resolve at this scale).
 */
export async function refineResults({ results, found, weights, radiusKm, slopeMeta }) {
  const { used, targets, spreads, rules } = found;
  if (radiusKm >= REFINE_BELOW_KM || !used.includes('slope') || !slopeMeta) return;
  const totalW = used.reduce((a, k) => a + weights[k], 0);
  const stepKm = Math.max(radiusKm / 2, 3);
  for (const res of results) {
    const base = res.score ** 2 * totalW - weights.slope * gapOf('slope', res.values.slope, targets.slope, spreads.slope, rules.slope) ** 2;
    const latStep = (stepKm / EARTH_R) * (180 / Math.PI);
    const n = Math.min(MAX_STEPS, Math.ceil((2 * SEARCH_DEG) / latStep) + 1);
    const cellLat = Math.round((res.lat - 0.25) * 2) / 2 + 0.25; // centre of the result's 0.5° cell
    const cellLon = Math.round((res.lon - 0.25) * 2) / 2 + 0.25;
    const cosLat = Math.max(0.2, Math.cos((cellLat * Math.PI) / 180));
    let best = null;
    const jobs = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const lat = cellLat - SEARCH_DEG + (i * 2 * SEARCH_DEG) / (n - 1);
        const lon = cellLon + (-SEARCH_DEG + (j * 2 * SEARCH_DEG) / (n - 1)) / cosLat;
        jobs.push(summarize('earth', 'slope', slopeMeta, lat, lon, radiusKm, EARTH_R).then((s) => {
          // skip mostly-sea circles: at least half the pixels the circle holds must be land
          if (s.none || !Number.isFinite(s.logMean)) return;
          const pxKm = (2 * Math.PI * EARTH_R) / (256 * 2 ** slopeMeta.max_zoom) * Math.cos((lat * Math.PI) / 180);
          const expected = (Math.PI * radiusKm ** 2) / pxKm ** 2;
          if (expected > 2 && s.pixels < expected / 2) return;
          const g = gapOf('slope', s.logMean, targets.slope, spreads.slope, rules.slope);
          const score = Math.sqrt(Math.max(0, base + weights.slope * g * g) / totalW);
          if (!best || score < best.score) best = { lat, lon, score, logslope: s.logMean, pixels: s.pixels };
        }));
      }
    }
    await Promise.all(jobs);
    // keep the original place unless a spot is clearly better (avoid moving on noise)
    if (best && best.score < res.score - 0.005) {
      const km = distance(res.lat, res.lon, best.lat, best.lon);
      Object.assign(res, { lat: best.lat, lon: best.lon, score: best.score, refined: { km, from: [res.lat, res.lon] } });
      res.values = { ...res.values, slope: best.logslope };
    } else {
      res.refined = { km: 0 };
    }
  }
}

function distance(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}
