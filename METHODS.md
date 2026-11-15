# Planet Maps: data and methods

How the maps, the Earth analog search and the other tools work, in detail. For what the app found, see the
[README](README.md); for every data set, [DATA_SOURCES.md](DATA_SOURCES.md).

## Where the maps come from

Every NASA and partner data set is listed, with dataset IDs, in [DATA_SOURCES.md](DATA_SOURCES.md).

Map images are streamed as tiles from these services while you browse, so nothing is downloaded up front:

| World | Zoomed out | Zoomed in (sharpest detail) |
|-------|------------|-----------------------------|
| Earth | Esri World Imagery (satellite) | under 1 m per pixel in many places |
| Moon  | LRO WAC mosaic (NASA), ~100 m/pixel | Kaguya TC mosaic (JAXA, via NASA Moon Trek), ~21 m/pixel |
| Mars  | Viking colour mosaic (NASA), ~232 m/pixel | CTX mosaic (NASA/Caltech, via Esri), ~5 m/pixel, tinted Mars-coloured |

Past that detail the images are enlarged, so the very closest zoom levels get soft. Change sources in `src/bodies.js`.

## Map views: data and method

All views come from NASA (and partner) data in the Planetary Data System, built by
`tools/build_layers.py`. Blue = low, red = high. Where a quantity exists on both bodies,
both share one colour range, so the same colour means the same value on each.

| View | Moon | Mars | Scale |
|---|---|---|---|
| Elevation | LRO LOLA, ~1.9 km | MGS MOLA, ~1.9 km | linear |
| Terrain slope | LOLA, ~1.9 km | MOLA, ~1.9 km | log, 0.1-30 deg |
| Dusty or rocky terrain | Thermal inertia (low = dust, high = rock), **calculated** from Diviner's midnight temperatures (GHRM mosaic) with a thermal model, ~1 km, 70S-70N | MGS TES night thermal inertia (low = dust, high = rock), ~3 km, 70S-70N | log, TIU; own range per body (Moon 25-400, Mars 30-1000) |
| Minerals: iron content | Lunar Prospector GRS, FeO wt%, ~60 km | Mars Odyssey GRS, Fe as FeO wt%, ~300 km, 57.5S-57.5N | linear; own range per body |
| Underground ice | *no global map product found* | Mars Odyssey averaged neutron data (~12 Mars years): % fewer epithermal neutrons than the driest ground (hydrogen, mostly ice near the poles), ~300 km | linear |
| Temperature | Diviner: average over a full lunar day, ~15 km | **Calculated** (see below): average over a Mars year, ~60 km | linear |
| Daily temperature variation | Diviner: hottest minus coldest time of day, ~15 km | **Calculated**: typical day-night swing | linear |
| Sunlight | **Calculated**: average solar power on flat ground over day, night and the year, from the Sun's path; beyond 75° with crater and mountain shadows from the LOLA polar terrain models (permanently shadowed craters = 0) | **Calculated**: Mars's orbit, dimmed by typical dust (optical depth 0.3 at 610 Pa, scaled with pressure from MOLA elevation); no dust storms | linear; own range per body |
| Yearly temperature range | *not added* | **Calculated**: hottest minus coldest moment of the year | linear |
| Maximum temperature | Diviner: hottest time of a typical day, ~15 km | **Calculated**: hottest month's average afternoon maximum | linear |
| Minimum temperature | Diviner: coldest time of a typical night, ~15 km | **Calculated**: coldest month's average night minimum | linear |

Maximum / minimum temperature are defined like Earth's (NASA POWER): the hottest month's average daily
maximum and the coldest month's average daily minimum. On Mars a "month" is a sliding 1/12 of the
Mars year (~56 sols). The Moon has no real seasons, so its typical day's max and night's min are used.

On the Moon (1.5 deg axial tilt) the maximum variation is essentially the daily variation, and
Diviner's archived product holds per-time-of-day averages, not all-time extremes, so it isn't added.

### Projections

| | Equirectangular | Mercator | North / South pole |
|---|---|---|---|
| Moon, Mars | their own (NASA Trek) | warped | warped |
| Earth | warped | its own (Esri) | warped |

`src/projections.js` defines each projection (lat/lon <-> map position, scale, zoom limits);
the polar ones are azimuthal equidistant: distance from the centre = angle from the pole, so
the opposite pole is the disc's rim.
`src/reproject.js` draws tiles of one projection in another: a 17 x 17 grid of points per tile
is converted to lat/lon and to source-tile pixels, each 16 px cell is drawn as two affine
triangles straight from the source tiles (subdivided where the mapping bends, e.g. at a pole,
or at the edge of a source's coverage). Drawing, rather than reading pixels, also works for
imagery from other sites. Data layers are warped first and coloured afterwards.

Limits: Mercator can't show the poles (stops at 85 deg), so Earth's polar views have a small round
gap within 5 deg of the pole (its sources are Mercator). Equirectangular sources store little detail
right at a pole (every pixel row wraps around a tiny circle): the source detail used there is
capped so a view never needs thousands of tiles, which makes close-ups within a few degrees of
a pole soft. The Moon's LRO WAC mosaic also has no data in the last ~1-2 deg around the poles.

### Earth data

| View | Source | Detail |
|---|---|---|
| Elevation, slope | (elevation uses a relief palette - green lowlands to white peaks - so low land doesn't look like water) NOAA ETOPO 2022, 60 arc-seconds (from NASA SRTM and other data); slope at the same ~1.9 km scale as the Moon and Mars | ~2-4 km |
| Max. / min. temperature, daily swing | NASA POWER `TS_MAX`, `TS_MIN`, `TS_RANGE`: **ground-surface** ("skin") temperature, long-term monthly averages. Max = hottest month's average daily maximum, min = coldest month's average daily minimum, swing = yearly mean | ~50 km |
| Dryness | NASA POWER `PRECTOTCORR` (MERRA-2 / GPM), yearly total; colour scale reversed so red = driest | ~50 km |
| UV radiation | NASA POWER `ALLSKY_SFC_UV_INDEX` (CERES), UV index averaged over day and night incl. clouds | ~100 km |
| Sunlight | NASA POWER `ALLSKY_SFC_SW_DWN` (CERES), solar power reaching the ground incl. clouds, yearly average, W/m² (same quantity as the Moon and Mars maps) | ~50 km |

Surface (not air) temperatures are used so Earth compares with the Moon and Mars surface maps.
The land mask comes from ETOPO: below-sea-level areas count as water only if bigger than
50,000 km2, so Death Valley, the Dead Sea shore and the Qattara Depression stay land. Earth tiles
are Web Mercator (to match the satellite basemap) with the ocean in a lossless alpha channel.
Download the climate data with `python3 tools/fetch_power.py` (cached, resumable), then build
with `python3 tools/build_layers.py earth`.

### Earth analog search

**Find Earth analogs** (Moon or Mars, with an area selected) first asks how much each characteristic
should count (off, ×0.5, ×1, ×2, ×3; at least one on), how many places to find (1-10, default 3) and
what a good analog is. **Defaults** restores the default weights, mode and number:
max. temperature ×2, min. temperature ×1, daily swing ×1, slope ×2, relief ×2, dryness ×2, sunlight ×1,
bare ground ×1, frozen ground ×1 and dust ×1 (the last two on Mars only); UV and altitude off. The first six
were chosen by running 18 Moon and Mars sites and checking that different sites get different places (it was
much worse with every weight at ×1, when most searches ended in the Atacama or Tibet). UV and altitude have no
Mars/Moon value, so they pull every search towards the same highlands. The last four were added later and set
with `tools/validate-analogs.html` (see *Does the search find known analogs?* below).

- **Match my site**: places whose values are closest to the site's. Where the site is beyond anything
  on Earth (Mars nights are always colder, its day-night swing always bigger), it is matched
  *relatively*: a site that is cold for its world (say its 20th percentile by area) is matched to
  places equally cold for Earth (Earth's 20th percentile). Taking Earth's extreme instead gave
  every site the same target and the same results (always the Atacama and Tibet). The comparison
  table shows the percentile and the Earth value it was matched to.
- **Most extreme**: for the temperatures, Earth's extreme on the site's side, whatever the site's value.

| Characteristic | Site value (Moon / Mars) | Earth (`public/search`) | How it's compared |
|---|---|---|---|
| Max. / min. temperature, daily swing | area mean of the temperature layers | NASA POWER | matched (or most extreme) |
| Terrain slope | mean of log10(slope), ~1.9 km scale | ETOPO 2022, same scale | matched |
| Terrain relief | mean elevation standard deviation inside ~9 km blocks | ETOPO 2022, same blocks | matched |
| Dryness | – (no Mars/Moon equivalent) | yearly rain, log | any desert (under 250 mm/yr) counts as dry enough; wetter places count against |
| Sunlight | the Sunlight layer, W/m² | NASA POWER (CERES), yearly mean, W/m² | **by rank only**: as sunny for Earth as the site is for its world |
| Bare ground | – (all of the Moon and Mars is bare) | share of land MODIS classes "Barren" (rock, sand or soil, under 10% vegetation), 2023 | half or more counts fully; less counts against |
| Frozen ground (Mars) | Underground ice layer (Odyssey) | NASA POWER yearly mean ground temperature | ice-rich site (signal ≥ 50%, `ICE_RICH`): looks for permafrost (yearly mean below 0 °C); other sites: for unfrozen ground |
| Dust in the air (Mars) | share of days with a dust storm (Mars Dust Activity Database, yearly mean) | MERRA-2 dust near the ground, 2014–2023 mean, log | **by rank only**: as dusty for Earth as the site is for Mars |
| UV radiation | – | average UV index | highest wins |
| Altitude (thin air) | – | mean elevation | highest wins |

Why "by rank only" for sunlight: Mars gets ~40% of Earth's sunlight, so its equator gets about as much as
cloudy Britain. Matching the W/m² sent equatorial Mars sites to England; matching the rank sends them to Earth's
sunniest deserts. Why 50% for ice: the Odyssey signal is 20–40% at the Martian equator (mostly water bound in
minerals) and over 60% poleward of ~60°, where ground ice lies within ~1 m.

How it works (`src/analogs.js`):
- `tools/build_search_grid.py` stores, for each of the ~96,000 half-degree cells with land, the
  land-area mean of each characteristic; `tools/build_search_extra.py` adds sunlight, mean ground
  temperature, bare ground and dust to the same file (3.5 MB, loaded only when a search starts).
- For the chosen radius, every land cell becomes the centre of a circle; the cells inside are
  combined, weighted by land area (circles smaller than a cell use the cell, centred on its land).
  Circles that are less than half land are skipped. Every circle is scored: nothing is sampled.
- Each characteristic's distance to its target is divided by its spread across Earth (5th-95th
  percentile), so degrees, millimetres and slopes become comparable. The score is the weighted
  root-mean-square; "% match" = 100 % minus the score (0 % = a whole Earth spread away).
- The best circle is kept, then the next best at least 800 km from all kept ones, until there are as
  many as asked for (3 by default).
- **Fine-scale positions** (`src/refine.js`): for radii under 25 km a result is only "somewhere in this
  ~50 km cell". Each one is then moved, within its cell, to the spot whose slope matches the site best,
  read from the Earth slope tiles (~5 km pixels at the equator, ~2.5 km at 60°). Climate data stays at
  ~50 km, and relief (measured in ~9 km blocks) stays at the cell value. The report card says when and how
  far a result moved.

#### Report card: how good is the analog, and where does it fail?

Click a result for its **report card** (`src/reportcard.js`), under the comparison table:

- **New or known**: is the place in a known analog region, or new? (see below)
- **✓ Strong / ≈ partial / ✗ weak match**: each characteristic, by how far the place is from the site's
  value, measured in Earth's spread of that characteristic (its 5th–95th percentile over all land): strong up
  to 15%, weak from 50% (`STRONG_GAP`, `WEAK_GAP`).
- **↕ Matched only relatively**: where the site is beyond anything on Earth, and always for sunlight and dust,
  only the rank matches. The card gives both real values, e.g. *Min. temperature: Mars −93 °C, here 6 °C; both
  at about the 92nd percentile of their own world*.
- **○ Not compared**: characteristics that were switched off, have no data at the site, or have no Earth
  counterpart in the search yet (surface material, iron, rock type, impact craters).
- **◎ Features in this area**: confirmed impact structures that overlap the area and young volcanoes in it
  (or else the nearest impact structure). Shown, not scored.
- **What no place on Earth can reproduce** (fixed per world): gravity, vacuum or the thin CO₂ air, radiation,
  the Moon's 29.5-day day, Mars's perchlorate soil, and Earth's life, which helps testing but contaminates
  samples.

#### Impact structures and volcanoes on the Earth map

`public/features/earth.json` (`tools/build_earth_features.py`): the 197 confirmed impact structures from
Wikipedia's regional lists (which follow the Earth Impact Database), drawn as dashed rings to scale (labelled
from 2× zoom when 20 km or larger, otherwise from 4×), and the 1,214 volcanoes active in the last ~12,000 years
from the Smithsonian Global Volcanism Program, as orange dots (hover for name, type and last eruption).

#### Known analogs: is the place new?

`src/knownAnalogs.js` lists 25 established analog sites (Haughton crater, McMurdo Dry Valleys, Atacama,
Río Tinto, Mars Desert Research Station, HI-SEAS, Askja, Meteor Crater, Ries, Sudbury, lava-tube parks, …),
each with what it is used for and a source. They show on the Earth map (✦, purple, from 2× zoom; click for
details). Every result is labelled **New analog** or **Known analog region** (within 250 km of one of them,
`KNOWN_REGION_KM`). **Only new places** in the search dialog leaves the known regions out (address: `new=1`).

**Does the search find known analogs?** `tools/validate-analogs.html` (open it with `npm run dev`, at
`/tools/validate-analogs.html`; `?sets=default,before` compares the current and the earlier defaults, `?w=...`
any weights) runs the search with a 25 km radius for Moon / Mars sites whose Earth analog is established, and
reports how well the best area within 250 km of that analog ranks among all of Earth's ~96,000 areas. For
comparison, the same number for 300 random land points (median). Current defaults, and in brackets the six
climate and terrain characteristics only (before sunlight, bare ground, frozen ground and dust were added):

| Moon / Mars site | Known Earth analog | Why that pair | Known analog ranks in | Random land point |
|---|---|---|---|---|
| Phoenix landing site (Mars) | McMurdo Dry Valleys | ice-cemented polar ground | **top 2.8%** (1.5%) | top 37% |
| Opportunity, Meridiani Planum (Mars) | Río Tinto | jarosite from acid water | **top 3.4%** (1.5%) | top 39% |
| Apollo 15, Hadley (Moon) | Askja | Apollo field training | **top 4.7%** (3.9%) | top 18% |
| Apollo 14, Fra Mauro (Moon) | Nördlinger Ries | Apollo 14 crew training | top 29% (20%) | top 40% |
| Apollo 16, Descartes (Moon) | Sudbury Basin | Apollo 16 / 17 rock studies | top 33% (28%) | top 37% |
| Viking 1, Chryse Planitia (Mars) | Atacama (Yungay) | Viking-like soil experiments | top 38% (81%) | top 21% |

Five of six known analogs rank above a random place (four before); three of them far above it. Sudbury is only
slightly above it and the Atacama below it: they were chosen for what the search can't compare, Sudbury for its
impact rocks and the Atacama for its soil chemistry. Viking 1's site is cold for Mars, so it is matched to
places cold for Earth, while Yungay is a warm coastal desert; bare ground and sunlight moved it from the bottom
fifth to the middle.

Over 20 Moon and Mars sites × 10 results, **12 of 200 results (6%) are in a known analog region** (e.g. Hellas →
near Haughton crater, Mars's north pole → Svalbard); the other 94% are new. With *Only new places* none are.
The new characteristics make sites share places a little more often: 35 of the 60 top-3 results have another
site's result within 400 km (30 of 60 before). Equatorial Mars sites now often share the Andean deserts, and
polar sites the barren Arctic islands: few places on Earth are cold, barren and dry at once.

### Countries (Earth analogs)

- **Country filter** (optional; one row near the top of the Find Earth analogs dialog): *Anywhere*, *Avoid countries* or *Only in
  countries*, with a searchable list. "No country" stands for Antarctica (Antarctic Treaty area, south of
  60°S) and unclaimed land. Every result shows its country. Filtered-out places still count for Earth's
  spread and percentiles, so the scores of the remaining places don't change.
- Boundaries: Natural Earth 1:50m (public domain), turned into a 0.25° lookup grid by
  `tools/build_country_grid.mjs` (`public/search/countries.bin`, 20 kB). Natural Earth draws de facto
  boundaries; disputed areas follow its choices.

### Simulation Planning (Earth analogs)

**🛠 Simulation Planning** (above each result's comparison table) opens a scrollable panel on the right: what it
would take to recreate the Moon or Mars site's environment at the selected Earth area (`src/simplan/`). It
follows the selected result while open.

- **Environmental gaps** (`plan.js`): each characteristic here and at the site, the difference, ✓ / ≈ / ✗ (same
  thresholds as the report card), and where it can be recreated: *Outdoors* (terrain, bare ground, rain, regolith,
  shading), *Equipment* at the site (climatic chamber, UV lamps, ground freezing, dust generators) or *Facility only*
  (vacuum / Mars-air chamber, gravity, radiation, the Moon's long days). Place values come from the app's data
  (the Moon / Mars layers and the Earth search grid); gravity, air, radiation and day length from NASA fact
  sheets, Curiosity RAD (Hassler et al. 2014), Chang'e 4 (Zhang et al. 2020) and UNSCEAR (`facts.js`). Earth's air
  pressure follows from the altitude. Wind is shown as *no data* (the app has no Earth wind data yet).
- **Recommendations**: one for each gap that can be acted on: what is lacking, what to change, the technology,
  its cost and its effect. For search characteristics the effect is computed: the match % with that gap
  closed (e.g. "raises the match from 75% to 77% inside the chamber"). Ordered by importance (the search
  weight × the gap) × feasibility (outdoors 1, equipment 0.75, facility 0.5).
- **Technology and equipment** (`catalog.js`): only what the gaps need. Each card: image (Wikimedia Commons),
  purpose, why it is needed here, purchase or per-campaign cost, running cost, where it has been used before
  (ARGOS, Chamber A, Aarhus Mars wind tunnel, NSRL, LUNA, MOXIE, Curiosity RAD …) and sources.
  **Every price says whether it is published** (regolith simulant ~$45/kg, parabolic flights $8,200 a seat
  (2022), NSRL beam time ~$4,000/hour, −70 °C chambers $42,000–67,000, walk-in chambers from ~$85,000, small
  thermal-vacuum chambers ~$52,000, solar simulators $50,000 to over $1 million) **or an estimate**, with its
  basis. Estimates are wide ranges, not quotes.
- **Total cost**: initial investment (equipment, installation 10–25%, a test hall when chambers or the
  offload rig are needed, power, field camp, transport 5–10%, preparation staff), recurring costs per year
  (maintenance, energy at grid or diesel prices, operating staff) and one simulation campaign (facility time,
  travel and permits, field team), with the assumptions listed. Field camp and logistics reuse the site types
  of `src/fieldplan.js` (polar, high altitude, hot or cold desert …), whose figures are the authors' planning
  numbers.
- **Manpower**: people per role (mission and simulation specialists, environmental, mechanical and electrical
  engineers, geologists, atmospheric scientists, technicians, construction workers) for preparing and for
  operating, from the setup person-months and operating staff of each piece of equipment; preparation time
  from the longest lead time, plus a test hall and commissioning.

New equipment: add an entry to `ITEMS` in `catalog.js` and a gap (or a line in an existing one) in `plan.js`
that names it.

### Mars and Moon equivalents of an Earth place (the reverse search)

`src/equivalents.js`. On the Earth map, select an area and press **🪐 Find the Mars & Moon
equivalents**: the spots on Mars and on the Moon most like it, each with a % match, the nearest
named place (e.g. "near Hellas Planitia") and a button that opens it on that world's map.

- **Compared**: hottest-month maximum, coldest-month minimum, day–night swing (ground
  temperatures), slope and relief, the characteristics both sides have; weights 2 / 1 / 1 / 2 / 2
  as in the analog search. The Earth place uses the analog search's Earth grid (land-area means
  over the circle); every Moon / Mars spot the "Find similar spots" circle means, same radius.
- **Like the analog search, the other way round**: slope and relief are matched by value;
  a temperature that exists on that world is matched by value, one beyond it (Earth's nights are
  far warmer than Mars's) relatively: the same percentile of that world as the place has on Earth.
  Score = weighted RMS of the differences, each divided by the world's 5–95% spread; % match =
  (1 − score) × 100.
- **Rain**: the Moon and Mars are bone dry, so rain beyond a desert's (250 mm a year) lowers the
  % match of every spot alike.
- **No close equivalent**: below 86% the panel says so and gives the nearest spot with its %.
  Calibrated on known places: classic Mars analogs score 92–96% on Mars (Atacama 93%, Devon
  Island 92%, Antarctic Dry Valleys 96%), deserts ~88% (Sahara, Death Valley); wet or green
  places don't reach it (London 80%, Iceland 78%, Hawaii and the Amazon 70%).

**For a route**: the route planner also works on the Earth map. Plan a route there, then
**Find the Mars (or Moon) equivalent of this route**: the same search for the circle around the
route (its midpoint, half its length); it then opens that world's planner with the same route
(same straight-line length and direction, same traveller where that world has it) at the
best-matching spot, with its % match (or "no close equivalent") and a side-by-side comparison with
the Earth route. Earth opened from Mars offers only the Mars button, from the Moon only the Moon
one; Earth opened from the home page (**Earth view**, top right) offers both.

### Map reliability

- **Moon / Mars imagery gaps**: the imagery comes from NASA Trek, which can be slow or drop tiles.
  A bundled whole-world layer sits underneath (`public/basemap/`, made by
  `tools/build_fallback_basemap.py` from the globe textures shaded with the 8 px/degree LOLA /
  MOLA relief), so a missing tile shows the shaded relief instead of a black square.
- **Earth 3D ("Stand here in 3D")**: the far landscape now comes from the AWS terrain tiles (small
  PNGs, fast), so it appears within seconds; NASADEM (Microsoft Planetary Computer) is used for
  the detailed rings with a 25 s limit, falling back to the AWS tiles; the satellite ground images
  get 30 s, and if they don't arrive the ground keeps its plain colour instead of turning black.

### Similar spots

**Find similar spots** (Moon or Mars, with an area selected) looks for the places on the *same* world
most like the selected area, at least 500 km away from it. It asks how much each data layer should count
(all ×1 by default) and how many spots to find (1-10, default 3). The results appear as numbered circles
with a "% match" and the distance from the site; click one for a site-vs-spot comparison table. Map clicks
are paused until **Exit results**.

How it works (`src/similar.js`):
- Each layer is read from its own map tiles at zoom level 1 (1024 x 512 pixels for the whole world:
  ~21 km per pixel on Mars, ~11 km on the Moon). The tile pyramid is box-averaged, so each pixel is the
  area mean of the detailed data (the mean of the log for slope and thermal inertia).
- Around every pixel, each layer is averaged over a circle of the selected radius (per-row running sums,
  so this takes about a second); the site gets the same treatment. Smaller radii than a pixel compare
  single pixels. Circles less than half covered by a layer (beyond its latitude limits) are skipped.
- Score and "% match" work as for Earth analogs: distance to the site's value divided by the layer's
  spread across the world (5th-95th percentile by area), weighted root-mean-square.
- Spots closer than 500 km to the site are left out; the best spot is kept, then the next best at least
  500 km from every kept one.

Results show as numbered circles of the site's radius. Click one (on the map or in the list) for its
area summary and a site-vs-Earth comparison. Selecting new areas is paused until **Exit results**;
data layers can still be shown. A search takes 0.1-1 s.

Not covered yet: impact craters as a search characteristic (they are shown, not scored) and soil type
(dusty/rocky data for Earth); see the report card's *Not compared* list.

### Moon and Mars 3D view: standing on the surface

On the Moon or Mars, select a point and click **Stand here in 3D**: you stand there with your eyes
1.8 m above the ground (`#/moon3d?lat=..&lon=..&t=..` or `#/mars3d?...`). Drag to look around, scroll
or pinch to zoom (arrow keys and +/− work too). The time panel sets the date and time (default: now);
the slider moves ±15 days on the Moon and ±3 sols on Mars, and **Play** runs time (Moon: 1, 6 or 24
hours per second; Mars: 15 min, 1 h or 3 h per second), so you can watch a sunrise or a whole day.
The panel says whether it's day or night, where the Sun, Earth (and on Mars, Phobos and Deimos) are,
and when the next sunrise or sunset is. A compass strip along the top marks them.

How it works (`src/surface3d/`, loaded only when opened; per-world settings in `worlds.js`):
- **Terrain** (`dem.js`, `terrain.js`): four nested square heightfields around you, including the Moon's
  curvature (a 1.8 m person's horizon is only ~2.5 km away; beyond it only higher ground shows):

  | Ring | Size | Grid | Source |
  |---|---|---|---|
  | foot | ±100 m | 1 m | 'near' + made-up small craters (0.6-25 m), rocks and regolith texture |
  | near | ±5 km | 20 m | LOLA 118 m + made-up craters 70-600 m |
  | mid | ±40 km | 250 m | LOLA 118 m, every 4th sample (~470 m) |
  | far | ±250 km | 2 km | LOLA 8 px/deg (~3.8 km), bundled: `public/surface3d/moon_8ppd.bin` |

  On Mars the same rings use the HRSC + MOLA blended DEM (200 m; mid ring every 2nd sample) and MOLA
  8 px/deg (`public/surface3d/mars_8ppd.bin`, far ring ±400 km), with made-up craters from 120 m.
  The ground colour is a rust tone whose brightness follows the Viking colour mosaic (dark basalt sand
  vs. bright dust).

  The 118 m LOLA DEM is read straight from the USGS Astrogeology server: the file stores one image row
  per strip, so the browser asks for just the bytes it needs of each row (HTTP range requests, 6 at a
  time, `cache: 'no-store'` so Chrome doesn't queue them one by one). About 90 + 175 small requests;
  ~5-10 s. The coarse landscape shows first, the detail fills in. Each ring fades its made-up detail
  out and blends into the next coarser ring towards its edge.
  Made-up detail is seeded by the location, so a place always looks the same.
- **Sun and Earth** (`sky.js`): `astronomy-engine` gives the Sun, Earth and the Moon's rotation (IAU
  model) for any time; from these come their directions in the observer's sky (Earth with parallax,
  its size and lit fraction). Checked: at Apollo 11's landing (20 July 1969, 20:17 UTC) the Sun was
  10.7° up in the east (historically ~10.8°); full and new moon put the sub-solar point at 0° / 180°.
- **Shadows**: the terrain shader marches from each pixel towards the Sun through the four heightfields
  (up to 250 km), with a soft edge the size of the Sun's disc, so a crater rim or a distant mountain
  shades you correctly at any time. Rocks also cast shadow-mapped shadows within ~100 m.
- **Light**: no air, so the sky is black and shadows are dark (a little light bounced from sunlit ground).
  At night the ground is lit by earthshine, brightest at "full Earth" (lunar midnight on the near side);
  the exposure adapts like eyes would. On the far side the Earth never rises.
- **Mars sky**: a dusty atmosphere (optical depth 0.5): butterscotch sky by day, a blue glow round the
  Sun at sunrise and sunset, sunlight dimmed and reddened near the horizon, haze over distance (~45 km).
  The Sun is ~2/3 the size seen from Earth; Earth is a bright star. Mars's rotation comes from the IAU
  model; checked: Curiosity's landing (6 Aug 2012, 05:17 UTC) gives mid-afternoon local solar time
  (15:35), as reported.
- **Phobos and Deimos** are drawn from mean orbital elements (JPL, with the precession of their orbits),
  so their positions are approximate (a few degrees). Checked: on 2 April 2022 Phobos crosses the Sun
  as seen from Jezero, the eclipse Perseverance filmed. Phobos rises in the west and sets in the east
  twice a day; neither is visible from near the poles (above ~70° for Phobos).

### Earth analogs in 3D

On the Earth map, pick an analog result (or select a point) and click **Stand here in 3D**
(`#/earth3d?lat=..&lon=..&t=..`). Same view and controls as on the Moon and Mars, with Earth's data:
- **Heights**: NASA **NASADEM** (the Space Shuttle radar mission SRTM, reprocessed), 1 arc second
  (~30 m), 60° N to 56° S: near ring at full resolution, mid ring every 8th sample, far ring (±150 km)
  from the file's coarsest overview. One cloud-optimised GeoTIFF per 1° tile on Microsoft Planetary
  Computer, read in small pieces; the browser first fetches a free anonymous access token. No tile =
  sea. North of 60° N and south of 56° S (Devon Island, Svalbard, Antarctica) the heights come from the
  AWS Terrain Tiles (web-Mercator PNGs, ~40 m there), with the sea floor cut off at sea level.
- **Ground**: Esri World Imagery as a texture per ring (up to ~1 m per pixel in deserts; where the
  finest level is missing, the next coarser one), with its own shadows from when it was taken.
  No made-up craters; rocks and small bumps are made up.
- **Sky** (`sky.js`): Sun and Moon from astronomy-engine's observer functions (with refraction); the
  Moon is a grey globe lit by the Sun, so it shows its phase. Blue sky, orange glow at sunset, haze
  over distance (~90 km). Checked: noon Sun at 23° S on 21 June is 43.6° up (90 − 23 − 23.44).
- Not yet: stars and planets, a real map of the Earth (it's a cloudy blue stand-in), the 5 m south-pole
  DEM. Very close to the poles (above ~88°) the DEM rows are read at full width, so loading is slower.

`tools/build_far_dem.mjs moon|mars` makes the far-terrain files from PDS `ldem_16.img` / MOLA
`megt90n000eb.img` (downloaded to `data/raw/`).

### Moon thermal inertia: from Diviner's midnight temperatures

Both worlds show thermal inertia, made the same way: ground with a high thermal inertia (rocks,
bedrock) stores the day's heat and stays warmer at night; fine dust cools fast. Mars's map (TES) was
calculated from night temperatures by the TES team; for the Moon, `tools/moon_thermal_inertia.py`
does it from Diviner's global mosaic of the bolometric (whole-surface, rocks included) temperature
at slope-adjusted midnight (128 px/deg, streamed and averaged to 32 px/deg by
`tools/fetch_diviner_night.py`, so the 3.3 GB file is never stored):

- A thermal model (uniform ground, the 29.53-day lunar day, sunlight 1361 W/m², albedo 0.12,
  emissivity 0.95, 40 layers, implicit time steps) gives the midnight temperature for 48 thermal
  inertias (10-3000 TIU) at every degree of latitude, e.g. at the equator 103 K for 50 TIU,
  195 K for 1000 TIU (measured lunar nights: ~95-105 K over typical soil).
- Each spot's measured temperature is matched to its thermal inertia.

Results: typical soil 42-46 TIU (published lunar values ~50); fresh craters much higher (Tycho's
floor ~200, up to ~430; Aristarchus ~110). Like the TES map it's an apparent (bulk) value: boulders
in fine soil give an in-between number. Albedo differences (0.07-0.16) shift it by ~10-15%.

### Mars temperatures: a thermal model

No global measured surface-temperature map of Mars exists in the PDS (orbiters only pass each
place at ~2-3 am and pm). `tools/mars_thermal.py` calculates them instead, in the spirit of
NASA/USGS's KRC model, for every 1 x 1 degree cell from NASA data:

- **Inputs:** MGS TES albedo (`mgs-m-tes-special-v1`), TES night thermal inertia, MOLA elevation.
- **Sunlight:** Mars's real orbit (eccentricity 0.0934, tilt 25.19 deg), hour by hour over the year;
  dimmed by dust (optical depth 0.3) along the slanted path, half of it arriving as skylight.
- **Atmosphere's infrared glow:** 5.5% of local noon sunlight.
- **Ground:** heat diffusion through 30 layers (heat capacity 1.2 MJ/m3/K, conductivity from thermal inertia).
- **CO2 frost:** the surface can't cool below the frost point (~148 K, from local pressure);
  extra cooling builds frost (albedo 0.6) that must evaporate before the ground warms.
- Two Mars years are simulated (implicit time steps, Newton iterations on frost-free ground);
  the second is kept. All of Mars runs in a few minutes on 4 cores (numba).

**Check against landers** (typical night / day surface temperature, model vs. published):
Curiosity 189 / 269 K vs ~180-200 / 270-295 K; InSight 185 / 274 K vs ~170-190 / 250-270 K;
Perseverance 191 / 269 K vs ~180-190 / 270-290 K; Viking 1 188 / 264 K vs ~180-190 / 260-270 K.
Within ~10 K. It is still a model: no dust storms, seasonal pressure changes or water-ice caps.

**Why linear or logarithmic.** Elevation, iron, temperatures and ice are roughly bell-shaped over a
limited range, and equal steps are what people compare: linear. Slope, rock cover and thermal
inertia each span 2-3 orders of magnitude with most values bunched at the low end (e.g. half of
Mars has slopes under 0.6 deg, 99% under 13 deg): logarithmic, otherwise most of the map is one colour.

**Methods.**
- Slope: steepness between neighbouring points, both bodies at the same ~1.9 km pixel size
  (MOLA 32 px/deg; LOLA 64 px/deg averaged to 16).
- Diviner temperatures: the Global Cumulative Product gives the surface temperature of every
  0.5 deg spot for 96 times of day. Each spot is seen at ~55-65% of those times; gaps of up to
  2 h are filled by interpolating along the daily cycle, spots with longer gaps are left out.
- Mars ice: hydrogen slows neutrons, so fewer epithermal neutrons escape; shown as % below the
  driest 5% of the planet. Seasonal CO2 frost (up to ~1 m in winter) hides the ice beneath it, so
  poleward of 45 deg only that hemisphere's frost-free summer is averaged (north Ls 105-165, south
  Ls 285-345); elsewhere all seasons. (An earlier version used HEND's first months of 2002, during
  northern winter, which made the north pole look dry.)
- Coarse data (iron, ice) is smoothed at about half its cell size, ignoring gaps, so it reads
  as a map instead of squares; small holes in the Diviner temperatures are filled from
  neighbours.
- Orbit-track stripes (TES thermal inertia, Diviner rock abundance) are removed by subtracting
  the part of the east-west detail that stays consistent over a long north-south stretch, then
  smoothing a little more across the stripes than along them.
- Layers that don't cover the whole globe are cut at a clean latitude line in the browser.
  (A "no data" value in the tiles wouldn't survive lossy compression.)
- Iron uses a separate colour range per body: Mars only varies between ~15 and 23% FeO,
  which on the Moon's 0-24% range would be one flat colour.

The layers are stored as 8-bit WebP "data tiles" in `public/overlays/` (value -> real units in
`index.json`); the browser colours them. To rebuild (downloads ~3.6 GB into `data/raw/`):

    pip install numpy scipy pandas pillow numba tifffile imagecodecs
    python3 tools/fetch_power.py               # Earth climate (NASA POWER), ~10 min
    python3 tools/build_layers.py              # or e.g.: python3 tools/build_layers.py mars iron
    python3 tools/build_search_grid.py         # Earth grid for the analog search, ~1 min
    python3 tools/fetch_gibs.py                # MODIS land cover + MERRA-2 dust from NASA GIBS, 16 MB
    python3 tools/build_search_extra.py        # adds sunlight, ground temperature, bare ground, dust
    python3 tools/build_earth_features.py      # impact structures + volcanoes for the Earth map
