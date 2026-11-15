"""
Download NASA POWER climatology (long-term monthly averages, 0.5 x 0.625 deg) for the
whole Earth, one parameter at a time, in 10 x 10 degree boxes (the API's limit).
Each box is cached in data/raw/power/, so the script can be re-run to resume.

  TS_MAX               daily maximum ground-surface ("skin") temperature (deg C), per month
  TS_MIN               daily minimum surface temperature (deg C), per month
  TS_RANGE             daily surface temperature range (deg C), per month
(Surface, not air, temperature - comparable with the Moon and Mars surface maps.)
  PRECTOTCORR          precipitation (mm/day), per month
  ALLSKY_SFC_UV_INDEX  surface UV index (all-sky, daily mean), per month
  ALLSKY_SFC_SW_DWN    sunlight reaching the ground (kWh/m2/day), per month
  TS                   ground-surface temperature (deg C), per month and yearly mean

Source: NASA Langley POWER project (MERRA-2 / CERES based), https://power.larc.nasa.gov
"""
import concurrent.futures as cf
import json
import os
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'raw', 'power')
API = 'https://power.larc.nasa.gov/api/temporal/climatology/regional'
PARAMS = ['TS_MAX', 'TS_MIN', 'TS_RANGE', 'PRECTOTCORR', 'ALLSKY_SFC_UV_INDEX', 'ALLSKY_SFC_SW_DWN', 'TS']


def box(param, lat0, lon0):
    path = os.path.join(OUT, param, f'{lat0}_{lon0}.json')
    if os.path.exists(path):
        return
    url = (f'{API}?parameters={param}&community=RE&format=JSON'
           f'&latitude-min={lat0}&latitude-max={lat0 + 10}&longitude-min={lon0}&longitude-max={lon0 + 10}')
    for attempt in range(5):
        try:
            data = urllib.request.urlopen(url, timeout=120).read()
            json.loads(data)['features']  # must be a valid answer
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + '.tmp', 'wb') as f:
                f.write(data)
            os.replace(path + '.tmp', path)
            return
        except Exception as e:  # network hiccup or rate limit: wait and retry
            time.sleep(2 ** attempt)
            last = e
    print(f'FAILED {param} {lat0} {lon0}: {last}')


def main():
    jobs = [(p, la, lo) for p in PARAMS for la in range(-90, 90, 10) for lo in range(-180, 180, 10)]
    done = 0
    with cf.ThreadPoolExecutor(4) as pool:
        for _ in pool.map(lambda j: box(*j), jobs):
            done += 1
            if done % 200 == 0:
                print(f'{done}/{len(jobs)}', flush=True)
    print('done')


if __name__ == '__main__':
    main()
