// "Zoom to route": frame the whole route between A and B on screen, clear of the panels.
//
// Works the same way in every projection: every route point (plus a ~5 km ring around A and
// B, so very short routes keep some surroundings) is projected to map pixels, and the zoom
// and centre are chosen from that pixel box. A lat/lon box would fail near a pole (a route
// passing the pole covers every longitude) and at 180 deg longitude (a box spanning the world).
import L from 'leaflet';

const MARGIN_PX = 40;        // at least this much space on every side
const PIN_PX = 16;           // the A / B pins and the line's dark halo reach this far past the route's points
const MIN_AROUND_KM = 5;     // keep at least this much visible around A and B
const DURATION_S = 0.7;      // animation, like the analog-result zoom in main.js
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Everything that sits on top of the map. Each one that's visible pushes the free area in
// from one side (the side that loses the least map), using its real on-screen size.
const OBSTACLES = [
  '#select-panel', '#area-panel', '#menu', '#route-panel', '#analog-banner',
  '.legend', '.top-buttons', '.leaflet-control-zoom', '.switch-world', '.map-settings', '.zoom-readout',
];

/** Is the map cylindrical (equirectangular / Mercator)? Polar maps don't end at 180 deg. */
export const isCylindrical = (map) => map.options.crs === L.CRS.EPSG4326 || map.options.crs === L.CRS.EPSG3857;

/** Longitudes of a route made continuous: each point on the short way round from the last. */
export function unwrapLons(pts) {
  const out = [];
  let prev = null;
  for (const [lat, lon] of pts) {
    let l = lon;
    if (prev !== null) l += Math.round((prev - l) / 360) * 360;
    out.push([lat, l]);
    prev = l;
  }
  return out;
}

/** The route's lat/lon bounds the short way round (east may be beyond 180). */
export function routeBounds(pts) {
  const u = unwrapLons(pts);
  let south = 90; let north = -90; let west = Infinity; let east = -Infinity;
  for (const [lat, lon] of u) {
    south = Math.min(south, lat); north = Math.max(north, lat);
    west = Math.min(west, lon); east = Math.max(east, lon);
  }
  // shift so the box starts inside -180..180
  const k = Math.floor((west + 180) / 360);
  return { south, north, west: west - k * 360, east: east - k * 360, crosses180: east - k * 360 > 180 };
}

/** The part of the map not covered by panels, in container pixels: { left, top, right, bottom }. */
export function freeArea(map) {
  const box = map.getContainer().getBoundingClientRect();
  const W = box.width; const H = box.height;
  const pad = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const sel of OBSTACLES) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.hidden || el.closest('[hidden]') || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const x0 = Math.max(0, r.left - box.left); const x1 = Math.min(W, r.right - box.left);
      const y0 = Math.max(0, r.top - box.top); const y1 = Math.min(H, r.bottom - box.top);
      if (x1 <= x0 || y1 <= y0) continue;
      // cut the panel off from one side: the one that costs the least map area
      const cuts = [
        ['left', x1, x1 * H], ['right', W - x0, (W - x0) * H],
        ['top', y1, y1 * W], ['bottom', H - y0, (H - y0) * W],
      ].sort((a, b) => a[2] - b[2]);
      const [side, size] = cuts[0];
      pad[side] = Math.max(pad[side], size);
    }
  }
  let free = { left: pad.left + MARGIN_PX, top: pad.top + MARGIN_PX, right: W - pad.right - MARGIN_PX, bottom: H - pad.bottom - MARGIN_PX };
  // panels on every side of a small screen: keep at least a usable middle
  if (free.right - free.left < 120 || free.bottom - free.top < 120) {
    free = { left: MARGIN_PX, top: MARGIN_PX + pad.top, right: W - MARGIN_PX, bottom: H - MARGIN_PX - pad.bottom };
    if (free.bottom - free.top < 120) free = { left: MARGIN_PX, top: MARGIN_PX, right: W - MARGIN_PX, bottom: H - MARGIN_PX };
  }
  return { ...free, W, H };
}

// A point d km from (lat, lon) towards bearing b (degrees), on a sphere of radius R.
function destination(lat, lon, dKm, bDeg, R) {
  const d = dKm / R; const b = rad(bDeg); const p1 = rad(lat); const l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), deg(l2)];
}

/**
 * Where to put the map so the route fills the free area: { center, zoom }.
 * pts: route points [lat, lon]; R: planet radius (km).
 */
export function routeView(map, pts, R) {
  const cyl = isCylindrical(map);
  // the route, plus a ring of MIN_AROUND_KM around A and B
  const all = [...pts];
  for (const p of [pts[0], pts[pts.length - 1]]) {
    for (let b = 0; b < 360; b += 45) all.push(destination(p[0], p[1], MIN_AROUND_KM, b, R));
  }
  // cylindrical maps: the short way round (continuous longitudes); polar maps: as they are
  const ll = cyl ? unwrapLons(all) : all.map(([lat, lon]) => [lat, ((((lon + 180) % 360) + 360) % 360) - 180]);
  const z0 = map.getZoom();
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [lat, lon] of ll) {
    const p = map.project(L.latLng(lat, lon), z0);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const free = freeArea(map);
  const fw = Math.max(40, free.right - free.left - 2 * PIN_PX); const fh = Math.max(40, free.bottom - free.top - 2 * PIN_PX);
  const bw = Math.max(1, x1 - x0); const bh = Math.max(1, y1 - y0);
  let zoom = z0 + Math.log2(Math.min(fw / bw, fh / bh));
  zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom)); // never closer than ~1 km across
  // put the box's centre at the centre of the free area (not of the whole screen)
  const s = 2 ** (zoom - z0);
  const boxCentre = L.point(((x0 + x1) / 2) * s, ((y0 + y1) / 2) * s);
  const shift = L.point(free.W / 2 - (free.left + free.right) / 2, free.H / 2 - (free.top + free.bottom) / 2);
  const center = map.unproject(boxCentre.add(shift), zoom);
  return { center, zoom };
}

/** Animate the map to frame the route. */
export function zoomToRoute(map, pts, R, { animate = true } = {}) {
  if (!pts || pts.length < 1) return;
  const { center, zoom } = routeView(map, pts, R);
  if (animate) map.flyTo(center, zoom, { duration: DURATION_S, easeLinearity: 0.35 });
  else map.setView(center, zoom, { animate: false });
}
