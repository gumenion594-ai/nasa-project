"""
More characteristics for the Earth analog search: adds (or replaces) these fields in
public/search/earth.bin + earth.json, for the same land cells tools/build_search_grid.py made.

  sun     sunlight reaching the ground, yearly average, W/m2 (NASA POWER ALLSKY_SFC_SW_DWN,
          from CERES; the same quantity as the Moon and Mars sunlight maps)
  tmean   yearly mean ground-surface ("skin") temperature, C (NASA POWER TS). Below 0 C the
          ground stays frozen at depth: a standard indicator of permafrost.
  bare    share of the cell's land classed "Barren" (rock, sand or soil, under 10% vegetation)
          by MODIS land cover (MCD12Q1, IGBP class 16), 2023
  dust    log10 of dust in the air near the ground, ug/m3, 2014-2023 average (NASA MERRA-2)

Inputs: tools/fetch_power.py with PARAMS = ['TS', 'ALLSKY_SFC_SW_DWN'] (data/raw/power/) and
tools/fetch_gibs.py (data/raw/gibs/).

Run:  python tools/build_search_extra.py
"""
import glob
import json
import os
import re

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'public', 'search')
SCALES = dict(sun=0.01, tmean=0.01, bare=1 / 30000, dust=0.001)
RES = 0.5


def colormap(path):
    """GIBS colour map -> list of (rgb, attributes)."""
    out = []
    for m in re.finditer(r'<ColorMapEntry ([^>]*)/>', open(path, encoding='utf-8').read()):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        out.append((tuple(int(v) for v in attrs['rgb'].split(',')), attrs))
    return out


def rgb_key(a):
    return (a[..., 0].astype(np.int32) << 16) | (a[..., 1].astype(np.int32) << 8) | a[..., 2]


def fill_nearest(grid):
    """Fill NaN cells from the nearest cell with a value."""
    bad = ~np.isfinite(grid)
    if not bad.any():
        return grid
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return grid[tuple(idx)]


def bare_grid():
    """Share of land pixels classed Barren, per 0.5 deg cell (360 x 720)."""
    cm = colormap(os.path.join(RAW, 'gibs', 'landcover.xml'))
    cls = {}
    for rgb, a in cm:
        if a.get('nodata') == 'true':
            continue
        cls[(rgb[0] << 16) | (rgb[1] << 8) | rgb[2]] = a['sourceValue']
    barren = [k for k, v in cls.items() if v == '16']
    water = [k for k, v in cls.items() if v in ('0,17',)]
    px = 20                                   # 0.025 deg pixels per 0.5 deg cell
    bare = np.zeros((360, 720))
    land = np.zeros((360, 720))
    for f in glob.glob(os.path.join(RAW, 'gibs', 'landcover', '*.png')):
        lat0, lon0 = map(int, os.path.basename(f)[:-4].split('_'))
        a = np.array(Image.open(f).convert('RGBA'))
        k = rgb_key(a)
        is_land = (a[..., 3] > 0) & ~np.isin(k, water) & np.isin(k, list(cls))
        is_bare = is_land & np.isin(k, barren)
        n = a.shape[0] // px
        r0 = int((90 - (lat0 + 45)) / RES)     # tile's top row in the 0.5 deg grid
        c0 = int((lon0 + 180) / RES)
        bare[r0:r0 + n, c0:c0 + n] = is_bare.reshape(n, px, n, px).sum(axis=(1, 3))
        land[r0:r0 + n, c0:c0 + n] = is_land.reshape(n, px, n, px).sum(axis=(1, 3))
    with np.errstate(invalid='ignore', divide='ignore'):
        share = np.where(land > 0, bare / land, np.nan)
    return fill_nearest(share)


def dust_grid():
    """log10 of the 2014-2023 mean dust surface concentration (ug/m3), per 0.5 deg cell."""
    cm = colormap(os.path.join(RAW, 'gibs', 'dust.xml'))
    lut = {}
    for rgb, a in cm:
        if a.get('nodata') == 'true' or 'value' not in a:
            continue
        lo, hi = re.match(r'\[([^,]+),([^)]+)\)', a['value']).groups()
        lo = 0.0 if lo == '-INF' else float(lo)
        hi = 2 * lo if hi == '+INF' else float(hi)
        lut[(rgb[0] << 16) | (rgb[1] << 8) | rgb[2]] = (lo + hi) / 2   # middle of the colour's bin
    files = sorted(glob.glob(os.path.join(RAW, 'gibs', 'dust', '*.png')))
    total = None
    for f in files:
        a = np.array(Image.open(f).convert('RGBA'))
        k = rgb_key(a)
        v = np.full(k.shape, np.nan)
        for key, val in lut.items():
            v[k == key] = val
        total = v if total is None else total + v
    mean = total / len(files)                                   # kg/m3, 576 x 1152 (0.3125 deg)
    h, w = mean.shape
    rows = ((np.arange(360) + 0.5) * RES / 180 * h).astype(int)  # nearest pixel to each cell centre
    cols = ((np.arange(720) + 0.5) * RES / 360 * w).astype(int)
    g = fill_nearest(mean[np.ix_(rows, cols)])
    return np.log10(np.maximum(g * 1e9, 0.01))                  # ug/m3


def power_points(param):
    """NASA POWER climatology: yearly ('ANN') value at each point -> (lat, lon), values."""
    files = glob.glob(os.path.join(RAW, 'power', param, '*.json'))
    if len(files) < 648:
        raise SystemExit(f'{param}: only {len(files)}/648 boxes - run tools/fetch_power.py with this parameter')
    pts = {}
    for f in files:
        with open(f) as fh:
            for feat in json.load(fh)['features']:
                lon, lat = feat['geometry']['coordinates'][:2]
                v = feat['properties']['parameter'][param]['ANN']
                if v is not None and v > -900:
                    pts[(round(lat, 4), round(lon, 4))] = v
    ll = np.array(list(pts))
    return ll, np.array(list(pts.values()))


def power_grid(param):
    """POWER yearly value at every 0.5 deg cell centre (nearest POWER point, 0.5 x 0.625 grid)."""
    ll, v = power_points(param)
    lat = 90 - (np.arange(360) + 0.5) * RES
    lon = -180 + (np.arange(720) + 0.5) * RES
    glat, glon = np.meshgrid(lat, lon, indexing='ij')

    def xyz(la, lo):
        la, lo = np.radians(la), np.radians(lo)
        return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)
    _, i = cKDTree(xyz(ll[:, 0], ll[:, 1])).query(xyz(glat.ravel(), glon.ravel()))
    return v[i].reshape(360, 720)


def main():
    meta = json.load(open(os.path.join(OUT, 'earth.json')))
    n = meta['cells']
    buf = open(os.path.join(OUT, 'earth.bin'), 'rb').read()
    idx = np.frombuffer(buf, np.uint32, n)
    cols = {f: np.frombuffer(buf, np.int16, n, n * 4 + i * n * 2) for i, f in enumerate(meta['fields'])}

    grids = {}
    print('sunlight');      grids['sun'] = power_grid('ALLSKY_SFC_SW_DWN') * 1000 / 24   # kWh/m2/day -> W/m2
    print('mean ground temperature'); grids['tmean'] = power_grid('TS')
    print('bare ground');   grids['bare'] = bare_grid()
    print('dust');          grids['dust'] = dust_grid()
    for k, g in grids.items():
        v = g.ravel()[idx]
        assert np.isfinite(v).all(), k
        cols[k] = np.round(v / SCALES[k]).clip(-32767, 32767).astype(np.int16)
        meta['scales'][k] = SCALES[k]
        if k not in meta['fields']:
            meta['fields'].append(k)
        print(f'  {k:6s} p1/50/99 {np.percentile(v, [1, 50, 99]).round(3)}')
    with open(os.path.join(OUT, 'earth.bin'), 'wb') as f:
        f.write(idx.tobytes())
        for k in meta['fields']:
            f.write(cols[k].tobytes())
    meta['about'] = ('Land-area-weighted means per 0.5 degree cell; see tools/build_search_grid.py and '
                     'tools/build_search_extra.py (sun, tmean, bare, dust)')
    json.dump(meta, open(os.path.join(OUT, 'earth.json'), 'w'), indent=1)
    print(f'{n} cells, fields: {meta["fields"]}')


if __name__ == '__main__':
    main()
