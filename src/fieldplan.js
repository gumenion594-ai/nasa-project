// Field campaign logistics for an Earth analog site: what kind of place it is (polar, high
// altitude, desert ...), how it is reached, the camp, and the yearly logistics. Used by
// Simulation Planning (src/simplan/).
//
// IMPORTANT: every price here is a rough planning figure (order of magnitude, 2025 US
// dollars) chosen by the app's authors from typical prices of such equipment and field
// logistics. They are NOT quotes and not from a NASA data set; real costs depend on the
// country, the national programme and the season. The app says so next to the numbers.
//
// The plan depends on the place: its climate and altitude (from the Earth search grid),
// its latitude, whether it is in Antarctica, and on the world it stands in for.
import { loadEarthGrid } from './analogs.js';

export const PERSON_YEAR_USD = 130000; // loaded cost of one person for a year (salary + overheads)

// Kinds of place: what getting there and living there takes.
//   field: people in the field; weeks: length of the yearly campaign;
//   personYears: the whole team's work in a year (preparation, campaign, analysis)
export const KINDS = {
  antarctic: { name: 'Antarctic deep-field site', field: 8, weeks: 6, personYears: 6,
    access: 'Reached only in the southern summer, through a national Antarctic programme (ship or aircraft, then ski-plane or traverse).',
    camp: ['Polar field camp', 'insulated tents, stoves, sleds, polar clothing, crevasse and rescue gear', 180000],
    logistics: [['Antarctic programme logistics', 'flights or ship berths, ski-plane hours, fuel depots, waste removal', 1500000],
      ['Freight', 'shipping the equipment south and back', 80000],
      ['Permits, insurance, medical evacuation cover', 'Antarctic Treaty permit and environmental assessment', 60000]] },
  polar: { name: 'Arctic / polar site', field: 8, weeks: 4, personYears: 5,
    access: 'Reached in summer by chartered ski- or tundra-wheel aircraft from the nearest settlement.',
    camp: ['Polar field camp', 'insulated tents, stoves, polar clothing, bear-safety gear', 120000],
    logistics: [['Charter aircraft and fuel caches', 'e.g. Twin Otter flights for people and cargo', 350000],
      ['Freight', 'air and sea freight to the staging settlement', 50000],
      ['Permits, insurance, medical evacuation cover', 'research and land-use permits', 40000]] },
  highalt: { name: 'High-altitude site', field: 8, weeks: 4, personYears: 5,
    access: 'Reached by 4x4 on mountain tracks; the team needs days to get used to the thin air.',
    camp: ['High-altitude camp', 'four-season tents, heating, bottled oxygen, pressure bag for altitude sickness', 70000],
    logistics: [['4x4 vehicles, drivers and fuel', 'including acclimatisation days on the way up', 90000],
      ['Freight', 'shipping and customs', 40000],
      ['Permits, insurance, medical evacuation cover', 'research permits, high-altitude rescue cover', 25000]] },
  hotdesert: { name: 'Hot desert site', field: 8, weeks: 4, personYears: 4.5,
    access: 'Reached by 4x4 convoy; all water and fuel is trucked in.',
    camp: ['Desert camp', 'shade structures, cooling for people and electronics, water storage', 50000],
    logistics: [['4x4 vehicles, water and fuel trucking', 'convoy with a support truck', 80000],
      ['Freight', 'shipping and customs', 40000],
      ['Permits, insurance, medical evacuation cover', 'research permits, heat-illness cover', 20000]] },
  colddesert: { name: 'Cold or temperate desert site', field: 8, weeks: 4, personYears: 4.5,
    access: 'Reached by 4x4; water and fuel are brought along.',
    camp: ['Desert camp', 'wind-proof tents, heating, water storage', 40000],
    logistics: [['4x4 vehicles, water and fuel', 'convoy with a support truck', 70000],
      ['Freight', 'shipping and customs', 40000],
      ['Permits, insurance, medical evacuation cover', 'research permits', 20000]] },
  other: { name: 'Accessible site', field: 6, weeks: 3, personYears: 3.5,
    access: 'Reached by road; supplies are available in the region.',
    camp: ['Field camp', 'tents or rented base, basic field kitchen', 30000],
    logistics: [['Vehicles and fuel', 'rented 4x4s', 40000],
      ['Freight', 'shipping', 20000],
      ['Permits, insurance, medical evacuation cover', 'research permits', 15000]] },
};

export function kindOf({ lat, altKm, rainMm, tmax, tmin }) {
  if (lat <= -60) return 'antarctic';
  if (Math.abs(lat) >= 60 && tmin <= -25) return 'polar';
  if (altKm >= 3.5) return 'highalt';
  if (rainMm < 250 && tmax >= 40) return 'hotdesert';
  if (rainMm < 250) return 'colddesert';
  return 'other';
}

/** Index of the Earth grid cell at a place (its 0.5 degree cell, or the nearest land cell), or -1. */
export function nearestCell(g, lat, lon) {
  const { width: W, height: H, res, dense } = g;
  const r0 = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / res)));
  const c0 = Math.floor((lon + 180) / res);
  let k = -1; let best = Infinity;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const r = r0 + dr; if (r < 0 || r >= H) continue;
      const i = r * W + (((c0 + dc) % W) + W) % W;
      const d = dr * dr + dc * dc;
      if (Number.isFinite(dense.tmax[i]) && d < best) { best = d; k = i; }
    }
  }
  return k;
}

// Values of the Earth search grid at a place
export async function placeValues(lat, lon) {
  const g = await loadEarthGrid();
  const { dense } = g;
  const k = nearestCell(g, lat, lon);
  if (k < 0) return null;
  return { tmax: dense.tmax[k], tmin: dense.tmin[k], altKm: dense.alt[k], rainMm: 10 ** dense.dry[k] - 1, uv: dense.uv[k] };
}
