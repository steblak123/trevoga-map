// Auto-update from the GitHub repository steblak123/trevoga-map. main.js needs only:
//   const update = require('./update/main');
//   update.start({ settings: () => settings, busy: () => <alert in my regions?>, changed: refreshTray });
//   ...update.menu()   in the tray menu
// Two ways, picked by how the widget was installed:
// - the setup .exe from GitHub Releases (app.isPackaged): electron-updater reads latest.yml of the
//   newest release, downloads the installer in the background and, when there is no alert in your
//   regions, installs it silently — the widget is back in a few seconds; or at once from the tray menu;
// - a git clone (scripts/install.bat, npm start): `git fetch`; when the clone is clean and only behind,
//   `git merge --ff-only`, then a restart (`npm install` first if package.json changed). Local edits
//   or commits are never touched: the clone is then only reported as "has local changes".
// Checks a minute after start and every 6 hours. The renderer talks over "update:*" IPC channels.
const { app, ipcMain, BrowserWindow, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const APP_ID = 'ua.trevoga.map';
const RELEASES = 'https://github.com/steblak123/trevoga-map/releases';
const FIRST_CHECK_MS = 60 * 1000;
const EVERY_MS = 6 * 3600 * 1000;
const CALM_EVERY_MS = 5 * 60 * 1000; // a ready update waits for a moment without alerts
const RETRY_AFTER_MS = 24 * 3600 * 1000; // an install that did not take is not retried on its own sooner
const ROOT = path.join(__dirname, '..', '..');

let opts = { settings: () => ({}), busy: () => false, changed: () => {} };
let memoFile = null; // userData/update.json: { target, from, at } of the last install
let memo = {};
let doCheck = async () => {};
let doInstall = () => {};
let calmTimer = null;
let manual = false; // the running check was asked for by the user: tell the result
let toldFor = null; // the update the user was already told about
let gitFiles = [];

const state = {
  mode: null, // 'release' | 'git' | null: updates do not reach this copy
  version: app.getVersion(),
  build: '', // git: short commit of the running copy
  status: 'idle', // idle | checking | latest | downloading | ready | installing | blocked | error
  next: '', // the version (release) or the number of new commits (git) on offer
  percent: 0,
  notes: [], // what is new: lines of the release notes / subjects of the new commits
  error: '',
  checkedAt: 0,
  releases: RELEASES,
};

const log = (...a) => console.log('[update]', ...a);

function set(patch) {
  Object.assign(state, patch);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', state);
  opts.changed();
}

const autoOn = () => {
  const u = opts.settings().update;
  return !u || u.auto !== false;
};

function shortError(e) {
  const msg = String((e && (e.stderr || e.message)) || e || '').trim().split('\n')[0];
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::ERR_|getaddrinfo|Could not resolve host|unable to access/i.test(msg)) return 'немає зв’язку з GitHub';
  if (/404|No published versions|Cannot find latest/i.test(msg)) return 'на GitHub ще немає релізу';
  if (/spawn git ENOENT/i.test(msg)) return 'git не знайдено';
  if (/no upstream/i.test(msg)) return 'гілка не пов’язана з GitHub';
  if (/local changes|not possible to fast-forward/i.test(msg)) return 'є локальні зміни';
  return msg.slice(0, 140) || 'невідома помилка';
}

function loadMemo() {
  try {
    memo = JSON.parse(fs.readFileSync(memoFile, 'utf8')) || {};
  } catch {
    memo = {};
  }
}

function saveMemo(m) {
  memo = m;
  try {
    fs.writeFileSync(memoFile, JSON.stringify(m));
  } catch (e) {
    log('memo:', e.message);
  }
}

function toast(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true, icon: path.join(__dirname, '..', 'assets', 'icon.png') });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch (e) {
    log('notification:', e.message);
  }
}

// An earlier install of this very target did not take (we still run the old copy): wait for a click.
const failedBefore = (target) => memo.target === target && Date.now() - (memo.at || 0) < RETRY_AFTER_MS;
const targetOf = () => (state.mode === 'git' ? state.target : state.next);
// Not now: an alert in your regions or a banner on screen, or the settings window in use.
const busy = () => opts.busy() || !!BrowserWindow.getFocusedWindow();
const mayInstall = () => state.status === 'ready' && autoOn() && !failedBefore(targetOf()) && !busy();

function install() {
  if (state.status !== 'ready') return;
  clearInterval(calmTimer);
  calmTimer = null;
  saveMemo({ target: targetOf(), from: state.build || state.version, at: Date.now() });
  set({ status: 'installing' });
  doInstall();
}

// A ready update: installed now when allowed, else at the first calm moment (checked every 5 min);
// when it may not install by itself (auto-update off, or it did not take before), a toast offers it once.
function whenCalm() {
  if (state.status !== 'ready') return;
  const target = targetOf();
  if ((!autoOn() || failedBefore(target)) && toldFor !== target) {
    toldFor = target;
    const what = state.mode === 'git' ? 'Нові зміни на GitHub' : `Версія ${state.next}`;
    toast('Доступне оновлення', `${what}. Натисніть, щоб встановити.`, install);
  }
  if (mayInstall()) return install();
  if (!calmTimer) calmTimer = setInterval(() => mayInstall() && install(), CALM_EVERY_MS);
}

// ---------- installed copy: GitHub Releases ----------

function startRelease() {
  let updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    log('electron-updater:', e.message);
    return false;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // also on "Вихід" from the tray
  updater.logger = { info: log, warn: log, error: log, debug() {} };
  const notesOf = (info) => {
    const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note).join('\n') : info.releaseNotes || '';
    return String(raw)
      .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((l) => l.replace(/^[\s*•-]+/, '').trim())
      .filter((l) => l && !/^(what's changed|full changelog|що нового)/i.test(l))
      .slice(0, 5);
  };
  updater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  updater.on('update-available', (info) => set({ status: 'downloading', next: info.version, percent: 0, notes: notesOf(info) }));
  updater.on('update-not-available', () => {
    set({ status: 'latest', next: '', notes: [], checkedAt: Date.now() });
    if (manual) toast('Оновлень немає', `Встановлено останню версію ${state.version}.`);
    manual = false;
  });
  updater.on('download-progress', (p) => set({ percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => {
    set({ status: 'ready', next: info.version, notes: notesOf(info), percent: 100, checkedAt: Date.now() });
    manual = false;
    whenCalm();
  });
  updater.on('error', (e) => {
    if (state.status === 'installing') return set({ status: 'ready', error: shortError(e) });
    set({ status: 'error', error: shortError(e), checkedAt: Date.now() });
    manual = false;
  });
  doCheck = () => updater.checkForUpdates().catch((e) => set({ status: 'error', error: shortError(e) }));
  doInstall = () => setImmediate(() => updater.quitAndInstall(true, true)); // silent, start again after
  return true;
}

// ---------- git clone ----------

// Never wait for a password: a background fetch of the public repository needs none.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, env: GIT_ENV, timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(String(stdout).trim());
    });
  });
}
const git = (...args) => run('git', args);

// Not in the middle of something the owner of the clone is doing (git am, merge, rebase).
const midOperation = () =>
  ['rebase-apply', 'rebase-merge', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((f) => fs.existsSync(path.join(ROOT, '.git', f)));

async function checkGit() {
  set({ status: 'checking', error: '' });
  try {
    const head = await git('rev-parse', '--short', 'HEAD');
    const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
    await git('fetch', '--quiet', '--no-tags', upstream.split('/')[0]);
    const [behind, ahead] = (await git('rev-list', '--left-right', '--count', '@{u}...HEAD')).split(/\s+/).map(Number);
    const base = { build: head, checkedAt: Date.now() };
    if (!behind) {
      set({ ...base, status: 'latest', next: '', notes: [] });
      if (manual) toast('Оновлень немає', 'Ця копія збігається з GitHub.');
      return;
    }
    if (ahead || midOperation() || (await git('status', '--porcelain', '--untracked-files=no'))) {
      return set({ ...base, status: 'blocked', next: String(behind), notes: [] });
    }
    const notes = (await git('log', '--format=%s', '-n', '5', 'HEAD..@{u}')).split('\n').filter(Boolean);
    gitFiles = (await git('diff', '--name-only', 'HEAD', '@{u}')).split('\n').filter(Boolean);
    set({ ...base, status: 'ready', next: String(behind), notes, target: await git('rev-parse', '--short', '@{u}') });
    whenCalm();
  } catch (e) {
    set({ status: 'error', error: shortError(e), checkedAt: Date.now() });
  } finally {
    manual = false;
  }
}

// Starts the widget again once this process is gone; `npm install` first when the dependencies changed.
// A small Node script does the waiting: the widget's own electron.exe must be free for npm to replace it.
function restartLater(npmInstall) {
  const script = path.join(app.getPath('temp'), 'trevoga-map-restart.js');
  fs.writeFileSync(
    script,
    `const { spawn, spawnSync } = require('child_process');
const [pid, root, exe, npm] = process.argv.slice(2);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
(function wait(n) {
  if (alive() && n < 120) return setTimeout(() => wait(n + 1), 500);
  if (npm === '1') spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, [root], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
})(0);
`,
  );
  const args = [script, String(process.pid), ROOT, process.execPath, npmInstall ? '1' : '0'];
  // The system Node when there is one (npm needs it anyway), else Electron's own Node.
  const child = spawn(npmInstall ? 'node' : process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', () => {
    if (npmInstall) restartLater(false); // no Node in PATH: restart without npm install
  });
  child.unref();
}

async function installGit() {
  try {
    if (midOperation() || (await git('status', '--porcelain', '--untracked-files=no'))) throw new Error('local changes');
    await git('merge', '--ff-only', '--quiet', '@{u}');
  } catch (e) {
    return set({ status: 'blocked', error: shortError(e) });
  }
  const deps = gitFiles.some((f) => /^package(-lock)?\.json$/.test(f));
  const code = deps || gitFiles.some((f) => f.startsWith('app/'));
  const build = await git('rev-parse', '--short', 'HEAD').catch(() => state.build);
  if (!code) {
    // Only docs or build scripts changed: nothing to restart for.
    saveMemo({});
    return set({ status: 'latest', next: '', notes: [], build });
  }
  saveMemo({ ...memo, done: true });
  restartLater(deps);
  app.quit();
}

// ---------- start ----------

function start(o) {
  opts = { ...opts, ...o };
  memoFile = path.join(app.getPath('userData'), 'update.json');
  loadMemo();
  if (app.isPackaged) {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // Windows shows toasts of a known app only
    if (startRelease()) state.mode = 'release';
  } else if (fs.existsSync(path.join(ROOT, '.git'))) {
    state.mode = 'git';
    doCheck = checkGit;
    doInstall = installGit;
  }
  // The first start after an update: say so once.
  if (memo.target && (memo.target === state.version || memo.done)) {
    const what = state.mode === 'git' ? 'з GitHub' : `до версії ${state.version}`;
    setTimeout(() => toast('Карта тривог оновлена', `Оновлено ${what}.`), 4000);
    saveMemo({});
  }
  if (!state.mode) return;
  setTimeout(() => doCheck(), FIRST_CHECK_MS);
  setInterval(() => doCheck(), EVERY_MS);
}

function check() {
  if (!state.mode || ['checking', 'downloading', 'installing'].includes(state.status)) return;
  manual = true;
  doCheck();
}

ipcMain.handle('update:get', () => state);
ipcMain.on('update:check', check);
ipcMain.on('update:install', install);

// Tray menu entries.
function menu() {
  if (!state.mode) return [];
  if (state.status === 'ready') {
    const what = state.mode === 'git' ? 'з GitHub' : `до ${state.next}`;
    return [{ label: `Оновити ${what} (перезапуск)`, click: install }];
  }
  if (state.status === 'downloading') return [{ label: `Завантаження оновлення ${state.next}… ${state.percent}%`, enabled: false }];
  if (state.status === 'installing') return [{ label: 'Встановлення оновлення…', enabled: false }];
  return [{ label: 'Перевірити оновлення', click: check }];
}

module.exports = { start, menu, check, install, state };
