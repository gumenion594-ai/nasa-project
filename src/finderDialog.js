// The "Find sites" dialog: which criteria a Moon / Mars site has to meet. Each data layer (and
// latitude) can be switched on with limits (min / max in its own units), a preference (lower
// or higher is better) and an importance. Presets fill in a typical set, which can be changed.
import { VIEWS } from './overlays.js';
import { LATITUDE, DEFAULT_COUNT, MAX_COUNT } from './sitefinder.js';

const NAMES = { relief: 'Terrain relief', [LATITUDE]: 'Latitude' };
export const criterionName = (k) => VIEWS[k]?.name ?? NAMES[k] ?? k;
export const criterionUnit = (k, layers) => (k === LATITUDE ? '°' : layers[k]?.unit ?? '');
const IMPORTANCE = [0.5, 1, 2, 3];

// Presets: starting points written for this app, in the spirit of real landing-site criteria;
// the help text says what each is meant for. Values are in the layers' units (km, °, %, TIU ...).
export const PRESETS = {
  mars: [
    { id: 'safe', name: 'Safe landing',
      help: 'Low ground (more air above it to slow a lander down), gentle and even terrain, near the equator, not deep in loose dust. In the spirit of the limits real Mars landers had; the numbers are a starting point, not any mission’s.',
      criteria: { [LATITUDE]: { min: -30, max: 30 }, elevation: { max: -1 }, slope: { max: 3, prefer: 'low', weight: 2 }, relief: { max: 0.1 }, surface: { min: 150 } } },
    { id: 'ice', name: 'Water ice within reach',
      help: 'Ice-rich ground (Mars Odyssey signal of 50% or more, as in the analog search) outside the polar ice caps (within 75° of the equator; Phoenix landed at 68° N), on gentle slopes and low enough to land.',
      criteria: { [LATITUDE]: { min: -75, max: 75 }, ice: { min: 50, prefer: 'high', weight: 2 }, slope: { max: 5 }, elevation: { max: 0 } } },
    { id: 'warm', name: 'Warm and sunny',
      help: 'The mildest nights and the most sunlight: for solar power and for equipment that has to survive the night.',
      criteria: { temp_min: { prefer: 'high', weight: 2 }, sunlight: { prefer: 'high' }, slope: { max: 5 } } },
    { id: 'iron', name: 'Iron-rich ground',
      help: 'The most iron in the soil (Mars Odyssey gamma-ray spectrometer), on gentle slopes.',
      criteria: { iron: { min: 18, prefer: 'high', weight: 2 }, slope: { max: 5 } } },
  ],
  moon: [
    { id: 'south', name: 'South pole sunlight',
      help: 'Within 10° of the south pole, where NASA plans its Artemis landings: the most sunlight (for power) on gentle slopes.',
      criteria: { [LATITUDE]: { max: -80 }, sunlight: { prefer: 'high', weight: 2 }, slope: { max: 8 } } },
    { id: 'mare', name: 'Smooth mare plain',
      help: 'Flat, even, iron-rich basalt plains, like the Apollo 11 and 12 landing sites.',
      criteria: { slope: { max: 2, prefer: 'low', weight: 2 }, relief: { max: 0.05 }, iron: { min: 12 } } },
    { id: 'cold', name: 'Coldest polar ground',
      help: 'The coldest ground near the south pole, where water ice can survive, on slopes a rover can manage.',
      criteria: { [LATITUDE]: { max: -80 }, temp_max: { prefer: 'low', weight: 2 }, slope: { max: 15 } } },
  ],
};

/**
 * Show the dialog. body: 'moon'|'mars'; bodyName; layers: {layer: meta} (index.json);
 * initial: { criteria, count, preset } from the last search. Resolves with the same shape, or null.
 */
export function askCriteria({ body, bodyName, layers, radiusKm, initial = {} }) {
  const dialog = document.getElementById('finder');
  const keys = [LATITUDE, ...Object.keys(VIEWS).filter((k) => layers[k]), ...(layers.relief ? ['relief'] : [])];
  const presets = PRESETS[body] ?? [];
  let state = {};       // key -> { on, min, max, prefer, weight }
  let preset = initial.preset ?? null;
  const blank = () => ({ on: false, min: '', max: '', prefer: '', weight: 1 });
  function load(criteria) {
    state = Object.fromEntries(keys.map((k) => {
      const c = criteria?.[k];
      return [k, c ? { on: true, min: c.min ?? '', max: c.max ?? '', prefer: c.prefer ?? '', weight: c.weight ?? 1 } : blank()];
    }));
  }
  load(initial.criteria ?? presets[0]?.criteria);
  if (!initial.criteria && presets[0]) preset = presets[0].id;

  dialog.querySelector('.f-sub').textContent = `${bodyName} · the whole surface · areas of ${radiusKm} km radius (the radius slider sets it)`;
  const presetBox = dialog.querySelector('.f-presets');
  const presetHelp = dialog.querySelector('.f-preset-help');
  const list = dialog.querySelector('.f-list');
  const countInput = dialog.querySelector('#f-count');
  const warning = dialog.querySelector('.f-warning');
  countInput.min = 1; countInput.max = MAX_COUNT;
  countInput.value = initial.count ?? DEFAULT_COUNT;

  function renderPresets() {
    presetBox.replaceChildren(...presets.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.name;
      b.setAttribute('aria-pressed', p.id === preset);
      b.onclick = () => { preset = p.id; load(p.criteria); render(); };
      return b;
    }));
    const p = presets.find((x) => x.id === preset);
    presetHelp.textContent = p ? p.help : 'Custom criteria.';
  }

  function render() {
    renderPresets();
    list.replaceChildren(...keys.map((k) => {
      const s = state[k];
      const meta = layers[k];
      const unit = criterionUnit(k, layers);
      const rangeText = k === LATITUDE ? '−90 (south) to 90 (north)' : `map colours ${meta.min}–${meta.max} ${unit}`;
      const row = document.createElement('div');
      row.className = `f-row${s.on ? '' : ' off'}`;
      row.innerHTML = `
        <label class="f-name"><input type="checkbox"><span><span class="f-label"></span><small></small></span></label>
        <div class="f-limits"><input type="number" step="any" class="f-min" aria-label="minimum"><span>to</span>
          <input type="number" step="any" class="f-max" aria-label="maximum"><span class="f-unit"></span></div>
        <select class="f-prefer" aria-label="preference"><option value="">no preference</option>
          <option value="low">lower is better</option><option value="high">higher is better</option></select>
        <select class="f-weight" aria-label="importance">${IMPORTANCE.map((w) => `<option value="${w}">×${w}</option>`).join('')}</select>`;
      row.querySelector('.f-label').textContent = criterionName(k);
      row.querySelector('small').textContent = k === LATITUDE ? rangeText : `${(meta.about ?? '').split(/\.\s/)[0].replace(/\.$/, '')}. ${rangeText}`;
      const [on, min, max, prefer, weight] = ['input[type=checkbox]', '.f-min', '.f-max', '.f-prefer', '.f-weight'].map((q) => row.querySelector(q));
      row.querySelector('.f-unit').textContent = unit;
      on.checked = s.on; min.value = s.min; max.value = s.max; prefer.value = s.prefer; weight.value = String(s.weight);
      min.placeholder = 'min'; max.placeholder = 'max';
      const changed = () => { preset = null; renderPresets(); validate(); };
      on.onchange = () => { s.on = on.checked; row.classList.toggle('off', !s.on); changed(); };
      // typing a limit or choosing a preference switches the criterion on
      const edit = (f) => () => { f(); if (!s.on) { s.on = true; on.checked = true; row.classList.remove('off'); } changed(); };
      min.oninput = edit(() => { s.min = min.value; });
      max.oninput = edit(() => { s.max = max.value; });
      prefer.onchange = edit(() => { s.prefer = prefer.value; });
      weight.onchange = () => { s.weight = Number(weight.value); changed(); };
      return row;
    }));
    validate();
  }

  // criteria of the switched-on rows; a row needs a limit or a preference to mean something
  function criteria() {
    const out = {};
    for (const k of keys) {
      const s = state[k];
      if (!s.on) continue;
      const c = { weight: s.weight };
      if (s.min !== '' && Number.isFinite(Number(s.min))) c.min = Number(s.min);
      if (s.max !== '' && Number.isFinite(Number(s.max))) c.max = Number(s.max);
      if (s.prefer) c.prefer = s.prefer;
      if (c.min !== undefined || c.max !== undefined || c.prefer) out[k] = c;
    }
    return out;
  }
  function problem() {
    const c = criteria();
    if (!Object.keys(c).length) return 'Switch on at least one criterion with a limit or a preference.';
    for (const [k, v] of Object.entries(c)) {
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) return `${criterionName(k)}: the minimum is above the maximum.`;
    }
    const n = Number(countInput.value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return `Number of sites: 1 to ${MAX_COUNT}.`;
    return '';
  }
  function validate() {
    const p = problem();
    warning.textContent = p;
    warning.hidden = !p;
    dialog.querySelector('.f-go').disabled = !!p;
  }
  countInput.oninput = validate;
  render();

  return new Promise((resolve) => {
    const done = (value) => { dialog.close(); resolve(value); };
    dialog.querySelector('.f-go').onclick = () => { if (!problem()) done({ criteria: criteria(), count: Number(countInput.value), preset }); };
    dialog.querySelector('.f-cancel').onclick = () => done(null);
    dialog.querySelector('.f-clear').onclick = () => { preset = null; load({}); render(); };
    dialog.oncancel = (e) => { e.preventDefault(); done(null); };
    dialog.showModal();
  });
}
