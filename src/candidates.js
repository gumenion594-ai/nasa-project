import L from 'leaflet';

export const ARTEMIS_III_REGIONS = [
  { name: 'Peak near Cabeus B', lat: -85.4, lon: -35.2 },
  { name: 'Haworth', lat: -87.2, lon: -4.8 },
  { name: 'Malapert Massif', lat: -85.7, lon: -2.0 },
  { name: 'Mons Mouton Plateau', lat: -84.8, lon: -19.0 },
  { name: 'Mons Mouton', lat: -84.4, lon: -27.8 },
  { name: 'Nobile Rim 1', lat: -85.2, lon: -53.5 },
  { name: 'Nobile Rim 2', lat: -85.6, lon: -50.2 },
  { name: 'de Gerlache Rim 2', lat: -88.4, lon: -87.2 },
  { name: 'Slater Plain', lat: -85.7, lon: -12.0 },
];

/** Add selectable, approximate Artemis III region centres to the lunar map. */
export function addCandidateSites(map, body, onSelect) {
  if (body !== 'moon') return () => {};

  map.createPane('candidate-sites').style.zIndex = 460;
  const sites = L.layerGroup();
  for (const site of ARTEMIS_III_REGIONS) {
    const marker = L.marker([site.lat, site.lon], {
      pane: 'candidate-sites',
      keyboard: true,
      bubblingMouseEvents: false,
      icon: L.divIcon({
        className: 'candidate-site-marker',
        html: '<span class="candidate-site-dot"></span><span class="candidate-site-name"></span>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      title: `${site.name} — approximate Artemis III candidate-region centre`,
    });
    marker.on('add', () => {
      const el = marker.getElement();
      el.querySelector('.candidate-site-name').textContent = site.name;
      el.setAttribute('aria-label', `${site.name}, approximate Artemis III candidate-region centre. Select this area.`);
    });
    marker.on('click', () => onSelect(site));
    sites.addLayer(marker);
  }

  let visible = true;
  const updateLabels = () => {
    map.getContainer().classList.toggle('candidate-sites-compact', map.getZoom() < map.getMinZoom() + 2);
  };
  map.on('zoomend', updateLabels);
  const update = () => {
    if (visible && !map.hasLayer(sites)) sites.addTo(map);
    if (!visible && map.hasLayer(sites)) sites.remove();
    updateLabels();
  };
  update();
  return (show) => { visible = show; update(); };
}
