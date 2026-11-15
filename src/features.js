// Earth features for analogs: confirmed impact structures and Holocene volcanoes
// (public/features/earth.json, made by tools/build_earth_features.py). Shown on the Earth map
// and named in the report card of any result that contains one.
import L from 'leaflet';

let featuresPromise = null;
export function loadFeatures() {
  featuresPromise ??= fetch(`${import.meta.env.BASE_URL}features/earth.json`).then((r) => r.json());
  return featuresPromise;
}

const rad = (d) => (d * Math.PI) / 180;
function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Features inside a circle: impact structures that overlap it, volcanoes inside it, and the
 * nearest impact structure. Resolves to { craters: [{name, diameter, km}], volcanoes: [...],
 * nearestCrater: {name, diameter, km} }.
 */
export async function featuresNear(lat, lon, radiusKm) {
  const { craters, volcanoes } = await loadFeatures();
  const cr = craters.map(([name, la, lo, diameter]) => ({ name, diameter, km: distanceKm(lat, lon, la, lo) }));
  const inside = cr.filter((c) => c.km <= radiusKm + c.diameter / 2).sort((a, b) => b.diameter - a.diameter);
  const nearestCrater = cr.reduce((a, b) => (b.km - b.diameter / 2 < a.km - a.diameter / 2 ? b : a));
  const vo = volcanoes.map(([name, la, lo, type, last]) => ({ name, type, last, km: distanceKm(lat, lon, la, lo) }))
    .filter((v) => v.km <= radiusKm).sort((a, b) => a.km - b.km);
  return { craters: inside, volcanoes: vo, nearestCrater };
}

const ago = (year) => {
  if (year === null || year === undefined) return 'last eruption unknown';
  return year >= 1900 ? `last erupted ${year}` : year > 0 ? `last erupted ${year} CE` : `last erupted ~${-year} BCE`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtKm = (d) => (d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString('en-US'));

/** Report-card section listing the features near a result. */
export function featuresHtml({ craters, volcanoes, nearestCrater }) {
  const items = [];
  for (const c of craters.slice(0, 4)) items.push(`<li><b>${esc(c.name)}</b> impact structure, ${fmtKm(c.diameter)} km across</li>`);
  if (volcanoes.length) {
    const v = volcanoes[0];
    items.push(`<li><b>${volcanoes.length} young volcano${volcanoes.length > 1 ? 'es' : ''}</b>, e.g. ${esc(v.name)} `
      + `(${esc(v.type.toLowerCase())}, ${ago(v.last)})</li>`);
  }
  const none = !items.length;
  if (none) {
    const edge = Math.max(0, nearestCrater.km - nearestCrater.diameter / 2);
    items.push(`<li>No impact structure or young volcano in the area. Nearest impact structure: ${esc(nearestCrater.name)} `
      + `(${fmtKm(nearestCrater.diameter)} km), ${fmtKm(edge)} km away</li>`);
  }
  return `<div class="rc-group rc-features"><p class="rc-head">◎ Features in this area</p><ul>${items.join('')}</ul></div>`;
}

/** Earth map markers: impact structures (rings to scale, labelled when large) and volcanoes. */
export async function addFeatureMarkers(map, tiers) {
  const { craters, volcanoes } = await loadFeatures();
  for (const [name, lat, lon, diameter, ] of craters) {
    const ring = L.circle([lat, lon], { radius: (diameter * 1000) / 2, className: 'impact-ring', interactive: false });
    const label = L.marker([lat, lon], {
      icon: L.divIcon({ className: 'landmark landmark-impact', html: `<div class="lm"><span class="lm-icon">◎</span><span class="lm-text"></span></div>`, iconSize: null }),
      pane: 'labels', interactive: false, keyboard: false,
    });
    label.on('add', () => {
      const el = label.getElement();
      el.querySelector('.lm-text').textContent = name;
      el.title = `${name}: impact structure, ${fmtKm(diameter)} km across`;
    });
    const tier = diameter >= 20 ? 1 : 2;
    tiers[tier].addLayer(ring);
    tiers[tier].addLayer(label);
  }
  for (const [name, lat, lon, type, last] of volcanoes) {
    const m = L.circleMarker([lat, lon], { radius: 3, className: 'volcano-dot', pane: 'labels' });
    m.bindTooltip(`${name}: ${type.toLowerCase() || 'volcano'}, ${ago(last)}`, { direction: 'top' });
    tiers[2].addLayer(m);
  }
}
