// Targets layer of widget.html (data: NEPTUN API): targets on the map (drones, missiles, KABs…),
// a status line with the targets close to the selected regions, counts under the map, a card with
// details, and a short banner when a target comes close. Talks to widget.js only through the DOM
// (#map, #wrap) and window.bridge.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const { TYPES, ORDER, typeMeta, predict } = window.NeptunTypes;
  const Geo = window.Geo;
  const bridge = window.bridge;
  const ipc = bridge.neptun || null; // preload.js hook; without it there is no alert banner
  // Projection of app/assets/map.json (see build/make-map.js), for a map.json without "proj".
  const DEFAULT_PROJ = { lat1: 45, lat2: 51, lat0: 48.5, lon0: 31.5, x0: -690178, y1: 432316, k: 0.000755630581276381 };
  const DEFAULTS = { markers: true, panel: true, hideFpv: false, alert: true, alertKm: 20, alertSound: false, cardSide: 'left' };
  const BADGE_PX = 9; // marker radius on screen
  const CLUSTER_PX = 15; // markers closer than this on screen become one "×N" marker
  const EDGE_PAD_PX = 13; // targets beyond the visible map are pinned this far inside its edge
  const MOVE_EVERY = 2000; // ms between dead-reckoning steps
  const COURSE_KM = 60; // length of the course line of the selected target
  const GROUP_ROWS = 6; // rows in the card of a group (the card never scrolls for them)
  const NEAR_ROWS = 4; // rows of the "close to your regions" list in the status block
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
  let mine = []; // shapes of the selected ("my") regions
  let selected = null; // id of the target shown in the card
  let group = null; // ids of the group shown in the card
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
  const selLayer = svgEl('g', { id: 'nep-sel' });
  const markerLayer = svgEl('g', { id: 'nep-markers' });
  layer.append(areaLayer, selLayer, markerLayer);
  svg.appendChild(layer);

  const panel = document.createElement('div');
  panel.id = 'nep-panel';
  panel.innerHTML = '<div class="nep-meta"></div><div class="nep-near"></div>';
  const summary = document.createElement('div');
  summary.id = 'nep-summary';
  const card = document.createElement('div');
  card.id = 'nep-card';
  card.className = 'ui';
  card.hidden = true;
  const tip = document.createElement('div');
  tip.id = 'nep-tip';
  $('wrap').append(panel, card, tip);
  svg.after(summary); // between the map and the status line

  // Clicks on our elements must not drag the widget or open the settings (widget.js listens on document).
  for (const el of [panel, summary, card, markerLayer]) {
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
  const bySeverity = (a, b) => typeMeta(b.type).severity - typeMeta(a.type).severity || (lastSeen(b) || 0) - (lastSeen(a) || 0);
  const sizeOf = (t) => (t.count > 1 ? t.count : 1);

  // "Одеська область", "АР Крим", "м. Київ" -> "одеська", "крим", "київ"
  const normOblast = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[’ʼ`]/g, "'")
      .replace(/^автономна республіка\s+|^ар\s+|^м\.\s*/, '')
      .replace(/\s+область$/, '')
      .trim();

  function ago(ms, now) {
    const min = Math.round((now - ms) / 60000);
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв тому`;
    return `${Math.floor(min / 60)} год ${min % 60} хв тому`;
  }

  const iconSvg = (type, cls = 'nep-ico') => `<svg class="${cls}" viewBox="-12 -12 24 24">${typeMeta(type).icon}</svg>`;
  const titleOf = (t) => esc(t.title || typeMeta(t.type).short) + (t.count > 1 ? ` <span class="nep-x">×${t.count}</span>` : '');

  // "Курс → Лозова" when the message named only where the target flies, otherwise the place itself.
  function placeHtml(t) {
    if (t.areaOnly) return `<b>${esc(t.region)}</b>`;
    if (t.destination && t.locality) return `Курс → <b>${esc(t.locality)}</b>`;
    return `<b>${esc(t.locality || t.district || t.region)}</b>`;
  }

  function regionLine(t) {
    if (t.areaOnly) return '';
    const parts = [t.district, t.region].filter((p) => p && p !== t.locality);
    return esc(parts.join(', '));
  }

  function rings(shape) {
    if (!shape.rings) shape.rings = Geo.pathRings(shape.d);
    return shape.rings;
  }

  // Targets the user wants to see (the FPV filter applies to the map, counts and alerts alike).
  const visible = (t) => !(opts.hideFpv && t.type === 'fpv');
  const targets = () => client.list().filter(visible);
  const pointTargets = () => targets().filter((t) => !t.areaOnly);

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

  function distanceText(near) {
    if (!near) return '';
    const name = esc(shortName(near.name));
    if (near.km < 0.5) return `над вашим районом · ${name}`;
    return `≈ ${Math.round(near.km)} км · ${name}${near.trend ? ` · ${near.trend}` : ''}`;
  }

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
    return { el, glyph, ptr, cnt, type: null };
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

  // Drawing units: single targets and groups of targets that overlap on screen.
  // Targets beyond the visible map are pinned to its edge with the pointer towards them.
  function computeUnits(now) {
    const m = svg.getScreenCTM();
    if (!project || !m || !m.a || !svg.getAttribute('viewBox')) return [];
    unitsPerPx = 1 / m.a;
    const v = viewBounds(m);
    const items = pointTargets()
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
      const meta = typeMeta(u.lead.type);
      if (m.type !== meta.type) {
        m.glyph.innerHTML = `<g class="g">${meta.icon}</g>`;
        m.el.style.setProperty('--c', meta.color);
        m.type = meta.type;
      }
      m.el.dataset.ids = u.ids.join(',');
      m.el.setAttribute('transform', `translate(${u.x.toFixed(2)} ${u.y.toFixed(2)}) scale(${s})`);
      const turn = u.glyphAngle == null || meta.type === 'unknown' ? 0 : u.glyphAngle.toFixed(1); // a "?" stays upright
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
    drawSelection(now);
  }

  // Trail, course line and uncertainty circle of the selected target (when it is on the map).
  function drawSelection(now) {
    selLayer.textContent = '';
    const t = selected && client.threats.get(selected);
    if (!t || t.areaOnly || !opts.markers || !project || !unitsPerPx) return;
    const p = placeOf(t, now);
    const m = svg.getScreenCTM();
    const v = m && viewBounds(m);
    if (v && (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1)) return;
    selLayer.style.setProperty('--c', typeMeta(t.type).color);
    if (t.uncertaintyKm > 0) {
      const r = t.uncertaintyKm / kmPerUnit;
      if (r / unitsPerPx > BADGE_PX + 3) selLayer.appendChild(svgEl('circle', { class: 'unc', cx: p.x, cy: p.y, r }));
    }
    if (Array.isArray(t.trail) && t.trail.length) {
      const pts = t.trail.filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon)).map((q) => project(q.lat, q.lon));
      pts.push([p.x, p.y]);
      selLayer.appendChild(svgEl('polyline', { class: 'trail', points: pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') }));
    }
    if (p.heading != null) {
      const [lat2, lon2] = Geo.dest(p.lat, p.lon, p.heading, COURSE_KM);
      const [x2, y2] = project(lat2, lon2);
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
      const top = list.sort(bySeverity)[0];
      const path = svgEl('path', { class: 'nep-area', d: o.d });
      path.style.setProperty('--c', typeMeta(top.type).color);
      areaLayer.appendChild(path);
    }
  }

  // ---------- status line (top left) ----------

  function renderMeta() {
    const box = panel.querySelector('.nep-meta');
    const st = client.status;
    let text;
    if (st === 'live' && client.updatedAt) text = `станом на ${hhmmss(client.updatedAt)}`;
    else if (st === 'connecting') text = 'підключення…';
    else text = client.updatedAt ? `немає зв’язку · дані на ${hhmm(client.updatedAt)}` : 'немає зв’язку';
    const noCourse = pointTargets().filter((t) => predict(t, Date.now()).heading == null).length;
    if (noCourse && st === 'live') text += ` · ${noCourse} без курсу`;
    setHtml(box, `<i class="nep-dot ${st}"></i>${esc(text)}`);
  }

  function sinceText(ms, now) {
    const min = Math.floor((now - ms) / 60000);
    if (min < 1) return 'щойно';
    return min < 60 ? `поруч ${min} хв` : `поруч ${Math.floor(min / 60)} год ${min % 60} хв`;
  }

  // Every target within the radius of the selected regions, new and long-standing, with how long it
  // has been close. Without any: one quiet line with the nearest target.
  function renderNear(now) {
    const box = panel.querySelector('.nep-near');
    if (!opts.panel || !mine.length) return setHtml(box, '');
    const close = closeTargets(now);
    if (close.length) {
      const rows = close
        .slice(0, NEAR_ROWS)
        .map(({ t, near }) => {
          const where = near.km < 0.5 ? `над районом ${esc(shortName(near.name))}` : `≈ ${Math.round(near.km)} км · ${esc(shortName(near.name))}`;
          const trend = near.trend ? ` · ${near.trend}` : '';
          return (
            `<button class="nep-near-row ui" data-id="${esc(t.id)}" style="--c:${typeMeta(t.type).color}">${iconSvg(t.type)}` +
            `<span><b>${titleOf(t)}</b> — ${where}${trend} <small>· ${sinceText(inside.get(t.id), now)}</small></span></button>`
          );
        })
        .join('');
      const more = close.length > NEAR_ROWS ? `<div class="nep-near-more">і ще ${close.length - NEAR_ROWS}</div>` : '';
      return setHtml(box, `<div class="nep-near-head">Біля ваших районів · до ${opts.alertKm} км</div>${rows}${more}`);
    }
    let best = null;
    for (const t of pointTargets()) {
      const near = nearOf(t, now);
      if (near && (!best || near.km < best.near.km)) best = { t, near };
    }
    setHtml(
      box,
      best ? `<button class="nep-link ui" data-id="${esc(best.t.id)}">Найближча: <b>${esc(typeMeta(best.t.type).short)} — ${distanceText(best.near)}</b></button>` : '',
    );
  }

  // ---------- counts under the map ----------

  function countChips(list, scope) {
    const counts = {};
    for (const t of list) counts[typeMeta(t.type).type] = (counts[typeMeta(t.type).type] || 0) + sizeOf(t);
    return ORDER.filter((type) => counts[type])
      .map((type) => `<button class="nep-chip ui" data-type="${type}" data-scope="${scope}" style="--c:${TYPES[type].color}">${iconSvg(type)}<b>${counts[type]}</b></button>`)
      .join('');
  }

  // Targets inside the selected regions and within the alert radius of them.
  function mineLists(now) {
    const inside = [];
    for (const t of pointTargets()) {
      const near = nearOf(t, now);
      if (!near) continue;
      if (near.km < 0.5) inside.push(t);
    }
    return { inside, close: closeTargets(now).map((c) => c.t) };
  }

  function renderSummary(now) {
    if (!opts.markers || !opts.panel) {
      summary.hidden = true;
      return;
    }
    summary.hidden = false;
    const points = pointTargets();
    const area = targets().filter((t) => t.areaOnly);
    const total = points.reduce((s, t) => s + sizeOf(t), 0) + area.length;
    let html = `<span class="nep-group"><span class="nep-lbl">Україна <b>${total}</b></span>${countChips(points, 'all')}`;
    if (area.length) html += `<button class="nep-chip ui area" data-area="1">по області <b>${area.length}</b></button>`;
    if (!total) html += `<span class="nep-none">${client.status === 'live' ? 'цілей немає' : '—'}</span>`;
    html += '</span>';
    if (mine.length) {
      const { inside, close } = mineLists(now);
      const n = inside.reduce((s, t) => s + sizeOf(t), 0);
      html += `<span class="nep-group"><span class="nep-lbl">Ваші райони <b>${n}</b></span>${countChips(inside, 'in')}`;
      html += `<button class="nep-chip ui near${close.length ? ' hot' : ''}" data-near="1">до ${opts.alertKm} км <b>${close.length}</b></button></span>`;
    }
    setHtml(summary, html);
  }

  // ---------- card ----------

  function row(label, value) {
    return value ? `<span class="k">${label}</span><span class="v">${value}</span>` : '';
  }

  // Always on the side chosen in the settings: left below the status line, or right below the gear.
  function placeCard() {
    const right = opts.cardSide === 'right';
    const top = right ? 34 : panel.offsetTop + panel.offsetHeight + 6;
    const bottom = svg.getBoundingClientRect().bottom - 4;
    card.classList.toggle('right', right);
    card.style.top = top + 'px';
    card.style.maxHeight = Math.max(120, bottom - top) + 'px';
  }

  function targetCardHtml(t, now) {
    const meta = typeMeta(t.type);
    const p = predict(t, now);
    const seen = lastSeen(t);
    let course = 'невідомий';
    if (t.areaOnly) course = '';
    else if (p.heading != null) course = `${Geo.compass(p.heading)} · ${Math.round(p.heading)}°${t.presumptiveCourse ? ' (оцінка)' : ''}`;
    const speed = t.velocity && t.velocity.speedKmh > 0 ? `≈ ${Math.round(t.velocity.speedKmh)} км/год` : '';
    const n = t.sourceCount || 0;
    const sources = n ? `${n} ${plural(n, ['джерело', 'джерела', 'джерел'])}` : '';
    const conf = CONFIDENCE[t.displayConfidence || t.confidenceLevel] || '';
    const accuracy = t.areaOnly ? 'лише область' : t.uncertaintyKm > 0 ? `±${Math.round(t.uncertaintyKm)} км${t.positionQuality === 'approx' ? ', приблизно' : ''}` : '';

    const notes = [];
    if (t.areaOnly) notes.push('Точки немає: у повідомленні названо лише область (на карті — пунктирний контур).');
    else if (t.destination) notes.push('У повідомленні названо лише, куди летить: позиція на карті розрахункова.');
    else if (p.flying && p.km > 0.5) notes.push(`Позиція розрахована за курсом від останньої згадки (+${Math.round(p.km)} км).`);
    if (t.advisory) notes.push('Спостереження, а не сигнал ховатися: широкої тривоги немає.');
    if (t.status === 'stale') notes.push('Давно не було нових повідомлень.');

    return (
      `<div class="nep-head">` +
      `<div class="nep-badge" style="--c:${meta.color}">${iconSvg(meta.type)}</div>` +
      `<div class="nep-title"><div>${titleOf(t)}</div><div class="nep-place">${placeHtml(t)}</div>` +
      (regionLine(t) ? `<div class="nep-sub">${regionLine(t)}</div>` : '') +
      `</div><button class="nep-close" title="Закрити">×</button></div>` +
      `<div class="nep-rows">` +
      row('Курс', esc(course)) +
      row('Швидкість', esc(speed)) +
      row('Остання згадка', seen ? `${hhmm(seen)} <small>${esc(ago(seen, now))}</small>` : '') +
      row('До ваших районів', distanceText(nearOf(t, now))) +
      row('Джерела', esc(sources)) +
      row('Достовірність', esc(conf)) +
      row('Точність', esc(accuracy)) +
      `</div>` +
      (t.explanationShort && t.explanationShort !== t.title ? `<div class="nep-expl">${esc(t.explanationShort)}</div>` : '') +
      notes.map((x) => `<div class="nep-note">${esc(x)}</div>`).join('')
    );
  }

  // Card of a "×N" group: a short list, each row opens that target.
  function groupCardHtml(list, now) {
    const top = list[0];
    const count = list.reduce((s, t) => s + sizeOf(t), 0);
    const places = [...new Set(list.map((t) => t.locality || t.region).filter(Boolean))];
    const rows = list
      .slice(0, GROUP_ROWS)
      .map((t) => {
        const near = nearOf(t, now);
        const sub = [ago(lastSeen(t) || now, now), near ? (near.km < 0.5 ? 'над вашим районом' : `≈ ${Math.round(near.km)} км`) : ''].filter(Boolean).join(' · ');
        return (
          `<button class="nep-item ui" data-id="${esc(t.id)}" style="--c:${typeMeta(t.type).color}">${iconSvg(t.type)}` +
          `<span class="nep-item-t">${titleOf(t)} <span class="nep-item-p">${placeHtml(t)}</span></span><small>${esc(sub)}</small></button>`
        );
      })
      .join('');
    const more = list.length > GROUP_ROWS ? `<div class="nep-more">і ще ${list.length - GROUP_ROWS} — наведіть на групу, щоб побачити всі</div>` : '';
    return (
      `<div class="nep-head">` +
      `<div class="nep-badge" style="--c:${typeMeta(top.type).color}">${iconSvg(top.type)}</div>` +
      `<div class="nep-title"><div>Група цілей <span class="nep-x">×${count}</span></div>` +
      `<div class="nep-sub">${esc(places.slice(0, 3).join(', '))}${places.length > 3 ? '…' : ''}</div>` +
      `</div><button class="nep-close" title="Закрити">×</button></div>` +
      `<div class="nep-items">${rows}</div>${more}`
    );
  }

  function renderCard(now) {
    if (!opts.markers) {
      card.hidden = true;
      return;
    }
    const t = selected && client.threats.get(selected);
    const list = group ? group.map((id) => client.threats.get(id)).filter((x) => x && visible(x)).sort(bySeverity) : [];
    if (t && visible(t)) setHtml(card, targetCardHtml(t, now));
    else if (list.length) setHtml(card, groupCardHtml(list, now));
    else {
      selected = group = null;
      card.hidden = true;
      return;
    }
    card.hidden = false;
    placeCard();
  }

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
    return (
      `<b>${titleOf(t)}</b><div>${placeHtml(t)}</div>` +
      (regionLine(t) ? `<div class="sub">${regionLine(t)}</div>` : '') +
      `<div class="sub">${seen ? esc(ago(seen, now)) : ''}${near ? ' · ' + distanceText(near) : ''}</div>` +
      (edge ? '<div class="sub">За межами карти — стрілка показує напрямок</div>' : '')
    );
  }

  function listTip(list, now, hint) {
    const rows = list
      .slice(0, 12)
      .map((t) => `<li>${esc(t.title || typeMeta(t.type).short)}${t.count > 1 ? ` ×${t.count}` : ''} — ${placeHtml(t)} <span class="sub">${esc(ago(lastSeen(t) || now, now))}</span></li>`)
      .join('');
    const more = list.length > 12 ? `<div class="sub">і ще ${list.length - 12}</div>` : '';
    return `<ul>${rows}</ul>${more}<div class="sub">${hint}</div>`;
  }

  // Targets behind a counter: a type in Ukraine or in the selected regions, area-only, or close ones.
  function chipList(chip, now) {
    if (chip.dataset.area) return targets().filter((t) => t.areaOnly);
    if (chip.dataset.near) return mineLists(now).close;
    const base = chip.dataset.scope === 'in' ? mineLists(now).inside : pointTargets();
    return base.filter((t) => typeMeta(t.type).type === chip.dataset.type);
  }

  function chipHead(chip) {
    if (chip.dataset.area) return 'Названо лише область';
    if (chip.dataset.near) return `Ближче ніж ${opts.alertKm} км до ваших районів`;
    return TYPES[chip.dataset.type].label + (chip.dataset.scope === 'in' ? ' у ваших районах' : '');
  }

  document.addEventListener('mousemove', (ev) => {
    const now = Date.now();
    const mk = ev.target.closest && ev.target.closest('.nep-marker');
    if (mk && mk.dataset.ids) {
      const list = mk.dataset.ids.split(',').map((id) => client.threats.get(id)).filter(Boolean);
      const edge = mk.classList.contains('edge');
      if (list.length === 1 && list[0].id !== selected) return showTip(targetTip(list[0], now, edge), ev);
      if (list.length > 1) {
        const count = list.reduce((s, t) => s + sizeOf(t), 0);
        return showTip(`<b>Група цілей ×${count}</b>${listTip(list.sort(bySeverity), now, 'Клік — список')}`, ev);
      }
    }
    const chip = ev.target.closest && ev.target.closest('.nep-chip');
    if (chip) {
      const list = chipList(chip, now);
      if (list.length) return showTip(`<b>${esc(chipHead(chip))}</b>${listTip(list, now, 'Клік — показати по черзі')}`, ev);
      return showTip(`<b>${esc(chipHead(chip))}</b><div class="sub">Зараз немає</div>`, ev);
    }
    hideTip();
  });
  document.addEventListener('mouseleave', hideTip);

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('.nep-marker, .nep-chip, .nep-link, .nep-item, .nep-near-row, .nep-close');
    if (!el) return;
    if (el.classList.contains('nep-close')) return select(null);
    if (el.classList.contains('nep-marker')) {
      const ids = (el.dataset.ids || '').split(',').filter(Boolean);
      if (ids.length === 1) return select(ids[0] === selected ? null : ids[0]);
      const same = group && ids.length === group.length && ids.every((id) => group.includes(id));
      return same ? select(null) : selectGroup(ids);
    }
    if (el.matches('.nep-link, .nep-item, .nep-near-row')) return select(el.dataset.id);
    cycle(chipList(el, Date.now()));
  });

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
        type: typeMeta(t.type).type,
        title: (t.title || typeMeta(t.type).short) + (t.count > 1 ? ` ×${t.count}` : ''),
        place: t.locality || t.district || t.region || '',
        km: Math.round(near.km),
        name: shortName(near.name),
        trend: near.trend || '',
      })),
    });
  }

  // ---------- data / settings ----------

  function refresh() {
    const now = Date.now();
    nearCache.clear();
    const entered = trackNear(now);
    if (quiet) quiet = false;
    else alertEntered(entered);
    renderMarkers(now);
    layer.style.display = opts.markers ? '' : 'none';
    panel.hidden = !opts.markers;
    if (!panel.hidden) {
      renderMeta();
      renderNear(now);
    }
    renderSummary(now);
    renderCard(now);
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
    quiet = prev.markers; // a settings change re-baselines the close targets without a banner
    if (opts.markers && !prev.markers) client.start();
    if (!opts.markers && prev.markers) client.stop();
    renderAll();
  }

  client.subscribe((kind) => {
    if (kind === 'data') renderAll();
    else if (!panel.hidden) renderMeta();
  });

  (async () => {
    const map = await bridge.getMapData();
    const proj = map.proj || DEFAULT_PROJ;
    project = Geo.mapProjector(proj);
    kmPerUnit = 1 / (proj.k * 1000);
    for (const r of map.raions) shapeIndex.set(r.uid, { uid: r.uid, name: r.name, d: r.d });
    for (const o of map.oblasts) oblastIndex.set(normOblast(o.name), o);
    applySettings(await bridge.getSettings());
    bridge.onSettings(applySettings);
    setInterval(() => opts.markers && refresh(), MOVE_EVERY);
    addEventListener('resize', () => opts.markers && refresh());
  })();
})();
