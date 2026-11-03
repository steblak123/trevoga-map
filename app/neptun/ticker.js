// Event ticker under the map (widget.html): air-raid alerts and all-clears, new targets, explosions, one
// line that scrolls, newest first:  "14:32  Тривога · Чугуївський р-н, Харківська обл. — alerts.in.ua".
// widget.js puts it on the page and feeds it: push({ at, kind, title, place, source, go }), where kind is
// 'alert' | 'clear' | 'target' | 'boom', source may be a function (the channel may be known later) and
// go(), if there is one, shows the event on the map when its line is clicked.
(function () {
  const MAX = 14; // events kept
  const SPEED = 40; // px per second
  const COLORS = { alert: '#ff4d4f', clear: '#3fd07a', target: '#ff9f43', boom: '#ffb020' };

  const el = document.createElement('div');
  el.id = 'nep-ticker';
  el.className = 'h-pan ui';
  el.innerHTML = '<span class="tk-head"><i></i>Події</span><div class="tk-view"><div class="tk-strip"></div></div>';
  const view = el.querySelector('.tk-view');
  const strip = el.querySelector('.tk-strip');
  let events = [];
  let html = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

  function item(e) {
    const src = typeof e.source === 'function' ? e.source() : e.source;
    return (
      `<span class="tk-it${e.go ? ' go' : ''}" data-i="${events.indexOf(e)}" style="--c:${COLORS[e.kind] || '#9fb3c8'}"><i></i><time>${hhmm(e.at)}</time>` +
      `<b>${esc(e.title)}</b>${e.place ? ` · ${esc(e.place)}` : ''}${src ? `<em>— ${esc(src)}</em>` : ''}</span>`
    );
  }

  // Scrolls only when it does not fit; the strip holds the items twice for a seamless loop.
  function render() {
    const body = events.length ? events.map(item).join('') : '<span class="tk-it quiet">Поки тихо</span>';
    if (body === html) return;
    html = body;
    strip.classList.remove('run');
    strip.innerHTML = body;
    requestAnimationFrame(() => {
      const w = strip.scrollWidth;
      if (events.length && w > view.clientWidth) {
        strip.innerHTML = body + body;
        strip.style.setProperty('--tk-time', `${Math.max(12, w / SPEED).toFixed(1)}s`);
        strip.classList.add('run');
      }
    });
  }

  function push(e) {
    events.unshift({ at: Date.now(), ...e });
    if (events.length > MAX) events.length = MAX;
    render();
  }

  el.addEventListener('click', (ev) => {
    const it = ev.target.closest && ev.target.closest('.tk-it.go');
    const e = it && events[Number(it.dataset.i)];
    if (e && e.go) e.go();
  });

  // Sources that come later (the posts feed is read every 30 s) are filled in on the next refresh.
  setInterval(render, 30000);
  render();

  window.NeptunTicker = { el, push, render };
})();
