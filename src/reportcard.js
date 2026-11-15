// Analogy report card for one Earth analog result: where the analogy is strong, where it is
// weak, what was only matched relatively (the site is beyond anything on Earth), what was
// not compared at all, and what no place on Earth can reproduce.
import { PARAMS, formatValue, formatSite, gapOf } from './analogs.js';
import { nearestKnown, KNOWN_REGION_KM } from './knownAnalogs.js';

// Gap to the target in Earth spreads (5th-95th percentile of all of Earth's land), as in the score
export const STRONG_GAP = 0.15; // up to this: strong match
export const WEAK_GAP = 0.5;    // from this: weak match (in between: partial)

// Characteristics the Moon / Mars maps have that the Earth search can't compare (yet)
const NOT_IN_SEARCH = {
  moon: ['Surface material: dust vs rock (thermal inertia)', 'Iron content (minerals)',
    'Rock type and geology', 'Impact craters (shown below, not scored)'],
  mars: ['Surface material: dust vs rock (thermal inertia)', 'Iron content (minerals)',
    'Rock type and geology', 'Impact craters (shown below, not scored)'],
};

// What no place on Earth can reproduce
const EARTH_LIMITS = {
  moon: [
    ['Gravity', '1/6 of Earth’s: people, rovers and dust move differently'],
    ['Vacuum', 'no air: no wind or water weathering, no cooling by air, no protection from micrometeorites'],
    ['Radiation', 'no magnetic field or air: full cosmic rays and solar storms'],
    ['Day length', '~29.5 Earth days: two weeks of sunlight, then two weeks of night'],
    ['Regolith', 'sharp, glassy grains never rounded by water or wind; dust clings electrostatically'],
    ['Life', 'Earth has microbes almost everywhere; the Moon is sterile'],
  ],
  mars: [
    ['Gravity', '3/8 of Earth’s (0.38 g)'],
    ['Air', '~0.6% of Earth’s pressure, mostly CO₂: liquid water boils or freezes quickly'],
    ['Radiation', 'thin air, no global magnetic field: ~0.7 mSv a day measured by Curiosity, '
      + 'about a year of Earth’s natural dose every 3–4 days'],
    ['Soil chemistry', 'perchlorates and other oxidants throughout the soil (Phoenix lander)'],
    ['Life', 'Earth has microbes almost everywhere: good for testing instruments, but every sample is contaminated'],
  ],
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const km = (d) => `${Math.round(d).toLocaleString('en-US')} km`;
// 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 92nd ...
export const ordinal = (n) => {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th';
  return `${n}${s}`;
};

/** Is this result inside a known analog region, or new? { known, site, km, text } */
export function novelty(lat, lon) {
  const { site, km: d } = nearestKnown(lat, lon);
  const known = d < KNOWN_REGION_KM;
  return {
    known, site, km: d,
    text: known ? `Known analog region: ${km(d)} from ${site.name}` : `New: the nearest known analog, ${site.name}, is ${km(d)} away`,
  };
}

/**
 * HTML of the report card. from: 'moon' | 'mars'; res: one result of findAnalogs();
 * found: the whole findAnalogs() answer; weights: the search weights.
 */
export function reportCardHtml({ from, worldName, res, site, found, weights }) {
  const { used, targets, spreads, relative = {}, rules = {} } = found;
  const strong = []; const partial = []; const weak = []; const rel = [];
  for (const k of used) {
    const p = PARAMS[k];
    const v = res.values[k];
    const gap = gapOf(k, v, targets[k], spreads[k], rules[k]);
    if (k in relative) {
      const pct = Math.round(relative[k] * 100);
      rel.push(`<li><b>${esc(p.name)}</b>: ${worldName} ${formatSite(k, site[k])}, here ${formatValue(k, v)}. `
        + `<span class="rc-why">Only the rank matches: both are at about the ${ordinal(pct)} percentile of their own world.</span></li>`);
      continue;
    }
    let what;
    if (p.rule) {
      const wantsFrozen = rules[k]?.better === 'low';
      what = `${worldName} ${formatSite(k, site[k])}, so it looks for ${wantsFrozen ? 'frozen' : 'unfrozen'} ground; `
        + `here the ground averages ${formatValue(k, v)} over the year`;
    } else if (p.site) {
      what = `${worldName} ${formatSite(k, site[k])}, here ${formatValue(k, v)}`;
    } else {
      what = `${formatValue(k, v)} (${p.better === 'low' ? 'lower is better' : 'higher is better'}; no ${worldName} value)`;
    }
    const line = `<li><b>${esc(p.name)}</b>: ${what}</li>`;
    // frozen or not is a yes/no question: the wrong side of 0 °C is a weak match however close
    if (p.rule) (gap === 0 ? strong : weak).push(line);
    else (gap <= STRONG_GAP ? strong : gap < WEAK_GAP ? partial : weak).push(line);
  }
  const off = Object.keys(PARAMS).filter((k) => !used.includes(k))
    .map((k) => PARAMS[k].name + (PARAMS[k].worlds && !PARAMS[k].worlds.includes(from) ? ` (no ${worldName} equivalent)`
      : weights[k] > 0 ? ` (no ${worldName} data here)` : ' (switched off)'));
  const notCompared = [...off, ...(NOT_IN_SEARCH[from] ?? [])];
  const nov = novelty(res.lat, res.lon);

  const group = (cls, title, items) => (items.length
    ? `<div class="rc-group rc-${cls}"><p class="rc-head">${title}</p><ul>${items.join('')}</ul></div>` : '');
  return `<section class="report-card" aria-label="Analogy report card">
    <p class="c-title">How good is this analog?</p>
    ${res.refined?.km > 0.5 ? `<p class="sub rc-refined">Position refined with ~5 km terrain data: moved
      ${Math.round(res.refined.km)} km within its ~50 km search cell to where the slope matches best.</p>` : ''}
    <p class="rc-novelty ${nov.known ? 'known' : 'new'}">${esc(nov.text)}.
      <a href="${esc(nov.site.source)}" target="_blank" rel="noopener noreferrer">About ${esc(nov.site.name)}</a></p>
    ${group('strong', '✓ Strong match', strong)}
    ${group('partial', '≈ Partial match', partial)}
    ${group('weak', '✗ Weak match', weak)}
    ${group('rel', '↕ Matched only relatively (beyond anything on Earth)', rel)}
    ${group('none', '○ Not compared', notCompared.map((t) => `<li>${esc(t)}</li>`))}
    <div class="rc-features-slot"></div>
    <details class="rc-limits"><summary>What no place on Earth can reproduce</summary>
      <ul>${(EARTH_LIMITS[from] ?? []).map(([t, d]) => `<li><b>${t}</b>: ${esc(d)}</li>`).join('')}</ul>
    </details>
    <p class="sub">Strong = within ${Math.round(STRONG_GAP * 100)}% of Earth’s spread of that characteristic
      (its 5th–95th percentile over all land); weak = ${Math.round(WEAK_GAP * 100)}% or more.</p>
  </section>`;
}
