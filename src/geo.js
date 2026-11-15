// Small geometry helpers that work on any sphere (Earth, Moon, Mars).

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Points of a circle `radiusKm` around (lat, lon) on a sphere of `sphereKm`.
// Longitudes are not wrapped, so a circle crossing ±180° stays in one piece.
export function circlePoints(lat, lon, radiusKm, sphereKm, steps = 96) {
  const d = radiusKm / sphereKm; // angular distance
  const φ1 = rad(lat);
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const θ = (2 * Math.PI * i) / steps;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
    const dλ = Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
      Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
    pts.push([deg(φ2), lon + deg(dλ)]);
  }
  return pts;
}

// 18.4400° N, 77.4500° E  (4 decimals ≈ 6 m on Mars)
export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

// One coordinate: degrees, optional minutes (') and seconds ("), optional N/S/E/W.
const COORD = /([+-]?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:["″]|'')\s*)?([NSEW])?/g;

/**
 * Reads typed coordinates: "-4.59, 137.44", "4.59 S 137.44 E", "18°24' N 77°30' E",
 * "4.59S 222.6E" (east longitudes 0–360 are common on Mars). Latitude first, unless the
 * letters say otherwise. Returns { lat, lon } (lon in -180..180) or { error }.
 */
export function parseLatLon(text) {
  const s = String(text).toUpperCase().replace(/[−–]/g, '-').replace(/[,;]/g, ' ').trim();
  if (!s) return { error: 'Type a latitude and a longitude, e.g. -4.59, 137.44.' };
  const parts = [];
  let used = '';
  for (const m of s.matchAll(COORD)) {
    if (!m[0].trim()) continue;
    const [, d, min = 0, sec = 0, hemi] = m;
    let v = Math.abs(Number(d)) + Number(min) / 60 + Number(sec) / 3600;
    if (Number(min) >= 60 || Number(sec) >= 60) return { error: 'Minutes and seconds must be below 60.' };
    if (d.startsWith('-')) v = -v;
    if (hemi === 'S' || hemi === 'W') v = -Math.abs(v);
    parts.push({ v, hemi });
    used += m[0];
  }
  // anything left over that isn't part of a coordinate (e.g. a typo) is an error
  if (parts.length !== 2 || s.replace(/\s/g, '').length !== used.replace(/\s/g, '').length) {
    return { error: 'Could not read that. Type a latitude and a longitude, e.g. -4.59, 137.44 or 4.59 S 137.44 E.' };
  }
  let [a, b] = parts;
  const isLon = (p) => p.hemi === 'E' || p.hemi === 'W';
  const isLat = (p) => p.hemi === 'N' || p.hemi === 'S';
  if (isLon(a) || isLat(b)) [a, b] = [b, a];
  if (isLon(a) || isLat(b)) return { error: 'Give one latitude (N/S) and one longitude (E/W).' };
  const lat = a.v;
  let lon = b.v;
  if (Math.abs(lat) > 90) return { error: 'Latitude must be between -90 (south) and 90 (north).' };
  if (lon < -180 || lon > 360) return { error: 'Longitude must be between -180 and 180 (or 0 to 360 east).' };
  if (lon > 180) lon -= 360;
  return { lat, lon };
}
