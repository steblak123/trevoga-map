const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const R = window.Regions;

let settings = null;
let state = { iot: null, alerts: null };
const shapes = new Map(); // uid -> { el, name, oblast, paths: [d] }

function makeGroup(parent, uid, cls, paths) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', cls);
  g.dataset.uid = uid;
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    g.appendChild(p);
  }
  parent.appendChild(g);
  return g;
}

async function buildMap() {
  const map = await window.bridge.getMapData();

  for (const r of map.raions) {
    const ob = R.OBLAST_BY_UID[R.oblastOf(r.uid)];
    const isCity = R.OBLAST_BY_UID[r.uid] != null;
    const el = makeGroup($(isCity ? 'cities' : 'raions'), r.uid, isCity ? 'city' : 'raion', [r.d]);
    shapes.set(r.uid, { el, name: r.name, oblast: isCity ? '' : ob.name, paths: [r.d] });
  }

  for (const o of map.oblasts) {
    const b = document.createElementNS(SVG_NS, 'path');
    b.setAttribute('d', o.d);
    $('borders').appendChild(b);
  }

  for (const l of map.labels) {
    const txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('x', l.x);
    txt.setAttribute('y', l.y);
    txt.setAttribute('font-size', 17);
    txt.textContent = l.name;
    $('labels').appendChild(txt);
  }

  const pad = 8;
  $('map').setAttribute('viewBox', `${-pad} ${-pad} ${map.width + pad * 2} ${map.height + pad * 2}`);
  $('loading').remove();
}

// ---------- rendering ----------

function levelFor(uid) {
  const s = shapes.get(uid);
  const list = R.alertsFor(state.alerts, uid, s && s.name).filter((a) => a.alert_type === 'air_raid');
  if (!list.length) return null;
  return list.some((a) => a.alert_level !== 'yellow') ? 'red' : 'yellow';
}

function paint() {
  for (const [uid, s] of shapes) {
    const st = R.statusOf(state.iot, uid);
    const lvl = st === 'N' ? null : levelFor(uid);
    s.el.setAttribute('class', `${s.oblast ? 'raion' : 'city'} st-${st}${lvl ? ' lvl-' + lvl : ''}`);
  }
  paintMine();
  paintStatus();
}

function paintMine() {
  const box = $('mine');
  box.textContent = '';
  if (!settings) return;
  for (const uid of settings.regions) {
    const s = shapes.get(uid);
    if (!s) continue;
    const st = R.statusOf(state.iot, uid);
    makeGroup(box, uid, st === 'N' ? '' : 'alert', s.paths);
  }
}

function sinceFor(uid) {
  const s = shapes.get(uid);
  return R.alertSince(state.alerts, uid, s && s.name) || (state.starts && state.starts[uid]) || null;
}

// "з 09:43 (25 хв)" for an ongoing alert.
function sinceText(uid) {
  const since = sinceFor(uid);
  return since ? `з ${R.formatTime(since)} (${R.formatDuration(Date.now() - since)})` : '';
}

// "04:49–09:08 (4 год 19 хв)" for the last finished alert, if known.
function lastText(uid) {
  const h = state.history && state.history[uid];
  if (!h || !h.end) return '';
  const dur = h.start ? ` (${R.formatDuration(h.end - h.start)})` : '';
  return R.formatRange(h.start, h.end) + dur;
}

function paintStatus() {
  const box = $('status');
  box.textContent = '';
  const add = (cls, html) => {
    const span = document.createElement('span');
    span.className = cls;
    span.innerHTML = html;
    box.appendChild(span);
  };
  if (state.error) add('err', `⚠ ${escapeHtml(state.error)}`);
  if (!settings || !settings.regions.length) {
    add('muted', 'Оберіть свої райони: ПКМ → Налаштування');
    return;
  }
  if (!state.iot) return;

  const list = settings.regions.map((uid) => ({ uid, st: R.statusOf(state.iot, uid) }));
  const active = list.filter((x) => x.st !== 'N');
  const shown = active.length ? active : list;
  for (const { uid, st } of shown.slice(0, 3)) {
    const s = shapes.get(uid);
    const name = escapeHtml(R.shortName(s ? s.name : uid));
    let text = 'спокійно';
    if (st === 'N') {
      const last = lastText(uid);
      if (last) text += ` <span class="muted">· остання ${escapeHtml(last)}</span>`;
    } else if (st === 'A') {
      text = `тривога ${escapeHtml(sinceText(uid))}`;
    } else if (st === 'P') {
      const places = R.partialPlaces(state.alerts, uid, s && s.name);
      text = 'тривога ' + (places.length ? 'в: ' + escapeHtml(places.join(', ')) : 'в частині району');
    }
    add(`item ${st}`, `<i class="dot"></i>${name}: ${text}`);
  }
  if (shown.length > 3) add('muted', `+${shown.length - 3}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------- tooltip ----------

const historyAsked = new Set(); // history targets already requested from the main process
let tipTarget = null; // { uid, ev } of the tooltip on screen, re-rendered on data updates

function showTip(uid, ev) {
  tipTarget = { uid, ev: { clientX: ev.clientX, clientY: ev.clientY } };
  const s = shapes.get(uid);
  if (!s) return hideTip();
  const st = R.statusOf(state.iot, uid);
  const alerts = R.alertsFor(state.alerts, uid, s.name);
  const air = alerts.filter((a) => a.alert_type === 'air_raid');
  const lvl = air.length ? (air.some((a) => a.alert_level !== 'yellow') ? 'red' : 'yellow') : null;

  let html = `<b>${escapeHtml(s.name)}</b>`;
  if (s.oblast) html += `<div class="sub">${escapeHtml(s.oblast)}</div>`;
  if (st === 'N' && !alerts.length) {
    html += `<div class="st N">Тривоги немає</div>`;
  } else if (st === 'P') {
    const places = R.partialPlaces(state.alerts, uid, s.name);
    html += `<div class="st P">Тривога в частині району</div>`;
    if (places.length) html += `<ul>${places.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
  } else {
    const lvlText = lvl === 'yellow' ? ' (жовтий рівень)' : lvl === 'red' ? ' (червоний рівень)' : '';
    if (st !== 'N') {
      html += `<div class="st ${lvl === 'yellow' ? 'Y' : st}">Повітряна тривога${lvlText}</div>`;
      const since = sinceFor(uid);
      if (since) {
        html += `<div class="time">Початок: ${escapeHtml(R.formatTime(since))} · триває ${escapeHtml(R.formatDuration(Date.now() - since))}</div>`;
      }
    }
    const other = alerts.filter((a) => a.alert_type !== 'air_raid');
    const threats = new Set();
    for (const a of alerts) for (const t of a.threats || []) threats.add(R.THREAT_TYPES[t.threat_type] || t.threat_type);
    for (const a of other) threats.add(R.ALERT_TYPES[a.alert_type] || a.alert_type);
    if (threats.size) html += `<ul>${[...threats].map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
    const note = alerts.map((a) => a.notes).find(Boolean);
    if (note) html += `<div class="note">${escapeHtml(note)}</div>`;
  }
  if (st !== 'A') {
    const last = lastText(uid);
    const target = R.isRaion(uid) ? R.oblastOf(uid) : uid;
    const fetched = state.fetched && state.fetched[target];
    if (last) html += `<div class="time">Остання тривога: ${escapeHtml(last)}</div>`;
    else if (fetched) html += `<div class="time">За останній місяць тривог не було</div>`;
    else html += `<div class="time">Остання тривога: завантаження…</div>`;
    if (!fetched && !historyAsked.has(target)) {
      historyAsked.add(target);
      window.bridge.wantHistory(uid);
    }
  }
  const tip = $('tip');
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
  tipTarget = null;
  $('tip').style.display = 'none';
}

// ---------- mouse: click-through on empty areas, drag, resize ----------

let ignoring = null;
function setIgnore(v) {
  if (v === ignoring) return;
  ignoring = v;
  window.bridge.setIgnore(v);
}

function interactiveTarget(el) {
  return el && el.closest && el.closest('.raion, .city, .ui');
}

document.addEventListener('mousemove', (ev) => {
  const hit = interactiveTarget(ev.target);
  setIgnore(!hit);
  const shape = ev.target.closest && ev.target.closest('.raion, .city');
  if (shape) showTip(Number(shape.dataset.uid), ev);
  else hideTip();
});
document.addEventListener('mouseleave', () => {
  hideTip();
  setIgnore(true);
});

document.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (ev.target.id === 'grip') return window.bridge.resizeStart();
  if (ev.target.id === 'gear') return;
  if (interactiveTarget(ev.target)) {
    hideTip();
    window.bridge.dragStart();
  }
});
document.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  window.bridge.contextMenu();
});
document.addEventListener('dblclick', () => window.bridge.openSettings());
$('gear').addEventListener('click', () => window.bridge.openSettings());

// ---------- PC load panel ----------

const SYS_POINTS = 60; // 2 minutes at one sample per 2 s
const sysHistory = new Map(); // tile id -> [values] (network: [[down, up]])
const SYS_COLORS = { cpu: '#3aa0ff', ram: '#b670ff', disk: '#6cc24a', net: '#ff7ab6', gpu: '#36c5b0' };

const num = (v, digits = 1) => v.toLocaleString('uk-UA', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function pushHistory(id, value) {
  const h = sysHistory.get(id) || [];
  h.push(value);
  if (h.length > SYS_POINTS) h.shift();
  sysHistory.set(id, h);
  return h;
}

function sparkPath(values, max, area) {
  if (!values.length) return '';
  const step = 60 / (SYS_POINTS - 1);
  const x0 = 60 - (values.length - 1) * step;
  const pts = values.map((v, i) => `${(x0 + i * step).toFixed(1)},${(30 - (Math.min(v || 0, max) / max) * 28).toFixed(1)}`);
  const line = 'M' + pts.join('L');
  return area ? `${line}L60,30L${x0.toFixed(1)},30Z` : line;
}

function netText(down, up) {
  const m = Math.max(down || 0, up || 0);
  const [div, unit, d] = m >= 1e9 ? [1e9, 'Гбіт/с', 1] : m >= 1e6 ? [1e6, 'Мбіт/с', 1] : [1e3, 'Кбіт/с', 0];
  return `↑${num((up || 0) / div, d)} ↓${num((down || 0) / div, d)} ${unit}`;
}

function tile(kind, id, title, value, values, { max = 100, second = null, hot = false } = {}) {
  const spark = `<svg class="spark" viewBox="0 0 60 30" preserveAspectRatio="none">`
    + `<path class="area" d="${sparkPath(values, max, true)}"/>`
    + `<path class="line" d="${sparkPath(values, max, false)}"/>`
    + (second ? `<path class="line2" d="${sparkPath(second, max, false)}"/>` : '')
    + `</svg>`;
  return `<div class="tile${hot ? ' hot' : ''}" style="--c:${SYS_COLORS[kind]}">${spark}`
    + `<div class="txt"><div class="t">${escapeHtml(title)}</div><div class="v">${escapeHtml(value)}</div></div></div>`;
}

function renderSys(data) {
  const cfg = settings && settings.sys;
  const box = $('sys');
  if (!cfg || !cfg.show || !data) {
    box.innerHTML = '';
    return;
  }
  const html = [];
  if (cfg.cpu) {
    const h = pushHistory('cpu', data.cpu.pct);
    const ghz = data.cpu.ghz ? ` · ${num(data.cpu.ghz, 2)} ГГц` : '';
    html.push(tile('cpu', 'cpu', 'ЦП', `${data.cpu.pct ?? '—'}%${ghz}`, h, { hot: data.cpu.pct >= 85 }));
  }
  if (cfg.ram) {
    const pct = Math.round((data.ram.used / data.ram.total) * 100);
    const h = pushHistory('ram', pct);
    const gb = (b) => num(b / 1024 ** 3, 1);
    html.push(tile('ram', 'ram', "Пам'ять", `${gb(data.ram.used)}/${gb(data.ram.total)} ГБ (${pct}%)`, h, { hot: pct >= 85 }));
  }
  if (cfg.disk) {
    for (const d of data.disks) {
      const h = pushHistory(d.id, d.active);
      const title = `Диск ${d.num}${d.letters ? ` (${d.letters})` : ''}`;
      html.push(tile('disk', d.id, title, `${d.active ?? 0}%${d.kind ? ' · ' + d.kind : ''}`, h, { hot: d.active >= 85 }));
    }
  }
  if (cfg.net) {
    for (const n of data.nets) {
      const h = pushHistory(n.id, [n.down || 0, n.up || 0]);
      const max = Math.max(1e5, ...h.flat());
      html.push(tile('net', n.id, n.name, netText(n.down, n.up), h.map((x) => x[0]), { max, second: h.map((x) => x[1]) }));
    }
  }
  if (cfg.gpu) {
    for (const g of data.gpus) {
      const h = pushHistory(g.id, g.pct);
      html.push(tile('gpu', g.id, g.name, `${g.pct}% · відеокарта`, h, { hot: g.pct >= 85 }));
    }
  }
  box.innerHTML = html.join('');
  fitWindow();
}

// Grows the window once when the panel would squeeze the map (map is ~0.68 as tall as wide).
let fittedFor = 0;
function fitWindow() {
  const extra = $('sys').offsetHeight + $('status').offsetHeight;
  if (!extra || extra === fittedFor) return;
  fittedFor = extra;
  const need = Math.ceil(innerWidth * 0.68 + extra);
  if (innerHeight < need - 20) window.bridge.fitHeight(need);
}

// ---------- settings / state ----------

function applySettings(s) {
  settings = s;
  document.body.style.opacity = s.opacity;
  document.body.classList.toggle('no-labels', !s.labels);
  document.body.classList.toggle('locked', !!s.locked);
  document.body.classList.toggle('passive', s.layer === 'desktop' && !s.editMode);
  if (!s.sys || !s.sys.show) renderSys(null);
  paint();
}

(async () => {
  await buildMap();
  applySettings(await window.bridge.getSettings());
  state = await window.bridge.getState();
  paint();
  window.bridge.onSettings(applySettings);
  window.bridge.onState((s) => {
    state = s;
    paint();
    if (tipTarget) showTip(tipTarget.uid, tipTarget.ev);
  });
  window.bridge.onSys(renderSys);
  setIgnore(true);
  setInterval(paintStatus, 30000);
})();
