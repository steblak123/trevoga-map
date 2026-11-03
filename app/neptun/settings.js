// "Цілі на карті" section of settings.html. The page needs only
//   <script src="neptun/settings.js"></script>  after settings.js
// Options are kept in settings.json under "neptun": { markers, panel }.
(function () {
  const DEFAULTS = { markers: true, panel: true };
  const section = document.createElement('section');
  section.innerHTML = `
    <h2>Цілі на карті · NEPTUN</h2>
    <label class="row"><input type="checkbox" id="nep-markers"> Показувати БпЛА, ракети, КАБ та інші цілі</label>
    <label class="row"><input type="checkbox" id="nep-panel"> Панель цілей: лічильники за типами й найближча до ваших районів</label>
    <div class="hint">Клік по цілі на карті відкриває картку: курс, швидкість, час останньої згадки, відстань до ваших районів.
      Дані — відкритий API <b>NEPTUN</b> (neptun.in.ua), токен не потрібен. Це агрегатор повідомлень, а не офіційне
      оповіщення: позиції приблизні й можуть запізнюватися.</div>`;
  const token = document.getElementById('token');
  const before = token && token.closest('section');
  document.querySelector('main').insertBefore(section, before || null);

  const box = { markers: section.querySelector('#nep-markers'), panel: section.querySelector('#nep-panel') };
  let current = { ...DEFAULTS };

  function fill(s) {
    current = { ...DEFAULTS, ...((s && s.neptun) || {}) };
    box.markers.checked = current.markers;
    box.panel.checked = current.panel;
    box.panel.disabled = !current.markers;
  }

  for (const [key, el] of Object.entries(box)) {
    el.addEventListener('change', () => {
      current = { ...current, [key]: el.checked };
      box.panel.disabled = !current.markers;
      window.bridge.setSettings({ neptun: current });
    });
  }

  window.bridge.getSettings().then(fill);
  window.bridge.onSettings(fill);
})();
