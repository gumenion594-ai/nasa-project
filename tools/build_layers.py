"""
Build the map "views" (coloured data overlays) for the Moon and Mars from
NASA / PDS data, as 8-bit data tiles the web app colours in the browser.

  Layer        Moon                                   Mars
  elevation    LRO LOLA LDEM 64 ppd -> 16 ppd         MGS MOLA MEGDR 32 ppd
  slope        (from the same elevation grids, both ~1.9 km per pixel)
  iron         Lunar Prospector GRS FeO, 2 deg        Odyssey GRS Fe (as FeO), 5 deg
  temperature  LRO Diviner global cumulative Tbol     thermal model from TES albedo + TI + MOLA
  temp_range   LRO Diviner (daily max - min)          thermal model (tools/mars_thermal.py)
  temp_yearly  (Moon: same as daily, 1.5 deg tilt)    thermal model: hottest - coldest of the year
  ice          (no global map product found)          Odyssey averaged neutron data, frost-free seasons, 5 deg
  surface      LRO Diviner rock abundance, 32 ppd     MGS TES night thermal inertia, 20 ppd

Output (served from public/overlays/):
  {body}/{layer}/{z}/{y}/{x}.webp   1..255 = position between enc_min and enc_max (linear or log)
  index.json                        scale, units and description of every layer

Run:  python3 tools/build_layers.py               all layers (downloads ~3.6 GB into data/raw/)
      python3 tools/build_layers.py mars iron     only layers matching any of the words
      python3 tools/build_layers.py earth/slope   one body/layer pair
Needs numpy, scipy, pandas and Pillow.
"""
import glob
import json
import math
import os
import re
import sys
import urllib.request

import numpy as np
import pandas as pd
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'public', 'overlays')
PDS = 'https://pds-geosciences.wustl.edu'
TILE_FORMAT = 'webp'  # lossy WebP q90: half the size of PNG, error ~0.5% of the scale
FEO_PER_FE = 71.844 / 55.845  # convert Fe weight % to FeO weight %

RADIUS_KM = {'moon': 1737.4, 'mars': 3396.19, 'earth': 6371.0}


def fetch(url, sub=''):
    """Path of a downloaded source file, downloading it first if needed."""
    folder = os.path.join(RAW, sub)
    path = os.path.join(folder, os.path.basename(url))
    if not os.path.exists(path):
        os.makedirs(folder, exist_ok=True)
        print(f'  downloading {url}')
        urllib.request.urlretrieve(url, path)
    return path


def pixel_km(body, ppd):
    return 2 * math.pi * RADIUS_KM[body] / (360 * ppd)


# ---- Elevation and slope ----------------------------------------------------

DEMS = {
    'mars': dict(url=f'{PDS}/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg032/megt90n000fb.img',
                 shape=(5760, 11520), dtype='>i2', scale=1.0, ppd=32, factor=1),
    'moon': dict(url=f'{PDS}/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img',
                 shape=(11520, 23040), dtype='<i2', scale=0.5, ppd=64, factor=4),
}


def load_dem(body):
    """Elevation (m), rows 90N -> 90S, columns 180W -> 180E, ~1.9 km per pixel on both bodies."""
    d = DEMS[body]
    dem = np.memmap(fetch(d['url']), dtype=d['dtype'], mode='r', shape=d['shape'])
    f = d['factor']
    if f > 1:  # block-average to a coarser grid
        h, w = d['shape']
        dem = np.asarray(dem, dtype=np.float32).reshape(h // f, f, w // f, f).mean(axis=(1, 3))
    dem = np.asarray(dem, dtype=np.float32) * d['scale']
    return np.roll(dem, dem.shape[1] // 2, axis=1), d['ppd'] // f  # 0..360E -> -180..180


def slope_deg(dem, ppd, radius_km):
    pixel_m = 2 * math.pi * radius_km * 1000 / (360 * ppd)
    lat = 90 - (np.arange(dem.shape[0]) + 0.5) / ppd
    dx_m = pixel_m * np.maximum(np.cos(np.radians(lat)), 0.02)[:, None]
    dzdx = (np.roll(dem, -1, axis=1) - np.roll(dem, 1, axis=1)) / (2 * dx_m)
    dzdy = np.gradient(dem, pixel_m, axis=0)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


RELIEF_BLOCK = 5  # DEM pixels (~1.9 km) per side of a relief block: ~9.3 km on all three bodies


def relief_blocks(dem_m, mask=None, f=RELIEF_BLOCK):
    """Local relief: standard deviation of elevation (km) inside f x f pixel blocks.
    With a mask (True = use), blocks less than half covered are NaN."""
    h, w = dem_m.shape
    d = np.asarray(dem_m, dtype=np.float64)[:h - h % f, :w - w % f] / 1000
    m = np.ones_like(d) if mask is None else np.asarray(mask[:h - h % f, :w - w % f], dtype=np.float64)
    d = np.where(m > 0, d, 0)
    shape = (d.shape[0] // f, f, d.shape[1] // f, f)
    n = m.reshape(shape).sum(axis=(1, 3))
    with np.errstate(invalid='ignore', divide='ignore'):
        mean = (d * m).reshape(shape).sum(axis=(1, 3)) / n
        var = (d * d * m).reshape(shape).sum(axis=(1, 3)) / n - mean ** 2
    out = np.sqrt(np.maximum(var, 0)).astype(np.float32)
    out[n < f * f / 2] = np.nan
    return out


# ---- Gridding helpers ---------------------------------------------------------

def grid_from_cells(lat_lo, lat_hi, lon_lo, lon_hi, values, res_deg):
    """Paint lat/lon boxes (any size) onto a global grid of res_deg cells. NaN = no data."""
    h, w = int(180 / res_deg), int(360 / res_deg)
    g = np.full((h, w), np.nan, dtype=np.float32)
    for a, b, c, d, v in zip(lat_lo, lat_hi, lon_lo, lon_hi, values):
        r0, r1 = int(round((90 - b) / res_deg)), int(round((90 - a) / res_deg))
        c0, c1 = int(round((c + 180) / res_deg)), int(round((d + 180) / res_deg))
        g[r0:r1, c0:c1] = v
    return g


def smooth_fill(grid, sigma_px):
    """Gaussian smoothing that ignores gaps (a weighted average of the nearby data), so
    coarse cells become a smooth map and small holes get filled from their neighbours."""
    valid = np.isfinite(grid)
    modes = ('nearest', 'wrap')  # don't wrap over the poles; do wrap around in longitude
    num = ndimage.gaussian_filter(np.where(valid, grid, 0).astype(np.float64), sigma_px, mode=modes)
    den = ndimage.gaussian_filter(valid.astype(np.float64), sigma_px, mode=modes)
    return np.where(den > 0.05, num / np.maximum(den, 1e-9), np.nan).astype(np.float32)


def fill_holes(grid, sigma_px=1.5):
    """Fill only the missing cells, from their neighbours; keep measured cells as they are."""
    return np.where(np.isfinite(grid), grid, smooth_fill(grid, sigma_px))


def destripe(grid, across=15, along=151, log=True, smooth=None):
    """Remove orbit-track stripes (thin north-south lines). Take what differs from the
    east-west neighbourhood, keep only the part that stays consistent over a long
    north-south stretch (that's the stripe, not a crater or dune field), subtract it."""
    valid = np.isfinite(grid)
    v = np.log10(np.maximum(fill_holes(grid, 3), 1e-6)) if log else fill_holes(grid, 3)
    v = np.where(np.isfinite(v), v, np.nanmedian(v))
    base = ndimage.median_filter(v, size=(1, across), mode='wrap')
    stripes = ndimage.uniform_filter1d(v - base, along, axis=0, mode='nearest')
    out = v - stripes
    if smooth:  # (north-south, east-west) gaussian sigma in pixels, stronger across the stripes
        out = ndimage.gaussian_filter(out, smooth, mode=('nearest', 'wrap'))
    out = 10 ** out if log else out
    return np.where(valid, out, np.nan).astype(np.float32)


# ---- Layers -----------------------------------------------------------------

def moon_iron():
    path = fetch(f'{PDS}/lunar/lp-l-grs-5-elem-abundance-v1/lp_9001/data/lpgrs_high1_elem_abundance_2deg.tab')
    t = np.loadtxt(path, usecols=(1, 2, 3, 4, 12))  # min/max lat, min/max lon, W_FEO (g/g)
    cells = grid_from_cells(t[:, 0], t[:, 1], t[:, 2], t[:, 3], t[:, 4] * 100, 0.5)
    return smooth_fill(cells, 2), 2.0  # smooth the 2-degree cells at ~1 degree


def mars_grs(name):
    """Odyssey GRS 5x5 deg table -> grid. 9999.999 = no data."""
    t = np.loadtxt(fetch(f'{PDS}/ody/ody-m-grs-5-elements-v1/odgm_xxxx/data/smoothed/{name}_sr_5x5.tab'))
    ok = t[:, 2] < 9000
    lat, lon, v = t[ok, 0], t[ok, 1], t[ok, 2]
    lon = np.where(lon > 180, lon - 360, lon)
    cells = grid_from_cells(lat - 2.5, lat + 2.5, lon - 2.5, lon + 2.5, v, 0.5)
    return smooth_fill(cells, 5)  # smooth the 5-degree cells at ~2.5 degrees


def mars_iron():
    return mars_grs('fe') * FEO_PER_FE, 5.0


def mars_ice():
    """Water-equivalent hydrogen in the top ~1 m, from Mars Odyssey's averaged neutron data
    (5 x 5 deg maps for every 15 deg of season, ~12 Mars years). Hydrogen slows neutrons,
    so fewer epithermal neutrons escape where there is ice.

    Seasonal CO2 frost (up to ~1 m in winter) hides the ice beneath it, so poleward of 45 deg
    only that hemisphere's frost-free summer is used (north Ls 105-165, south Ls 285-345);
    nearer the equator all seasons are averaged. Shown as % fewer neutrons than over the
    driest 5% of Mars."""
    base = f'{PDS}/ody/ody-m-grs-5-and-v2/odgn2_xxxx'
    inv = urllib.request.urlopen(f'{base}/collection_data_science_averaged_inventory.csv').read().decode()
    names = sorted(set(re.findall(r'and_\d{2}_\d{3}_\d{3}', inv)))
    dt = np.dtype([(n, '>f4') for n in ('lat', 'lon', 'ctherm', 'ntherm', 'stherm',
                                        'cepi', 'nepi', 'sepi', 'cfast', 'nfast', 'sfast')])
    total = np.zeros(2592)
    weight = np.zeros(2592)
    lat = lon = None
    for name in names:
        yr, ls0, ls1 = name.split('_')[1:]
        path = fetch(f'{base}/yr{yr}/yr{yr}_ls{ls0}_{ls1}/{name}.dat', 'ody_and')
        t = np.fromfile(path, dtype=dt)
        lat, lon = t['lat'].astype(float), t['lon'].astype(float)
        ls = (int(ls0) + int(ls1)) / 2
        use = np.where(lat >= 45, (ls >= 105) & (ls <= 165),
                       np.where(lat <= -45, (ls >= 285) & (ls <= 345), True))
        good = use & np.isfinite(t['cepi']) & (t['cepi'] > 0) & (t['nepi'] > 0)
        total += np.where(good, t['nepi'] * t['cepi'], 0)  # (0 * NaN would still be NaN)
        weight += np.where(good, t['nepi'], 0)
    cepi = np.where(weight > 0, total / np.maximum(weight, 1e-9), np.nan)
    dry = np.nanpercentile(cepi, 95)
    suppression = np.clip((1 - cepi / dry) * 100, 0, None)
    lon = np.where(lon > 180, lon - 360, lon)
    ok = np.isfinite(suppression)
    cells = grid_from_cells(lat[ok] - 2.5, lat[ok] + 2.5, lon[ok] - 2.5, lon[ok] + 2.5, suppression[ok], 0.5)
    return smooth_fill(cells, 5), 5.0  # smooth the 5-degree cells at ~2.5 degrees


def mars_surface():
    """TES nightside thermal inertia, 20 ppd. Low = dust, high = rock/bedrock."""
    base = f'{PDS}/mgs/mgs-m-tes-5-timap-v1/mgst_9001/data/global_ti_night_2007'
    fetch(base + '.lbl')
    ti = np.fromfile(fetch(base + '.img'), dtype='>i2').reshape(3600, 7200).astype(np.float32)
    ti[ti <= 0] = np.nan
    return destripe(ti, across=15, along=121, smooth=(0.8, 2)), 1 / 20


def moon_surface():
    """Thermal inertia, as for Mars: from Diviner's midnight temperatures with a thermal model
    (tools/moon_thermal_inertia.py), 32 ppd, 70S-70N. Low = fine dust, high = rocks."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import moon_thermal_inertia
    if not os.path.exists(os.path.join(RAW, 'diviner_tbol_midnight_32.npy')):
        raise SystemExit('run tools/fetch_diviner_night.py first')
    return moon_thermal_inertia.moon_thermal_inertia(RAW), 1 / 32


def moon_rock_abundance():
    """(No longer shown.) Diviner rock abundance (fraction of surface covered by rocks > ~1 m),
    32 ppd, 60S-60N."""
    base = f'{PDS}/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gdr_l3/cylindrical/img/dgdr_ra_avg_cyl_032_img'
    fetch(base + '.lbl')
    ra = np.fromfile(fetch(base + '.img'), dtype='<i2').reshape(3840, 11520).astype(np.float32)
    ra[ra == -32768] = np.nan
    ra = np.roll(ra * 0.001 * 100, 11520 // 2, axis=1)  # -> %, 0..360E -> -180..180
    g = np.full((5760, 11520), np.nan, dtype=np.float32)
    ra[ra <= 0] = np.nan  # log scale: treat 0 as no measurement
    # This product is speckly and striped at full detail; rocky craters are 5-50 km
    # across, so destripe and smooth at ~2-4 km (more across the stripes than along).
    g[960:960 + 3840] = destripe(ra, across=21, along=121, smooth=(2, 4))  # rows for 60N..60S
    return g, 0.1  # effective detail after smoothing: ~3 km


DIVINER_BANDS = ['90s80s', '80s70s', '70s60s', '60s50s', '50s40s', '40s30s', '30s20s', '20s10s', '10s00s',
                 '00n10n', '10n20n', '20n30n', '30n40n', '40n50n', '50n60n', '60n70n', '70n80n', '80n90n']


def moon_temperatures():
    """Diviner Global Cumulative Products: bolometric surface temperature for every
    0.5 deg cell and every 0.25 h of local time. Returns (mean, daily max - min, daily max,
    daily min) in C (or K for the difference). The Moon has no real seasons (1.5 deg tilt),
    so the daily max/min stand for Earth's 'hottest month max' / 'coldest month min'."""
    base = f'{PDS}/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gcp/global_cumul_avg_cyl_{{}}_002.tab'
    mean = np.full((360, 720), np.nan, dtype=np.float32)
    rng = np.full((360, 720), np.nan, dtype=np.float32)
    tmax = np.full((360, 720), np.nan, dtype=np.float32)
    tmin = np.full((360, 720), np.nan, dtype=np.float32)
    for band in DIVINER_BANDS:
        path = fetch(base.format(band), 'diviner_gcp')
        df = pd.read_csv(path, skipinitialspace=True, usecols=['clon', 'clat', 'ltim', 'tbol'])
        t = df['tbol'].to_numpy(np.float32)
        t[t < 0] = np.nan
        # rows are ordered longitude, latitude, local time -> (lat, lon, 96 time bins)
        nlat = df['clat'].nunique()
        cube = t.reshape(720, nlat, 96).transpose(1, 0, 2).copy()
        lats = df['clat'].to_numpy()[:nlat * 96:96]
        assert np.allclose(df['clon'].to_numpy()[::nlat * 96], np.arange(-179.75, 180, 0.5))
        # Each spot is seen at ~55-65% of the 96 times of day, with short gaps spread
        # through the day. Fill gaps of up to 2 h by circular interpolation; spots with
        # a longer gap (could miss the hottest or coldest time) are left out.
        filled = cube
        ok = np.zeros(cube.shape[:2], dtype=bool)
        x = np.arange(96)
        for i in range(cube.shape[0]):
            for j in range(720):
                row = filled[i, j]
                good = np.isfinite(row)
                if good.sum() < 24:
                    continue
                if not good.all():
                    gx = x[good]
                    gaps = np.diff(np.r_[gx, gx[0] + 96]) - 1  # missing bins between readings
                    if gaps.max() > 8:
                        continue
                    row[~good] = np.interp(x[~good], np.r_[gx - 96, gx, gx + 96], np.tile(row[good], 3))
                ok[i, j] = True
        rows = np.round((90 - lats - 0.25) / 0.5).astype(int)
        mean[rows] = np.where(ok, np.nanmean(filled, axis=2) - 273.15, np.nan)
        rng[rows] = np.where(ok, np.nanmax(filled, axis=2) - np.nanmin(filled, axis=2), np.nan)
        tmax[rows] = np.where(ok, np.nanmax(filled, axis=2) - 273.15, np.nan)
        tmin[rows] = np.where(ok, np.nanmin(filled, axis=2) - 273.15, np.nan)
        print(f'  diviner {band}: {ok.mean():.0%} of cells usable')
    # a few spots never got enough readings: fill them from their neighbours
    return fill_holes(mean), fill_holes(rng), fill_holes(tmax), fill_holes(tmin)



# ---- Earth ------------------------------------------------------------------
# Elevation/slope: NOAA ETOPO 2022, 60 arc-seconds (~1.9 km, the same scale as the
# Moon/Mars slope maps). Climate: NASA POWER long-term monthly averages (0.5 x 0.625 deg),
# ground-surface ("skin") temperatures so they compare with the Moon/Mars surface maps.
# Earth's map uses Web Mercator, so its tiles are built in that projection, with the
# ocean as a transparent alpha channel (alpha survives WebP compression exactly).

EARTH_RAW = os.path.join(RAW, 'earth')
ETOPO_URL = ('https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/'
             'ETOPO_2022_v1_60s_N90W180_surface.tif')
_earth = {}


def earth_dem_full():
    """ETOPO elevation (m), 1 arc-minute, rows 90N -> 90S, columns 180W -> 180E."""
    if 'full' not in _earth:
        cache = os.path.join(EARTH_RAW, 'etopo.npy')
        if not os.path.exists(cache):
            import tifffile
            path = fetch(ETOPO_URL, 'earth')
            np.save(cache, tifffile.imread(path).astype(np.float32))
        _earth['full'] = np.load(cache, mmap_mode='r')
    return _earth['full']


def block_mean(a, f):
    h, w = a.shape
    return np.asarray(a, dtype=np.float32).reshape(h // f, f, w // f, f).mean(axis=(1, 3))


def earth_land():
    """Land mask on a 2 arc-minute grid. Below-sea-level areas count as water only if they
    are big (> 50,000 km2: oceans, Caspian, Black Sea...); small dry depressions such as
    Death Valley, the Dead Sea shore or the Qattara Depression stay land."""
    if 'land' not in _earth:
        dem = block_mean(earth_dem_full(), 2)
        below = dem < 0
        labels, n = ndimage.label(below)
        lat = 90 - (np.arange(dem.shape[0]) + 0.5) / 30
        cell_km2 = (pixel_km('earth', 30) ** 2) * np.cos(np.radians(lat))
        area = ndimage.sum(np.broadcast_to(cell_km2[:, None], dem.shape), labels, index=np.arange(1, n + 1))
        water_ids = np.nonzero(area > 50_000)[0] + 1
        _earth['land'] = ~np.isin(labels, water_ids)
        _earth['dem2'] = dem
    return _earth['land']


def earth_elevation():
    land = earth_land()
    return np.where(land, _earth['dem2'] / 1000, np.nan), 1 / 30


def earth_slope():
    land = earth_land()
    s = slope_deg(np.asarray(earth_dem_full(), dtype=np.float32), 60, RADIUS_KM['earth'])
    return np.where(land, block_mean(s, 2), np.nan), 1 / 30


POWER_DIR = os.path.join(RAW, 'power')


def power_grid(param, how):
    """NASA POWER monthly climatology -> one value per point (how: 'max', 'min' or 'mean'
    of the 12 months), on its own grid (0.5 x 0.625 deg, or 1 deg for UV), then smoothly
    onto the 2 arc-minute land-mask grid."""
    files = glob.glob(os.path.join(POWER_DIR, param, '*.json'))
    if len(files) < 648:
        raise SystemExit(f'{param}: only {len(files)}/648 boxes downloaded - run tools/fetch_power.py')
    months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
    points = {}
    for f in files:
        with open(f) as fh:
            for feat in json.load(fh)['features']:
                lon, lat = feat['geometry']['coordinates'][:2]
                vals = np.array([feat['properties']['parameter'][param][m] for m in months], dtype=float)
                vals[vals < -900] = np.nan  # POWER's fill value
                points[(round(lat, 4), round(lon, 4))] = {'max': np.nanmax, 'min': np.nanmin, 'mean': np.nanmean}[how](vals)
    # each parameter comes on its own grid (e.g. 0.5 x 0.625 deg, or 1 deg for UV): use it as is
    lat_axis = np.array(sorted({k[0] for k in points}))
    lon_axis = np.array(sorted({k[1] for k in points}))
    li = {v: i for i, v in enumerate(lat_axis)}
    lo = {v: i for i, v in enumerate(lon_axis)}
    g = np.full((lat_axis.size, lon_axis.size), np.nan)
    for (la, ln), v in points.items():
        g[li[la], lo[ln]] = v
    from scipy.interpolate import RegularGridInterpolator
    interp = RegularGridInterpolator((lat_axis, lon_axis), g, bounds_error=False, fill_value=None)
    # interpolate onto the 2 arc-minute land-mask grid so coastlines stay crisp
    # (the values themselves are ~50 km data and stay smooth)
    land = earth_land()
    h, w = land.shape
    lat_t = 90 - (np.arange(h) + 0.5) * 180 / h
    lon_t = -180 + (np.arange(w) + 0.5) * 360 / w
    out = np.empty((h, w), dtype=np.float32)
    for r0 in range(0, h, 600):  # in strips, to keep memory modest
        LA, LO = np.meshgrid(lat_t[r0:r0 + 600], lon_t, indexing='ij')
        out[r0:r0 + 600] = interp(np.stack([LA, LO], axis=-1))
    if param in ('TS_RANGE', 'PRECTOTCORR', 'ALLSKY_SFC_UV_INDEX', 'ALLSKY_SFC_SW_DWN'):
        out = np.maximum(out, 0)  # can't be negative (interpolation can undershoot slightly)
    return np.where(land, out, np.nan), 0.5


def write_tiles_mercator(encoded, valid, folder, max_zoom):
    """Tile pyramid in Web Mercator (EPSG:3857) from an equirectangular grid. RGBA WebP:
    grey = value (gaps filled from the nearest data), alpha = land (exact, lossless)."""
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        encoded = encoded[tuple(idx)]
    h, w = encoded.shape
    vimg = Image.fromarray(encoded, 'L')
    mimg = Image.fromarray(valid.astype(np.uint8) * 255, 'L')
    written = 0
    for z in range(max_zoom + 1):
        n = 256 * 2 ** z
        rows = min(h, 2 * n)  # pre-shrink rows when far bigger than needed (avoids aliasing)
        rs = Image.BOX if n <= w else Image.BILINEAR
        v = np.asarray(vimg.resize((n, rows), rs), dtype=np.float32)
        m = np.asarray(mimg.resize((n, rows), rs), dtype=np.float32)
        y = (np.arange(n) + 0.5) / n
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))
        src = np.clip((90 - lat) / 180 * rows - 0.5, 0, rows - 1)
        i0 = np.floor(src).astype(int)
        i1 = np.minimum(i0 + 1, rows - 1)
        f = (src - i0)[:, None]
        val = np.clip(np.round((1 - f) * v[i0] + f * v[i1]), 1, 255).astype(np.uint8)
        alpha = (((1 - f) * m[i0] + f * m[i1]) >= 128).astype(np.uint8) * 255
        for ty in range(n // 256):
            for tx in range(n // 256):
                sl = (slice(ty * 256, ty * 256 + 256), slice(tx * 256, tx * 256 + 256))
                a = alpha[sl]
                if not a.any():
                    continue  # all ocean
                d = os.path.join(folder, str(z), str(ty))
                os.makedirs(d, exist_ok=True)
                t = val[sl]
                Image.fromarray(np.dstack([t, t, t, a]), 'RGBA').save(
                    os.path.join(d, f'{tx}.{TILE_FORMAT}'), quality=90, method=6)
                written += 1
    return written


# ---- Encoding and tiles -------------------------------------------------------

def encode(values, lo, hi, log):
    """Map values to 1..255 (linear or log10 between lo and hi); 0 = no data."""
    v = values.astype(np.float64)
    finite = np.isfinite(v)
    if log:
        v, lo, hi = np.log10(np.maximum(np.nan_to_num(v, nan=lo), 1e-9)), math.log10(lo), math.log10(hi)
    t = np.clip((np.nan_to_num(v, nan=lo) - lo) / (hi - lo), 0, 1)
    out = (1 + np.round(t * 254)).astype(np.uint8)
    out[~finite] = 0
    return out


def write_tiles(encoded, folder, max_zoom, lat_range=(-90, 90)):
    """Write a tile pyramid. Gaps are filled from the nearest data: a "no data" value
    would not survive lossy compression (0 turns into 1-2 = "very low"). Instead, layers
    that only cover part of the globe are cut at a clean latitude in the browser
    (`lat_min`/`lat_max` in index.json), and tiles wholly outside are skipped."""
    valid = encoded > 0
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        encoded = encoded[tuple(idx)]
    img = Image.fromarray(encoded, 'L')
    written = 0
    for z in range(max_zoom + 1):
        w, h = 512 * 2 ** z, 256 * 2 ** z
        level = img.resize((w, h), Image.BOX if w <= img.width else Image.BILINEAR)
        rows = h // 256
        for y in range(rows):
            top, bottom = 90 - y * 180 / rows, 90 - (y + 1) * 180 / rows
            if bottom >= lat_range[1] or top <= lat_range[0]:
                continue  # tile entirely outside the layer's coverage
            for x in range(w // 256):
                d = os.path.join(folder, str(z), str(y))
                os.makedirs(d, exist_ok=True)
                level.crop((x * 256, y * 256, x * 256 + 256, y * 256 + 256)).save(
                    os.path.join(d, f'{x}.{TILE_FORMAT}'), quality=90, method=6)
                written += 1
    return written


# ---- Layer catalogue ----------------------------------------------------------
# Colour-scale choices:
#  * elevation, iron, temperatures, ice: linear - roughly bell-shaped values over a
#    limited range, and equal steps (km, %, degrees) are what people compare.
#  * slope, rock cover, thermal inertia: logarithmic - each spans 2-3 orders of
#    magnitude with most values bunched at the low end.
# Temperature ranges span roughly the 2nd-98th percentile of the surface *by area*
# (the flat map exaggerates the poles), so the colours spread over real variation;
# values beyond get the end colour, marked "≤" / "+" in the legend.
# Elevation and slope share a range between the bodies so the same colour means the
# same value on the Moon and on Mars.

SLOPE = dict(unit='°', log=True, min=0.1, max=30)
RELIEF = dict(unit='km', log=True, min=0.005, max=0.5)


def sunlight_module():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import sunlight
    return sunlight


def catalogue():
    """(body, layer) -> (function returning (grid, degrees per pixel), scale, max_zoom, description)."""
    dem_cache = {}

    def dem(body):
        if body not in dem_cache:
            dem_cache[body] = load_dem(body)
        return dem_cache[body]

    def elevation(body):
        d, ppd = dem(body)
        return d / 1000, 1 / ppd

    def slope(body):
        d, ppd = dem(body)
        return slope_deg(d, ppd, RADIUS_KM[body]), 1 / ppd

    def relief(body):
        d, ppd = dem(body)
        return relief_blocks(d), RELIEF_BLOCK / ppd

    mars_temps = {}

    def mars_temp(which):
        if not mars_temps:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import mars_thermal
            (mars_temps['mean'], mars_temps['daily'], mars_temps['yearly'],
             mars_temps['tmax'], mars_temps['tmin']) = mars_thermal.mars_temperature_maps(RAW, res=1.0)
        return mars_temps[which], 1.0

    temps = {}

    def moon_temp(which):
        if not temps:
            temps['mean'], temps['range'], temps['max'], temps['min'] = moon_temperatures()
        return temps[which], 0.5

    return {
        ('mars', 'elevation'): (lambda: elevation('mars'), dict(unit='km', log=False, min=-8, max=12, palette='topo'), 4,
                                'Height above the average surface level (MOLA, MGS).'),
        ('moon', 'elevation'): (lambda: elevation('moon'), dict(unit='km', log=False, min=-6, max=6, palette='topoBlue'), 3,
                                'Height above the average surface level (LOLA, LRO).'),
        ('mars', 'slope'): (lambda: slope('mars'), SLOPE, 4,
                            'How steep the ground is, in degrees, between points ~1.9 km apart (MOLA).'),
        ('moon', 'slope'): (lambda: slope('moon'), SLOPE, 3,
                            'How steep the ground is, in degrees, between points ~1.9 km apart (LOLA).'),
        # Relief is not a map view: the analog search reads it (same definition as Earth's
        # in tools/build_search_grid.py). Stored log-scaled, so flat plains keep their detail.
        ('mars', 'relief'): (lambda: relief('mars'), RELIEF, 2,
                             'Local relief: how much the height varies inside ~9 km blocks (MOLA).'),
        ('moon', 'relief'): (lambda: relief('moon'), RELIEF, 2,
                             'Local relief: how much the height varies inside ~9 km blocks (LOLA).'),
        ('mars', 'surface'): (mars_surface, dict(unit='TIU', log=True, min=30, max=1000, lat_min=-70, lat_max=70), 3,
                              'Thermal inertia: low = fine dust, high = rocks and bedrock (TES, MGS). '
                              '70°S–70°N; nearer the poles seasonal frost spoils the readings.'),
        # colour range centred on typical lunar soil (~44 TIU), so soil differences show; rocky craters are '80+'
        ('moon', 'surface'): (moon_surface, dict(unit='TIU', log=True, min=25, max=80, lat_min=-70, lat_max=70), 3,
                              'Thermal inertia, as on Mars: low = fine dust, high = rocks and bedrock. Calculated '
                              'from Diviner (LRO) midnight temperatures with a thermal model. 70°S–70°N.'),
        # Iron: each body gets its own range. Mars only varies between ~15 and 23 %,
        # which on a shared 0-25 % scale would be one flat orange.
        ('mars', 'iron'): (mars_iron, dict(unit='%', log=False, min=14, max=24, lat_min=-57.5, lat_max=57.5), 2,
                           'Iron in the top few tens of cm, as FeO weight % (gamma-ray spectrometer, Mars Odyssey). '
                           '~300 km pixels; none beyond ~60° latitude.'),
        ('moon', 'iron'): (moon_iron, dict(unit='%', log=False, min=0, max=24), 2,
                           'Iron in the soil, as FeO weight % (gamma-ray spectrometer, Lunar Prospector). '
                           '~60 km pixels. Dark volcanic plains are iron-rich, bright highlands iron-poor.'),
        ('mars', 'ice'): (mars_ice, dict(unit='%', log=False, min=0, max=80), 2,
                          'Hydrogen in the top ~1 m, mostly water ice near the poles: how many fewer neutrons '
                          'escape than over the driest ground (Mars Odyssey, ~12 Mars years; polar regions from '
                          'their frost-free summers only). ~300 km pixels.'),
        ('moon', 'temperature'): (lambda: moon_temp('mean'), dict(unit='°C', log=False, min=-130, max=-50), 2,
                                  'Average surface temperature over a whole lunar day and night (Diviner, LRO).'),
        ('moon', 'temp_range'): (lambda: moon_temp('range'), dict(unit='°C', log=False, min=190, max=300), 2,
                                 'Difference between the hottest and coldest time of a lunar day (Diviner, LRO).'),
        # ---- Earth (Web Mercator tiles; ocean transparent)
        ('earth', 'elevation'): (earth_elevation, dict(unit='km', log=False, min=0, max=4, palette='terrain'), 5,
                                 'Height above sea level (NOAA ETOPO 2022, from NASA SRTM and other data).'),
        ('earth', 'slope'): (earth_slope, SLOPE, 5,
                             'How steep the ground is, in degrees, between points ~1.9 km apart - the same '
                             'scale as the Moon and Mars slope maps (ETOPO 2022).'),
        ('earth', 'temp_max'): (lambda: power_grid('TS_MAX', 'max'), dict(unit='°C', log=False, min=-10, max=60), 5,
                                'Ground-surface temperature of the hottest month: its average daily maximum '
                                '(NASA POWER, long-term average).'),
        ('earth', 'temp_min'): (lambda: power_grid('TS_MIN', 'min'), dict(unit='°C', log=False, min=-80, max=20), 5,
                                'Ground-surface temperature of the coldest month: its average daily minimum '
                                '(NASA POWER, long-term average).'),
        ('earth', 'temp_range'): (lambda: power_grid('TS_RANGE', 'mean'), dict(unit='°C', log=False, min=0, max=27), 5,
                                  'Typical day-night swing of the ground-surface temperature, averaged over the '
                                  'year (NASA POWER).'),
        ('earth', 'dryness'): (lambda: (power_grid('PRECTOTCORR', 'mean')[0] * 365.25, 0.5),
                               dict(unit='mm/yr', log=True, min=15, max=2500, reverse=True), 5,
                               'Yearly rainfall: red = driest (least rain), blue = wettest (NASA POWER, '
                               'from MERRA-2 and GPM).'),
        ('earth', 'uv'): (lambda: power_grid('ALLSKY_SFC_UV_INDEX', 'mean'), dict(unit='UV index', log=False, min=0, max=2.5), 5,
                          'Ultraviolet at the ground: UV index averaged over day and night, including clouds '
                          '(NASA POWER, from CERES). Midday peaks are several times higher.'),
        ('moon', 'temp_max'): (lambda: moon_temp('max'), dict(unit='°C', log=False, min=-15, max=125), 2,
                               'Hottest time of a typical lunar day (Diviner, LRO). The Moon has no real '
                               'seasons, so this is every day\'s maximum.'),
        ('moon', 'temp_min'): (lambda: moon_temp('min'), dict(unit='°C', log=False, min=-210, max=-175), 2,
                               'Coldest time of a typical lunar night (Diviner, LRO).'),
        ('mars', 'temp_max'): (lambda: mars_temp('tmax'), dict(unit='°C', log=False, min=-40, max=35), 2,
                               'Hottest month\'s average afternoon maximum (a sliding 1/12 of the Mars year), as '
                               'for Earth. Calculated with a thermal model from TES and MOLA data.'),
        ('mars', 'temp_min'): (lambda: mars_temp('tmin'), dict(unit='°C', log=False, min=-127, max=-85), 2,
                               'Coldest month\'s average night minimum (a sliding 1/12 of the Mars year), as for '
                               'Earth. Calculated with a thermal model from TES and MOLA data.'),
        # Sunlight: average solar power on flat ground over day, night and the year (W/m2).
        # Earth measured (NASA POWER, from CERES satellites); Moon and Mars calculated
        # (tools/sunlight.py). Each world has its own colour range.
        ('earth', 'sunlight'): (lambda: (power_grid('ALLSKY_SFC_SW_DWN', 'mean')[0] * 1000 / 24, 0.5),
                                dict(unit='W/m²', log=False, min=80, max=290), 5,
                                'Sunlight reaching the ground, averaged over day, night and the year, '
                                'including clouds (NASA POWER, from CERES satellite data).'),
        ('mars', 'sunlight'): (lambda: sunlight_module().mars_sunlight(RAW), dict(unit='W/m²', log=False, min=50, max=155), 3,
                               'Sunlight reaching flat ground, averaged over day, night and the Mars year. '
                               'Calculated from Mars\'s orbit, dimmed by typical dust (more air and dust '
                               'over low ground, MOLA). No dust storms.'),
        ('moon', 'sunlight'): (lambda: sunlight_module().moon_sunlight(RAW), dict(unit='W/m²', log=False, min=0, max=435), 3,
                               'Sunlight reaching flat ground, averaged over the lunar day and night. '
                               'Calculated from the Sun\'s path; near the poles (beyond 75°) with mountain '
                               'and crater shadows from LOLA terrain, so permanently shadowed craters are 0.'),
        # Mars temperatures are calculated (no global measured product exists), with
        # their own ranges: Mars is far milder than the Moon.
        ('mars', 'temperature'): (lambda: mars_temp('mean'), dict(unit='°C', log=False, min=-120, max=-45), 2,
                                  'Average surface temperature over a Mars year. Calculated with a thermal model '
                                  'from TES albedo and thermal inertia and MOLA elevation; matches lander '
                                  'measurements within ~10 °C.'),
        ('mars', 'temp_range'): (lambda: mars_temp('daily'), dict(unit='°C', log=False, min=0, max=125), 2,
                                 'Typical day-night swing (daily max - min, averaged over the year). Calculated '
                                 'with a thermal model from TES and MOLA data.'),
        ('mars', 'temp_yearly'): (lambda: mars_temp('yearly'), dict(unit='°C', log=False, min=85, max=155), 2,
                                  'Hottest minus coldest moment of the whole Mars year: daily swing plus seasons. '
                                  'Calculated with a thermal model from TES and MOLA data.'),
    }


def area_quantiles(grid):
    """0th..100th percentile of an equirectangular grid, weighted by real area (cos lat)."""
    h = grid.shape[0]
    lat = 90 - (np.arange(h) + 0.5) * 180 / h
    w = np.broadcast_to(np.cos(np.radians(lat))[:, None], grid.shape)
    ok = np.isfinite(grid)
    v, w = grid[ok], w[ok]
    order = np.argsort(v)
    cum = np.cumsum(w[order])
    cum /= cum[-1]
    return [float(f'{x:.4g}') for x in np.interp(np.linspace(0, 1, 101), cum, v[order])]


def main():
    index_path = os.path.join(OUT, 'index.json')
    index = {}
    if os.path.exists(index_path):  # keep layers that aren't rebuilt this time
        with open(index_path) as f:
            index = json.load(f)
    wanted = sys.argv[1:]
    for (body, layer), (make, scale, max_zoom, about) in catalogue().items():
        if wanted and not ({body, layer, f'{body}/{layer}'} & set(wanted)):
            continue
        print(f'{body} {layer}')
        grid, deg = make()
        vals = grid[np.isfinite(grid)]
        print('  percentiles 1/5/50/95/99:', np.round(np.percentile(vals, [1, 5, 50, 95, 99]), 2),
              f'| {np.isfinite(grid).mean():.0%} of map has data')
        folder = os.path.join(OUT, body, layer)
        if os.path.isdir(folder):
            for f in glob.glob(os.path.join(folder, '**', '*.*'), recursive=True):
                os.remove(f)
        # Tiles store the layer's *full* value range (enc_min..enc_max), so the area
        # summary can read real values; the browser applies the colour range (min..max).
        # (log scales need a positive start: floor it at 1/1000 of the colour scale's minimum)
        enc_min = (max(float(np.nanmin(vals[vals > 0])), scale['min'] / 1000) if scale['log']
                   else float(np.nanmin(vals)))
        enc_max = float(np.nanmax(vals))
        lat_range = (scale.get('lat_min', -90), scale.get('lat_max', 90))
        encoded = encode(grid, enc_min, enc_max, scale['log'])
        if body == 'earth':
            n = write_tiles_mercator(encoded, np.isfinite(grid), folder, max_zoom)
        else:
            n = write_tiles(encoded, folder, max_zoom, lat_range)
        print(f'  {n} tiles')
        index.setdefault(body, {})[layer] = {
            **scale, 'about': about,
            'below_min': bool((vals < scale['min']).any()), 'above_max': bool((vals > scale['max']).any()),
            'enc_min': float(f'{enc_min:.6g}'), 'enc_max': float(f'{enc_max:.6g}'), 'pixel_km': round(pixel_km(body, 1 / deg), 1),
            'max_zoom': max_zoom, 'format': TILE_FORMAT,
            # area-weighted percentiles 0..100 of the whole body (the analog search uses them to
            # say how warm or cold a site is *for its world*)
            **({'quantiles': area_quantiles(grid)} if body != 'earth' else {}),
            **({'crs': 'EPSG3857'} if body == 'earth' else {})}
    # drop layers that no longer exist in the catalogue (e.g. the old roughness view)
    known = set(catalogue())
    index = {b: {l: m for l, m in layers.items() if (b, l) in known} for b, layers in index.items()}
    with open(index_path, 'w') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)


if __name__ == '__main__':
    main()
