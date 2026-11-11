// End-to-end tests of reading the posts of local monitoring channels (app/neptun/routes.js, intel.js, main.js)
// on a week of real posts (28.10–04.11.2026) of @krop_vanek, @shpk_krop and @povitryanatrivogaaa:
//   npm test                 run
//   UPDATE=1 npm test        rewrite tests/fixtures/*.expected.txt after checking the changes by eye
// Every post of the week is in tests/fixtures/<channel>.expected.txt with what was read from it: the target,
// its kind, where it is, where from and where to; the test fails on any change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.self = global;
global.window = global;
require('../app/neptun/intel.js');
require('../app/neptun/basemap/places.js');
const { Routes } = require('../app/neptun/routes.js');
const { Intel } = require('../app/neptun/intel.js');
const Geo = require('../app/neptun/geo.js');
const MAP = require('../app/assets/map.json');

const FIX = path.join(__dirname, 'fixtures');
const CHANNELS = ['krop_vanek', 'shpk_krop', 'povitryanatrivogaaa'];
const KM = 1 / (MAP.proj.k * 1000);
const KIND = { jet: 'реактивний', plain: 'шахед', missile: 'ракета', kab: 'КАБ', recon: 'розвідник', fpv: 'FPV', null: '?' };

const week = (ch) => JSON.parse(fs.readFileSync(path.join(FIX, `${ch}.week.json`), 'utf8')).map((p) => ({ ...p, channel: '@' + ch }));

// Reads the posts one by one, as they came: [{ post, out: [sightings] }].
// As in the widget of the one who follows these channels: their point is in Kropyvnytskyi.
const HOME = { x: 563.9, y: 326.1 };
function run(posts) {
  const r = new Routes(window.NeptunBasemapPlaces);
  r.kmPerUnit = KM;
  r.defaultHome = HOME;
  return { r, read: posts.map((p) => ({ post: p, out: r.add([p], Date.parse(p.date)) })) };
}

const fmt = (s) =>
  `  → ${s.track.split('#')[1]} ${KIND[s.kind]}${s.count > 1 ? ` ×${s.count}` : ''} | ${s.pos ? s.pos.name + (s.pos.last ? ' (востаннє)' : s.pos.est ? ' (куди)' : '') : '—'}` +
  ` | з: ${s.from || '—'} | на: ${s.to || '—'}${s.heading != null ? ` | курс ${Math.round(s.heading)}°` : ''}${s.gone ? ` | ${FATE[s.fate]}` : ''}`;
const FATE = { lost: 'зник з радарів', down: 'збито', left: 'вилетів' };

function report(read) {
  const lines = [];
  for (const { post, out } of read) {
    lines.push(`${post.id} ${post.date.slice(5, 16)}${post.reply ? ` ↳${post.reply.id}` : ''} ${[...post.text.replace(/\s*\n\s*/g, ' ⏎ ')].slice(0, 160).join('')}`);
    for (const s of out) lines.push(fmt(s));
  }
  return lines.join('\n') + '\n';
}

const byId = (read, id) => read.find((x) => x.post.id === id).out;
const one = (read, id) => {
  const out = byId(read, id);
  assert.equal(out.length, 1, `post ${id}: one target, got ${out.length}`);
  return out[0];
};

// ---------- every post of the week ----------

for (const ch of CHANNELS) {
  test(`@${ch}: every post of the week reads as checked (snapshot)`, () => {
    const { read } = run(week(ch));
    const got = report(read);
    const file = path.join(FIX, `${ch}.expected.txt`);
    if (process.env.UPDATE || !fs.existsSync(file)) fs.writeFileSync(file, got);
    const want = fs.readFileSync(file, 'utf8').split('\n');
    const have = got.split('\n');
    for (let i = 0; i < Math.max(want.length, have.length); i++) {
      if (want[i] !== have[i]) assert.fail(`line ${i + 1} of ${path.basename(file)} changed:\n  was: ${want[i]}\n  now: ${have[i]}\n(UPDATE=1 npm test to accept)`);
    }
  });

  test(`@${ch}: no target jumps farther than it can fly, every point is in Ukraine`, () => {
    const { read } = run(week(ch));
    const speed = { jet: 11, missile: 16, kab: 6, plain: 4, recon: 3, fpv: 2 }; // km per minute, with slack
    const last = new Map();
    for (const { out } of read) {
      for (const s of out) {
        if (!s.pos) continue;
        assert.ok(s.pos.x > 0 && s.pos.x < 1000 && s.pos.y > 0 && s.pos.y < 700, `${s.post}: ${s.pos.name} is off the map`);
        const l = last.get(s.track);
        if (l) {
          const km = Math.hypot(l.pos.x - s.pos.x, l.pos.y - s.pos.y) * KM;
          const min = (s.at - l.at) / 60000;
          assert.ok(km <= 40 + min * (speed[s.kind] || 11) * 1.5, `${s.post}: ${l.pos.name} → ${s.pos.name}, ${km.toFixed(0)} km in ${min.toFixed(0)} min`);
        }
        last.set(s.track, s);
      }
    }
  });
}

test('local channels: the points stay in and around Kirovohrad oblast', () => {
  const center = { x: 563.9, y: 326.1 }; // Kropyvnytskyi
  for (const ch of ['krop_vanek', 'shpk_krop']) {
    const { read } = run(week(ch));
    let far = 0;
    let all = 0;
    for (const { out } of read)
      for (const s of out) {
        if (!s.pos) continue;
        all++;
        if (Math.hypot(s.pos.x - center.x, s.pos.y - center.y) * KM > 260) far++;
      }
    assert.ok(all > 400, `@${ch}: ${all} points`);
    assert.ok(far / all < 0.03, `@${ch}: ${far} of ${all} points farther than 260 km`);
  }
});

// ---------- the scenario of 04.11, 16:00–16:12 (local time) ----------

test('@krop_vanek: "Реактивний на Новий Стародуб" → "→Нова Прага" → "В бік Аджамки" → "Другий за ним йде, Інгулецьке"', () => {
  const { read } = run(week('krop_vanek'));
  const a = one(read, 35869);
  assert.equal(a.kind, 'jet');
  assert.equal(a.pos.name, 'Новий Стародуб');
  const b = one(read, 35870);
  assert.equal(b.track, a.track, 'the reply continues the same target');
  assert.equal(b.pos.name, 'Нова Прага');
  assert.equal(b.from, 'Новий Стародуб');
  assert.equal(b.kind, 'jet', 'the kind comes from the post it answers');
  assert.ok(b.heading > 250 && b.heading < 310, `west-north-west, got ${b.heading}`);
  const c = one(read, 35871);
  assert.equal(c.track, a.track);
  assert.equal(c.to, 'Аджамки');
  assert.equal(c.from, 'Нова Прага');
  const d = one(read, 35872);
  assert.notEqual(d.track, a.track, '"Другий за ним" is a second target');
  assert.equal(d.kind, 'jet');
  assert.equal(d.pos.name, 'Інгулецьке');
  const [e1, e2] = byId(read, 35875); // "1й Кандаурове ⏎ 2й Шарівка": each to its own target
  assert.equal(e1.track, a.track);
  assert.equal(e1.pos.name, 'Кандаурове');
  assert.equal(e2.track, d.track);
  assert.equal(e2.pos.name, 'Шарівка');
  assert.equal(one(read, 35887).gone, true, '"—" ends the target');
});

test('@shpk_krop: the same jets, written without replies', () => {
  const { read } = run(week('shpk_krop'));
  assert.equal(byId(read, 17583).length, 0, '"Буде тривога і доречі вони реактивні" names no place');
  const a = one(read, 17584); // "Заходить , Новий Стародуб"
  assert.equal(a.kind, 'jet', '"вони реактивні" a few minutes before');
  assert.equal(a.pos.name, 'Новий Стародуб');
  const b = one(read, 17585); // "Нова Прага", no reply: the nearest target of the channel
  assert.equal(b.track, a.track);
  assert.equal(b.from, 'Новий Стародуб');
  const c = one(read, 17586); // reply: "В бік Аджамки"
  assert.equal(c.track, a.track);
  assert.equal(c.to, 'Аджамки');
  const d = one(read, 17587); // "За ним ще один Інгулецьке"
  assert.notEqual(d.track, a.track);
  assert.equal(d.kind, 'jet');
  const e = one(read, 17594); // "Другий дублює маршрут. Нова Прага"
  assert.equal(e.track, d.track);
  assert.equal(e.from, 'Інгулецьке');
  assert.equal(one(read, 17591).pos.name, 'Високі Байраки', '"Байраки" is Високі Байраки');
  assert.equal(one(read, 17590).pos.name, 'Канатове');
});

// ---------- ways of writing ----------

const P = (id, text, extra = {}) => ({ channel: '@t', id, date: new Date(Date.UTC(2026, 10, 4, 12, 0) + id * 60000).toISOString(), text, reply: null, ...extra });
// A fresh reader knows no channel's area yet: it looks near your point (here Kropyvnytskyi), as in the widget.
const readAll = (posts) => {
  const r = new Routes(window.NeptunBasemapPlaces);
  r.kmPerUnit = KM;
  r.defaultHome = { x: 563.9, y: 326.1 };
  return posts.map((p) => ({ post: p, out: r.add([p], Date.parse(p.date)) }));
};

test('lists: each line is a target of its own', () => {
  const read = readAll([P(1, '1 → Компаніївка\n1 → Долинська'), P(2, 'БпЛА → Суботці\nБпЛА → Шарівка\nРеактивний → Добровеличківка')]);
  const [a, b] = byId(read, 1);
  assert.notEqual(a.track, b.track);
  assert.equal(a.to, 'Компаніївка');
  assert.equal(b.to, 'Долинська');
  const c = byId(read, 2);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((s) => s.kind), ['plain', 'plain', 'jet']);
});

test('from and to: "Ще 1 від Христофорівки в бік Устинівки", "Реактив з Дніпропетровщини. Курс Лікарівка"', () => {
  const read = readAll([P(1, 'Ще 1 від Христофорівки в бік Устинівки'), P(20, 'Реактив з Дніпропетровщини. Курс Лікарівка')]);
  const a = one(read, 1);
  assert.equal(a.from, 'Христофорівки');
  assert.equal(a.to, 'Устинівки');
  const b = one(read, 20);
  assert.equal(b.kind, 'jet');
  assert.equal(b.from, 'Дніпропетровщина');
  assert.equal(b.to, 'Лікарівка');
});

test('what is not a target: chatter, alerts, greetings, planes, "Кроп без загроз", news of hits', () => {
  const read = readAll([
    P(1, '🚨Кропивницький район, повітряна тривога!'),
    P(2, '+Олександрійський рн'),
    P(3, 'Кроп без загроз ✅'),
    P(4, '🌅 Доброго ранку, спільното\n📅 Середа, 28 жовтня 2026'),
    P(5, 'Виліт 2 Ту-160 з ае Українка'),
    P(6, 'Внаслідок ворожої атаки пошкоджено вікна в Долинській громаді'),
    P(7, 'Якщо є бажання та можливість можете пригостити кавою чи єнергетіком 🙂'),
    P(8, 'Знам ви чули щось ?'),
    P(9, '💥 Дніпро - вибухи'),
  ]);
  for (const { post, out } of read) assert.equal(out.length, 0, `"${post.text}" gave ${out.map(fmt).join(', ')}`);
});

test('the channels\' short names: Кроп, Знам, Долік, Мико, "Знамʼянка 2га", "с.Нове"', () => {
  const read = readAll([P(1, 'Кроп, уважно'), P(20, 'Знам на увазі'), P(40, 'Долік на увазі ⚠️'), P(60, 'Реактивний з Мико на Помічну'), P(80, 'С.Нове')]);
  assert.equal(one(read, 1).pos.name, 'Кропивницький');
  assert.equal(one(read, 20).pos.name, 'Знам’янка');
  assert.equal(one(read, 40).pos.name, 'Долинська');
  assert.equal(one(read, 60).from, 'Миколаївщина');
  assert.equal(one(read, 80).pos.name, 'Нове');
});

test('of villages sharing a name, the one near the target; of a town and a village, the town', () => {
  const read = readAll([P(1, 'Реактивний на Новий Стародуб'), P(2, '→Аджамка', { reply: { id: 1, text: 'Реактивний на Новий Стародуб' } }), P(3, 'Веселівка', { reply: { id: 2, text: '→Аджамка' } }), P(30, '2 реактивних в бік П\'ятихаток')]);
  const v = one(read, 3);
  const adj = window.NeptunBasemapPlaces.places.find((p) => p[2] === 'Аджамка');
  assert.ok(Math.hypot(v.pos.x - adj[0], v.pos.y - adj[1]) * KM < 15, 'the Веселівка next to Аджамка, of 13');
  const p = one(read, 30);
  const town = window.NeptunBasemapPlaces.places.find((q) => q[2] === 'П’ятихатки' && q[3] <= 4);
  assert.ok(Math.hypot(p.pos.x - town[0], p.pos.y - town[1]) < 1, 'П\'ятихатки the town, not the village of that name');
});

test('@povitryanatrivogaaa: "✈️Кіровоградщина:" headers, "→Кропивницький/р-н з Дніпропетровщини", "(2х)"', () => {
  const read = readAll([P(1, '✈️Кіровоградщина:\n→Кропивницький/р-н з Дніпропетровщини.\n\n✈️Дніпропетровщина:\n→П\'ятихатки/Кіровоградщина (2х).'), P(20, 'КАБ 🚀→Затока/Чорноморськ (Одещина)')]);
  const [a, b] = byId(read, 1);
  assert.equal(a.kind, 'plain');
  assert.equal(a.pos.name, 'Кропивницький');
  assert.equal(a.from, 'Дніпропетровщина');
  assert.equal(b.count, 2);
  assert.equal(b.pos.name, 'П’ятихатки'); // the gazetteer's name
  const c = one(read, 20);
  assert.equal(c.kind, 'kab');
  assert.match(c.pos.name, /Затока/);
});

// ---------- intel.js: the posts with the tracks ----------

function intelWith(posts, trusted = []) {
  const intel = new Intel();
  intel.trusted = new Set(trusted);
  intel.setPlaces(window.NeptunBasemapPlaces, Geo.mapProjector(MAP.proj), KM);
  intel.addExternal(posts, Date.parse(posts[posts.length - 1].date));
  return intel;
}

test('a NEPTUN track near the channel route takes its posts: jet, sources, route, course', () => {
  const posts = week('krop_vanek').filter((p) => p.id >= 35866 && p.id <= 35872);
  const intel = intelWith(posts, ['@krop_vanek']);
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-04T14:06:00Z');
  try {
    // NEPTUN puts it a few km off Нова Прага and names another village (or none): the posts still count.
    const t = { id: 'trk_1', type: 'uav', lat: 48.585, lon: 32.88, locality: 'Аджамка', region: 'Кіровоградська область', updatedAt: '2026-11-04T14:05:00Z' };
    assert.deepEqual(intel.about(t) && intel.about(t).mode, 'jet', 'your own channel says jet');
    const src = intel.sources(t);
    assert.equal(src.length, 1, 'one channel, once');
    assert.equal(src[0].channel, '@krop_vanek');
    const r = intel.routeOf(t);
    assert.ok(r, 'a route');
    assert.deepEqual(r.points.map((p) => p.name).slice(0, 2), ['Новий Стародуб', 'Нова Прага']);
    assert.ok(r.heading > 240 && r.heading < 300, `course from the posts, west: ${r.heading}`);
    // Far from the route: none of it.
    const far = { ...t, id: 'trk_2', lat: 50.45, lon: 30.52, locality: 'Київ' };
    assert.equal(intel.near(far).length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('the same post from the NEPTUN feed and from Telegram counts once', () => {
  const intel = new Intel();
  const text = '✈️Кіровоградщина:\n→Кропивницький/р-н з Дніпропетровщини.';
  const now = Date.parse('2026-11-04T14:03:00Z');
  intel.add([{ channel: '@povitryanatrivogaaa', date: '2026-11-04T14:01:10Z', text }], now); // the feed: "Z", no number
  intel.addExternal([{ channel: '@povitryanatrivogaaa', id: 237786, date: '2026-11-04T14:01:10+00:00', text, reply: null }], now);
  intel.addExternal([{ channel: '@PovitryanaTrivogaaa', id: 237786, date: '2026-11-04T14:01:40+00:00', text: text + ' ', reply: null }], now);
  assert.equal(intel.posts.size, 1);
  const t = { id: 'x', type: 'uav', lat: 48.5, lon: 32.26, locality: 'Кропивницький', region: 'Кіровоградська область', updatedAt: '2026-11-04T14:02:00Z' };
  assert.equal(intel.sources(t).length, 1);
});

// ---------- main.js: the t.me/s page ----------

test('main.js reads the post number and the post it answers from t.me/s', () => {
  const Module = require('module');
  const load = Module._load;
  const fake = { on() {}, whenReady: () => ({ then() {} }) };
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: fake, shell: {}, BrowserWindow: function () {}, ipcMain: { on() {}, handle() {} }, screen: {} };
    return load.call(this, req, ...rest);
  };
  let parseTg;
  try {
    ({ parseTg } = require('../app/neptun/main.js'));
  } finally {
    Module._load = load;
  }
  const html =
    '<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="krop_vanek/35870">' +
    '<a class="tgme_widget_message_reply user-color-default" href="https://t.me/krop_vanek/35869" ">' +
    '<div class="tgme_widget_message_text js-message_reply_text" dir="auto">Реактивний на Новий Стародуб</div></a>' +
    '<div class="tgme_widget_message_text js-message_text" dir="auto">→Нова Прага</div>' +
    '<time datetime="2026-11-04T14:02:11+00:00" class="time">16:02</time></div></div>';
  assert.deepEqual(parseTg(html, 'krop_vanek'), [
    { channel: '@krop_vanek', id: 35870, date: '2026-11-04T14:02:11+00:00', text: '→Нова Прага', reply: { id: 35869, text: 'Реактивний на Новий Стародуб' } },
  ]);
});

// ---------- a reply that turns the target ----------

test('a reply that turns the target changes its route and course: "Відвернув на Варварівку/Братське"', () => {
  const { read } = run(week('krop_vanek'));
  const a = one(read, 35390); // "↳ В бік Долинської чз Гурівку"
  const b = one(read, 35391); // "↳ Відвернув на Варварівку/Братське"
  assert.equal(b.track, a.track);
  assert.equal(a.to, 'Долинської');
  assert.equal(b.to, 'Варварівку/Братське');
  assert.ok(Math.abs(((b.heading - a.heading + 540) % 360) - 180) > 60, `the course turned: ${a.heading} → ${b.heading}`);
  const c = one(read, 35328); // "↳ Назад на Миколаївщину в бік Первомайська"
  assert.equal(c.to, 'Миколаївщина');
  assert.ok(c.heading > 220 && c.heading < 300, `back west: ${c.heading}`);
});

test('types.predict: the channel course is used when NEPTUN has none, and over NEPTUN\'s when the post is newer', () => {
  global.Geo = Geo;
  require('../app/neptun/types.js');
  const T = global.NeptunTypes;
  const t = { id: 'a', type: 'uav', lat: 48.5, lon: 32.2, heading: 90, updatedAt: '2026-11-04T14:00:00Z' };
  T.setCourse(() => ({ heading: 270, at: Date.parse('2026-11-04T13:58:00Z') }));
  assert.equal(T.predict(t, Date.now()).heading, 90, 'an older post does not override NEPTUN');
  T.setCourse(() => ({ heading: 270, at: Date.parse('2026-11-04T14:02:00Z') }));
  const p = T.predict(t, Date.now());
  assert.equal(p.heading, 270, 'a newer post does');
  assert.equal(p.byPosts, true);
  assert.equal(T.predict({ ...t, heading: null }, Date.now()).heading, 270);
  T.setCourse(null);
});

// ---------- "Зник" and "Збили" ----------

test('"Не спостерігається" keeps the target 5 minutes as lost, "Збили" 4 minutes with a cross', () => {
  const r = new Routes(window.NeptunBasemapPlaces);
  r.kmPerUnit = KM;
  r.defaultHome = { x: 563.9, y: 326.1 };
  const t0 = Date.parse('2026-11-04T14:00:00Z');
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  r.add([{ channel: '@a', id: 1, date: at(0), text: 'Реактивний на Канатове', reply: null }], t0);
  const [lost] = r.add([{ channel: '@a', id: 2, date: at(1), text: 'Зник, але здається десь низько летить', reply: { id: 1, text: 'Реактивний на Канатове' } }], t0 + 60000);
  assert.equal(lost.fate, 'lost');
  assert.equal(lost.pos.name, 'Канатове', 'where it was last');
  assert.equal(r.live(t0 + 3 * 60000).length, 1, 'still there 2 min later');
  assert.equal(r.live(t0 + 3 * 60000)[0].lost, true);
  assert.equal(r.live(t0 + 7 * 60000).length, 0, 'gone after 5 min');
  r.add([{ channel: '@a', id: 3, date: at(2), text: 'Дрон на Компаніївку', reply: null }], t0 + 120000);
  const [down] = r.add([{ channel: '@a', id: 4, date: at(3), text: 'Збили', reply: { id: 3, text: 'Дрон на Компаніївку' } }], t0 + 180000);
  assert.equal(down.fate, 'down');
  const dn = r.live(t0 + 180000).find((s) => s.track === down.track);
  assert.ok(dn && dn.down, 'shot down: still there a few minutes, with a cross');
  assert.ok(!r.live(t0 + 8 * 60000).some((s) => s.track === down.track), 'and then off');
  const [back] = r.add([{ channel: '@a', id: 5, date: at(4), text: 'Знову до нас - Созонівка', reply: { id: 2, text: 'Зник' } }], t0 + 240000);
  assert.equal(back.track, lost.track, 'a lost one seen again is the same target');
  assert.ok(!back.gone);
});

test('a course from the words of a post: "Ракета з Харківщини курсом на Полтаву"', () => {
  const intel = new Intel();
  intel.setPlaces(window.NeptunBasemapPlaces, Geo.mapProjector(MAP.proj), KM, null);
  const now = Date.parse('2026-11-04T14:03:00Z');
  intel.add([{ channel: '@x', date: '2026-11-04T14:01:00Z', text: 'Ракета з Харківщини курсом на Полтаву' }], now);
  const t = { id: 'm', type: 'missile', lat: 49.59, lon: 34.55, heading: null, locality: 'Полтава', region: 'Полтавська область', updatedAt: '2026-11-04T14:02:00Z', destination: true };
  const h = intel.courseFromText(t);
  assert.ok(h != null && h > 225 && h < 315, `from Kharkiv oblast, west: ${h}`);
  assert.equal(intel.courseFromText({ ...t, id: 'n', locality: 'Суми' }), null, 'no post about it, no course');
});

test('a target with a course but no speed creeps, it does not race off: at most a few km', () => {
  global.Geo = Geo;
  require('../app/neptun/types.js');
  const T = global.NeptunTypes;
  T.setCourse(null);
  const t = { id: 'c', type: 'uav', lat: 48.5, lon: 32.2, heading: 270, updatedAt: '2026-11-04T14:00:00Z', confirmedAt: '2026-11-04T14:00:00Z' };
  const p = T.predict(t, Date.parse('2026-11-04T14:30:00Z'));
  assert.ok(p.km > 0 && p.km <= 4, `moved ${p.km} km in 30 min`);
  assert.equal(T.predict({ ...t, destination: true }, Date.parse('2026-11-04T14:30:00Z')).km, 0, '"курсом на Х" stays on Х');
  assert.ok(T.reachKm(t, 10) >= 20, 'the sector ahead reaches where it may be in 10 min');
});

test('"Пропав" is lost too', () => {
  const read = readAll([P(1, 'Реактивний на Канатове'), P(2, 'Пропав', { reply: { id: 1, text: 'Реактивний на Канатове' } })]);
  assert.equal(one(read, 2).fate, 'lost');
});

// ---------- the same targets, not new ones ----------

test('@krop_vanek: the lists "1 → Компаніївка ⏎ 1 → Долинська" four minutes apart are the same two jets', () => {
  const { read } = run(week('krop_vanek'));
  const a = byId(read, 35269); // 18:01 1 → Компаніївка ⏎ 1 → Долинська
  const b = byId(read, 35270); // 18:05 1 → Червоновершка ⏎ 1 → Молодіжне
  const c = byId(read, 35271); // 18:08 1 → Димине/Семенасте ⏎ 1 → Компаніївка
  const ids = new Set([...a, ...b, ...c].map((s) => s.track));
  assert.ok(ids.size <= 3, `${ids.size} targets for two jets: ${[...ids].join(', ')}`);
  for (const s of b) assert.ok(new Set(a.map((x) => x.track)).has(s.track), `${s.pos.name}: one of the two of 18:01`);
  assert.equal(a[1].pos.name, 'Долинська', 'the town, not the village Долинське');
});

test('@shpk_krop: "Ще один на Птх" → "Зайшов. На Петрове" → "Верблюжка" → "В бік Компаніївки" → "Хмельове" is one jet', () => {
  const { read } = run(week('shpk_krop'));
  const ids = [16603, 16606, 16607, 16609, 16612].map((id) => one(read, id).track);
  assert.equal(new Set(ids).size, 1, ids.join(', '));
  assert.equal(one(read, 16603).pos.name, 'П’ятихатки', '"Птх"');
  assert.equal(one(read, 16606).pos.name, 'Петрове', 'the Петрове by П\'ятихатки');
  const ptx = window.NeptunBasemapPlaces.places.find((p) => p[2] === 'П’ятихатки' && p[3] <= 4);
  const p = one(read, 16606).pos;
  assert.ok(Math.hypot(p.x - ptx[0], p.y - ptx[1]) * KM < 40, 'next to П\'ятихатки, not the village by Kropyvnytskyi');
  assert.equal(byId(read, 17317).length, 0, '"Локаційних Кроп/Знам/Олександр немає": none there');
  assert.equal(one(read, 16525).pos.name, 'Кривий Ріг', '"Над Кривим"');
});

test('a week of your two channels: few targets twice at once (the many of a mass attack aside)', () => {
  const limits = { krop_vanek: 45, shpk_krop: 100 };
  for (const ch of Object.keys(limits)) {
    const r = new Routes(window.NeptunBasemapPlaces);
    r.kmPerUnit = KM;
    r.defaultHome = HOME;
    let twins = 0;
    for (const p of week(ch)) {
      const now = Date.parse(p.date);
      r.add([p], now);
      const live = r.live(now, 8 * 60000).filter((s) => !s.down);
      const fam = (k) => (['missile', 'kab'].includes(k) ? k : 'drone');
      for (let i = 0; i < live.length; i++)
        for (let j = i + 1; j < live.length; j++)
          if (fam(live[i].kind) === fam(live[j].kind) && Math.hypot(live[i].pos.x - live[j].pos.x, live[i].pos.y - live[j].pos.y) * KM <= 20) twins++;
    }
    assert.ok(twins <= limits[ch], `@${ch}: ${twins} pairs of targets within 20 km of each other (was 90 / 119 before)`);
  }
});

// ---------- 09.11: a jet only your channel wrote of ----------

test('"Реактивний від Криворіжжя на Гурівку" → "→Долинська/Тимкове" → "→Сугокліївка" → "→Тарасівка і далі на захід" is one jet flying west', () => {
  const at = (m) => new Date(Date.parse('2026-11-09T08:14:00Z') + m * 60000).toISOString();
  const posts = [
    { id: 1, date: at(0), text: 'Реактивний від Криворіжжя на Гурівку', reply: null },
    { id: 2, date: at(0.5), text: '→Долинська/Тимкове', reply: null },
    { id: 3, date: at(3), text: '→Сугокліївка', reply: null },
    { id: 4, date: at(5), text: '→Тарасівка і далі на захід', reply: null },
  ].map((p) => ({ ...p, channel: '@krop_vanek' }));
  const { r, read } = run(posts);
  assert.equal(new Set(read.map((x) => one(read, x.post.id).track)).size, 1, 'one target');
  const first = one(read, 1);
  assert.ok(first.heading > 270 && first.heading < 350, `from Криворіжжя to Гурівка is north-west, got ${first.heading}`);
  assert.equal(one(read, 3).pos.name, 'Сугокліївка', 'a village of places-extra.js');
  // each next village lies west of the one before: the Тарасівка beyond Сугокліївка, not the one by Kropyvnytskyi
  const xs = read.map((x) => x.out[0].pos.x);
  assert.ok(xs[1] < xs[0] && xs[2] < xs[1] && xs[3] < xs[2], xs.join(' > '));
  assert.equal(r.isWide('@krop_vanek'), false);
});

test('a local channel is not a wide one, an all-Ukraine summary is', () => {
  assert.equal(run(week('krop_vanek')).r.isWide('@krop_vanek'), false);
  assert.equal(run(week('shpk_krop')).r.isWide('@shpk_krop'), false);
  assert.equal(run(week('povitryanatrivogaaa')).r.isWide('@povitryanatrivogaaa'), true);
});

test('"в бік Бобринця", "На Кроп поки немає, цей пішов ближче до Компаніївки", "1х" after "2х"', () => {
  const mk = (id, min, text) => ({ id, date: new Date(Date.parse('2026-11-09T10:00:00Z') + min * 60000).toISOString(), text, reply: null, channel: '@shpk_krop' });
  const { read } = run([mk(1, 0, 'Реактивний Долинська'), { ...mk(2, 2, 'В бік Бобринця'), reply: { id: 1, text: 'Реактивний Долинська' } }, mk(3, 20, 'БпЛА Нове'), mk(4, 22, 'На Кроп поки немає, цей пішов ближче до Компаніївки'), mk(5, 60, '2х БпЛА Тишківка'), mk(6, 63, '1х БпЛА Тишківка ⏎ 1х БпЛА Панчеве'.replace(' ⏎ ', '\n'))]);
  assert.equal(one(read, 2).pos.name, 'Бобринець');
  assert.equal(one(read, 2).track, one(read, 1).track);
  assert.equal(byId(read, 4).length, 0, 'nothing flies to the place said to be clear');
  assert.equal(one(read, 5).count, 2);
  assert.ok(byId(read, 6).every((s) => s.count === 1), 'one each now');
});

// ---------- a post edited in Telegram ----------

test('an edited post is read again: the target moves, keeps its id, later posts still follow it', () => {
  const mk = (id, min, text, reply) => ({ id, date: new Date(Date.parse('2026-11-09T08:14:00Z') + min * 60000).toISOString(), text, reply: reply || null, channel: '@krop_vanek' });
  const r = new Routes(window.NeptunBasemapPlaces);
  r.kmPerUnit = KM;
  r.defaultHome = HOME;
  const now = Date.parse('2026-11-09T08:25:00Z');
  r.add([mk(1, 0, 'Реактивний на Гурівку'), mk(2, 2, '→Братолюбівка'), mk(3, 5, '→Сугокліївка')], now);
  const before = r.live(now).map((s) => s.track);
  assert.equal(before.length, 1);
  assert.deepEqual(r.route(before[0]).map((p) => p.name), ['Гурівка', 'Братолюбівка', 'Сугокліївка']);
  const home = JSON.stringify(r.state('@krop_vanek').homePts);
  // the same three posts come again (every poll does that), the second one corrected
  const fresh = r.add([mk(1, 0, 'Реактивний на Гурівку'), mk(2, 2, '→Долинська/Тимкове'), mk(3, 5, '→Сугокліївка')], now);
  assert.equal(fresh.length, 1, 'the edited post');
  assert.equal(fresh[0].pos.name.split('/')[0], 'Долинська');
  const live = r.live(now);
  assert.deepEqual(live.map((s) => s.track), before, 'the same target');
  assert.equal(live[0].pos.name, 'Сугокліївка');
  assert.equal(r.route(before[0])[1].name.split('/')[0], 'Долинська');
  assert.equal(r.sightings.length, 3);
  assert.equal(JSON.stringify(r.state('@krop_vanek').homePts), home, 'not learnt twice');
  assert.equal(r.add([mk(1, 0, 'Реактивний на Гурівку'), mk(2, 2, '→Долинська/Тимкове'), mk(3, 5, '→Сугокліївка')], now).length, 0, 'nothing new the next time');
  // edited so that it names no target any more
  r.add([mk(3, 5, 'Відбій')], now);
  assert.equal(r.live(now)[0].pos.name.split('/')[0], 'Долинська');

  const intel = new Intel();
  intel.add([mk(7, 0, 'Вибухи Знамʼянка')], now);
  intel.add([mk(7, 0, 'Вибухи Олександрія')], now);
  assert.equal(intel.posts.size, 1, 'the old text is gone');
  assert.match([...intel.posts.values()][0].lines[0].text, /Олександрія/);
});
