// Banner "targets near your regions" (window created by neptun/main.js): the targets that just came
// close, as HUD entries, for 5 s; then it fades out by itself. The full list stays in the widget.
// p.calm: the "Акуратний" look of the settings (no glow).
const bar = document.getElementById('bar');
const SHOW_MS = 5000;
const ROWS = 3;
const STATUS = { appr: 'Наближається', pass: 'Проліт', away: 'Віддаляється', hit: 'Удар', unk: 'Невідомо' };
let audio = null;
let timer = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const plural = (n, [one, few, many]) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const icon = (d) => `<svg class="h-ico" viewBox="-8 -8 16 16">${d}</svg>`;
const PIN = icon('<path d="M0-7.2a5 5 0 0 1 5 5C5 1.6 0 7.4 0 7.4S-5 1.6-5-2.2a5 5 0 0 1 5-5Zm0 3.1A1.9 1.9 0 1 0 0-.3 1.9 1.9 0 0 0 0-4.1Z"/>');
const DIST = icon('<path d="M-7.5 0-4-3.4V-1.3H4V-3.4L7.5 0 4 3.4V1.3H-4V3.4Z"/>');
const CLOCK = icon('<circle class="s" r="6" stroke-width="1.6"/><path class="s" stroke-width="1.6" stroke-linecap="round" d="M0-3.4V0l2.6 1.7"/>');

// Two short double beeps: noticeable, but not the air-raid siren.
function beep(volume) {
  if (!audio) audio = new AudioContext();
  const t0 = audio.currentTime + 0.05;
  [0, 0.18, 0.6, 0.78].forEach((dt, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.value = i % 2 ? 660 : 880;
    const t = t0 + dt;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35 * volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  });
}

function entry(i) {
  const T = window.NeptunTypes;
  const meta = T.typeMeta(i.type);
  const st = STATUS[i.status] ? i.status : 'unk';
  const dist = i.vague ? `${DIST}≈${i.km}<small>км</small>` : i.km < 1 ? `${DIST}над районом` : `${DIST}${i.km}<small>км</small>`;
  const badges =
    (i.place ? `<span class="h-b place">${PIN}${esc(i.place)}</span>` : '') +
    `<span class="h-b dist">${dist}</span>` +
    (i.eta ? `<span class="h-b eta">${CLOCK}${i.eta}<small>хв</small></span>` : '') +
    (i.src ? `<span class="h-b src">${esc(i.src)}</span>` : '');
  return (
    `<div class="h-ent r${i.risk || 0}" style="--c:${meta.color}">` +
    `<span class="h-ent-ico" style="--c:${meta.color}"><svg class="h-ico" viewBox="-12 -12 24 24">${meta.icon}</svg></span>` +
    `<span class="h-ent-name">${esc(i.title)}</span><span class="h-b h-st ${st}">${STATUS[st]}</span>` +
    `<span class="h-ent-badges">${badges}</span></div>`
  );
}

function render(p) {
  clearTimeout(timer);
  bar.classList.remove('out');
  const items = (p && p.items) || [];
  if (!items.length) {
    bar.style.display = 'none';
    return;
  }
  const n = items.length;
  bar.querySelector('.h-title').textContent = `${n} ${plural(n, ['ЦІЛЬ', 'ЦІЛІ', 'ЦІЛЕЙ'])} ПОРУЧ`;
  bar.classList.toggle('r2', items.some((i) => i.risk === 2));
  bar.classList.toggle('calm', !!p.calm);
  const shown = items.slice(0, n > ROWS ? ROWS - 1 : ROWS);
  document.getElementById('list').innerHTML =
    shown.map(entry).join('') + (n > shown.length ? `<div class="h-foot"><span class="h-b none">+${n - shown.length}</span></div>` : '');
  bar.style.display = 'block';
  requestAnimationFrame(() => window.bridge.neptun.send('alert-size', { width: bar.offsetWidth + 20, height: bar.offsetHeight + 20 }));
  if (p.sound) beep(p.volume ?? 0.7);
  timer = setTimeout(() => {
    bar.classList.add('out');
    timer = setTimeout(() => window.bridge.neptun.send('alert-done'), 400);
  }, SHOW_MS);
}

window.bridge.neptun.on('alert', render);
