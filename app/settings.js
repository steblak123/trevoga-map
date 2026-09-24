const R = window.Regions;
const $ = (id) => document.getElementById(id);
let settings = null;
let selected = new Set();
const raionsByOblast = new Map(); // oblast uid -> [{ uid, name }]
const names = new Map();

function save(patch) {
  return window.bridge.setSettings(patch);
}

async function loadRaions() {
  const map = await window.bridge.getMapData();
  for (const { uid, name } of map.raions) {
    if (!R.isRaion(uid)) continue;
    const ob = R.oblastOf(uid);
    if (!raionsByOblast.has(ob)) raionsByOblast.set(ob, []);
    raionsByOblast.get(ob).push({ uid, name });
    names.set(uid, name);
  }
  for (const list of raionsByOblast.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  for (const o of R.OBLASTS) if (o.city) names.set(o.uid, o.name);
}

function buildTree() {
  const tree = $('tree');
  tree.textContent = '';
  const sorted = [...R.OBLASTS].sort((a, b) => a.name.replace('м. ', '').localeCompare(b.name.replace('м. ', ''), 'uk'));
  for (const ob of sorted) {
    if (ob.city) {
      const row = document.createElement('label');
      row.className = 'city';
      row.dataset.search = ob.name.toLowerCase();
      row.innerHTML = `<input type="checkbox" data-uid="${ob.uid}"> ${ob.name}`;
      tree.appendChild(row);
      continue;
    }
    const raions = raionsByOblast.get(ob.uid) || [];
    const det = document.createElement('details');
    det.dataset.search = [ob.name, ...raions.map((r) => r.name)].join(' ').toLowerCase();
    const sum = document.createElement('summary');
    sum.innerHTML = `<input type="checkbox" class="all" title="Уся область"><span>${ob.name}</span><span class="count"></span>`;
    det.appendChild(sum);
    const box = document.createElement('div');
    box.className = 'raions';
    for (const r of raions) {
      const row = document.createElement('label');
      row.className = 'row';
      row.dataset.search = r.name.toLowerCase();
      row.innerHTML = `<input type="checkbox" data-uid="${r.uid}"> ${r.name}`;
      box.appendChild(row);
    }
    det.appendChild(box);
    tree.appendChild(det);

    const all = sum.querySelector('.all');
    all.addEventListener('click', (e) => e.stopPropagation());
    all.addEventListener('change', () => {
      for (const r of raions) all.checked ? selected.add(r.uid) : selected.delete(r.uid);
      commitRegions();
    });
  }
  tree.addEventListener('change', (e) => {
    const uid = Number(e.target.dataset.uid);
    if (!uid) return;
    e.target.checked ? selected.add(uid) : selected.delete(uid);
    commitRegions();
  });
}

function syncTree() {
  for (const cb of $('tree').querySelectorAll('input[data-uid]')) cb.checked = selected.has(Number(cb.dataset.uid));
  for (const det of $('tree').querySelectorAll('details')) {
    const boxes = [...det.querySelectorAll('input[data-uid]')];
    const n = boxes.filter((b) => b.checked).length;
    const all = det.querySelector('.all');
    all.checked = n > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    det.querySelector('.count').textContent = n ? `${n} / ${boxes.length}` : '';
  }
  const chosen = [...selected].map((u) => R.shortName(names.get(u) || u));
  $('chosen').textContent = chosen.length ? `Обрано: ${chosen.join(', ')}` : 'Нічого не обрано';
}

function commitRegions() {
  syncTree();
  save({ regions: [...selected] });
}

function filterTree(q) {
  q = q.trim().toLowerCase();
  for (const el of $('tree').querySelectorAll('details, .city')) {
    const match = !q || el.dataset.search.includes(q);
    el.style.display = match ? '' : 'none';
    if (el.tagName === 'DETAILS') {
      el.open = !!q && match;
      for (const row of el.querySelectorAll('.raions label')) {
        row.style.display = !q || row.dataset.search.includes(q) || el.querySelector('summary').textContent.toLowerCase().includes(q) ? '' : 'none';
      }
    }
  }
}

function fill(s) {
  settings = s;
  selected = new Set(s.regions.map(Number));
  $('overlay').checked = s.overlay;
  $('sound').checked = s.sound;
  $('volume').value = s.volume;
  $('labels').checked = s.labels;
  $('locked').checked = s.locked;
  $('autostart').checked = s.autostart;
  $('opacity').value = s.opacity;
  for (const r of document.querySelectorAll('input[name=layer]')) r.checked = r.value === s.layer;
  if (document.activeElement !== $('token')) $('token').value = s.token;
  $('token').placeholder = s.hasEmbeddedToken ? 'Використовується вбудований токен' : 'Вставте токен';
  $('tokenHint').textContent = s.hasEmbeddedToken
    ? 'Поле можна залишити порожнім. Свій токен можна отримати на devs.alerts.in.ua.'
    : 'Токен можна отримати на devs.alerts.in.ua. Зберігається лише на цьому комп’ютері.';
  syncTree();
}

(async () => {
  await loadRaions();
  buildTree();
  fill(await window.bridge.getSettings());
  window.bridge.onSettings(fill);

  $('search').addEventListener('input', (e) => filterTree(e.target.value));
  for (const id of ['overlay', 'sound', 'labels', 'locked', 'autostart']) {
    $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  }
  $('volume').addEventListener('change', (e) => save({ volume: Number(e.target.value) }));
  $('opacity').addEventListener('input', (e) => save({ opacity: Number(e.target.value) }));
  for (const r of document.querySelectorAll('input[name=layer]')) {
    r.addEventListener('change', () => save({ layer: r.value }));
  }
  $('test').addEventListener('click', () => window.bridge.testAlert());
  $('token').addEventListener('change', (e) => save({ token: e.target.value.trim() }));
  $('showToken').addEventListener('click', () => {
    const t = $('token');
    t.type = t.type === 'password' ? 'text' : 'password';
  });
})();
