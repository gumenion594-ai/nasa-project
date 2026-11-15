// Map settings for each body. radiusKm is the body's mean radius, used to
// work out how many km the screen shows. To add another planet, add an entry
// here and a matching button in index.html.
//
// Each body has one or more image layers, drawn bottom to top:
//   maxNativeZoom - deepest zoom level the server really has; beyond it the
//                   last level is enlarged
//   tileSize / zoomOffset - for servers using 512px tiles
//   minZoom       - layer only appears once you zoom in this far
//   bounds        - limit a layer to part of the globe [[south, west], [north, east]]
//   filter        - CSS filter, e.g. to tint or brighten a layer
const TREK = 'https://trek.nasa.gov/tiles';
const trek = (path, ext) => `${TREK}/${path}/1.0.0/default/default028mm/{z}/{y}/{x}.${ext}`;
// Bundled whole-world layer under the NASA Trek imagery (tools/build_fallback_basemap.py): it
// always loads, so a slow or missing Trek tile shows the shaded relief instead of a black square.
const fallback = (body, attribution) => ({
  url: `${import.meta.env.BASE_URL}basemap/${body}/{z}/{y}/{x}.jpg`,
  attribution,
  maxNativeZoom: 2, // ~5 km (Moon) / ~10 km (Mars) per pixel; enlarged beyond
});

export const BODIES = {
  earth: {
    name: 'Earth',
    selectable: true, // select an area (no analog search from Earth)
    crs: 'EPSG3857', // standard web map projection
    radiusKm: 6371.0,
    layers: [{
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
      maxNativeZoom: 18, // sub-metre in many places
    }],
  },
  moon: {
    name: 'Moon',
    selectable: true, // click to pick a 10 km area
    crs: 'EPSG4326', // NASA Trek tiles are equirectangular
    radiusKm: 1737.4,
    layers: [
      fallback('moon', 'Relief: NASA LRO LOLA'),
      { // backup underneath, in case the sharper mosaic has a gap
        url: trek('Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02', 'jpg'),
        attribution: 'LRO WAC &copy; NASA/GSFC/ASU',
        maxNativeZoom: 7, // ~100 m per pixel
      },
      {
        url: trek('Moon/EQ/Kaguya_TCortho_Mosaic_Global_4096ppd', 'png'),
        attribution: 'Kaguya TC mosaic &copy; JAXA/SELENE, via NASA Moon Trek',
        maxNativeZoom: 10, // ~21 m per pixel
        minZoom: 6, // zoomed out, the clean WAC map looks better
        bounds: [[-70, -180], [70, 180]], // this mosaic is garbled near the poles
        filter: 'brightness(1.4) contrast(1.3)', // it's quite dark as delivered
      },
    ],
  },
  mars: {
    name: 'Mars',
    selectable: true,
    crs: 'EPSG4326',
    radiusKm: 3389.5,
    layers: [
      fallback('mars', 'Relief: NASA MGS MOLA'),
      { // colour of the whole planet
        url: trek('Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m', 'jpg'),
        attribution: 'Viking MDIM 2.1 &copy; NASA/JPL/USGS',
        maxNativeZoom: 7, // ~232 m per pixel
      },
      { // fine detail from the black-and-white CTX camera, tinted Mars-coloured
        url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}',
        attribution: 'CTX mosaic &copy; NASA/JPL/MSSS/Caltech Murray Lab/Esri',
        tileSize: 512,
        zoomOffset: -1,
        maxNativeZoom: 13, // server level 12, ~5 m per pixel
        minZoom: 7, // takes over where the Viking colour map runs out of detail
        filter: 'sepia(1) saturate(1.4) hue-rotate(-30deg) brightness(0.72) contrast(1.2)',
      },
    ],
  },
};
