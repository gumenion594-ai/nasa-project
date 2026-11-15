// Simulation Planning: what it would take to recreate a Moon or Mars site's environment at an
// Earth analog. Works out, for the selected Earth place and the selected Moon / Mars site:
//   * the environmental gaps (the app's own data where it has it, NASA facts otherwise),
//   * which equipment closes each gap (only for gaps that exist; src/simplan/catalog.js),
//   * prioritised recommendations, with how much closer each brings the place,
//   * the cost (initial investment, yearly running costs, one simulation campaign) as ranges,
//   * the people needed to prepare and run it.
// Pure computation: panel.js renders the result.
import { PARAMS, displayValue, formatValue, formatSite, gapOf, loadEarthGrid, similarity } from '../analogs.js';
import { STRONG_GAP, WEAK_GAP } from '../reportcard.js';
import { KINDS, kindOf, nearestCell } from '../fieldplan.js';
import { WORLD, SOURCES, earthPressureAt } from './facts.js';
import { ITEMS, ROLES, itemFor } from './catalog.js';

// ---- assumptions (shown in the panel) -------------------------------------------------------
export const ASSUME = {
  personYear: [90e3, 160e3],   // loaded cost of one person for a year (salary + overheads)
  installShare: [0.1, 0.25],   // installation and commissioning, share of the purchase price
  freightShare: [0.05, 0.1],   // shipping equipment to the site, share of the purchase price
  gridKwh: [0.1, 0.3],         // electricity from the grid, $/kWh
  dieselKwh: [0.3, 0.8],       // electricity from diesel generators at remote sites, $/kWh
  hall: [300e3, 1.5e6],        // a test hall (~500 m², power, crane rails) for chambers and the offload rig
  generatorPerKw: [300, 800],  // generators for remote sites, $ per kW of peak load (+50% reserve)
  gridConnection: [10e3, 100e3],
  logistics: [0.7, 1.3],       // the field-logistics planning figures (src/fieldplan.js) as a range
};
const FEASIBILITY = { outdoor: 1, equipment: 0.75, facility: 0.5 };
export const SETTINGS = {
  outdoor: { label: 'Outdoors', help: 'can be recreated at the site itself' },
  equipment: { label: 'Equipment', help: 'needs special equipment at the site' },
  facility: { label: 'Facility only', help: 'only in a chamber or a dedicated facility' },
};

// ---- Earth values at a place --------------------------------------------------------------------
const spreadCache = {};
function gridSpread(g, k) {
  if (spreadCache[k] !== undefined) return spreadCache[k];
  const col = g.dense[PARAMS[k].field];
  const v = Float32Array.from(g.idx, (i) => col[i]).filter(Number.isFinite).sort();
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  spreadCache[k] = Math.max(1e-6, q(0.95) - q(0.05));
  return spreadCache[k];
}

const statusOf = (gap) => (!Number.isFinite(gap) ? 'na' : gap <= STRONG_GAP ? 'match' : gap < WEAK_GAP ? 'partial' : 'gap');
const sign = (x, unit, more, less) => `${Math.abs(x) < 0.5 ? 'about the same' : `${Math.round(Math.abs(x))}${unit} ${x > 0 ? more : less}`}`;

/**
 * The whole plan. ctx: { from: 'moon'|'mars', worldName, siteName, res (one findAnalogs result,
 * with lat, lon, values, score, country), site (site values), found (findAnalogs answer), weights }
 */
export async function simulationPlan({ from, worldName, res, site, found, weights }) {
  const g = await loadEarthGrid();
  const cell = nearestCell(g, res.lat, res.lon);
  const W = WORLD[from];
  const used = found.used ?? [];
  const earthRaw = (k) => (Number.isFinite(res.values?.[k]) ? res.values[k] : cell >= 0 ? g.dense[PARAMS[k].field][cell] : NaN);
  const spreadOf = (k) => found.spreads?.[k] ?? gridSpread(g, k);
  const altKm = cell >= 0 ? g.dense.alt[cell] : 0;
  const rainMm = displayValue('dry', earthRaw('dry'));
  const kindKey = kindOf({ lat: res.lat, altKm, rainMm, tmax: displayValue('tmax', earthRaw('tmax')), tmin: displayValue('tmin', earthRaw('tmin')) });
  const kind = KINDS[kindKey];

  const rows = [];
  const add = (row) => { rows.push({ items: [], keys: [], ...row }); };

  // ---- temperatures (app data: Moon / Mars temperature layers, NASA POWER on Earth)
  // Mars nights below -70 °C need liquid-nitrogen cooling (the Mars chamber); a climatic chamber does the rest
  const chamberFor = (k) => (from === 'moon' ? 'tvac' : k !== 'tmax' && site.tmin < -70 ? 'marschamber' : 'climate');
  for (const k of ['tmax', 'tmin', 'swing']) {
    const e = earthRaw(k); const s = site[k];
    if (!Number.isFinite(e) || !Number.isFinite(s)) continue;
    const diff = e - s;
    const gap = Math.abs(diff) / spreadOf(k);
    const beyond = k in (found.relative ?? {});
    const item = chamberFor(k);
    const word = k === 'swing' ? ['larger', 'smaller'] : ['warmer', 'colder'];
    add({ id: k, name: PARAMS[k].name, earth: formatValue(k, e), target: formatSite(k, s),
      diff: `here ${sign(diff, ' °C', word[0], word[1])}`, status: statusOf(gap), gap,
      setting: ITEMS[item].setting, keys: [k], items: gap > STRONG_GAP ? [item] : [],
      note: beyond ? `${worldName}’s value is beyond anything on Earth: only a chamber reaches it.` : '',
      rec: gap > STRONG_GAP && {
        title: k === 'swing' ? 'Recreate the day–night temperature cycle' : diff > 0 ? `Cool test pieces to ${worldName}’s ${k === 'tmax' ? 'daytime' : 'night-time'} temperatures` : `Warm test pieces to ${worldName}’s ${k === 'tmax' ? 'daytime' : 'night-time'} temperatures`,
        lacking: `${PARAMS[k].name}: here ${formatValue(k, e)}, ${worldName} ${formatSite(k, s)}.`,
        change: k === 'swing' ? `Cycle between ${worldName}’s day and night temperatures on its day length.`
          : `${diff > 0 ? 'Lower' : 'Raise'} the temperature of test pieces by ~${Math.round(Math.abs(diff))} °C. Outdoors this can’t be done for a whole area: it needs a chamber.`,
        scope: 'inside the chamber',
      } });
  }

  // ---- air pressure and composition (NASA fact sheets; Earth's from the altitude)
  const pEarth = earthPressureAt(altKm);
  const airItem = from === 'moon' ? 'tvac' : 'marschamber';
  add({ id: 'pressure', name: 'Air pressure', earth: `${Math.round(pEarth)} hPa (at ${altKm.toFixed(1)} km altitude)`, target: W.pressureText,
    diff: from === 'moon' ? 'Earth has air; the Moon has none' : `${Math.round(pEarth / W.pressureHpa)}× too high`, status: 'gap', gap: 2,
    setting: 'facility', items: [airItem], sources: W.sources.map((s) => SOURCES[s]), importance: 2,
    note: altKm >= 3 ? `At ${altKm.toFixed(1)} km the air is already ${Math.round((1 - pEarth / 1013) * 100)}% thinner than at sea level, still far from ${worldName}.` : '',
    rec: { title: from === 'moon' ? 'Test in vacuum' : 'Test in Mars air: CO₂ at ~6 hPa',
      lacking: `Air pressure: here ${Math.round(pEarth)} hPa, ${worldName} ${W.pressureText}; air: ${WORLD.earth.air} instead of ${W.air}.`,
      change: from === 'moon' ? 'Pump the air out around test pieces (and suited people).' : 'Replace the air around test pieces with carbon dioxide at Mars pressure. People enter only in suits or with breathing apparatus.',
      scope: 'inside the chamber',
      improvement: `Closes the whole pressure and composition gap, but only inside the chamber: ${from === 'moon' ? 'vacuum' : '~6 hPa of CO₂'} for whatever fits in it.` } });
  add({ id: 'air', name: 'Atmosphere', earth: WORLD.earth.air, target: W.air, diff: 'different gas', status: 'gap', gap: 2,
    setting: 'facility', items: [airItem], note: 'Recreated together with the pressure.' });

  // ---- gravity (NASA fact sheets)
  add({ id: 'gravity', name: 'Gravity', earth: `${WORLD.earth.g} m/s² (1 g)`, target: `${W.g} m/s² (${(W.g / WORLD.earth.g).toFixed(2)} g)`,
    diff: `${Math.round((1 - W.g / WORLD.earth.g) * 100)}% less needed`, status: 'gap', gap: 2, setting: 'facility',
    items: ['offload', 'parabolic'], importance: 2, sources: W.sources.slice(0, 1).map((s) => SOURCES[s]),
    rec: { title: `Simulate ${worldName}’s gravity`,
      lacking: `Gravity: Earth’s 1 g everywhere; ${worldName} ${(W.g / WORLD.earth.g).toFixed(2)} g.`,
      change: `Carry ${Math.round((1 - W.g / WORLD.earth.g) * 100)}% of the weight of people and rovers with an offload crane; use parabolic flights for short whole-body tests.`,
      scope: 'on the rig / in flight',
      improvement: 'The rig gives the full partial gravity, but only for one person or rover hanging from it; parabolic flights give it to everything on board, for 20–30 s at a time. No place on Earth can change gravity.' } });

  // ---- radiation (Curiosity RAD, Chang'e 4, UNSCEAR)
  const ratio = W.doseDay / WORLD.earth.doseDay;
  add({ id: 'radiation', name: 'Radiation dose', earth: `~${(WORLD.earth.doseDay * 365).toFixed(1)} mSv a year (world average)`,
    target: `~${W.doseDay} mSv a day (~${Math.round(W.doseDay * 365)} mSv a year)`, diff: `~${Math.round(ratio)}× more needed`,
    status: 'gap', gap: 2, setting: 'facility', items: ['radbeam', 'dosimeters'], importance: 1.5,
    sources: [SOURCES.unscear, SOURCES[from === 'moon' ? 'zhang' : 'hassler']],
    note: 'High places get somewhat more cosmic radiation; still a tiny fraction of the target.',
    rec: { title: 'Radiation tests at an accelerator',
      lacking: `Radiation: ~${Math.round(ratio)}× Earth’s natural dose on ${worldName}, from cosmic rays and solar particles that Earth’s air and magnetic field stop.`,
      change: 'Expose samples, electronics and shielding to heavy-ion and proton beams; measure the doses on site with dosimeters. This is not done to people.',
      scope: 'in the beam',
      improvement: 'Reproduces the kind of radiation and its dose for samples in the beam; the field site itself stays at Earth’s level.' } });

  // ---- sunlight (app data: Sunlight layer on the Moon / Mars; NASA POWER on Earth) and UV
  const sunE = displayValue('sun', earthRaw('sun')); const sunS = site.sun;
  if (Number.isFinite(sunE) && Number.isFinite(sunS)) {
    const r = sunE / sunS;
    const st = Math.abs(Math.log(r)) < Math.log(1.15) ? 'match' : Math.abs(Math.log(r)) < Math.log(1.4) ? 'partial' : 'gap';
    const tooBright = r > 1;
    const item = tooBright && from === 'mars' ? 'shade' : 'solarsim';
    add({ id: 'sun', name: 'Sunlight (yearly average on the ground)', earth: `${Math.round(sunE)} W/m²`, target: `${Math.round(sunS)} W/m²`,
      diff: `here ${Math.round(Math.abs(r - 1) * 100)}% ${tooBright ? 'more' : 'less'}`, status: st, gap: Math.abs(Math.log(r)),
      setting: ITEMS[item].setting, items: st === 'match' ? [] : [item], keys: [],
      rec: st !== 'match' && {
        title: tooBright ? `Cut the sunlight to ${worldName}’s level` : `Add ${worldName}’s stronger, unfiltered sunlight`,
        lacking: `Sunlight: here ${Math.round(sunE)} W/m² a year on average, ${worldName} ${Math.round(sunS)} W/m².`,
        change: tooBright ? `Shade the test area by ~${Math.round((1 - 1 / r) * 100)}%.` : 'Light test pieces with a solar simulator (in the vacuum chamber).',
        scope: tooBright ? 'under the shade' : 'under the lamps',
        improvement: tooBright ? `Brings the light on the test area to ${worldName}’s average (${Math.round(sunS)} W/m²) under the shade.` : 'Gives the full space sunlight, but only under the lamps.' } });
  }
  const uvE = displayValue('uv', earthRaw('uv'));
  add({ id: 'uv', name: 'Ultraviolet', earth: Number.isFinite(uvE) ? `UV index ${uvE.toFixed(1)} (ozone layer filters UV-C)` : 'ozone layer filters UV-C',
    target: from === 'mars' ? 'UV-C reaches the ground (no ozone layer)' : 'full solar UV (no atmosphere)', diff: 'short-wave UV missing',
    status: 'gap', gap: 1, setting: from === 'mars' ? 'equipment' : 'facility', items: [from === 'mars' ? 'uvlamps' : 'solarsim'], importance: 0.8,
    sources: from === 'mars' ? [SOURCES.cockell] : [],
    rec: { title: from === 'mars' ? 'Add Mars’s UV-C' : 'Add the Moon’s unfiltered UV',
      lacking: `Ultraviolet: Earth’s ozone layer absorbs UV-C, which reaches the surface of ${worldName}.`,
      change: from === 'mars' ? 'Irradiate samples with UV-C lamps.' : 'Use the solar simulator’s full spectrum in the vacuum chamber.',
      scope: 'under the lamps', improvement: 'Reproduces the missing short-wave UV for samples under the lamps.' } });

  // ---- day length (NASA fact sheets)
  add({ id: 'day', name: 'Day and night', earth: WORLD.earth.day, target: W.day,
    diff: from === 'mars' ? 'nearly the same' : '~30× longer days and nights', status: from === 'mars' ? 'match' : 'gap', gap: from === 'mars' ? 0 : 1.5,
    setting: from === 'mars' ? 'outdoor' : 'facility', items: from === 'mars' ? [] : ['solarsim'], importance: 0.6,
    rec: from === 'moon' && { title: 'Two-week days and nights',
      lacking: 'Day length: the Moon’s day lasts ~29.5 Earth days.',
      change: 'Run long-duration tests indoors under controlled lighting (solar simulator), or in the dark for the lunar night.',
      scope: 'indoors', improvement: 'Full control of the day–night cycle, indoors only.' } });

  // ---- terrain (app data: slope and relief, Moon / Mars DEMs and ETOPO 2022)
  for (const k of ['slope', 'relief']) {
    const e = earthRaw(k); const s = site[k];
    if (!Number.isFinite(e) || !Number.isFinite(s)) continue;
    const gap = Math.abs(e - s) / spreadOf(k);
    const rougher = e > s;
    add({ id: k, name: PARAMS[k].name, earth: formatValue(k, e), target: formatSite(k, s),
      diff: `here ${gap <= STRONG_GAP ? 'slightly ' : ''}${rougher ? 'rougher' : 'smoother'}`, status: statusOf(gap), gap, setting: 'outdoor', keys: [k],
      items: gap > STRONG_GAP ? ['earthworks'] : [],
      rec: gap > STRONG_GAP && { title: rougher ? 'Build a smoother test field' : 'Add rocky, cratered terrain',
        lacking: `${PARAMS[k].name}: here ${formatValue(k, e)}, ${worldName} ${formatSite(k, s)}.`,
        change: rougher ? 'Level a test field and fill gullies, or pick the flattest part of the area.' : 'Place boulder fields, mounds and crater pits on the test field.',
        scope: 'on the test field' } });
  }

  // ---- surface: bare ground (MODIS) and regolith (fixed)
  const bareE = earthRaw('bare');
  if (Number.isFinite(bareE)) {
    const gap = gapOf('bare', bareE, PARAMS.bare.limit, spreadOf('bare'), { better: 'high', limit: PARAMS.bare.limit });
    add({ id: 'bare', name: 'Bare ground', earth: formatValue('bare', bareE), target: '100% (no plants)',
      diff: bareE >= PARAMS.bare.limit ? 'mostly bare' : 'vegetated', status: statusOf(gap), gap, setting: 'outdoor', keys: ['bare'],
      items: gap > STRONG_GAP ? ['earthworks'] : [],
      rec: gap > STRONG_GAP && { title: 'Clear the test field of vegetation',
        lacking: `Bare ground: only ${formatValue('bare', bareE)} of the area is bare (MODIS land cover).`,
        change: 'Clear plants from the test field and cover it with crushed rock or simulant (with the permits this needs).', scope: 'on the test field' } });
  }
  add({ id: 'regolith', name: 'Surface material', earth: 'soil weathered by water, wind and life',
    target: from === 'moon' ? 'sharp, glassy, unweathered regolith' : 'basaltic regolith with perchlorates', diff: 'different material',
    status: 'partial', gap: 0.4, setting: 'outdoor', items: ['simulant'], importance: 1.2,
    rec: { title: `Lay a bed of ${worldName} regolith simulant`,
      lacking: `Surface material: Earth soil is weathered and full of life; ${worldName}’s regolith isn’t.`,
      change: 'Cover the test field with crushed basalt, and use research-grade simulant where wheels, drills and tools touch the ground.',
      scope: 'on the test bed', improvement: from === 'mars'
        ? 'Wheels, drills and tools meet ground with the right grain sizes and minerals; Mars’s perchlorate chemistry only if it is added to the simulant.'
        : 'Wheels, drills and tools meet ground with the right grain sizes and minerals; the dust only clings and charges like lunar dust in vacuum.' } });

  // ---- dryness (NASA POWER rain)
  const dryE = earthRaw('dry');
  if (Number.isFinite(dryE)) {
    const gap = gapOf('dry', dryE, PARAMS.dry.limit, spreadOf('dry'), { better: 'low', limit: PARAMS.dry.limit });
    add({ id: 'dry', name: 'Rain', earth: formatValue('dry', dryE), target: 'none', diff: displayValue('dry', dryE) < 250 ? 'desert-dry' : gap > STRONG_GAP ? 'wetter than a desert' : 'just above desert-dry',
      status: statusOf(gap), gap, setting: 'outdoor', keys: ['dry'], items: gap > STRONG_GAP ? ['cover'] : [],
      rec: gap > STRONG_GAP && { title: 'Keep the test bed dry', lacking: `Rain: ${formatValue('dry', dryE)} here; none on ${worldName}.`,
        change: 'Put the test bed under a tunnel hall and run dehumidifiers.', scope: 'under the cover' } });
  }

  // ---- frozen ground (Mars only: Odyssey ice map vs NASA POWER ground temperature)
  if (from === 'mars' && Number.isFinite(site.frozen)) {
    const e = earthRaw('frozen');
    const rule = found.rules?.frozen ?? PARAMS.frozen.rule(site.frozen);
    const wantsFrozen = rule.better === 'low';
    const gap = gapOf('frozen', e, 0, spreadOf('frozen'), rule);
    const fixable = wantsFrozen && gap > 0;
    add({ id: 'frozen', name: 'Frozen ground', earth: `${formatValue('frozen', e)} yearly mean ground temperature`,
      target: wantsFrozen ? 'ice-rich ground' : 'dry ground, no ice', diff: gap === 0 ? 'same state' : wantsFrozen ? 'ground not frozen here' : 'permafrost here',
      status: gap === 0 ? 'match' : 'gap', gap: gap === 0 ? 0 : Math.max(gap, WEAK_GAP), setting: 'equipment', keys: ['frozen'],
      items: fixable ? ['freeze'] : [],
      rec: gap > 0 && { title: wantsFrozen ? 'Freeze an icy test pit' : 'Work on unfrozen ground',
        lacking: `Ground: ${worldName}’s site is ${wantsFrozen ? 'ice-rich' : 'dry'}; here the ground averages ${formatValue('frozen', e)} a year.`,
        change: wantsFrozen ? 'Freeze a pit of simulant mixed with water ice with chilled brine pipes.'
          : 'Permafrost can’t sensibly be thawed: test in the summer thaw layer, or on a heated, insulated pad.',
        scope: 'in the test pit' } });
  }

  // ---- dust (Mars: Mars Dust Activity Database vs MERRA-2; Moon: fixed)
  if (from === 'mars' && 'dust' in (found.targets ?? {})) {
    const e = earthRaw('dust');
    const t = found.targets.dust;
    const gap = Math.abs(e - t) / spreadOf('dust');
    const less = e < t;
    add({ id: 'dust', name: 'Dust in the air', earth: formatValue('dust', e), target: formatSite('dust', site.dust),
      diff: `here ${less ? 'less' : 'more'} dusty (by rank)`, status: statusOf(gap), gap, setting: 'equipment', keys: ['dust'],
      items: gap > STRONG_GAP && less ? ['dustwind'] : [],
      note: 'Compared by rank: as dusty for Earth as the site is for Mars.',
      rec: gap > STRONG_GAP && less && { title: 'Add dust storms', lacking: `Dust: the site has dust storms on ${Math.round(site.dust * 100)}% of days; this place is less dusty for Earth.`,
        change: 'Raise fine dust over the test area with fans and dust feeders.', scope: 'in the test area' } });
  } else if (from === 'moon') {
    add({ id: 'dust', name: 'Dust', earth: 'settles in air, rounded by weathering', target: 'sharp, clinging, electrostatically charged',
      diff: 'only in vacuum', status: 'gap', gap: 1, setting: 'facility', items: ['tvac', 'simulant'], note: 'Lunar dust only behaves like lunar dust in a vacuum chamber.' });
  }
  add({ id: 'wind', name: 'Wind', earth: 'no wind data in this app', target: from === 'moon' ? 'none' : 'winds in very thin air', diff: '–',
    status: 'na', gap: NaN, setting: null, note: 'Not available: the app has no Earth wind data yet.' });

  // ---- recommendations: importance x feasibility, with the match gain for search characteristics
  const totalW = used.reduce((a, k) => a + (weights[k] ?? 0), 0);
  const gapNow = (k) => gapOf(k, res.values[k], found.targets[k], found.spreads[k], found.rules?.[k]);
  const scoreWithout = (zero) => Math.sqrt(used.reduce((a, k) => a + (zero.includes(k) ? 0 : (weights[k] ?? 0) * gapNow(k) ** 2), 0) / (totalW || 1));
  const base = totalW ? similarity(scoreWithout([])) : null;
  const recs = rows.filter((r) => r.rec).map((r) => {
    const keys = r.keys.filter((k) => used.includes(k));
    let improvement = r.rec.improvement ?? '';
    if (keys.length && base !== null) {
      const after = similarity(scoreWithout(keys));
      if (after > base) improvement = `Raises the match from ${base}% to ${after}% ${r.rec.scope}. ${improvement}`.trim();
    }
    if (!improvement) improvement = `Closes the ${r.name.toLowerCase()} gap ${r.rec.scope}.`;
    const importance = r.importance ?? (keys.length ? Math.max(...keys.map((k) => weights[k] ?? 1)) : 1) * Math.min(2, r.gap || 1);
    const priority = importance * FEASIBILITY[r.setting];
    return { ...r.rec, row: r, items: r.items, improvement, priority, setting: r.setting };
  }).sort((a, b) => b.priority - a.priority);
  recs.forEach((r) => { r.level = r.priority >= 1.2 ? 'High' : r.priority >= 0.6 ? 'Medium' : 'Low'; });

  // ---- equipment: every item some gap needs, with the reasons
  const why = new Map();
  for (const r of rows) for (const id of r.items) {
    if (!why.has(id)) why.set(id, []);
    why.get(id).push(r.name);
  }
  const equipment = [...why.keys()].map((id) => ({ ...itemFor(id, from), why: why.get(id) }));

  return { from, worldName, kindKey, kind, altKm, rows, recs, equipment, ...costsAndTeam(equipment, kind, kindKey) };
}

// ---- costs and people ---------------------------------------------------------------------------
const R = (lo, hi = lo) => [lo, hi];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, f) => (Array.isArray(f) ? [a[0] * f[0], a[1] * f[1]] : [a[0] * f, a[1] * f]);

function costsAndTeam(equipment, kind, kindKey) {
  const remote = kindKey !== 'other';
  const capex = equipment.reduce((a, it) => (it.cost ? add2(a, R(it.cost.lo, it.cost.hi)) : a), R(0));
  const perCampaign = equipment.reduce((a, it) => (it.perCampaign ? add2(a, R(it.perCampaign.lo, it.perCampaign.hi)) : a), R(0));
  const opex = equipment.reduce((a, it) => (it.opex ? add2(a, R(it.opex.lo, it.opex.hi)) : a), R(0));
  const kw = equipment.reduce((a, it) => a + (it.kw ?? 0), 0);
  const kwh = equipment.reduce((a, it) => a + (it.kw ?? 0) * (it.hours ?? 0), 0);
  const needsHall = equipment.some((it) => it.hall);
  const ap = ASSUME;

  const install = mul(capex, ap.installShare);
  const freight = mul(capex, ap.freightShare);
  const hall = needsHall ? R(...ap.hall) : R(0);
  const power = kw ? (remote ? mul(R(...ap.generatorPerKw), kw * 1.5) : R(...ap.gridConnection)) : R(0);
  const camp = mul(R(kind.camp[2]), ap.logistics);
  const energy = mul(R(kwh), remote ? ap.dieselKwh : ap.gridKwh);
  const fieldLogistics = mul(R(kind.logistics.reduce((a, l) => a + l[2], 0) + kind.field * (kindKey === 'antarctic' ? 8000 : 4000)), ap.logistics);

  // people
  const prepPM = {}; const ops = {};
  for (const it of equipment) {
    for (const [r, v] of Object.entries(it.prep ?? {})) prepPM[r] = (prepPM[r] ?? 0) + v;
    for (const [r, v] of Object.entries(it.ops ?? {})) ops[r] = (ops[r] ?? 0) + v;
  }
  // every simulation has a lead and at least one specialist running it, and a geologist for the site
  prepPM.mission = (prepPM.mission ?? 0) + 3; ops.mission = Math.max(1, (ops.mission ?? 0) + 1);
  ops.geo = Math.max(0.5, ops.geo ?? 0);
  const lead = Math.max(3, ...equipment.map((it) => it.lead ?? 0));
  const prepMonths = R(lead, lead + (needsHall ? 6 : 0) + 2); // hall construction, commissioning
  const prepPeople = {}; const opsPeople = {};
  const midMonths = (prepMonths[0] + prepMonths[1]) / 2;
  for (const r of Object.keys(ROLES)) {
    if (prepPM[r]) prepPeople[r] = Math.max(1, Math.ceil(prepPM[r] / midMonths));
    if (ops[r]) opsPeople[r] = Math.max(1, Math.ceil(ops[r]));
  }
  const team = Object.keys(ROLES).filter((r) => prepPeople[r] || opsPeople[r]).map((r) => ({
    role: r, ...ROLES[r], prep: prepPeople[r] ?? 0, ops: opsPeople[r] ?? 0, prepPM: prepPM[r] ?? 0, opsFte: ops[r] ?? 0,
    items: equipment.filter((it) => it.prep?.[r] || it.ops?.[r]).map((it) => it.name),
  }));
  const sumPM = Object.values(prepPM).reduce((a, b) => a + b, 0);
  const sumFte = Object.values(ops).reduce((a, b) => a + b, 0);
  const prepStaff = mul(R(...ap.personYear), sumPM / 12);
  const opsStaff = mul(R(...ap.personYear), sumFte);
  const campaignTeam = mul(R(...ap.personYear), (kind.field * kind.weeks) / 52);

  const initial = [['Equipment purchase', capex], ['Installation and commissioning', install], ['Infrastructure: test hall', hall],
    ['Infrastructure: power supply', power], ['Infrastructure: field camp', camp], ['Transport of equipment to the site', freight],
    ['Preparation staff', prepStaff]].filter(([, v]) => v[1] > 0);
  const recurring = [['Maintenance and consumables', opex], ['Energy', energy], ['Operating staff', opsStaff]].filter(([, v]) => v[1] > 0);
  const campaign = [['Facility time and flights (beam time, parabolic flights)', perCampaign], ['Travel, transport, permits and insurance', fieldLogistics],
    [`Field team (${kind.field} people for ${kind.weeks} weeks)`, campaignTeam]].filter(([, v]) => v[1] > 0);
  const total = (list) => list.reduce((a, [, v]) => add2(a, v), R(0));
  const T = { initial: total(initial), recurring: total(recurring), campaign: total(campaign) };
  T.firstYear = add2(add2(T.initial, T.recurring), T.campaign);
  return {
    costs: { initial, recurring, campaign, totals: T, kw, kwh, remote, needsHall },
    team, prepMonths, people: {
      prep: team.reduce((a, t) => a + t.prep, 0), ops: team.reduce((a, t) => a + t.ops, 0),
      total: team.reduce((a, t) => a + Math.max(t.prep, t.ops), 0), field: kind.field, weeks: kind.weeks,
    },
  };
}
