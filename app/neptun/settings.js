// "Цілі на карті" section of settings.html. The page needs only
//   <script src="neptun/settings.js"></script>  after settings.js
// Options are kept in settings.json under
//   "neptun": { markers, panel, hideFpv, alert, alertKm, alertSound, cardSide }.
(function () {
  const DEFAULTS = { markers: true, panel: true, hideFpv: false, alert: true, alertKm: 20, alertSound: false, cardSide: 'left' };
  const RADII = [5, 10, 20, 50];
  const section = document.createElement('section');
  section.innerHTML = `
    <h2>Цілі на карті</h2>
    <label class="row"><input type="checkbox" id="nep-markers"> Показувати БпЛА, ракети, КАБ та інші цілі</label>
    <div id="nep-more" style="padding-left:24px">
      <label class="row"><input type="checkbox" id="nep-panel"> Плитки з кількістю цілей під картою (як навантаження ПК)</label>
      <label class="row"><input type="checkbox" id="nep-hideFpv"> Приховати FPV-дрони (на карті, у лічильниках і сповіщеннях)</label>
      <div class="inline" style="padding:4px 0">
        <span class="hint">Інформаційне вікно</span>
        <label class="row"><input type="radio" name="nep-side" value="left"> ліворуч</label>
        <label class="row"><input type="radio" name="nep-side" value="right"> праворуч</label>
      </div>
      <label class="row"><input type="checkbox" id="nep-alert"> Сповіщати, коли ціль ближче ніж
        <select id="nep-alertKm">${RADII.map((km) => `<option value="${km}">${km} км</option>`).join('')}</select>
        до ваших районів</label>
      <div class="inline" style="padding:2px 0 2px 24px">
        <label class="row"><input type="checkbox" id="nep-alertSound"> Звук сповіщення</label>
        <button id="nep-test" type="button">Перевірити</button>
      </div>
    </div>
    <div class="hint">Під картою — вікно з цілями біля ваших районів (клік по цілі показує її тут же) і плитки з
      кількістю цілей. Сповіщення — плашка на 2 секунди в правому верхньому куті; гучність — як у розділі
      «Сповіщення». Дрони без курсу на карті видно лише поруч з вашими районами; решту — у плитках.</div>`;
  const token = document.getElementById('token');
  const before = token && token.closest('section');
  document.querySelector('main').insertBefore(section, before || null);

  const q = (id) => section.querySelector('#nep-' + id);
  const checks = ['markers', 'panel', 'hideFpv', 'alert', 'alertSound'];
  const km = q('alertKm');
  const sides = [...section.querySelectorAll('input[name=nep-side]')];
  km.style.cssText = 'background:#0d1219;color:inherit;border:1px solid #273142;border-radius:6px;padding:2px 4px;font:inherit';
  let current = { ...DEFAULTS };
  let all = {};

  function sync() {
    q('more').style.opacity = current.markers ? '' : '0.45';
    for (const id of ['panel', 'hideFpv', 'alert', 'alertSound', 'test']) q(id).disabled = !current.markers;
    for (const r of sides) r.disabled = !current.markers;
    km.disabled = q('alertSound').disabled = q('test').disabled = !current.markers || !current.alert;
  }

  function fill(s) {
    all = s || {};
    current = { ...DEFAULTS, ...(all.neptun || {}) };
    for (const id of checks) q(id).checked = !!current[id];
    km.value = String(RADII.includes(current.alertKm) ? current.alertKm : DEFAULTS.alertKm);
    for (const r of sides) r.checked = r.value === current.cardSide;
    sync();
  }

  function save(patch) {
    current = { ...current, ...patch };
    sync();
    window.bridge.setSettings({ neptun: current });
  }

  for (const id of checks) q(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  km.addEventListener('change', () => save({ alertKm: Number(km.value) }));
  for (const r of sides) r.addEventListener('change', () => save({ cardSide: r.value }));

  q('test').addEventListener('click', () => {
    if (!window.bridge.neptun) return;
    const n = Math.max(1, Math.round(current.alertKm / 2));
    window.bridge.neptun.send('alert', {
      test: true,
      sound: current.alertSound,
      volume: Number.isFinite(all.volume) ? all.volume : 0.7,
      items: [{ id: 'test', type: 'uav', title: 'Шахед', place: 'Перевірка', km: n, name: 'ваш район', trend: 'наближається', status: 'appr', risk: 1, eta: 6 }],
    });
  });

  window.bridge.getSettings().then(fill);
  window.bridge.onSettings(fill);
})();
