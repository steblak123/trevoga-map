// Targets layer of widget.html (data: NEPTUN API): targets on the map with where they came from and
// where they head; under the map a tactical HUD dock — a region card (status, nearest target, distance,
// direction, ETA, risk), a panel of targets near your regions, count tiles — and a short banner when
// a target comes close. Nothing is written over the map itself.
// Talks to widget.js only through the DOM (#map, #wrap, #status, #sys) and window.bridge.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const { TYPES, ORDER, typeMeta, kindOf, predict } = window.NeptunTypes;
  const Geo = window.Geo;
  const R = window.Regions;
  const bridge = window.bridge;
  const ipc = bridge.neptun || null; // preload.js hook; without it there is no banner
  // Projection of app/assets/map.json (see build/make-map.js), for a map.json without "proj".
  const DEFAULT_PROJ = { lat1: 45, lat2: 51, lat0: 48.5, lon0: 31.5, x0: -690178, y1: 432316, k: 0.000755630581276381 };
  const DEFAULTS = { markers: true, panel: true, hideFpv: false, alert: true, alertKm: 20, alertSound: false, cardSide: 'left' };
  const BADGE_PX = 9; // marker radius on screen
  const CLUSTER_PX = 15; // markers closer than this on screen become one "×N" marker
  const EDGE_PAD_PX = 13; // targets beyond the visible map are pinned this far inside its edge
  const MOVE_EVERY = 2000; // ms between dead-reckoning steps
  const COURSE_KM = 60; // course line of the selected target
  const HOME_KM = 50; // drones without a course are drawn only this close to your regions (as NEPTUN does)
  const FULL_ROWS = 3; // up to this many close targets get a two-line entry…
  const COMPACT_ROWS = 6; // …more get one line each
  const HIST_EVERY = 30000; // count tiles: one sample per 30 s…
  const HIST_POINTS = 60; // …for the last 30 minutes
  const DRONES = new Set(['uav', 'jet', 'recon']);
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

  let opts = { ...DEFAULTS, markers: false }; // applySettings() starts the client if enabled
  let volume = 0.7;
  let project = null; // (lat, lon) -> [x, y] in map units
  let kmPerUnit = 1;
  const shapeIndex = new Map(); // raion / city uid -> { uid, name, d, rings? }
  const oblastIndex = new Map(); // normalized oblast name -> { uid, name, d }
  let land = []; // [{ x0, y0, x1, y1, rings }] of every raion: is a point over Ukraine
  let mine = []; // shapes of the selected ("my") regions
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
  const markerLayer = svgEl('g', { id: 'nep-markers' });
  layer.append(areaLayer, trackLayer, selLayer, markerLayer);
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
  if ($('sys')) $('sys').before(dock, tilesEl);
  else ($('status') || svg).after(dock, tilesEl);
  const tip = document.createElement('div');
  tip.id = 'nep-tip';
  $('wrap').appendChild(tip);

  // Clicks on our elements must not drag the widget or open the settings (widget.js listens on document).
  for (const el of [dock, tilesEl, markerLayer]) {
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
  const nameOf = (t) => esc(t.title || metaOf(t).short) + (t.count > 1 ? `<em>×${t.count}</em>` : '');

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
  const courseless = (t, now) => DRONES.has(kindOf(t)) && predict(t, now).heading == null;

  // Drones without a course are not drawn unless close to your regions (or picked): they are in the tiles.
  function onMap(t, now) {
    if (t.id === selected || (group && group.includes(t.id)) || !courseless(t, now)) return true;
    const near = nearOf(t, now);
    return !!near && near.km <= HOME_KM;
  }
  const mapTargets = (now) => pointTargets().filter((t) => onMap(t, now));

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
    if (!mine.length || t.areaOnly || !project) return null;
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
  const courseBadge = (p) => (p.heading == null ? '' : `<span class="h-b dir">${arrowIco(p.angle == null ? p.heading : p.angle)}${compass8(p.heading)}</span>`);
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
      : placeBadge(placeShort(t)) + distBadge(near) + courseBadge(p) + etaBadge(etaMin(t, near));
    return (
      `<button class="${cls}" data-id="${esc(t.id)}" style="--c:${metaOf(t).color}">${typeChip(kindOf(t))}` +
      `<span class="h-ent-name">${nameOf(t)}</span>${statusBadge(statusKey(near))}<span class="h-ent-badges">${badges}</span></button>`
    );
  }

  // ---------- markers ----------

  function makeMarker() {
    const el = svgEl('g', { class: 'nep-marker ui' });
    // Course pointer outside the badge (towards the target for an off-map one); hidden without a course.
    const ptr = svgEl('path', { class: 'ptr', d: 'M0-21.5 6.2-11.6H-6.2Z' });
    el.append(svgEl('circle', { class: 'pulse', r: 11 }), ptr, svgEl('circle', { class: 'halo', r: 11 }));
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
        return { t, p, x, y, edge, edgeAngle: edge ? (Math.atan2(p.x - x, y - p.y) * 180) / Math.PI : null };
      });
    const limit = CLUSTER_PX * unitsPerPx;
    const groups = [];
    let sel = null;
    for (const it of items) {
      if (it.t.id === selected) {
        sel = [it];
        continue;
      }
      const g = groups.find((g) => g[0].edge === it.edge && Math.hypot(g[0].x - it.x, g[0].y - it.y) < limit);
      if (g) g.push(it);
      else groups.push([it]);
    }
    // Drawing order: lower severity first, the selected target last (on top).
    const units = groups.map(unitOf).reverse();
    if (sel) units.push(unitOf(sel));
    return units;
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
      cls.toggle('sel', u.sel || (!!group && u.ids.some((id) => group.includes(id))));
      m.el.style.display = '';
    });
    for (let i = units.length; i < pool.length; i++) {
      pool[i].el.style.display = 'none';
      pool[i].el.dataset.ids = '';
    }
    drawTracks(now);
    drawSelection(now);
  }

  // Tracks are drawn only where they matter, so many targets do not turn into a mess of bands:
  // the picked target, missiles / ballistics / jets / aviation, and targets close to your regions.
  // Every other one shows its course by the pointer on its marker.
  function wantsTrack(t, now) {
    if (t.id === selected) return true;
    const kind = kindOf(t);
    if (FAST.has(kind) && kind !== 'kab') return true;
    const near = nearOf(t, now);
    return !!near && near.km <= Math.max(opts.alertKm * 3, 30);
  }

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
      if (pts.length > 1 && len * kmPerUnit > 1.5) {
        // where it came from: fades in from the first report to the position now
        const color = metaOf(t).color;
        const stroke = fade(pts[0], pts[pts.length - 1], [[0, color, 0.15], [1, color, 1]]);
        g.appendChild(svgEl('polyline', { class: 'from', stroke, points: pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') }));
        g.appendChild(svgEl('circle', { class: 'start', cx: pts[0][0].toFixed(2), cy: pts[0][1].toFixed(2), r: (2.2 * unitsPerPx).toFixed(3) }));
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
    if (!opts.markers || !mine.length) {
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
        title: (t.title || metaOf(t).short) + (t.count > 1 ? ` ×${t.count}` : ''),
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
      `<span class="h-k">Найближча</span><span class="h-v">${best ? `${typeChip(kindOf(best.t))}<span class="h-tname" style="--c:${metaOf(best.t).color}">${esc(best.t.title || metaOf(best.t).short)}</span>` : '<span class="h-b none">немає</span>'}</span>` +
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
    if (!mine.length) return head + `<div class="h-empty">Райони не обрано</div>`;
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
    else if (t.status === 'stale') note = 'Давні дані';
    const course = p.heading == null ? `<span class="h-b none">—</span>` : `<span class="h-b dir">${arrowIco(p.angle == null ? p.heading : p.angle)}${compass8(p.heading)}<small>${Math.round(p.heading)}°</small></span>`;
    const eta = etaMin(t, near);
    const risk = near ? targetRisk(t, near) : 0;
    targetsEl.dataset.near = risk ? '1' : '0';
    return (
      `<div class="h-head">${typeChip(kindOf(t))}<span class="h-title" style="color:color-mix(in srgb, ${metaOf(t).color} 45%, #fff)">${nameOf(t)}</span>${statusBadge(statusKey(near))}<button class="h-x ui nep-close" title="Закрити">×</button></div>` +
      `<div class="h-kv two">` +
      `<span class="h-k">Місце</span><span class="h-v">${placeBadge(placeShort(t))}</span>` +
      `<span class="h-k">Відстань</span><span class="h-v">${distBadge(near)}</span>` +
      `<span class="h-k">Курс</span><span class="h-v">${course}</span>` +
      `<span class="h-k">Швидкість</span><span class="h-v">${speed ? `${speed}<small>км/год</small>` : '—'}</span>` +
      `<span class="h-k">ETA</span><span class="h-v">${eta == null ? '—' : etaBadge(eta)}</span>` +
      `<span class="h-k">Згадка</span><span class="h-v">${seen ? `${hhmm(seen)}<small>${esc(ago(seen, now))}</small>` : '—'}</span>` +
      `<span class="h-k">Джерела</span><span class="h-v">${n || '—'}${conf ? `<small>${conf}</small>` : ''}</span>` +
      `<span class="h-k">Ризик</span><span class="h-v"><span class="h-risk l${risk}"><span class="seg"><i></i><i></i><i></i></span></span>${t.uncertaintyKm > 0 ? `<small>±${Math.round(t.uncertaintyKm)} км</small>` : ''}</span>` +
      `</div>` +
      (note ? `<div class="h-foot"><span class="h-b note">${esc(note)}</span></div>` : '')
    );
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
    const out = { total: sumSize(points) + targets().filter((t) => t.areaOnly).length, near: mine.length ? closeTargets(now).length : 0 };
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
      const noCourse = points.filter((t) => courseless(t, now)).length;
      const close = mine.length ? closeTargets(now) : [];
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
      if (mine.length) {
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
    const extra = Math.ceil(h(dock) + h(tilesEl) + h($('sys')));
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

  function targetTip(t, now, edge) {
    const near = nearOf(t, now);
    const p = placeOf(t, now);
    const region = regionLine(t);
    return (
      `<div class="tt-h" style="--c:${metaOf(t).color}">${typeChip(kindOf(t))}<b>${nameOf(t)}</b></div>` +
      `<div class="tt-p">${placeHtml(t)}${region ? `<span>${region}</span>` : ''}</div>` +
      `<div class="tt-b">${statusBadge(statusKey(near))}${distBadge(near)}${courseBadge(p)}${etaBadge(etaMin(t, near))}</div>` +
      (near && near.km >= 0.5 ? `<div class="tt-s">до ${esc(shortName(near.name))}</div>` : '') +
      (edge ? '<div class="tt-s">за межами карти</div>' : '')
    );
  }

  function listTip(title, list, now) {
    const rows = list
      .slice(0, 10)
      .map((t) => {
        const near = nearOf(t, now);
        return `<li style="--c:${metaOf(t).color}">${typeIcon(kindOf(t))}<span>${esc(t.title || metaOf(t).short)}${t.count > 1 ? ` ×${t.count}` : ''}</span>${distBadge(near)}</li>`;
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
      if (list.length === 1 && list[0].id !== selected) return showTip(targetTip(list[0], now, mk.classList.contains('edge')), ev);
      if (list.length > 1) return showTip(listTip(`Група ×${sumSize(list)}`, list.sort(bySeverity), now), ev);
    }
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

  // ---------- zoom (zoom.js) ----------

  svg.addEventListener('nep-zoom', () => opts.markers && refresh());
  svg.addEventListener('nep-zoom-mine', () => {
    if (!mine.length || !window.NeptunZoom) return;
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
    if (s && Number.isFinite(s.volume)) volume = s.volume;
    mine = ((s && s.regions) || []).map((uid) => shapeIndex.get(Number(uid))).filter(Boolean);
    const zoomBar = $('nep-zoom');
    if (zoomBar) zoomBar.classList.toggle('has-mine', mine.length > 0);
    quiet = prev.markers; // a settings change re-baselines the close targets without a banner
    if (opts.markers && !prev.markers) client.start();
    if (!opts.markers && prev.markers) client.stop();
    renderAll();
  }

  client.subscribe((kind) => {
    if (kind === 'data') renderAll();
    else if (!dock.hidden && !selected && !group) setHtml(targetsEl, nearPanelHtml(Date.now())); // live time in the title
  });

  (async () => {
    const map = await bridge.getMapData();
    const proj = map.proj || DEFAULT_PROJ;
    project = Geo.mapProjector(proj);
    kmPerUnit = 1 / (proj.k * 1000);
    for (const r of map.raions) shapeIndex.set(r.uid, { uid: r.uid, name: r.name, d: r.d });
    for (const o of map.oblasts) oblastIndex.set(normOblast(o.name), o);
    land = map.raions.map((r) => {
      const rr = Geo.pathRings(r.d);
      const xs = rr.flat().map((p) => p[0]);
      const ys = rr.flat().map((p) => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), rings: rr };
    });
    if (bridge.getState) alertState = (await bridge.getState()) || {};
    // widget.js rebuilds the PC tiles every 2 s; keep their rows even.
    if ($('sys')) new MutationObserver(() => balance($('sys'), 168)).observe($('sys'), { childList: true });
    if (bridge.onState) {
      bridge.onState((s) => {
        alertState = s || {};
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
