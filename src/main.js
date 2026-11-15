import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { BODIES } from './bodies.js';
import { circlePoints, formatLatLon, parseLatLon } from './geo.js';
import { createGlobe, globesReady } from './globes.js';
import { drawStarfield } from './starfield.js';
import { VIEWS, loadIndex, createOverlay, legendHtml, summaryColour, SUMMARY_GRADIENT_CSS, retryFailedTiles } from './overlays.js';
import { summarize } from './areastats.js';
import { askWeights, parseWeights, formatWeights } from './weights.js';
import { PARAMS, WEIGHT_STEPS, DEFAULT_WEIGHTS, DEFAULT_COUNT, MAX_COUNT, MIN_SEPARATION_KM, parseAnalogWeights, siteValues, findAnalogs, formatValue as formatParam, formatSite,
  similarity } from './analogs.js';
import { findSimilar, MIN_DISTANCE_KM as SIMILAR_MIN_KM, DEFAULT_COUNT as SIMILAR_DEFAULT_COUNT,
  MAX_COUNT as SIMILAR_MAX_COUNT, cellKm } from './similar.js';
import { addLandmarks } from './landmarks.js';
import { addCandidateSites } from './candidates.js';
import { reportCardHtml, novelty, ordinal } from './reportcard.js';
import { loadCountries, parseCountryFilter, formatCountryFilter, filteredOut, describeFilter } from './countries.js';
import { createSimPanel } from './simplan/panel.js';
import { findSites, LATITUDE, MIN_SEPARATION_KM as SITE_SEPARATION_KM } from './sitefinder.js';
import { askCriteria, criterionName, PRESETS } from './finderDialog.js';
import { inKnownRegion, KNOWN_REGION_KM } from './knownAnalogs.js';
import { refineResults, REFINE_BELOW_KM } from './refine.js';
import { featuresNear, featuresHtml } from './features.js';
import { addRuler, isMeasuring } from './ruler.js';
import { maybeStartTutorial, startTour } from './tutorial.js';
import { createRoutePlanner, routeEvents } from './route/planner.js';
import { siteCrossing, sameRouteOnEarth, destination, bearingDeg } from './route/compare.js';
import { haversineKm as routeKm } from './route/grid.js';
import { findEquivalents, SHARED, CLOSE_MATCH } from './equivalents.js';
import { projection, PROJECTIONS } from './projections.js';
import { WarpedImagery, sourceGrid } from './reproject.js';
import moonTexture from './assets/moon-texture.jpg';
import iconEarth from './assets/icon-earth.png';
import moonPhoto from './assets/moon.png';
import marsPhoto from './assets/mars.png';
import iconMoon from './assets/icon-moon.png';
import iconMars from './assets/icon-mars.png';
import marsTexture from './assets/mars-texture.jpg';

let terrainView = null; // 3D terrain view (src/terrain3d/), loaded and made the first time it's opened
async function getTerrainView() {
  if (!terrainView) {
    const { createView3D } = await import('./terrain3d/view3d.js');
    terrainView ??= createView3D({ routeEvents });
  }
  return terrainView;
}

const home = document.getElementById('home');
const mapView = document.getElementById('map-view');
let map = null;

// Closest you can zoom: about this many km across the screen.
const MIN_VIEW_KM = 1;

// Radius of the area you select (km): a slider from 1 to 250 km. It's logarithmic, so the
// small sizes get as much room as the big ones (the middle of the slider is ~16 km).
const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 250;
const DEFAULT_RADIUS_KM = 10;
const SLIDER_STEPS = 1000;
const sliderToKm = (v) => Math.round(MIN_RADIUS_KM * (MAX_RADIUS_KM / MIN_RADIUS_KM) ** (v / SLIDER_STEPS));
const kmToSlider = (km) => Math.round((Math.log(km / MIN_RADIUS_KM) / Math.log(MAX_RADIUS_KM / MIN_RADIUS_KM)) * SLIDER_STEPS);
const validRadius = (km) => Number.isFinite(km) && km >= MIN_RADIUS_KM && km <= MAX_RADIUS_KM;

const $ = (id) => document.getElementById(id);

// On phones the zoom readout sits just above the selection panel; track its height.
new ResizeObserver(([entry]) => {
  mapView.style.setProperty('--panel-h', `${entry.target.offsetHeight}px`);
}).observe($('select-panel'));

// Starry sky behind the home page; repainted when the window size changes.
const stars = $('stars');
let starTimer = null;
let starsPainted = false;
new ResizeObserver(() => {
  clearTimeout(starTimer);
  if (!starsPainted) { starsPainted = true; drawStarfield(stars); return; } // first paint: right away
  starTimer = setTimeout(() => drawStarfield(stars), 150);              // resizes: wait until settled
}).observe(stars);

// Spinning globes on the home page. The Moon turns 28x slower than Mars.
const MARS_SECONDS_PER_TURN = 30;
const GLOBES = {
  mars: { texture: marsTexture, secondsPerTurn: MARS_SECONDS_PER_TURN, tiltDeg: 25.2, startLon: -70, viewFromDeg: 20 },
  moon: { texture: moonTexture, secondsPerTurn: MARS_SECONDS_PER_TURN * 28, tiltDeg: 1.5, startLon: 0 },
};
for (const [key, opts] of Object.entries(GLOBES)) {
  const globe = document.querySelector(`.globe.${key}`);
  if (createGlobe(globe.querySelector('canvas'), opts)) globe.classList.add('is-3d');
  else globe.querySelector('img').src = { moon: moonPhoto, mars: marsPhoto }[key]; // no 3D: photo instead
}

document.querySelectorAll('.body-btn').forEach((btn) => {
  btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.body}`; });
});

document.getElementById('back').addEventListener('click', () => { location.hash = ''; });

const circumferenceKm = (body) => 2 * Math.PI * body.radiusKm;
// Each body's own projection: the one its map tiles are made in.
const nativeProjection = (body) => (body.crs === 'EPSG3857' ? 'mercator' : 'equirect');
let proj = projection('equirect'); // projection of the map currently shown
let keepViewPanelOpen = false;     // reopen the View panel after switching projection
// When the projection changes, the view carries over: same centre, same scale on screen
// (zoom numbers mean different scales in different projections). { key, lat, lon, pxPerKm, atMin }
let carryView = null;

// Screen pixels per km at (lat, lon) at zoom 0 in a projection (geometric mean of the
// north-south and east-west scales there).
function pxPerKmAtZoom0(pr, lat, lon, radiusKm) {
  const km = 0.5;
  const dLat = (km / radiusKm) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const p0 = pr.crs.latLngToPoint(L.latLng(lat, lon), 0);
  const pN = pr.crs.latLngToPoint(L.latLng(lat + (lat > 0 ? -dLat : dLat), lon), 0);
  const pE = pr.crs.latLngToPoint(L.latLng(lat, lon + dLon), 0);
  return Math.sqrt(p0.distanceTo(pN) * p0.distanceTo(pE)) / km;
}

// Zoom level at which the screen width spans MIN_VIEW_KM.
function maxZoomFor(body, size) {
  return Math.log2((size.x * proj.kmPerPxAtZoom0(body.radiusKm)) / MIN_VIEW_KM);
}

// The edges of the map, so it can't repeat or be dragged off screen (native layers).
const MAP_BOUNDS = {
  EPSG3857: [[-85.0511, -180], [85.0511, 180]],
  EPSG4326: [[-90, -180], [90, 180]],
};

function haversineKm(R, a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2
    + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Real-world width of the current view.
function viewWidthKm(body) {
  if (proj.cylindrical) { // measured along the centre latitude
    const b = map.getBounds();
    const degrees = Math.min(b.getEast() - b.getWest(), 360);
    return (degrees / 360) * circumferenceKm(body) * Math.cos((map.getCenter().lat * Math.PI) / 180);
  }
  // polar (azimuthal equidistant): true scale along lines from the pole, so the
  // screen's width in km is simply its width in map pixels
  return (map.getSize().x * proj.kmPerPxAtZoom0(body.radiusKm)) / 2 ** map.getZoom();
}

// A characteristic's value with sensible precision for its unit.
function formatValue(meta, v, withUnit = true) {
  const u = meta.unit;
  let text;
  if (u === 'km') text = v.toFixed(Math.abs(v) < 10 ? 2 : 1);
  else if (u === '°C' || u === 'TIU') text = String(Math.round(v));
  else if (u === '°' || u === '%') text = v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  else text = v.toPrecision(3);
  text = text.replace('-', '−');
  if (!withUnit) return text;
  return u === '°' || u === '%' ? `${text}${u}` : `${text} ${u}`;
}

function formatKm(km) {
  const m = Math.round(km * 1000);
  if (m < 1000) return `${m} m`;
  if (km >= 100) return `${Math.round(km).toLocaleString()} km`;
  return `${km.toFixed(1)} km`;
}

function openMap(key, params) {
  const body = BODIES[key];
  home.hidden = true;
  mapView.hidden = false;
  document.title = `${body.name} · Planet Maps`;

  // Projection: the body's own unless another one is chosen (?proj=...)
  const native = nativeProjection(body);
  proj = projection(PROJECTIONS[params.get('proj')] ? params.get('proj') : native);

  const screen = { x: window.innerWidth, y: window.innerHeight };
  map = L.map('map', {
    crs: proj.crs,
    center: proj.center,
    zoom: proj.minZoom(screen),
    minZoom: proj.minZoom(screen),
    maxZoom: maxZoomFor(body, screen),
    zoomSnap: 0, // smooth zooming; the +/- buttons still step by 2x
    zoomDelta: 1,
    wheelPxPerZoomLevel: 120,
    maxBounds: proj.bounds ?? undefined,
    maxBoundsViscosity: 1.0, // hard stop at the map edges
    zoomControl: false,
    doubleClickZoom: false, // a second click on the selected area zooms to it instead
  });
  if (import.meta.env.DEV) window.map = map; // handy for debugging in the browser console
  // Zoom buttons: a see-through horizontal bar at the top centre of the map
  map.attributionControl.setPrefix(false); // no 'Leaflet' link; the data credits stay
  const zoom = L.control.zoom({ position: 'topright' }).addTo(map);
  const zoomEl = zoom.getContainer();
  zoomEl.classList.add('zoom-bar');
  map.getContainer().appendChild(zoomEl); // out of Leaflet's corner, positioned by CSS

  // Ruler (measure a distance): button in the top-left row, next to Home / View
  addRuler(map, {
    button: $('ruler-btn'),
    panel: $('ruler-panel'),
    root: mapView,
    radiusKm: body.radiusKm,
    cylindrical: proj.cylindrical, // flat maps: the line is split at the 180° edge
    toWorld: proj.toWorld, // to find where the line would jump across the map
    // polar maps: ignore clicks in the empty corners outside the world disc
    inside: proj.inside ? (e) => {
      const n = 256 * 2 ** map.getZoom();
      const raw = map.containerPointToLayerPoint(e.containerPoint).add(map.getPixelOrigin());
      return proj.inside(raw.x / n, raw.y / n);
    } : null,
  });
  body.layers.forEach((layer, i) => {
    // Each layer gets its own pane so it can have its own blend/filter.
    const pane = `layer${i}`;
    const el = map.createPane(pane);
    el.style.zIndex = 200 + i;
    if (layer.filter) el.style.filter = layer.filter;
    if (proj.id === native) {
      retryFailedTiles(L.tileLayer(layer.url, {
        pane,
        attribution: layer.attribution,
        tileSize: layer.tileSize ?? 256,
        zoomOffset: layer.zoomOffset ?? 0,
        maxNativeZoom: layer.maxNativeZoom,
        minZoom: layer.minZoom ?? 0,
        maxZoom: 30,
        noWrap: true, // show the map once, never repeated side by side
        bounds: layer.bounds ?? MAP_BOUNDS[body.crs],
      })).addTo(map);
      return;
    }
    // Another projection: same source tiles, warped in the browser.
    const nativePx = native === 'equirect' ? 512 : 256; // world width at zoom 0
    new WarpedImagery({
      pane,
      attribution: layer.attribution,
      proj,
      radiusKm: body.radiusKm,
      // layers that only appear when zoomed in (e.g. Mars CTX): same level of detail
      maxKmPerPx: layer.minZoom ? circumferenceKm(body) / (nativePx * 2 ** layer.minZoom) : undefined,
      src: sourceGrid({
        kind: native,
        url: layer.url,
        tileSize: layer.tileSize ?? 256,
        maxLevel: layer.maxNativeZoom + (layer.zoomOffset ?? 0),
        bounds: layer.bounds,
      }),
      maxZoom: 30,
      noWrap: true,
    }).addTo(map);
  });

  // Polar maps: keep the square map on screen (Leaflet's maxBounds works in lat/lon)
  if (!proj.bounds) {
    map.on('moveend', () => {
      const z = map.getZoom();
      const world = 256 * 2 ** z;
      const half = map.getSize().divideBy(2);
      const c = map.project(map.getCenter(), z);
      const clamp = (v, h) => (world <= 2 * h ? world / 2 : Math.min(Math.max(v, h), world - h));
      const x = clamp(c.x, half.x);
      const y = clamp(c.y, half.y);
      if (Math.abs(x - c.x) > 0.5 || Math.abs(y - c.y) > 0.5) map.panTo(map.unproject([x, y], z), { animate: false });
    });
  }

  // Zoom readout in the bottom-left corner. ×1 = whole map filling the screen.
  const Readout = L.Control.extend({
    onAdd() {
      const el = L.DomUtil.create('div', 'zoom-readout');
      const update = () => {
        const factor = Math.round(2 ** (map.getZoom() - map.getMinZoom()));
        el.innerHTML = `<strong>×${factor.toLocaleString()}</strong>` +
          `<span>${formatKm(viewWidthKm(body))} across</span>`;
      };
      map.on('zoom move resize', update);
      update();
      return el;
    },
  });
  new Readout({ position: 'bottomleft' }).addTo(map);

  map.on('resize', () => {
    const size = map.getSize();
    map.setMinZoom(proj.minZoom(size));
    map.setMaxZoom(maxZoomFor(body, size));
  });

  // switching projection: same centre and the same scale on screen as before
  if (carryView?.key === key && !carryView.atMin) {
    const lat = proj.id === 'mercator' ? Math.max(-84, Math.min(84, carryView.lat)) : carryView.lat;
    const z = Math.log2(carryView.pxPerKm / pxPerKmAtZoom0(proj, lat, carryView.lon, body.radiusKm));
    map.setView([lat, carryView.lon], Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), z)), { animate: false });
  }

  const analog = key === 'earth' && params.has('site');
  const selection = body.selectable ? setUpSelection(key, body, params, { analog }) : null;
  carryView = null;
  if (analog) showAnalogResults(params, selection);
  setUpWorldSwitch(key, params);
}

// ---- Menu, views and area selection (Moon and Mars) -------------------------

function setUpSelection(key, body, params, { analog = false } = {}) {
  // During an analog search the results replace the selection panel, and clicking the
  // map doesn't select anything until 'Exit results'.
  $('select-panel').hidden = analog;
  $('results-analogs').hidden = true; // shown only with 'Find similar spots' results
  $('menu-btn').hidden = false;
  let shapes = null;
  let current = null; // { lat, lon } of the selected point
  const r = parseFloat(params.get('r'));
  let radiusKm = validRadius(r) ? Math.round(r) : DEFAULT_RADIUS_KM;
  let view = VIEWS[params.get('view')] ? params.get('view') : null;
  if (analog) radiusKm = parseFloat(params.get('sr')) || DEFAULT_RADIUS_KM; // results use the site's radius
  let weights = parseWeights(params.get('w'));            // last weights for 'Find similar spots'
  let analogWeights = parseAnalogWeights(params.get('aw')); // ... and for 'Find Earth analogs'
  let analogMode = params.get('am') === 'extreme' ? 'extreme' : 'match';
  let analogCount = parseCount(params.get('an'));
  let analogNewOnly = params.get('anew') === '1';
  let analogCountries = parseCountryFilter(params.get('ac')); // countries to avoid / keep to
  let similarCount = parseCount(params.get('sn'), SIMILAR_DEFAULT_COUNT);
  let similarShown = false;                    // 'Find similar spots' results are on the map
  let available = {};                          // data layers for this body (from index.json)
  let planner = null;
  let driveAt = null;                          // Earth analogs: plan the site's route at a result                          // Mars / Moon route planner (src/route/), when open
  let describe = () => {};
  function selectView(v) {
    view = v;
    showView();
    describe();
    saveToUrl();
    document.querySelectorAll('#view-options input').forEach((input, i) => {
      input.checked = (i === 0 && !v) || input.dataset.view === v;
    });
  }

  // Keep selection, radius and view in the address, without adding history
  // steps, so coming back to this page (e.g. from Earth) restores them.
  // Earth keeps where it was opened from (and an analog search's site) in its address
  const keep = (key === 'earth' ? ['from', 'site', 'sr', 'w', 'mode', 'n', 'new', 'src', 'str', 'sss'] : ['cmp', 'ca', 'em']).filter((k) => params.has(k));
  function query() {
    const q = new URLSearchParams();
    for (const k of keep) q.set(k, params.get(k));
    if (current) { q.set('lat', current.lat.toFixed(4)); q.set('lon', current.lon.toFixed(4)); }
    if (current || radiusKm !== DEFAULT_RADIUS_KM) q.set('r', radiusKm);
    if (view) q.set('view', view);
    if (proj.id !== nativeProjection(body)) q.set('proj', proj.id);
    planner?.query(q);
    if (key !== 'earth' && Object.keys(weights).length) {
      q.set('w', formatWeights(weights));
      q.set('sn', similarCount);
    }
    if (key !== 'earth' && Object.keys(analogWeights).length) {
      q.set('aw', formatWeights(analogWeights));
      q.set('am', analogMode);
      q.set('an', analogCount);
      if (analogNewOnly) q.set('anew', '1');
      if (formatCountryFilter(analogCountries)) q.set('ac', formatCountryFilter(analogCountries));
    }
    return q.toString();
  }
  const saveToUrl = () => {
    const q = query();
    history.replaceState(null, '', `#/${key}${q ? `?${q}` : ''}`);
    lastPage[key] = location.hash; // so 'Back to Mars view' (and leaving the 3D view) restores it
  };
  saveToUrl();
  // No analog search from Earth itself; instead the reverse: the Mars and Moon equivalents
  document.querySelector('#select-info .actions').hidden = key === 'earth';
  $('equiv').hidden = key !== 'earth' || analog;
  let equivToken = 0;
  function resetEquiv() {
    equivToken++;
    $('equiv-status').textContent = '';
    $('equiv-results').replaceChildren();
    $('find-equiv').disabled = false;
  }
  resetEquiv();
  $('find-equiv').onclick = async () => {
    if (!current) return;
    const my = ++equivToken;
    const at = { ...current };
    $('find-equiv').disabled = true;
    $('equiv-results').replaceChildren();
    const status = (t) => { if (my === equivToken) $('equiv-status').textContent = t; };
    try {
      const index = await loadIndex();
      const found = await findEquivalents({ lat: at.lat, lon: at.lon, radiusKm, index, onProgress: status });
      if (my !== equivToken) return;
      if (!found) { status('No land data here: pick a place on land (not the sea or the ice sheets).'); return; }
      status(`Most like this ${radiusKm} km area on Earth (temperatures, slope and relief):`);
      $('equiv-results').replaceChildren(...['mars', 'moon'].map((w) => equivGroup(w, found)));
    } catch (err) {
      console.error(err);
      status('The search failed to load its data.');
    } finally {
      if (my === equivToken) $('find-equiv').disabled = false;
    }
  };
  // One world's matches: the best % (or "no close equivalent"), the spots, a comparison table
  function equivGroup(world, { place, worlds }) {
    const W = worlds[world];
    const name = BODIES[world].name;
    const the = world === 'moon' ? 'the Moon' : name;
    const box = document.createElement('section');
    box.className = `equiv-world ${W.close ? 'close' : 'far'}`;
    const best = W.results[0];
    const where = (r) => (r.landmark ? `near ${r.landmark.name}${r.landmark.km > 25 ? ` (${Math.round(r.landmark.km)} km)` : ''}` : formatLatLon(r.lat, r.lon));
    box.innerHTML = `<p class="equiv-head"><strong>${name}</strong> ${W.close
      ? `<span class="equiv-badge ok">${best.match}% match</span>`
      : `<span class="equiv-badge far">no close equivalent</span>`}</p>
      <p class="sub">${!best ? `No ${name} data to compare with.` : W.close
    ? `The closest ${name} equivalent is ${where(best)}.`
    : `Nothing on ${the} reaches ${CLOSE_MATCH}%: the nearest is ${where(best)}, a ${best.match}% match.`}</p>`;
    // the best spot shown; the others and the comparison folded away (keeps the panel short)
    const list = document.createElement('ol');
    list.className = 'equiv-list';
    const more = document.createElement('ol');
    more.className = 'equiv-list';
    W.results.forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" title="Open this spot on the ${name} map"><span class="where"></span><span class="sim">${r.match}%</span></button>`;
      li.querySelector('.where').innerHTML = `${r.landmark ? `${r.landmark.name}<span class="sub"> · ${formatLatLon(r.lat, r.lon)}</span>` : formatLatLon(r.lat, r.lon)}`;
      li.querySelector('button').onclick = () => {
        location.hash = `#/${world}?lat=${r.lat.toFixed(4)}&lon=${r.lon.toFixed(4)}&r=${radiusKm}`;
      };
      (i ? more : list).append(li);
    });
    box.append(list);
    if (best) {
      const rows = Object.entries(SHARED).map(([k, s]) => {
        const rel = k in W.relative ? ` <span class="sub" title="Beyond anything on ${name}: matched to the same percentile of ${name}">(as ${Math.round(W.relative[k] * 100)}th pct)</span>` : '';
        return `<tr><td>${s.name}</td><td>${s.fmt(place[k])}${rel}</td><td>${Number.isFinite(best.values[k]) ? s.fmt(best.values[k]) : '–'}</td></tr>`;
      });
      rows.push(`<tr><td>Rain</td><td>${Math.round(place.rainMm).toLocaleString()} mm/yr</td><td>none</td></tr>`);
      const det = document.createElement('details');
      det.className = 'equiv-compare';
      det.innerHTML = `<summary>Compare${W.results.length > 1 ? ` · ${W.results.length - 1} more spots` : ''}</summary>
        <table><thead><tr><th></th><th>Earth</th><th>${name}</th></tr></thead><tbody>${rows.join('')}</tbody></table>
        <p class="sub">Averages over a ${radiusKm} km circle on both worlds. Temperatures beyond anything on ${the} are matched relatively:
        as hot or cold for ${the} as this place is for Earth. Rain beyond a desert's (250 mm a year) lowers the % match.</p>`;
      if (more.children.length) {
        const h = document.createElement('p');
        h.className = 'sub';
        h.textContent = `Next best on ${the} (at least 500 km apart):`;
        det.append(h, more);
      }
      box.append(det);
    }
    return box;
  }

  // ---- Menu drawer
  const menu = $('menu');
  const openMenu = (open) => {
    menu.hidden = !open;
    $('menu-btn').setAttribute('aria-expanded', open);
  };
  $('menu-btn').onclick = () => openMenu(menu.hidden);
  appHooks.openMenu = openMenu;
  appHooks.bodyName = () => body.name;
  if (keepViewPanelOpen) { openMenu(true); keepViewPanelOpen = false; }
  $('menu-close').onclick = () => openMenu(false);
  map.on('keydown', (e) => { if (e.originalEvent.key === 'Escape') openMenu(false); });

  // ---- Projection buttons (top of the View panel): rebuild the map in another projection
  $('proj-options').replaceChildren(...Object.entries(PROJECTIONS).map(([id, info]) => {
    const label = document.createElement('label');
    label.className = 'view-chip';
    label.title = info.name;
    label.innerHTML = '<input type="radio" name="proj"><span></span>';
    label.querySelector('span').textContent = info.short;
    const input = label.querySelector('input');
    input.checked = id === proj.id;
    input.onchange = () => {
      // remember the view: centre and real scale on screen (or "whole map")
      const c = map.getCenter();
      carryView = {
        key, lat: c.lat, lon: c.lng,
        pxPerKm: pxPerKmAtZoom0(proj, c.lat, c.lng, body.radiusKm) * 2 ** map.getZoom(),
        atMin: map.getZoom() <= map.getMinZoom() + 0.05,
      };
      proj = projection(id);
      saveToUrl();
      keepViewPanelOpen = true; // so projections can be tried one after another
      route(); // same body, selection and view - new projection
    };
    return label;
  }));

  // ---- Views (coloured overlays)
  map.createPane('overlay').style.zIndex = 350; // above the imagery, below the selection
  let overlay = null;
  const mapLegend = L.control({ position: 'bottomleft' });
  mapLegend.onAdd = () => {
    const el = L.DomUtil.create('div', 'legend');
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    return el;
  };
  let mapLegendAdded = false;

  const selectCandidate = (site) => {
    if (analog || similarShown || isMeasuring()) return;
    if (planner?.isOpen()) { planner.click(L.latLng(site.lat, site.lon)); return; }
    select(site.lat, site.lon, undefined, site.name);
  };

  // ---- Map settings panel (bottom left): landmarks and candidate sites
  const settings = L.control({ position: 'bottomleft' });
  settings.onAdd = () => {
    const el = L.DomUtil.create('div', 'map-settings');
    el.innerHTML = `
      <label class="switch-row">
        <input id="landmarks-toggle" type="checkbox" checked>
        <span class="switch" aria-hidden="true"></span>
        <span>Landmarks</span>
      </label>`;
    if (key === 'moon') {
      el.insertAdjacentHTML('beforeend', `
        <label class="switch-row">
          <input id="candidate-sites-toggle" type="checkbox" checked>
          <span class="switch" aria-hidden="true"></span>
          <span>Artemis III candidates (South Pole)</span>
        </label>`);
    }
    L.DomEvent.disableClickPropagation(el); // clicks here shouldn't select a spot on the map
    L.DomEvent.disableScrollPropagation(el);
    return el;
  };
  settings.addTo(map);

  // Landmarks: on whenever a map opens; the switch only hides them on this map
  const showLandmarks = addLandmarks(map, key);
  const toggle = $('landmarks-toggle');
  toggle.checked = true;
  showLandmarks(true);
  toggle.onchange = () => showLandmarks(toggle.checked);
  if (key === 'moon') {
    const showCandidates = addCandidateSites(map, key, selectCandidate);
    const candidateToggle = $('candidate-sites-toggle');
    candidateToggle.onchange = () => showCandidates(candidateToggle.checked);
  }

  loadIndex().then((index) => {
    if (!map) return;
    available = index[key] ?? {};
    const options = [[null, { name: 'None', short: 'None', about: 'Just the imagery, no data layer.' }],
      ...Object.entries(VIEWS).filter(([v]) => available[v])
        .map(([v, info]) => [v, { ...info, about: available[v].about }])];
    describe = () => {
      const info = options.find(([v]) => v === view)?.[1] ?? options[0][1];
      $('view-about').textContent = info.about;
    };
    $('view-options').replaceChildren(...options.map(([v, info]) => {
      const label = document.createElement('label');
      label.className = 'view-chip';
      label.title = `${info.name}: ${info.about}`;
      label.innerHTML = '<input type="radio" name="view"><span></span>';
      label.querySelector('span').textContent = info.short;
      const input = label.querySelector('input');
      input.dataset.view = v ?? '';
      input.checked = v === view;
      input.onchange = () => selectView(v);
      return label;
    }));
    describe();
    if (view && !available[view]) view = null;
    showView();
    updateSummary();
  });

  function showView() {
    document.querySelectorAll('.area-row').forEach((row, i) => {
      row.classList.toggle('active', Object.keys(VIEWS).filter((v) => available[v])[i] === view);
    });
    if (overlay) { overlay.remove(); overlay = null; }
    const legend = $('view-legend');
    if (!view) {
      if (mapLegendAdded) { mapLegend.remove(); mapLegendAdded = false; }
      legend.hidden = true;
      legend.open = false;
      return;
    }
    const meta = available[view];
    overlay = createOverlay(key, view, meta, 'overlay', proj).addTo(map);
    legend.hidden = false;
    legend.open = true;
    legend.querySelector('summary').textContent = `Colour legend: ${VIEWS[view].name}`;
    $('view-legend-content').innerHTML = legendHtml(view, meta);
    if (!mapLegendAdded) { mapLegend.addTo(map); mapLegendAdded = true; }
    mapLegend.getContainer().innerHTML = legendHtml(view, meta);
  }

  // ---- Area summary: typical value of every characteristic over the circle
  let summaryToken = 0;
  async function updateSummary() {
    const panel = $('area-panel');
    if (!current || !Object.keys(available).length) { panel.hidden = true; return; }
    panel.hidden = false;
    $('area-scale-bar').style.background = SUMMARY_GRADIENT_CSS;
    $('area-sub').textContent = `${formatLatLon(current.lat, current.lon)} · ${radiusKm} km radius`;
    const token = ++summaryToken;
    const layers = Object.keys(VIEWS).filter((v) => available[v]);
    const rows = layers.map((v) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'area-row';
      row.innerHTML = '<span class="swatch"></span><span class="a-name"></span><span class="a-val">…</span><span class="a-range"></span>';
      row.querySelector('.a-name').textContent = VIEWS[v].name;
      row.title = `Show ${VIEWS[v].name} on the map`;
      row.onclick = () => selectView(v);
      row.classList.toggle('active', v === view);
      return row;
    });
    $('area-rows').replaceChildren(...rows);
    const { lat, lon } = current;
    await Promise.all(layers.map(async (v, i) => {
      const meta = available[v];
      const res = await summarize(key, v, meta, lat, lon, radiusKm, body.radiusKm);
      if (token !== summaryToken) return; // a newer selection has started
      const row = rows[i];
      if (res.none) {
        row.querySelector('.a-val').textContent = 'no data here';
        row.classList.add('none');
        return;
      }
      row.querySelector('.a-val').textContent = formatValue(meta, res.median);
      const lo = formatValue(meta, res.p10, false);
      const hi = formatValue(meta, res.p90, false);
      const spread = lo === hi ? 'uniform' : `${lo} – ${formatValue(meta, res.p90)}`;
      const regional = meta.pixel_km > 2 * radiusKm ? ` · regional value (~${Math.round(meta.pixel_km)} km data)` : '';
      row.querySelector('.a-range').textContent = `range ${spread}${regional}`;
      row.querySelector('.swatch').style.backgroundColor = summaryColour(meta, res.median);
    }));
  }
  const setCollapsed = (collapsed) => {
    $('area-panel').classList.toggle('collapsed', collapsed);
    $('area-collapse').setAttribute('aria-expanded', !collapsed);
    $('area-collapse').setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} area summary`);
    $('area-collapse').innerHTML = collapsed ? '&plus;' : '&minus;';
  };
  setCollapsed(window.innerWidth < 600); // phones: start as a single bar, tap to open
  $('area-collapse').onclick = () => setCollapsed(!$('area-panel').classList.contains('collapsed'));

  // ---- Selection
  // fit: 'always' (restoring a saved selection), 'if-hidden' (radius changed), or none (a click).
  function draw({ fit } = {}) {
    if (shapes) shapes.remove();
    const ring = circlePoints(current.lat, current.lon, radiusKm, body.radiusKm);
    shapes = L.layerGroup([
      L.polygon(ring, { className: 'selection-area', interactive: false }),
      L.circleMarker([current.lat, current.lon], { className: 'selection-centre', radius: 4, interactive: false }),
    ]).addTo(map);
    $('select-radius').textContent = `${radiusKm} km radius · click elsewhere to move it`;
    const bounds = L.latLngBounds(ring);
    if (fit === 'always' || (fit === 'if-hidden' && !map.getBounds().contains(bounds))) {
      map.fitBounds(bounds, { padding: [80, 80] });
    }
  }

  let zoomedIn = false; // has the current area already been zoomed to (second click)?
  function select(lat, lon, opts, siteName = null) {
    current = { lat, lon };
    zoomedIn = false;
    resetEquiv();
    $('select-hint').hidden = true;
    $('select-info').hidden = false;
    const formatApproximate = (value, positive, negative) =>
      `${Math.abs(value).toFixed(1)}° ${value >= 0 ? positive : negative}`;
    $('select-coords').textContent = siteName
      ? `${formatApproximate(lat, 'N', 'S')}, ${formatApproximate(lon, 'E', 'W')}`
      : formatLatLon(lat, lon);
    $('select-site').hidden = !siteName;
    $('select-site').textContent = siteName
      ? `${siteName} · approximate region centre, not a touchdown point. No global Moon ice layer is available.`
      : '';
    $('goto-msg').textContent = ''; // a new selection replaces any "Go to coordinates" message
    $('goto-form').classList.remove('bad');
    draw(opts);
    saveToUrl();
    updateSummary();
  }

  function clear() {
    zoomedIn = false;
    if (shapes) shapes.remove();
    shapes = null;
    current = null;
    $('select-hint').hidden = false;
    $('select-info').hidden = true;
    $('select-site').hidden = true;
    saveToUrl();
    updateSummary();
  }

  // Radius slider (in the selection panel, bottom right). While dragging, the circle follows;
  // the area summary is recalculated once the slider stops moving.
  const slider = $('radius-slider');
  const showRadius = () => {
    $('radius-value').textContent = `${radiusKm} km`;
    slider.setAttribute('aria-valuetext', `${radiusKm} km`);
  };
  slider.value = kmToSlider(radiusKm);
  $('radius-slider').parentElement.querySelector('.radius-ticks').replaceChildren(...[1, 5, 25, 100, 250].map((km) => {
    const t = document.createElement('span');
    t.textContent = km;
    t.style.left = `${(kmToSlider(km) / SLIDER_STEPS) * 100}%`;
    return t;
  }));
  showRadius();
  let summaryTimer = null;
  slider.oninput = () => {
    const km = sliderToKm(Number(slider.value));
    if (km === radiusKm) return;
    radiusKm = km;
    showRadius();
    if (current) draw();
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => { saveToUrl(); updateSummary(); }, 250);
  };
  slider.onchange = () => {
    if (current) draw({ fit: 'if-hidden' });
    clearTimeout(summaryTimer);
    saveToUrl();
    updateSummary();
  };

  map.on('click', (e) => {
    if (isMeasuring()) return; // the ruler has the clicks
    if (planner?.isOpen()) { planner.click(e.latlng); return; } // route planner picks A and B
    if (analog || similarShown) return; // paused while search results are shown
    // polar maps: ignore clicks in the empty corners outside the world disc
    if (proj.inside) {
      const n = 256 * 2 ** map.getZoom();
      const raw = map.containerPointToLayerPoint(e.containerPoint).add(map.getPixelOrigin());
      if (!proj.inside(raw.x / n, raw.y / n)) return;
    }
    // a click on the area that's already selected zooms to it; anywhere else selects a new area
    // the second click on the selected area zooms to it, once; after that, clicks inside it do
    // nothing (no zooming again), until a new area is selected by clicking outside it
    if (current && insideSelection(e.containerPoint)) {
      if (!zoomedIn) { zoomedIn = true; zoomToSelection(); }
      return;
    }
    select(e.latlng.lat, e.latlng.lng);
  });
  $('clear-selection').onclick = clear;

  // ---- Go to typed coordinates: selects the area there, as a click would
  const gotoMsg = (text, bad = false) => {
    $('goto-msg').textContent = text;
    $('goto-form').classList.toggle('bad', bad);
  };
  $('goto-input').value = '';
  $('goto-input').title = key === 'earth'
    ? 'Latitude, longitude in degrees (south and west negative), or with N/S/E/W'
    : 'Latitude, longitude in degrees: planetocentric, east longitude (south and west negative, or 0–360° E), or with N/S/E/W';
  gotoMsg('');
  $('goto-input').oninput = () => gotoMsg('');
  $('goto-form').onsubmit = (e) => {
    e.preventDefault();
    const p = parseLatLon($('goto-input').value);
    if (p.error) { gotoMsg(p.error, true); return; }
    // e.g. the Mercator map stops short of the poles
    const maxLat = proj.bounds ? L.latLngBounds(proj.bounds).getNorth() : 90;
    if (Math.abs(p.lat) > maxLat) {
      gotoMsg(`This map only reaches ${Math.floor(maxLat)}° ${p.lat > 0 ? 'N' : 'S'}.${key === 'earth' ? '' : ' Switch to a polar map in “View”.'}`, true);
      return;
    }
    select(p.lat, p.lon, { fit: 'always' });
    gotoMsg(`Selected ${formatLatLon(p.lat, p.lon)}.`);
  };

  // Is a screen point on the selected area? (Tiny areas count within ~14 px of their centre,
  // so they can be clicked again even when the map is zoomed far out.)
  function insideSelection(point) {
    const ring = circlePoints(current.lat, current.lon, radiusKm, body.radiusKm);
    const c = map.latLngToContainerPoint([current.lat, current.lon]);
    const reach = Math.max(14, ...ring.map((ll) => c.distanceTo(map.latLngToContainerPoint(ll))));
    return c.distanceTo(point) <= reach;
  }
  // Zoom so the selected area fills the free part of the screen - the same size on screen
  // whatever its radius. Fitted in screen pixels, so it works in every projection (also
  // around a pole, where a latitude/longitude box doesn't).
  function zoomToSelection() { zoomToArea(current.lat, current.lon, radiusKm); }
  // Fly to a circular area so it fills the free part of the screen (selected area, similar spots)
  function zoomToArea(lat, lon, km) {
    const ring = circlePoints(lat, lon, km, body.radiusKm);
    // measured at the most detailed zoom, so even a 1 km area is many pixels wide
    const z0 = map.getMaxZoom();
    const pts = ring.map((ll) => map.project(ll, z0));
    const xs = pts.map((q) => q.x); const ys = pts.map((q) => q.y);
    const bw = Math.max(1, Math.max(...xs) - Math.min(...xs));
    const bh = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const { paddingTopLeft: [pl, pt], paddingBottomRight: [pr, pb] } = freeScreenPadding(6);
    const size = map.getSize();
    const freeW = size.x - pl - pr; const freeH = size.y - pt - pb;
    const z = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), z0 + Math.log2(Math.min(freeW / bw, freeH / bh))));
    const k = 2 ** (z - z0);
    // the area's middle goes to the middle of the free part of the screen
    const mid = L.point((Math.min(...xs) + Math.max(...xs)) / 2 * k, (Math.min(...ys) + Math.max(...ys)) / 2 * k);
    const shift = L.point(pl + freeW / 2 - size.x / 2, pt + freeH / 2 - size.y / 2);
    map.flyTo(map.unproject(mid.subtract(shift), z), z, { duration: 0.8 });
  }

  // 'Find similar spots' first asks how much each characteristic should count.
  async function chooseWeights() {
    const layers = Object.keys(VIEWS).filter((v) => available[v]);
    const chosen = await askWeights({
      heading: `Find similar spots on ${body.name}`,
      subheading: `${body.name} · ${formatLatLon(current.lat, current.lon)} · ${radiusKm} km radius · ` +
        `at least ${SIMILAR_MIN_KM} km away`,
      action: 'Find similar spots →',
      layers,
      initial: weights,
      count: { value: similarCount, default: SIMILAR_DEFAULT_COUNT, min: 1, max: SIMILAR_MAX_COUNT },
    });
    if (!chosen) return false;
    similarCount = chosen.count;
    delete chosen.count;
    weights = chosen;
    saveToUrl();
    return true;
  }
  $('find-analogs').onclick = () => findEarthAnalogs(current);
  // Ask for the weights, then open Earth to search for analogs of an area around 'at'.
  // With a planned route: the area is the circle around the route (its midpoint, half its length,
  // within the allowed radii), and the route goes along, to drive it again at the analogs.
  async function findEarthAnalogs(at, route = null) {
    const areaKm = route ? Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, Math.round(route.km / 2))) : radiusKm;
    const countryData = await loadCountries().catch(() => null); // the filter is optional
    const chosen = await askWeights({
      countries: countryData ? { value: analogCountries, list: countryData.list } : null,
      heading: route ? 'Find Earth analogs for this route' : 'Find Earth analogs',
      subheading: `${body.name} · ${formatLatLon(at.lat, at.lon)} · ${areaKm} km radius`,
      action: 'Find Earth analogs →',
      items: Object.entries(PARAMS).filter(([, p]) => !p.worlds || p.worlds.includes(key))
        .map(([k, p]) => ({ key: k, name: p.name, help: p.help })),
      steps: WEIGHT_STEPS,
      initial: { ...DEFAULT_WEIGHTS, ...analogWeights },
      defaults: DEFAULT_WEIGHTS,
      count: { value: analogCount, default: DEFAULT_COUNT, min: 1, max: MAX_COUNT },
      mode: {
        value: analogMode,
        default: 'match',
        options: [
          ['match', 'Match my site', `Places whose temperatures are closest to this site's. Where ${body.name} is ` +
            'beyond anything on Earth, places that are as cold (or warm) for Earth as this site is for ' +
            `${body.name}.`],
          ['extreme', 'Most extreme', 'The most extreme places on Earth in the direction of this site: coldest, ' +
            'hottest or biggest day–night swing.'],
        ],
      },
      toggle: { value: analogNewOnly, label: 'Only new places',
        help: `Leave out known analog regions (within ${KNOWN_REGION_KM} km of a site already used for Moon or Mars research).` },
    });
    if (!chosen) return;
    analogNewOnly = chosen.toggle;
    delete chosen.toggle;
    if (chosen.countries) analogCountries = chosen.countries;
    delete chosen.countries;
    analogMode = chosen.mode;
    analogCount = chosen.count;
    delete chosen.mode;
    delete chosen.count;
    analogWeights = chosen;
    saveToUrl();
    const site = new URLSearchParams({ from: key, site: `${at.lat.toFixed(4)},${at.lon.toFixed(4)}`,
      sr: areaKm, w: formatWeights(analogWeights), mode: analogMode, n: analogCount });
    if (analogNewOnly) site.set('new', '1');
    if (route) {
      const f = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      site.set('src', `${f(route.a)};${f(route.b)}`);
      site.set('str', route.traveller);
      if (route.season) site.set('sss', route.season);
    }
    if (formatCountryFilter(analogCountries)) site.set('c', formatCountryFilter(analogCountries));
    location.hash = `#/earth?${site}`;
  }
  $('find-similar').onclick = async () => {
    if (!Object.keys(available).length || !(await chooseWeights())) return;
    showSimilarResults();
  };
  // Moon and Mars: stand at the selected point in 3D
  $('view-3d').hidden = !WORLDS_3D.includes(key);
  $('view-3d').onclick = () => {
    location.hash = `#/${key}3d?lat=${current.lat.toFixed(5)}&lon=${current.lon.toFixed(5)}`;
  };

  // ---- 'Find similar spots': search this world, show the best spots on the map
  let similarGroup = null;
  function exitSimilar() {
    similarShown = false;
    similarGroup?.remove();
    similarGroup = null;
    $('analog-banner').hidden = true;
    $('results-analogs').hidden = true;
    $('select-panel').hidden = false;
    $('back-to-site').textContent = '← Back to this site';
  }
  function showSimilarResults() {
    const site = { ...current };
    const r = radiusKm;
    const w = Object.entries(weights).filter(([k, v]) => v > 0 && available[k]).sort((a, b) => b[1] - a[1]);
    const total = w.reduce((a, [, v]) => a + v, 0);
    similarShown = true;
    $('select-panel').hidden = true;
    $('analog-heading').textContent = `Similar spots on ${body.name} to`;
    $('analog-source').textContent = formatLatLon(site.lat, site.lon);
    const cell = Math.round(cellKm(body.radiusKm));
    $('analog-radius').textContent = `${r} km radius · at least ${SIMILAR_MIN_KM} km away` +
      (r < cell ? ` · compared at ~${cell} km detail` : '');
    $('analog-weights').textContent = `Weights: ${w.map(([k, v]) => `${VIEWS[k].name} ${Math.round((v / total) * 100)}%`).join(' · ')}`;
    $('analog-results').replaceChildren();
    $('analog-compare').hidden = true;
    $('analog-status').textContent = 'Searching…';
    $('analog-banner').hidden = false;
    $('back-to-site').onclick = () => {
      map.flyToBounds(L.latLngBounds(circlePoints(site.lat, site.lon, Math.max(r, 50), body.radiusKm)),
        { padding: [60, 60], duration: 0.8 });
    };
    $('exit-results').onclick = exitSimilar;
    // Earth analogs of the site, or of a spot once one is picked (see pick())
    const toEarth = $('results-analogs');
    toEarth.textContent = 'Find Earth analogs for this site';
    toEarth.onclick = () => findEarthAnalogs(site);
    toEarth.hidden = false;

    const thisMap = map;
    const still = () => map === thisMap && similarShown;
    findSimilar({
      body: key, sphereKm: body.radiusKm, layers: available, weights: Object.fromEntries(w), site,
      radiusKm: r, count: similarCount,
      onProgress: (text) => { if (still()) $('analog-status').textContent = text; },
    }).then((found) => {
      if (!still()) return;
      if (import.meta.env.DEV) console.log('similar spots', found);
      showSpots(found, site, r);
    }).catch((err) => {
      console.error(err);
      if (still()) $('analog-status').textContent = 'The search failed to load its data. Please try again.';
    });
  }
  function showSpots({ results, site: siteValues, used, skipped }, site, r) {
    $('analog-status').textContent = (results.length
      ? (results.length === 1 ? 'Best spot.' : `Best ${results.length} spots, at least ${SIMILAR_MIN_KM} km from the site and from each other.`)
      : 'No matching spots found.') +
      (skipped.length ? ` No data at the site for: ${skipped.map((k) => VIEWS[k].name).join(', ')}.` : '');
    similarGroup = L.layerGroup().addTo(map);
    const markers = [];
    const items = results.map((res, i) => {
      L.polygon(circlePoints(res.lat, res.lon, r, body.radiusKm), { className: 'analog-area', interactive: false })
        .addTo(similarGroup);
      const m = L.marker([res.lat, res.lon], {
        icon: L.divIcon({ className: '', html: `<span class="analog-marker">${i + 1}</span>`, iconSize: [26, 26] }),
        keyboard: false, title: `Spot ${i + 1}`,
      }).addTo(similarGroup);
      m.on('click', () => pick(i));
      markers.push(m);
      const li = document.createElement('li');
      li.innerHTML = '<button type="button" aria-pressed="false"><span class="num"></span><span class="where"></span><span class="sim"></span></button>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.where').textContent = `${formatLatLon(res.lat, res.lon)} · ${formatKm(res.km)}`;
      li.querySelector('.sim').textContent = `${similarity(res.score)}% match`;
      li.querySelector('button').onclick = () => pick(i);
      return li;
    });
    $('analog-results').replaceChildren(...items);
    // show the site and every spot
    if (results.length) {
      const all = L.latLngBounds([[site.lat, site.lon], ...results.map((p) => [p.lat, p.lon])]);
      map.flyToBounds(all, { padding: [80, 80], duration: 0.8, maxZoom: map.getZoom() + 1 });
    }

    // clicking a spot (in the list or its marker on the map) zooms so it fills the free screen
    function pick(i) {
      const res = results[i];
      items.forEach((li, j) => li.querySelector('button').setAttribute('aria-pressed', i === j));
      markers.forEach((m, j) => m.getElement()?.firstChild?.classList.toggle('picked', i === j));
      zoomToArea(res.lat, res.lon, r);
      const rows = used.map((k) => `<tr><td>${VIEWS[k].name}</td><td>${formatValue(available[k], siteValues[k])}</td>` +
        `<td>${formatValue(available[k], res.values[k])}</td></tr>`);
      const box = $('analog-compare');
      box.innerHTML = `<p class="c-title">Spot ${i + 1} compared with the site · ${formatKm(res.km)} away</p>
        <table><thead><tr><th></th><th>Site</th><th>Spot ${i + 1}</th></tr></thead><tbody>${rows.join('')}</tbody></table>
        <p class="sub" style="margin-top:.4rem">Averages over each area, from the map data at ~${Math.round(cellKm(body.radiusKm))} km
        detail, so they can differ a little from the area summary (top right), which shows the selected site's medians.</p>`;
      box.hidden = false;
      $('results-analogs').textContent = `Find Earth analogs for spot ${i + 1}`;
      $('results-analogs').onclick = () => findEarthAnalogs(res);
    }
  }

  // ---- 'Find sites': search the whole world by criteria instead of clicking (src/sitefinder.js)
  const finderWorld = key === 'mars' || key === 'moon';
  $('finder-btn').hidden = !finderWorld;
  $('finder-btn').onclick = async () => {
    if (!finderWorld || !Object.keys(available).length) return;
    const chosen = await askCriteria({ body: key, bodyName: body.name, layers: available, radiusKm, initial: finderState[key] });
    if (!chosen) return;
    finderState[key] = chosen;
    showFoundSites(chosen);
  };
  // "Slope ≤ 3° (lower is better, ×2)"
  const fmtCrit = (k) => (k === LATITUDE ? (v) => `${Math.round(v * 10) / 10}°`
    : k === 'relief' ? (v) => `${Math.round(v * 1000)} m` : (v) => formatValue(available[k], v));
  function describeLimits(k, c) {
    const f = fmtCrit(k);
    const lim = c.min !== undefined && c.max !== undefined ? `${f(c.min)} to ${f(c.max)}`
      : c.min !== undefined ? `≥ ${f(c.min)}` : c.max !== undefined ? `≤ ${f(c.max)}` : '';
    const pref = c.prefer ? `${lim ? ', ' : ''}${c.prefer === 'low' ? 'lower' : 'higher'} is better` : '';
    return `${lim}${pref}${c.weight !== 1 ? ` (×${c.weight})` : ''}`;
  }
  function showFoundSites({ criteria, count, preset }) {
    exitSimilar();
    const r = radiusKm;
    similarShown = true; // map clicks pause while results are shown, as for similar spots
    $('select-panel').hidden = true;
    $('analog-heading').textContent = `Sites on ${body.name} that meet`;
    $('analog-source').textContent = PRESETS[key]?.find((p) => p.id === preset)?.name ?? 'Your criteria';
    $('analog-radius').textContent = `${r} km radius (set with the radius slider) · at least ${SITE_SEPARATION_KM} km apart`;
    $('analog-weights').textContent = Object.entries(criteria).map(([k, c]) => `${criterionName(k)} ${describeLimits(k, c)}`).join(' · ');
    $('analog-results').replaceChildren();
    $('analog-compare').hidden = true;
    $('analog-status').textContent = 'Searching…';
    $('analog-banner').hidden = false;
    $('back-to-site').textContent = 'Change criteria';
    $('back-to-site').onclick = () => $('finder-btn').click();
    $('exit-results').onclick = exitSimilar;
    $('results-analogs').hidden = true;
    const thisMap = map;
    const still = () => map === thisMap && similarShown;
    findSites({ body: key, sphereKm: body.radiusKm, layers: available, criteria, radiusKm: r, count,
      onProgress: (text) => { if (still()) $('analog-status').textContent = text; } })
      .then((found) => { if (still()) showSiteResults(found, criteria, r); })
      .catch((err) => {
        console.error(err);
        if (still()) $('analog-status').textContent = 'The search failed to load its data. Please try again.';
      });
  }
  function showSiteResults(found, criteria, r) {
    const { results, used, passShare, shares, cellKm: cell } = found;
    if (import.meta.env.DEV) console.log('sites', found);
    const pct = (x) => (x >= 0.1 ? `${Math.round(x * 100)}%` : x >= 0.001 ? `${(x * 100).toFixed(1)}%` : x > 0 ? 'under 0.1%' : '0%');
    // when nothing passes, say which limit rules out most of the surface
    const strictest = used.filter((k) => criteria[k].min !== undefined || criteria[k].max !== undefined)
      .sort((a, b) => shares[a] - shares[b])[0];
    $('analog-status').textContent = results.length
      ? `${pct(passShare)} of ${body.name}’s surface meets every limit. Best ${results.length === 1 ? 'site' : `${results.length} sites`}, ranked by how well they fit (~${Math.round(cell)} km detail).`
      : `No area meets every limit.${strictest ? ` The strictest: ${criterionName(strictest)} (${pct(shares[strictest])} of the surface passes it on its own).` : ''} Try “Change criteria”.`;
    similarGroup = L.layerGroup().addTo(map);
    const markers = [];
    const items = results.map((res, i) => {
      L.polygon(circlePoints(res.lat, res.lon, r, body.radiusKm), { className: 'analog-area', interactive: false }).addTo(similarGroup);
      const m = L.marker([res.lat, res.lon], {
        icon: L.divIcon({ className: '', html: `<span class="analog-marker">${i + 1}</span>`, iconSize: [26, 26] }),
        keyboard: false, title: `Site ${i + 1}`,
      }).addTo(similarGroup);
      m.on('click', () => pick(i));
      markers.push(m);
      const li = document.createElement('li');
      li.innerHTML = '<button type="button" aria-pressed="false"><span class="num"></span><span class="where"></span><span class="sim"></span></button>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.where').textContent = formatLatLon(res.lat, res.lon);
      li.querySelector('.sim').textContent = `${Math.round(res.fit * 100)}% fit`;
      li.querySelector('button').onclick = () => pick(i);
      return li;
    });
    $('analog-results').replaceChildren(...items);
    if (results.length) {
      map.flyToBounds(L.latLngBounds(results.map((p) => [p.lat, p.lon])).pad(0.3), { padding: [80, 80], duration: 0.8 });
    }
    function pick(i) {
      const res = results[i];
      items.forEach((li, j) => li.querySelector('button').setAttribute('aria-pressed', i === j));
      markers.forEach((m, j) => m.getElement()?.firstChild?.classList.toggle('picked', i === j));
      zoomToArea(res.lat, res.lon, r);
      const rows = used.map((k) => `<tr><td>${criterionName(k)}</td><td>${describeLimits(k, criteria[k]) || '–'}</td>` +
        `<td>${fmtCrit(k)(res.values[k])}</td></tr>`);
      const box = $('analog-compare');
      box.innerHTML = `<p class="c-title">Site ${i + 1} · ${formatLatLon(res.lat, res.lon)} · ${Math.round(res.fit * 100)}% fit</p>
        <table><thead><tr><th></th><th>Criterion</th><th>Here</th></tr></thead><tbody>${rows.join('')}</tbody></table>
        <p class="sub" style="margin-top:.4rem">Averages over the ${r} km area from the map data at ~${Math.round(cell)} km detail.
        Fit: where the site stands on your preferences among all areas that meet the limits, by importance (100% = the best of them on every one); with no preferences, how comfortably it meets the limits.</p>
        <button type="button" class="view-3d-btn finder-select">Select this site &rarr;</button>`;
      box.querySelector('.finder-select').onclick = () => { exitSimilar(); select(res.lat, res.lon, { fit: 'always' }); };
      box.hidden = false;
      $('results-analogs').textContent = `Find Earth analogs for site ${i + 1}`;
      $('results-analogs').onclick = () => findEarthAnalogs(res);
      $('results-analogs').hidden = false;
    }
  }

  // ---- Route planner (Mars and Moon): A to B, with the dangers on the way. On Earth only at an
  // analog search's results, to drive the same route there (src/route/compare.js).
  const routeWorld = true;
  $('plan-route').hidden = key === 'earth' && analog; // (at Earth analog results: 'Drive the same route here')
  $('route-analogs').hidden = true;
  if (routeWorld) {
    const showRoutePanels = (open) => {
      $('select-panel').hidden = open || analog;
      if (open) $('area-panel').hidden = true; else updateSummary();
    };
    // 3D terrain of the route: the button shows once A and B are set (and stays while the
    // 3D view is open, as its way back to the 2D map)
    const btn3d = $('btn-3d');
    const update3dButton = () => {
      const r = planner?.result();
      btn3d.hidden = key === 'earth' || !((r?.open && r.a && r.b) || terrainView?.isOpen());
    };
    // Earth: the site route to compare with: the one planned at the site, or a crossing of the site area
    let compare = null;
    const pairOf = (text) => {
      const pts = (text ?? '').split(';').map((t) => t.split(',').map(Number));
      return pts.length === 2 && pts.every((p) => p.length === 2 && p.every(Number.isFinite))
        ? { a: { lat: pts[0][0], lon: pts[0][1] }, b: { lat: pts[1][0], lon: pts[1][1] } } : null;
    };
    // Moon / Mars opened from an Earth route's equivalents: compare with that Earth route
    if (key !== 'earth' && params.get('cmp') === 'earth' && pairOf(params.get('ca'))) {
      compare = { world: 'earth', ...pairOf(params.get('ca')), season: 0, match: params.has('em') ? Number(params.get('em')) : NaN };
    }
    if (key === 'earth' && analog) {
      const from = BODIES[params.get('from')] && params.get('from') !== 'earth' ? params.get('from') : 'mars';
      const [sLat, sLon] = (params.get('site') ?? '').split(',').map(Number);
      const pts = (params.get('src') ?? '').split(';').map((t) => t.split(',').map(Number));
      const ok = pts.length === 2 && pts.every((p) => p.length === 2 && p.every(Number.isFinite));
      compare = ok
        ? { world: from, a: { lat: pts[0][0], lon: pts[0][1] }, b: { lat: pts[1][0], lon: pts[1][1] }, season: Number(params.get('sss')) || 0 }
        : { world: from, ...siteCrossing({ lat: sLat, lon: sLon }, radiusKm, from) };
      if (!params.has('tr') && params.has('str')) params.set('tr', params.get('str')); // the same traveller
    }
    planner = createRoutePlanner(map, params, () => {
      showRoutePanels(planner?.isOpen() ?? true); saveToUrl(); update3dButton();
    }, key, { compare });
    // Moon / Mars: with a route, find Earth analogs for it (and drive it there); the planner shows the button
    update3dButton(); // (a route restored from the address)
    saveToUrl(); // (the planner's part of the address, now that `planner` is set)
    $('route-analogs').onclick = () => {
      const res = planner.result();
      if (!res.a || !res.b) return;
      const km = routeKm(res.a.lat, res.a.lon, res.b.lat, res.b.lon, body.radiusKm);
      const mid = destination(res.a, bearingDeg(res.a, res.b), km / 2, body.radiusKm);
      findEarthAnalogs(mid, { a: res.a, b: res.b, km, traveller: res.traveller, season: res.season });
    };
    // Earth: the Mars / Moon equivalent of a route. Opened from Mars (or the Moon) only that world
    // is offered; opened from the home page, both. The search looks at the circle around the
    // route (its midpoint, half its length), then opens that world's planner with the same route
    // (length, direction, traveller) at the best-matching spot, compared with the Earth route.
    if (key === 'earth') {
      const fromWorld = params.get('from');
      const offered = fromWorld === 'mars' || fromWorld === 'moon' ? [fromWorld] : ['mars', 'moon'];
      for (const w of ['mars', 'moon']) {
        const btn = $(`route-eq-${w}`);
        btn.hidden = !offered.includes(w);
        btn.disabled = false;
        btn.textContent = `${w === 'mars' ? '🔴 Find the Mars' : '🌕 Find the Moon'} equivalent of this route`;
        btn.onclick = () => routeEquivalent(w, btn);
      }
      $('route-eq-status').textContent = '';
    }
    let equivToken2 = 0;
    async function routeEquivalent(w, btn) {
      const res = planner.result();
      if (!res.a || !res.b) return;
      const my = ++equivToken2;
      const label = btn.textContent;
      const say = (t) => { if (my === equivToken2) $('route-eq-status').textContent = t; };
      const km = routeKm(res.a.lat, res.a.lon, res.b.lat, res.b.lon, body.radiusKm);
      const mid = destination(res.a, bearingDeg(res.a, res.b), km / 2, body.radiusKm);
      const areaKm = Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, Math.round(km / 2)));
      const the = w === 'moon' ? 'the Moon' : 'Mars';
      btn.disabled = true;
      btn.textContent = `Searching ${the}…`;
      try {
        const found = await findEquivalents({ lat: mid.lat, lon: mid.lon, radiusKm: areaKm, index: await loadIndex(), onProgress: say, worlds: [w] });
        if (my !== equivToken2) return;
        const best = found?.worlds[w]?.results[0];
        if (!found) { say('No land data around this route (sea or ice sheet): nothing to compare.'); return; }
        if (!best) { say(`No ${BODIES[w].name} data to compare with.`); return; }
        say(`${best.match}% match${best.match >= CLOSE_MATCH ? '' : ' (no close equivalent)'}: opening ${the}…`);
        // the same route at the best spot: same length and direction, centred on it
        const R = BODIES[w].radiusKm;
        const brg = bearingDeg(res.a, res.b);
        const line = { a: destination(best, (brg + 180) % 360, km / 2, R), b: destination(best, brg, km / 2, R) };
        const f = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        const q = new URLSearchParams({ route: `${f(line.a)};${f(line.b)}`, tr: res.traveller, cmp: 'earth', ca: `${f(res.a)};${f(res.b)}`, em: best.match });
        location.hash = `#/${w}?${q}`;
      } catch (err) {
        console.error(err);
        say('The search failed to load its data.');
      } finally {
        if (my === equivToken2 && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      }
    }
    // Earth analogs: 'Drive the same route here' at a result
    driveAt = async (res) => {
      const line = await sameRouteOnEarth(compare, res);
      planner.setRoute(line.a, line.b, { turned: line.turned });
    };
    $('plan-route').onclick = () => { if (shapes) clear(); planner.open(); };
    const set3dButton = (on) => {
      btn3d.setAttribute('aria-pressed', on);
      // the long word is hidden on phones, where the top bar is short of space
      btn3d.innerHTML = on ? '🗺 2D<span class="long"> map</span>' : '⛰ 3D<span class="long"> terrain</span>';
    };
    set3dButton(false);
    btn3d.onclick = async () => {
      await getTerrainView();
      if (terrainView.isOpen()) { terrainView.close(); return; }
      if (shapes) clear();
      set3dButton(true);
      terrainView.open({
        world: key,
        planner,
        onClose: () => { set3dButton(false); update3dButton(); },
        getLeafletView: () => {
          const c = map.getCenter();
          const b = map.getBounds();
          const wKm = viewWidthKm(body);
          const hKm = Math.min(180, b.getNorth() - b.getSouth()) * (Math.PI / 180) * body.radiusKm;
          return { lat: c.lat, lon: c.lng, wKm, hKm };
        },
      });
    };
  }

  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  // (after a projection change the carried-over view is kept, so the selection doesn't re-zoom)
  if (Number.isFinite(lat) && Number.isFinite(lon)) select(lat, lon, { fit: analog || carryView ? undefined : 'always' });
  appHooks.selectPoint = (lat, lon) => select(lat, lon, { fit: 'always' });
  // tutorial: start from the whole planet, nothing selected
  appHooks.zoomOut = () => {
    clear();
    map.setView(proj.center, map.getMinZoom(), { animate: false });
  };
  // tutorial: select the spot under a screen point, as a normal map click would
  appHooks.selectAt = (clientX, clientY) => {
    const p = map.mouseEventToContainerPoint({ clientX, clientY });
    if (proj.inside) {
      const n = 256 * 2 ** map.getZoom();
      const raw = map.containerPointToLayerPoint(p).add(map.getPixelOrigin());
      if (!proj.inside(raw.x / n, raw.y / n)) return false;
    }
    const ll = map.containerPointToLatLng(p);
    select(ll.lat, ll.lng);
    return true;
  };
  return { select, clear, current: () => current, saveToUrl, driveAt: (res) => driveAt?.(res) };
}

// ---- Earth page opened from "Find Earth analogs": the search and its results ---------

// number of places to find, from the address; 1-10, default 3
function parseCount(text, fallback = DEFAULT_COUNT) {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= MAX_COUNT ? n : fallback;
}

// Padding for fitting something into the part of the map not covered by panels: the
// results panel (left on wide screens, bottom on phones), the area summary (top right),
// the top buttons and the bottom-left map controls.
function freeScreenPadding(gap = 24) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const box = (id) => { const el = $(id); return el && !el.hidden ? el.getBoundingClientRect() : null; };
  const left = box('analog-banner');
  const summary = box('area-panel');
  const selectPanel = box('select-panel');
  let pl = gap; let pr = gap; let pt = 70 + gap; let pb = gap;
  if (W > 600) {
    if (left) pl = Math.max(pl, left.right + gap);
    if (summary) pr = Math.max(pr, W - summary.left + gap);
    if (selectPanel) pr = Math.max(pr, W - selectPanel.left + gap);
    // bottom-left map controls (landmarks switch, active layer legend, zoom readout)
    const controls = document.querySelector('#map-view .leaflet-bottom.leaflet-left')?.getBoundingClientRect();
    if (controls && controls.width > 0) pl = Math.max(pl, controls.right + gap);
  } else {
    if (left) pb = Math.max(pb, H - left.top + gap);
    if (selectPanel) pb = Math.max(pb, H - selectPanel.top + gap);
    if (summary) pt = Math.max(pt, summary.bottom + gap);
    // bottom-left map controls: keep the area beside them or above them, whichever leaves more room
    const controls = document.querySelector('#map-view .leaflet-bottom.leaflet-left')?.getBoundingClientRect();
    if (controls && controls.width > 0 && controls.top < H - pb) {
      const besideW = W - (controls.right + gap) - pr; const besideH = H - pt - pb;
      const aboveW = W - pl - pr; const aboveH = controls.top - gap - pt;
      if (Math.min(besideW, besideH) >= Math.min(aboveW, aboveH)) pl = Math.max(pl, controls.right + gap);
      else pb = Math.max(pb, H - controls.top + gap);
    }
  }
  // always leave room for the area itself: a third of the width, and at least 160 px of height
  pl = Math.min(pl, W / 3); pr = Math.min(pr, W / 3);
  if (H - pt - pb < 160) pb = Math.max(gap, H - pt - 160);
  return { paddingTopLeft: [pl, pt], paddingBottomRight: [pr, pb] };
}

function showAnalogResults(params, selection) {
  const from = BODIES[params.get('from')] ? params.get('from') : 'mars';
  const source = BODIES[from];
  const [lat, lon] = (params.get('site') ?? '').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const r = parseFloat(params.get('sr')) || DEFAULT_RADIUS_KM;
  const weights = parseAnalogWeights(params.get('w'));
  if (!Object.values(weights).some((v) => v > 0)) Object.assign(weights, DEFAULT_WEIGHTS);
  const mode = params.get('mode') === 'extreme' ? 'extreme' : 'match';
  const count = parseCount(params.get('n'));
  const newOnly = params.get('new') === '1';
  const countryFilter = parseCountryFilter(params.get('c'));

  $('results-analogs').hidden = true;
  $('analog-heading').textContent = 'Earth analogs for';
  $('analog-source').textContent = `${source.name} · ${formatLatLon(lat, lon)}`;
  $('analog-radius').textContent = `${r} km radius · ${mode === 'extreme' ? 'most extreme' : 'match my site'}${newOnly ? ' · only new places' : ''}`;
  const w = Object.entries(weights).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = w.reduce((a, [, v]) => a + v, 0);
  $('analog-weights').textContent = `Weights: ${w.map(([k, v]) => `${PARAMS[k].name} ${Math.round((v / total) * 100)}%`).join(' · ')}`;
  $('back-to-site').onclick = () => {
    location.hash = lastPage[from] ?? `#/${from}?lat=${lat}&lon=${lon}&r=${r}`;
  };
  $('exit-results').onclick = () => {
    // back to the plain Earth map (same view and projection); selecting works again
    const q = new URLSearchParams({ from });
    const cur = new URLSearchParams(location.hash.split('?')[1] ?? '');
    for (const k of ['view', 'proj']) if (cur.has(k)) q.set(k, cur.get(k));
    location.hash = `#/earth?${q}`;
  };
  $('analog-results').replaceChildren();
  $('analog-compare').hidden = true;
  $('analog-status').textContent = 'Searching every land area on Earth…';
  $('analog-banner').hidden = false;

  const thisMap = map;
  let countries = null;
  (async () => {
    const index = await loadIndex();
    const site = await siteValues(from, source.radiusKm, index[from] ?? {}, lat, lon, r);
    const t0 = performance.now();
    // countries: shown for every result, and (optionally) used to leave places out
    countries = await loadCountries().catch(() => null);
    if (countries && countryFilter.mode !== 'any') {
      $('analog-radius').textContent += ` · ${describeFilter(countryFilter, countries)}`;
    }
    const exclude = (la, lo) => (newOnly && inKnownRegion(la, lo)) ||
      (countries ? filteredOut(countryFilter, countries.at(la, lo)) : false);
    const found = await findAnalogs({ site, weights, mode, radiusKm: r, count, exclude });
    if (map !== thisMap) return; // the page has changed meanwhile
    if (r < REFINE_BELOW_KM && found.results.length) {
      $('analog-status').textContent = 'Refining positions with ~5 km terrain data…';
      await refineResults({ results: found.results, found, weights, radiusKm: r, slopeMeta: index.earth?.slope });
      found.results.sort((a, b) => a.score - b.score);
      if (map !== thisMap) return;
    }
    if (import.meta.env.DEV) { console.log(`analog search: ${Math.round(performance.now() - t0)} ms`, found, site); window.__lastAnalogs = found; }
    showResults(found, site);
  })().catch((err) => {
    console.error(err);
    $('analog-status').textContent = 'The search failed to load its data.';
  });

  function showResults(found, site) {
    const { results, used } = found;
    const skipped = Object.keys(weights).filter((k) => weights[k] > 0 && !used.includes(k));
    $('analog-status').textContent = results.length
      ? (results.length === 1 ? 'Best area.' : `Best ${results.length} areas, at least ${MIN_SEPARATION_KM} km apart.`) +
        (skipped.length ? ` No ${source.name} data here for: ${skipped.map((k) => PARAMS[k].name).join(', ')}.` : '')
      : (countryFilter.mode !== 'any' ? 'No matching areas found with this country filter.' : 'No matching areas found.');
    const group = L.layerGroup().addTo(map);
    const markers = [];
    const buttons = results.map((res, i) => {
      L.polygon(circlePoints(res.lat, res.lon, r, BODIES.earth.radiusKm), { className: 'analog-area', interactive: false })
        .addTo(group);
      const m = L.marker([res.lat, res.lon], {
        icon: L.divIcon({ className: '', html: `<span class="analog-marker">${i + 1}</span>`, iconSize: [26, 26] }),
        keyboard: false, title: `Analog ${i + 1}`,
      }).addTo(group);
      m.on('click', () => pick(i));
      markers.push(m);
      const li = document.createElement('li');
      li.innerHTML = '<button type="button" aria-pressed="false"><span class="num"></span><span class="where"></span><span class="sim"></span><span class="nov"></span></button>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.where').textContent = formatLatLon(res.lat, res.lon);
      res.country = countries ? countries.nameAt(res.lat, res.lon) : null;
      if (res.country) {
        const c = document.createElement('span');
        c.className = 'country';
        c.textContent = res.country;
        li.querySelector('.where').append(c);
      }
      li.querySelector('.sim').textContent = `${similarity(res.score)}% match`;
      const nov = novelty(res.lat, res.lon);
      const novEl = li.querySelector('.nov');
      novEl.textContent = nov.known ? `Known analog region (${nov.site.name})` : 'New analog';
      novEl.classList.add(nov.known ? 'known' : 'new');
      li.querySelector('button').onclick = () => pick(i);
      return li;
    });
    $('analog-results').replaceChildren(...buttons);

    // Selecting a result (in the list or on the map) zooms so its area fills the part of
    // the screen that the panels leave free.
    function pick(i) {
      const res = results[i];
      buttons.forEach((li, j) => li.querySelector('button').setAttribute('aria-pressed', i === j));
      markers.forEach((m, j) => m.getElement()?.firstChild?.classList.toggle('picked', i === j));
      selection?.select(res.lat, res.lon);
      const area = L.latLngBounds(circlePoints(res.lat, res.lon, r, BODIES.earth.radiusKm));
      map.flyToBounds(area, { ...freeScreenPadding(), duration: 0.9, maxZoom: map.getMaxZoom() });
      showComparison(i, res, site, found);
    }
  }

  function showComparison(i, res, site, found) {
    const { relative = {}, targets = {} } = found;
    const fmt = formatParam;
    const rows = Object.keys(res.values).map((k) => {
      const p = PARAMS[k];
      let siteCell = p.site ? formatSite(k, site[k]) : `<span class="note">${p.better === 'low' ? 'lower wins' : 'higher wins'}</span>`;
      if (k in relative) {
        // beyond Earth's range: matched to the same percentile of Earth
        const pct = Math.round(relative[k] * 100);
        siteCell += `<br><span class="note" title="${pct}% of ${source.name} is below this value; matched to Earth's ${ordinal(pct)} percentile">` +
          `${ordinal(pct)} pct → ${fmt(k, targets[k])} on Earth</span>`;
      }
      return `<tr><td>${p.name}</td><td>${siteCell}</td><td>${fmt(k, res.values[k])}</td></tr>`;
    });
    const box = $('analog-compare');
    box.innerHTML = `<button type="button" class="primary analog-sim">🛠 Simulation Planning</button>
      <div class="analog-3d-row">
        <button type="button" class="view-3d-btn analog-3d">Stand here in 3D &rarr;</button>
        <button type="button" class="view-3d-btn analog-terrain">⛰ 3D terrain</button>
      </div>
      <div class="analog-drive">
        <button type="button" class="view-3d-btn analog-route">🛣 ${params.has('src') ? 'Drive the same route here' : 'Drive across this area'} &rarr;</button>
        <p class="sub">${params.has('src')
    ? `Plans your ${source.name} route (same length, same traveller) in this area and compares the two.`
    : `Plans a route across this area with a ${source.name} traveller and compares it with the same crossing of the site. Tip: plan a route on the ${source.name} map, then "Find Earth analogs for this route".`}</p>
      </div>
      <p class="c-title">Area ${i + 1}${res.country ? ` · ${res.country}` : ''} compared with the site</p>
      <table><thead><tr><th></th><th>${source.name}</th><th>Earth</th></tr></thead><tbody>${rows.join('')}</tbody></table>
      <p class="sub" style="margin-top:.4rem">Values beyond anything on Earth are matched relatively:
      as cold (or warm) for Earth as the site is for ${source.name}. Search values are averages over the area. The area summary
      (top right) shows this Earth area's typical values from the map data.</p>
      ${reportCardHtml({ from, worldName: source.name, res, site, found, weights })}`;
    featuresNear(res.lat, res.lon, r).then((f) => {
      const slot = box.querySelector('.rc-features-slot');
      if (slot) slot.outerHTML = featuresHtml(f);
    }).catch(() => {});
    // Simulation Planning: what recreating the site's environment here would take (src/simplan/)
    const simCtx = { from, worldName: source.name, siteName: formatLatLon(lat, lon), res, site, found, weights,
      placeName: `Area ${i + 1}${res.country ? ` · ${res.country}` : ''}` };
    box.querySelector('.analog-sim').onclick = () => simPanel().open(simCtx);
    if (simPanelInstance?.isOpen()) simPanelInstance.update(simCtx); // follows the selected result
    // detailed 3D landscape of this area's centre, loaded only on request
    // drive the site's route here: the planner opens with it, compared side by side
    box.querySelector('.analog-route').onclick = (e) => {
      e.currentTarget.disabled = true;
      Promise.resolve(selection?.driveAt(res)).finally(() => { e.currentTarget.disabled = false; });
    };
    box.querySelector('.analog-3d').onclick = () => {
      location.hash = `#/earth3d?lat=${res.lat.toFixed(5)}&lon=${res.lon.toFixed(5)}`;
    };
    // bird's-eye 3D model of the area and its surroundings (src/terrain3d/, as on Mars):
    // the area's tile is 4 radii wide, with the ring of the area on it
    box.querySelector('.analog-terrain').onclick = async () => {
      await getTerrainView();
      terrainView.open({ world: 'earth', region: { lat: res.lat, lon: res.lon, wKm: 4 * r, hKm: 4 * r, ringKm: r, name: `Area ${i + 1}` } });
    };
    box.hidden = false;
  }
}

// ---- Earth <-> Moon/Mars switch (top right) ---------------------------------

// The last address of each Moon/Mars map, so switching back restores its view and selection.
const lastPage = {};
const ICONS = { earth: iconEarth, moon: iconMoon, mars: iconMars };
// Earth view from the home page: Earth on its own (route equivalents on both Mars and the Moon)
$('home-earth').querySelector('img').src = iconEarth;
$('home-earth').onclick = () => { location.hash = '#/earth'; };

function setUpWorldSwitch(key, params) {
  const btn = $('switch-world');
  // From the Moon/Mars: go to Earth. From Earth: back to where it was opened from.
  const target = key === 'earth' ? (BODIES[params.get('from')] ? params.get('from') : 'mars') : 'earth';
  btn.querySelector('img').src = ICONS[target];
  const name = BODIES[target].name;
  btn.querySelector('.sw-text').innerHTML = key === 'earth'
    ? `<span class="sw-long">Back to </span>${name}<span class="sw-long"> view</span>`
    : `${name}<span class="sw-long"> view</span>`;
  btn.setAttribute('aria-label', key === 'earth' ? `Back to ${name} view` : `${name} view`);
  btn.onclick = () => {
    location.hash = key === 'earth' ? (lastPage[target] ?? `#/${target}`) : `#/earth?from=${key}`;
  };
  btn.hidden = false;
}

// Hooks the first-visit tutorial uses to drive the app (filled in when a map opens)
const appHooks = {
  openBody: (key) => { location.hash = `#/${key}`; },
  currentBody: () => location.hash.replace(/^#\/?/, '').split('?')[0],
  openMenu: () => {},
  selectPoint: () => {},
  zoomOut: () => {},
  selectAt: () => false,
  bodyName: () => 'Mars',
};

const finderState = {}; // last 'Find sites' criteria per world, for this visit
let simPanelInstance = null; // Simulation Planning panel (src/simplan/), made when first opened
const simPanel = () => (simPanelInstance ??= createSimPanel());

function hidePanels() {
  if (terrainView?.isOpen()) terrainView.close();
  simPanelInstance?.close();
  $('btn-3d').hidden = true;
  for (const id of ['select-panel', 'analog-banner', 'menu', 'menu-btn', 'area-panel', 'switch-world', 'ruler-panel', 'route-panel', 'finder-btn']) $(id).hidden = true;
  $('back-to-site').textContent = '← Back to this site';
  mapView.classList.remove('measuring');
  $('menu-btn').setAttribute('aria-expanded', false);
  $('select-hint').hidden = false;
  $('select-info').hidden = true;
}

function showHome() {
  mapView.hidden = true;
  home.hidden = false;
  document.title = 'Planet Maps';
}

// The URL hash decides the page, so the browser's back button works:
//   #/mars                          Mars map
//   #/mars?lat=18.44&lon=77.45&r=10       Mars map with a 10 km-radius area selected
//   #/mars?view=slope                     Mars map showing the slope overlay
//   #/earth?from=mars                     Earth map, opened from Mars (switch button goes back)
//   #/earth?from=mars&site=lat,lon&sr=10&w=..  Earth map, looking for analogs of a Mars area
//   (Earth's own selection and view use lat/lon/r/view like the other maps)
//   #/moon3d?lat=..&lon=..&t=ISO           standing on the Moon in 3D at that time (#/mars3d, #/earth3d)
const WORLDS_3D = ['moon', 'mars', 'earth'];
function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  if (map) { map.remove(); map = null; }
  close3D?.(); close3D = null;
  $('view3d').hidden = true;
  hidePanels();
  const world3d = WORLDS_3D.find((w) => path === `${w}3d`);
  if (world3d) open3DPage(world3d, new URLSearchParams(query));
  else if (BODIES[path]) openMap(path, new URLSearchParams(query));
  else showHome();
}

// ---- Moon / Mars / Earth: stand on the surface in 3D (code loaded only when opened) ---------------
let close3D = null;
function open3DPage(world, params) {
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { location.hash = `#/${world}`; return; }
  const t = new Date(params.get('t') ?? '');
  home.hidden = true;
  mapView.hidden = true;
  $('view3d').hidden = false;
  document.title = `${BODIES[world].name} 3D · Planet Maps`;
  // a fresh canvas each time: closing the last view gave its WebGL context back (forceContextLoss),
  // which leaves that canvas unable to draw again
  const oldCanvas = $('v3-canvas');
  oldCanvas.replaceWith(oldCanvas.cloneNode(false));
  const els = Object.fromEntries(['canvas', 'hud', 'back', 'where', 'status', 'date', 'now', 'slider', 'play', 'speed',
    'offset', 'sun', 'earth', 'next', 'note'].map((k) => [k, $(`v3-${k}`)]));
  els.status.hidden = false;
  els.status.textContent = 'Loading the 3D view…';
  const hash = location.hash;
  import('./surface3d/view.js').then(({ open3D }) => {
    if (location.hash !== hash) return; // left meanwhile
    close3D = open3D(els, {
      world, lat, lon,
      date: Number.isNaN(t.getTime()) ? new Date() : t,
      onBack: () => { location.hash = lastPage[world] ?? `#/${world}?lat=${lat}&lon=${lon}`; },
      onTime: (date) => {
        const q = new URLSearchParams({ lat, lon, t: date.toISOString().slice(0, 16) + 'Z' });
        history.replaceState(null, '', `#/${world}3d?${q}`);
      },
    });
    $('v3-canvas').focus();
  }).catch((err) => {
    console.error(err);
    els.status.textContent = 'The 3D view failed to load.';
  });
}

window.addEventListener('hashchange', route);

// "?" button on the map pages (top left): show the tutorial any time
$('help-btn').onclick = () => startTour(appHooks);
route();

// Reveal the page only when it's ready: styles applied, globe images loaded and the
// first frame drawn. Never wait more than 4 s, so a slow image can't leave it blank.
Promise.race([globesReady(), new Promise((r) => setTimeout(r, 4000))]).then(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add('ready');
    setTimeout(() => document.getElementById('loader')?.remove(), 600); // after its fade-out
    // first visit, arriving on the home page: offer the tutorial
    if (!location.hash.replace(/^#\/?/, '')) setTimeout(() => maybeStartTutorial(appHooks), 700);
  }));
});
