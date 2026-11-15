"""Build the precise elevation grids for the route engine (public/route/grid/).

The map's own elevation tiles are 8-bit (~115 m steps) and must not be used for climbs. This
script packs NASA's raw MOLA elevation (16-bit, 1 m steps) into lossless WebP blocks:

    R, G  = elevation in metres + 10000, as a 16-bit number (R = high byte, G = low byte)
    B     = steepest slope inside the cell, in 0.25 deg steps (0..63.75 deg), taken from the next
            finer level (for the finest level built: from its own pixels and their 8 neighbours)

Levels (docs/route-algorithm.md, section 2):
    L0  8 px/deg   (~7.4 km)   MOLA MEGDR 32 px/deg, averaged over 4 x 4 pixels    global
    L1  32 px/deg  (~1.85 km)  MOLA MEGDR 32 px/deg (megt90n000fb.img, 132 MB)     global
    L2  128 px/deg (~463 m)    MOLA MEGDR 128 px/deg tiles (~130 MB each)           only the tiles you ask for

Blocks are 256 x 256 cells: public/route/grid/<level>/<row>_<col>.webp, row 0 at 90 N, col 0 at
180 W. public/route/grid/index.json describes them. The app loads only the blocks a search needs.

Moon (--body moon, into public/route/moon/grid/), from LRO LOLA's gridded elevation:
    L0  4 px/deg   (~7.6 km)   LOLA LDEM 16 px/deg, averaged over 4 x 4 pixels
    L1  16 px/deg  (~1.9 km)   LOLA LDEM 16 px/deg (ldem_16.img, 32 MB; little-endian int16 in 0.5 m steps)

Usage:
    python3 tools/build_route_grids.py                      # L0 + L1 (downloads megt90n000fb.img if needed)
    python3 tools/build_route_grids.py --body moon          # the Moon (downloads ldem_16.img if needed)
    python3 tools/build_route_grids.py --body moon --src data/raw/ldem_16.img
    python3 tools/build_route_grids.py --src path/to/megt90n000fb.img
    python3 tools/build_route_grids.py --l2 -10,0,130,140   # also L2 for a lat/lon box (south,north,west,east)
    python3 tools/build_route_grids.py --l2-dir data/raw/meg128   # where the 128 px/deg tiles are (or get downloaded)

Needs: numpy, pillow (pip install numpy pillow).
"""
import argparse
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'public', 'route', 'grid')
PDS = 'https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x'
LOLA = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img'
R_KM = 3389.5  # Mars; 1737.4 for --body moon
BLOCK = 256
OFFSET = 10000
SLOPE_STEP = 0.25


def fetch(url, folder=RAW):
    path = os.path.join(folder, os.path.basename(url))
    if not os.path.exists(path):
        os.makedirs(folder, exist_ok=True)
        print(f'  downloading {url}')
        urllib.request.urlretrieve(url, path)
    return path


def read_megdr(path, ppd, rows=None):
    """MOLA MEGDR topography: big-endian int16 metres, rows from the top edge, columns from 0 E."""
    n = os.path.getsize(path) // 2
    cols = 360 * ppd
    rows = rows or n // cols
    dem = np.memmap(path, dtype='>i2', mode='r', shape=(rows, cols))
    return np.asarray(dem, dtype=np.float32)


def read_ldem(path, ppd=16):
    """LRO LOLA LDEM: little-endian int16, 0.5 m steps above a 1737.4 km sphere, rows from the
    top edge (90 N), columns from 0 E."""
    cols = 360 * ppd
    dem = np.memmap(path, dtype='<i2', mode='r', shape=(180 * ppd, cols))
    return np.asarray(dem, dtype=np.float32) * 0.5


def to_180w(dem):
    """Columns 0..360 E -> 180 W..180 E."""
    return np.roll(dem, dem.shape[1] // 2, axis=1)


def steepest_slope(dem, ppd, lat_top):
    """Steepest slope (deg) from each pixel to any of its 8 neighbours (no wrap over the poles)."""
    h, w = dem.shape
    px_km = 2 * math.pi * R_KM / (360 * ppd)
    lat = lat_top - (np.arange(h) + 0.5) / ppd
    dx = np.maximum(np.cos(np.radians(lat)), 0.01)[:, None] * px_km * 1000
    dy = px_km * 1000
    out = np.zeros_like(dem)
    pad = np.pad(dem, ((1, 1), (0, 0)), mode='edge')
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            nb = np.roll(pad[1 + dr:1 + dr + h], -dc, axis=1)
            dist = np.sqrt((dc * dx) ** 2 + (dr * dy) ** 2)
            out = np.maximum(out, np.degrees(np.arctan(np.abs(nb - dem) / dist)))
    return out


def block_reduce(a, f, how):
    h, w = a.shape
    a = a[:h - h % f, :w - w % f].reshape(h // f, f, w // f, f)
    return a.mean(axis=(1, 3)) if how == 'mean' else a.max(axis=(1, 3))


def write_level(name, elev, smax, ppd, lat_top=90.0, lon_left=-180.0, only_blocks=None):
    """Cut a level into 256 x 256 lossless WebP blocks. Returns the index entry."""
    folder = os.path.join(OUT, name)
    os.makedirs(folder, exist_ok=True)
    h, w = elev.shape
    e = np.clip(np.round(elev + OFFSET), 0, 65535).astype(np.uint16)
    s = np.clip(np.round(smax / SLOPE_STEP), 0, 255).astype(np.uint8)
    # block grid is global (row 0 at 90 N, col 0 at 180 W), so blocks of every build line up
    r_off = int(round((90 - lat_top) * ppd)); c_off = int(round((lon_left + 180) * ppd))
    blocks = []
    for br in range(r_off // BLOCK, (r_off + h - 1) // BLOCK + 1):
        for bc in range(c_off // BLOCK, (c_off + w - 1) // BLOCK + 1):
            if only_blocks is not None and (br, bc) not in only_blocks:
                continue
            r0 = br * BLOCK - r_off; c0 = bc * BLOCK - c_off
            rgb = np.zeros((BLOCK, BLOCK, 3), np.uint8)
            valid = np.zeros((BLOCK, BLOCK), bool)
            rs0, rs1 = max(0, r0), min(h, r0 + BLOCK); cs0, cs1 = max(0, c0), min(w, c0 + BLOCK)
            if rs1 <= rs0 or cs1 <= cs0:
                continue
            sub_e = e[rs0:rs1, cs0:cs1]; sub_s = s[rs0:rs1, cs0:cs1]
            rr = slice(rs0 - r0, rs1 - r0); cc = slice(cs0 - c0, cs1 - c0)
            rgb[rr, cc, 0] = sub_e >> 8
            rgb[rr, cc, 1] = sub_e & 255
            rgb[rr, cc, 2] = sub_s
            valid[rr, cc] = True
            # outside the data: elevation 0 (= -10000 m) marks "no data"
            Image.fromarray(rgb, 'RGB').save(os.path.join(folder, f'{br}_{bc}.webp'), 'WEBP', lossless=True, quality=100, method=4)
            blocks.append(f'{br}_{bc}')
    print(f'  {name}: {len(blocks)} blocks, {ppd} px/deg')
    return {'ppd': ppd, 'block': BLOCK, 'offset_m': OFFSET, 'slope_step_deg': SLOPE_STEP,
            'cell_km': round(2 * math.pi * R_KM / (360 * ppd), 3), 'blocks': sorted(blocks)}


L2_TILES = [(top, left) for top in (88, 44, 0, -44) for left in (0, 90, 180, 270)]


def l2_tile_name(top, left):
    lat = f'{abs(top):02d}{"n" if top >= 0 else "s"}'
    return f'megt{lat}{left:03d}hb.img'


def build_l2(box, l2_dir, index):
    """L2 (128 px/deg) for a lat/lon box, from the MEGDR 128 px/deg tiles that cover it."""
    south, north, west, east = box
    ppd = 128
    for top, left in L2_TILES:
        # tile covers lat top-44..top, lon left..left+90 (0..360 E)
        tw = ((left + 180) % 360) - 180  # its west edge in -180..180
        lons = [((west % 360) + 360) % 360, ((east % 360) + 360) % 360]
        if top - 44 >= north or top <= south:
            continue
        if not any(left <= l < left + 90 for l in lons) and not (west <= tw <= east):
            continue
        name = l2_tile_name(top, left)
        path = os.path.join(l2_dir, name)
        if not os.path.exists(path):
            path = fetch(f'{PDS}/meg128/{name}', l2_dir)
        dem = np.asarray(np.memmap(path, dtype='>i2', mode='r', shape=(44 * ppd, 90 * ppd)), dtype=np.float32)
        # crop to the box (plus a block of margin)
        r0 = max(0, int((top - north) * ppd) - BLOCK); r1 = min(dem.shape[0], int((top - south) * ppd) + BLOCK)
        lon_left = left if left < 180 else left - 360
        c0 = max(0, int((west - lon_left) * ppd) - BLOCK) if west >= lon_left else 0
        c1 = min(dem.shape[1], int((east - lon_left) * ppd) + BLOCK)
        if c1 <= c0 or r1 <= r0:
            continue
        sub = dem[r0:r1, c0:c1]
        smax = steepest_slope(sub, ppd, top - r0 / ppd)
        entry = write_level('L2', sub, smax, ppd, lat_top=top - r0 / ppd, lon_left=lon_left + c0 / ppd)
        prev = index['levels'].get('L2', {'blocks': []})
        entry['blocks'] = sorted(set(prev['blocks']) | set(entry['blocks']))
        entry['coverage'] = 'partial'
        index['levels']['L2'] = entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--body', choices=['mars', 'moon'], default='mars')
    ap.add_argument('--src', help='MOLA MEGDR 32 px/deg file (megt90n000fb.img), or for --body moon LOLA ldem_16.img; downloaded if missing')
    ap.add_argument('--ppd', type=int, default=32, help='pixels per degree of --src (32; 4 for megt90n000cb.img, tests only)')
    ap.add_argument('--l2', help='also build L2 for south,north,west,east (degrees, west/east in -180..180)')
    ap.add_argument('--l2-dir', default=os.path.join(RAW, 'meg128'))
    ap.add_argument('--out', help='output folder (default public/route/grid)')
    args = ap.parse_args()
    global OUT, R_KM
    if args.body == 'moon':
        R_KM = 1737.4
        OUT = os.path.join(ROOT, 'public', 'route', 'moon', 'grid')
    if args.out:
        OUT = args.out

    os.makedirs(OUT, exist_ok=True)
    index_path = os.path.join(OUT, 'index.json')
    index = json.load(open(index_path)) if os.path.exists(index_path) else {'levels': {}}

    if args.body == 'moon':
        src = args.src or fetch(f'{LOLA}/ldem_16.img')
        print(f'reading {src}')
        dem = to_180w(read_ldem(src, 16))
        s1 = steepest_slope(dem, 16, 90.0)
        index['levels']['L1'] = write_level('L1', dem, s1, 16)
        index['levels']['L1']['smax_from'] = 'L1 pixels and their 8 neighbours'
        index['levels']['L0'] = write_level('L0', block_reduce(dem, 4, 'mean'), block_reduce(s1, 4, 'max'), 4)
        index['levels']['L0']['smax_from'] = 'L1'
        index['radius_km'] = R_KM
        index['source'] = 'LRO LOLA gridded elevation LDEM_16 (NASA PDS Geosciences Node), LRO-L-LOLA-4-GDR-V1.0'
        index['format'] = 'R,G = elevation m + offset (16 bit, R high byte); B = steepest slope inside the cell / slope_step; block 256x256, row 0 at 90N, col 0 at 180W'
        json.dump(index, open(index_path, 'w'), indent=1)
        print('wrote', index_path)
        return

    src = args.src or fetch(f'{PDS}/meg032/megt90n000fb.img')
    ppd = args.ppd
    print(f'reading {src}')
    dem = to_180w(read_megdr(src, ppd))
    s1 = steepest_slope(dem, ppd, 90.0)
    index['radius_km'] = R_KM
    if ppd == 32:
        # L1: the MEGDR itself. Its steepest slope comes from its own pixels (no L2 everywhere).
        index['levels']['L1'] = write_level('L1', dem, s1, 32)
        index['levels']['L1']['smax_from'] = 'L1 pixels and their 8 neighbours'
        # L0: 4 x 4 average; steepest slope = the steepest L1 slope inside the cell
        index['levels']['L0'] = write_level('L0', block_reduce(dem, 4, 'mean'), block_reduce(s1, 4, 'max'), 8)
        index['levels']['L0']['smax_from'] = 'L1'
    else:
        # a coarser stand-in source (tests only): use it as L0 directly
        index['levels']['L0'] = write_level('L0', dem, s1, ppd)
        index['levels']['L0']['smax_from'] = f'its own pixels ({ppd} px/deg stand-in)'
        index['levels'].pop('L1', None)
    if args.l2:
        build_l2([float(x) for x in args.l2.split(',')], args.l2_dir, index)
    index['source'] = 'MGS MOLA MEGDR (NASA PDS Geosciences Node), MGS-M-MOLA-5-MEGDR-L3-V1.0'
    index['format'] = 'R,G = elevation m + offset (16 bit, R high byte); B = steepest slope inside the cell / slope_step; block 256x256, row 0 at 90N, col 0 at 180W'
    json.dump(index, open(index_path, 'w'), indent=1)
    print('wrote', index_path)


if __name__ == '__main__':
    main()
