// Who can travel a route: an astronaut on foot or one of NASA's five Mars rovers; on the
// Moon, an astronaut or NASA's Apollo Lunar Roving Vehicle.
//
// Two kinds of numbers live here, kept apart on purpose:
//   specs - published facts about each rover, with their source
//   model - how the route planner treats the rover. These are MODEL ASSUMPTIONS made
//           for this app, derived from the specs where possible (each one says how).
//
// The terrain data is ~2.6 km per cell, so "slope" below means the slope averaged over
// ~2 km; a rover's local tilt on a crater wall or a boulder is steeper. Obstacles such as
// single rocks are far too small to see in this data: obstacle clearance only sets how
// much the planner dislikes rough ground and crater rims (proxies for rocky terrain).

const SRC = {
  rankin22: 'Rankin et al., "Mars Curiosity Rover Wheel Wear" (JPL, 2022), Table 1: mass and wheel size of all NASA Mars rovers',
  rankin20: 'Rankin et al., "Mars Curiosity Rover Mobility Trends During the First Seven Years" (JPL, 2020)',
  mpfPds: 'Mars Pathfinder Microrover Flight Experiment, system and operations overview (NASA PDS, 1996)',
  mpfJpl: 'JPL Robotics, Mars Pathfinder Rover: Sojourner',
  merJpl: 'JPL, Mars Exploration Rover mission pages (wheels, AutoNav)',
  merLeger: 'Leger et al., "Mars Exploration Rover Surface Operations: Driving Spirit at Gusev Crater" (JPL, 2005)',
  merSlope: 'JPL news, "Rover Takes on Steepest Slope Ever Tried on Mars" (31 Mar 2016)',
  merSand: 'JPL, "Slip Sliding Away on the Red Planet" (Mar 2004): MER test rover stalls on ~25° loose sand',
  merEnd: 'NASA, Opportunity mission complete (13 Feb 2019): Opportunity 45.16 km, Spirit 7.7 km',
  mslNasa: 'NASA/JPL Mars Science Laboratory: Curiosity rover pages',
  m2020Jpl: 'JPL Robotics, Mars 2020 rover mobility',
};

export const ROVERS = {
  sojourner: {
    name: 'Sojourner',
    mission: 'Mars Pathfinder',
    period: 'Landed 4 Jul 1997 · last contact 27 Sep 1997',
    status: 'Mission complete',
    specs: {
      mass: { text: '10.5–11.5 kg', src: [SRC.mpfJpl, SRC.rankin22] },
      size: { text: '65 × 48 × 30 cm', src: [SRC.mpfJpl] },
      wheels: { text: '6 wheels, 13–14 cm diameter, 7.9 cm wide; rocker-bogie, 4-wheel steering', src: [SRC.rankin22, SRC.mpfPds] },
      obstacles: { text: 'Drives over obstacles ~1.5 wheel diameters high (~20 cm)', src: [SRC.mpfPds] },
      speed: { text: 'Max 1 cm/s; ~0.4 m/min in normal terrain', src: [SRC.mpfPds] },
      navigation: { text: 'Simple hazard detection with laser stripes; commanded from Earth each sol; stayed close to the lander, its radio relay', src: [SRC.mpfJpl] },
      distance: { text: 'Planned to drive no more than ~10 m from the lander', src: ['NASA Mars Pathfinder rover description (1997)'] },
    },
    wheelCm: 13,
    model: {
      noGoDeg: 20, noGoWhy: 'no published slope limit found; set lower than the bigger rovers (assumption)',
      cautionDeg: 15,
      weights: { slope: 3, crater: 3, rough: 4, soft: 1, rocky: 2, storm: 1 },
      why: 'Tiny wheels clear only ~20 cm, so rough ground and crater rims count most. Its light weight makes sand less of a risk.',
      rangeKm: 0.1, rangeWhy: 'it had to stay near its lander, its radio relay (planned ≤ 10 m away)',
      pace: null,
    },
  },
  spirit: {
    name: 'Spirit',
    mission: 'Mars Exploration Rover A',
    period: 'Landed 4 Jan 2004 · last contact 22 Mar 2010 · ended 25 May 2011',
    status: 'Mission complete',
    specs: {
      mass: { text: '185 kg', src: [SRC.rankin22] },
      size: { text: '1.6 m long', src: [SRC.merLeger] },
      wheels: { text: '6 wheels, 26 cm diameter, 21.5 cm wide; rocker-bogie, 4-wheel steering', src: [SRC.rankin22, SRC.merJpl] },
      obstacles: { text: 'Over rocks or holes larger than a wheel diameter; 29 cm ground clearance', src: [SRC.merJpl, SRC.merLeger] },
      speed: { text: 'Max 5 cm/s; ~34 m/h average with AutoNav', src: [SRC.merJpl] },
      navigation: { text: 'AutoNav stereo hazard avoidance, visual odometry', src: [SRC.merJpl] },
      distance: { text: '7.7 km in total; stuck in soft sand in 2009', src: [SRC.merEnd] },
    },
    wheelCm: 26,
    model: {
      noGoDeg: 25, noGoWhy: 'its twin test rover stalled on ~25° loose sand (JPL)',
      cautionDeg: 15,
      weights: { slope: 3, crater: 2, rough: 3, soft: 3, rocky: 1, storm: 1 },
      why: 'Mid-size wheels (26 cm) and a history of getting stuck in sand: loose dust counts heavily, rough ground more than for the big rovers.',
      rangeKm: 7.7, rangeWhy: 'Spirit drove 7.7 km in six years',
      pace: { mPerSol: 7700 / 2208, text: 'Spirit\'s lifetime average (7.7 km in ~2,208 sols, incl. non-driving sols)' },
    },
  },
  opportunity: {
    name: 'Opportunity',
    mission: 'Mars Exploration Rover B',
    period: 'Landed 25 Jan 2004 · last contact 10 Jun 2018 · ended 13 Feb 2019',
    status: 'Mission complete',
    specs: {
      mass: { text: '185 kg', src: [SRC.rankin22] },
      size: { text: '1.6 m long', src: [SRC.merLeger] },
      wheels: { text: '6 wheels, 26 cm diameter, 21.5 cm wide; rocker-bogie, 4-wheel steering', src: [SRC.rankin22, SRC.merJpl] },
      obstacles: { text: 'Over rocks or holes larger than a wheel diameter; 29 cm ground clearance', src: [SRC.merJpl, SRC.merLeger] },
      speed: { text: 'Max 5 cm/s; ~34 m/h average with AutoNav', src: [SRC.merJpl] },
      navigation: { text: 'AutoNav stereo hazard avoidance, visual odometry', src: [SRC.merJpl] },
      distance: { text: '45.16 km: the record for driving on another world. Steepest tilt 32° (2016)', src: [SRC.merEnd, SRC.merSlope] },
    },
    wheelCm: 26,
    model: {
      noGoDeg: 25, noGoWhy: 'the same rover design stalled on ~25° loose sand; it tilted up to 32° on bedrock (JPL)',
      cautionDeg: 15,
      weights: { slope: 3, crater: 2, rough: 3, soft: 3, rocky: 1, storm: 1 },
      why: 'Same design as Spirit, so the same terrain rules. It differs in how far it has proven it can go.',
      rangeKm: 45.16, rangeWhy: 'Opportunity\'s record: 45.16 km in 14 years',
      pace: { mPerSol: 45160 / 5111, text: 'Opportunity\'s lifetime average (45.16 km in 5,111 sols, incl. non-driving sols)' },
    },
  },
  curiosity: {
    name: 'Curiosity',
    mission: 'Mars Science Laboratory',
    period: 'Landed 6 Aug 2012 · still operating',
    status: 'Active',
    specs: {
      mass: { text: '899 kg', src: [SRC.rankin22] },
      size: { text: '3.0 × 2.7 × 2.2 m', src: [SRC.mslNasa] },
      wheels: { text: '6 wheels, 50 cm diameter, 40 cm wide; rocker-bogie, 4-wheel steering', src: [SRC.rankin22] },
      obstacles: { text: 'Rolls over obstacles up to ~65 cm high', src: [SRC.mslNasa] },
      speed: { text: 'Max ~4 cm/s (up to 90 m/h)', src: [SRC.mslNasa] },
      navigation: { text: 'AutoNav and visual odometry; wheel-wear limits after sharp rocks punctured its thin wheels', src: [SRC.rankin20] },
      distance: { text: 'Nominal tilt limit 30°; steepest tilt in 7 years 25.3°; ~29 m per drive on average', src: [SRC.rankin20] },
    },
    wheelCm: 50,
    model: {
      noGoDeg: 25, noGoWhy: 'its steepest tilt in seven years was 25.3° (nominal limit 30°)',
      cautionDeg: 15,
      weights: { slope: 3, crater: 1.5, rough: 1.5, soft: 2, rocky: 2.5, storm: 0.5 },
      why: 'Big wheels clear ~65 cm, so rough ground and crater rims matter less. But sharp rocks damaged its thin wheels, so rocky ground counts heavily. Nuclear-powered: dust storms barely affect its power.',
      rangeKm: null,
      pace: { mPerSol: 29, text: 'Curiosity\'s average ~29 m per drive in its first 7 years (one drive per driving sol)' },
    },
  },
  perseverance: {
    name: 'Perseverance',
    mission: 'Mars 2020',
    period: 'Landed 18 Feb 2021 · still operating',
    status: 'Active',
    specs: {
      mass: { text: '1,025 kg', src: [SRC.rankin22] },
      size: { text: 'Based on the Curiosity design', src: [SRC.m2020Jpl] },
      wheels: { text: '6 wheels, 52.5 cm diameter, 33.6 cm wide, thicker aluminium skin; rocker-bogie', src: [SRC.rankin22] },
      obstacles: { text: 'Similar to Curiosity (same suspension design)', src: [SRC.m2020Jpl] },
      speed: { text: 'Max 4.2 cm/s (~150 m/h)', src: [SRC.m2020Jpl] },
      navigation: { text: 'Enhanced AutoNav: plans its path while driving ("thinking while driving")', src: [SRC.m2020Jpl] },
      distance: { text: 'Still driving; total not used here', src: [] },
    },
    wheelCm: 52.5,
    model: {
      noGoDeg: 25, noGoWhy: 'no published record found; same suspension design as Curiosity (assumption)',
      cautionDeg: 15,
      weights: { slope: 3, crater: 1.5, rough: 1.2, soft: 2, rocky: 1, storm: 0.5 },
      why: 'Curiosity-sized wheels with thicker skins, redesigned after Curiosity\'s wheel damage: rocky ground counts much less than for Curiosity. Nuclear-powered like Curiosity.',
      rangeKm: null,
      pace: null,
    },
  },
};

// ---- The Moon ------------------------------------------------------------------------

const MSRC = {
  lrvNssdc: 'NASA NSSDC, "The Apollo Lunar Roving Vehicle" (nssdc.gsfc.nasa.gov/planetary/lunar/apollo_lrv.html)',
  lrvHandbook: 'Boeing, "Lunar Roving Vehicle Operations Handbook" (NASA contract NAS8-25145, 1971)',
  alsj: 'Apollo Lunar Surface Journal (NASA): LRV traverse distances and driving times of Apollo 15, 16 and 17',
};

export const MOON_ROVERS = {
  lrv: {
    name: 'Apollo LRV',
    mission: 'Lunar Roving Vehicle · Apollo 15, 16, 17',
    period: 'Driven Jul 1971 – Dec 1972 · 3 rovers, all left on the Moon',
    status: 'Mission complete',
    specs: {
      mass: { text: '210 kg empty; carried up to 490 kg (two astronauts, tools, samples)', src: [MSRC.lrvNssdc] },
      size: { text: '3.1 m long, 2.3 m wheelbase, 1.14 m high', src: [MSRC.lrvNssdc] },
      wheels: { text: '4 wheels, 81.8 cm diameter, 23 cm wide; woven zinc-coated steel wire with titanium treads; 4-wheel steering', src: [MSRC.lrvNssdc] },
      obstacles: { text: 'Steps up to 30 cm, crevasses up to 70 cm wide; slopes up to 25°', src: [MSRC.lrvHandbook, MSRC.lrvNssdc] },
      speed: { text: 'About 13 km/h top speed (18 km/h downhill on Apollo 17)', src: [MSRC.lrvNssdc] },
      navigation: { text: 'Driven by the astronauts; a gyro and wheel odometers showed heading and the way back to the lunar module', src: [MSRC.lrvNssdc] },
      distance: { text: 'Apollo 15: 27.8 km · Apollo 16: 26.7 km · Apollo 17: 35.9 km in total', src: [MSRC.alsj] },
    },
    wheelCm: 81.8,
    model: {
      noGoDeg: 25, noGoWhy: 'its design slope limit',
      cautionDeg: 15,
      weights: { slope: 2.5, crater: 2, rough: 2, soft: 0.5, rocky: 1.5, storm: 0 },
      why: 'A fast, open car with two astronauts aboard: rough, blocky ground and crater rims count most (bouncing at speed). Its wire-mesh wheels coped well with the loose lunar soil. Apollo rules kept every drive within walking distance of the lunar module, in case the rover broke down.',
      rangeKm: 92, rangeWhy: 'its two batteries were sized for ~92 km in total',
      pace: { kmh: 8, text: '~8 km/h, the average Apollo 15–17 driving speed' },
    },
  },
};

// On foot. NASA xEVA spacesuit concept of operations (EVA-EXP-0042): walking on slopes up
// to 20°; Apollo walking traverses stayed under ~15°.
export const ASTRONAUT = {
  name: 'Astronaut on foot',
  model: {
    noGoDeg: 20, noGoWhy: 'NASA\'s xEVA spacesuit requirement: walking on slopes up to 20°',
    cautionDeg: 15,
    weights: { slope: 3, crater: 1.5, rough: 1.5, soft: 1, rocky: 0.5, storm: 1 },
    why: 'Walking: steep ground matters most (and on Mars, dust storms for visibility).',
    rangeKm: null,
  },
};

/** Any rover, Mars or Moon, by its key. */
export const roverOf = (key) => ROVERS[key] ?? MOON_ROVERS[key];
export const travellerModel = (key) => (key === 'walk' ? ASTRONAUT.model : roverOf(key).model);
export const travellerName = (key) => (key === 'walk' ? ASTRONAUT.name : roverOf(key).name);

// Small side-view silhouette, scaled by wheel diameter (the one size all five share a source for).
export function roverIcon(key, px = 48) {
  if (key === 'walk') {
    return `<svg viewBox="0 0 40 40" width="${px * 0.6}" height="${px * 0.6}" aria-hidden="true"><circle cx="20" cy="8" r="5" fill="currentColor"/><path d="M20 14v12M12 20h16M20 26l-6 11M20 26l6 11" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>`;
  }
  const r = roverOf(key);
  const s = Math.min(1.3, Math.max(0.28, r.wheelCm / 52.5)); // relative to Perseverance (the LRV capped)
  if (key === 'lrv') {
    // open car: two seats, a high-gain dish, 4 wire wheels
    return `<svg viewBox="0 0 50 32" width="${px * s}" height="${px * s * 0.64}" aria-hidden="true" fill="currentColor">
      <rect x="4" y="16" width="42" height="3" rx="1"/><rect x="15" y="9" width="3" height="7"/><rect x="25" y="9" width="3" height="7"/>
      <rect x="13" y="12" width="17" height="2"/><rect x="40" y="4" width="1.6" height="12"/><path d="M36 4 Q41 0 46 4 Z"/>
      <circle cx="11" cy="24" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="39" cy="24" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>`;
  }
  const big = r.wheelCm >= 50;
  const body = big
    ? '<rect x="8" y="10" width="34" height="9" rx="1.5"/><rect x="34" y="1" width="2.5" height="10"/><rect x="31" y="0" width="8" height="3.5" rx="1"/><rect x="5" y="12" width="5" height="5" rx="1"/>'
    : key === 'sojourner'
      ? '<rect x="9" y="12" width="32" height="6" rx="1"/><rect x="13" y="9" width="24" height="3"/>'
      : '<rect x="5" y="9" width="40" height="3" rx="1"/><rect x="12" y="12" width="26" height="6" rx="1"/><rect x="33" y="2" width="2" height="8"/><rect x="30" y="1" width="7" height="2.5" rx="1"/>';
  return `<svg viewBox="0 0 50 32" width="${px * s}" height="${px * s * 0.64}" aria-hidden="true" fill="currentColor">${body}
    <path d="M12 19 L18 24 L25 19 L32 24 L38 19" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <circle cx="12" cy="26" r="4.5"/><circle cx="25" cy="26" r="4.5"/><circle cx="38" cy="26" r="4.5"/></svg>`;
}
