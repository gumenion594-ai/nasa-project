// Simulation Planning side panel (right side, over the map; the map stays usable). Opened from
// an Earth analog result; follows the selected result while it is open.
import { simulationPlan, ASSUME, SETTINGS } from './plan.js';
import { SOURCES } from './facts.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// $45k, $1.2M; ranges as "$45k–$190k"
function money(x) {
  if (x >= 1e6) return `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`;
  if (x >= 1e3) return `$${Math.round(x / 1e3)}k`;
  return `$${Math.round(x)}`;
}
export const range = ([lo, hi]) => (Math.round(lo / 1e3) === Math.round(hi / 1e3) ? money(lo) : `${money(lo)}–${money(hi)}`);

const STATUS = { match: ['✓', 'Matches'], partial: ['≈', 'Partly'], gap: ['✗', 'Needs change'], na: ['?', 'No data'] };
const KIND = { published: 'Published price', estimate: 'Estimate', mixed: 'Published + estimate' };
const link = (s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`;

function gapTable(p) {
  return `<table class="sp-gaps"><thead><tr><th>Characteristic</th><th>Here</th><th>${esc(p.worldName)}</th></tr></thead><tbody>${
    p.rows.map((r) => `<tr class="sp-${r.status}">
      <td><span class="sp-dot" title="${STATUS[r.status][1]}">${STATUS[r.status][0]}</span> ${esc(r.name)}
        ${r.setting ? `<span class="sp-badge sp-${r.setting}" title="${esc(SETTINGS[r.setting].help)}">${SETTINGS[r.setting].label}</span>` : ''}
        <small>${esc(r.diff)}${r.note ? ` · ${esc(r.note)}` : ''}</small></td>
      <td>${esc(r.earth)}</td><td>${esc(r.target)}</td></tr>`).join('')}</tbody></table>
    <p class="sp-legend">✓ matches · ≈ partly · ✗ needs change. ${Object.values(SETTINGS).map((s) => `<b>${s.label}</b>: ${s.help}`).join(' · ')}.</p>`;
}

function recCards(p) {
  const byId = Object.fromEntries(p.equipment.map((e) => [e.id, e]));
  return p.recs.map((r, i) => {
    const items = r.items.map((id) => byId[id]).filter(Boolean);
    const cost = items.reduce((a, it) => {
      const c = it.cost ?? it.perCampaign;
      return c ? [a[0] + c.lo, a[1] + c.hi] : a;
    }, [0, 0]);
    return `<li class="sp-rec">
      <div class="sp-rec-head"><span class="sp-prio sp-prio-${r.level.toLowerCase()}">${i + 1} · ${r.level} priority</span>
        <span class="sp-badge sp-${r.setting}">${SETTINGS[r.setting].label}</span></div>
      <p class="sp-rec-title">${esc(r.title)}</p>
      <dl>
        <dt>Lacking</dt><dd>${esc(r.lacking)}</dd>
        <dt>Change</dt><dd>${esc(r.change)}</dd>
        ${items.length ? `<dt>Technology</dt><dd>${items.map((it) => esc(it.name)).join('; ')}</dd>
        <dt>Cost</dt><dd>${range(cost)}${items.every((it) => it.perCampaign) ? ' per campaign' : items.some((it) => it.perCampaign) ? ' (purchase, plus facility time per campaign)' : ' to buy'}</dd>` : '<dt>Technology</dt><dd>none: a choice of where and when to test</dd>'}
        <dt>Effect</dt><dd>${esc(r.improvement)}</dd>
      </dl></li>`;
  }).join('');
}

function equipmentCards(p) {
  return p.equipment.map((it) => {
    const c = it.cost ?? it.perCampaign;
    const img = it.img
      ? `<a href="${esc(it.wiki)}" target="_blank" rel="noopener" class="sp-img"><img src="${esc(it.img)}" alt="${esc(it.name)}" loading="lazy" referrerpolicy="no-referrer"></a>`
      : `<span class="sp-img sp-icon" aria-hidden="true">${it.icon ?? '⚙'}</span>`;
    return `<li class="sp-card">${img}<div class="sp-card-body">
      <p class="sp-card-name">${esc(it.name)}</p>
      <p>${esc(it.purpose)}</p>
      <p class="sp-why"><b>Needed here for:</b> ${esc(it.why.join(', '))}</p>
      <p class="sp-cost"><b>${it.perCampaign ? 'Per campaign' : 'Purchase'}:</b> ${range([c.lo, c.hi])}
        <span class="sp-kind sp-kind-${c.kind}">${KIND[c.kind]}</span>
        ${it.opex ? `<br><b>Running:</b> ${range([it.opex.lo, it.opex.hi])} a year <small>(${esc(it.opex.basis)})</small>` : ''}</p>
      <details><summary>Price basis, past use and sources</summary>
        <p><small>${esc(c.basis)}</small></p>
        <p><small><b>Used before:</b> ${esc(it.heritage)}</small></p>
        <ul class="sp-src">${it.sources.map((s) => `<li>${link(s)}</li>`).join('')}</ul>
      </details></div></li>`;
  }).join('');
}

function costTable(p) {
  const { initial, recurring, campaign, totals: T, kwh, remote } = p.costs;
  const rows = (list) => list.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${range(v)}</td></tr>`).join('');
  return `<table class="sp-costs"><tbody>
    <tr class="sp-sub"><th colspan="2">Initial investment</th></tr>${rows(initial)}
    <tr class="sp-sum"><td>Initial investment</td><td>${range(T.initial)}</td></tr>
    <tr class="sp-sub"><th colspan="2">Recurring, per year</th></tr>${rows(recurring)}
    <tr class="sp-sum"><td>Per year</td><td>${range(T.recurring)}</td></tr>
    <tr class="sp-sub"><th colspan="2">Running one simulation campaign</th></tr>${rows(campaign)}
    <tr class="sp-sum"><td>Per campaign</td><td>${range(T.campaign)}</td></tr>
    <tr class="sp-total"><td>First year (all of the above)</td><td>${range(T.firstYear)}</td></tr>
  </tbody></table>
  <details class="sp-assume"><summary>Assumptions</summary><ul>
    <li>Equipment prices: as on each card (published prices where they exist, otherwise labelled estimates).</li>
    <li>Installation ${ASSUME.installShare.map((x) => `${x * 100}%`).join('–')} and transport ${ASSUME.freightShare.map((x) => `${x * 100}%`).join('–')} of the purchase price (estimates).</li>
    ${p.costs.needsHall ? `<li>Test hall of ~500 m² for the chambers and offload rig: ${range(ASSUME.hall)} (estimate; renting time at an existing facility avoids it).</li>` : ''}
    <li>Energy: ~${Math.round(kwh / 1000).toLocaleString('en-US')} MWh a year at ${remote ? `$${ASSUME.dieselKwh.join('–')}/kWh from diesel generators (remote site)` : `$${ASSUME.gridKwh.join('–')}/kWh from the grid`} (estimate).</li>
    <li>Staff: ${range(ASSUME.personYear)} per person-year including overheads (estimate).</li>
    <li>Field camp, travel and permits: this app’s planning figures for a ${esc(p.kind.name.toLowerCase())}, ±30% (not quotes).</li>
    <li>2025 US dollars. Ranges are wide on purpose: real prices depend on the country, the supplier and the size of the test area.</li>
  </ul></details>`;
}

function teamTable(p) {
  return `<table class="sp-team"><thead><tr><th>Role</th><th>Preparing</th><th>Operating</th></tr></thead><tbody>${
    p.team.map((t) => `<tr><td>${esc(t.name)}<small>${esc(t.does)}${t.items.length ? `. Here: ${esc(t.items.join(', '))}` : ''}</small></td>
      <td>${t.prep || '–'}</td><td>${t.ops || '–'}</td></tr>`).join('')}
    <tr class="sp-sum"><td>Total</td><td>${p.people.prep}</td><td>${p.people.ops}</td></tr></tbody></table>
    <p class="sp-legend">Preparation takes about ${p.prepMonths[0]}–${p.prepMonths[1]} months (longest equipment lead time${p.costs.needsHall ? ', building the test hall' : ''}, commissioning).
      Operating staff are year-round; each campaign also needs a field team of ${p.people.field} for ${p.people.weeks} weeks. Estimates from typical staffing of each piece of equipment.</p>`;
}

function sourcesList(p) {
  const all = new Map();
  for (const s of Object.values(SOURCES)) all.set(s.url, s);
  for (const it of p.equipment) for (const s of it.sources) all.set(s.url, s);
  return `<ul class="sp-src">${[...all.values()].map((s) => `<li>${link(s)}</li>`).join('')}</ul>
    <p class="sp-legend">Place data: this app’s Moon / Mars layers and Earth search grid (NASA POWER, ETOPO 2022, MODIS, MERRA-2); see the report card.</p>`;
}

const section = (title, body, open = false) => `<details class="sp-sec"${open ? ' open' : ''}><summary>${title}</summary><div class="sp-sec-body">${body}</div></details>`;

export function createSimPanel() {
  const root = $('sim-panel');
  let ctx = null; let token = 0;
  $('sim-close').onclick = () => close();

  async function render() {
    const my = ++token;
    const c = ctx;
    $('sim-sub').textContent = `${c.placeName} → ${c.worldName} · ${c.siteName}`;
    $('sim-body').innerHTML = '<p class="sub">Working out the plan…</p>';
    try {
      const p = await simulationPlan(c);
      if (my !== token) return;
      const nGap = p.rows.filter((r) => r.status === 'gap' || r.status === 'partial').length;
      $('sim-body').innerHTML = `
        <div class="sp-summary">
          <div class="sp-big"><span>First year, estimated</span><strong>${range(p.costs.totals.firstYear)}</strong></div>
          <div class="sp-facts">
            <span><b>${range(p.costs.totals.initial)}</b> initial</span>
            <span><b>${range(p.costs.totals.recurring)}</b> a year</span>
            <span><b>${range(p.costs.totals.campaign)}</b> per campaign</span>
            <span><b>${p.people.total}</b> people · <b>${p.prepMonths[0]}–${p.prepMonths[1]}</b> months to prepare</span>
          </div>
          <p class="sp-legend">${nGap} of ${p.rows.length} characteristics differ; ${p.equipment.length} pieces of equipment chosen for them.
            ${esc(p.kind.name)}: ${esc(p.kind.access)}</p>
        </div>
        ${section(`Environmental gaps <span class="sp-count">${nGap}</span>`, gapTable(p), true)}
        ${section(`Recommendations <span class="sp-count">${p.recs.length}</span>`, `<ol class="sp-recs">${recCards(p)}</ol>`, true)}
        ${section(`Technology and equipment <span class="sp-count">${p.equipment.length}</span>`, `<ul class="sp-cards">${equipmentCards(p)}</ul>`)}
        ${section('Total cost', costTable(p))}
        ${section(`Manpower <span class="sp-count">${p.people.total}</span>`, teamTable(p))}
        ${section('Sources', sourcesList(p))}`;
    } catch (err) {
      console.error(err);
      if (my === token) $('sim-body').innerHTML = '<p class="sub">The plan could not be worked out: the Earth data failed to load.</p>';
    }
  }

  function open(c) { ctx = c; root.hidden = false; root.scrollTop = 0; render(); }
  function update(c) { if (!root.hidden) { ctx = c; render(); } }
  function close() { root.hidden = true; token++; }
  return { open, update, close, isOpen: () => !root.hidden };
}
