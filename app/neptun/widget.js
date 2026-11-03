// Targets layer of widget.html (data: NEPTUN API): targets on the map with where they came from and
// where they head, an info window and count tiles under the map (styled like the PC load tiles), and
// a short banner when a target comes close. Nothing is written over the map itself.
// Talks to widget.js only through the DOM (#map, #wrap, #status, #sys) and window.bridge.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const { TYPES, ORDER, typeMeta, kindOf, predict } = window.NeptunTypes;
  const Geo = window.Geo;
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
  const INFO_ROWS = 4; // lines under the title of the info window
  const HIST_EVERY = 30000; // count tiles: one sample per 30 s…
  const HIST_POINTS = 60; // …for the last 30 minutes
  const DRONES = new Set(['uav', 'jet', 'recon']);
  const CONFIDENCE = { high: 'висока', medium: 'середня', low: 'низька' };

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
  let selected = null; // id of the target in the info window
  let group = null; // ids of the "×N" group in the info window
  let unitsPerPx = 0;
  const pool = []; // marker elements, reused in drawing order
  const nearCache = new Map(); // id -> { km, name, trend } for the current render pass

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

  // Under the map, next to the PC load tiles: the info window and the count tiles in one grid.
  const box = document.createElement('div');
  box.id = 'nep-box';
  const info = document.createElement('div');
  info.className = 'nep-info ui';
  box.appendChild(info);
  if ($('sys')) $('sys').before(box);
  else ($('status') || svg).after(box);
  const tip = document.createElement('div');
  tip.id = 'nep-tip';
  $('wrap').appendChild(tip);

  // Clicks on our elements must not drag the widget or open the settings (widget.js listens on document).
  for (const el of [box, markerLayer]) {
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
  const shortName = (name) => (window.Regions && window.Regions.shortName ? window.Regions.shortName(name) : name);
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const lastSeen = (t) => Date.parse(t.confirmedAt || t.updatedAt) || null;
  const metaOf = (t) => typeMeta(kindOf(t));
  const bySeverity = (a, b) => metaOf(b).severity - metaOf(a).severity || (lastSeen(b) || 0) - (lastSeen(a) || 0);
  const sizeOf = (t) => (t.count > 1 ? t.count : 1);
  const sumSize = (list) => list.reduce((s, t) => s + sizeOf(t), 0);

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
    if (min < 60) return `${min} хв тому`;
    return `${Math.floor(min / 60)} год ${min % 60} хв тому`;
  }

  function sinceText(ms, now) {
    const min = Math.floor((now - ms) / 60000);
    if (min < 1) return 'щойно';
    return min < 60 ? `поруч ${min} хв` : `поруч ${Math.floor(min / 60)} год ${min % 60} хв`;
  }

  const iconSvg = (kind, cls = 'nep-ico') => `<svg class="${cls}" viewBox="-12 -12 24 24">${typeMeta(kind).icon}</svg>`;
  const titleOf = (t) => esc(t.title || metaOf(t).short) + (t.count > 1 ? ` <span class="nep-x">×${t.count}</span>` : '');

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

  // "Курс → Лозова" when the message named only where the target flies, otherwise the place itself.
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

  // Targets the user wants to see: the FPV filter applies to the map, the window, tiles and banners alike.
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

  // Nearest selected region to a map point: { km, name } (km = 0 inside it).
  function nearestAt(x, y) {
    let best = null;
    for (const s of mine) {
      const r = rings(s);
      const km = Geo.insideRings(r, x, y) ? 0 : Geo.ringsDistance(r, x, y) * kmPerUnit;
      if (!best || km < best.km) best = { km, name: s.name };
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

  const whereText = (near) =>
    near.km < 0.5 ? `над районом ${esc(shortName(near.name))}` : `≈ ${Math.round(near.km)} км · ${esc(shortName(near.name))}`;
  const distanceText = (near) => (near ? whereText(near) + (near.trend && near.km >= 0.5 ? ` · ${near.trend}` : '') : '');

  // ---------- markers ----------

  function makeMarker() {
    const el = svgEl('g', { class: 'nep-marker ui' });
    // Course pointer outside the badge (towards the target for an off-map one); hidden without a course.
    const ptr = svgEl('path', { class: 'ptr', d: 'M0-17.5 4-11.2H-4Z' });
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

  // Where each target came from (reported trail up to its position now) and where it heads:
  // a translucent sector, wider when the course is only an estimate.
  function drawTracks(now) {
    trackLayer.textContent = '';
    const m = svg.getScreenCTM();
    if (!opts.markers || !project || !unitsPerPx || !m) return;
    const v = viewBounds(m);
    const minKm = (BADGE_PX + 14) * unitsPerPx * kmPerUnit; // the sector reaches past the badge
    for (const t of mapTargets(now)) {
      const p = placeOf(t, now);
      if (!inView(v, p.x, p.y)) continue;
      const g = svgEl('g', { class: 'nep-trk' + (t.id === selected ? ' sel' : '') });
      g.style.setProperty('--c', metaOf(t).color);
      const raw = (Array.isArray(t.trail) ? t.trail : []).filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon)).map((q) => project(q.lat, q.lon));
      raw.push(project(t.lat, t.lon), [p.x, p.y]);
      const pts = [];
      for (const q of raw) if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0.3) pts.push(q);
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (pts.length > 1 && len * kmPerUnit > 1.5) {
        g.appendChild(svgEl('polyline', { class: 'from', points: pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') }));
        g.appendChild(svgEl('circle', { class: 'start', cx: pts[0][0].toFixed(2), cy: pts[0][1].toFixed(2), r: (2.4 * unitsPerPx).toFixed(3) }));
      }
      if (p.heading != null) {
        const speed = t.velocity && t.velocity.speedKmh > 0 ? t.velocity.speedKmh : 0;
        const km = Math.max(minKm, speed ? Math.min(45, speed / 6) : 20); // about 10 minutes ahead
        const spread = t.presumptiveCourse || !speed ? 22 : 12;
        const at = (deg, k) => project(...Geo.dest(p.lat, p.lon, deg, k));
        const cone = [[p.x, p.y], at(p.heading - spread, km), at(p.heading, km * 1.06), at(p.heading + spread, km)];
        g.appendChild(svgEl('polygon', { class: 'to', points: cone.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') }));
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
  function alertEntered(entered) {
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
        place: seaOf(t) ? `над ${seaOf(t)}` : t.locality || t.district || t.region || '',
        km: Math.round(near.km),
        name: shortName(near.name),
        trend: near.trend || '',
      })),
    });
  }

  // ---------- info window ----------

  function statusHtml() {
    const st = client.status;
    let text;
    if (st === 'live') text = client.updatedAt ? hhmmss(client.updatedAt) : '';
    else if (st === 'connecting') text = 'підключення…';
    else text = `немає зв’язку${client.updatedAt ? ' · ' + hhmm(client.updatedAt) : ''}`;
    return `<span class="nep-is"><i class="nep-dot ${st}"></i>${esc(text)}</span>`;
  }

  const head = (title, right) => `<div class="nep-ih"><span class="nep-it">${title}</span>${right}</div>`;
  const line = (html, cls = '') => `<div class="nep-il${cls}">${html}</div>`;
  const closeBtn = '<button class="nep-close ui" title="Закрити">×</button>';
  const rowHtml = (t, rest) =>
    `<button class="nep-row ui" data-id="${esc(t.id)}" style="--c:${metaOf(t).color}">${iconSvg(kindOf(t))}<span><b>${titleOf(t)}</b> — ${rest}</span></button>`;

  function nearestTarget(now) {
    let best = null;
    for (const t of pointTargets()) {
      const near = nearOf(t, now);
      if (near && (!best || near.km < best.near.km)) best = { t, near };
    }
    return best;
  }

  // Every target within the radius, new and long-standing, with how long it has been close.
  function nearInfoHtml(now) {
    if (!mine.length) return head('Цілі поруч', statusHtml()) + line('Оберіть свої райони в налаштуваннях — тут будуть цілі біля них', ' muted');
    const close = closeTargets(now);
    let html = head(`Біля ваших районів · до ${opts.alertKm} км`, statusHtml());
    if (close.length) {
      const n = close.length > INFO_ROWS ? INFO_ROWS - 1 : INFO_ROWS;
      html += close
        .slice(0, n)
        .map(({ t, near }) => rowHtml(t, `${distanceText(near)} <small>· ${sinceText(inside.get(t.id), now)}</small>`))
        .join('');
      if (close.length > n) html += line(`і ще ${close.length - n} — наведіть на плитку «Біля вас»`, ' muted');
      return html;
    }
    html += line('Поруч нікого', ' muted');
    const best = nearestTarget(now);
    if (best) html += rowHtml(best.t, `найближча · ${distanceText(best.near)}`);
    return html;
  }

  function targetInfoHtml(t, now) {
    const p = predict(t, now);
    const seen = lastSeen(t);
    let course = '';
    if (!t.areaOnly) course = p.heading != null ? `курс ${Geo.compass(p.heading)} · ${Math.round(p.heading)}°${t.presumptiveCourse ? ' (оцінка)' : ''}` : 'курс невідомий';
    const speed = t.velocity && t.velocity.speedKmh > 0 ? `≈ ${Math.round(t.velocity.speedKmh)} км/год` : '';
    const n = t.sourceCount || 0;
    const sources = n ? `${n} ${plural(n, ['джерело', 'джерела', 'джерел'])}` : '';
    const conf = CONFIDENCE[t.displayConfidence || t.confidenceLevel];
    const accuracy = t.areaOnly ? 'лише область' : t.uncertaintyKm > 0 ? `±${Math.round(t.uncertaintyKm)} км` : '';
    const near = nearOf(t, now);
    let note = '';
    if (t.areaOnly) note = 'Точки немає: названо лише область (на карті — пунктирний контур).';
    else if (t.destination) note = 'Названо лише, куди летить: позиція на карті розрахункова.';
    else if (p.flying && p.km > 0.5) note = `Позиція розрахована за курсом від останньої згадки (+${Math.round(p.km)} км).`;
    else if (t.advisory) note = 'Спостереження, а не сигнал ховатися.';
    else if (t.status === 'stale') note = 'Давно не було нових повідомлень.';
    const region = regionLine(t);
    return (
      head(`${iconSvg(kindOf(t))}<b>${titleOf(t)}</b> · ${placeHtml(t)}${region ? ` <span class="nep-sub">· ${region}</span>` : ''}`, closeBtn) +
      line(esc([course, speed].filter(Boolean).join(' · '))) +
      line(esc([seen ? `згадка ${hhmm(seen)} (${ago(seen, now)})` : '', sources, conf && `достовірність ${conf}`, accuracy].filter(Boolean).join(' · '))) +
      (near ? line(`до ваших районів ${distanceText(near)}`) : '') +
      (note ? line(esc(note), ' note') : t.explanationShort && t.explanationShort !== t.title ? line(esc(t.explanationShort), ' muted') : '')
    );
  }

  function groupInfoHtml(list, now) {
    const places = [...new Set(list.map((t) => (seaOf(t) ? `над ${seaOf(t)}` : t.locality || t.region)).filter(Boolean))];
    let html = head(
      `${iconSvg(kindOf(list[0]))}<b>Група цілей <span class="nep-x">×${sumSize(list)}</span></b> <span class="nep-sub">· ${esc(places.slice(0, 3).join(', '))}${places.length > 3 ? '…' : ''}</span>`,
      closeBtn,
    );
    const n = list.length > INFO_ROWS ? INFO_ROWS - 1 : INFO_ROWS;
    html += list
      .slice(0, n)
      .map((t) => {
        const near = nearOf(t, now);
        const dist = near ? ` · ${near.km < 0.5 ? 'над вашим районом' : `≈ ${Math.round(near.km)} км`}` : '';
        return rowHtml(t, `${placeHtml(t)} <small>· ${esc(ago(lastSeen(t) || now, now))}${dist}</small>`);
      })
      .join('');
    if (list.length > n) html += line(`і ще ${list.length - n} — наведіть на групу на карті`, ' muted');
    return html;
  }

  function renderInfo(now) {
    const t = selected && client.threats.get(selected);
    const list = group ? group.map((id) => client.threats.get(id)).filter((x) => x && visible(x)).sort(bySeverity) : [];
    if (t && visible(t)) return setHtml(info, targetInfoHtml(t, now));
    if (list.length) return setHtml(info, groupInfoHtml(list, now));
    selected = group = null;
    setHtml(info, nearInfoHtml(now));
  }

  // ---------- count tiles (like the PC load tiles) ----------

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

  function putTile(key, { color, title, value, values, hot = false, data }) {
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
      `<svg class="nep-spark" viewBox="0 0 60 30" preserveAspectRatio="none">${sparkPaths(values)}</svg>` +
        `<div class="nep-txt"><div class="nep-tt">${title}</div><div class="nep-tv">${value}</div></div>`,
    );
    box.appendChild(el); // calls come in display order
  }

  function renderTiles(now) {
    const used = new Set();
    if (opts.panel) {
      const c = counts(now);
      const points = pointTargets();
      const area = targets().filter((t) => t.areaOnly).length;
      const noCourse = points.filter((t) => courseless(t, now)).length;
      const close = mine.length ? closeTargets(now) : [];
      putTile('total', { color: '#9fb3c8', title: 'Усього цілей', value: `${c.total}${noCourse ? ` · ${noCourse} без курсу` : ''}`, values: series('total', c.total), data: { all: '1' } });
      used.add('total');
      for (const kind of ORDER) {
        const key = 'k:' + kind;
        if (kind === 'fpv' && opts.hideFpv) continue;
        if (!c[key] && !(hist.get(key) || []).some((v) => v > 0)) continue; // a type seen in the last 30 min stays
        const k = close.filter((x) => kindOf(x.t) === kind).length;
        putTile(key, {
          color: TYPES[kind].color,
          title: `${iconSvg(kind)}${esc(TYPES[kind].tile || TYPES[kind].short)}`,
          value: `${c[key]}${k ? ` · поруч ${k}` : ''}`,
          values: series(key, c[key]),
          data: { type: kind },
        });
        used.add(key);
      }
      if (mine.length) {
        const over = close.filter((x) => x.near.km < 0.5).length;
        putTile('near', {
          color: '#ff9f43',
          title: `Біля вас (${opts.alertKm} км)`,
          value: `${close.length}${over ? ` · над районами ${over}` : ''}`,
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

  // The window takes two tile rows; on a wide widget it sits left or right of the tiles.
  function layoutBox() {
    const cols = getComputedStyle(box).gridTemplateColumns.split(' ').filter(Boolean).length;
    box.classList.toggle('wide', cols >= 3 && opts.panel);
    box.classList.toggle('right', opts.cardSide === 'right');
  }

  // Grows the widget once when the window and tiles would squeeze the map (as widget.js does for the PC tiles).
  let fittedFor = 0;
  function fitWindow() {
    if (!bridge.fitHeight) return;
    const h = (el) => (el ? el.getBoundingClientRect().height : 0);
    const extra = Math.ceil(h(box) + h($('status')) + h($('sys')));
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
    const seen = lastSeen(t);
    const near = nearOf(t, now);
    const region = regionLine(t);
    return (
      `<b>${titleOf(t)}</b><div>${placeHtml(t)}</div>` +
      (region ? `<div class="sub">${region}</div>` : '') +
      `<div class="sub">${seen ? esc(ago(seen, now)) : ''}${near ? ' · ' + distanceText(near) : ''}</div>` +
      (edge ? '<div class="sub">За межами карти — стрілка показує напрямок</div>' : '')
    );
  }

  function listTip(list, now, hint) {
    const rows = list
      .slice(0, 12)
      .map((t) => `<li>${esc(t.title || metaOf(t).short)}${t.count > 1 ? ` ×${t.count}` : ''} — ${placeHtml(t)} <span class="sub">${esc(ago(lastSeen(t) || now, now))}</span></li>`)
      .join('');
    const more = list.length > 12 ? `<div class="sub">і ще ${list.length - 12}</div>` : '';
    return `<ul>${rows}</ul>${more}<div class="sub">${hint}</div>`;
  }

  // Targets behind a tile: all, one kind, or the close ones.
  function tileList(el, now) {
    if (el.dataset.all) return targets();
    if (el.dataset.near) return closeTargets(now).map((x) => x.t);
    return pointTargets().filter((t) => kindOf(t) === el.dataset.type);
  }

  function tileHead(el) {
    if (el.dataset.all) {
      const area = targets().filter((t) => t.areaOnly).length;
      return `Усі цілі${area ? ` · по області ${area}` : ''}`;
    }
    if (el.dataset.near) return `Ближче ніж ${opts.alertKm} км до ваших районів`;
    return TYPES[el.dataset.type].label;
  }

  document.addEventListener('mousemove', (ev) => {
    const now = Date.now();
    const mk = ev.target.closest && ev.target.closest('.nep-marker');
    if (mk && mk.dataset.ids && !svg.classList.contains('nep-panning')) {
      const list = mk.dataset.ids.split(',').map((id) => client.threats.get(id)).filter(Boolean);
      if (list.length === 1 && list[0].id !== selected) return showTip(targetTip(list[0], now, mk.classList.contains('edge')), ev);
      if (list.length > 1) return showTip(`<b>Група цілей ×${sumSize(list)}</b>${listTip(list.sort(bySeverity), now, 'Клік — список')}`, ev);
    }
    const tile = ev.target.closest && ev.target.closest('.nep-tile');
    if (tile) {
      const list = tileList(tile, now);
      return showTip(`<b>${esc(tileHead(tile))}</b>${list.length ? listTip(list, now, 'Клік — показати по черзі') : '<div class="sub">Зараз немає</div>'}`, ev);
    }
    hideTip();
  });
  document.addEventListener('mouseleave', hideTip);

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('.nep-marker, .nep-tile, .nep-row, .nep-close');
    if (!el) return;
    if (el.classList.contains('nep-close')) return select(null);
    if (el.classList.contains('nep-marker')) {
      const ids = (el.dataset.ids || '').split(',').filter(Boolean);
      if (ids.length === 1) return select(ids[0] === selected ? null : ids[0]);
      const same = group && ids.length === group.length && ids.every((id) => group.includes(id));
      return same ? select(null) : selectGroup(ids);
    }
    if (el.classList.contains('nep-row')) return select(el.dataset.id);
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
    else alertEntered(entered);
    layer.style.display = opts.markers ? '' : 'none';
    renderMarkers(now);
    box.hidden = !opts.markers;
    if (box.hidden) return;
    if (!sampled && client.status === 'live') {
      sampled = true;
      sample(now);
    }
    renderInfo(now);
    renderTiles(now);
    layoutBox();
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
    else if (!box.hidden && !selected && !group) renderInfo(Date.now()); // status in the window title
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
    applySettings(await bridge.getSettings());
    bridge.onSettings(applySettings);
    setInterval(() => opts.markers && refresh(), MOVE_EVERY);
    setInterval(() => opts.markers && sample(Date.now()), HIST_EVERY);
    addEventListener('resize', () => opts.markers && refresh());
  })();
})();
