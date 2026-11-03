// Main-process part of the targets layer. main.js needs only:  require('./neptun/main');
// - the "target near your regions" banner: its own small always-on-top window in the top-right
//   corner (the air-raid banner is at the top centre). It shows for 2 s and lets clicks through;
// - links in app windows open in the default browser, never inside an app window.
// The widget and the settings page talk to it over "neptun:*" IPC channels (window.bridge.neptun).
const { app, shell, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const external = (url) => {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
};

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    e.preventDefault();
    external(url);
  });
});

// ---------- alert banner ----------

let win = null;
let shown = false;

function ensureWin() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 420,
    height: 120,
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
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, 'alert.html'));
  win.on('closed', () => (win = null));
  return win;
}

function hide() {
  shown = false;
  if (win && !win.isDestroyed()) win.hide();
}

// Targets that just came close (from the widget) or a test (from the settings page).
ipcMain.on('neptun:alert', (_e, payload) => {
  if (!payload || !payload.items || !payload.items.length) return;
  shown = true;
  const w = ensureWin();
  const send = () => w.webContents.send('neptun:alert', payload);
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
});

// The page reports the banner size; the window is exactly that big, in the top-right corner.
ipcMain.on('neptun:alert-size', (_e, { width, height }) => {
  if (!win || win.isDestroyed() || !shown) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(Math.ceil(width), wa.width);
  win.setBounds({ x: wa.x + wa.width - w - 6, y: wa.y + 6, width: w, height: Math.min(Math.ceil(height), wa.height) });
  if (!win.isVisible()) win.showInactive();
});

// The banner faded out by itself.
ipcMain.on('neptun:alert-done', hide);
