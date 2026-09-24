// Win32 helpers (via koffi) for pinning the widget to the desktop layer.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 name)');
const FindWindowExW = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 name)');
const SendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, void *result)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const SetParent = user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)');
const GetParent = user32.func('intptr_t __stdcall GetParent(intptr_t hwnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)');
const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');

const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const GWLP_HWNDPARENT = -8;

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function progman() {
  return FindWindowW('Progman', null);
}

// "Bottom" layer: owned by the desktop (Progman) so Win+D does not hide it,
// and kept at the bottom of the z-order, above the desktop icons.
function pinBottom(win) {
  const h = hwndOf(win);
  const pm = progman();
  if (pm) SetWindowLongPtrW(h, GWLP_HWNDPARENT, pm);
  SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function sendToBottom(win) {
  SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

// Finds the window that sits between the wallpaper and the desktop icons.
// Returns { parent, insertAfter } where insertAfter (optional) is the sibling
// our window must be placed below.
function findDesktopHost() {
  const pm = progman();
  if (!pm) return null;
  // Ask Progman to spawn the WorkerW behind the icons (same trick as wallpaper engines).
  SendMessageTimeoutW(pm, 0x052c, 0xd, 0x1, 0, 1000, null);
  SendMessageTimeoutW(pm, 0x052c, 0, 0, 0, 1000, null);

  // Windows 11 24H2+: DefView and the wallpaper WorkerW are both children of Progman.
  const defViewInProgman = FindWindowExW(pm, 0, 'SHELLDLL_DefView', null);
  const workerInProgman = FindWindowExW(pm, 0, 'WorkerW', null);
  if (defViewInProgman && workerInProgman) {
    return { parent: pm, insertAfter: defViewInProgman };
  }

  // Older layout: top-level WorkerW that follows the one hosting DefView.
  let host = 0;
  EnumWindows((top) => {
    if (FindWindowExW(top, 0, 'SHELLDLL_DefView', null)) {
      host = FindWindowExW(0, top, 'WorkerW', null);
    }
    return true;
  }, 0);
  if (host) return { parent: host };
  return null;
}

// "Under icons" layer. `physBounds` are screen coordinates in physical pixels.
function pinUnderIcons(win, physBounds) {
  const h = hwndOf(win);
  const host = findDesktopHost();
  if (!host) return false;
  SetWindowLongPtrW(h, GWLP_HWNDPARENT, 0);
  SetParent(h, host.parent);
  moveChild(win, physBounds, host);
  return true;
}

function moveChild(win, physBounds, host) {
  const h = hwndOf(win);
  const parent = host ? host.parent : GetParent(h);
  if (!parent) return;
  const r = {};
  GetWindowRect(parent, r);
  const after = host && host.insertAfter ? host.insertAfter : 0;
  const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
  SetWindowPos(h, after, physBounds.x - r.left, physBounds.y - r.top, physBounds.width, physBounds.height, flags);
}

function unpinFromDesktop(win) {
  const h = hwndOf(win);
  if (GetParent(h)) SetParent(h, 0);
}

function isParentAlive(win) {
  const p = GetParent(hwndOf(win));
  return !p || IsWindow(p);
}

function isLeftButtonDown() {
  return (GetAsyncKeyState(0x01) & 0x8000) !== 0;
}

module.exports = {
  pinBottom, sendToBottom, pinUnderIcons, unpinFromDesktop, moveChild, isParentAlive, isLeftButtonDown,
};
