// Established terrestrial analog sites: places already used to study or train for the Moon or
// Mars. Shown on the Earth map, used to label every analog result as a known analog region or
// a new one, and (optionally) left out of the search.
//
// Coordinates are the centre of the site or field area, to ~0.1° (enough at the scale the
// search works at: 0.5° cells, results at least 800 km apart). `approx` marks sites whose
// field area is spread out or whose centre is a rough choice.
//
// worlds: which world the site is an analog for. Sources: one reference per site.

// A result within this distance of a known site counts as "a known analog region".
export const KNOWN_REGION_KM = 250;

export const KNOWN_ANALOGS = [
  // ---- Polar and cold deserts
  { name: 'Haughton crater, Devon Island', lat: 75.38, lon: -89.68, worlds: ['mars', 'moon'],
    why: 'Impact crater in a polar desert; NASA Haughton-Mars Project field tests since 1997',
    source: 'https://en.wikipedia.org/wiki/Haughton_crater' },
  { name: 'McMurdo Dry Valleys', lat: -77.5, lon: 162.0, worlds: ['mars'],
    why: 'Coldest, driest ice-free ground on Earth; permafrost like the Phoenix landing site',
    source: 'https://en.wikipedia.org/wiki/McMurdo_Dry_Valleys' },
  { name: 'Concordia Station, Dome C', lat: -75.1, lon: 123.33, worlds: ['mars', 'moon'],
    why: 'Isolated, confined crew on the Antarctic plateau; ESA uses it to study long missions',
    source: 'https://en.wikipedia.org/wiki/Concordia_Station' },
  { name: 'Svalbard (Bockfjorden)', lat: 79.43, lon: 13.3, worlds: ['mars'], approx: true,
    why: 'Volcanoes and hot springs in permafrost; AMASE rover and instrument tests',
    source: 'https://en.wikipedia.org/wiki/Arctic_Mars_Analog_Svalbard_Expedition' },
  // ---- Hot and arid deserts
  { name: 'Atacama Desert (Yungay)', lat: -24.1, lon: -70.0, worlds: ['mars'],
    why: 'Hyperarid soil with almost no life; Mars life-detection instruments tested here',
    source: 'https://en.wikipedia.org/wiki/Atacama_Desert' },
  { name: 'Mars Desert Research Station, Utah', lat: 38.41, lon: -110.79, worlds: ['mars'],
    why: 'Habitat for simulated Mars crew missions among red sedimentary rock',
    source: 'https://en.wikipedia.org/wiki/Mars_Desert_Research_Station' },
  { name: 'Death Valley', lat: 36.5, lon: -117.0, worlds: ['mars'],
    why: 'Salt flats, playas, alluvial fans and dunes; NASA rover and instrument testing',
    source: 'https://en.wikipedia.org/wiki/Death_Valley' },
  { name: 'Qaidam Basin', lat: 37.5, lon: 94.0, worlds: ['mars'], approx: true,
    why: 'High, hyperarid salt basin with yardangs: wind-eroded, salty ground as on Mars',
    source: 'https://en.wikipedia.org/wiki/Qaidam_Basin' },
  { name: 'Dhofar, Oman (AMADEE-18)', lat: 18.9, lon: 53.8, worlds: ['mars'], approx: true,
    why: 'Austrian Space Forum simulated Mars mission in the desert, 2018',
    source: 'https://en.wikipedia.org/wiki/AMADEE-18' },
  { name: 'Makhtesh Ramon (AMADEE-20)', lat: 30.6, lon: 34.85, worlds: ['mars'],
    why: 'Erosion crater in the Negev desert; Austrian Space Forum / Israeli D-MARS missions',
    source: 'https://en.wikipedia.org/wiki/Makhtesh_Ramon' },
  // ---- Water, minerals, early life
  { name: 'Río Tinto', lat: 37.7, lon: -6.56, worlds: ['mars'],
    why: 'Acid, iron-rich water depositing jarosite, like the rocks at Meridiani Planum',
    source: 'https://en.wikipedia.org/wiki/Rio_Tinto_(river)' },
  { name: 'Dallol', lat: 14.24, lon: 40.3, worlds: ['mars'],
    why: 'Hyperacid, salty hydrothermal pools: the limits of habitability',
    source: 'https://en.wikipedia.org/wiki/Dallol_(hydrothermal_system)' },
  { name: 'Pilbara (Dresser Formation)', lat: -21.1, lon: 119.4, worlds: ['mars'], approx: true,
    why: 'Some of the oldest signs of life (3.5 billion-year-old stromatolites): biosignature practice',
    source: 'https://en.wikipedia.org/wiki/Dresser_Formation' },
  // ---- Volcanic terrain and lava tubes
  { name: 'Lanzarote (Timanfaya)', lat: 29.0, lon: -13.75, worlds: ['moon', 'mars'],
    why: 'Young basaltic lava fields and lava tubes; ESA PANGAEA astronaut geology training',
    source: 'https://en.wikipedia.org/wiki/Timanfaya_National_Park' },
  { name: 'HI-SEAS, Mauna Loa', lat: 19.6, lon: -155.49, worlds: ['mars', 'moon'],
    why: 'Habitat on barren lava for long simulated Mars and Moon crew missions',
    source: 'https://en.wikipedia.org/wiki/HI-SEAS' },
  { name: 'Mauna Kea', lat: 19.82, lon: -155.47, worlds: ['moon'],
    why: 'Volcanic ash like lunar soil; NASA tested oxygen extraction (ISRU) here',
    source: 'https://en.wikipedia.org/wiki/Mauna_Kea' },
  { name: 'Askja', lat: 65.03, lon: -16.75, worlds: ['moon', 'mars'],
    why: 'Bare volcanic highland where Apollo astronauts trained in 1965 and 1967',
    source: 'https://en.wikipedia.org/wiki/Askja' },
  { name: 'Craters of the Moon, Idaho', lat: 43.42, lon: -113.52, worlds: ['moon', 'mars'],
    why: 'Basalt lava flows and tubes; Apollo 14 training and NASA BASALT spacewalk tests',
    source: 'https://en.wikipedia.org/wiki/Craters_of_the_Moon_National_Monument_and_Preserve' },
  { name: 'Lava Beds, California', lat: 41.71, lon: -121.51, worlds: ['mars', 'moon'],
    why: 'Hundreds of lava tubes; NASA BRAILLE project tested cave-mapping robots',
    source: 'https://en.wikipedia.org/wiki/Lava_Beds_National_Monument' },
  { name: 'Black Point lava flow, Arizona', lat: 35.69, lon: -111.46, worlds: ['moon'], approx: true,
    why: 'NASA Desert RATS: lunar rover and spacewalk tests on basalt',
    source: 'https://en.wikipedia.org/wiki/Desert_Research_and_Technology_Studies' },
  // ---- Impact craters
  { name: 'Meteor Crater, Arizona', lat: 35.03, lon: -111.02, worlds: ['moon'],
    why: 'Young, well-preserved impact crater; Apollo astronaut training',
    source: 'https://en.wikipedia.org/wiki/Meteor_Crater' },
  { name: 'Nördlinger Ries', lat: 48.88, lon: 10.57, worlds: ['moon'],
    why: 'Impact crater with impact breccias; Apollo 14 crew geology training',
    source: 'https://en.wikipedia.org/wiki/N%C3%B6rdlinger_Ries' },
  { name: 'Sudbury Basin', lat: 46.6, lon: -81.18, worlds: ['moon'],
    why: 'Large, ancient impact structure; Apollo 16 and 17 crews studied its rocks',
    source: 'https://en.wikipedia.org/wiki/Sudbury_Basin' },
  { name: 'Kilbourne Hole, New Mexico', lat: 31.97, lon: -106.97, worlds: ['moon'],
    why: 'Volcanic maar crater used in Apollo field training',
    source: 'https://en.wikipedia.org/wiki/Kilbourne_Hole' },
  { name: 'Lonar crater', lat: 19.98, lon: 76.51, worlds: ['moon', 'mars'],
    why: 'Impact crater in basalt, the rock of the lunar maria and much of Mars',
    source: 'https://en.wikipedia.org/wiki/Lonar_Lake' },
];

const rad = (d) => (d * Math.PI) / 180;
function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The known analog nearest to a point: { site, km }. */
export function nearestKnown(lat, lon) {
  let best = null;
  for (const site of KNOWN_ANALOGS) {
    const km = distanceKm(lat, lon, site.lat, site.lon);
    if (!best || km < best.km) best = { site, km };
  }
  return best;
}

/** Is a point inside a known analog region? (for "skip known analog regions") */
export const inKnownRegion = (lat, lon) => nearestKnown(lat, lon).km < KNOWN_REGION_KM;
