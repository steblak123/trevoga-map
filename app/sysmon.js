// PC load sampler with the same metrics as Task Manager's Performance tab:
// CPU (+ clock), memory, each physical disk, each network adapter, each GPU.
const os = require('os');
const { execFile } = require('child_process');
const native = require('./native');

let perf = null;
let gpuNames = [];
try {
  perf = native.perfCounters();
  gpuNames = native.gpuAdapters();
} catch {}

// Disk number -> "SSD (NVMe)" / "HDD (SATA)", read once in the background.
const diskKinds = {};
execFile(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-Command', 'Get-PhysicalDisk | Select-Object DeviceId,MediaType,BusType | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 30000 },
  (err, stdout) => {
    if (err) return;
    try {
      const list = [].concat(JSON.parse(stdout));
      for (const d of list) {
        const media = d.MediaType && d.MediaType !== 'Unspecified' ? d.MediaType : '';
        diskKinds[d.DeviceId] = media && d.BusType ? `${media} (${d.BusType})` : media || d.BusType || '';
      }
    } catch {}
  },
);

let prevCpu = null;
let prevNet = null;
let prevAt = 0;

// Fallback when performance counters are unavailable.
function cpuFromTimes() {
  const cur = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  if (prevCpu) {
    cur.forEach((t, i) => {
      const p = prevCpu[i];
      if (!p) return;
      const busy = t.user + t.nice + t.sys + t.irq - (p.user + p.nice + p.sys + p.irq);
      const free = t.idle - p.idle;
      idle += free;
      total += busy + free;
    });
  }
  prevCpu = cur;
  return total > 0 ? Math.round((1 - idle / total) * 100) : null;
}

// Connection names ("Ethernet 2", "Wi-Fi") by MAC.
function adapterNames() {
  const names = {};
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) if (a.mac) names[a.mac.replace(/:/g, '').toLowerCase()] = name;
  }
  return names;
}

// Bits/s per adapter since the previous sample (Task Manager shows bits);
// 32-bit counters wrap, hence the modulo.
function nets(now) {
  const cur = native.netCounters();
  const names = adapterNames();
  const secs = (now - prevAt) / 1000;
  const list = Object.entries(cur).map(([mac, c]) => {
    const p = prevNet && prevNet[mac];
    const rate = (a, b) => (p && secs > 0 ? (((a - b + 0x100000000) % 0x100000000) * 8) / secs : null);
    return {
      id: mac,
      name: names[mac] || (c.wifi ? 'Wi-Fi' : 'Ethernet'),
      wifi: c.wifi,
      down: p ? rate(c.in, p.in) : null,
      up: p ? rate(c.out, p.out) : null,
    };
  });
  prevNet = cur;
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function shortGpuName(name) {
  return name.replace(/^(NVIDIA\s+GeForce|NVIDIA|AMD\s+Radeon\(TM\)|AMD|Intel\(R\))\s+/i, '').trim();
}

function sample() {
  const now = Date.now();
  const c = (perf && perf.read()) || { cpu: null, ghz: null, disks: [], gpus: {} };
  let netList = [];
  try {
    netList = nets(now);
  } catch {}
  prevAt = now;
  const total = os.totalmem();
  return {
    cpu: { pct: c.cpu ?? cpuFromTimes(), ghz: c.ghz },
    ram: { used: total - os.freemem(), total },
    disks: c.disks.map((d) => ({ ...d, id: `disk${d.num}`, kind: diskKinds[d.num] || '' })),
    nets: netList,
    gpus: gpuNames.map((g) => ({ id: g.luid, name: shortGpuName(g.name), full: g.name, pct: c.gpus[g.luid] ?? 0 })),
  };
}

// Cells available on this PC, for the settings list: [{ id, group, title }].
function items(s) {
  return [
    { id: 'cpu', group: 'Процесор', title: 'ЦП' },
    { id: 'ram', group: "Пам'ять", title: "Оперативна пам'ять" },
    ...s.disks.map((d) => ({
      id: d.id,
      group: 'Диски',
      title: `Диск ${d.num}${d.letters ? ` (${d.letters})` : ''}${d.kind ? ' · ' + d.kind : ''}`,
    })),
    ...s.nets.map((n) => ({ id: n.id, group: 'Мережа', title: n.name })),
    ...s.gpus.map((g) => ({ id: g.id, group: 'Відеокарти', title: g.full })),
  ];
}

module.exports = { sample, items };
