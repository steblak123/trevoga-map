// Targets layer of widget.html (data: NEPTUN API): targets on the map with where they came from and
// where they head; under the map a tactical HUD dock — a region card (status, nearest target, distance,
// direction, ETA, risk), a panel of targets near your regions, count tiles — and a short banner when
// a target comes close. Nothing is written over the map itself.
// Talks to widget.js only through the DOM (#map, #wrap, #status, #sys) and window.bridge.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const { TYPES, ORDER, typeMeta, kindOf, classify, predict } = window.NeptunTypes;
  const Geo = window.Geo;
  const R = window.Regions;
  const bridge = window.bridge;
  const ipc = bridge.neptun || null; // preload.js hook; without it there is no banner
  // Projection of app/assets/map.json (see build/make-map.js), for a map.json without "proj".
  const DEFAULT_PROJ = { lat1: 45, lat2: 51, lat0: 48.5, lon0: 31.5, x0: -690178, y1: 432316, k: 0.000755630581276381 };
  const DEFAULTS = { markers: true, panel: true, hideFpv: false, alert: true, alertKm: 20, alertSound: false, cardSide: 'left', booms: true, ticker: true, style: 'bright', home: null };
  const BADGE_PX = 9; // marker radius on screen
  const CLUSTER_PX = 15; // markers closer than this on screen become one "×N" marker
  const EDGE_PAD_PX = 13; // targets beyond the visible map are pinned this far inside its edge
  const MOVE_EVERY = 2000; // ms between dead-reckoning steps
  const COURSE_KM = 60; // course line of the selected target
  const HOME_KM = 50; // Shaheds without a course farther than this from your regions are drawn faint
  const FULL_ROWS = 3; // up to this many close targets get a two-line entry…
  const COMPACT_ROWS = 6; // …more get one line each
  const HIST_EVERY = 30000; // count tiles: one sample per 30 s…
  const HIST_POINTS = 60; // …for the last 30 minutes
  // Shaheds without a course are drawn only near your regions (as on the NEPTUN map); reconnaissance
  // drones usually circle without one, so they are always drawn.
  const SHAHEDS = new Set(['uav', 'jet']);
  const FAST = new Set(['missile', 'ballistic', 'jet', 'kab', 'mig31k']);
  // Direction sector length by kind: [km at most, km when the speed is unknown]; missiles reach far ahead.
  const AHEAD = { missile: [160, 110], ballistic: [140, 90], jet: [120, 80], mig31k: [100, 70], kab: [45, 30] };
  const CONFIDENCE = { high: 'висока', medium: 'середня', low: 'низька' };
  const STATUS = { appr: 'Наближається', pass: 'Проліт', away: 'Віддаляється', hit: 'Удар', unk: 'Невідомо' };
  const RISK = ['Низький', 'Середній', 'Високий'];
  const COMPASS8 = ['Пн', 'Пн-Сх', 'Сх', 'Пд-Сх', 'Пд', 'Пд-Зх', 'Зх', 'Пн-Зх'];

  // Small line icons for badges and titles (viewBox -8 -8 16 16).
  const ICON = {
    pin: '<path d="M0-7.2a5 5 0 0 1 5 5C5 1.6 0 7.4 0 7.4S-5 1.6-5-2.2a5 5 0 0 1 5-5Zm0 3.1A1.9 1.9 0 1 0 0-.3 1.9 1.9 0 0 0 0-4.1Z"/>',
    dist: '<path d="M-7.5 0-4-3.4V-1.3H4V-3.4L7.5 0 4 3.4V1.3H-4V3.4Z"/>',
    arrow: '<path d="M0-7 4.6 5.6 0 3-4.6 5.6Z"/>',
    clock: '<circle class="s" r="6" stroke-width="1.6"/><path class="s" stroke-width="1.6" stroke-linecap="round" d="M0-3.4V0l2.6 1.7"/>',
    radar: '<circle class="s" r="6.3" stroke-width="1.3"/><circle class="s" r="3.4" stroke-width="1.3"/><path d="M0 0 6-3.6A7 7 0 0 1 6.4.8Z" opacity=".8"/><circle r="1.2"/>',
    region: '<path d="M-6.5-5.5 2-7.2 6.8-2.6 5.4 5.6-3.2 7-6.9 1.2Z" class="s" stroke-width="1.5" stroke-linejoin="round"/><circle r="1.6"/>',
    warn: '<path d="M0-7.2 7.4 6.2H-7.4Z" class="s" stroke-width="1.5" stroke-linejoin="round"/><path d="M-.8-2.4H.8L.5 2.2H-.5ZM-.9 3.4H.9V5H-.9Z"/>',
  };
  const ico = (name, cls = '') => `<svg class="h-ico ${cls}" viewBox="-8 -8 16 16">${ICON[name]}</svg>`;
  const arrowIco = (deg) => `<svg class="h-ico" viewBox="-8 -8 16 16"><g transform="rotate(${Math.round(deg)})">${ICON.arrow}</g></svg>`;

  const $ = (id) => document.getElementById(id);
  const svg = $('map');
  const client = new window.NeptunClient();
  // Jet or plain Shahed from the channel posts (intel.js), cached per track update.
  const intel = window.NeptunIntel ? new window.NeptunIntel() : null;
  const hintCache = new Map(); // track id -> { v, u, mode, at, channel }
  window.NeptunTypes.setHint((t) => {
    if (!intel) return null;
    const c = hintCache.get(t.id);
    if (c && c.v === intel.version && c.u === t.updatedAt) return c.mode;
    if (hintCache.size > 3000) hintCache.clear();
    const a = intel.about(t);
    hintCache.set(t.id, { v: intel.version, u: t.updatedAt, mode: a ? a.mode : null, at: a ? a.at : null, channel: a ? a.channel : '' });
    return a ? a.mode : null;
  });

  let opts = { ...DEFAULTS, markers: false }; // applySettings() starts the client if enabled
  let volume = 0.7;
  let project = null; // (lat, lon) -> [x, y] in map units
  let projDef = null; // the projection parameters
  let kmPerUnit = 1;
  const shapeIndex = new Map(); // raion / city uid -> { uid, name, d, rings? }
  const oblastIndex = new Map(); // normalized oblast name -> { uid, name, d }
  let land = []; // [{ x0, y0, x1, y1, rings }] of every raion: is a point over Ukraine
  let mine = []; // shapes of the selected ("my") regions
  // Your own point ({ lat, lon, x, y }), when set: distances, the radius and "Біля вас" count from it, not from the raions.
  let home = null;
  const homeShape = { name: 'вашої точки', center: [0, 0] };
  const hasBase = () => mine.length > 0 || !!home;
  let alertState = {}; // air-raid state from main.js (iot, alerts, history, starts, error)
  let selected = null; // id of the target in the targets panel
  let group = null; // ids of the "×N" group in the targets panel
  let unitsPerPx = 0;
  const pool = []; // marker elements, reused in drawing order
  const nearCache = new Map(); // id -> { km, name, shape, trend } for the current render pass

  // ---------- DOM ----------

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  const layer = svgEl('g', { id: 'nep-layer' });
  const areaLayer = svgEl('g', { id: 'nep-area' });
  const trackLayer = svgEl('g', { id: 'nep-tracks' });
  const selLayer = svgEl('g', { id: 'nep-sel' });
  const leadLayer = svgEl('g', { id: 'nep-leads' }); // lines from fanned-out markers to their true spot
  const boomLayer = svgEl('g', { id: 'nep-booms' }); // explosions named in the channel posts
  const homeLayer = svgEl('g', { id: 'nep-home' }); // your own point
  const markerLayer = svgEl('g', { id: 'nep-markers' });
  layer.append(areaLayer, trackLayer, selLayer, leadLayer, boomLayer, homeLayer, markerLayer);
  svg.appendChild(layer);

  // Under the map, above the PC load tiles: the dock (region card + targets panel) and the count tiles.
  const dock = document.createElement('div');
  dock.id = 'nep-dock';
  const regionEl = document.createElement('section');
  regionEl.className = 'h-pan nep-region ui';
  const targetsEl = document.createElement('section');
  targetsEl.className = 'h-pan nep-targets ui';
  dock.append(regionEl, targetsEl);
  const tilesEl = document.createElement('div');
  tilesEl.id = 'nep-tiles';
  const ticker = window.NeptunTicker || null; // events line between the map and the dock (ticker.js)
  const tickerEl = ticker ? ticker.el : document.createElement('div');
  if ($('sys')) $('sys').before(tickerEl, dock, tilesEl);
  else ($('status') || svg).after(tickerEl, dock, tilesEl);
  const tip = document.createElement('div');
  tip.id = 'nep-tip';
  $('wrap').appendChild(tip);
  // Links to the data sources: the APIs' and the map data licences ask for a visible one next to the map.
  // Only the sources of what is on screen are shown (basemap.js sets the nep-base-* body classes).
  const credit = document.createElement('div');
  credit.id = 'nep-credit';
  credit.innerHTML = [
    ['', 'https://alerts.in.ua/', 'alerts.in.ua'],
    ['nep-src', 'https://neptun.in.ua/', 'NEPTUN'],
    ['nep-osm', 'https://www.openstreetmap.org/copyright', '© OpenStreetMap'],
    ['nep-eox', 'https://s2maps.eu/', 'Sentinel-2 · EOX'],
  ]
    .map(([cls, href, text]) => `<a class="ui ${cls}" href="${href}" target="_blank">${text}</a>`)
    .join('');
  $('wrap').appendChild(credit);

  // Clicks on our elements must not drag the widget or open the settings (widget.js listens on document).
  for (const el of [tickerEl, dock, tilesEl, markerLayer, boomLayer, homeLayer, credit]) {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ---------- helpers ----------

  // innerHTML only when it changed, so hover and clicks survive the periodic re-render.
  function setHtml(el, html) {
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const hhmmss = (ms) => `${hhmm(ms)}:${pad(new Date(ms).getSeconds())}`;
  const plural = (n, [one, few, many]) => {
    const a = n % 10;
    const b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };
  const shortName = (name) => (R && R.shortName ? R.shortName(name) : name);
  const bareName = (name) => String(name).replace(/ район$/, '').replace(/^м\. /, '');
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const lastSeen = (t) => Date.parse(t.confirmedAt || t.updatedAt) || null;
  const metaOf = (t) => typeMeta(kindOf(t));
  const bySeverity = (a, b) => metaOf(b).severity - metaOf(a).severity || (lastSeen(b) || 0) - (lastSeen(a) || 0);
  const sizeOf = (t) => (t.count > 1 ? t.count : 1);
  const sumSize = (list) => list.reduce((s, t) => s + sizeOf(t), 0);
  const compass8 = (deg) => COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  // "Одеська область", "АР Крим", "м. Київ" -> "одеська", "крим", "київ"
  const normOblast = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[’ʼ`]/g, "'")
      .replace(/^автономна республіка\s+|^ар\s+|^м\.\s*/, '')
      .replace(/\s+область$/, '')
      .trim();

  // "Одеська область" -> "Одеської області" ("у бік Одеської області").
  const toward = (region) => String(region).replace(/ька область$/, 'ької області');

  function ago(ms, now) {
    const min = Math.round((now - ms) / 60000);
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв`;
    return `${Math.floor(min / 60)} год ${min % 60} хв`;
  }

  function closeFor(ms, now) {
    const min = Math.floor((now - ms) / 60000);
    if (min < 1) return 'щойно';
    return min < 60 ? `${min} хв` : `${Math.floor(min / 60)} год`;
  }

  const typeIcon = (kind, cls = 'h-ico') => `<svg class="${cls}" viewBox="-12 -12 24 24">${typeMeta(kind).icon}</svg>`;
  const typeChip = (kind) => `<span class="h-ent-ico" style="--c:${typeMeta(kind).color}">${typeIcon(kind)}</span>`;
  // A target's name: "Реактивний шахед" or "Шахед" (the API calls both "БпЛА", a group "Група БпЛА (2+)"),
  // in the plural for a group; other targets keep their title.
  function nameText(t) {
    const kind = kindOf(t);
    const title = (t.title || '').trim();
    const many = t.count > 1 || /груп|шахеди/i.test(title);
    if (kind === 'jet') return many ? 'Реактивні шахеди' : 'Реактивний шахед';
    if (kind === 'uav') return !title || /^(бпла|шахеди?|uav|група бпла.*)$/i.test(title) ? (many ? 'Шахеди' : 'Шахед') : title;
    return title || metaOf(t).short;
  }
  const nameOf = (t) => esc(nameText(t)) + (t.count > 1 ? `<em>×${t.count}</em>` : '');

  // Over the sea: a report with no place of its own whose point is off the Ukrainian land.
  const seaCache = new Map();
  function seaOf(t) {
    if (t.areaOnly || (t.locality && t.locality !== t.region) || !project) return null;
    const key = `${t.id}:${t.lat},${t.lon}`;
    if (seaCache.has(key)) return seaCache.get(key);
    if (seaCache.size > 500) seaCache.clear();
    const [x, y] = project(t.lat, t.lon);
    let sea = null;
    if (!land.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && Geo.insideRings(r.rings, x, y))) {
      if (t.lat > 45.25 && t.lat < 47.15 && t.lon > 34.8 && t.lon < 38.7) sea = 'Азовським морем';
      else if (t.lat > 41 && t.lat < 46.75 && t.lon > 27.3 && t.lon < 41.9) sea = 'Чорним морем';
    }
    seaCache.set(key, sea);
    return sea;
  }

  // Where a target is, in two or three words: "Макарів", "→ Лозова" (only the destination was named),
  // "над морем", or the oblast for area-only reports.
  function placeShort(t) {
    if (t.areaOnly) return shortName(t.region);
    if (seaOf(t)) return 'над морем';
    if (t.destination && t.locality) return `→ ${t.locality}`;
    return t.locality || shortName(t.district || t.region || '');
  }

  // Oblast and raion in a few words: "Харківська обл. · Чугуївський р-н", "у бік Одеської області".
  function areaText(t) {
    if (seaOf(t)) return t.region ? `у бік ${toward(t.region)}` : 'над морем';
    const parts = [];
    if (t.region) parts.push(shortName(t.region));
    if (t.district && t.district !== t.region) parts.push(shortName(t.district));
    return parts.join(' · ');
  }

  // What lies at a point: { kind: 'raion', name } over Ukraine, or 'sea' / 'abroad'.
  function areaAt(lat, lon) {
    const [x, y] = project(lat, lon);
    const r = land.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && Geo.insideRings(r.rings, x, y));
    if (r) return { kind: 'raion', name: r.name };
    const sea = (lat > 45.25 && lat < 47.15 && lon > 34.8 && lon < 38.7) || (lat > 41 && lat < 46.75 && lon > 27.3 && lon < 41.9);
    return { kind: sea ? 'sea' : 'abroad' };
  }

  // Where a target came from: the first point of its reported trail, or, with only a course, a point
  // some way back along it (est). { lat, lon, est, bearing (from the target to it), where }.
  function originOf(t, now) {
    if (t.areaOnly || !project) return null;
    const p = predict(t, now);
    const trail = (Array.isArray(t.trail) ? t.trail : []).filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon));
    let o = null;
    if (trail.length && Geo.distanceKm(trail[0].lat, trail[0].lon, p.lat, p.lon) > 3) o = { lat: trail[0].lat, lon: trail[0].lon, est: false };
    else if (Geo.distanceKm(t.lat, t.lon, p.lat, p.lon) > 3) o = { lat: t.lat, lon: t.lon, est: false };
    else if (p.heading != null) {
      const speed = t.velocity && t.velocity.speedKmh > 0 ? t.velocity.speedKmh : 0;
      const km = speed ? Math.min(80, Math.max(25, speed / 4)) : 40; // about 15 minutes back
      const [lat, lon] = Geo.dest(p.lat, p.lon, (p.heading + 180) % 360, km);
      o = { lat, lon, est: true };
    }
    if (!o) return null;
    o.bearing = Geo.bearing(p.lat, p.lon, o.lat, o.lon);
    o.where = areaAt(o.lat, o.lon);
    return o;
  }

  const originText = (o) => (o.where.kind === 'raion' ? shortName(o.where.name) : o.where.kind === 'sea' ? 'з моря' : 'з-за кордону');

  // For tooltips: place plus region.
  function placeHtml(t) {
    if (t.areaOnly) return `<b>${esc(t.region)}</b>`;
    const sea = seaOf(t);
    if (sea) return `<b>над ${sea}</b>`;
    if (t.destination && t.locality) return `Курс → <b>${esc(t.locality)}</b>`;
    return `<b>${esc(t.locality || t.district || t.region)}</b>`;
  }

  function regionLine(t) {
    if (t.areaOnly) return '';
    if (seaOf(t)) return t.region ? esc(`у бік ${toward(t.region)}`) : '';
    const shown = t.locality || t.district || t.region;
    return esc([t.district, t.region].filter((p) => p && p !== shown).join(', '));
  }

  function rings(shape) {
    if (!shape.rings) shape.rings = Geo.pathRings(shape.d);
    return shape.rings;
  }

  function centroid(shape) {
    if (!shape.center) {
      const pts = rings(shape).flat();
      shape.center = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }
    return shape.center;
  }

  // Targets the user wants to see: the FPV filter applies to the map, the dock, tiles and banners alike.
  const visible = (t) => !(opts.hideFpv && kindOf(t) === 'fpv');
  const targets = () => client.list().filter(visible);
  const pointTargets = () => targets().filter((t) => !t.areaOnly);
  const courseless = (t, now) => SHAHEDS.has(kindOf(t)) && predict(t, now).heading == null;

  // Every target is on the map. A Shahed without a course far from your regions is drawn faint: the report
  // names only a place near which it was (NEPTUN leaves such ones off its map and counts them "ще N без курсу").
  function faint(t, now) {
    if (t.id === selected || (group && group.includes(t.id)) || !courseless(t, now)) return false;
    const near = nearOf(t, now);
    return !near || near.km > HOME_KM;
  }
  const mapTargets = () => pointTargets();

  // Map position and on-screen heading (degrees clockwise from up) of a target now.
  function placeOf(t, now) {
    const p = predict(t, now);
    const [x, y] = project(p.lat, p.lon);
    let angle = null;
    if (p.heading != null) {
      const [lat2, lon2] = Geo.dest(p.lat, p.lon, p.heading, 10);
      const [x2, y2] = project(lat2, lon2);
      angle = (Math.atan2(x2 - x, y - y2) * 180) / Math.PI;
    }
    return { ...p, x, y, angle };
  }

  // Nearest selected region to a map point: { km, name, shape } (km = 0 inside it).
  function nearestAt(x, y) {
    if (home) {
      homeShape.center = [home.x, home.y];
      return { km: Math.hypot(x - home.x, y - home.y) * kmPerUnit, name: homeShape.name, shape: homeShape };
    }
    let best = null;
    for (const s of mine) {
      const r = rings(s);
      const km = Geo.insideRings(r, x, y) ? 0 : Geo.ringsDistance(r, x, y) * kmPerUnit;
      if (!best || km < best.km) best = { km, name: s.name, shape: s };
    }
    return best;
  }

  // Distance to the selected regions and whether the target is closing in. Not for area-only reports.
  function nearOf(t, now) {
    if (!hasBase() || t.areaOnly || !project) return null;
    if (nearCache.has(t.id)) return nearCache.get(t.id);
    const p = placeOf(t, now);
    const near = nearestAt(p.x, p.y);
    if (near && near.km > 0 && p.heading != null) {
      const [lat2, lon2] = Geo.dest(p.lat, p.lon, p.heading, 3);
      const ahead = nearestAt(...project(lat2, lon2));
      if (ahead.km < near.km - 0.5) near.trend = 'наближається';
      else if (ahead.km > near.km + 0.5) near.trend = 'віддаляється';
    }
    nearCache.set(t.id, near);
    return near;
  }

  // Status of a target relative to your regions: over a region, closing in, moving away, or unknown.
  function statusKey(near) {
    if (!near) return 'unk';
    if (near.km < 0.5) return 'pass';
    if (near.trend === 'наближається') return 'appr';
    if (near.trend === 'віддаляється') return 'away';
    return 'unk';
  }

  // Threat level 0 low / 1 medium / 2 high of one target for your regions.
  function targetRisk(t, near) {
    if (!near) return 0;
    const r = opts.alertKm;
    const appr = near.trend === 'наближається';
    if (near.km < 0.5 || (appr && near.km <= r) || (FAST.has(kindOf(t)) && near.km <= r * 2)) return 2;
    if (near.km <= r || (appr && near.km <= r * 3)) return 1;
    return 0;
  }

  // Minutes until a target closing in at a known speed reaches your region.
  function etaMin(t, near) {
    const speed = t.velocity && t.velocity.speedKmh;
    if (!near || near.km < 0.5 || near.trend !== 'наближається' || !(speed > 0)) return null;
    return Math.max(1, Math.round((near.km / speed) * 60));
  }

  // Compass direction from a region to a target.
  function bearingFrom(shape, t, now) {
    const [cx, cy] = centroid(shape);
    const p = placeOf(t, now);
    return ((Math.atan2(p.x - cx, cy - p.y) * 180) / Math.PI + 360) % 360;
  }

  // ---------- badges ----------

  const distBadge = (near) => {
    if (!near) return `<span class="h-b none">${ico('dist')}—</span>`;
    if (near.km < 0.5) return `<span class="h-b dist">${ico('dist')}над районом</span>`;
    return `<span class="h-b dist">${ico('dist')}${Math.round(near.km)}<small>км</small></span>`;
  };
  const placeBadge = (text) => `<span class="h-b place">${ico('pin')}${esc(text)}</span>`;
  // "з Пн-Сх → Пд-Зх": where it comes from and where it heads.
  const courseBadge = (p, o) => {
    if (p.heading == null && !o) return '';
    const from = o ? `з ${compass8(o.bearing)}` : '';
    if (p.heading == null) return `<span class="h-b dir">${from}</span>`;
    return `<span class="h-b dir">${arrowIco(p.angle == null ? p.heading : p.angle)}${from ? `${from} → ` : ''}${compass8(p.heading)}</span>`;
  };
  const etaBadge = (min) => (min == null ? '' : `<span class="h-b eta">${ico('clock')}${min}<small>хв</small></span>`);
  const statusBadge = (key) => `<span class="h-b h-st ${key}">${STATUS[key]}</span>`;

  // One target: icon, name, status on the first line; badges on the second. Left bar = threat level.
  function entryHtml(t, now, { compact = false, fresh = false } = {}) {
    const near = nearOf(t, now);
    const p = placeOf(t, now);
    const risk = near ? targetRisk(t, near) : null;
    const cls = `h-ent ui${compact ? ' compact' : ''}${risk == null ? '' : ' r' + risk}${fresh ? ' fresh' : ''}${t.id === selected ? ' sel' : ''}`;
    const badges = compact
      ? distBadge(near)
      : placeBadge(placeShort(t)) + distBadge(near) + courseBadge(p, originOf(t, now)) + etaBadge(etaMin(t, near));
    return (
      `<button class="${cls}" data-id="${esc(t.id)}" style="--c:${metaOf(t).color}">${typeChip(kindOf(t))}` +
      `<span class="h-ent-name">${nameOf(t)}<small>${esc(areaText(t))}</small></span>${statusBadge(statusKey(near))}<span class="h-ent-badges">${badges}</span></button>`
    );
  }

  // ---------- markers ----------

  function makeMarker() {
    const el = svgEl('g', { class: 'nep-marker ui' });
    // Course pointer outside the badge (towards the target for an off-map one); hidden without a course.
    const ptr = svgEl('path', { class: 'ptr', d: 'M0-21.5 6.2-11.6H-6.2Z' });
    // A target named only by where it heads ("Ракета курсом на Балаклія"): it sits on that place, in a sight.
    const aim = svgEl('g', { class: 'aim' });
    aim.append(svgEl('circle', { r: 16 }), svgEl('path', { d: 'M0-21V-16.5M0 21V16.5M-21 0H-16.5M21 0H16.5' }));
    el.append(aim, svgEl('circle', { class: 'pulse', r: 11 }), ptr, svgEl('circle', { class: 'halo', r: 11 }));
    const glyph = svgEl('g', { class: 'glyph' });
    const cnt = svgEl('text', { class: 'cnt', x: 9, y: 16 });
    el.append(glyph, cnt);
    markerLayer.appendChild(el);
    return { el, glyph, ptr, cnt, kind: null };
  }

  // Visible part of the map in map units, shrunk by the edge padding.
  function viewBounds(m) {
    const r = svg.getBoundingClientRect();
    const p = EDGE_PAD_PX * unitsPerPx;
    return {
      x0: (r.left - m.e) / m.a + p,
      x1: (r.right - m.e) / m.a - p,
      y0: (r.top - m.f) / m.d + p,
      y1: (r.bottom - m.f) / m.d - p,
    };
  }

  const inView = (v, x, y) => x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;

  // Drawing units: single targets and groups of targets that overlap on screen.
  // Targets beyond the visible map are pinned to its edge with the pointer towards them.
  function computeUnits(now) {
    const m = svg.getScreenCTM();
    if (!project || !m || !m.a || !svg.getAttribute('viewBox')) return [];
    unitsPerPx = 1 / m.a;
    const v = viewBounds(m);
    const items = mapTargets(now)
      .sort(bySeverity)
      .map((t) => {
        const p = placeOf(t, now);
        const x = Math.min(v.x1, Math.max(v.x0, p.x));
        const y = Math.min(v.y1, Math.max(v.y0, p.y));
        const edge = Math.abs(x - p.x) + Math.abs(y - p.y) > 1e-6;
        return { t, p, x, y, edge, edgeAngle: edge ? (Math.atan2(p.x - x, y - p.y) * 180) / Math.PI : null, faint: faint(t, now) };
      });
    const limit = CLUSTER_PX * unitsPerPx;
    const groups = [];
    let sel = null;
    for (const it of items) {
      if (it.t.id === selected) {
        sel = [it];
        continue;
      }
      // one "×N" marker only for targets that share a course; the rest are fanned out below
      const g = groups.find((g) => g[0].edge === it.edge && Math.hypot(g[0].x - it.x, g[0].y - it.y) < limit && g.every((m) => sameCourse(m, it)));
      if (g) g.push(it);
      else groups.push([it]);
    }
    // Drawing order: lower severity first, the selected target last (on top).
    const units = groups.map(unitOf).reverse();
    if (sel) units.push(unitOf(sel));
    fanOut(units);
    return units;
  }

  const sameCourse = (a, b) => (a.p.angle == null) === (b.p.angle == null) && (a.p.angle == null || angleDiff(a.p.angle, b.p.angle) < 30);

  // Markers that would sit on top of each other (different courses at one spot) are spread on a small
  // ring around it, each on the side it flies to; a thin line leads from each to its true spot.
  function fanOut(units) {
    const touch = BADGE_PX * 2.2 * unitsPerPx;
    const used = new Set();
    for (let i = 0; i < units.length; i++) {
      if (used.has(i)) continue;
      const pile = [i];
      for (let j = i + 1; j < units.length; j++) {
        if (!used.has(j) && units[j].edge === units[i].edge && Math.hypot(units[i].x - units[j].x, units[i].y - units[j].y) < touch) pile.push(j);
      }
      if (pile.length < 2) continue;
      for (const k of pile) used.add(k);
      const cx = pile.reduce((s, k) => s + units[k].x, 0) / pile.length;
      const cy = pile.reduce((s, k) => s + units[k].y, 0) / pile.length;
      const r = BADGE_PX * Math.max(1.45, 0.5 * pile.length) * unitsPerPx;
      const order = pile.map((k) => units[k]).sort((a, b) => (a.ptrAngle ?? 999) - (b.ptrAngle ?? 999));
      const base = order[0].ptrAngle ?? 0;
      order.forEach((u, n) => {
        const a = ((base + (360 * n) / order.length) * Math.PI) / 180;
        u.ax = u.x;
        u.ay = u.y;
        u.x = cx + r * Math.sin(a);
        u.y = cy - r * Math.cos(a);
        u.fanned = true;
      });
    }
  }

  function unitOf(members) {
    const lead = members[0];
    const course = members.every((i) => i.p.angle != null && angleDiff(i.p.angle, lead.p.angle) < 30) ? lead.p.angle : null;
    const sum = (f) => members.reduce((s, i) => s + f(i), 0);
    return {
      ids: members.map((i) => i.t.id),
      lead: lead.t,
      x: sum((i) => i.x) / members.length,
      y: sum((i) => i.y) / members.length,
      glyphAngle: course,
      ptrAngle: lead.edge ? lead.edgeAngle : course,
      count: sum((i) => sizeOf(i.t)),
      edge: lead.edge,
      adv: members.every((i) => i.t.advisory),
      stale: members.every((i) => i.t.status === 'stale'),
      faint: members.every((i) => i.faint),
      dest: members.every((i) => i.t.destination && i.p.angle == null),
      sel: members.length === 1 && lead.t.id === selected,
      group: members.length > 1,
    };
  }

  function renderMarkers(now) {
    const units = opts.markers ? computeUnits(now) : [];
    layoutLabels();
    dimLabels(units);
    const s = ((BADGE_PX / 11) * unitsPerPx).toFixed(4);
    units.forEach((u, i) => {
      const m = pool[i] || (pool[i] = makeMarker());
      const kind = kindOf(u.lead);
      if (m.kind !== kind) {
        m.glyph.innerHTML = `<g class="g">${typeMeta(kind).icon}</g>`;
        m.el.style.setProperty('--c', typeMeta(kind).color);
        m.kind = kind;
      }
      m.el.dataset.ids = u.ids.join(',');
      m.el.setAttribute('transform', `translate(${u.x.toFixed(2)} ${u.y.toFixed(2)}) scale(${s})`);
      const turn = u.glyphAngle == null || kind === 'unknown' ? 0 : u.glyphAngle.toFixed(1); // a "?" stays upright
      m.glyph.setAttribute('transform', `rotate(${turn}) scale(0.72)`);
      m.ptr.setAttribute('transform', `rotate(${u.ptrAngle == null ? 0 : u.ptrAngle.toFixed(1)})`);
      m.cnt.textContent = u.count > 1 ? `×${u.count}` : '';
      const cls = m.el.classList;
      cls.toggle('nocourse', u.ptrAngle == null);
      cls.toggle('edge', u.edge);
      cls.toggle('group', u.group);
      cls.toggle('adv', u.adv);
      cls.toggle('stale', u.stale);
      cls.toggle('faint', u.faint && !u.stale);
      cls.toggle('dest', !!u.dest);
      cls.toggle('sel', u.sel || (!!group && u.ids.some((id) => group.includes(id))));
      m.el.style.display = '';
    });
    for (let i = units.length; i < pool.length; i++) {
      pool[i].el.style.display = 'none';
      pool[i].el.dataset.ids = '';
    }
    leadLayer.textContent = '';
    for (const u of units) {
      if (!u.fanned) continue;
      leadLayer.appendChild(svgEl('line', { class: 'lead', x1: u.ax.toFixed(2), y1: u.ay.toFixed(2), x2: u.x.toFixed(2), y2: u.y.toFixed(2) }));
      leadLayer.appendChild(svgEl('circle', { class: 'spot', cx: u.ax.toFixed(2), cy: u.ay.toFixed(2), r: (1.8 * unitsPerPx).toFixed(3) }));
    }
    drawTracks(now);
    drawSelection(now);
    drawBooms(now);
    drawHome();
  }

  // ---------- your point ----------

  const xy = (lat, lon) => {
    const [x, y] = project(lat, lon);
    return { x, y };
  };

  // A small quiet dot; the dashed circle of the radius shows only while you point at it.
  function drawHome() {
    homeLayer.textContent = '';
    if (!home || !opts.markers || !unitsPerPx) return;
    const u = unitsPerPx;
    const g = svgEl('g', { class: 'nep-home ui', transform: `translate(${home.x.toFixed(3)} ${home.y.toFixed(3)})` });
    g.append(
      svgEl('circle', { class: 'rad', r: ((opts.alertKm / kmPerUnit)).toFixed(3) }),
      svgEl('circle', { class: 'hit', r: (9 * u).toFixed(3) }),
      svgEl('circle', { class: 'dot', r: (3 * u).toFixed(3), 'stroke-width': (1.2 * u).toFixed(3) }),
    );
    homeLayer.appendChild(g);
  }

  // Placing: the ⌖ button, then a click on the map. Esc or the button again cancels.
  let placing = false;
  function setPlacing(on) {
    placing = on;
    document.body.classList.toggle('nep-placing', on);
    const b = document.querySelector('#nep-zoom [data-z="home"]');
    if (b) b.classList.toggle('on', on);
  }
  function saveHome(h) {
    bridge.setSettings({ neptun: { ...opts, home: h } });
  }
  svg.addEventListener(
    'mousedown',
    (e) => {
      if (placing && e.button === 0) e.stopPropagation(); // not a window drag
    },
    true,
  );
  svg.addEventListener(
    'click',
    (e) => {
      if (!placing) return;
      e.stopPropagation();
      const m = svg.getScreenCTM();
      const un = window.Geo.mapUnprojector && window.Geo.mapUnprojector(projDef);
      setPlacing(false);
      if (!m || !un) return;
      const [lat, lon] = un((e.clientX - m.e) / m.a, (e.clientY - m.f) / m.d);
      saveHome({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
    },
    true,
  );
  addEventListener('keydown', (e) => e.key === 'Escape' && placing && setPlacing(false));
  svg.addEventListener('nep-place-home', () => setPlacing(!placing));
  document.addEventListener('mousemove', (ev) => {
    const h = ev.target.closest && ev.target.closest('.nep-home');
    if (h) showTip(`<div class="tt-h"><b>Ваша точка</b></div><div class="tt-s">радіус ${opts.alertKm} км · змінити: ⌖</div>`, ev);
  });

  // ---------- explosions ----------

  // Explosions the channels wrote about in the last 15 minutes (intel.js), at the town they named
  // (basemap.js knows the towns): a burst that fades with age; hover for who wrote it.
  const BURST = 'M0-11 2.6-4.6 9.5-6.4 5.4-0.6 10 4.8 3-3.6 1.6 10.4-1.8 4.4-7.6 8.6-5.2 1.6-10.6-2.4-4.4-3.4-8.8-8.6-2.8-5.6Z';
  let booms = [];
  let focusBoom = null; // { name, until }: the explosion just opened from the events line blinks for a while
  const seenBooms = new Set();
  let boomsReady = false;
  function drawBooms(now) {
    boomLayer.textContent = '';
    booms = [];
    const places = window.NeptunPlaces;
    if (!opts.markers || !opts.booms || !intel || !places || !project || !unitsPerPx) return;
    booms = intel.booms(places.find, now);
    for (const b of booms) {
      const key = `${b.place.name}|${Math.floor(b.at / 600000)}`;
      if (!seenBooms.has(key)) {
        seenBooms.add(key);
        const { x, y } = b.place;
        const go = () => {
          focusBoom = { name: b.place.name, until: Date.now() + 6000 };
          if (window.NeptunZoom) window.NeptunZoom.centerOn(x, y, 12);
          refresh();
        };
        if (boomsReady && ticker) ticker.push({ at: b.at, kind: 'boom', title: 'Вибухи', place: [b.place.name, oblastAtMap(x, y)].filter(Boolean).join(', '), source: b.sources[0] && b.sources[0].channel, go });
      }
    }
    boomsReady = true; // the explosions already there at start are not news
    const s = ((1.35 * BADGE_PX) / 11) * unitsPerPx; // a bit bigger than a target marker
    booms.forEach((b, i) => {
      const age = (now - b.at) / 60000;
      const focus = focusBoom && focusBoom.name === b.place.name && now < focusBoom.until;
      const cls = 'nep-boom ui' + (age < 5 ? ' fresh' : '') + (focus ? ' focus' : '');
      const g = svgEl('g', { class: cls, transform: `translate(${b.place.x} ${b.place.y}) scale(${(focus ? 1.25 * s : s).toFixed(4)})` });
      g.style.opacity = focus ? '1' : Math.max(0.45, 1 - age / 50).toFixed(2);
      g.dataset.boom = i;
      g.append(svgEl('circle', { class: 'ring', r: 10 }), svgEl('path', { class: 'burst', d: BURST }), svgEl('circle', { class: 'core', r: 3.2 }));
      boomLayer.appendChild(g);
    });
  }

  function boomTip(b, now) {
    const min = Math.max(0, Math.round((now - b.at) / 60000));
    const rows = b.sources
      .slice(0, 3)
      .map((x) => `<div class="tt-sr"><b>${esc(x.channel)}</b><i>${hhmm(x.at)}</i><span>${esc(x.text)}</span></div>`)
      .join('');
    return (
      `<div class="tt-h" style="--c:#ffb020"><span class="h-ent-ico" style="--c:#ffb020"><svg class="h-ico" viewBox="-12 -12 24 24"><path d="${BURST}" fill="currentColor"/></svg></span><b>Вибухи</b></div>` +
      `<div class="tt-p"><b>${esc(b.place.name)}</b><span>${hhmm(b.at)} · ${min ? `${min} хв тому` : 'щойно'}</span></div>` +
      `<div class="tt-src"><div class="tt-k">Джерела<small>${b.sources.length} ${plural(b.sources.length, ['канал', 'канали', 'каналів'])}</small></div>${rows}</div>`
    );
  }

  // Tracks are drawn only where they matter, so many targets do not turn into a mess of bands:
  // the picked target, missiles / ballistics / jets / aviation, and targets close to your regions.
  // Every other one shows its course by the pointer on its marker.
  // Where a target came from and where it heads are drawn only for the one you clicked (or the members of
  // the group you clicked): with many targets the beams lit up the whole map. Every marker keeps its small
  // arrow of the course.
  let hoverId = null; // the target under the mouse: its trajectory shows while you point at it
  const picked = (t) => t.id === selected || t.id === hoverId || (!!group && group.includes(t.id));
  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    drawTracks(Date.now());
  }
  const showsFrom = (t) => picked(t);
  const wantsTrack = (t) => picked(t);

  // Where each target came from (reported trail up to its position now) and where it heads:
  // a translucent sector, wider when the course is only an estimate.
  function drawTracks(now) {
    trackLayer.textContent = '';
    const m = svg.getScreenCTM();
    if (!opts.markers || !project || !unitsPerPx || !m) return;
    const v = viewBounds(m);
    const defs = svgEl('defs');
    trackLayer.appendChild(defs);
    let gid = 0;
    // A gradient along a segment: [offset, colour, opacity] stops, in map units.
    const fade = ([x1, y1], [x2, y2], stops) => {
      const id = `nep-g${gid++}`;
      const lg = svgEl('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2) });
      for (const [offset, color, opacity] of stops) lg.appendChild(svgEl('stop', { offset, 'stop-color': color, 'stop-opacity': opacity }));
      defs.appendChild(lg);
      return `url(#${id})`;
    };
    for (const t of mapTargets(now)) {
      if (!wantsTrack(t, now)) continue;
      const p = placeOf(t, now);
      if (!inView(v, p.x, p.y)) continue;
      const kind = kindOf(t);
      const fast = FAST.has(kind) && kind !== 'kab';
      const g = svgEl('g', { class: 'nep-trk' + (fast ? ' fast' : '') + (t.id === selected ? ' sel' : '') });
      g.style.setProperty('--c', metaOf(t).color);
      const raw = (Array.isArray(t.trail) ? t.trail : []).filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon)).map((q) => project(q.lat, q.lon));
      raw.push(project(t.lat, t.lon), [p.x, p.y]);
      const pts = [];
      for (const q of raw) if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0.3) pts.push(q);
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const color = metaOf(t).color;
      if (pts.length > 1 && len * kmPerUnit > 1.5) {
        // where it came from: fades in from the first report to the position now
        const stroke = fade(pts[0], pts[pts.length - 1], [[0, color, 0.15], [1, color, 1]]);
        g.appendChild(svgEl('polyline', { class: 'from', stroke, points: pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') }));
        g.appendChild(svgEl('circle', { class: 'start', cx: pts[0][0].toFixed(2), cy: pts[0][1].toFixed(2), r: (2.2 * unitsPerPx).toFixed(3) }));
      } else if (showsFrom(t, now)) {
        // no reported trail: an estimate back along the course, dashed, for the picked target and
        // every target in or near your regions
        const o = originOf(t, now);
        if (o) {
          const op = project(o.lat, o.lon);
          const stroke = fade(op, [p.x, p.y], [[0, color, 0.1], [1, color, 0.95]]);
          g.appendChild(svgEl('line', { class: 'from est', stroke, x1: op[0].toFixed(2), y1: op[1].toFixed(2), x2: p.x.toFixed(2), y2: p.y.toFixed(2) }));
          g.appendChild(svgEl('circle', { class: 'start est', cx: op[0].toFixed(2), cy: op[1].toFixed(2), r: (2.2 * unitsPerPx).toFixed(3) }));
        }
      }
      if (p.heading != null) {
        const speed = t.velocity && t.velocity.speedKmh > 0 ? t.velocity.speedKmh : 0;
        const [maxKm, noSpeedKm] = AHEAD[kind] || [60, 28];
        const minKm = (BADGE_PX + (fast ? 64 : 30)) * unitsPerPx * kmPerUnit; // always well past the badge
        const km = Math.max(minKm, speed ? Math.min(maxKm, speed / 5) : noSpeedKm); // about 12 minutes ahead
        const spread = (t.presumptiveCourse || !speed ? 24 : 15) * (fast ? 0.7 : 1);
        const at = (deg, k) => project(...Geo.dest(p.lat, p.lon, deg, k));
        const xy = ([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`;
        const cone = [[p.x, p.y], at(p.heading - spread, km), at(p.heading - spread / 2, km * 1.04), at(p.heading, km * 1.06), at(p.heading + spread / 2, km * 1.04), at(p.heading + spread, km)];
        // where it heads: a radar-like beam, bright at the marker and fading out ahead
        const tipPt = at(p.heading, km * 1.06);
        const strong = fast || t.id === selected;
        const beam = '#4fe3ff';
        g.appendChild(
          svgEl('polygon', {
            class: 'to',
            fill: fade([p.x, p.y], tipPt, [[0, beam, strong ? 0.55 : 0.42], [0.6, beam, strong ? 0.22 : 0.14], [1, beam, 0]]),
            stroke: fade([p.x, p.y], tipPt, [[0, beam, 1], [0.8, beam, 0.35], [1, beam, 0]]),
            points: cone.map(xy).join(' '),
          }),
        );
        g.appendChild(
          svgEl('line', {
            class: 'axis',
            stroke: fade([p.x, p.y], tipPt, [[0, '#ffffff', 1], [1, '#ffffff', 0.1]]),
            x1: p.x.toFixed(2),
            y1: p.y.toFixed(2),
            x2: tipPt[0].toFixed(2),
            y2: tipPt[1].toFixed(2),
          }),
        );
      }
      if (g.childNodes.length) trackLayer.appendChild(g);
    }
  }

  // Course line and uncertainty circle of the selected target (when it is in view).
  function drawSelection(now) {
    selLayer.textContent = '';
    const t = selected && client.threats.get(selected);
    const m = svg.getScreenCTM();
    if (!t || t.areaOnly || !opts.markers || !project || !unitsPerPx || !m) return;
    const p = placeOf(t, now);
    if (!inView(viewBounds(m), p.x, p.y)) return;
    selLayer.style.setProperty('--c', metaOf(t).color);
    if (t.uncertaintyKm > 0) {
      const r = t.uncertaintyKm / kmPerUnit;
      if (r / unitsPerPx > BADGE_PX + 3) selLayer.appendChild(svgEl('circle', { class: 'unc', cx: p.x, cy: p.y, r }));
    }
    if (p.heading != null) {
      const [x2, y2] = project(...Geo.dest(p.lat, p.lon, p.heading, COURSE_KM));
      selLayer.appendChild(svgEl('line', { class: 'course', x1: p.x, y1: p.y, x2, y2 }));
    }
  }

  // ---------- region labels: never on top of each other or under a marker ----------

  // Each label keeps its own line: on a collision it moves a line up or down (or a bit sideways),
  // and with no free place it hides until the map is zoomed in. Recomputed on zoom and resize.
  let labelKey = '';
  const labelBoxes = new Map(); // text element -> its box in map units
  function layoutLabels() {
    const texts = [...document.querySelectorAll('#labels text')];
    const key = `${texts.length}|${svg.getAttribute('viewBox')}|${svg.clientWidth}x${svg.clientHeight}`;
    if (!texts.length || key === labelKey || !unitsPerPx) return;
    labelKey = key;
    labelBoxes.clear();
    const items = texts.map((t) => {
      if (t.dataset.ox == null) {
        t.dataset.ox = t.getAttribute('x');
        t.dataset.oy = t.getAttribute('y');
      }
      t.setAttribute('x', t.dataset.ox);
      t.setAttribute('y', t.dataset.oy);
      t.classList.remove('nep-hide');
      return { t, b: t.getBBox() };
    });
    items.sort((a, b) => b.b.width * b.b.height - a.b.width * a.b.height); // long names first
    const gap = 3 * unitsPerPx;
    const placed = [];
    const hits = (b) => placed.some((p) => b.x < p.x + p.w && p.x < b.x + b.w && b.y < p.y + p.h && p.y < b.y + b.h);
    for (const { t, b } of items) {
      const h = b.height;
      const w = b.width;
      const tries = [[0, 0], [0, -0.85 * h], [0, 0.85 * h], [-0.3 * w, 0], [0.3 * w, 0], [0, -1.7 * h], [0, 1.7 * h], [-0.3 * w, -0.85 * h], [0.3 * w, 0.85 * h], [-0.3 * w, 0.85 * h], [0.3 * w, -0.85 * h]];
      const spot = tries.map(([dx, dy]) => ({ dx, dy, x: b.x + dx - gap, y: b.y + dy - gap, w: w + gap * 2, h: h + gap * 2 })).find((c) => !hits(c));
      if (!spot) {
        t.classList.add('nep-hide');
        continue;
      }
      t.setAttribute('x', (+t.dataset.ox + spot.dx).toFixed(1));
      t.setAttribute('y', (+t.dataset.oy + spot.dy).toFixed(1));
      placed.push(spot);
      labelBoxes.set(t, spot);
    }
  }

  // A label with a marker on it fades, so the marker reads clearly.
  function dimLabels(units) {
    const r = (BADGE_PX + 4) * unitsPerPx;
    for (const [t, b] of labelBoxes) {
      const under = units.some((u) => u.x + r > b.x && u.x - r < b.x + b.w && u.y + r > b.y && u.y - r < b.y + b.h);
      t.classList.toggle('nep-dim', under);
    }
  }

  // Dashed outline of an oblast named in a report without a point. It marks the region, never a place.
  function drawAreas() {
    areaLayer.textContent = '';
    if (!opts.markers) return;
    const byOblast = new Map();
    for (const t of targets()) {
      if (!t.areaOnly) continue;
      const o = oblastIndex.get(normOblast(t.region));
      if (!o) continue;
      if (!byOblast.has(o)) byOblast.set(o, []);
      byOblast.get(o).push(t);
    }
    for (const [o, list] of byOblast) {
      const path = svgEl('path', { class: 'nep-area', d: o.d });
      path.style.setProperty('--c', metaOf(list.sort(bySeverity)[0]).color);
      areaLayer.appendChild(path);
    }
  }

  // ---------- targets close to the selected regions ----------

  const inside = new Map(); // id -> when it came within the radius (it leaves only past 1.3× the radius)
  const freshUntil = new Map(); // id -> time until which its entry flashes once
  let quiet = false; // re-baseline after a settings change without a banner

  // Updates the set of close targets; returns the ones that just came close.
  function trackNear(now) {
    const entered = [];
    if (!opts.markers || !hasBase()) {
      inside.clear();
      return entered;
    }
    const seen = new Set();
    for (const t of pointTargets()) {
      const near = nearOf(t, now);
      if (!near) continue;
      const limit = inside.has(t.id) ? opts.alertKm * 1.3 : opts.alertKm;
      if (near.km > limit) continue;
      seen.add(t.id);
      if (!inside.has(t.id)) {
        inside.set(t.id, now);
        entered.push({ t, near });
      }
    }
    for (const id of [...inside.keys()]) if (!seen.has(id)) inside.delete(id);
    return entered;
  }

  // Close targets, nearest first.
  function closeTargets(now) {
    return pointTargets()
      .filter((t) => inside.has(t.id))
      .map((t) => ({ t, near: nearOf(t, now) }))
      .filter((x) => x.near)
      .sort((a, b) => a.near.km - b.near.km);
  }

  // A 2-second banner for the targets that just came close. Observations (advisory) and old tracks do not alarm.
  function alertEntered(entered, now) {
    for (const { t } of entered) freshUntil.set(t.id, now + 1500);
    const fresh = entered.filter(({ t }) => !t.advisory && t.status !== 'stale');
    if (!fresh.length || !opts.alert || !ipc) return;
    fresh.sort((a, b) => a.near.km - b.near.km);
    ipc.send('alert', {
      sound: opts.alertSound,
      volume,
      items: fresh.map(({ t, near }) => ({
        id: t.id,
        type: kindOf(t),
        title: nameText(t) + (t.count > 1 ? ` ×${t.count}` : ''),
        place: placeShort(t),
        km: Math.round(near.km),
        name: shortName(near.name),
        trend: near.trend || '',
        status: statusKey(near),
        risk: targetRisk(t, near),
        eta: etaMin(t, near),
      })),
    });
  }

  function nearestTarget(now) {
    let best = null;
    for (const t of pointTargets()) {
      const near = nearOf(t, now);
      if (near && (!best || near.km < best.near.km)) best = { t, near };
    }
    return best;
  }

  // ---------- region card ----------

  function regionStatus(s) {
    const st = R ? R.statusOf(alertState.iot, s.uid) : 'N';
    const since = (R && R.alertSince(alertState.alerts, s.uid, s.name)) || (alertState.starts && alertState.starts[s.uid]) || null;
    const last = alertState.history && alertState.history[s.uid];
    return { s, st, since, last };
  }

  function statusCell(r, now) {
    if (!alertState.iot) return `<span class="h-b h-st unk">Немає даних</span>`;
    if (r.st === 'A') {
      const sub = r.since ? `<small>з ${R.formatTime(r.since)} · ${R.formatDuration(now - r.since) || '1 хв'}</small>` : '';
      return `<span class="h-b h-st alert">Тривога</span>${sub}`;
    }
    if (r.st === 'P') return `<span class="h-b h-st part">Частково</span>`;
    const sub = r.last && r.last.end ? `<small>ост. ${R.formatRange(r.last.start, r.last.end)}</small>` : '';
    return `<span class="h-b h-st calm">Спокійно</span>${sub}`;
  }

  function regionHtml(now) {
    if (!mine.length) {
      regionEl.dataset.risk = '0';
      return (
        `<div class="h-head">${ico('region')}<span class="h-title">Мої райони</span></div>` +
        `<div class="h-kv"><span class="h-k">Статус</span><span class="h-v"><span class="h-b none">Не обрано</span></span>` +
        `<span class="h-k">Де обрати</span><span class="h-v"><small>Налаштування → Мої райони</small></span></div>`
      );
    }
    const order = { A: 0, P: 1, N: 2 };
    const regs = mine.map(regionStatus).sort((a, b) => order[a.st] - order[b.st]);
    const main = regs[0];
    const more = regs.length > 1 ? `<span class="h-count" style="--h-cc:var(--h-steel)">+${regs.length - 1}</span>` : '';
    const otherAlerts = regs.slice(1).filter((r) => r.st === 'A').length;
    const best = nearestTarget(now);
    let risk = 0;
    for (const t of pointTargets()) risk = Math.max(risk, targetRisk(t, nearOf(t, now)));
    if (regs.some((r) => r.st === 'A')) risk = Math.max(risk, 1);
    regionEl.dataset.risk = String(risk);
    const dir = best && best.near.km >= 0.5 ? bearingFrom(best.near.shape, best.t, now) : null;
    const eta = best ? etaMin(best.t, best.near) : null;
    const err = alertState.error ? `<div class="h-foot"><span class="h-b note">${ico('warn')}${esc(alertState.error)}</span></div>` : '';
    return (
      `<div class="h-head">${ico('region')}<span class="h-title" title="${esc(regs.map((r) => r.s.name).join(', '))}">${esc(shortName(main.s.name))}</span>${more}</div>` +
      `<div class="h-kv">` +
      `<span class="h-k">Статус</span><span class="h-v">${statusCell(main, now)}${otherAlerts ? `<span class="h-b h-st alert">+${otherAlerts}</span>` : ''}</span>` +
      `<span class="h-k">Найближча</span><span class="h-v">${best ? `${typeChip(kindOf(best.t))}<span class="h-tname" style="--c:${metaOf(best.t).color}">${esc(nameText(best.t))}</span>` : '<span class="h-b none">немає</span>'}</span>` +
      `<span class="h-k">Відстань</span><span class="h-v">${distBadge(best && best.near)}</span>` +
      `<span class="h-k">Напрямок</span><span class="h-v">${dir == null ? `<span class="h-b none">—</span>` : `<span class="h-b dir">${arrowIco(dir)}${compass8(dir)}</span>`}</span>` +
      `<span class="h-k">ETA</span><span class="h-v">${eta == null ? `<span class="h-b none">${ico('clock')}—</span>` : etaBadge(eta)}</span>` +
      `<span class="h-k">Ризик</span><span class="h-v"><span class="h-risk l${risk}"><span class="seg"><i></i><i></i><i></i></span>${RISK[risk]}</span></span>` +
      `</div>${err}`
    );
  }

  // ---------- targets panel ----------

  function liveHtml() {
    const st = client.status;
    let text;
    if (st === 'live') text = client.updatedAt ? hhmmss(client.updatedAt) : '';
    else if (st === 'connecting') text = 'підключення';
    else text = client.updatedAt ? hhmm(client.updatedAt) : 'немає зв’язку';
    return `<span class="h-live"><i class="${st}"></i>${esc(text)}</span>`;
  }

  const countChip = (n, word) => `<span class="h-count"${n ? '' : ' style="--h-cc:var(--h-dim)"'}>${n} ${plural(n, word)}</span>`;
  const TARGET_WORD = ['ціль', 'цілі', 'цілей'];

  function listHtml(list, now) {
    const compact = list.length > FULL_ROWS;
    const max = compact ? COMPACT_ROWS : FULL_ROWS;
    const shown = list.slice(0, list.length > max ? max - 1 : max);
    let html = shown.map((t) => entryHtml(t, now, { compact, fresh: (freshUntil.get(t.id) || 0) > now })).join('');
    if (list.length > shown.length) html += `<div class="h-foot"><span class="h-b none">+${list.length - shown.length} ${plural(list.length - shown.length, TARGET_WORD)}</span></div>`;
    return `<div class="h-list">${html}</div>`;
  }

  function nearPanelHtml(now) {
    const close = closeTargets(now).map((x) => x.t);
    targetsEl.dataset.near = close.length ? '1' : '0';
    const head = `<div class="h-head">${ico('radar')}<span class="h-title">Поблизу ваших районів</span>${countChip(close.length, TARGET_WORD)}${liveHtml()}</div>`;
    if (!hasBase()) return head + `<div class="h-empty">Райони не обрано</div>`;
    if (close.length >= FULL_ROWS) return head + listHtml(close, now);
    // Room left: the next nearest targets beyond the radius, under a quiet divider.
    const ids = new Set(close.map((t) => t.id));
    const further = pointTargets()
      .filter((t) => !ids.has(t.id))
      .map((t) => ({ t, near: nearOf(t, now) }))
      .filter((x) => x.near)
      .sort((a, b) => a.near.km - b.near.km)
      .slice(0, close.length ? FULL_ROWS - close.length : 4)
      .map((x) => x.t);
    const fresh = (t) => (freshUntil.get(t.id) || 0) > now;
    let body = close.map((t) => entryHtml(t, now, { fresh: fresh(t) })).join('');
    if (!close.length) body += `<div class="h-sep">Поруч нікого · до ${opts.alertKm} км</div>`;
    if (further.length) body += (close.length ? `<div class="h-sep">Далі</div>` : '') + further.map((t) => entryHtml(t, now, { compact: true })).join('');
    return head + `<div class="h-list">${body}</div>`;
  }

  function detailsHtml(t, now) {
    const p = placeOf(t, now);
    const near = nearOf(t, now);
    const seen = lastSeen(t);
    const speed = t.velocity && t.velocity.speedKmh > 0 ? Math.round(t.velocity.speedKmh) : null;
    const n = t.sourceCount || 0;
    const conf = CONFIDENCE[t.displayConfidence || t.confidenceLevel];
    let note = '';
    if (t.areaOnly) note = 'Лише область';
    else if (t.destination) note = 'Розрахункова позиція';
    else if (p.flying && p.km > 0.5) note = `За курсом +${Math.round(p.km)} км`;
    else if (t.advisory) note = 'Спостереження';
    else if (t.status === 'stale') note = 'Застарілі дані';
    const course = p.heading == null ? `<span class="h-b none">—</span>` : `<span class="h-b dir">${arrowIco(p.angle == null ? p.heading : p.angle)}на ${compass8(p.heading)}<small>${Math.round(p.heading)}°</small></span>`;
    const o = originOf(t, now);
    const from = o ? `<span class="h-b dir">з ${compass8(o.bearing)}</span><small>${esc(originText(o))}${o.est ? ' · оцінка' : ''}</small>` : '—';
    const eta = etaMin(t, near);
    const risk = near ? targetRisk(t, near) : 0;
    const { kind, by } = classify(t);
    let typeCell = '';
    if (SHAHEDS.has(kind)) {
      // What told the kind: a post about the place (and its time), NEPTUN's own words, the speed.
      const h = hintCache.get(t.id);
      const chan = h && h.channel ? esc(h.channel.length > 18 ? h.channel.slice(0, 17) + '…' : h.channel) : 'пост';
      const why =
        by === 'post' && h && h.at
          ? `${chan} ${hhmm(h.at)}`
          : by === 'maybe' && h ? `можливо реактивний · ${chan}` : by === 'text' ? 'опис' : by === 'speed' ? `${speed} км/год` : by ? '' : 'ймовірно';
      typeCell = `<span class="h-k">Тип</span><span class="h-v">${kind === 'jet' ? '<span class="h-b jet">Реактивний</span>' : '<span class="h-b plain">Звичайний</span>'}${why ? `<small>${why}</small>` : ''}</span>`;
    } else {
      typeCell = `<span class="h-k">Точність</span><span class="h-v">${t.uncertaintyKm > 0 ? `±${Math.round(t.uncertaintyKm)}<small>км</small>` : '—'}</span>`;
    }
    targetsEl.dataset.near = risk ? '1' : '0';
    return (
      `<div class="h-head">${typeChip(kind)}<span class="h-title" style="color:color-mix(in srgb, ${metaOf(t).color} 45%, #fff)">${nameOf(t)}</span>${maybeJet(t)}${statusBadge(statusKey(near))}<button class="h-x ui nep-close" title="Закрити">×</button></div>` +
      `<div class="h-kv two">` +
      `<span class="h-k">Місце</span><span class="h-v">${placeBadge(placeShort(t))}</span>` +
      `<span class="h-k">Відстань</span><span class="h-v">${distBadge(near)}</span>` +
      `<span class="h-k">Звідки</span><span class="h-v">${from}</span>` +
      `<span class="h-k">Курс</span><span class="h-v">${course}</span>` +
      `<span class="h-k">Швидкість</span><span class="h-v">${speed ? `${speed}<small>км/год</small>` : '—'}</span>` +
      `<span class="h-k">ETA</span><span class="h-v">${eta == null ? '—' : etaBadge(eta)}</span>` +
      typeCell +
      `<span class="h-k">Згадка</span><span class="h-v">${seen ? `${hhmm(seen)}<small>${esc(ago(seen, now))}</small>` : '—'}</span>` +
      `<span class="h-k">Джерела</span><span class="h-v">${n || '—'}${conf ? `<small>${conf}</small>` : ''}</span>` +
      `<span class="h-k">Ризик</span><span class="h-v"><span class="h-risk l${risk}"><span class="seg"><i></i><i></i><i></i></span>${RISK[risk]}</span></span>` +
      `</div>` +
      detailsFoot(t, note)
    );
  }

  // Under the card: the note and the channels that wrote about the target (a click opens the channel).
  function detailsFoot(t, note) {
    const chips = sourcesOf(t).map((x) => {
      const url = channelUrl(x.channel);
      const body = `${esc(x.channel)}<small>${hhmm(x.at)}</small>`;
      const title = esc(x.text);
      return url
        ? `<a class="h-b src ui" href="${url}" target="_blank" title="${title}">${body}</a>`
        : `<span class="h-b src" title="${title}">${body}</span>`;
    });
    if (!note && !chips.length) return '';
    return `<div class="h-foot">${note ? `<span class="h-b note">${esc(note)}</span>` : ''}${chips.join('')}</div>`;
  }

  function groupPanelHtml(list, now) {
    return (
      `<div class="h-head">${typeChip(kindOf(list[0]))}<span class="h-title">Група цілей</span>${countChip(sumSize(list), TARGET_WORD)}<button class="h-x ui nep-close" title="Закрити">×</button></div>` +
      listHtml(list, now)
    );
  }

  function renderTargets(now) {
    const t = selected && client.threats.get(selected);
    const list = group ? group.map((id) => client.threats.get(id)).filter((x) => x && visible(x)).sort(bySeverity) : [];
    if (t && visible(t)) return setHtml(targetsEl, detailsHtml(t, now));
    if (list.length) return setHtml(targetsEl, groupPanelHtml(list, now));
    selected = group = null;
    setHtml(targetsEl, nearPanelHtml(now));
  }

  // ---------- count tiles ----------

  const hist = new Map(); // tile key -> counts, one per HIST_EVERY
  const tileEls = new Map(); // tile key -> element
  let sampled = false;

  function counts(now) {
    const points = pointTargets();
    const out = { total: sumSize(points) + targets().filter((t) => t.areaOnly).length, near: hasBase() ? closeTargets(now).length : 0 };
    for (const kind of ORDER) out['k:' + kind] = sumSize(points.filter((t) => kindOf(t) === kind));
    return out;
  }

  function sample(now) {
    for (const [key, n] of Object.entries(counts(now))) {
      const h = hist.get(key) || [];
      h.push(n);
      if (h.length > HIST_POINTS) h.shift();
      hist.set(key, h);
    }
  }

  // History plus the value now as the last point.
  const series = (key, now) => [...(hist.get(key) || []), now];

  function sparkPaths(values) {
    if (values.length < 2) return '';
    const max = Math.max(4, ...values);
    const step = 60 / (HIST_POINTS - 1);
    const x0 = 60 - (values.length - 1) * step;
    const pts = values.map((v, i) => `${(x0 + i * step).toFixed(1)},${(30 - (v / max) * 27).toFixed(1)}`);
    const lineD = 'M' + pts.join('L');
    return `<path class="area" d="${lineD}L60,30L${x0.toFixed(1)},30Z"/><path class="line" d="${lineD}"/>`;
  }

  function putTile(key, { color, icon, label, value, sub = '', values, hot = false, data }) {
    let el = tileEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'nep-tile ui';
      Object.assign(el.dataset, data);
      tileEls.set(key, el);
    }
    el.style.setProperty('--c', color);
    el.classList.toggle('hot', hot);
    setHtml(
      el,
      `<div class="nep-tl">${icon}<span>${esc(label)}</span></div>` +
        `<div class="nep-tn">${value}${sub ? `<span class="nep-ts">${sub}</span>` : ''}</div>` +
        `<svg class="nep-spark" viewBox="0 0 60 30" preserveAspectRatio="none">${sparkPaths(values)}</svg>`,
    );
    tilesEl.appendChild(el); // calls come in display order
  }

  function renderTiles(now) {
    const used = new Set();
    tilesEl.hidden = !opts.panel;
    if (opts.panel) {
      const c = counts(now);
      const points = pointTargets();
      const noCourse = points.filter((t) => courseless(t, now)).length; // like "ще N без курсу" on the NEPTUN map
      const close = hasBase() ? closeTargets(now) : [];
      putTile('total', { color: '#9fb3c8', icon: ico('radar'), label: 'Усього', value: c.total, sub: noCourse ? `${noCourse} без курсу` : '', values: series('total', c.total), data: { all: '1' } });
      used.add('total');
      for (const kind of ORDER) {
        const key = 'k:' + kind;
        if (kind === 'fpv' && opts.hideFpv) continue;
        if (!c[key] && !(hist.get(key) || []).some((v) => v > 0)) continue; // a type seen in the last 30 min stays
        const k = close.filter((x) => kindOf(x.t) === kind).length;
        putTile(key, {
          color: TYPES[kind].color,
          icon: typeIcon(kind),
          label: TYPES[kind].tile || TYPES[kind].short,
          value: c[key],
          sub: k ? `поруч ${k}` : '',
          values: series(key, c[key]),
          data: { type: kind },
        });
        used.add(key);
      }
      if (hasBase()) {
        putTile('near', {
          color: '#ff9f43',
          icon: ico('pin'),
          label: 'Біля вас',
          value: close.length,
          sub: `до ${opts.alertKm} км`,
          values: series('near', close.length),
          hot: close.length > 0,
          data: { near: '1' },
        });
        used.add('near');
      }
    }
    for (const [key, el] of tileEls) {
      if (used.has(key)) continue;
      el.remove();
      tileEls.delete(key);
    }
  }

  // Tiles in even rows that fill the width: 7 tiles become 4 + 3, never 6 + 1 with a gap.
  function balance(box, minWidth, gap = 6) {
    if (!box) return;
    const n = box.children.length;
    const width = box.clientWidth - 16; // horizontal padding
    if (!n || width <= 0) return;
    const fit = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
    const rows = Math.ceil(n / fit);
    const cols = String(Math.ceil(n / rows));
    if (box.style.getPropertyValue('--cols') !== cols) box.style.setProperty('--cols', cols);
  }

  // The targets panel goes left or right of the region card; one column on a narrow widget.
  function layoutDock() {
    dock.classList.toggle('right', opts.cardSide === 'right');
    dock.classList.toggle('narrow', dock.clientWidth < 520);
    balance(tilesEl, 140);
    balance($('sys'), 168);
  }

  // Grows the widget once when the dock and tiles would squeeze the map (as widget.js does for the PC tiles).
  let fittedFor = 0;
  function fitWindow() {
    if (!bridge.fitHeight) return;
    const h = (el) => (el && !el.hidden ? el.getBoundingClientRect().height : 0);
    const extra = Math.ceil(h(tickerEl) + h(dock) + h(tilesEl) + h($('sys')));
    if (!extra || extra === fittedFor) return;
    fittedFor = extra;
    const need = Math.ceil(innerWidth * 0.68 + extra);
    if (innerHeight < need - 20) bridge.fitHeight(need);
  }

  // ---------- selection ----------

  function select(id) {
    selected = id && client.threats.has(id) ? id : null;
    group = null;
    hideTip();
    refresh();
  }

  function selectGroup(ids) {
    selected = null;
    group = ids && ids.length ? ids : null;
    hideTip();
    refresh();
  }

  // Next target of a list after the selected one (newest first).
  function cycle(list) {
    list = list.sort((a, b) => (lastSeen(b) || 0) - (lastSeen(a) || 0));
    if (!list.length) return;
    const i = list.findIndex((t) => t.id === selected);
    select(list[(i + 1) % list.length].id);
  }

  // ---------- tooltip ----------

  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = ev.clientX + 14;
    let y = ev.clientY + 14;
    if (x + w > innerWidth - 4) x = Math.max(4, ev.clientX - w - 10);
    if (y + h > innerHeight - 4) y = Math.max(4, ev.clientY - h - 10);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hideTip() {
    tip.style.display = 'none';
  }

  // Where the information about a target comes from: the channels that wrote about its place lately
  // (intel.js: name, time, the line) and how many sources NEPTUN counted.
  const CONFIRM_WORD = ['підтвердження', 'підтвердження', 'підтверджень'];
  const sourcesOf = (t) => (intel ? intel.sources(t, kindOf(t), 3) : []);
  const channelUrl = (c) => (/^@[A-Za-z0-9_]{4,32}$/.test(c) ? `https://t.me/${c.slice(1)}` : null);

  function sourcesTip(t) {
    const n = t.sourceCount || 0;
    const list = sourcesOf(t);
    const head = `<div class="tt-k">Джерела${n ? `<small>${n} ${plural(n, CONFIRM_WORD)}</small>` : ''}</div>`;
    const rows = list.length
      ? list.map((x) => `<div class="tt-sr"><b>${esc(x.channel)}</b><i>${hhmm(x.at)}</i><span>${esc(x.text)}</span></div>`).join('')
      : '<div class="tt-sr"><b>NEPTUN</b><span>зведення моніторингових каналів</span></div>';
    return `<div class="tt-src">${head}${rows}</div>`;
  }

  // One channel calls it jet, but neither the Air Force nor a second channel does: counted as an ordinary Shahed.
  const maybeJet = (t) => (classify(t).by === 'maybe' ? '<span class="h-b note">можливо реактивний</span>' : '');

  function targetTip(t, now, edge) {
    const near = nearOf(t, now);
    const p = placeOf(t, now);
    const region = regionLine(t);
    return (
      `<div class="tt-h" style="--c:${metaOf(t).color}">${typeChip(kindOf(t))}<b>${nameOf(t)}</b>${maybeJet(t)}</div>` +
      `<div class="tt-p">${placeHtml(t)}${region ? `<span>${region}</span>` : ''}</div>` +
      `<div class="tt-b">${statusBadge(statusKey(near))}${distBadge(near)}${courseBadge(p)}${etaBadge(etaMin(t, near))}</div>` +
      (near && near.km >= 0.5 ? `<div class="tt-s">до ${esc(shortName(near.name))}</div>` : '') +
      (edge ? '<div class="tt-s">за межами карти</div>' : '') +
      sourcesTip(t)
    );
  }

  function listTip(title, list, now) {
    const rows = list
      .slice(0, 10)
      .map((t) => {
        const near = nearOf(t, now);
        return (
          `<li style="--c:${metaOf(t).color}">${typeIcon(kindOf(t))}` +
          `<span>${esc(nameText(t))}${t.count > 1 ? ` ×${t.count}` : ''}<small>${esc(areaText(t))}</small></span>${distBadge(near)}</li>`
        );
      })
      .join('');
    const more = list.length > 10 ? `<div class="tt-s">+${list.length - 10}</div>` : '';
    return `<div class="tt-h"><b>${esc(title)}</b></div>${list.length ? `<ul>${rows}</ul>${more}` : '<div class="tt-s">зараз немає</div>'}`;
  }

  // Targets behind a tile: all, one kind, or the close ones.
  function tileList(el, now) {
    if (el.dataset.all) return targets();
    if (el.dataset.near) return closeTargets(now).map((x) => x.t);
    return pointTargets().filter((t) => kindOf(t) === el.dataset.type);
  }

  function tileHead(el) {
    if (el.dataset.all) return 'Усі цілі';
    if (el.dataset.near) return `До ${opts.alertKm} км від вас`;
    return TYPES[el.dataset.type].label;
  }

  document.addEventListener('mousemove', (ev) => {
    const now = Date.now();
    const mk = ev.target.closest && ev.target.closest('.nep-marker');
    if (mk && mk.dataset.ids && !svg.classList.contains('nep-panning')) {
      const list = mk.dataset.ids.split(',').map((id) => client.threats.get(id)).filter(Boolean);
      setHover(list.length === 1 ? list[0].id : null);
      if (list.length === 1 && list[0].id !== selected) return showTip(targetTip(list[0], now, mk.classList.contains('edge')), ev);
      if (list.length > 1) return showTip(listTip(`Група ×${sumSize(list)}`, list.sort(bySeverity), now), ev);
    } else setHover(null);
    const bm = ev.target.closest && ev.target.closest('.nep-boom');
    if (bm && booms[bm.dataset.boom]) return showTip(boomTip(booms[bm.dataset.boom], now), ev);
    const tile = ev.target.closest && ev.target.closest('.nep-tile');
    if (tile) return showTip(listTip(tileHead(tile), tileList(tile, now), now), ev);
    hideTip();
  });
  document.addEventListener('mouseleave', hideTip);

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('.nep-marker, .nep-tile, .h-ent, .nep-close');
    if (!el) return;
    if (el.classList.contains('nep-close')) return select(null);
    if (el.classList.contains('nep-marker')) {
      const ids = (el.dataset.ids || '').split(',').filter(Boolean);
      if (ids.length === 1) return select(ids[0] === selected ? null : ids[0]);
      const same = group && ids.length === group.length && ids.every((id) => group.includes(id));
      return same ? select(null) : selectGroup(ids);
    }
    if (el.classList.contains('h-ent')) return select(el.dataset.id);
    cycle(tileList(el, Date.now()));
  });

  // ---------- events line (ticker.js) ----------

  const oblastShort = (uid) => {
    const o = R.OBLAST_BY_UID[uid];
    return o ? shortName(o.name).replace('Автономна Республіка Крим', 'АР Крим') : '';
  };
  // Raion, oblast of a point of the map ("Миколаївський р-н, Миколаївська обл.").
  function oblastAtMap(x, y) {
    const r = land.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1 && Geo.insideRings(q.rings, x, y));
    if (!r) return '';
    const ob = R.isRaion(r.uid) ? R.oblastOf(r.uid) : null;
    return [R.isRaion(r.uid) ? shortName(r.name) : '', ob ? oblastShort(ob) : shortName(r.name)].filter(Boolean).join(', ');
  }

  // Alerts and all-clears from the IoT string of alerts.in.ua: one line per oblast and change —
  // the oblast when all of it changed, else its raions (two named, then "+N").
  let alertPrev = null; // uid -> under alert
  function alertEvents(iot) {
    if (!iot || !ticker || !opts.ticker) return;
    const now = new Map();
    for (const uid of shapeIndex.keys()) now.set(uid, R.statusOf(iot, uid) !== 'N');
    const prev = alertPrev;
    alertPrev = now;
    if (!prev) return; // the state at start is not news
    const byOblast = new Map();
    for (const [uid, on] of now) {
      const ob = R.isRaion(uid) ? R.oblastOf(uid) : uid;
      if (!byOblast.has(ob)) byOblast.set(ob, []);
      byOblast.get(ob).push({ uid, on, was: !!prev.get(uid) });
    }
    const named = (list) => list.slice(0, 2).map((x) => shortName(shapeIndex.get(x.uid).name)).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
    for (const [ob, list] of byOblast) {
      const started = list.filter((x) => x.on && !x.was);
      const ended = list.filter((x) => !x.on && x.was);
      const whole = (part) => part.length === list.length || list.length === 1;
      if (started.length) ticker.push({ kind: 'alert', title: 'Тривога', place: whole(started) ? oblastShort(ob) : `${named(started)}, ${oblastShort(ob)}`, source: 'alerts.in.ua' });
      if (ended.length) ticker.push({ kind: 'clear', title: 'Відбій', place: whole(ended) || !list.some((x) => x.on) ? oblastShort(ob) : `${named(ended)}, ${oblastShort(ob)}`, source: 'alerts.in.ua' });
    }
  }

  // New targets: one line per kind and oblast ("Шахеди ×3 · Чернігівська обл."); the channel that wrote
  // about them is looked up when the line is drawn, as the posts come in up to 30 s later.
  const seenTargets = new Set();
  let targetsReady = false;
  function newTargets() {
    const fresh = client.list().filter((t) => !seenTargets.has(t.id));
    for (const t of fresh) seenTargets.add(t.id);
    if (seenTargets.size > 5000) seenTargets.clear();
    if (!targetsReady) return (targetsReady = true); // the snapshot at start is not news
    if (!ticker || !opts.ticker || !opts.markers) return;
    const groups = new Map();
    for (const t of fresh.filter(visible)) {
      const key = `${kindOf(t)}|${t.region || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const list of groups.values()) {
      const t = list[0];
      const n = list.reduce((s, x) => s + sizeOf(x), 0);
      const region = t.region ? shortName(t.region) : '';
      const place = list.length === 1 ? [t.locality !== t.region ? t.locality : '', t.district ? shortName(t.district) : '', region].filter(Boolean).join(', ') : region;
      const title = n > 1 ? `${nameText({ ...t, count: 2 })} ×${n}` : nameText(t);
      const source = () => {
        const src = intel ? intel.sources(t, kindOf(t), 1)[0] : null;
        return src ? src.channel : 'NEPTUN';
      };
      // a click on the line picks the target (or the first of the group) and brings it into view
      const go = () => {
        const cur = client.threats.get(t.id);
        if (!cur || !project) return;
        const p = predict(cur, Date.now());
        const [x, y] = project(p.lat, p.lon);
        if (window.NeptunZoom) window.NeptunZoom.centerOn(x, y, Math.max(4, window.NeptunZoom.zoom));
        select(cur.id);
      };
      ticker.push({ kind: 'target', title, place: place || 'Україна', source, go });
    }
  }

  // ---------- zoom (zoom.js) ----------

  svg.addEventListener('nep-zoom', () => opts.markers && refresh());
  svg.addEventListener('nep-zoom-mine', () => {
    if (!hasBase() || !window.NeptunZoom) return;
    if (home && !mine.length) return window.NeptunZoom.centerOn(home.x, home.y, 12);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of mine) {
      for (const r of rings(s)) {
        for (const [x, y] of r) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    window.NeptunZoom.fit(x0, y0, x1, y1);
  });

  // ---------- data / settings ----------

  function refresh() {
    const now = Date.now();
    nearCache.clear();
    const entered = trackNear(now);
    if (quiet) quiet = false;
    else alertEntered(entered, now);
    layer.style.display = opts.markers ? '' : 'none';
    tickerEl.hidden = !ticker || !opts.ticker;
    credit.classList.toggle('no-targets', !opts.markers);
    document.body.classList.toggle('nep-hud', opts.markers); // the region card replaces widget.js's status line
    renderMarkers(now);
    dock.hidden = !opts.markers;
    if (dock.hidden) {
      tilesEl.hidden = true;
      return;
    }
    if (!sampled && client.status === 'live') {
      sampled = true;
      sample(now);
    }
    setHtml(regionEl, regionHtml(now));
    renderTargets(now);
    renderTiles(now);
    layoutDock();
    fitWindow();
  }

  function renderAll() {
    drawAreas();
    refresh();
  }

  function applySettings(s) {
    const prev = opts;
    opts = { ...DEFAULTS, ...((s && s.neptun) || {}) };
    document.body.classList.toggle('nep-calm', opts.style === 'calm'); // "Акуратний" look under the map
    if (s && Number.isFinite(s.volume)) volume = s.volume;
    mine = ((s && s.regions) || []).map((uid) => shapeIndex.get(Number(uid))).filter(Boolean);
    const h = opts.home;
    home = h && Number.isFinite(h.lat) && Number.isFinite(h.lon) && project ? { lat: h.lat, lon: h.lon, ...xy(h.lat, h.lon) } : null;
    const zoomBar = $('nep-zoom');
    if (zoomBar) zoomBar.classList.toggle('has-mine', hasBase());
    quiet = prev.markers; // a settings change re-baselines the close targets without a banner
    if (opts.markers && !prev.markers) {
      client.start();
      if (intel) intel.start();
    }
    if (!opts.markers && prev.markers) {
      client.stop();
      if (intel) intel.stop();
    }
    renderAll();
  }

  if (intel) intel.onUpdate(() => opts.markers && renderAll()); // new posts can change jet / plain

  client.subscribe((kind) => {
    if (kind === 'data') {
      newTargets();
      renderAll();
    }
    else if (!dock.hidden && !selected && !group) setHtml(targetsEl, nearPanelHtml(Date.now())); // live time in the title
  });

  (async () => {
    const map = await bridge.getMapData();
    const proj = map.proj || DEFAULT_PROJ;
    project = Geo.mapProjector(proj);
    projDef = proj;
    kmPerUnit = 1 / (proj.k * 1000);
    for (const r of map.raions) shapeIndex.set(r.uid, { uid: r.uid, name: r.name, d: r.d });
    for (const o of map.oblasts) oblastIndex.set(normOblast(o.name), o);
    land = map.raions.map((r) => {
      const rr = Geo.pathRings(r.d);
      const xs = rr.flat().map((p) => p[0]);
      const ys = rr.flat().map((p) => p[1]);
      return { uid: r.uid, name: r.name, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), rings: rr };
    });
    if (bridge.getState) alertState = (await bridge.getState()) || {};
    alertEvents(alertState.iot); // the state at start: what later changes are compared with
    // widget.js rebuilds the PC tiles every 2 s; keep their rows even.
    if ($('sys')) new MutationObserver(() => balance($('sys'), 168)).observe($('sys'), { childList: true });
    if (bridge.onState) {
      bridge.onState((s) => {
        alertState = s || {};
        alertEvents(alertState.iot);
        if (!dock.hidden) setHtml(regionEl, regionHtml(Date.now()));
      });
    }
    applySettings(await bridge.getSettings());
    bridge.onSettings(applySettings);
    setInterval(() => opts.markers && refresh(), MOVE_EVERY);
    setInterval(() => opts.markers && sample(Date.now()), HIST_EVERY);
    addEventListener('resize', () => opts.markers && refresh());
  })();
})();
