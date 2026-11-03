// Zoom for the widget map: buttons (+, −, my regions, whole map), the mouse wheel over the map, and
// dragging the map while it is zoomed in (at the normal size a drag still moves the widget).
// It changes only the viewBox of #map; markers keep their size, region labels are scaled back.
// Other scripts listen for the "nep-zoom" event on #map; "nep-zoom-mine" asks to show the selected regions.
(function () {
  const svg = document.getElementById('map');
  const MAX = 100; // the most the map can be enlarged: a view about 13 km wide
  const STEP = 1.8; // one button press
  let anim = 0;
  let base = null; // [x, y, w, h]: the whole-map viewBox set by widget.js
  let view = null;
  let setting = false; // our own viewBox change, not the one from widget.js

  const zoom = () => (base && view ? base[2] / view[2] : 1);

  function emit() {
    svg.style.setProperty('--nep-zoom', zoom().toFixed(3));
    svg.classList.toggle('nep-zoomed', zoom() > 1.001);
    svg.dispatchEvent(new CustomEvent('nep-zoom'));
  }

  // Keeps the base aspect ratio, between 1× and MAX×, and inside the whole map.
  function apply([x, y, w]) {
    if (!base) return;
    const k = Math.min(1, Math.max(1 / MAX, w / base[2]));
    const nw = base[2] * k;
    const nh = base[3] * k;
    const cx = x + w / 2;
    const cy = y + (w * base[3]) / base[2] / 2;
    const nx = Math.min(base[0] + base[2] - nw, Math.max(base[0], cx - nw / 2));
    const ny = Math.min(base[1] + base[3] - nh, Math.max(base[1], cy - nh / 2));
    view = [nx, ny, nw, nh];
    setting = true;
    svg.setAttribute('viewBox', view.map((n) => +n.toFixed(2)).join(' '));
    setting = false;
    emit();
  }

  // factor > 1 zooms in, keeping the map point (px, py) where it is.
  function zoomAt(factor, px, py) {
    if (!view) return;
    const [x, y, w, h] = view;
    const nw = Math.min(base[2], Math.max(base[2] / MAX, w / factor));
    const f = w / nw;
    apply([px - (px - x) / f, py - (py - y) / f, nw, (nw * h) / w]);
  }

  const center = () => (view ? [view[0] + view[2] / 2, view[1] + view[3] / 2] : [0, 0]);

  function toMap(clientX, clientY) {
    const m = svg.getScreenCTM();
    return m ? [(clientX - m.e) / m.a, (clientY - m.f) / m.d] : center();
  }

  // A button press zooms in a few frames instead of one jump.
  function smoothZoom(factor, px, py) {
    cancelAnimationFrame(anim);
    const steps = 7;
    const f = factor ** (1 / steps);
    let i = 0;
    const step = () => {
      zoomAt(f, px, py);
      if (++i < steps) anim = requestAnimationFrame(step);
    };
    step();
  }

  const api = {
    zoomBy: (f) => smoothZoom(f, ...center()),
    reset: () => base && apply(base),
    // Fits a box of map units (with a margin), e.g. the selected regions.
    fit(x0, y0, x1, y1) {
      if (!base) return;
      const margin = Math.max(x1 - x0, y1 - y0) * 0.35 + 20;
      const w = Math.max(x1 - x0 + margin * 2, ((y1 - y0 + margin * 2) * base[2]) / base[3]);
      apply([(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - ((w * base[3]) / base[2]) / 2, w]);
    },
    get zoom() {
      return zoom();
    },
  };
  window.NeptunZoom = api;

  // The whole-map viewBox comes from widget.js once the map is built.
  function readBase() {
    const vb = svg.getAttribute('viewBox');
    if (!vb || setting) return;
    base = vb.split(/[\s,]+/).map(Number);
    view = base.slice();
    emit();
  }
  if (svg.getAttribute('viewBox')) readBase();
  else {
    const mo = new MutationObserver(() => {
      if (!svg.getAttribute('viewBox')) return;
      mo.disconnect();
      readBase();
    });
    mo.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
  }

  // ---------- buttons ----------

  const bar = document.createElement('div');
  bar.id = 'nep-zoom';
  bar.innerHTML =
    '<button class="ui" data-z="in" title="Наблизити">+</button>' +
    '<button class="ui" data-z="out" title="Віддалити">−</button>' +
    '<button class="ui mine" data-z="mine" title="Мої райони">◎</button>' +
    '<button class="ui" data-z="all" title="Уся карта">⤢</button>';
  document.getElementById('wrap').appendChild(bar);
  for (const ev of ['mousedown', 'dblclick']) bar.addEventListener(ev, (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.z === 'in') api.zoomBy(STEP);
    else if (b.dataset.z === 'out') api.zoomBy(1 / STEP);
    else if (b.dataset.z === 'all') api.reset();
    else svg.dispatchEvent(new CustomEvent('nep-zoom-mine'));
  });

  // ---------- wheel and drag ----------

  // The wheel zooms at the cursor, in proportion to how far it turned: one mouse notch ×1.25, a touchpad
  // or a pinch (which comes as a wheel with Ctrl) smoothly.
  svg.addEventListener(
    'wheel',
    (e) => {
      if (!base) return;
      e.preventDefault();
      cancelAnimationFrame(anim);
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY; // lines -> pixels
      const f = Math.min(2, Math.max(0.5, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022))));
      zoomAt(f, ...toMap(e.clientX, e.clientY));
    },
    { passive: false },
  );

  // While zoomed in, a left drag on the map pans it instead of moving the widget.
  let drag = null;
  svg.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || zoom() <= 1.001) return;
      e.stopPropagation(); // widget.js would start moving the window
      drag = { x: e.clientX, y: e.clientY, view: view.slice(), moved: false };
      svg.classList.add('ui', 'nep-panning'); // keeps the window catching the mouse during the drag
    },
    true,
  );
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    const m = svg.getScreenCTM();
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!m || !drag.moved) return;
    apply([drag.view[0] - dx / m.a, drag.view[1] - dy / m.d, drag.view[2]]);
  });
  addEventListener('mouseup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    svg.classList.remove('nep-panning');
    setTimeout(() => svg.classList.remove('ui'), 0);
    // A drag is not a click on whatever is under the cursor.
    if (!moved) return;
    const swallow = (e) => e.stopPropagation();
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 60);
  });
})();
