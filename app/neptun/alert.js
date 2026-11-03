// Banner "target near your regions" (window created by neptun/main.js): shows the targets that
// just came close, for 2 s, then fades out by itself. The full list stays in the widget.
const bar = document.getElementById('bar');
const SHOW_MS = 2000;
const ROWS = 4;
let audio = null;
let timer = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const plural = (n, [one, few, many]) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

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

function render(p) {
  clearTimeout(timer);
  bar.classList.remove('out');
  const items = (p && p.items) || [];
  if (!items.length) {
    bar.style.display = 'none';
    return;
  }
  const n = items.length;
  bar.querySelector('.text').textContent =
    n === 1 ? 'ЦІЛЬ БІЛЯ ВАШИХ РАЙОНІВ' : `${n} ${plural(n, ['ЦІЛЬ', 'ЦІЛІ', 'ЦІЛЕЙ'])} БІЛЯ ВАШИХ РАЙОНІВ`;
  const T = window.NeptunTypes;
  document.getElementById('list').innerHTML =
    items
      .slice(0, ROWS)
      .map((i) => {
        const where = i.km < 1 ? `над районом ${esc(i.name)}` : `≈ ${i.km} км · ${esc(i.name)}`;
        const trend = i.trend ? ` · <span class="tr">${esc(i.trend)}</span>` : '';
        const place = i.place ? ` (${esc(i.place)})` : '';
        return `<div class="row"><svg viewBox="-12 -12 24 24">${T.typeMeta(i.type).icon}</svg>` +
          `<span><b>${esc(i.title)}</b>${place} — ${where}${trend}</span></div>`;
      })
      .join('') + (n > ROWS ? `<div class="more">і ще ${n - ROWS}</div>` : '');
  bar.style.display = 'block';
  requestAnimationFrame(() => window.bridge.neptun.send('alert-size', { width: bar.offsetWidth + 20, height: bar.offsetHeight + 20 }));
  if (p.sound) beep(p.volume ?? 0.7);
  timer = setTimeout(() => {
    bar.classList.add('out');
    timer = setTimeout(() => window.bridge.neptun.send('alert-done'), 400);
  }, SHOW_MS);
}

window.bridge.neptun.on('alert', render);
