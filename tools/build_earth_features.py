"""
Earth features for the analog search: confirmed impact structures and Holocene volcanoes.
Writes public/features/earth.json:

  craters:   [name, lat, lon, diameter_km]   confirmed impact structures, from Wikipedia's
             regional "List of impact structures in ..." pages (which follow the Earth Impact
             Database, Planetary and Space Science Centre, University of New Brunswick)
  volcanoes: [name, lat, lon, landform, last_eruption]   volcanoes active in the last ~12,000
             years, Smithsonian Institution Global Volcanism Program, Volcanoes of the World
             (VOTW) database, via its public web service

Downloads are cached in data/raw/features/.

Run:  python tools/build_earth_features.py
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw', 'features')
OUT = os.path.join(ROOT, 'public', 'features')
UA = {'User-Agent': 'planet-maps-data-build/1.0'}
REGIONS = ['Africa', 'Antarctica', 'Asia and Russia', 'Australia', 'Europe', 'North America', 'South America']
VOLCANO_WFS = ('https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0'
               '&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json')


def cached(name, url):
    path = os.path.join(RAW, name)
    if not os.path.exists(path):
        os.makedirs(RAW, exist_ok=True)
        for attempt in range(6):
            try:
                data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()
                json.loads(data)
                break
            except Exception as e:  # rate limit or hiccup: wait and retry
                last = e
                time.sleep(5 * 2 ** attempt)
        else:
            raise SystemExit(f'failed: {url}: {last}')
        with open(path, 'wb') as f:
            f.write(data)
        time.sleep(3)  # be polite to the Wikipedia API
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def parse_coord(text):
    """{{coord|48|45|N|32|10|E|...}} or {{coord|48.75|32.17|...}} -> (lat, lon)."""
    m = re.search(r'\{\{\s*coord\s*\|([^}]*)\}\}', text, re.I)
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).split('|') if '=' not in p]
    nums, hemis = [], []
    for p in parts:
        if p.upper() in ('N', 'S', 'E', 'W'):
            hemis.append((p.upper(), nums))
            nums = []
        elif re.fullmatch(r'-?\d+(\.\d+)?', p):
            nums.append(float(p))
    if len(hemis) >= 2:
        def dms(h, v):
            x = v[0] + (v[1] if len(v) > 1 else 0) / 60 + (v[2] if len(v) > 2 else 0) / 3600
            return -x if h in ('S', 'W') else x
        return dms(*hemis[0]), dms(*hemis[1])
    if len(nums) >= 2:
        return nums[0], nums[1]
    return None


def craters():
    out = {}
    for region in REGIONS:
        title = f'List of impact craters in {region}'
        url = ('https://en.wikipedia.org/w/api.php?action=parse&redirects=1&prop=wikitext&format=json&formatversion=2&page='
               + urllib.parse.quote(title.replace(' ', '_')))
        text = cached(f'wiki_{region.replace(" ", "_")}.json', url)['parse']['wikitext']
        # confirmed structures only: every page lists the unconfirmed ones under their own heading
        cut = re.search(r'^==+\s*Unconfirmed[^\n]*$', text, re.M | re.I)
        if cut:
            text = text[:cut.start()]
        for row in re.split(r'\n\|-[^\n]*', text):
            coord = parse_coord(row)
            name = re.search(r'^\s*\|\s*\[\[(?:[^|\]]*\|)?([^\]]+)\]\]', row, re.M)
            if not coord or not name:
                continue
            cells = [c.strip() for c in re.split(r'\n\|', '\n' + row.strip()) if c.strip()]
            diam = None
            for c in cells[1:]:
                c = re.sub(r'^\s*align\s*=\s*\w+\s*\|', '', c).strip()
                if 'coord' in c.lower() or c.startswith('{{sort') or c.startswith('|{{sort'):
                    continue
                m = re.match(r'(?:\{\{0\|0*\}\})?\s*(\d+(?:\.\d+)?)', c)
                if m:
                    diam = float(m.group(1))
                    break
            nm = re.sub(r'\s+(crater|structure|impact structure|impact crater)$', '', name.group(1).strip(), flags=re.I)
            out[nm] = [nm, round(coord[0], 3), round(coord[1], 3), diam]
    return sorted(out.values(), key=lambda c: -(c[3] or 0))


def volcanoes():
    data = cached('gvp_holocene_volcanoes.json', VOLCANO_WFS)
    out = []
    for f in data['features']:
        p = f['properties']
        lon, lat = f['geometry']['coordinates'][:2]
        out.append([p['Volcano_Name'], round(lat, 3), round(lon, 3), p.get('Primary_Volcano_Type') or '',
                    p.get('Last_Eruption_Year')])
    return out


def main():
    c = craters()
    v = volcanoes()
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'earth.json'), 'w', encoding='utf-8') as f:
        json.dump({'about': 'Impact structures (Wikipedia regional lists, after the Earth Impact Database) and '
                            'Holocene volcanoes (Smithsonian GVP VOTW); see tools/build_earth_features.py',
                   'craters': c, 'volcanoes': v}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(c)} impact structures ({sum(1 for x in c if x[3] is None)} without diameter), {len(v)} volcanoes')
    print('largest:', c[:5])


if __name__ == '__main__':
    main()
