const bar = document.getElementById('bar');
const R = window.Regions;
const SHOW_MS = 2000; // the banner fades out by itself after this
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

const svgIcon = (d) => `<svg class="h-ico" viewBox="-8 -8 16 16">${d}</svg>`;
const ICON_ALERT = svgIcon('<path d="M0-7.2 7.4 6.2H-7.4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M-.8-2.4H.8L.5 2.2H-.5ZM-.9 3.4H.9V5H-.9Z"/>');
const ICON_CLEAR = svgIcon('<path d="M0-7.4 6.2-5V.2C6.2 4 3.4 6.4 0 7.4-3.4 6.4-6.2 4-6.2.2V-5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M-3-.4-.8 1.8 3.2-2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');
const PIN = svgIcon('<path d="M0-7.2a5 5 0 0 1 5 5C5 1.6 0 7.4 0 7.4S-5 1.6-5-2.2a5 5 0 0 1 5-5Zm0 3.1A1.9 1.9 0 1 0 0-.3 1.9 1.9 0 0 0 0-4.1Z"/>');
const CLOCK = svgIcon('<circle r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M0-3.4V0l2.6 1.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
const badge = (cls, html) => `<span class="h-b ${cls}">${html}</span>`;

function render(p) {
  clearTimeout(hideTimer);
  bar.className = 'h-pan ' + p.kind;
  bar.querySelector('.icon').innerHTML = p.kind === 'alert' ? ICON_ALERT : ICON_CLEAR;
  const list = document.getElementById('list');
  const hint = document.getElementById('hint');
  if (p.kind === 'alert') {
    const partialOnly = p.items.every((i) => i.status === 'P');
    bar.querySelector('.text').textContent = partialOnly ? 'ТРИВОГА В ЧАСТИНІ ВАШОГО РАЙОНУ' : 'ПОВІТРЯНА ТРИВОГА';
    list.innerHTML = p.items
      .map((i) => {
        const places = i.places && i.places.length ? i.places.join(', ') : 'частина району';
        return (
          `<div class="ov-row">${badge('place', PIN + esc(i.name))}` +
          (i.status === 'P' ? badge('part', esc(places)) : '') +
          (i.level === 'yellow' ? badge('note', 'жовтий рівень') : '') +
          (i.since ? badge('', `${CLOCK}з ${R.formatTime(i.since)}`) + badge('eta', esc(R.formatDuration(Date.now() - i.since) || 'щойно')) : '') +
          `</div>`
        );
      })
      .join('');
    hint.innerHTML = badge('', p.test ? 'Це перевірка плашки' : 'Пройдіть в укриття');
  } else {
    bar.querySelector('.text').textContent = 'ВІДБІЙ ТРИВОГИ';
    list.innerHTML = (p.items || [])
      .filter((i) => i.end)
      .map(
        (i) =>
          `<div class="ov-row">${badge('place', PIN + esc(i.name))}${badge('', CLOCK + esc(R.formatRange(i.start, i.end)))}` +
          (i.start ? badge('eta', esc(R.formatDuration(i.end - i.start))) : '') +
          `</div>`,
      )
      .join('');
    hint.innerHTML = badge('', p.test ? 'Це перевірка плашки' : 'Тривогу скасовано');
  }
  bar.style.display = p.visible ? 'block' : 'none';
  // The window is sized to the banner (plus room for the pulsing ring), so it never covers other windows.
  if (p.visible) {
    requestAnimationFrame(() => window.bridge.overlaySize({ width: bar.offsetWidth + 28, height: bar.offsetHeight + 28 }));
    hideTimer = setTimeout(() => {
      bar.classList.add('out');
      hideTimer = setTimeout(() => window.bridge.hideOverlay(), 400);
    }, SHOW_MS);
  }
  if (p.sound) (p.kind === 'alert' ? playSiren : playChime)(p.volume ?? 0.7);
}

window.bridge.onOverlay(render);
