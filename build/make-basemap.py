#!/usr/bin/env python3
"""Builds the offline map layers of the widget (app/neptun/basemap/) in the projection of app/assets/map.json.

  sat/       satellite image of Ukraine in three levels of detail (transparent outside the borders):
             l0.webp for the whole map, l1_*/l2_* tiles of 512 px for closer zoom (~330 and ~165 m per px);
             Sentinel-2 cloudless 2017 by EOX IT Services GmbH, CC BY 4.0 (https://s2maps.eu),
             tiles fetched from tiles.maps.eox.at at zoom 10 and reprojected.
  vector.js  roads, railways and places from OpenStreetMap (ODbL; HOT export of Ukraine,
             https://data.humdata.org/organization/hot), water and built-up areas from Natural Earth
             (public domain), cut into a grid of tiles so the widget redraws only what changed.

Usage (Python 3.10+, packages: numpy pillow pyarrow shapely):
  python build/make-basemap.py --data DIR [sat] [vector]
DIR holds the downloaded sources:
  roads.parquet, railways.parquet, populated_places.parquet
      https://production-raw-data-api.s3.amazonaws.com/ISO3/UKR/_layers/osm/<name>.parquet
  ne_10m_lakes.geojson, ne_10m_lakes_europe.geojson, ne_10m_rivers_lake_centerlines.geojson,
  ne_10m_rivers_europe.geojson, ne_10m_urban_areas.geojson
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/<name>.geojson
Satellite tiles are cached in DIR/eox-tiles.
"""
import argparse
import concurrent.futures as cf
import io
import json
import math
import os
import re
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP = os.path.join(ROOT, 'app', 'assets', 'map.json')
OUT = os.path.join(ROOT, 'app', 'neptun', 'basemap')

SAT_ZOOM = 9  # ~205 m per source pixel at 48°N
SAT_UNITS_PER_PX = 0.25  # output: 4 px per map unit (~330 m)
SAT_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/{z}/{y}/{x}.jpg'
GRID = (8, 6)  # vector tiles across the map

# ---------- projection (same as app/neptun/geo.js and build/make-map.js) ----------

A = 6378137.0
E = math.sqrt(0.00669437999014)


def lcc_consts(p):
    m = lambda phi: math.cos(phi) / math.sqrt(1 - (E * math.sin(phi)) ** 2)

    def t(phi):
        es = E * math.sin(phi)
        return math.tan(math.pi / 4 - phi / 2) / ((1 - es) / (1 + es)) ** (E / 2)

    p1, p2, p0 = (math.radians(p[k]) for k in ('lat1', 'lat2', 'lat0'))
    n = (math.log(m(p1)) - math.log(m(p2))) / (math.log(t(p1)) - math.log(t(p2)))
    F = m(p1) / (n * t(p1) ** n)
    rho0 = A * F * t(p0) ** n
    return n, F, rho0


class Proj:
    def __init__(self, p):
        self.p = p
        self.n, self.F, self.rho0 = lcc_consts(p)
        self.lon0 = math.radians(p['lon0'])

    def fwd(self, lon, lat):
        """lon/lat (degrees, numpy arrays) -> map units."""
        phi = np.radians(lat)
        es = E * np.sin(phi)
        t = np.tan(np.pi / 4 - phi / 2) / ((1 - es) / (1 + es)) ** (E / 2)
        rho = A * self.F * t ** self.n
        theta = self.n * (np.radians(lon) - self.lon0)
        x = rho * np.sin(theta)
        y = self.rho0 - rho * np.cos(theta)
        return (x - self.p['x0']) * self.p['k'], (self.p['y1'] - y) * self.p['k']

    def inv(self, X, Y):
        """map units -> lon/lat (degrees)."""
        x = X / self.p['k'] + self.p['x0']
        y = self.p['y1'] - Y / self.p['k']
        dy = self.rho0 - y
        rho = np.sqrt(x * x + dy * dy)
        theta = np.arctan2(x, dy)
        t = (rho / (A * self.F)) ** (1 / self.n)
        phi = np.pi / 2 - 2 * np.arctan(t)
        for _ in range(6):
            es = E * np.sin(phi)
            phi = np.pi / 2 - 2 * np.arctan(t * ((1 - es) / (1 + es)) ** (E / 2))
        return np.degrees(theta / self.n + self.lon0), np.degrees(phi)


def path_rings(d):
    """Rings of an SVG path made of M/m, L/l and z (the format of map.json)."""
    rings, ring, x, y = [], [], 0.0, 0.0
    for cmd, args in re.findall(r'([MmLlZz])([^MmLlZz]*)', d):
        nums = [float(v) for v in re.findall(r'-?\d*\.?\d+(?:e-?\d+)?', args)]
        if cmd in 'Zz':
            if ring:
                rings.append(ring)
            ring = []
            continue
        for i in range(0, len(nums) - 1, 2):
            if cmd == 'M' or (cmd == 'L'):
                x, y = nums[i], nums[i + 1]
            else:
                x, y = x + nums[i], y + nums[i + 1]
            if cmd in 'Mm' and i == 0 and ring:
                rings.append(ring)
                ring = []
            ring.append((x, y))
    if ring:
        rings.append(ring)
    return rings


# ---------- satellite ----------


def merc_px(lon, lat, z):
    s = 256 * 2 ** z
    phi = np.radians(np.clip(lat, -85, 85))
    return (lon + 180) / 360 * s, (1 - np.log(np.tan(phi) + 1 / np.cos(phi)) / np.pi) / 2 * s


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'trevoga-map basemap build'})
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
            with open(path, 'wb') as f:
                f.write(data)
            return True
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                print('  tile failed', url, e, file=sys.stderr)
            time.sleep(2 ** attempt)
    return False


def land_mask(m, box, scale, oversample=4):
    """8-bit mask of Ukraine (union of oblasts) on the output grid, with soft edges."""
    x0, y0, w, h = box
    big = Image.new('L', (w * oversample, h * oversample), 0)
    draw = ImageDraw.Draw(big)
    k = oversample / scale
    for o in m['oblasts']:
        for ring in path_rings(o['d']):
            if len(ring) >= 3:
                draw.polygon([((px - x0) * k, (py - y0) * k) for px, py in ring], fill=255)
    return big.resize((w, h), Image.BOX)


def render_strip(proj, x0, y0, scale, w, rows, mosaic, origin, zoom, ss=2):
    """RGB (float, 0..255) of output rows `rows` (range) sampled from the mercator mosaic, ss x ss per pixel."""
    r0, r1 = rows
    ys, xs = np.mgrid[r0 * ss:r1 * ss, 0:w * ss].astype(np.float64)
    lon, lat = proj.inv(x0 + (xs + 0.5) * scale / ss, y0 + (ys + 0.5) * scale / ss)
    mx, my = merc_px(lon, lat, zoom)
    fx = mx - origin[0] - 0.5
    fy = my - origin[1] - 0.5
    ix = np.clip(np.floor(fx).astype(np.int64), 0, mosaic.shape[1] - 2)
    iy = np.clip(np.floor(fy).astype(np.int64), 0, mosaic.shape[0] - 2)
    ax = np.clip(fx - ix, 0, 1)[..., None].astype(np.float32)
    ay = np.clip(fy - iy, 0, 1)[..., None].astype(np.float32)
    c = lambda dy, dx: mosaic[iy + dy, ix + dx].astype(np.float32)  # noqa: E731
    rgb = c(0, 0) * (1 - ax) * (1 - ay) + c(0, 1) * ax * (1 - ay) + c(1, 0) * (1 - ax) * ay + c(1, 1) * ax * ay
    return rgb.reshape(r1 - r0, ss, w, ss, 3).mean(axis=(1, 3))


def grade(rgb):
    """For a dark widget: a little darker and calmer, the contrast kept."""
    rgb = rgb / 255.0
    luma = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    rgb = luma[..., None] + (rgb - luma[..., None]) * 0.9
    return np.clip(np.clip(rgb, 0, 1) ** 1.12 * 0.92 * 255 + 0.5, 0, 255).astype(np.uint8)


def build_sat(m, proj, data_dir):
    """Three levels: L0 (whole map, 0.5 map units per px), L1 and L2 (512 px tiles, 0.25 and 0.125)."""
    zoom = SAT_ZOOM + 1  # ~100 m per source pixel at 48°N
    scale = SAT_UNITS_PER_PX / 2  # finest level: 8 px per map unit
    pad = 2.0
    x0, y0 = -pad, -pad
    w = int(math.ceil((m['width'] + 2 * pad) / scale / 4)) * 4
    h = int(math.ceil((m['height'] + 2 * pad) / scale / 4)) * 4
    print(f'satellite: {w}x{h} px at {scale} map units per px, z{zoom} tiles')

    # Mercator tiles that cover Ukraine (with a margin), from a coarse grid of the output.
    mask = land_mask(m, (x0, y0, w // 8, h // 8), scale * 8, 2)
    on = np.asarray(mask.filter(ImageFilter.MaxFilter(5))) > 0
    gy, gx = np.nonzero(on)
    lon, lat = proj.inv(x0 + (gx + 0.5) * scale * 8, y0 + (gy + 0.5) * scale * 8)
    mx, my = merc_px(lon, lat, zoom)
    need = set(zip((mx // 256).astype(int), (my // 256).astype(int)))
    for tx, ty in list(need):  # neighbours too, for the bilinear samples at tile edges
        need.update((tx + dx, ty + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1))
    cache = os.path.join(data_dir, 'eox-tiles')
    os.makedirs(cache, exist_ok=True)
    jobs = {(tx, ty): os.path.join(cache, f'{zoom}_{ty}_{tx}.jpg') for tx, ty in need}
    t0 = time.time()
    with cf.ThreadPoolExecutor(6) as ex:
        ok = sum(ex.map(lambda kv: fetch(SAT_URL.format(z=zoom, x=kv[0][0], y=kv[0][1]), kv[1]), jobs.items()))
    print(f'  {ok}/{len(jobs)} tiles in {time.time() - t0:.0f} s')
    tx0 = min(t[0] for t in jobs)
    ty0 = min(t[1] for t in jobs)
    tx1 = max(t[0] for t in jobs)
    ty1 = max(t[1] for t in jobs)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.uint8)
    for (tx, ty), path in jobs.items():
        try:
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = np.asarray(Image.open(path).convert('RGB'))
        except Exception:  # noqa: BLE001  (missing tile: stays black, outside Ukraine anyway)
            pass

    full = np.zeros((h, w, 3), np.uint8)
    for r in range(0, h, 256):
        full[r:r + 256] = grade(render_strip(proj, x0, y0, scale, w, (r, min(h, r + 256)), mosaic, (tx0 * 256, ty0 * 256), zoom))
    del mosaic
    alpha = land_mask(m, (x0, y0, w, h), scale, 2)
    img = Image.fromarray(np.dstack([np.asarray(full), np.asarray(alpha)]), 'RGBA')
    del full

    out = os.path.join(OUT, 'sat')
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        os.remove(os.path.join(out, f))
    levels = []
    total = 0
    for lv, (div, q) in enumerate([(4, 80), (2, 74), (1, 70)]):
        im = img if div == 1 else img.resize((w // div, h // div), Image.LANCZOS)
        if div > 1:
            im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=40, threshold=2))
        lw, lh = im.size
        if lv == 0:
            name = 'l0.webp'
            im.save(os.path.join(out, name), 'WEBP', quality=q, method=6, alpha_quality=70)
            total += os.path.getsize(os.path.join(out, name))
            levels.append({'scale': scale * div, 'tiles': None})
            continue
        T = 512
        tiles = []
        for ty in range(0, lh, T):
            for tx in range(0, lw, T):
                tile = im.crop((tx, ty, min(lw, tx + T), min(lh, ty + T)))
                if tile.getchannel('A').getextrema()[1] == 0:
                    continue  # nothing of Ukraine in it
                name = f'l{lv}_{ty // T}_{tx // T}.webp'
                tile.save(os.path.join(out, name), 'WEBP', quality=q, method=6, alpha_quality=70)
                total += os.path.getsize(os.path.join(out, name))
                tiles.append([tx // T, ty // T, tile.size[0], tile.size[1]])
        levels.append({'scale': scale * div, 'size': T, 'tiles': tiles})
        print(f'  L{lv}: {lw}x{lh}, {len(tiles)} tiles')
    print(f'  {out}: {total / 1e6:.2f} MB')
    return {'x': x0, 'y': y0, 'w': round(w * scale, 3), 'h': round(h * scale, 3), 'levels': levels}


# ---------- vectors ----------


def read_geoparquet(path, columns, keep):
    import pyarrow.parquet as pq
    from shapely import wkb

    pf = pq.ParquetFile(path)
    rows = []
    for batch in pf.iter_batches(batch_size=200000, columns=columns + ['geom']):
        d = batch.to_pydict()
        for i in range(len(d['geom'])):
            props = {c: d[c][i] for c in columns}
            if keep(props):
                rows.append((props, wkb.loads(d['geom'][i])))
    return rows


def read_geojson(path):
    from shapely.geometry import shape

    with open(path, encoding='utf8') as f:
        fc = json.load(f)
    return [(f['properties'] or {}, shape(f['geometry'])) for f in fc['features'] if f.get('geometry')]


def to_map(geom, proj):
    from shapely import transform

    return transform(geom, lambda xy: np.column_stack(proj.fwd(xy[:, 0], xy[:, 1])))


def lines_of(geom):
    t = geom.geom_type
    if t == 'LineString':
        return [geom]
    if t in ('MultiLineString', 'GeometryCollection'):
        return [g for part in geom.geoms for g in lines_of(part)]
    return []


def polys_of(geom):
    t = geom.geom_type
    if t == 'Polygon':
        return [geom]
    if t in ('MultiPolygon', 'GeometryCollection'):
        return [g for part in geom.geoms for g in polys_of(part)]
    return []


def fmt(v):
    s = f'{v:.1f}'
    s = s.rstrip('0').rstrip('.') if '.' in s else s
    return '0' if s in ('-0', '') else s


def coords_path(coords, close=False):
    """Absolute first point, then relative steps rounded to 0.1 map units (no drift: steps between rounded points)."""
    pts = [(round(x, 1), round(y, 1)) for x, y in coords]
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    if len(out) < 2:
        return ''
    d = f'M{fmt(out[0][0])} {fmt(out[0][1])}'
    for (ax, ay), (bx, by) in zip(out, out[1:]):
        d += f'l{fmt(bx - ax)} {fmt(by - ay)}'.replace(' -', '-')
    return d + ('z' if close else '')


def cell_of(geom, m):
    c = geom.envelope.centroid
    gx = min(GRID[0] - 1, max(0, int(c.x / m['width'] * GRID[0])))
    gy = min(GRID[1] - 1, max(0, int(c.y / m['height'] * GRID[1])))
    return gy * GRID[0] + gx


def tiled(parts, m):
    """{cell: path} of lines or polygons."""
    cells = {}
    for g in parts:
        if g.geom_type == 'Polygon':
            d = coords_path(list(g.exterior.coords)[:-1], True) + ''.join(coords_path(list(r.coords)[:-1], True) for r in g.interiors)
        else:
            d = coords_path(list(g.coords))
        if d:
            cells.setdefault(cell_of(g, m), []).append(d)
    return {str(k): ''.join(v) for k, v in sorted(cells.items())}


def merged(lines, tol, min_len=0):
    from shapely import line_merge, MultiLineString, simplify

    if not lines:
        return []
    out = []
    for g in lines_of(line_merge(MultiLineString(lines))):
        g = simplify(g, tol, preserve_topology=False)
        if g.length >= min_len and len(g.coords) >= 2:
            out.append(g)
    return out


def build_vector(m, proj, data_dir):
    from shapely import make_valid, simplify, union_all
    from shapely.geometry import Polygon
    from shapely.prepared import prep

    # Ukraine, a little wider than drawn (the borders of map.json are simplified).
    land = union_all([make_valid(Polygon(r)) for o in m['oblasts'] for r in path_rings(o['d']) if len(r) >= 3]).buffer(0.3)
    land_p = prep(land)
    clip = lambda g: g if land_p.contains(g) else g.intersection(land)  # noqa: E731
    km = 1 / (m['proj']['k'] * 1000)  # km per map unit
    U = lambda k: k / km  # noqa: E731  km -> map units
    res = {'grid': list(GRID), 'size': [m['width'], m['height']]}

    # Roads: motorway/trunk, primary, secondary (OSM).
    print('roads…')
    cls = {'motorway': 'm', 'trunk': 'm', 'primary': 'p', 'secondary': 's'}
    rows = read_geoparquet(os.path.join(data_dir, 'roads.parquet'), ['highway'], lambda p: p['highway'] in cls)
    by = {'m': [], 'p': [], 's': []}
    for p, g in rows:
        for line in lines_of(to_map(g, proj)):
            by[cls[p['highway']]].append(line)
    tol = {'m': U(0.12), 'p': U(0.14), 's': U(0.18)}
    res['roads'] = {}
    for c, lines in by.items():
        ms = merged(lines, tol[c], U(0.4))
        res['roads'][c] = tiled(ms, m)
        print(f'  {c}: {len(lines)} ways -> {len(ms)} lines')

    print('railways…')
    rows = read_geoparquet(os.path.join(data_dir, 'railways.parquet'), ['railway'], lambda p: p['railway'] == 'rail')
    rails = [line for _, g in rows for line in lines_of(to_map(g, proj))]
    ms = merged(rails, U(0.15), U(2.5))  # short pieces are yards and sidings
    res['rail'] = tiled(ms, m)
    print(f'  {len(rails)} ways -> {len(ms)} lines')

    print('water…')
    lakes = []
    for name in ('ne_10m_lakes.geojson', 'ne_10m_lakes_europe.geojson'):
        for p, g in read_geojson(os.path.join(data_dir, name)):
            if 'Kakhovka' in str(p.get('name') or '') or 'Kakhovs' in str(p.get('name_en') or ''):
                continue  # drained since the dam was blown up in June 2023
            gm = to_map(g, proj)
            if not gm.intersects(land):
                continue
            for poly in polys_of(make_valid(clip(gm))):
                poly = simplify(poly, U(0.12))
                if poly.area > U(1.5) ** 2:
                    lakes.append(poly)
    res['water'] = tiled(lakes, m)
    rivers = {'r1': [], 'r2': []}
    for name in ('ne_10m_rivers_lake_centerlines.geojson', 'ne_10m_rivers_europe.geojson'):
        for p, g in read_geojson(os.path.join(data_dir, name)):
            gm = to_map(g, proj)
            if not gm.intersects(land):
                continue
            rank = p.get('scalerank', 10)
            key = 'r1' if (rank if rank is not None else 10) <= 6 else 'r2'
            rivers[key].extend(lines_of(clip(gm)))
    res['rivers'] = {k: tiled(merged(v, U(0.15), U(3)), m) for k, v in rivers.items()}
    print(f'  {len(lakes)} lakes, {len(rivers["r1"])}+{len(rivers["r2"])} river parts')

    print('built-up areas…')
    urban = []
    for p, g in read_geojson(os.path.join(data_dir, 'ne_10m_urban_areas.geojson')):
        gm = to_map(g, proj)
        if not gm.intersects(land):
            continue
        for poly in polys_of(make_valid(clip(gm))):
            poly = simplify(poly, U(0.15))
            if poly.area > U(0.8) ** 2:
                urban.append(poly)
    res['urban'] = tiled(urban, m)
    print(f'  {len(urban)} areas')

    print('places…')
    # The bigger towns from Natural Earth (the OSM export misses some, e.g. Dnipro), then OSM towns.
    places = []

    def add(name, lon, lat, rank):
        x, y = proj.fwd(np.array([lon]), np.array([lat]))
        x, y = float(x[0]), float(y[0])
        if not land_p.contains(Polygon([(x - .01, y - .01), (x + .01, y - .01), (x + .01, y + .01)])):
            return
        for q in places:
            d2 = (x - q[0]) ** 2 + (y - q[1]) ** 2
            if d2 < U(3) ** 2 or (q[2] == name and d2 < U(15) ** 2):
                return  # the same town twice: a node and an area, both sources, or another spelling
        places.append([round(x, 1), round(y, 1), name, rank])

    def pop_of(v):
        try:
            return int(re.sub(r'[^\d]', '', str(v)) or 0)
        except ValueError:
            return 0

    # (all of them inside the borders of the map: Natural Earth files Crimean towns under another country)
    ne = [(p, g) for p, g in read_geojson(os.path.join(data_dir, 'ne_10m_populated_places.geojson')) if 21 < g.x < 41.5 and 44 < g.y < 53]
    for p, g in sorted(ne, key=lambda r: -(r[0].get('POP_MAX') or 0)):
        pop = p.get('POP_MAX') or 0
        name = p.get('NAME_UK') or p.get('NAME')
        capital = 'capital' in str(p.get('FEATURECLA'))
        rank = 0 if p.get('FEATURECLA') == 'Admin-0 capital' else 1 if pop >= 500000 else 2 if pop >= 150000 or capital else 3 if pop >= 60000 else 4
        add(name, g.x, g.y, rank)
    n_ne = len(places)
    rows = read_geoparquet(
        os.path.join(data_dir, 'populated_places.parquet'),
        ['name', 'name_uk', 'place', 'population'],
        lambda p: p['place'] in ('city', 'town'),
    )
    rows.sort(key=lambda r: (r[0]['place'] != 'city', -pop_of(r[0]['population'])))
    for p, g in rows:
        name = (p['name_uk'] or p['name'] or '').strip()
        if not name:
            continue
        pt = g if g.geom_type == 'Point' else g.representative_point()
        pop = pop_of(p['population'])
        rank = 1 if pop >= 500000 else 2 if pop >= 150000 else 3 if p['place'] == 'city' or pop >= 40000 else 4 if pop >= 12000 else 5
        add(name, pt.x, pt.y, rank)
    places.sort(key=lambda r: (r[3], r[2]))
    res['places'] = places
    print(f'  {len(places)} places ({n_ne} from Natural Earth)', {r: sum(1 for q in places if q[3] == r) for r in range(6)})

    path = os.path.join(OUT, 'vector.js')
    with open(path, 'w', encoding='utf8') as f:
        f.write('// Offline map layers in map.json units; built by build/make-basemap.py (sources: basemap/LICENSE.md).\n')
        f.write('window.NeptunBasemapData = ')
        json.dump(res, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print(f'{path}: {os.path.getsize(path) / 1e6:.2f} MB')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', required=True)
    ap.add_argument('what', nargs='*', default=['sat', 'vector'])
    a = ap.parse_args()
    with open(MAP, encoding='utf8') as f:
        m = json.load(f)
    proj = Proj(m['proj'])
    sat_json = os.path.join(a.data, 'sat-box.json')
    if 'sat' in a.what:
        with open(sat_json, 'w') as f:
            json.dump(build_sat(m, proj, a.data), f)
    if os.path.exists(sat_json):
        with open(sat_json) as f:
            sat = json.load(f)
        path = os.path.join(OUT, 'sat.js')
        with open(path, 'w', encoding='utf8') as f:
            f.write('// Satellite levels in map.json units; built by build/make-basemap.py (sources: basemap/LICENSE.md).\n')
            f.write('window.NeptunBasemapSat = ' + json.dumps(sat, separators=(',', ':')) + ';\n')
    if 'vector' in a.what:
        build_vector(m, proj, a.data)


if __name__ == '__main__':
    main()
