// Main-process part of the targets layer. main.js needs only:  require('./neptun/main');
// - the "target near your regions" banner: its own small always-on-top window in the top-right
//   corner (the air-raid banner is at the top centre). It shows for 5 s and lets clicks through;
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

// ---------- your own Telegram channels ----------
// Public channels have a web preview, https://t.me/s/<channel>: the latest posts, no login, no bot. The widget
// sends the list (settings.neptun.channels) over "neptun:tg-channels"; the posts go back over "neptun:tg-posts"
// as { channel: '@name', id, date, text, reply: { id, text } | null } — the shape of the posts of the NEPTUN feed
// plus the post number and the post it answers, so routes.js can follow a target from reply to reply.
// The widget says "fast" ("neptun:tg-fast") while a target is in your radius or your regions are under an alert:
// then every 8 s. A channel that answers 429 (too many requests) or fails rests for a minute.
const TG_EVERY = 45000;
const TG_FAST = 8000;
const TG_REST = 60000;
let tgFast = false;
let tgBusy = false;
const tgRest = new Map(); // name -> until when it is not asked
const TG_NAME = /^[A-Za-z0-9_]{4,32}$/;
let tgSender = null;
let tgList = [];
let tgTimer = null;

const decode = (s) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

// Posts of the t.me/s page: a post's own text is the block marked js-message_text; the post it answers is
// quoted in tgme_widget_message_reply (its link has the number, js-message_reply_text the text).
function parseTg(html, name) {
  const out = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const id = /data-post="[^"/]+\/(\d+)"/.exec(block);
    const text = /class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const time = /<time[^>]*datetime="([^"]+)"/.exec(block);
    if (!text || !time) continue;
    const reply = /tgme_widget_message_reply[^"]*" href="[^"]*\/(\d+)"[\s\S]*?js-message_reply_text"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const t = decode(text[1]);
    if (t) out.push({ channel: '@' + name, id: id ? Number(id[1]) : null, date: time[1], text: t, reply: reply ? { id: Number(reply[1]), text: decode(reply[2]) } : null });
  }
  return out;
}

async function pollTg() {
  if (!tgSender || tgSender.isDestroyed() || !tgList.length || tgBusy) return;
  tgBusy = true;
  const posts = [];
  const now = Date.now();
  await Promise.all(
    tgList
      .filter((name) => !(tgRest.get(name) > now))
      .map(async (name) => {
        try {
          const res = await fetch(`https://t.me/s/${name}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 trevoga-map', 'Cache-Control': 'no-cache' },
            signal: AbortSignal.timeout(tgFast ? 7000 : 15000),
          });
          if (res.ok) posts.push(...parseTg(await res.text(), name));
          else tgRest.set(name, Date.now() + TG_REST);
        } catch (e) {
          if (!tgFast) tgRest.set(name, Date.now() + TG_REST);
          console.log('[telegram]', name, e.message);
        }
      }),
  );
  tgBusy = false;
  if (posts.length && !tgSender.isDestroyed()) tgSender.send('neptun:tg-posts', posts);
}

function scheduleTg() {
  clearInterval(tgTimer);
  tgTimer = tgList.length ? setInterval(pollTg, tgFast ? TG_FAST : TG_EVERY) : null;
}

ipcMain.on('neptun:tg-fast', (_e, on) => {
  if (!!on === tgFast) return;
  tgFast = !!on;
  scheduleTg();
  if (tgFast) pollTg();
});

ipcMain.on('neptun:tg-channels', (e, list) => {
  tgSender = e.sender;
  const next = [...new Set((Array.isArray(list) ? list : []).map((n) => String(n).trim()).filter((n) => TG_NAME.test(n)))].slice(0, 12);
  if (next.join() === tgList.join() && tgTimer) return;
  tgList = next;
  scheduleTg();
  if (tgList.length) pollTg();
});

module.exports = { parseTg };
