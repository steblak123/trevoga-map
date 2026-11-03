// "Оновлення" section of settings.html (data from update/main.js). The page needs only
//   <script src="update/settings.js"></script>
// The "auto" switch is kept in settings.json as  "update": { "auto": true }.
(function () {
  const api = window.bridge.update;
  if (!api) return;
  const css = document.createElement('style');
  css.textContent = `
    #upd .head { display: flex; align-items: center; gap: 10px; }
    #upd .ver { font-weight: 600; }
    #upd .ver small { color: var(--muted); font-weight: 400; margin-left: 4px; }
    #upd .btns { margin-left: auto; display: flex; gap: 6px; }
    #upd .st { display: flex; align-items: center; gap: 7px; margin: 6px 0 2px; font-size: 13px; }
    #upd .st i { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
    #upd .st.ok i { background: #3fd07a; box-shadow: 0 0 6px #3fd07a; }
    #upd .st.go i { background: var(--accent); box-shadow: 0 0 6px var(--accent); animation: upd-blink 1.1s infinite; }
    #upd .st.ready i { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
    #upd .st.warn i { background: #ffb020; box-shadow: 0 0 6px #ffb020; }
    #upd .st.warn { color: #ffd28a; }
    #upd .bar { height: 4px; border-radius: 2px; background: #0d1219; overflow: hidden; margin: 4px 0 2px; }
    #upd .bar b { display: block; height: 100%; background: var(--accent); transition: width .3s; }
    #upd ul { margin: 4px 0 4px; padding-left: 20px; color: #cfd8e3; font-size: 12.5px; }
    #upd a { color: var(--accent); }
    #upd-install { background: #1f4f6b; border-color: #2f7aa3; }
    #upd button:disabled { opacity: .45; cursor: default; }
    @keyframes upd-blink { 50% { opacity: .35; } }`;
  document.head.appendChild(css);

  const section = document.createElement('section');
  section.id = 'upd';
  section.innerHTML = `
    <h2>Оновлення</h2>
    <div class="head">
      <span class="ver" id="upd-ver"></span>
      <span class="btns">
        <button type="button" id="upd-install" hidden>Оновити зараз</button>
        <button type="button" id="upd-check">Перевірити</button>
      </span>
    </div>
    <div class="st" id="upd-st"><i></i><span></span></div>
    <div class="bar" id="upd-bar" hidden><b></b></div>
    <ul id="upd-notes" hidden></ul>
    <label class="row" id="upd-autorow"><input type="checkbox" id="upd-auto"> Оновлювати автоматично, коли у ваших районах немає тривоги</label>
    <div class="hint" id="upd-hint"></div>`;
  document.querySelector('main').appendChild(section);

  const $ = (id) => section.querySelector('#upd-' + id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const plural = (n, [one, few, many]) => {
    const a = n % 10;
    const b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };
  let settings = {};

  function render(s) {
    $('ver').innerHTML = `Версія ${esc(s.version)}${s.build ? `<small>${esc(s.build)}</small>` : ''}`;
    const n = Number(s.next) || 0;
    const news = s.mode === 'git' ? `${n} ${plural(n, ['нова зміна', 'нові зміни', 'нових змін'])} на GitHub` : `версія ${esc(s.next)}`;
    let cls = '';
    let text = '';
    if (!s.mode) {
      text = 'Ця копія не оновлюється сама';
    } else if (s.status === 'checking') {
      cls = 'go';
      text = 'Перевірка…';
    } else if (s.status === 'latest') {
      cls = 'ok';
      text = `Встановлено останню версію${s.checkedAt ? ` · перевірено о ${hhmm(s.checkedAt)}` : ''}`;
    } else if (s.status === 'downloading') {
      cls = 'go';
      text = `Завантаження: версія ${esc(s.next)} — ${s.percent || 0} %`;
    } else if (s.status === 'ready') {
      cls = 'ready';
      text = `Готово до встановлення: ${news}`;
    } else if (s.status === 'installing') {
      cls = 'go';
      text = 'Встановлення… віджет перезапуститься';
    } else if (s.status === 'blocked') {
      cls = 'warn';
      text = `${n ? news[0].toUpperCase() + news.slice(1) + ', але в' : 'В'} цій копії є власні зміни — оновіть її вручну (git pull)`;
    } else if (s.status === 'error') {
      cls = 'warn';
      text = `Не вдалося перевірити: ${esc(s.error)}`;
    } else {
      text = 'Перевірка — за хвилину після запуску';
    }
    $('st').className = 'st ' + cls;
    $('st').querySelector('span').innerHTML = text;
    $('bar').hidden = s.status !== 'downloading';
    $('bar').querySelector('b').style.width = `${s.percent || 0}%`;
    const notes = (s.status === 'ready' || s.status === 'downloading') && s.notes && s.notes.length ? s.notes : [];
    $('notes').hidden = !notes.length;
    $('notes').innerHTML = notes.map((l) => `<li>${esc(l)}</li>`).join('');
    $('install').hidden = s.status !== 'ready';
    $('check').disabled = !s.mode || ['checking', 'downloading', 'installing'].includes(s.status);
    $('autorow').style.display = s.mode ? '' : 'none'; // label.row is display:flex, so not [hidden]
    $('hint').innerHTML = !s.mode
      ? `Встановіть віджет інсталятором з <a href="${esc(s.releases)}" target="_blank">GitHub</a> — тоді нові версії приходитимуть самі.`
      : s.mode === 'git'
        ? 'Оновлюється з GitHub через git: нові зміни підтягуються самі, якщо в цій папці немає власних правок.'
        : `Нові версії — на сторінці <a href="${esc(s.releases)}" target="_blank">релізів</a>; встановлення займає кілька секунд.`;
  }

  function fill(s) {
    settings = s || {};
    $('auto').checked = !(settings.update && settings.update.auto === false);
  }

  $('check').addEventListener('click', () => api.check());
  $('install').addEventListener('click', () => api.install());
  $('auto').addEventListener('change', (e) => window.bridge.setSettings({ update: { ...(settings.update || {}), auto: e.target.checked } }));

  api.on(render);
  api.get().then(render);
  window.bridge.getSettings().then(fill);
  window.bridge.onSettings(fill);
})();
