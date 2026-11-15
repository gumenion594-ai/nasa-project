# Data sources

All the data and imagery Planet Maps uses, with the organisation behind each. Map imagery is
streamed while you browse; the data layers are processed by `tools/build_layers.py`,
`tools/mars_thermal.py` and `tools/build_search_grid.py`.

## NASA data

**Mars**
- **MOLA elevation** (Mars Orbiter Laser Altimeter, Mars Global Surveyor): MEGDR 32 px/deg,
  `MGS-M-MOLA-5-MEGDR-L3-V1.0`, NASA Planetary Data System (PDS) Geosciences Node.
  Used for elevation, slope, relief, the thermal model and Mars sunlight (dust column).
- **MOLA MEGDR 16 px/deg** (`megt90n000eb.img`, same data set), averaged to 8 px/deg: far terrain in
  the Mars 3D view (`public/surface3d/mars_8ppd.bin`).
- **Phobos and Deimos orbits**: mean orbital elements from JPL Solar System Dynamics (planetary
  satellite mean elements, after Jacobson 2014). Approximate positions in the Mars 3D view sky.
- **TES thermal inertia** (Thermal Emission Spectrometer, Mars Global Surveyor): global night map
  2007 (N. Putzig, SwRI), `MGS-M-TES-5-TIMAP-V1.0`, PDS Geosciences. Used for "Dusty or rocky
  terrain" and the thermal model.
- **TES albedo** (Mars Global Surveyor): global albedo 8 px/deg (P. Christensen, Arizona State
  University), PDS Geosciences. Used for the thermal model.
- **Mars Odyssey Gamma Ray Spectrometer**: element maps (iron), `ODY-M-GRS-5-ELEMENTS-V1.0`,
  PDS Geosciences.
- **Mars Odyssey GRS averaged neutron data** (epithermal neutrons, ~12 Mars years),
  `ODY-M-GRS-5-AND-V2`, PDS Geosciences. Used for "Underground ice".
- **Viking MDIM 2.1 colour mosaic** (NASA/JPL/USGS), ~232 m/pixel, via NASA Mars Trek.
  Map imagery and the home-page globe; its brightness also tints the ground in the Mars 3D view.
- **CTX mosaic** (Context Camera, Mars Reconnaissance Orbiter; NASA/JPL/MSSS, Caltech Murray
  Lab global mosaic), ~5 m/pixel, served by Esri (OnMars). Close-up map imagery.

**Moon**
- **LOLA elevation** (Lunar Orbiter Laser Altimeter, Lunar Reconnaissance Orbiter): LDEM 64 px/deg,
  `LRO-L-LOLA-4-GDR-V1.0`, PDS Geosciences. Used for elevation, slope and relief.
- **LOLA polar elevation models** (LRO), 75°–90° N and S, 240 m, polar stereographic, same data
  set, PDS Geosciences. Used for crater and mountain shadows in Moon sunlight.
- **LOLA LDEM 16 px/deg** (same data set, PDS Geosciences), averaged to 8 px/deg: far terrain in the
  Moon 3D view (`public/surface3d/moon_8ppd.bin`).
- **LOLA global DEM 118 m** (`Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif`, USGS Astrogeology
  Science Center, from LRO LOLA data), read on demand by the browser: near and middle terrain in the
  Moon 3D view.
- **Diviner Global Cumulative Product** (Diviner Lunar Radiometer, LRO): surface temperature for
  96 times of day, 0.5 deg. Used for temperature, daily swing, and max./min. temperature.
- **Diviner global high-resolution mosaic, bolometric temperature at slope-adjusted midnight**
  (LRO, GHRM, `dghrm_tbol_m_70s70n`, 128 px/deg, 70°S–70°N), `urn:nasa:pds:lro_diviner_derived1`,
  PDS Geosciences. Turned into thermal inertia with a thermal model for "Dusty or rocky terrain".
- **Lunar Prospector Gamma Ray Spectrometer** element abundances (FeO), 2 deg,
  `LP-L-GRS-5-ELEM-ABUNDANCE-V1.0`, PDS Geosciences. Used for iron.
- **LRO WAC global mosaic** (Wide Angle Camera; NASA/GSFC/Arizona State University), ~100 m/pixel,
  via NASA Moon Trek. Map imagery and the home-page globe.

**Earth**
- **NASA POWER** (Prediction Of Worldwide Energy Resources, NASA Langley Research Center),
  long-term monthly climatology: `TS_MAX`, `TS_MIN`, `TS_RANGE` (ground-surface temperature),
  `PRECTOTCORR` (rainfall; from MERRA-2 / GPM), `ALLSKY_SFC_UV_INDEX` (UV; from CERES),
  `ALLSKY_SFC_SW_DWN` (sunlight reaching the ground; from CERES).
  Used for Earth's temperature, dryness, UV and sunlight layers and the analog search.
  `TS` (yearly mean ground-surface temperature) for "Frozen ground" in the analog search.
- **MODIS land cover** (MCD12Q1, Terra + Aqua, IGBP classification), 2023, via **NASA GIBS**
  (`MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual`, decoded with its published colour map; sampled at
  0.025°). Used for "Bare ground" (class 16, Barren) in the analog search.
- **MERRA-2** dust surface mass concentration (NASA GMAO reanalysis), monthly 2014–2023, via NASA GIBS
  (`MERRA2_Dust_Surface_Mass_Concentration_Monthly`). Used for "Dust in the air" in the analog search.

**Services**
- **NASA Mars Trek** and **NASA Moon Trek** (Solar System Treks, NASA JPL): map tile services.
- **NASA Planetary Data System, Geosciences Node** (Washington University in St. Louis): downloads.
- **USGS Astrogeology Science Center** (Planetary Maps / Annex): the 118 m Moon DEM and the 200 m
  Mars DEM, served to the browser.

**Mars route planner**
- **Robbins & Hynek global Mars crater database** (2012 release, `RobbinsCraters_20121016`):
  384,343 craters ≥ 1 km with position, diameter and MOLA-measured rim-to-floor depth, rim height
  and degradation state. Robbins, S. J. & Hynek, B. M. (2012), JGR 117, E05004,
  doi:10.1029/2011JE003966; https://craters.sjrdesign.net/ (NASA-funded; uses MGS MOLA and
  Mars Odyssey THEMIS data). Used for crater hazards and depths.
- **Mars Dust Activity Database (MDAD) v1.0**: 14,974 dust storms mapped from MGS MOC and MRO
  MARCI daily global images, Mars years 24–32 (2001–2015). Battalio, M. & Wang, H. (2021), Icarus
  354, 114059; data doi:10.7910/DVN/F8R2JX. Used for dust-storm frequency by season.
- Slope limits: NASA xEVA System Concept of Operations (EVA-EXP-0042); Rankin, A. et al., "Mars
  Curiosity Rover Mobility Trends During the First Seven Years" (JPL); Ono, M. et al., Mars 2020
  surface traversability analysis (JPL).
- Walking time: Tobler, W. (1993), hiking function (Earth-based).

**Moon route planner**
- **Robbins global lunar crater database** (2018 release, `lunar_crater_database_robbins_2018`):
  1,296,796 craters ≥ 1–2 km with position and diameter (no depths); the app keeps the 909,934
  craters ≥ 1.3 km. Robbins, S. J. (2019), JGR Planets 124, 871–892, doi:10.1029/2018JE005592;
  USGS Astrogeology, https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins.
  Depths of craters ≥ 15 km measured from LRO LOLA LDEM 16 px/degree
  (`tools/build_moon_route_data.mjs`); smaller ones from Pike, R. J. (1977), "Size-dependence in
  the shape of fresh impact craters on the Moon".
- Rover profile: NASA NSSDC "The Apollo Lunar Roving Vehicle"; Boeing, LRV Operations Handbook
  (1971); Apollo Lunar Surface Journal (traverse distances and driving times).

**Rover profiles** (`src/route/rovers.js`)
- Rankin, A. et al. (2022), "Mars Curiosity Rover Wheel Wear", JPL: mass and wheel size of
  Sojourner, Spirit/Opportunity, Curiosity and Perseverance (Table 1).
- Mars Pathfinder Microrover Flight Experiment overview (NASA PDS, 1996); JPL Robotics, Mars
  Pathfinder Rover: Sojourner.
- JPL Mars Exploration Rover pages; Leger, P. C. et al. (2005), "Driving Spirit at Gusev Crater"
  (JPL); JPL news "Rover Takes on Steepest Slope Ever Tried on Mars" (2016); JPL "Slip Sliding Away
  on the Red Planet" (2004); NASA, Opportunity mission complete (2019).
- NASA/JPL Mars Science Laboratory (Curiosity) pages; JPL Robotics, Mars 2020 rover mobility.

## Partner data

- **Mars HRSC + MOLA blended DEM** (`Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif`; ESA/DLR/FU Berlin
  High Resolution Stereo Camera on Mars Express, blended with NASA MOLA; USGS Astrogeology Science
  Center), 200 m, read on demand by the browser: near and middle terrain in the Mars 3D view.
- **Kaguya Terrain Camera ortho mosaic** (JAXA / SELENE), ~21 m/pixel, via NASA Moon Trek.
  Close-up Moon imagery.
- **NOAA ETOPO 2022** global relief model, 60 arc-seconds (NOAA National Centers for Environmental
  Information; includes NASA SRTM data). Earth elevation, slope, relief, land mask and the analog
  search.
- **Natural Earth** 1:50m country boundaries (public domain, naturalearthdata.com; via the
  `world-atlas` package). Country of each Earth analog result and the country filter.
- **Esri World Imagery** (Esri, Maxar, Earthstar Geographics). Earth satellite imagery, also the
  ground texture in the Earth 3D view.
- **NASADEM** (NASA JPL, reprocessed SRTM Space Shuttle radar data), 1 arc second, 60° N–56° S, as
  cloud-optimised GeoTIFFs on Microsoft Planetary Computer (`nasadem` collection), read on demand by
  the browser: terrain in the Earth 3D view.
- **AWS Terrain Tiles** (Registry of Open Data on AWS; Mapzen/Tilezen, from SRTM, GMTED, ETOPO1 and
  national models). Earth 3D view terrain north of 60° N and south of 56° S.

## Earth features

- **Impact structures**: the confirmed structures in Wikipedia's regional "List of impact structures in …"
  pages (Africa, Asia and Russia, Australia, Europe, North America, South America; Antarctica has only
  unconfirmed ones), which follow the **Earth Impact Database** (Planetary and Space Science Centre,
  University of New Brunswick). 197 structures with position and diameter.
- **Volcanoes**: Smithsonian Institution **Global Volcanism Program**, Volcanoes of the World database,
  Holocene volcanoes (1,214), via its public web service (webservices.volcano.si.edu).

## Simulation Planning (facts, equipment, prices)

Listed with each item in the app (`src/simplan/facts.js`, `src/simplan/catalog.js`); the main ones:

- Gravity, air pressure and composition, day length, sunlight above the atmosphere: **NASA Planetary Fact
  Sheets** (Moon, Mars, Earth; nssdc.gsfc.nasa.gov).
- Surface radiation dose: Mars ~0.64 mSv a day, **Curiosity RAD** (Hassler et al. 2014, Science,
  doi:10.1126/science.1244797); Moon ~1.37 mSv a day, **Chang'e 4 LND** (Zhang et al. 2020, Science Advances,
  doi:10.1126/sciadv.aaz1334); Earth 2.4 mSv a year, **UNSCEAR 2008**.
- Mars surface UV: Cockell et al. 2000, Icarus, doi:10.1006/icar.2000.6393.
- Facilities and past use: NASA ARGOS (technology.nasa.gov), Lunar Landing Research Facility, NASA Johnson
  Chamber A, Aarhus Mars Simulation Wind Tunnel (ESA), NASA Space Radiation Laboratory (Brookhaven), ESA/DLR
  LUNA, MOXIE, Exolith Lab simulants.
- Published prices: regolith simulants LHS-1 / MGS-1 (Space Resource Technologies, $45 per kg bag),
  parabolic flights (Zero Gravity Corporation, $8,200 a seat in 2022), NSRL beam time (~$4,000/hour, NASA
  heavy-ion facility overview 2022), −70 °C chambers (Binder list prices), walk-in chambers (Associated
  Environmental Systems), small thermal-vacuum chambers (UNISEC 2019), solar simulators (G2V), LUNA's cost
  (~€45 million, press). Everything else is a labelled estimate.
- Images: Wikimedia Commons, via the linked Wikipedia articles.

## Known analog sites

`src/knownAnalogs.js`: 25 established Moon and Mars analog sites on Earth, each with one reference
(Wikipedia articles, which cite the NASA, ESA and research sources). Coordinates checked against the
articles' coordinates where they have them (within ~0.1°); sites spread over a large area are marked
approximate.

## Software

- Leaflet (maps), three.js (3D globes and the Moon / Mars / Earth 3D views), astronomy-engine (Sun, Earth,
  Moon and Mars positions and rotation), geotiff.js (reading the DEM file layout), Vite (build); Python with NumPy, SciPy, Numba,
  Pillow and tifffile for data processing.
