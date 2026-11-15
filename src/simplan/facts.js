// Fixed facts about the Moon, Mars and Earth used by Simulation Planning, each with its source.
// Values that depend on the place (temperatures, terrain, rain, sunlight ...) come from the
// app's own data (the Moon/Mars maps and the Earth search grid), not from here.

export const SOURCES = {
  marsFact: { label: 'NASA Mars Fact Sheet', url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html' },
  moonFact: { label: 'NASA Moon Fact Sheet', url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html' },
  earthFact: { label: 'NASA Earth Fact Sheet', url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html' },
  hassler: { label: 'Hassler et al. 2014, Science: radiation on the surface of Mars measured by Curiosity (RAD)', url: 'https://doi.org/10.1126/science.1244797' },
  zhang: { label: 'Zhang et al. 2020, Science Advances: first radiation dose measured on the lunar surface (Chang’e 4)', url: 'https://doi.org/10.1126/sciadv.aaz1334' },
  unscear: { label: 'UNSCEAR 2008 report: world average natural radiation dose 2.4 mSv a year', url: 'https://www.unscear.org/unscear/en/publications/2008_1.html' },
  cockell: { label: 'Cockell et al. 2000, Icarus: the ultraviolet environment of Mars', url: 'https://doi.org/10.1006/icar.2000.6393' },
};

// g in m/s²; pressure in hPa (mbar); dose in mSv a day; solar = sunlight above the atmosphere, W/m²
export const WORLD = {
  earth: { g: 9.81, pressureHpa: 1013.25, scaleHeightKm: 8.5, air: '78% nitrogen, 21% oxygen', doseDay: 2.4 / 365,
    solar: 1361, day: '24 h' },
  moon: { name: 'Moon', g: 1.62, pressureHpa: 3e-12, pressureText: '~3×10⁻¹² hPa (vacuum)', air: 'none (vacuum)',
    doseDay: 1.369, solar: 1361, day: '29.5 Earth days (~2 weeks of sunlight, ~2 weeks of night)',
    sources: ['moonFact', 'zhang'] },
  mars: { name: 'Mars', g: 3.71, pressureHpa: 6.36, pressureText: '~6 hPa (0.6% of Earth’s)', air: '95% CO₂, 2.6% nitrogen, 1.9% argon',
    doseDay: 0.64, solar: 586, day: '24 h 40 min', sources: ['marsFact', 'hassler'] },
};

/** Air pressure at an altitude on Earth (hPa), from the barometric formula with an 8.5 km scale height. */
export const earthPressureAt = (altKm) => WORLD.earth.pressureHpa * Math.exp(-Math.max(0, altKm) / WORLD.earth.scaleHeightKm);
