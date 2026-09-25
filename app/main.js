const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Regions = require('./regions');
const native = require('./native');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.alerts.in.ua';
const IOT_INTERVAL = 15000; // IoT string every 15 s, active.json every 30 s -> 6 req/min (limit 8-10)
const STARTUP_LNK = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'trevoga-map.lnk');

app.setPath('userData', path.join(app.getPath('appData'), 'trevoga-map'));
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  token: '',
  regions: [], // selected raion / city UIDs
  sound: false,
  volume: 0.7,
  overlay: true,
  layer: 'bottom', // 'bottom' | 'desktop'
  labels: true,
  opacity: 1,
  locked: false,
  bounds: null,
};

// Default token baked in at build time (see build/prepare-token.js); a user token in settings wins.
const EMBEDDED_TOKEN = (() => {
  try {
    const { t } = JSON.parse(fs.readFileSync(path.join(__dirname, 'embedded.json'), 'utf8'));
    const key = Buffer.from('trevoga-map');
    return Buffer.from(t, 'base64').map((b, i) => b ^ key[i % key.length]).toString('utf8');
  } catch {
    return '';
  }
})();

let settings = loadSettings();

function apiToken() {
  return settings.token || EMBEDDED_TOKEN;
}
let widget = null;
let overlay = null;
let settingsWin = null;
let tray = null;
let editMode = false;
let quitting = false;

// history: uid -> { start, end } of the last finished alert; starts: uid -> start of the ongoing one.
const state = { iot: null, alerts: null, updatedAt: null, error: null, history: {}, starts: {} };
const lastModified = { iot: null, active: null };
let pollTimer = null;
let tick = 0;
let prevStatus = null; // Map uid -> 'A' | 'P' | 'N' for selected regions
let overlayState = null;

const MAP_JSON = fs.readFileSync(path.join(__dirname, 'assets', 'map.json'), 'utf8');
const RAION_NAMES = Object.fromEntries(
  JSON.parse(MAP_JSON)
    .raions.filter((r) => Regions.isRaion(r.uid))
    .map((r) => [r.uid, r.name]),
);

const ALL_UIDS = JSON.parse(MAP_JSON).raions.map((r) => r.uid);
const HISTORY_FILE = path.join(app.getPath('userData'), 'history.json');

function regionName(uid) {
  return RAION_NAMES[uid] || (Regions.OBLAST_BY_UID[uid] || {}).name || `#${uid}`;
}

// ---------- alert history ----------
// Every raion: start/end observed from the IoT status while the widget runs.
// Selected raions: exact times from /v1/regions/{oblast}/alerts/month_ago.json
// (separate limit of 2 req/min, so requests are queued 35 s apart).

try {
  state.history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch {}

let prevAll = null;
const HISTORY_GAP = 35000;
const historyQueue = new Set();
let historyTimer = null;
let lastHistoryAt = 0;

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(state.history));
  } catch {}
}

function trackTransitions() {
  const now = Date.now();
  const cur = {};
  let changed = false;
  for (const uid of ALL_UIDS) {
    const on = Regions.statusOf(state.iot, uid) === 'A';
    cur[uid] = on;
    if (on) {
      const since = Regions.alertSince(state.alerts, uid, RAION_NAMES[uid]);
      if (since) state.starts[uid] = since;
      else if (!state.starts[uid] && prevAll) state.starts[uid] = now;
    } else if (prevAll && prevAll[uid]) {
      state.history[uid] = { start: state.starts[uid] || null, end: now };
      delete state.starts[uid];
      changed = true;
    } else delete state.starts[uid];
  }
  prevAll = cur;
  if (changed) saveHistory();
}

function historyTarget(uid) {
  return Regions.isRaion(uid) ? Regions.oblastOf(uid) : uid;
}

function queueHistory(delay = 0) {
  for (const uid of settings.regions) historyQueue.add(historyTarget(uid));
  if (historyTimer || !historyQueue.size) return;
  const wait = Math.max(delay, lastHistoryAt + HISTORY_GAP - Date.now(), 0);
  historyTimer = setTimeout(runHistory, wait);
}

async function runHistory() {
  historyTimer = null;
  const [target] = historyQueue;
  if (target == null || !apiToken()) return;
  historyQueue.delete(target);
  lastHistoryAt = Date.now();
  try {
    const res = await fetch(`${API}/v1/regions/${target}/alerts/month_ago.json`, {
      headers: { Authorization: `Bearer ${apiToken()}` },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) applyHistory(target, (await res.json()).alerts || []);
  } catch {}
  if (historyQueue.size) historyTimer = setTimeout(runHistory, HISTORY_GAP);
}

function applyHistory(target, alerts) {
  for (const uid of settings.regions) {
    if (historyTarget(uid) !== target) continue;
    const raion = Regions.isRaion(uid);
    const list = alerts.filter((a) => {
      if (a.alert_type !== 'air_raid') return false;
      const loc = Number(a.location_uid);
      if (raion) return (a.location_type === 'raion' && loc === uid) || (a.location_type === 'oblast' && loc === target);
      return loc === uid;
    });
    const sessions = Regions.mergeSessions(list);
    const last = sessions.filter((s) => s.end).pop();
    const known = state.history[uid];
    // A locally observed all-clear newer than the API data wins (the API may lag).
    if (last && (!known || last.end >= known.end - 60000)) state.history[uid] = last;
    const open = sessions.find((s) => s.end === null);
    if (open && Regions.statusOf(state.iot, uid) === 'A') state.starts[uid] = open.start;
  }
  saveHistory();
  broadcastState();
}

// ---------- settings ----------

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function updateSettings(patch) {
  const old = settings;
  settings = { ...settings, ...patch };
  saveSettings();
  if (patch.layer && patch.layer !== old.layer) {
    editMode = false;
    applyLayer();
  }
  if (patch.token !== undefined && patch.token !== old.token) {
    lastModified.iot = lastModified.active = null;
    startPolling();
  }
  if (patch.regions) rebaseline();
  broadcastSettings();
  refreshTray();
}

function broadcastSettings() {
  for (const w of [widget, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('settings', publicSettings());
}

function publicSettings() {
  return { ...settings, autostart: isAutostart(), editMode, hasEmbeddedToken: !!EMBEDDED_TOKEN };
}

// ---------- autostart (Startup-folder shortcut to scripts/start-widget.vbs) ----------

function isAutostart() {
  return fs.existsSync(STARTUP_LNK);
}

function setAutostart(on) {
  if (!on) {
    if (fs.existsSync(STARTUP_LNK)) fs.unlinkSync(STARTUP_LNK);
    return;
  }
  const opts = app.isPackaged
    ? { target: process.execPath, cwd: path.dirname(process.execPath) }
    : {
        target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
        args: `"${path.join(ROOT, 'scripts', 'start-widget.vbs')}"`,
        cwd: ROOT,
      };
  shell.writeShortcutLink(STARTUP_LNK, 'create', { ...opts, description: 'Карта повітряних тривог' });
}

// ---------- API polling ----------

async function apiGet(pathname, key) {
  const headers = { Authorization: `Bearer ${apiToken()}` };
  if (lastModified[key]) headers['If-Modified-Since'] = lastModified[key];
  const res = await fetch(API + pathname, { headers, signal: AbortSignal.timeout(10000) });
  if (res.status === 304) return undefined;
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  lastModified[key] = res.headers.get('last-modified');
  return res.json();
}

function startPolling() {
  clearTimeout(pollTimer);
  tick = 0;
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  let delay = IOT_INTERVAL;
  if (!apiToken()) {
    state.error = 'Вкажіть токен API в налаштуваннях';
    broadcastState();
  } else {
    try {
      const iot = await apiGet('/v1/iot/active_air_raid_alerts.json', 'iot');
      if (iot !== undefined) state.iot = iot;
      if (tick % 2 === 0) {
        const active = await apiGet('/v1/alerts/active.json', 'active');
        if (active !== undefined) state.alerts = compactAlerts(active.alerts || []);
      }
      tick++;
      state.updatedAt = Date.now();
      state.error = null;
      trackTransitions();
    } catch (e) {
      if (e.status === 401) state.error = 'Невірний або неактивний токен (401)';
      else if (e.status === 403) state.error = 'Доступ заборонено (403)';
      else if (e.status === 429) {
        state.error = 'Забагато запитів (429), пауза 1 хв';
        delay = 60000;
      } else state.error = 'Немає зв’язку з alerts.in.ua';
    }
    broadcastState();
    checkMyRegions();
  }
  pollTimer = setTimeout(poll, delay);
}

function compactAlerts(list) {
  return list.map((a) => ({
    location_uid: a.location_uid,
    location_title: a.location_title,
    location_type: a.location_type,
    location_oblast_uid: a.location_oblast_uid,
    location_raion: a.location_raion,
    alert_type: a.alert_type,
    alert_level: a.alert_level,
    started_at: a.started_at,
    notes: a.notes,
    threats: a.threats,
  }));
}

function broadcastState() {
  if (widget && !widget.isDestroyed()) widget.webContents.send('state', state);
}

// ---------- "my regions" notifications ----------

function currentStatuses() {
  const map = new Map();
  for (const uid of settings.regions) map.set(uid, Regions.statusOf(state.iot, uid));
  return map;
}

function rebaseline() {
  if (!state.iot) return;
  prevStatus = currentStatuses();
  updateOverlayList();
  queueHistory();
}

function activeItems(statuses) {
  const items = [];
  for (const [uid, st] of statuses) {
    if (st === 'N') continue;
    const al = Regions.alertsFor(state.alerts, uid, RAION_NAMES[uid]);
    const since = Regions.alertSince(state.alerts, uid, RAION_NAMES[uid]) || state.starts[uid] || null;
    const places = st === 'P' ? Regions.partialPlaces(state.alerts, uid, RAION_NAMES[uid]) : [];
    items.push({ uid, name: regionName(uid), status: st, since, places, level: al.some((a) => a.alert_level === 'red') ? 'red' : al.length ? al[0].alert_level : null });
  }
  return items;
}

function checkMyRegions() {
  if (!state.iot) return;
  const now = currentStatuses();
  const first = prevStatus === null;
  let started = false;
  const cleared = [];
  for (const [uid, st] of now) {
    const was = first ? 'N' : prevStatus.get(uid) || 'N';
    if (was === 'N' && st !== 'N') started = true;
    if (was !== 'N' && st === 'N') cleared.push(uid);
  }
  prevStatus = now;
  const items = activeItems(now);
  refreshTray();
  if (first) queueHistory(3000);
  // Give the API a minute to close the record, then fetch exact start/end times.
  if (cleared.length) queueHistory(70000);

  if (started) showOverlay({ kind: 'alert', items, sound: true });
  else if (items.length === 0 && cleared.length) {
    const done = cleared.map((uid) => ({ uid, name: regionName(uid), ...(state.history[uid] || {}) }));
    showOverlay({ kind: 'clear', items: done, sound: true });
  } else updateOverlayList();
}

function updateOverlayList() {
  if (!overlayState || overlayState.kind !== 'alert' || !overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
  const items = activeItems(currentStatuses());
  if (items.length === 0) return hideOverlay();
  showOverlay({ kind: 'alert', items, sound: false });
}

// ---------- windows ----------

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = 560;
  const height = 430;
  return { x: wa.x + wa.width - width - 24, y: wa.y + wa.height - height - 24, width, height };
}

function validBounds(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 80 > a.x && b.x < a.x + a.width - 80 && b.y + 40 > a.y && b.y < a.y + a.height - 40;
  });
}

function createWidget() {
  const b = validBounds(settings.bounds) ? settings.bounds : defaultBounds();
  widget = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: 'Карта тривог',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  widget.loadFile(path.join(__dirname, 'widget.html'));
  widget.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[widget] ${message} (${path.basename(source)}:${line})`);
  });
  widget.once('ready-to-show', () => {
    widget.showInactive();
    applyLayer();
  });
  widget.on('closed', () => {
    widget = null;
    // Explorer restart destroys children of the desktop window: bring the widget back.
    if (!quitting) setTimeout(createWidget, 1500);
  });
}

function physBounds() {
  return screen.dipToScreenRect(widget, widget.getBounds());
}

function applyLayer() {
  if (!widget || widget.isDestroyed()) return;
  const underIcons = settings.layer === 'desktop' && !editMode;
  if (underIcons) {
    if (!native.pinUnderIcons(widget, physBounds())) native.pinBottom(widget);
  } else {
    native.unpinFromDesktop(widget);
    widget.setBounds(settings.bounds && validBounds(settings.bounds) ? settings.bounds : widget.getBounds());
    native.pinBottom(widget);
  }
  widget.webContents.send('settings', publicSettings());
}

function setEditMode(on) {
  editMode = on;
  applyLayer();
  refreshTray();
}

function saveBounds() {
  if (!widget) return;
  settings.bounds = widget.getBounds();
  saveSettings();
}

// Manual move/resize: poll the cursor while the left button is held.
function trackMouse(onMove) {
  const start = screen.getCursorScreenPoint();
  const b = widget.getBounds();
  const timer = setInterval(() => {
    if (!widget || widget.isDestroyed()) return clearInterval(timer);
    const p = screen.getCursorScreenPoint();
    onMove(b, p.x - start.x, p.y - start.y);
    if (!native.isLeftButtonDown()) {
      clearInterval(timer);
      saveBounds();
    }
  }, 16);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    title: 'Карта тривог — налаштування',
    backgroundColor: '#11161f',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    width: 680,
    height: 220,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.on('closed', () => (overlay = null));
  return overlay;
}

function showOverlay(payload) {
  const soundOn = payload.sound && (settings.sound || payload.test);
  const visible = settings.overlay || payload.test;
  // Banner disabled: the hidden overlay page is still used to play the sound.
  if (!visible && !soundOn) return;
  const win = ensureOverlay();
  overlayState = payload;
  const send = () => {
    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: Math.round(wa.x + (wa.width - 680) / 2), y: wa.y + 12, width: 680, height: 220 });
    win.webContents.send('overlay', { ...payload, sound: soundOn, volume: settings.volume, visible });
    if (visible) win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function hideOverlay() {
  overlayState = null;
  if (overlay && !overlay.isDestroyed()) overlay.hide();
}

// ---------- tray ----------

function makeIcon([r, g, b]) {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      const fill = Math.max(0, Math.min(1, 13.5 - d));
      const ring = Math.max(0, Math.min(1, 15.5 - d)) - fill;
      const a = fill + ring;
      if (a <= 0) continue;
      const mix = (v) => Math.round((v * fill + 20 * ring) / a);
      buf[i] = mix(b);
      buf[i + 1] = mix(g);
      buf[i + 2] = mix(r);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function myStatusSummary() {
  if (!settings.regions.length) return { color: [120, 130, 145], text: 'Райони не обрано' };
  if (!state.iot) return { color: [120, 130, 145], text: state.error || 'Завантаження…' };
  const items = activeItems(currentStatuses());
  if (items.length) return { color: [220, 50, 47], text: `Тривога: ${items.map((i) => Regions.shortName(i.name)).join(', ')}` };
  return { color: [60, 170, 90], text: 'У ваших районах спокійно' };
}

function buildMenu() {
  const s = myStatusSummary();
  return Menu.buildFromTemplate([
    { label: s.text, enabled: false },
    { type: 'separator' },
    { label: 'Налаштування…', click: openSettings },
    { type: 'separator' },
    {
      label: 'Над ярликами (нижній шар)',
      type: 'radio',
      checked: settings.layer === 'bottom',
      click: () => updateSettings({ layer: 'bottom' }),
    },
    {
      label: 'Під ярликами (як шпалери)',
      type: 'radio',
      checked: settings.layer === 'desktop',
      click: () => updateSettings({ layer: 'desktop' }),
    },
    {
      label: 'Режим редагування (перемістити / змінити розмір)',
      type: 'checkbox',
      visible: settings.layer === 'desktop',
      checked: editMode,
      click: (i) => setEditMode(i.checked),
    },
    { type: 'separator' },
    { label: 'Закріпити положення', type: 'checkbox', checked: settings.locked, click: (i) => updateSettings({ locked: i.checked }) },
    { label: 'Звук при тривозі / відбої', type: 'checkbox', checked: settings.sound, click: (i) => updateSettings({ sound: i.checked }) },
    { label: 'Плашка поверх екрана', type: 'checkbox', checked: settings.overlay, click: (i) => updateSettings({ overlay: i.checked }) },
    {
      label: 'Автозапуск з Windows',
      type: 'checkbox',
      checked: isAutostart(),
      click: (i) => {
        setAutostart(i.checked);
        broadcastSettings();
        refreshTray();
      },
    },
    { type: 'separator' },
    { label: 'Перевірити плашку і звук', click: testAlert },
    { label: 'Скинути положення', click: resetPosition },
    { label: 'Вихід', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const s = myStatusSummary();
  tray.setImage(makeIcon(s.color));
  tray.setToolTip(`Карта тривог — ${s.text}`);
  tray.setContextMenu(buildMenu());
}

function resetPosition() {
  settings.bounds = defaultBounds();
  saveSettings();
  applyLayer();
  if (widget && settings.layer === 'desktop' && !editMode) native.moveChild(widget, physBounds());
}

function testAlert() {
  const uid = settings.regions[0] || 31;
  showOverlay({ kind: 'alert', test: true, items: [{ uid, name: regionName(uid), status: 'A', since: Date.now() - 5 * 60000, level: 'red' }], sound: true });
  setTimeout(() => {
    if (!overlayState || !overlayState.test) return;
    const end = Date.now();
    showOverlay({ kind: 'clear', test: true, items: [{ uid, name: regionName(uid), start: end - 5 * 60000, end }], sound: true });
  }, 8000);
}

// ---------- IPC ----------

ipcMain.handle('get-settings', () => publicSettings());
ipcMain.handle('set-settings', (_e, patch) => {
  if ('autostart' in patch) {
    setAutostart(patch.autostart);
    delete patch.autostart;
  }
  updateSettings(patch);
  return publicSettings();
});
ipcMain.handle('get-state', () => state);
ipcMain.handle('map-data', () => JSON.parse(MAP_JSON));
ipcMain.on('open-settings', openSettings);
ipcMain.on('test-alert', testAlert);
ipcMain.on('overlay-hide', hideOverlay);
ipcMain.on('overlay-ignore', (_e, ignore) => overlay && overlay.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.on('set-ignore', (_e, ignore) => widget && widget.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.on('context-menu', () => tray && tray.popUpContextMenu(buildMenu()));
ipcMain.on('drag-start', () => {
  if (!widget || settings.locked) return;
  trackMouse((b, dx, dy) => widget.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }));
});
ipcMain.on('resize-start', () => {
  if (!widget || settings.locked) return;
  trackMouse((b, dx, dy) =>
    widget.setBounds({ x: b.x, y: b.y, width: Math.max(220, b.width + dx), height: Math.max(170, b.height + dy) }),
  );
});

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openSettings);
  app.whenReady().then(() => {
    tray = new Tray(makeIcon([120, 130, 145]));
    tray.on('click', openSettings);
    refreshTray();
    createWidget();
    startPolling();
    if (!apiToken() || !settings.regions.length) setTimeout(openSettings, 800);

    screen.on('display-metrics-changed', () => setTimeout(applyLayer, 500));
    setInterval(() => queueHistory(), 15 * 60000);
    // Keep the bottom layer at the bottom, and re-pin if Explorer recreated the desktop.
    setInterval(() => {
      if (!widget || widget.isDestroyed()) return;
      if (settings.layer === 'desktop' && !editMode) {
        if (!native.isParentAlive(widget)) applyLayer();
      } else native.sendToBottom(widget);
    }, 3000);
  });
  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {});
}
