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

// ---------- network byte counters (iphlpapi GetIfTable / MIB_IFROW) ----------

const iphlpapi = koffi.load('iphlpapi.dll');
const GetIfTable = iphlpapi.func('uint32_t __stdcall GetIfTable(_Inout_ uint8_t *table, _Inout_ uint32_t *size, bool order)');

const IFROW_SIZE = 860;
const IF_TYPE_ETHERNET = 6;
const IF_TYPE_WIFI = 71;
const IF_OPER_STATUS_OPERATIONAL = 5;

// Per physical adapter (by MAC): { in, out, wifi } with 32-bit octet counters. Filter
// drivers expose the same adapter several times, so rows are deduplicated by MAC.
function netCounters() {
  const size = [0];
  GetIfTable(null, size, false);
  if (!size[0]) return {};
  const buf = Buffer.alloc(size[0]);
  if (GetIfTable(buf, size, false) !== 0) return {};
  const out = {};
  const n = buf.readUInt32LE(0);
  for (let i = 0; i < n; i++) {
    const o = 4 + i * IFROW_SIZE;
    const type = buf.readUInt32LE(o + 516);
    if (type !== IF_TYPE_ETHERNET && type !== IF_TYPE_WIFI) continue;
    if (buf.readUInt32LE(o + 544) !== IF_OPER_STATUS_OPERATIONAL) continue;
    const macLen = Math.min(buf.readUInt32LE(o + 528), 8);
    const mac = buf.subarray(o + 532, o + 532 + macLen).toString('hex');
    if (!mac || mac.startsWith('00155d')) continue; // no MAC / Hyper-V virtual switch (would double-count)
    const row = { in: buf.readUInt32LE(o + 552), out: buf.readUInt32LE(o + 576), wifi: type === IF_TYPE_WIFI };
    if (!out[mac] || row.in > out[mac].in) out[mac] = row;
  }
  return out;
}

// ---------- GPU names (DXGI) ----------

const dxgi = koffi.load('dxgi.dll');
const GUID = koffi.struct('GUID', { d1: 'uint32_t', d2: 'uint16_t', d3: 'uint16_t', d4: koffi.array('uint8_t', 8) });
koffi.struct('DXGI_ADAPTER_DESC1', {
  Description: koffi.array('char16_t', 128, 'String'),
  VendorId: 'uint32_t',
  DeviceId: 'uint32_t',
  SubSysId: 'uint32_t',
  Revision: 'uint32_t',
  DedicatedVideoMemory: 'size_t',
  DedicatedSystemMemory: 'size_t',
  SharedSystemMemory: 'size_t',
  LuidLow: 'uint32_t',
  LuidHigh: 'int32_t',
  Flags: 'uint32_t',
});
const CreateDXGIFactory1 = dxgi.func('int32_t __stdcall CreateDXGIFactory1(GUID *riid, _Out_ void **factory)');
const EnumAdapters1 = koffi.proto('int32_t __stdcall EnumAdapters1(void *self, uint32_t index, _Out_ void **adapter)');
const GetDesc1 = koffi.proto('int32_t __stdcall GetDesc1(void *self, _Out_ DXGI_ADAPTER_DESC1 *desc)');
const Release = koffi.proto('uint32_t __stdcall Release(void *self)');
const IID_IDXGIFactory1 = { d1: 0x770aae78, d2: 0xf26f, d3: 0x4dba, d4: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87] };
const DXGI_ADAPTER_FLAG_SOFTWARE = 2;

// Calls method `index` of a COM object's vtable.
function vcall(obj, index, proto, ...args) {
  const vtbl = koffi.decode(obj, 'void *');
  const fn = koffi.decode(vtbl, index * koffi.sizeof('void *'), 'void *');
  return koffi.call(fn, proto, obj, ...args);
}

const hex8 = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

// Hardware GPUs in DXGI order (Task Manager numbers them the same way): [{ luid, name }].
function gpuAdapters() {
  const f = [null];
  if (CreateDXGIFactory1(IID_IDXGIFactory1, f) < 0) return [];
  const factory = f[0];
  const list = [];
  try {
    for (let i = 0; ; i++) {
      const a = [null];
      if (vcall(factory, 12, EnumAdapters1, i, a) < 0) break;
      const desc = {};
      if (vcall(a[0], 10, GetDesc1, desc) >= 0 && !(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) {
        list.push({ luid: `${hex8(desc.LuidHigh)}_${hex8(desc.LuidLow)}`, name: desc.Description.replace(/\0.*$/, '').trim() });
      }
      vcall(a[0], 2, Release);
    }
  } finally {
    vcall(factory, 2, Release);
  }
  return list;
}

// ---------- performance counters (pdh.dll), same sources as Task Manager ----------

const pdh = koffi.load('pdh.dll');
const PDH_FMT_COUNTERVALUE = koffi.struct('PDH_FMT_COUNTERVALUE', { CStatus: 'uint32_t', value: 'double' });
const PDH_ITEM = koffi.struct('PDH_FMT_COUNTERVALUE_ITEM_W', { name: 'str16', v: PDH_FMT_COUNTERVALUE });
const PdhOpenQueryW = pdh.func('uint32_t __stdcall PdhOpenQueryW(str16 source, uintptr_t user, _Out_ void **query)');
const PdhAddEnglishCounterW = pdh.func('uint32_t __stdcall PdhAddEnglishCounterW(void *query, str16 path, uintptr_t user, _Out_ void **counter)');
const PdhCollectQueryData = pdh.func('uint32_t __stdcall PdhCollectQueryData(void *query)');
const PdhGetFormattedCounterValue = pdh.func('uint32_t __stdcall PdhGetFormattedCounterValue(void *counter, uint32_t format, _Out_ uint32_t *type, _Out_ PDH_FMT_COUNTERVALUE *value)');
const PdhGetFormattedCounterArrayW = pdh.func('uint32_t __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32_t format, _Inout_ uint32_t *size, _Out_ uint32_t *count, void *items)');

const PDH_FMT_DOUBLE = 0x200;
const PDH_FMT_NOCAP100 = 0x8000;
const valid = (status) => status <= 1; // PDH_CSTATUS_VALID_DATA / NEW_DATA

// Returns { read() } or null if PDH is unavailable. read() gives:
//   cpu: % (Task Manager's "% Processor Utility"), ghz: current clock,
//   disks: [{ num, letters, active }], gpus: { luid: % } (busiest engine, like Task Manager).
function perfCounters() {
  const q = [null];
  if (PdhOpenQueryW(null, 0, q) !== 0) return null;
  const query = q[0];
  const add = (p) => {
    const c = [null];
    return PdhAddEnglishCounterW(query, p, 0, c) === 0 ? c[0] : null;
  };
  const cpu = add('\\Processor Information(_Total)\\% Processor Utility');
  const perf = add('\\Processor Information(_Total)\\% Processor Performance');
  const freq = add('\\Processor Information(_Total)\\Processor Frequency');
  const disk = add('\\PhysicalDisk(*)\\% Idle Time');
  const gpu = add('\\GPU Engine(*)\\Utilization Percentage');
  PdhCollectQueryData(query);

  const single = (counter, fmt = PDH_FMT_DOUBLE) => {
    if (!counter) return null;
    const v = {};
    if (PdhGetFormattedCounterValue(counter, fmt, [0], v) !== 0 || !valid(v.CStatus)) return null;
    return v.value;
  };
  const array = (counter) => {
    if (!counter) return [];
    const size = [0];
    const count = [0];
    PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, size, count, null);
    if (!size[0]) return [];
    const mem = koffi.alloc('uint8_t', size[0]);
    try {
      if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, size, count, mem) !== 0 || !count[0]) return [];
      return koffi.decode(mem, PDH_ITEM, count[0]).filter((it) => valid(it.v.CStatus));
    } finally {
      koffi.free(mem);
    }
  };
  const pct = (v) => (v == null ? null : Math.max(0, Math.min(100, Math.round(v))));

  return {
    read() {
      if (PdhCollectQueryData(query) !== 0) return null;
      const p = single(perf, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100);
      const mhz = single(freq);

      const disks = array(disk)
        .filter((it) => it.name !== '_Total')
        .map((it) => {
          const m = /^(\d+)\s*(.*)$/.exec(it.name) || [];
          return { num: Number(m[1]), letters: (m[2] || '').trim(), active: pct(100 - it.v.value) };
        })
        .filter((d) => !Number.isNaN(d.num))
        .sort((a, b) => a.num - b.num);

      // Sum per engine (instances are per process), then the busiest engine per GPU.
      const engines = {};
      for (const it of array(gpu)) {
        const m = /luid_0x([0-9a-f]+)_0x([0-9a-f]+)_phys_(\d+)_eng_(\d+)/i.exec(it.name);
        if (!m) continue;
        const key = `0x${m[1].toUpperCase()}_0x${m[2].toUpperCase()}|${m[3]}|${m[4]}`;
        engines[key] = (engines[key] || 0) + it.v.value;
      }
      const gpus = {};
      for (const [key, v] of Object.entries(engines)) {
        const luid = key.split('|')[0];
        gpus[luid] = Math.max(gpus[luid] || 0, v);
      }
      for (const k of Object.keys(gpus)) gpus[k] = pct(gpus[k]);

      return {
        cpu: pct(single(cpu)),
        ghz: p != null && mhz ? (mhz * p) / 100 / 1000 : null,
        disks,
        gpus,
      };
    },
  };
}

module.exports = {
  pinBottom, sendToBottom, pinUnderIcons, unpinFromDesktop, moveChild, isParentAlive, isLeftButtonDown,
  netCounters, gpuAdapters, perfCounters,
};

