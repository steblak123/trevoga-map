// "Цілі на карті" section of settings.html. The page needs only
//   <script src="neptun/settings.js"></script>  after settings.js
// Options are kept in settings.json under
//   "neptun": { markers, panel, hideFpv, alert, alertKm (drones), alertKmMissile (missiles, KAB, aviation), alertSound,
//   cardSide, basemap, style, home, homeRing, channels, tgTargets }.
(function () {
  const DEFAULTS = { markers: true, panel: true, hideFpv: false, alert: true, alertKm: 20, alertKmMissile: 50, fastKm: 50, alertSound: false, cardSide: 'left', basemap: 'none', booms: true, ticker: true, style: 'bright', home: null, homeRing: true, channels: [], tgTargets: true };
  const STYLES = [
    ['bright', 'Яскравий', 'кольори, підсвітка'],
    ['calm', 'Акуратний', 'спокійно, без підсвітки'],
  ];
  const RADII = [5, 10, 20, 50];
  const RADII_M = [10, 20, 50, 100, 150]; // missiles: they come from farther, faster
  const BASEMAPS = [
    ['none', 'Звичайна'],
    ['map', 'Карта з дорогами'],
    ['sat', 'Супутник'],
    ['hybrid', 'Супутник і дороги'],
    ['dark', 'Темний супутник'],
  ];
  // "Карта": the offline layer under the regions (basemap.js); it works with the targets off too.
  const mapSection = document.createElement('section');
  mapSection.innerHTML = `
    <h2>Карта</h2>
    <div class="nep-bm">${BASEMAPS.map(([v, t]) => `<label class="nep-bm-${v}"><input type="radio" name="nep-basemap" value="${v}"><span>${t}</span></label>`).join('')}</div>
    <div class="hint">Працює без інтернету; назви районів, міст і сіл з’являються при наближенні. Супутник при сильному
      наближенні, коли є інтернет, — детальніший.</div>
    <h2 style="margin-top:12px">Вигляд панелей під картою</h2>
    <div class="nep-st">${STYLES.map(([v, t, sub]) => `<label class="nep-st-${v}"><input type="radio" name="nep-style" value="${v}"><span class="pv"><i></i><i></i><i></i></span><b>${t}</b><small>${sub}</small></label>`).join('')}</div>`;
  const bmCss = document.createElement('style');
  bmCss.textContent = `
    .nep-bm { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 6px; }
    .nep-bm label { position: relative; display: flex; align-items: flex-end; height: 58px; padding: 6px 7px; border-radius: 8px;
      border: 1px solid var(--line); cursor: pointer; font-size: 12px; font-weight: 600; text-shadow: 0 1px 2px #000; overflow: hidden; }
    .nep-bm input { position: absolute; opacity: 0; }
    .nep-bm label:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 0 10px rgba(95,211,255,.25); }
    .nep-bm-none { background: linear-gradient(135deg, #1a2433, #121a26); }
    .nep-st { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .nep-st label { position: relative; display: grid; grid-template-columns: 54px 1fr; grid-template-rows: auto auto; column-gap: 9px;
      align-items: center; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line); background: #121822; cursor: pointer; }
    .nep-st input { position: absolute; opacity: 0; }
    .nep-st label:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .nep-st .pv { grid-row: span 2; display: flex; flex-direction: column; gap: 3px; padding: 4px; border-radius: 5px; background: #0b1017; }
    .nep-st .pv i { height: 7px; border-radius: 2px; }
    .nep-st b { font-size: 13px; }
    .nep-st small { color: var(--muted); font-size: 11.5px; }
    .nep-st-bright .pv i:nth-child(1) { background: linear-gradient(90deg, #ff4d57, #ff9f43); box-shadow: 0 0 6px rgba(255,77,87,.6); }
    .nep-st-bright .pv i:nth-child(2) { background: linear-gradient(90deg, #4fc3f7, #3ddc84); box-shadow: 0 0 6px rgba(79,195,247,.6); width: 80%; }
    .nep-st-bright .pv i:nth-child(3) { background: linear-gradient(90deg, #b670ff, #ff7ab6); width: 60%; }
    .nep-st-calm .pv i { background: #3a4554; }
    .nep-st-calm .pv i:nth-child(2) { width: 80%; }
    .nep-st-calm .pv i:nth-child(3) { width: 60%; background: #2e3744; }
    .nep-bm-map { background: linear-gradient(160deg, transparent 46%, #ffc45c 47% 50%, transparent 51%), linear-gradient(60deg, transparent 60%, #eadcb0 61% 62.5%, transparent 63.5%), radial-gradient(circle at 75% 30%, #1e548c 0 14%, transparent 15%), #182231; }
    .nep-bm-sat { background: radial-gradient(circle at 30% 30%, #4b6b3a, transparent 55%), radial-gradient(circle at 80% 70%, #7a6a4a, transparent 50%), linear-gradient(135deg, #2f4a2a, #3b3a2a); }
    .nep-bm-dark { background: linear-gradient(160deg, transparent 46%, #93b0cc 47% 49%, transparent 50%), radial-gradient(circle at 70% 70%, rgba(239,68,68,.45) 0 22%, transparent 23%), radial-gradient(circle at 30% 30%, #24331f, transparent 55%), linear-gradient(135deg, #161d16, #11151a); }
    .nep-bm-hybrid { background: linear-gradient(160deg, transparent 46%, #ffd36e 47% 50%, transparent 51%), radial-gradient(circle at 30% 30%, #4b6b3a, transparent 55%), radial-gradient(circle at 80% 70%, #7a6a4a, transparent 50%), linear-gradient(135deg, #2f4a2a, #3b3a2a); }`;
  bmCss.textContent += `
    .nep-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 0 4px 24px; }
    .nep-chips:empty { display: none; }
    .nep-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 3px 2px 8px; border-radius: 12px; border: 1px solid var(--line); background: #121822; font-size: 12.5px; }
    .nep-chip a { color: var(--text); text-decoration: none; }
    .nep-chip button { padding: 0 6px; border: 0; background: transparent; color: var(--muted); font-size: 14px; line-height: 18px; border-radius: 9px; cursor: pointer; }
    .nep-chip button:hover { background: #2c3a52; color: var(--text); }`;
  document.head.appendChild(bmCss);
  const section = document.createElement('section');
  section.innerHTML = `
    <h2>Цілі на карті</h2>
    <label class="row"><input type="checkbox" id="nep-markers"> Показувати БпЛА, ракети, КАБ та інші цілі</label>
    <div id="nep-more" style="padding-left:24px">
      <label class="row"><input type="checkbox" id="nep-panel"> Плитки з кількістю цілей під картою (як навантаження ПК)</label>
      <label class="row"><input type="checkbox" id="nep-hideFpv"> Приховати FPV-дрони (на карті, у лічильниках і сповіщеннях)</label>
      <label class="row"><input type="checkbox" id="nep-booms"> Вибухи з повідомлень каналів (40 хвилин)</label>
      <label class="row"><input type="checkbox" id="nep-ticker"> Стрічка подій під картою: тривоги, нові цілі, вибухи</label>
      <div class="inline" style="padding:4px 0">
        <span class="hint">Інформаційне вікно</span>
        <label class="row"><input type="radio" name="nep-side" value="left"> ліворуч</label>
        <label class="row"><input type="radio" name="nep-side" value="right"> праворуч</label>
      </div>
      <label class="row"><input type="checkbox" id="nep-alert"> Сповіщати, коли до вашої точки (без неї — до ваших районів) ближче ніж</label>
      <div class="inline" style="padding:2px 0 2px 24px">
        <span class="hint">дрони</span>
        <input type="number" id="nep-alertKm" min="1" max="500" step="1" list="nep-km-d" style="width:70px"> км
        <span class="hint">ракети, КАБ, авіація</span>
        <input type="number" id="nep-alertKmMissile" min="1" max="500" step="1" list="nep-km-m" style="width:70px"> км
        <datalist id="nep-km-d">${RADII.map((km) => `<option value="${km}">`).join('')}</datalist>
        <datalist id="nep-km-m">${RADII_M.map((km) => `<option value="${km}">`).join('')}</datalist>
      </div>
      <div class="inline" style="padding:2px 0 2px 24px">
        <span class="hint">Частіше оновлювати (кожні 8–10 с), коли ціль ближче за радіус плюс</span>
        <input type="number" id="nep-fastKm" min="0" max="500" step="10" style="width:70px"> км
      </div>
      <div class="inline" style="padding:2px 0 2px 24px">
        <span class="hint">Моя точка</span>
        <input type="text" id="nep-home" placeholder="50.4501, 30.5234" style="max-width:190px" spellcheck="false">
        <button id="nep-homeClear" type="button">Зняти</button>
      </div>
      <label class="row" style="padding-left:24px"><input type="checkbox" id="nep-homeRing"> Коло радіуса навколо точки</label>
      <div class="hint" style="padding-left:24px">Відстань і радіус рахуються від неї замість меж районів. Координати — з Google Карт
        (клік правою кнопкою → числа), або кнопка ⌖ на карті віджета.</div>
      <div class="inline" style="padding:2px 0 2px 24px">
        <span class="hint">Мої канали Telegram</span>
        <input type="text" id="nep-channels" placeholder="Вставте посилання: t.me/shpk_krop" style="flex:1" spellcheck="false">
        <button id="nep-chAdd" type="button">Додати</button>
      </div>
      <div id="nep-chList" class="nep-chips"></div>
      <div class="hint" style="padding-left:24px">Публічні канали. Їхні пости показуються в джерелах при наведенні, дають вибухи, а слово
        «реактивний» у них одразу робить шахед реактивним (вашим каналам довіряємо). Можна вставити кілька посилань одразу.
        Коли ціль у вашому радіусі або у ваших районах тривога, канали читаються щокілька секунд.</div>
      <label class="row" style="padding-left:24px"><input type="checkbox" id="nep-tgTargets"> Показувати цілі з моїх каналів, яких ще немає в NEPTUN</label>
      <div class="inline" style="padding:2px 0 2px 24px">
        <label class="row"><input type="checkbox" id="nep-alertSound"> Звук сповіщення</label>
        <button id="nep-test" type="button">Перевірити</button>
      </div>
    </div>
    <div class="hint">Під картою — вікно з цілями біля ваших районів (клік по цілі показує її тут же) і плитки з
      кількістю цілей. Сповіщення — плашка на 5 секунд у правому верхньому куті; гучність — як у розділі
      «Сповіщення». Шахеди без курсу — бліді: про них відомо лише місце, біля якого їх бачили.</div>`;
  const token = document.getElementById('token');
  const before = token && token.closest('section');
  document.querySelector('main').insertBefore(section, before || null);
  document.querySelector('main').insertBefore(mapSection, section);
  const basemaps = [...mapSection.querySelectorAll('input[name=nep-basemap]')];
  const styles = [...mapSection.querySelectorAll('input[name=nep-style]')];

  const q = (id) => section.querySelector('#nep-' + id);
  const checks = ['markers', 'panel', 'hideFpv', 'booms', 'ticker', 'homeRing', 'alert', 'alertSound', 'tgTargets'];
  const km = q('alertKm');
  const kmM = q('alertKmMissile');
  const fastKm = q('fastKm');
  const sides = [...section.querySelectorAll('input[name=nep-side]')];
  km.style.cssText = kmM.style.cssText = fastKm.style.cssText = 'background:#0d1219;color:inherit;border:1px solid #273142;border-radius:6px;padding:2px 4px;font:inherit';
  let current = { ...DEFAULTS };
  let all = {};

  function sync() {
    q('more').style.opacity = current.markers ? '' : '0.45';
    for (const id of ['panel', 'hideFpv', 'booms', 'ticker', 'alert', 'alertSound', 'test', 'home', 'homeClear', 'homeRing', 'channels', 'chAdd', 'tgTargets']) q(id).disabled = !current.markers;
    for (const r of sides) r.disabled = !current.markers;
    km.disabled = kmM.disabled = fastKm.disabled = q('alertSound').disabled = q('test').disabled = !current.markers || !current.alert;
  }

  function fill(s) {
    all = s || {};
    current = { ...DEFAULTS, ...(all.neptun || {}) };
    for (const id of checks) q(id).checked = !!current[id];
    if (document.activeElement !== km) km.value = String(num(current.alertKm, DEFAULTS.alertKm, 1));
    if (document.activeElement !== kmM) kmM.value = String(num(current.alertKmMissile, DEFAULTS.alertKmMissile, 1));
    if (document.activeElement !== fastKm) fastKm.value = String(num(current.fastKm, DEFAULTS.fastKm, 0));
    for (const r of sides) r.checked = r.value === current.cardSide;
    for (const r of basemaps) r.checked = r.value === current.basemap;
    for (const r of styles) r.checked = r.value === current.style;
    drawChannels();
    if (document.activeElement !== q('home')) q('home').value = current.home ? `${current.home.lat}, ${current.home.lon}` : '';
    sync();
  }

  function save(patch) {
    current = { ...current, ...patch };
    sync();
    window.bridge.setSettings({ neptun: current });
  }

  for (const id of checks) q(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  // typed by hand: any whole number of km, kept within 1–500 (the "fast" extra: 0–500)
  function num(v, def, min) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(500, Math.max(min, n)) : def;
  }
  km.addEventListener('change', () => { km.value = String(num(km.value, current.alertKm, 1)); save({ alertKm: Number(km.value) }); });
  kmM.addEventListener('change', () => { kmM.value = String(num(kmM.value, current.alertKmMissile, 1)); save({ alertKmMissile: Number(kmM.value) }); });
  fastKm.addEventListener('change', () => { fastKm.value = String(num(fastKm.value, current.fastKm, 0)); save({ fastKm: Number(fastKm.value) }); });
  const homeIn = q('home');
  function parseHome(v) {
    const m = String(v).match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1].replace(',', '.'));
    const lon = Number(m[2].replace(',', '.'));
    return lat > 43 && lat < 54 && lon > 21 && lon < 41 ? { lat, lon } : null; // Ukraine and its surroundings
  }
  homeIn.addEventListener('change', () => {
    const h = parseHome(homeIn.value);
    homeIn.style.outline = h || !homeIn.value.trim() ? '' : '2px solid #ff4d57';
    if (h || !homeIn.value.trim()) save({ home: h });
  });
  const chIn = q('channels');
  const parseChannels = (v) => [...new Set(String(v).split(/[\s,;]+/).map((x) => x.replace(/^(https?:\/\/)?(t\.me|telegram\.me)\/(s\/)?/i, '').replace(/^@/, '').replace(/[/?#].*$/, '')).filter((x) => /^[A-Za-z0-9_]{4,32}$/.test(x)))];
  function addChannels() {
    const found = parseChannels(chIn.value);
    chIn.style.outline = found.length || !chIn.value.trim() ? '' : '2px solid #ff4d57';
    if (!found.length) return;
    chIn.value = '';
    save({ channels: [...new Set([...(current.channels || []), ...found])].slice(0, 12) });
  }
  q('chAdd').addEventListener('click', addChannels);
  chIn.addEventListener('keydown', (e) => e.key === 'Enter' && addChannels());
  q('chList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ch]');
    if (b) save({ channels: (current.channels || []).filter((c) => c !== b.dataset.ch) });
  });
  function drawChannels() {
    q('chList').innerHTML = (current.channels || [])
      .map((c) => `<span class="nep-chip"><a href="https://t.me/${c}" target="_blank">@${c}</a><button type="button" data-ch="${c}" title="Прибрати">×</button></span>`)
      .join('');
  }
  q('homeClear').addEventListener('click', () => {
    homeIn.value = '';
    save({ home: null });
  });
  for (const r of sides) r.addEventListener('change', () => save({ cardSide: r.value }));
  for (const r of basemaps) r.addEventListener('change', () => save({ basemap: r.value }));
  for (const r of styles) r.addEventListener('change', () => save({ style: r.value }));

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
