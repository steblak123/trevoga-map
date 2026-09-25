const bar = document.getElementById('bar');
const R = window.Regions;
let hideTimer = null;
let audio = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function ctx() {
  if (!audio) audio = new AudioContext();
  return audio;
}

// Siren: tone sweeping up and down a few times.
function playSiren(volume) {
  const ac = ctx();
  const t0 = ac.currentTime + 0.05;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sawtooth';
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  const cycles = 3;
  const len = 1.6;
  for (let i = 0; i < cycles; i++) {
    osc.frequency.setValueAtTime(420, t0 + i * len);
    osc.frequency.linearRampToValueAtTime(980, t0 + i * len + len * 0.55);
    osc.frequency.linearRampToValueAtTime(420, t0 + (i + 1) * len);
  }
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.35 * volume, t0 + 0.15);
  gain.gain.setValueAtTime(0.35 * volume, t0 + cycles * len - 0.3);
  gain.gain.linearRampToValueAtTime(0, t0 + cycles * len);
  osc.connect(lp).connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + cycles * len + 0.05);
}

// All-clear: three soft rising chimes.
function playChime(volume) {
  const ac = ctx();
  const notes = [523.25, 659.25, 783.99];
  notes.forEach((f, i) => {
    const t = ac.currentTime + 0.05 + i * 0.28;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.4 * volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 1.2);
  });
}

function render(p) {
  clearTimeout(hideTimer);
  bar.className = p.kind;
  bar.querySelector('.icon').textContent = p.kind === 'alert' ? '🚨' : '✅';
  const list = document.getElementById('list');
  const hint = document.getElementById('hint');
  if (p.kind === 'alert') {
    const partialOnly = p.items.every((i) => i.status === 'P');
    bar.querySelector('.text').textContent = partialOnly ? 'ТРИВОГА В ЧАСТИНІ ВАШОГО РАЙОНУ' : 'ПОВІТРЯНА ТРИВОГА';
    list.innerHTML = p.items
      .map((i) => {
        const since = i.since ? ` — з ${R.formatTime(i.since)} (${R.formatDuration(Date.now() - i.since) || 'щойно'})` : '';
        const places = i.places && i.places.length ? i.places.join(', ') : 'частина району';
        const part = i.status === 'P' ? ` (${esc(places)})` : '';
        const lvl = i.level === 'yellow' ? ' · жовтий рівень' : '';
        return `<div>${esc(i.name)}${part}${lvl}${since}</div>`;
      })
      .join('');
    hint.textContent = p.test ? 'Це перевірка плашки' : 'Пройдіть в укриття';
  } else {
    bar.querySelector('.text').textContent = 'ВІДБІЙ ТРИВОГИ';
    list.innerHTML = (p.items || [])
      .filter((i) => i.end)
      .map((i) => {
        const dur = i.start ? `, тривала ${R.formatDuration(i.end - i.start)}` : '';
        return `<div>${esc(i.name)}: ${esc(R.formatRange(i.start, i.end))}${esc(dur)}</div>`;
      })
      .join('');
    hint.textContent = p.test ? 'Це перевірка плашки' : 'У ваших районах тривогу скасовано';
    hideTimer = setTimeout(() => window.bridge.hideOverlay(), 10000);
  }
  bar.style.display = p.visible ? 'block' : 'none';
  if (p.sound) (p.kind === 'alert' ? playSiren : playChime)(p.volume ?? 0.7);
}

window.bridge.onOverlay(render);
document.getElementById('close').addEventListener('click', () => window.bridge.hideOverlay());

// Click-through everywhere except the banner itself.
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  const over = bar.style.display !== 'none' && bar.contains(e.target);
  if (over === !ignoring) return;
  ignoring = !over;
  window.bridge.overlayIgnore(ignoring);
});
