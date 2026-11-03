// Map layers for widget.html, in the units of map.json (data built by build/make-basemap.py):
//  - names in every mode: raion names from ~1.8×, towns by size as you zoom in, villages from 13×; the
//    bigger first, never over each other, the region names or the target markers; your raions in cyan;
//  - "sat": a satellite image under the regions, which then become see-through (alerts stay red). The
//    whole map is one small image, closer views load 512 px tiles of the visible part (all built in, so it
//    works offline); closer still, when online, Sentinel-2 tiles straight from EOX (cached by the browser);
//  - "map": a road map over the dark regions — roads, railways, rivers, lakes, built-up areas;
//  - "hybrid": both;
//  - "dark": the satellite dimmed, thin pale-blue roads, alerts as a light red tint with a red outline —
//    a calm night look in which the markers stand out most.
// Setting: settings.json neptun.basemap = 'none' | 'sat' | 'map' | 'hybrid' | 'dark' (settings.js "Карта").
// window.NeptunPlaces.find(keys) gives the best-known town for place keys of a post (explosions, widget.js).
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DIR = document.currentScript.src.replace(/[^/]*$/, '') + 'basemap/';
  const svg = document.getElementById('map');
  const RAD = Math.PI / 180;
  const MODES = ['none', 'sat', 'map', 'hybrid', 'dark'];
  const SAT_MODES = new Set(['sat', 'hybrid', 'dark']);
  const MAP_MODES = new Set(['map', 'hybrid', 'dark']);
  // Zoom from which a road class, a town rank (0 Kyiv … 5 small towns, 6 villages) or raion names show up.
  const ROAD_ZOOM = { p: 1.7, s: 3.2, t: 7 };
  const PLACE_ZOOM = [1.25, 1.6, 2.3, 3.4, 5, 7, 13];
  const RAION_ZOOM = 1.8;
  // Name sizes in screen pixels (not in map units: on a small widget those came out 8 px), by rank:
  // big cities, towns, small towns, villages; raion names. They grow a little as you zoom in.
  const NAME_PX = [14.5, 14, 13, 13, 12.5, 12, 11.5];
  const RAION_PX = 10.5;
  const MAX_NAMES = 220;
  // Satellite level by screen pixels per map unit: L0 up to 2.6, L1 up to 5.2, L2 up to 9, then online tiles.
  const LEVEL_PX = [2.6, 5.2];
  const DEEP_PX = 9;
  const DEEP_URL = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/${z}/${y}/${x}.jpg`;
  const DEEP_MAX = 140; // tiles at once (a large HiDPI widget needs ~100)

  let mode = 'none';
  let sat = null; // window.NeptunBasemapSat
  let vec = null; // window.NeptunBasemapData
  let labels = null; // [{ x, y, name, rank, raion, uid }] in drawing priority
  let mine = new Set(); // your raion uids
  let project = null;
  let unproject = null;
  let proj = null;
  const loading = {};
  let raf = 0;

  const el = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // Under the regions: the satellite. Over the regions (under borders and labels): the road map.
  const under = el('g', { id: 'nep-base-sat' });
  const satLow = el('g'); // L0 and the built-in tiles
  const deep = el('g', { class: 'deep', 'clip-path': 'url(#nep-ua-clip)' }); // online tiles, cut to Ukraine
  under.append(satLow, deep);
  const over = el('g', { id: 'nep-base-map' });
  const names = el('g', { id: 'nep-base-names' });
  const satTiles = new Map(); // "lv_row_col" -> <image>
  const deepTiles = new Map(); // "z/x/y" -> <image>
  function mount() {
    const raions = document.getElementById('raions');
    const borders = document.getElementById('borders');
    const regionLabels = document.getElementById('labels');
    if (!raions || !borders || !regionLabels) return false;
    svg.insertBefore(under, raions);
    svg.insertBefore(over, borders);
    regionLabels.after(names);
    return true;
  }

  function loadScript(file, global) {
    if (window[global]) return Promise.resolve(window[global]);
    if (loading[file]) return loading[file];
    loading[file] = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = DIR + file;
      s.onload = () => resolve(window[global] || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return loading[file];
  }

  // ---------- satellite ----------

  function satImage(href, x, y, w, h) {
    return el('image', { href, x, y, width: w, height: h, preserveAspectRatio: 'none', decoding: 'async' });
  }

  function buildSat() {
    if (satLow.firstChild || !sat) return;
    satLow.appendChild(satImage(DIR + 'sat/l0.webp', sat.x, sat.y, sat.w, sat.h));
  }

  // Shows the built-in tiles of the useful level that cover the view (over the whole-map image, which shows
  // until they are decoded) and drops the others, so only a screenful of tiles stays in memory.
  function updateSat(view, pxPerUnit) {
    if (!sat) return;
    const lv = pxPerUnit > LEVEL_PX[1] ? 2 : pxPerUnit > LEVEL_PX[0] ? 1 : 0;
    const want = new Set();
    const L = sat.levels[lv];
    if (lv && L && L.tiles) {
      const span = L.size * L.scale; // map units per tile
      const [vx, vy, vw, vh] = view;
      const c0 = Math.floor((vx - sat.x) / span);
      const c1 = Math.floor((vx + vw - sat.x) / span);
      const r0 = Math.floor((vy - sat.y) / span);
      const r1 = Math.floor((vy + vh - sat.y) / span);
      for (const [c, r, w, h] of L.tiles) {
        if (c < c0 || c > c1 || r < r0 || r > r1) continue;
        const key = `${lv}_${r}_${c}`;
        want.add(key);
        if (satTiles.has(key)) continue;
        const img = satImage(`${DIR}sat/l${lv}_${r}_${c}.webp`, sat.x + c * span, sat.y + r * span, w * L.scale, h * L.scale);
        satTiles.set(key, img);
        satLow.appendChild(img);
      }
    }
    for (const [key, img] of satTiles) {
      if (want.has(key)) continue;
      img.remove();
      satTiles.delete(key);
    }
  }

  // Web Mercator tile of a point, and the north-west corner of a tile, at zoom z.
  const tileOf = (lat, lon, z) => {
    const n = 2 ** z;
    const phi = lat * RAD;
    return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n];
  };
  const cornerOf = (x, y, z) => {
    const n = 2 ** z;
    return [Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / RAD, (x / n) * 360 - 180];
  };

  // Closer than the built-in levels reach: Sentinel-2 tiles from EOX for the visible part. Each Mercator
  // tile is placed with an affine transform through its corners (over a few km the two projections differ
  // by a turn and a stretch only). Offline they simply do not load and the built-in image stays.
  function updateDeep(view, pxPerUnit) {
    const want = new Set();
    if (unproject && pxPerUnit > DEEP_PX) {
      const [vx, vy, vw, vh] = view;
      const [clat] = unproject(vx + vw / 2, vy + vh / 2);
      const metersPerPx = 1 / (proj.k * pxPerUnit);
      let z = Math.min(15, Math.max(11, Math.ceil(Math.log2((156543.03 * Math.cos(clat * RAD)) / metersPerPx))));
      let range = null;
      for (; z >= 11; z--) {
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const fx of [0, 0.5, 1]) {
          for (const fy of [0, 0.5, 1]) {
            const [lat, lon] = unproject(vx + vw * fx, vy + vh * fy);
            const [tx, ty] = tileOf(lat, lon, z);
            x0 = Math.min(x0, tx);
            x1 = Math.max(x1, tx);
            y0 = Math.min(y0, ty);
            y1 = Math.max(y1, ty);
          }
        }
        range = [Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1)];
        if ((range[2] - range[0] + 1) * (range[3] - range[1] + 1) <= DEEP_MAX) break;
      }
      // Still too many even at z11: the view is wide enough for the built-in image.
      if (z < 11) range = [0, 0, -1, -1];
      const [x0, y0, x1, y1] = range;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const key = `${z}/${tx}/${ty}`;
          want.add(key);
          if (deepTiles.has(key)) continue;
          const [nwx, nwy] = project(...cornerOf(tx, ty, z));
          const [nex, ney] = project(...cornerOf(tx + 1, ty, z));
          const [swx, swy] = project(...cornerOf(tx, ty + 1, z));
          // 0.3 % overlap hides hairline seams between neighbours
          const img = el('image', {
            href: DEEP_URL(z, tx, ty),
            x: -0.003,
            y: -0.003,
            width: 1.006,
            height: 1.006,
            preserveAspectRatio: 'none',
            transform: `matrix(${[nex - nwx, ney - nwy, swx - nwx, swy - nwy, nwx, nwy].map((v) => +v.toFixed(4)).join(' ')})`,
          });
          img.addEventListener('error', () => img.remove(), { once: true });
          deepTiles.set(key, img);
          deep.appendChild(img);
        }
      }
    }
    for (const [key, img] of deepTiles) {
      if (want.has(key)) continue;
      img.remove();
      deepTiles.delete(key);
    }
  }

  // ---------- road map ----------

  function paths(g, cls, cells) {
    for (const [cell, d] of Object.entries(cells || {})) {
      const p = el('path', { d, class: cls });
      p.dataset.cell = cell;
      g.appendChild(p);
    }
  }

  function buildMap() {
    if (over.firstChild || !vec) return;
    const add = (id) => {
      const g = el('g', { class: id });
      over.appendChild(g);
      return g;
    };
    paths(add('nb-urban'), 'nb-urban', vec.urban);
    paths(add('nb-water'), 'nb-water', vec.water);
    paths(add('nb-river'), 'nb-r2', vec.rivers && vec.rivers.r2);
    paths(over.lastChild, 'nb-r1', vec.rivers && vec.rivers.r1);
    paths(add('nb-rail'), 'nb-rail', vec.rail);
    // Roads: the dark casing under the line, minor classes first.
    const casing = add('nb-casing');
    const roads = add('nb-roads');
    for (const c of ['t', 's', 'p', 'm']) {
      paths(casing, `nb-c${c}`, vec.roads[c]);
      paths(roads, `nb-${c}`, vec.roads[c]);
    }
  }

  // Cells (tiles of the vector grid) outside the view are hidden: less to redraw.
  function cullMap(view) {
    if (!vec) return;
    const [gx, gy] = vec.grid;
    const cw = vec.size[0] / gx;
    const ch = vec.size[1] / gy;
    const m = 12; // map units of margin: lines reach a little past their cell
    const [vx, vy, vw, vh] = view;
    const c0 = Math.floor((vx - m) / cw);
    const c1 = Math.floor((vx + vw + m) / cw);
    const r0 = Math.floor((vy - m) / ch);
    const r1 = Math.floor((vy + vh + m) / ch);
    for (const p of over.querySelectorAll('path')) {
      const cell = Number(p.dataset.cell);
      const c = cell % gx;
      const r = Math.floor(cell / gx);
      p.style.display = c < c0 - 1 || c > c1 + 1 || r < r0 - 1 || r > r1 + 1 ? 'none' : '';
    }
  }

  // ---------- names ----------

  // Drawing order: the big towns, then raion names, then the other towns and the villages.
  function buildLabels(data) {
    const places = data.places.map(([x, y, name, rank]) => ({ x, y, name, rank }));
    const raions = (data.raions || []).map(([x, y, name, uid]) => ({ x, y, name: name.toUpperCase(), rank: -1, raion: true, uid }));
    labels = [...places.filter((p) => p.rank <= 2), ...raions, ...places.filter((p) => p.rank > 2)];
    const Intel = window.NeptunIntel;
    if (Intel && Intel.placeKey) {
      const index = new Map(); // place key -> the most important place of that name
      for (const p of places) {
        if (p.rank > 5) continue; // villages share names too often to be named by a post alone
        const k = Intel.placeKey(p.name);
        const cur = index.get(k);
        if (k && (!cur || p.rank < cur.rank)) index.set(k, p);
      }
      // A short one-word key ("Мена" ~ "мені") names a town only if it is a big one.
      api.find = (keys) => {
        let best = null;
        for (const k of keys) {
          const p = index.get(k);
          if (!p || (!k.includes(' ') && k.length < 5 && p.rank > 2)) continue;
          if (!best || p.rank < best.rank || (k.includes(' ') && p.rank === best.rank)) best = p;
        }
        return best;
      };
    }
  }

  // Names are sized in screen pixels and grow with the zoom (up to ×1.45), so they stay readable however
  // small the widget is; in map units that is px / ctm.a.
  function placeNames(view, zoom, ctm) {
    names.textContent = '';
    if (!labels || !ctm) return;
    const boxes = [];
    // Region names and target markers stay readable: the names keep off them.
    for (const t of document.querySelectorAll('#labels text, .nep-marker, .nep-boom')) {
      const b = t.getBoundingClientRect();
      if (b.width && t.style.display !== 'none') boxes.push([b.left - 3, b.top - 2, b.right + 3, b.bottom + 2]);
    }
    const hit = (a) => boxes.some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
    const [vx, vy, vw, vh] = view;
    const grow = Math.min(1.45, 1 + 0.12 * Math.log2(Math.max(1, zoom)));
    const u = (px) => (px / ctm.a).toFixed(4); // screen px -> map units
    let shown = 0;
    for (const l of labels) {
      if (zoom < (l.raion ? RAION_ZOOM : PLACE_ZOOM[l.rank])) continue;
      if (l.x < vx || l.x > vx + vw || l.y < vy || l.y > vy + vh) continue;
      const sx = ctm.a * l.x + ctm.e;
      const sy = ctm.d * l.y + ctm.f;
      if (l.raion) {
        const px = RAION_PX * Math.min(1.3, grow);
        const w = l.name.length * px * 0.72 + 4;
        const box = [sx - w / 2, sy - px * 0.62, sx + w / 2, sy + px * 0.62];
        if (box[0] < 0 || box[2] > innerWidth || hit(box)) continue;
        boxes.push(box);
        const t = el('text', { x: l.x, y: l.y, class: 'nb-raion' + (mine.has(l.uid) ? ' mine' : ''), 'font-size': u(px), 'letter-spacing': u(px / 9), 'stroke-width': u(3) });
        t.textContent = l.name;
        names.appendChild(t);
      } else {
        const big = l.rank <= 1;
        const px = NAME_PX[l.rank] * grow;
        const dot = (big ? 3.4 : l.rank === 6 ? 2.2 : 2.8) * Math.min(1.25, grow);
        const box = [sx - dot - 2, sy - px * 0.72, sx + dot + 4 + l.name.length * px * (big ? 0.58 : 0.53), sy + px * 0.52];
        if (box[2] > innerWidth || hit(box)) continue;
        boxes.push(box);
        const g = el('g', { class: `nb-place r${l.rank}` });
        g.appendChild(el('circle', { cx: l.x, cy: l.y, r: u(dot), 'stroke-width': u(1.2) }));
        const t = el('text', { x: +l.x + +u(dot + 3.5), y: l.y, 'font-size': u(px), 'stroke-width': u(3.2) });
        t.textContent = l.name;
        g.appendChild(t);
        names.appendChild(g);
      }
      if (++shown >= MAX_NAMES) break;
    }
  }

  // ---------- view ----------

  function viewBox() {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    return vb.length === 4 && vb.every(Number.isFinite) ? vb : null;
  }

  function update() {
    raf = 0;
    const view = viewBox();
    const ctm = svg.getScreenCTM();
    if (!view || !ctm) return;
    const zoom = (window.NeptunZoom && window.NeptunZoom.zoom) || 1;
    const pxPerUnit = ctm.a * (window.devicePixelRatio || 1);
    const useSat = SAT_MODES.has(mode);
    if (useSat) updateSat(view, pxPerUnit);
    updateDeep(view, useSat ? pxPerUnit : 0);
    if (MAP_MODES.has(mode)) {
      over.dataset.z = zoom >= ROAD_ZOOM.t ? 4 : zoom >= ROAD_ZOOM.s ? 3 : zoom >= ROAD_ZOOM.p ? 2 : 1;
      cullMap(view);
    }
    placeNames(view, zoom, ctm);
  }

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  async function setMode(m) {
    m = MODES.includes(m) ? m : 'none';
    if (m === mode) return schedule();
    mode = m;
    const useSat = SAT_MODES.has(m);
    const useMap = MAP_MODES.has(m);
    document.body.classList.toggle('nep-base-sat', useSat);
    document.body.classList.toggle('nep-base-map', useMap);
    document.body.classList.toggle('nep-base-dark', m === 'dark');
    document.body.dataset.basemap = m;
    under.style.display = useSat ? '' : 'none';
    over.style.display = useMap ? '' : 'none';
    if (useSat && !sat) sat = await loadScript('sat.js', 'NeptunBasemapSat');
    if (useMap && !vec) vec = await loadScript('vector.js', 'NeptunBasemapData');
    if (mode !== m) return; // changed while loading
    if (useSat) buildSat();
    if (useMap) buildMap();
    schedule();
  }

  function apply(s) {
    mine = new Set(((s && s.regions) || []).map(Number));
    setMode(s && s.neptun && s.neptun.basemap);
  }

  // widget.js builds the map from map.json first; mount once its groups exist.
  async function init() {
    if (!mount()) return setTimeout(init, 100);
    const map = await window.bridge.getMapData();
    proj = map.proj;
    if (proj && window.Geo && window.Geo.mapUnprojector) {
      project = window.Geo.mapProjector(proj);
      unproject = window.Geo.mapUnprojector(proj);
      // Ukraine's outline cuts the online tiles (they cover the neighbours and the sea too).
      const clip = el('clipPath', { id: 'nep-ua-clip', clipPathUnits: 'userSpaceOnUse' });
      clip.appendChild(el('path', { d: map.oblasts.map((o) => o.d).join('') }));
      const defs = el('defs');
      defs.appendChild(clip);
      under.prepend(defs);
    }
    svg.addEventListener('nep-zoom', schedule);
    addEventListener('resize', schedule);
    window.bridge.getSettings().then(apply);
    window.bridge.onSettings(apply);
    const data = await loadScript('places.js', 'NeptunBasemapPlaces');
    if (data) buildLabels(data);
    schedule();
  }

  const api = { setMode, find: () => null, get mode() { return mode; } };
  window.NeptunBasemap = api;
  window.NeptunPlaces = api;
  init();
})();
