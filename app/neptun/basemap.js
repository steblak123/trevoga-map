// Offline map layers for widget.html, in the units of map.json (built by build/make-basemap.py):
//  - "sat": a satellite image under the regions, which then become see-through (alerts stay red);
//    the whole map is one small image, closer views load 512 px tiles of the visible part only;
//  - "map": a road map over the dark regions — roads, railways, rivers, lakes, built-up areas, towns;
//  - "hybrid": both. Town names appear as you zoom in, the bigger towns first, never overlapping.
// Setting: settings.json neptun.basemap = 'none' | 'sat' | 'map' | 'hybrid' (settings.js "Карта").
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DIR = document.currentScript.src.replace(/[^/]*$/, '') + 'basemap/';
  const svg = document.getElementById('map');
  const MODES = ['none', 'sat', 'map', 'hybrid'];
  // Zoom from which a road class or a town rank shows up.
  const ROAD_ZOOM = { m: 1, p: 1.7, s: 3.2 };
  const PLACE_ZOOM = [1.25, 1.6, 2.3, 3.4, 5, 7];
  const LABEL_PX = 11.5; // town name size on screen
  // Satellite level by screen pixels per map unit: L0 up to 2.6, L1 up to 5.2, then L2.
  const LEVEL_PX = [2.6, 5.2];

  let mode = 'none';
  let sat = null; // window.NeptunBasemapSat
  let vec = null; // window.NeptunBasemapData
  let loading = {};
  let raf = 0;

  const el = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // Under the regions: the satellite. Over the regions (under borders and labels): the road map.
  const under = el('g', { id: 'nep-base-sat' });
  const over = el('g', { id: 'nep-base-map' });
  const names = el('g', { id: 'nep-base-names' });
  const satTiles = new Map(); // "lv_row_col" -> <image>

  function mount() {
    const raions = document.getElementById('raions');
    const borders = document.getElementById('borders');
    const labels = document.getElementById('labels');
    if (!raions || !borders || !labels) return false;
    svg.insertBefore(under, raions);
    svg.insertBefore(over, borders);
    labels.after(names);
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
    if (under.firstChild || !sat) return;
    const l0 = satImage(DIR + 'sat/l0.webp', sat.x, sat.y, sat.w, sat.h);
    l0.classList.add('l0');
    under.appendChild(l0);
  }

  // Shows the tiles of the useful level that cover the view (over the whole-map image, which shows
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
        under.appendChild(img);
      }
    }
    for (const [key, img] of satTiles) {
      if (want.has(key)) continue;
      img.remove();
      satTiles.delete(key);
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
    for (const c of ['s', 'p', 'm']) {
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

  // Town names: by rank and zoom, inside the view, not over each other or the region names.
  // Sizes are in map units divided by the zoom, like the region names: constant while zooming.
  function placeNames(view, zoom, ctm) {
    names.textContent = '';
    if (!vec || !ctm) return;
    const boxes = [];
    // Region names and target markers stay readable: town names keep off them.
    for (const t of document.querySelectorAll('#labels text, .nep-marker')) {
      const b = t.getBoundingClientRect();
      if (b.width && t.style.display !== 'none') boxes.push([b.left - 3, b.top - 2, b.right + 3, b.bottom + 2]);
    }
    const hit = (a) => boxes.some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
    const [vx, vy, vw, vh] = view;
    const unit = LABEL_PX / zoom; // font size in map units
    const px = unit * ctm.a; // ... and on screen
    let shown = 0;
    for (const [x, y, name, rank] of vec.places) {
      if (zoom < PLACE_ZOOM[rank] || x < vx || x > vx + vw || y < vy || y > vy + vh) continue;
      const big = rank <= 1;
      const f = big ? 1.1 : 1;
      const sx = ctm.a * x + ctm.e;
      const sy = ctm.d * y + ctm.f;
      const box = [sx - 4, sy - px * f * 0.72, sx + 6 + name.length * px * f * (big ? 0.58 : 0.52), sy + px * f * 0.5];
      if (box[2] > innerWidth || hit(box)) continue;
      boxes.push(box);
      const g = el('g', { class: `nb-place r${rank}` });
      g.appendChild(el('circle', { cx: x, cy: y, r: (((big ? 2.7 : 2.1) * unit) / LABEL_PX).toFixed(3) }));
      const t = el('text', { x: x + (5 * unit) / LABEL_PX, y, 'font-size': (unit * f).toFixed(3) });
      t.textContent = name;
      g.appendChild(t);
      names.appendChild(g);
      if (++shown > 160) break;
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
    if (mode === 'sat' || mode === 'hybrid') updateSat(view, pxPerUnit);
    if (mode === 'map' || mode === 'hybrid') {
      over.dataset.z = zoom >= ROAD_ZOOM.s ? 3 : zoom >= ROAD_ZOOM.p ? 2 : 1;
      cullMap(view);
      placeNames(view, zoom, ctm);
    } else names.textContent = '';
  }

  const schedule = () => {
    if (!raf && mode !== 'none') raf = requestAnimationFrame(update);
  };

  async function setMode(m) {
    m = MODES.includes(m) ? m : 'none';
    if (m === mode) return;
    mode = m;
    const useSat = m === 'sat' || m === 'hybrid';
    const useMap = m === 'map' || m === 'hybrid';
    document.body.classList.toggle('nep-base-sat', useSat);
    document.body.classList.toggle('nep-base-map', useMap);
    document.body.dataset.basemap = m;
    under.style.display = useSat ? '' : 'none';
    over.style.display = names.style.display = useMap ? '' : 'none';
    if (useSat && !sat) sat = await loadScript('sat.js', 'NeptunBasemapSat');
    if (useMap && !vec) vec = await loadScript('vector.js', 'NeptunBasemapData');
    if (mode !== m) return; // changed while loading
    if (useSat) buildSat();
    if (useMap) buildMap();
    schedule();
  }

  function apply(s) {
    setMode(s && s.neptun && s.neptun.basemap);
  }

  // widget.js builds the map from map.json first; mount once its groups exist.
  function init() {
    if (!mount()) return setTimeout(init, 100);
    svg.addEventListener('nep-zoom', schedule);
    addEventListener('resize', schedule);
    // Region labels move with the zoom; place names avoid them, so they follow a frame later.
    window.bridge.getSettings().then(apply);
    window.bridge.onSettings(apply);
  }
  init();

  window.NeptunBasemap = { setMode, get mode() { return mode; } };
})();
