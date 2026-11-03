// NEPTUN layer of widget.html: targets on the map (drones, missiles, KABs…), a panel with
// counts by type and a card with the details of the selected target.
// Self-contained: talks to widget.js only through the DOM (#map, #wrap) and window.bridge.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const { TYPES, ORDER, typeMeta, predict } = window.NeptunTypes;
  const Geo = window.Geo;
  const SITE = 'https://neptun.in.ua/';
  // Projection of app/assets/map.json (see build/make-map.js), for a map.json without "proj".
  const DEFAULT_PROJ = { lat1: 45, lat2: 51, lat0: 48.5, lon0: 31.5, x0: -690178, y1: 432316, k: 0.000755630581276381 };
  const DEFAULTS = { markers: true, panel: true };
  const BADGE_PX = 9; // marker radius on screen
  const MOVE_EVERY = 2000; // ms between dead-reckoning steps
  const COURSE_KM = 60; // length of the course line of the selected target
  const CONFIDENCE = { high: 'висока', medium: 'середня', low: 'низька' };

  const $ = (id) => document.getElementById(id);
  const svg = $('map');
  const client = new window.NeptunClient();

  let opts = { ...DEFAULTS };
  let project = null; // (lat, lon) -> [x, y] in map units
  let kmPerUnit = 1;
  const shapeIndex = new Map(); // uid -> { uid, name, d, rings? }
  let mine = []; // shapes of the selected ("my") regions
  let selected = null; // id of the target shown in the card
  let cardRight = false; // card on the right side, away from the selected target
  let unitsPerPx = 0;
  const markers = new Map(); // id -> { el, glyph, cnt, type }

  // ---------- DOM ----------

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  const layer = svgEl('g', { id: 'nep-layer' });
  const selLayer = svgEl('g', { id: 'nep-sel' });
  const markerLayer = svgEl('g', { id: 'nep-markers' });
  layer.append(selLayer, markerLayer);
  svg.appendChild(layer);

  const panel = document.createElement('div');
  panel.id = 'nep-panel';
  panel.innerHTML = '<div class="nep-chips"></div><div class="nep-meta"></div><div class="nep-near"></div>';
  const card = document.createElement('div');
  card.id = 'nep-card';
  card.className = 'ui';
  card.hidden = true;
  const tip = document.createElement('div');
  tip.id = 'nep-tip';
  $('wrap').append(panel, card, tip);

  // Clicks on our elements must not drag the widget or open the settings (widget.js listens on document).
  for (const el of [panel, card, markerLayer]) {
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

  function ago(ms, now) {
    const min = Math.round((now - ms) / 60000);
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв тому`;
    return `${Math.floor(min / 60)} год ${min % 60} хв тому`;
  }

  const lastSeen = (t) => Date.parse(t.confirmedAt || t.updatedAt) || null;
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

  // Nearest selected region: { km, name } (km = 0 inside it). Not for area-only reports.
  function nearestMine(t, now) {
    if (!mine.length || t.areaOnly) return null;
    const { x, y } = placeOf(t, now);
    let best = null;
    for (const s of mine) {
      const r = rings(s);
      const km = Geo.insideRings(r, x, y) ? 0 : Geo.ringsDistance(r, x, y) * kmPerUnit;
      if (!best || km < best.km) best = { km, name: s.name };
    }
    return best;
  }

  function distanceText(near) {
    if (!near) return '';
    const name = esc(shortName(near.name));
    return near.km < 0.5 ? `над вашим районом · ${name}` : `≈ ${Math.round(near.km)} км · ${name}`;
  }

  const targets = () => client.list();
  const pointTargets = () => targets().filter((t) => !t.areaOnly);

  // ---------- markers ----------

  function updateScale() {
    const m = svg.getScreenCTM();
    if (!m || !m.a || !svg.getAttribute('viewBox')) return false;
    unitsPerPx = 1 / m.a;
    return true;
  }

  function makeMarker(id) {
    const el = svgEl('g', { class: 'nep-marker ui' });
    el.dataset.id = id;
    // Course pointer outside the badge; hidden while the course is unknown.
    const ptr = svgEl('path', { class: 'ptr', d: 'M0-17.5 4-11.2H-4Z' });
    el.append(svgEl('circle', { class: 'pulse', r: 11 }), ptr, svgEl('circle', { class: 'halo', r: 11 }));
    const glyph = svgEl('g', { class: 'glyph' });
    const cnt = svgEl('text', { class: 'cnt', x: 9, y: 16 });
    el.append(glyph, cnt);
    return { el, glyph, ptr, cnt, type: null };
  }

  function syncMarkers() {
    const list = opts.markers ? pointTargets() : [];
    const ids = new Set(list.map((t) => t.id));
    for (const [id, m] of markers) {
      if (!ids.has(id)) {
        m.el.remove();
        markers.delete(id);
      }
    }
    // Higher severity drawn on top, the selected target above everything.
    list.sort((a, b) => typeMeta(a.type).severity - typeMeta(b.type).severity || (a.id === selected) - (b.id === selected));
    for (const t of list) {
      let m = markers.get(t.id);
      if (!m) markers.set(t.id, (m = makeMarker(t.id)));
      const meta = typeMeta(t.type);
      if (m.type !== meta.type) {
        m.glyph.innerHTML = `<g class="g">${meta.icon}</g>`;
        m.el.style.setProperty('--c', meta.color);
        m.type = meta.type;
      }
      m.cnt.textContent = t.count > 1 ? `×${t.count}` : '';
      m.el.classList.toggle('adv', !!t.advisory);
      m.el.classList.toggle('stale', t.status === 'stale');
      m.el.classList.toggle('sel', t.id === selected);
      markerLayer.appendChild(m.el);
    }
  }

  function moveMarkers(now) {
    if (!project || !updateScale()) return;
    const s = (BADGE_PX / 11) * unitsPerPx;
    for (const t of pointTargets()) {
      const m = markers.get(t.id);
      if (!m) continue;
      const p = placeOf(t, now);
      m.el.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${s.toFixed(4)})`);
      const angle = p.angle == null ? 0 : p.angle.toFixed(1);
      m.glyph.setAttribute('transform', `rotate(${m.type === 'unknown' ? 0 : angle}) scale(0.72)`); // a "?" stays upright
      m.ptr.setAttribute('transform', `rotate(${angle})`);
      m.el.classList.toggle('nocourse', p.angle == null);
    }
    drawSelection(now);
  }

  // Trail, course line and uncertainty circle of the selected target.
  function drawSelection(now) {
    selLayer.textContent = '';
    const t = selected && client.threats.get(selected);
    if (!t || t.areaOnly || !opts.markers || !project) return;
    const p = placeOf(t, now);
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

  // ---------- panel ----------

  function renderChips() {
    const box = panel.querySelector('.nep-chips');
    const counts = {};
    for (const t of pointTargets()) counts[typeMeta(t.type).type] = (counts[typeMeta(t.type).type] || 0) + (t.count > 1 ? t.count : 1);
    const area = targets().filter((t) => t.areaOnly).length;
    let html = '';
    for (const type of ORDER) {
      if (!counts[type]) continue;
      html += `<button class="nep-chip ui" data-type="${type}" style="--c:${TYPES[type].color}">${iconSvg(type)}<b>${counts[type]}</b></button>`;
    }
    if (area) html += `<button class="nep-chip ui area" data-area="1">по області <b>${area}</b></button>`;
    if (!html && client.status === 'live') html = '<span class="nep-none">Цілей на карті немає</span>';
    setHtml(box, html);
  }

  function renderMeta() {
    const box = panel.querySelector('.nep-meta');
    const st = client.status;
    let text;
    if (st === 'live' && client.updatedAt) text = `станом на ${hhmmss(client.updatedAt)}`;
    else if (st === 'connecting') text = 'підключення до NEPTUN…';
    else text = client.updatedAt ? `немає зв’язку · дані на ${hhmm(client.updatedAt)}` : 'немає зв’язку з NEPTUN';
    const noCourse = pointTargets().filter((t) => predict(t, Date.now()).heading == null).length;
    if (noCourse && st === 'live') text += ` · ${noCourse} без курсу`;
    setHtml(box, `<i class="nep-dot ${st}"></i>${esc(text)} · <a class="ui" href="${SITE}" target="_blank" title="Цілі на карті: neptun.in.ua">NEPTUN</a>`);
  }

  function renderNear(now) {
    const box = panel.querySelector('.nep-near');
    let best = null;
    for (const t of pointTargets()) {
      const near = nearestMine(t, now);
      if (near && (!best || near.km < best.near.km)) best = { t, near };
    }
    setHtml(
      box,
      best ? `<button class="nep-link ui" data-id="${esc(best.t.id)}">Найближча: ${esc(typeMeta(best.t.type).short)} — ${distanceText(best.near)}</button>` : '',
    );
  }

  // ---------- card ----------

  function row(label, value) {
    return value ? `<span class="k">${label}</span><span class="v">${value}</span>` : '';
  }

  // Below the panel, on the side of the widget away from the selected target.
  function placeCard() {
    const top = panel.hidden ? 22 : panel.offsetTop + panel.offsetHeight + 6;
    card.classList.toggle('right', cardRight);
    card.style.top = top + 'px';
    card.style.maxHeight = Math.max(120, innerHeight - top - 30) + 'px';
  }

  function chooseCardSide(t) {
    cardRight = false;
    const m = svg.getScreenCTM();
    if (!t || t.areaOnly || !project || !m) return;
    cardRight = m.a * placeOf(t, Date.now()).x + m.e < innerWidth / 2;
  }

  function renderCard(now) {
    const t = selected && client.threats.get(selected);
    if (!t || !opts.markers) {
      card.hidden = true;
      return;
    }
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
    if (t.areaOnly) notes.push('Точки немає: у повідомленні названо лише область.');
    else if (t.destination) notes.push('У повідомленні названо лише, куди летить: позиція на карті розрахункова.');
    else if (p.flying && p.km > 0.5) notes.push(`Позиція розрахована за курсом від останньої згадки (+${Math.round(p.km)} км).`);
    if (t.advisory) notes.push('Спостереження, а не сигнал ховатися: широкої тривоги немає.');
    if (t.status === 'stale') notes.push('Давно не було нових повідомлень.');

    setHtml(
      card,
      `<div class="nep-head">` +
      `<div class="nep-badge" style="--c:${meta.color}">${iconSvg(meta.type)}</div>` +
      `<div class="nep-title"><div>${titleOf(t)}</div><div class="nep-place">${placeHtml(t)}</div>` +
      (regionLine(t) ? `<div class="nep-sub">${regionLine(t)}</div>` : '') +
      `</div><button class="nep-close" title="Закрити">×</button></div>` +
      `<div class="nep-rows">` +
      row('Курс', esc(course)) +
      row('Швидкість', esc(speed)) +
      row('Остання згадка', seen ? `${hhmm(seen)} <small>${esc(ago(seen, now))}</small>` : '') +
      row('До ваших районів', distanceText(nearestMine(t, now))) +
      row('Джерела', esc(sources)) +
      row('Достовірність', esc(conf)) +
      row('Точність', esc(accuracy)) +
      `</div>` +
      (t.explanationShort ? `<div class="nep-expl">${esc(t.explanationShort)}</div>` : '') +
      notes.map((x) => `<div class="nep-note">${esc(x)}</div>`).join('') +
      `<div class="nep-foot">Джерело: <a class="ui" href="${SITE}" target="_blank">NEPTUN</a> · не є офіційним оповіщенням</div>`,
    );
    card.hidden = false;
    placeCard();
  }

  function select(id) {
    selected = id && client.threats.has(id) ? id : null;
    chooseCardSide(selected && client.threats.get(selected));
    hideTip();
    syncMarkers();
    const now = Date.now();
    moveMarkers(now);
    renderCard(now);
  }

  // Next target of a type (or the next area-only report) after the selected one.
  function cycle(filter) {
    const list = targets().filter(filter).sort((a, b) => (lastSeen(b) || 0) - (lastSeen(a) || 0));
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

  function targetTip(t, now) {
    const seen = lastSeen(t);
    const near = nearestMine(t, now);
    return (
      `<b>${titleOf(t)}</b><div>${placeHtml(t)}</div>` +
      (regionLine(t) ? `<div class="sub">${regionLine(t)}</div>` : '') +
      `<div class="sub">${seen ? esc(ago(seen, now)) : ''}${near ? ' · ' + distanceText(near) : ''}</div>`
    );
  }

  function listTip(list, now) {
    const rows = list
      .slice(0, 10)
      .map((t) => `<li>${esc(t.title || typeMeta(t.type).short)} — ${placeHtml(t)} <span class="sub">${esc(ago(lastSeen(t) || now, now))}</span></li>`)
      .join('');
    const more = list.length > 10 ? `<div class="sub">і ще ${list.length - 10}</div>` : '';
    return `<ul>${rows}</ul>${more}<div class="sub">Клік — показати по черзі</div>`;
  }

  document.addEventListener('mousemove', (ev) => {
    const now = Date.now();
    const mk = ev.target.closest && ev.target.closest('.nep-marker');
    if (mk && mk.dataset.id !== selected) {
      const t = client.threats.get(mk.dataset.id);
      if (t) return showTip(targetTip(t, now), ev);
    }
    const chip = ev.target.closest && ev.target.closest('.nep-chip');
    if (chip) {
      const list = chip.dataset.area ? targets().filter((t) => t.areaOnly) : pointTargets().filter((t) => typeMeta(t.type).type === chip.dataset.type);
      const head = chip.dataset.area ? 'Названо лише область' : TYPES[chip.dataset.type].label;
      return showTip(`<b>${esc(head)}</b>${listTip(list, now)}`, ev);
    }
    hideTip();
  });
  document.addEventListener('mouseleave', hideTip);

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('.nep-marker, .nep-chip, .nep-link, .nep-close');
    if (!el) return;
    if (el.classList.contains('nep-close')) return select(null);
    if (el.classList.contains('nep-marker')) return select(el.dataset.id === selected ? null : el.dataset.id);
    if (el.classList.contains('nep-link')) return select(el.dataset.id);
    if (el.dataset.area) return cycle((t) => t.areaOnly);
    cycle((t) => !t.areaOnly && typeMeta(t.type).type === el.dataset.type);
  });

  // ---------- data / settings ----------

  function renderAll() {
    const now = Date.now();
    if (selected && !client.threats.has(selected)) selected = null;
    syncMarkers();
    moveMarkers(now);
    layer.style.display = opts.markers ? '' : 'none';
    // The status line with the NEPTUN link stays while targets are shown (API attribution terms).
    panel.hidden = !opts.markers;
    panel.classList.toggle('compact', !opts.panel);
    if (!panel.hidden) {
      renderChips();
      renderMeta();
      renderNear(now);
    }
    renderCard(now);
  }

  function applySettings(s) {
    const prev = opts;
    opts = { ...DEFAULTS, ...((s && s.neptun) || {}) };
    mine = ((s && s.regions) || []).map((uid) => shapeIndex.get(Number(uid))).filter(Boolean);
    if (opts.markers && !prev.markers) client.start();
    if (!opts.markers && prev.markers) client.stop();
    renderAll();
  }

  client.subscribe((kind) => {
    if (kind === 'data') renderAll();
    else if (!panel.hidden) renderMeta();
  });

  (async () => {
    const map = await window.bridge.getMapData();
    const proj = map.proj || DEFAULT_PROJ;
    project = Geo.mapProjector(proj);
    kmPerUnit = 1 / (proj.k * 1000);
    for (const r of map.raions) shapeIndex.set(r.uid, { uid: r.uid, name: r.name, d: r.d });
    opts = { ...DEFAULTS, markers: false }; // applySettings starts the client if enabled
    applySettings(await window.bridge.getSettings());
    window.bridge.onSettings(applySettings);
    setInterval(() => {
      if (!opts.markers) return;
      const now = Date.now();
      moveMarkers(now);
      if (!panel.hidden) renderNear(now);
      if (!card.hidden) renderCard(now);
    }, MOVE_EVERY);
    addEventListener('resize', () => {
      moveMarkers(Date.now());
      if (!card.hidden) placeCard();
    });
  })();
})();
