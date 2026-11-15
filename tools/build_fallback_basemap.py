"""Local fallback imagery for the Moon and Mars maps: public/basemap/<body>/<z>/<y>/<x>.jpg.

The maps' imagery comes from NASA Trek (and Esri for Mars CTX), which can be slow or drop
tiles; without a layer underneath, every missing tile is a black square. This builds a small
whole-world layer that ships with the app and always loads: the globe texture's colours
(src/assets/<body>-texture.jpg) shaded with the relief of the bundled 8 px/degree NASA
elevation (public/surface3d/<body>_8ppd.bin: LOLA on the Moon, MOLA on Mars), lit from the
north-west. Equirectangular like Trek, levels 0-2 (512 x 256 to 2048 x 1024 px, ~5 km per pixel
on the Moon, ~10 km on Mars); deeper zooms enlarge level 2.

Run: python3 tools/build_fallback_basemap.py   (needs numpy, pillow)
"""
import math
import os
import zlib

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BODIES = {'moon': 1737.4, 'mars': 3389.5}
LEVELS = 3  # z = 0, 1, 2


def far_dem(body):
    raw = zlib.decompress(open(os.path.join(ROOT, 'public', 'surface3d', f'{body}_8ppd.bin'), 'rb').read())
    delta = np.frombuffer(raw, dtype='<i2').reshape(1440, 2880).astype(np.int32)
    return np.cumsum(delta, axis=0).astype(np.float32)  # rows: differences from the row above


def hillshade(dem, r_km, az=315, alt=35):
    h, w = dem.shape
    lat = 90 - (np.arange(h) + 0.5) / 8
    dy = 2 * math.pi * r_km * 1000 / (360 * 8)
    dx = np.maximum(np.cos(np.radians(lat)), 0.02)[:, None] * dy
    gx = (np.roll(dem, -1, axis=1) - np.roll(dem, 1, axis=1)) / (2 * dx)
    p = np.pad(dem, ((1, 1), (0, 0)), mode='edge')
    gy = (p[:-2] - p[2:]) / (2 * dy)  # northward
    a, z = math.radians(az), math.radians(90 - alt)
    sx, sy, sz = math.sin(z) * math.sin(a), math.sin(z) * math.cos(a), math.cos(z)
    n = np.sqrt(gx ** 2 + gy ** 2 + 1)
    return np.clip((-gx * sx - gy * sy + sz) / n, 0, 1)


def main():
    for body, r_km in BODIES.items():
        W, H = 512 * 2 ** (LEVELS - 1), 256 * 2 ** (LEVELS - 1)
        tex = Image.open(os.path.join(ROOT, 'src', 'assets', f'{body}-texture.jpg')).convert('RGB').resize((W, H), Image.LANCZOS)
        col = np.asarray(tex, dtype=np.float32) / 255
        shade = hillshade(far_dem(body), r_km)
        flat = math.cos(math.radians(55))  # brightness of level ground
        shade = np.asarray(Image.fromarray((shade * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR), np.float32) / 255
        rel = np.clip(shade / flat, 0.25, 1.8)[..., None]
        img = np.clip(col * (0.45 + 0.55 * rel) * 255, 0, 255).astype(np.uint8)
        full = Image.fromarray(img)
        n = 0
        for z in range(LEVELS):
            lw, lh = 512 * 2 ** z, 256 * 2 ** z
            lvl = full.resize((lw, lh), Image.LANCZOS) if lw != W else full
            for ty in range(lh // 256):
                for tx in range(lw // 256):
                    d = os.path.join(ROOT, 'public', 'basemap', body, str(z), str(ty))
                    os.makedirs(d, exist_ok=True)
                    lvl.crop((tx * 256, ty * 256, tx * 256 + 256, ty * 256 + 256)).save(os.path.join(d, f'{tx}.jpg'), quality=85)
                    n += 1
        print(f'{body}: {n} tiles')


if __name__ == '__main__':
    main()
