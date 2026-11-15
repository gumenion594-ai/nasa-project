// Equipment and technology for Simulation Planning.
//
// Prices: every cost says whether it is a published price (with its source) or an estimate (with
// what it is based on). Estimates are wide ranges, in US dollars; they are not quotes. Nothing here
// is recommended by default: plan.js picks items only for the gaps the selected place has.
//
// Fields:
//   name, img (Wikimedia Commons thumbnail), wiki (article the image comes from), icon (no image)
//   purpose: what it does; heritage: where it has been used (missions, facilities)
//   cost: { lo, hi, kind: 'published' | 'estimate' | 'mixed', basis }   one-off purchase
//   perCampaign: same, paid for every simulation campaign instead of once (beam time, flights)
//   opex: { lo, hi, basis }   per year (maintenance, consumables)
//   setting: 'outdoor' | 'equipment' | 'facility'   (where the condition can be recreated)
//   hall: needs a building (chambers, cranes); kw, hours: power draw and hours of use a year
//   lead: months to buy, build and commission
//   prep: { role: person-months } to set it up;  ops: { role: full-time people } to run it
//   sources: [{ label, url }]

const W = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/';
export const ROLES = {
  mission: { name: 'Mission and simulation specialists', does: 'plan the simulation scenarios, run test campaigns, keep the protocols and safety rules' },
  env: { name: 'Environmental engineers', does: 'specify and verify temperature, pressure, humidity and air conditions' },
  mech: { name: 'Mechanical engineers', does: 'design and install chambers, cranes, cooling and structures' },
  elec: { name: 'Electrical engineers', does: 'power supply, control systems, lamps, sensors and data logging' },
  geo: { name: 'Geologists', does: 'choose and check rock and simulant, build realistic terrain, sample the site' },
  atmo: { name: 'Atmospheric scientists', does: 'gas mixtures, dust and wind experiments, sunlight and UV measurements' },
  tech: { name: 'Technicians', does: 'operate and maintain the equipment day to day, prepare test runs' },
  construct: { name: 'Construction workers', does: 'earthworks, foundations, halls and shade structures' },
};

export const ITEMS = {
  offload: {
    name: 'Partial-gravity offload rig',
    img: `${W}d/d3/Drop_Test_at_Lunar_Landing_Research_Facility_-_GPN-2000-001287.jpg/330px-Drop_Test_at_Lunar_Landing_Research_Facility_-_GPN-2000-001287.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Lunar_Landing_Research_Facility',
    purpose: 'An overhead crane with a constant-force cable carries part of the weight of a person, rover or tool, so it moves as it would in lower gravity.',
    heritage: 'NASA Johnson’s ARGOS (Active Response Gravity Offload System) simulates lunar, Martian or zero gravity this way; Apollo crews trained in Langley’s Lunar Landing Research Facility (pictured).',
    cost: { lo: 150e3, hi: 1.5e6, kind: 'estimate', basis: 'No published price. Low end: a passive counterweight-and-harness rig; high end: an active robotic crane like ARGOS with its steel frame.' },
    opex: { lo: 10e3, hi: 75e3, basis: 'cables, sensors and inspections, ~5–7% of the purchase a year (estimate)' },
    setting: 'facility', hall: true, kw: 15, hours: 400, lead: 9,
    prep: { mech: 6, elec: 3, tech: 4, construct: 2 }, ops: { tech: 0.5, mission: 0.25 },
    sources: [{ label: 'NASA: ARGOS full-size reduced-gravity simulator', url: 'https://technology.nasa.gov/patent/MSC-TOPS-60' },
      { label: 'Lunar Landing Research Facility (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Lunar_Landing_Research_Facility' }],
  },
  parabolic: {
    name: 'Parabolic-flight campaign',
    img: `${W}a/a9/Zero_gravity_flight_trajectory_C9-565_vector.svg/330px-Zero_gravity_flight_trajectory_C9-565_vector.svg.png`,
    wiki: 'https://en.wikipedia.org/wiki/Reduced-gravity_aircraft',
    purpose: 'An aircraft flying parabolas gives about 20–30 seconds of lunar or Martian gravity at a time: whole-body tests the offload rig can’t do.',
    heritage: 'Zero Gravity Corporation flies Martian (1/3 g) and lunar (1/6 g) parabolas; ESA and NASA run research parabolic-flight campaigns.',
    perCampaign: { lo: 4 * 8200, hi: 8 * 8200, kind: 'published', basis: '4–8 seats at the public price of $8,200 a seat (2022); research charters are quoted on request' },
    setting: 'facility', lead: 6,
    prep: { mission: 1 }, ops: {},
    sources: [{ label: 'Zero Gravity Corporation (Wikipedia): prices and lunar / Martian parabolas', url: 'https://en.wikipedia.org/wiki/Zero_Gravity_Corporation' }],
  },
  tvac: {
    name: 'Thermal-vacuum chamber',
    img: `${W}5/5f/Thermal_Vacuum_Test_Chamber_A_with_Door_Open.jpg/330px-Thermal_Vacuum_Test_Chamber_A_with_Door_Open.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Thermal_vacuum_chamber',
    purpose: 'Pumps out the air and drives the temperature with a cold shroud and heaters, so parts, instruments and suits meet the Moon’s vacuum and its day and night temperatures.',
    heritage: 'NASA Johnson’s Chamber A (pictured) was built to test Apollo spacecraft and later tested the James Webb Space Telescope.',
    cost: { lo: 52e3, hi: 2e6, kind: 'mixed', basis: '~$52,000 for a small chamber (UNISEC 2019 paper); the high end is an estimate for a walk-in chamber big enough for a rover wheel or a suited person. Renting test time is cheaper: from £2,000 a test at Alba Orbital (Glasgow).' },
    opex: { lo: 15e3, hi: 150e3, basis: 'liquid nitrogen, pump service and repairs (estimate)' },
    setting: 'facility', hall: true, kw: 40, hours: 600, lead: 12,
    prep: { mech: 4, elec: 3, env: 3, tech: 4 }, ops: { tech: 1, env: 0.5 },
    sources: [{ label: 'Thermal vacuum chamber (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Thermal_vacuum_chamber' },
      { label: 'UNISEC LaSEINE 2019: low-cost thermal-vacuum chambers (~$52,000)', url: 'https://kyutech.repo.nii.ac.jp/record/6696/files/LaSEINE-2019_20.pdf' },
      { label: 'Alba Orbital test services (from £2,000)', url: 'https://satsearch.co/products/alba-orbital-test-services' }],
  },
  marschamber: {
    name: 'Mars-atmosphere chamber (CO₂ at ~6 hPa, down to −170 °C)',
    img: `${W}e/ec/Vacuum_chamber-being_opened_by_engineer.jpeg/330px-Vacuum_chamber-being_opened_by_engineer.jpeg`,
    wiki: 'https://en.wikipedia.org/wiki/Vacuum_chamber',
    purpose: 'A vacuum chamber filled with carbon dioxide at Mars’s surface pressure and cooled with liquid nitrogen: the only way to get Mars’s air, pressure and night-time cold together.',
    heritage: 'Aarhus University’s Mars Simulation Wind Tunnel goes below 1/100 of Earth’s air pressure and down to −170 °C, with winds up to 30 m/s and Mars dust. A CO₂ atmosphere also allows tests of oxygen production like Perseverance’s MOXIE.',
    cost: { lo: 100e3, hi: 2e6, kind: 'estimate', basis: 'No published price for a Mars chamber. A vacuum chamber (small ones from ~$52,000, UNISEC 2019) plus CO₂ gas handling and liquid-nitrogen cooling; the high end is a walk-in chamber. Using an existing facility such as Aarhus is the cheaper route.' },
    opex: { lo: 15e3, hi: 150e3, basis: 'CO₂, liquid nitrogen, pump service (estimate)' },
    setting: 'facility', hall: true, kw: 40, hours: 600, lead: 12,
    prep: { mech: 4, elec: 3, env: 3, atmo: 2, tech: 4 }, ops: { tech: 1, atmo: 0.5 },
    sources: [{ label: 'ESA: Aarhus Mars Simulation Wind Tunnel', url: 'https://www.esa.int/ESA_Multimedia/Images/2019/05/Aarhus_Mars_Simulation_Wind_Tunnel' },
      { label: 'MOXIE, Mars Oxygen ISRU Experiment (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Mars_Oxygen_ISRU_Experiment' },
      { label: 'UNISEC LaSEINE 2019: low-cost thermal-vacuum chambers', url: 'https://kyutech.repo.nii.ac.jp/record/6696/files/LaSEINE-2019_20.pdf' }],
  },
  climate: {
    name: 'Low-temperature climatic chamber (to −70 °C)',
    img: 'https://upload.wikimedia.org/wikipedia/commons/7/77/Environmental_chamber.jpg',
    wiki: 'https://en.wikipedia.org/wiki/Environmental_chamber',
    purpose: 'Cycles test pieces between day and night temperatures at normal air pressure: faster and cheaper than a vacuum chamber for cold and thermal-cycling tests.',
    heritage: 'Standard equipment for qualifying spacecraft and rover parts before they go into a vacuum chamber.',
    cost: { lo: 42e3, hi: 150e3, kind: 'mixed', basis: '$42,017–67,448 list price for −70 °C cabinet chambers (Binder); walk-in chambers start at ~$85,000 and cost more for very low temperatures (Associated Environmental Systems). The high end is an estimate.' },
    opex: { lo: 5e3, hi: 20e3, basis: 'service and refrigerant (estimate)' },
    setting: 'equipment', hall: false, kw: 15, hours: 1500, lead: 4,
    prep: { env: 1, elec: 1, tech: 1 }, ops: { tech: 0.25 },
    sources: [{ label: 'Associated Environmental Systems: what a walk-in test chamber costs', url: 'https://www.associatedenvironmentalsystems.com/blog/what-is-the-price-of-a-walk-in-test-chamber' },
      { label: 'Binder −70 °C environmental chamber (list price)', url: 'https://www.zoro.com/binder-environmental-chamber-480v-47-625-w-9020-0365/i/G514548095/' }],
  },
  solarsim: {
    name: 'Solar simulator (space sunlight)',
    img: `${W}1/12/Solar_simulator_at_U-Dub.jpg/330px-Solar_simulator_at_U-Dub.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Solar_simulator',
    purpose: 'Xenon or LED lamps reproduce sunlight as it is outside an atmosphere (the AM0 spectrum), including the ultraviolet Earth’s air removes; used inside the vacuum chamber, and for long days and nights under full control.',
    heritage: 'Used to test solar cells and spacecraft thermal designs; NASA’s large space-simulation chambers have them.',
    cost: { lo: 50e3, hi: 1e6, kind: 'published', basis: 'Class AAA solar simulators: ~$50,000 for a small test area to over $1 million for a large one (G2V pricing guide)' },
    opex: { lo: 5e3, hi: 50e3, basis: 'replacement xenon lamps are the main running cost (G2V)' },
    setting: 'facility', hall: true, kw: 10, hours: 400, lead: 6,
    prep: { elec: 2, tech: 1 }, ops: { tech: 0.25, atmo: 0.25 },
    sources: [{ label: 'Solar simulator (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Solar_simulator' },
      { label: 'G2V: solar simulator pricing guide', url: 'https://g2voptics.com/solar-simulator-price' }],
  },
  uvlamps: {
    name: 'UV lamp array (UV-C)',
    img: `${W}1/13/UV-ontsmetting_laminaire-vloeikast.JPG/330px-UV-ontsmetting_laminaire-vloeikast.JPG`,
    wiki: 'https://en.wikipedia.org/wiki/Ultraviolet_germicidal_irradiation',
    purpose: 'Adds the short-wave ultraviolet that reaches the ground on Mars but is absorbed by Earth’s ozone layer, for tests of materials, instruments and microbes.',
    heritage: 'With no ozone layer, ultraviolet down to ~200 nm reaches Mars’s surface (Cockell et al. 2000).',
    cost: { lo: 10e3, hi: 60e3, kind: 'estimate', basis: 'UV-C lamp sets with power supplies and a UV meter; no reference price' },
    opex: { lo: 2e3, hi: 10e3, basis: 'replacement lamps (estimate)' },
    setting: 'equipment', kw: 3, hours: 500, lead: 2,
    prep: { elec: 1, tech: 1 }, ops: { tech: 0.1 },
    sources: [{ label: 'Cockell et al. 2000: the ultraviolet environment of Mars', url: 'https://doi.org/10.1006/icar.2000.6393' }],
  },
  shade: {
    name: 'Shade structures over the test area',
    icon: '⛱',
    purpose: 'Neutral shade cloth on frames cuts the sunlight on an outdoor test area to the level on Mars, which gets ~43% of Earth’s sunlight.',
    heritage: 'Mars receives 586 W/m² of sunlight above its atmosphere, Earth 1,361 W/m² (NASA fact sheets).',
    cost: { lo: 5e3, hi: 40e3, kind: 'estimate', basis: 'shade-cloth frames over ~1,000 m²; no reference price' },
    opex: { lo: 1e3, hi: 5e3, basis: 'repairs (estimate)' },
    setting: 'outdoor', lead: 1,
    prep: { construct: 1, tech: 0.5 }, ops: {},
    sources: [{ label: 'NASA Mars Fact Sheet (solar irradiance)', url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html' }],
  },
  earthworks: {
    name: 'Terrain construction (excavator, boulders, craters)',
    img: `${W}8/82/Excavator_Postiguet_Beach_2.jpg/330px-Excavator_Postiguet_Beach_2.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Excavator',
    purpose: 'Reshapes a test field: boulder fields, slopes, crater pits and mounds, or levelled and cleared ground, to match the site.',
    heritage: 'ESA and DLR’s LUNA hall in Cologne (opened 2024) has ~700 m² of regolith shaped into lunar terrain; NASA Johnson has an outdoor rock yard for rover and spacewalk tests.',
    cost: { lo: 50e3, hi: 400e3, kind: 'estimate', basis: 'excavator and truck hire, imported rock and crushed basalt for a test field of about one hectare; no reference price. For scale, the whole LUNA facility, hall included, was reported to cost ~€45 million.' },
    opex: { lo: 5e3, hi: 30e3, basis: 'regrading after tests (estimate)' },
    setting: 'outdoor', lead: 3,
    prep: { construct: 6, geo: 2, mech: 1 }, ops: { tech: 0.25, geo: 0.25 },
    sources: [{ label: 'DLR: opening of LUNA, “the Moon on Earth”', url: 'https://www.dlr.de/en/latest/news/2024/training-facility-for-astronautical-and-robotic-missions-to-the-moon' },
      { label: 'IamExpat: LUNA cost ~€45 million', url: 'https://iamexpat.de/lifestyle/lifestyle-news/european-space-agency-opens-moon-replica-centre-cologne' }],
  },
  simulant: {
    name: { moon: 'Lunar regolith simulant (LHS-1) test bed', mars: 'Martian regolith simulant (MGS-1) test bed' },
    img: { moon: `${W}0/0c/JSC-1A_lunar_simulant_jar.agr.jpg/330px-JSC-1A_lunar_simulant_jar.agr.jpg`,
      mars: `${W}7/7e/Martian_regolith_simulant_-_pile.JPG/330px-Martian_regolith_simulant_-_pile.JPG` },
    wiki: { moon: 'https://en.wikipedia.org/wiki/Lunar_regolith_simulant', mars: 'https://en.wikipedia.org/wiki/Martian_regolith_simulant' },
    purpose: 'Earth soil is weathered by water and life; regolith is sharp, unweathered rock dust. A bed of simulant gives wheels, drills, tools and seals the right ground.',
    heritage: { moon: 'LHS-1 was developed at the University of Central Florida’s Exolith Lab; NASA keeps a catalogue of lunar simulants; ESA/DLR’s LUNA uses EAC-1A basalt from a quarry near Cologne.',
      mars: 'MGS-1 was developed at the University of Central Florida’s Exolith Lab, based on the soil Curiosity analysed at Rocknest in Gale crater.' },
    cost: { lo: 65e3, hi: 190e3, kind: 'mixed', basis: '1–2 tonnes of research-grade simulant at ~$45/kg (Space Resource Technologies list price, before shipping) for close-up tests, plus 50–150 m³ of crushed local basalt for the bed ($20,000–100,000, estimate)' },
    opex: { lo: 2e3, hi: 15e3, basis: 'top-ups and dust control (estimate)' },
    setting: 'outdoor', lead: 3,
    prep: { geo: 2, construct: 2, tech: 1 }, ops: { geo: 0.25 },
    sources: {
      moon: [{ label: 'Space Resource Technologies: LHS-1 ($45 per kg bag)', url: 'https://spaceresourcetech.com/products/lhs-1-lunar-highlands-simulant' },
        { label: 'NASA ARES: lunar regolith simulants', url: 'https://ares.jsc.nasa.gov/projects/simulants/' },
        { label: 'DLR: LUNA facility', url: 'https://www.dlr.de/en/latest/news/2024/training-facility-for-astronautical-and-robotic-missions-to-the-moon' }],
      mars: [{ label: 'Space Resource Technologies: MGS-1 ($45 per kg bag)', url: 'https://spaceresourcetech.com/products/mgs-1-mars-global-simulant' },
        { label: 'UCF Exolith Lab / CLASS: MGS-1 Mars Global Simulant', url: 'https://sciences.ucf.edu/class/simulant_marsglobal/' }],
    },
  },
  cover: {
    name: 'Covered, dehumidified test bed',
    img: `${W}b/b0/Polytunnel_Balhungie.jpg/330px-Polytunnel_Balhungie.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Polytunnel',
    purpose: 'A tunnel hall over the test bed keeps rain off and, with dehumidifiers, keeps the simulant bone dry.',
    heritage: 'The LUNA hall in Cologne keeps its regolith indoors for the same reason.',
    cost: { lo: 30e3, hi: 200e3, kind: 'estimate', basis: 'tunnel hall of ~500–1,000 m² plus industrial dehumidifiers; no reference price' },
    opex: { lo: 5e3, hi: 25e3, basis: 'repairs and dehumidifier service (estimate)' },
    setting: 'outdoor', kw: 10, hours: 3000, lead: 3,
    prep: { construct: 3, env: 1, elec: 1 }, ops: { tech: 0.25 },
    sources: [{ label: 'Polytunnel (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Polytunnel' },
      { label: 'Dehumidifier (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Dehumidifier' }],
  },
  freeze: {
    name: 'Artificial ground freezing (icy test pit)',
    img: `${W}8/89/Ground_Freezing_System_in_Operation_while_Commuter_Trains_Run_Through_the_Big_Dig.gif/330px-Ground_Freezing_System_in_Operation_while_Commuter_Trains_Run_Through_the_Big_Dig.gif`,
    wiki: 'https://en.wikipedia.org/wiki/Ground_freezing',
    purpose: 'Pipes with chilled brine freeze a pit of icy soil, as civil engineers do when tunnelling (Boston’s Big Dig, pictured): ground for ice drills and diggers.',
    heritage: 'The Phoenix lander dug into ice-rich ground on Mars in 2008; future missions want to mine that ice for water.',
    cost: { lo: 50e3, hi: 300e3, kind: 'estimate', basis: 'brine chiller, pipes and insulation for a ~100 m² pit; no reference price' },
    opex: { lo: 10e3, hi: 40e3, basis: 'chiller service (estimate); electricity is counted separately' },
    setting: 'equipment', kw: 30, hours: 4000, lead: 4,
    prep: { mech: 2, env: 2, construct: 2, tech: 1 }, ops: { tech: 0.25 },
    sources: [{ label: 'Ground freezing (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Ground_freezing' },
      { label: 'Phoenix lander (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Phoenix_(spacecraft)' }],
  },
  dustwind: {
    name: 'Dust and wind generators',
    img: `${W}9/9c/8-Foot_Transonic_Pressure_Tunnel_%289443013405%29.jpg/330px-8-Foot_Transonic_Pressure_Tunnel_%289443013405%29.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Wind_tunnel',
    purpose: 'Fans and dust feeders raise fine dust over the test area, for dust-storm tests of solar panels, seals and cameras.',
    heritage: 'Aarhus University’s Mars Simulation Wind Tunnel does this at Mars pressure. Outdoors it runs at Earth pressure, where dust behaves less like on Mars.',
    cost: { lo: 20e3, hi: 100e3, kind: 'estimate', basis: 'industrial fans, dust feeders and dust monitors; no reference price' },
    opex: { lo: 3e3, hi: 15e3, basis: 'dust simulant and service (estimate)' },
    setting: 'equipment', kw: 20, hours: 300, lead: 3,
    prep: { mech: 1, atmo: 1, tech: 1 }, ops: { atmo: 0.25 },
    sources: [{ label: 'ESA: Aarhus Mars Simulation Wind Tunnel', url: 'https://www.esa.int/ESA_Multimedia/Images/2019/05/Aarhus_Mars_Simulation_Wind_Tunnel' }],
  },
  radbeam: {
    name: 'Beam time at a space-radiation accelerator',
    img: 'https://upload.wikimedia.org/wikipedia/commons/d/d0/High_Flux_Beam_Reactor_-_Brookhaven_%287494424838%29.jpg',
    wiki: 'https://en.wikipedia.org/wiki/Brookhaven_National_Laboratory',
    purpose: 'Heavy ions and protons from an accelerator reproduce the cosmic rays and solar particles that reach the surface, for tests of shielding, electronics and living things. Nowhere on Earth’s surface gets this radiation.',
    heritage: 'NASA’s Space Radiation Laboratory at Brookhaven National Laboratory was built for this (pictured: Brookhaven’s former High Flux Beam Reactor).',
    perCampaign: { lo: 8 * 4000, hi: 24 * 4000, kind: 'published', basis: '8–24 beam hours at ~$4,000 an hour (NASA overview of heavy-ion test facilities, 2022); NASA-approved studies get their beam time paid by NASA' },
    setting: 'facility', lead: 9,
    prep: { mission: 1 }, ops: {},
    sources: [{ label: 'Brookhaven: NASA Space Radiation Laboratory', url: 'https://www.bnl.gov/nsrl/' },
      { label: 'NASA (LaBel 2022): heavy-ion facilities, NSRL ~$4,000 per hour', url: 'https://ntrs.nasa.gov/api/citations/20220001810/downloads/LaBel-2022-WANDA-Heavy-Ion-Facility-CONUS-Overview-v2.pdf' }],
  },
  dosimeters: {
    name: 'Radiation dosimeters and shielding samples',
    img: `${W}c/c6/Radiation_Assessment_Detector_seen_by_left_Mastcam.jpg/330px-Radiation_Assessment_Detector_seen_by_left_Mastcam.jpg`,
    wiki: 'https://en.wikipedia.org/wiki/Radiation_assessment_detector',
    purpose: 'Measure the dose people and parts get, and compare shielding (regolith, water, polyethylene) in the beam tests.',
    heritage: 'Curiosity’s Radiation Assessment Detector (pictured) measured the dose on Mars; Chang’e 4 measured it on the Moon.',
    cost: { lo: 5e3, hi: 30e3, kind: 'estimate', basis: 'electronic personal dosimeters, a survey meter and shielding samples; no reference price' },
    opex: { lo: 1e3, hi: 5e3, basis: 'calibration (estimate)' },
    setting: 'equipment', lead: 2,
    prep: { tech: 0.5 }, ops: { tech: 0.1 },
    sources: [{ label: 'Radiation assessment detector (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Radiation_assessment_detector' }],
  },
};

/** An item's text for one world (some fields differ between the Moon and Mars). */
export function itemFor(id, world) {
  const it = ITEMS[id];
  const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) && (v.moon || v.mars) ? v[world] : v);
  return { id, ...it, name: pick(it.name), img: pick(it.img), wiki: pick(it.wiki), heritage: pick(it.heritage), sources: pick(it.sources) };
}
