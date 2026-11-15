// Which country is a place in? Used by the Earth analog search to show each result's
// country and to leave countries out of the search, or keep it to chosen countries.
//
// Data: public/search/countries.bin + .json (tools/build_country_grid.mjs), a 0.25 degree
// grid from Natural Earth's public-domain country boundaries (de facto boundaries; disputed
// areas follow Natural Earth). Antarctica is "no country" (Antarctic Treaty area).
const BASE = `${import.meta.env.BASE_URL}search`;

/** id used for "no country": Antarctica and any unclaimed land */
export const NO_COUNTRY = 0;

let promise = null;
/** Resolves to { list: [{id, name}], nameOf(id), at(lat, lon) -> id }. ids are 1-based; 0 = no country. */
export function loadCountries() {
  promise ??= (async () => {
    const [meta, res] = await Promise.all([
      fetch(`${BASE}/countries.json`).then((r) => r.json()),
      fetch(`${BASE}/countries.bin`),
    ]);
    const grid = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const { width: W, height: H, res: RES } = meta;
    const none = new Set(meta.countries.map((c, i) => (c.noCountry ? i + 1 : 0)).filter(Boolean));
    const cell = (r, c) => {
      if (r < 0 || r >= H) return 0;
      const v = grid[r * W + ((c % W) + W) % W];
      return none.has(v) ? NO_COUNTRY : v;
    };
    const raw = (r, c) => (r < 0 || r >= H ? 0 : grid[r * W + ((c % W) + W) % W]);
    // the cell itself, or (on a coast, where the cell centre is in the sea) the nearest
    // cell with a country within ~2 cells
    function at(lat, lon) {
      const r0 = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / RES)));
      const c0 = Math.floor((lon + 180) / RES);
      if (raw(r0, c0)) return cell(r0, c0);
      let best = 0; let bestD = Infinity;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (!raw(r0 + dr, c0 + dc)) continue;
          const d = dr * dr + dc * dc;
          if (d < bestD) { bestD = d; best = cell(r0 + dr, c0 + dc); }
        }
      }
      return best;
    }
    const list = [{ id: NO_COUNTRY, name: 'No country (Antarctica, unclaimed land)' },
      ...meta.countries.map((c, i) => ({ id: i + 1, name: c.name })).filter((c) => !none.has(c.id))];
    const names = new Map(list.map((c) => [c.id, c.name]));
    names.set(NO_COUNTRY, 'No country');
    return {
      list, at, source: meta.source,
      nameOf: (id) => names.get(id) ?? 'No country',
      /** Name to show for a place: its country, "Antarctica (no country)" or "No country" */
      nameAt: (lat, lon) => {
        const id = at(lat, lon);
        return id === NO_COUNTRY ? (lat <= -60 ? 'Antarctica (no country)' : 'No country') : names.get(id);
      },
    };
  })();
  promise.catch(() => { promise = null; });
  return promise;
}

// ---- The filter: { mode: 'any' | 'avoid' | 'only', ids: [country ids] } -----------------

export const NO_FILTER = { mode: 'any', ids: [] };

/** "avoid:12.45" / "only:0.33" <-> { mode, ids } (kept in the address) */
export function parseCountryFilter(text) {
  const [mode, rest = ''] = (text ?? '').split(':');
  if (mode !== 'avoid' && mode !== 'only') return { ...NO_FILTER };
  const ids = [...new Set(rest.split('.').filter((s) => s !== '').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 256))];
  return ids.length ? { mode, ids } : { ...NO_FILTER };
}
export const formatCountryFilter = (f) => (f.mode === 'any' || !f.ids.length ? '' : `${f.mode}:${f.ids.join('.')}`);

/** Is a place with this country id ruled out by the filter? */
export function filteredOut(filter, id) {
  if (filter.mode === 'avoid') return filter.ids.includes(id);
  if (filter.mode === 'only') return !filter.ids.includes(id);
  return false;
}

/** Short description, e.g. "avoiding Chile, China" / "only in Canada" */
export function describeFilter(filter, countries) {
  if (filter.mode === 'any' || !filter.ids.length) return '';
  const names = filter.ids.map((id) => (id === NO_COUNTRY ? 'no-country land' : countries.nameOf(id)));
  const shown = names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4} more` : names.join(', ');
  return filter.mode === 'avoid' ? `avoiding ${shown}` : `only in ${shown}`;
}
