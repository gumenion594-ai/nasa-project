"""
Download two NASA Earth data sets from NASA GIBS (the imagery service behind NASA Worldview),
as images whose colours are decoded back into values with GIBS's published colour maps.
No login needed. Cached in data/raw/gibs/, so the script can be re-run to resume.

  MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual (MCD12Q1, Terra + Aqua), year 2023:
      land cover class of every 0.025 deg pixel (~2.8 km; the product itself is 500 m, so this
      is a sample of it). Used for "Bare ground": IGBP class 16 "Barren" = rock, sand or soil
      with less than 10% vegetation.
  MERRA2_Dust_Surface_Mass_Concentration_Monthly (NASA GMAO MERRA-2 reanalysis), 2014-2023:
      dust in the air near the ground, kg/m3, monthly means on MERRA-2's 0.5 x 0.625 deg grid.
      Used for "Dust".

Run:  python tools/fetch_gibs.py
"""
import concurrent.futures as cf
import os
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'raw', 'gibs')
WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
COLORMAPS = {
    'landcover.xml': 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_IGBP_Land_Cover_Type.xml',
    'dust.xml': 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/MERRA2_Dust_Surface_Mass_Concentration_Monthly.xml',
}
LANDCOVER_YEAR = 2023
LANDCOVER_TILE_DEG = 45          # 8 x 4 tiles of 1800 x 1800 px = 0.025 deg per pixel
LANDCOVER_TILE_PX = 1800
DUST_YEARS = range(2014, 2024)


def get(url, path):
    if os.path.exists(path):
        return
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'planet-maps-data-build'})
            data = urllib.request.urlopen(req, timeout=180).read()
            if not data.startswith(b'\x89PNG') and not path.endswith('.xml'):
                raise ValueError(data[:200])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + '.tmp', 'wb') as f:
                f.write(data)
            os.replace(path + '.tmp', path)
            return
        except Exception as e:  # network hiccup or busy server: wait and retry
            last = e
            time.sleep(2 ** attempt)
    print(f'FAILED {url}: {last}')


def wms(layer, time_, bbox, w, h):
    s, wl, n, e = bbox  # WMS 1.3.0 EPSG:4326 axis order: lat, lon
    return (f'{WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS={layer}&STYLES=&FORMAT=image/png'
            f'&CRS=EPSG:4326&BBOX={s},{wl},{n},{e}&WIDTH={w}&HEIGHT={h}&TIME={time_}')


def jobs():
    for name, url in COLORMAPS.items():
        yield url, os.path.join(OUT, name)
    for lat0 in range(-90, 90, LANDCOVER_TILE_DEG):
        for lon0 in range(-180, 180, LANDCOVER_TILE_DEG):
            bbox = (lat0, lon0, lat0 + LANDCOVER_TILE_DEG, lon0 + LANDCOVER_TILE_DEG)
            yield (wms('MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual', f'{LANDCOVER_YEAR}-01-01', bbox,
                       LANDCOVER_TILE_PX, LANDCOVER_TILE_PX),
                   os.path.join(OUT, 'landcover', f'{lat0}_{lon0}.png'))
    for y in DUST_YEARS:
        for m in range(1, 13):
            yield (wms('MERRA2_Dust_Surface_Mass_Concentration_Monthly', f'{y}-{m:02d}-01', (-90, -180, 90, 180), 1152, 576),
                   os.path.join(OUT, 'dust', f'{y}-{m:02d}.png'))


def main():
    todo = list(jobs())
    with cf.ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda j: get(*j), todo))
    print(f'done: {len(todo)} files in {OUT}')


if __name__ == '__main__':
    main()
