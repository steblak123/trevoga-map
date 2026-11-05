// Routes from the posts of local monitoring channels (your own Telegram channels, read by main.js):
//   "Реактивний на Новий Стародуб"  ->  "↳ →Нова Прага"  ->  "↳ В бік Аджамки"  ->  "↳ Другий за ним йде, Інгулецьке"
// Each post is read line by line: what kind of target, how many, where it is (at), where it flies (to), where
// from. A reply continues the target of the post it answers (Telegram gives the quote of it too), a bare
// "→Сасівка" continues the nearest target of the channel that could have got there, "Ще 1 ..." starts a new
// one. Place names are looked up in the basemap gazetteer (basemap/places.js, map units): of the villages
// sharing a name the one nearest to the target's last point, or to where the channel usually writes about.
// Pure: no DOM, no network; tests/routes.test.js runs it on a week of real posts.
(function (root) {
  const Intel = root.NeptunIntel || (typeof require === 'function' ? require('./intel').Intel : null);
  const placeKey = Intel.placeKey;

  const TRACK_MS = 15 * 60000; // a target nobody wrote about this long is not continued by a bare post
  const KEEP_MS = 60 * 60000; // tracks and sightings are kept this long
  const KM_PER_MIN = { jet: 11, missile: 16, kab: 6, plain: 4, recon: 3, fpv: 2 }; // how far a target gets, with slack
  const FAR_KM = 230;
  const AREA_KM = 190; // a place under "✈️Сумщина:" is within this of the oblast's middle
  const RANK_WEIGHT = { 0: 3, 1: 3, 2: 3, 3: 3, 4: 2.5, 5: 1.6 }; // villages (6) 1
  const CONTEXT_MS = 90 * 60000; // "Ще 1 до нас зайшов" is of the kind the channel wrote about lately // a village this far from where the channel writes about is another one of that name

  // What a line is about (a line naming none continues the kind of the post, the target, or the channel).
  const AIR = /(?:^|[^а-яіїєґ])(?:ту|су|міг|іл)-?\s?\d{2,3}|стратегічн|бортів|(?:^|\s)ае(?:\s|$)|аеродром/i; // planes over Russia
  const KIND = [
    ['jet', /реактив|реактор|(?:^|[^а-яіїєґ'’ʼ])реакт(?![а-яіїєґ])|рбпла/i],
    ['kab', /(?:^|[^а-яіїєґ])каб(?:и|ів|ами|ам|ах|у)?(?![а-яіїєґ])|авіабомб/i],
    ['missile', /ракет|крилат|(?:^|[^а-яіїєґ])кр(?![а-яіїєґ])|балістик|калібр|іскандер|кинджал|х-?101|х-?59|х-?22|бандерол|бамбарол/i],
    ['recon', /розвід|орлан|zala|supercam/i],
    ['fpv', /fpv|фпв/i],
    ['plain', /✈|шахед|(?:^|[^а-яіїєґ])шах(?![а-яіїєґ])|мопед|бпла|герань|дрон|дурік|звичайн|(?:^|[^а-яіїєґ])звич(?![а-яіїєґ])/i],
  ];
  const ALERT = /повітряна тривога|відбій|рівень знижено|рівень підвищено|тривог[уаи] (?:триває|дали|зняли)|загроза (?:по|балістик|застосування)|^[+]\s*\S+\s+(?:рн|р-н|район)/i;
  const CLEAR = /(?:область|кіровоградщин\S*|в нас|наразі|поки)\s*(?:майже\s*)?чисто|чисто\s*(?:в|на)\s+(?:області|кіровоградщин)/i;
  // A target the channel no longer sees: 'lost' ("Зник", "Не спостерігається": it may fly low, it stays a few
  // minutes, faint), 'down' ("Збили", "Мінус", "Впав") or 'left' ("Вилетів з області"): gone at once.
  const DOWN = /збили|збито|(?:^|\s)мінус(?![а-яіїєґ])|впав|впала|недолетів|знищен|приземлил/i;
  const LEFT = /вилетів|вилітає з област|виходить з обл|вийшов з обл/i;
  const LOST = /не\s*спостеріга|(?:^|\s)зник|зникл|пропав|пропал|не\s*фікс|^[—–-]+$/i;
  const GONE = new RegExp(`${DOWN.source}|${LEFT.source}|${LOST.source}`, 'i');
  const fateOf = (line) => (DOWN.test(line) ? 'down' : LEFT.test(line) ? 'left' : LOST.test(line) ? 'lost' : null);
  const LOST_MS = 5 * 60000;
  const DOWN_MS = 4 * 60000; // a shot down one stays this long, with a cross, then goes
  const STEADY_KM = 8; // a lost target stays this long
  const NEW = /(?:^|\s)(?:ще|і ще|за ним|другий|другого|третій|ще один|наступн|новий|нова ціль|нові)(?![а-яіїєґ])/i;
  const ORDINAL = /^\s*(\d)\s*-?\s*(?:й|ий|ій|га|гий|ге)(?![а-яіїєґ])|^\s*(перший|другий|третій)/i;
  const COUNT = /^\s*(?:(?:і\s+)?ще\s+|за\s+ним\s+ще\s+|всього\s+)?(\d{1,2})(?![\d:.,/-])|(?:^|[\s(])(\d{1,2})\s*(?:х|x|шт)(?![а-яіїєґ])/i;
  const SAFE = /без\s+загроз|звуки\s+добр|не\s+летить|нічого\s+нема|поки\s+немає|поки\s+локаційно|чуєте|чули|статус|як\s*\?|онлайн/i;
  // News about what was hit, not where a target is now.
  const BOOM = /вибух|прил[іи]т|прильот|влучанн/i; // explosions are read by intel.js
  const NEWS = /внаслідок|пошкоджен|постраждал|загинул|поранен|завдав удар|вдарил|знищили|вибухотехнік|дснс|рятувальник|уламк/i;
  // Spellings the gazetteer does not take as they are.
  const REWRITE = [
    [/кривим\s+рогом|кривого\s+рогу|кривому\s+розі|кривий\s+ріг/gi, 'Кривий-Ріг'],
    [/жовті\s+води|жовтих\s+вод|жовтим\s+водам/gi, (m) => m.replace(/\s+/, ' ')],
    [/дніпро\.?\s*обл\S*|днпр\.?(?:\s*обл\S*)?/gi, 'Дніпропетровщина'],
  ];
  const NOISE_POST = /https?:\/\/|реквізит|підтрим|донат|кавою|хвилина мовчання|t\.me\//i;
  const GREETING = /📅|доброго ранку|добрий ранок|хвилина мовчання|надобраніч|тихої ночі|тихого (?:дня|вечора)/i;

  // Words that name a region, not a point: where a target comes from or leaves to.
  const REGIONS = [
    [/^дніпропетров|^дніпропетровщ/i, 'Дніпропетровщина', 717, 331],
    [/^черкащ|^черкашин|^черкаськ/i, 'Черкащина', 522, 268],
    [/^миколаївщ|^миколаївськ|^мико$|^микол$/i, 'Миколаївщина', 544, 419],
    [/^полтавщ|^полтавськ/i, 'Полтавщина', 658, 232],
    [/^вінниччин|^вінничин|^вінницьк/i, 'Вінниччина', 362, 273],
    [/^харківськ|^харківщ|^хaркiвщ/i, 'Харківщина', 789, 234],
    [/^київщ|^kиївщ|^київськ/i, 'Київщина', 473, 184],
    [/^одещин|^одеськ/i, 'Одещина', 435, 468],
    [/^херсонщ|^херсонськ/i, 'Херсонщина', 637, 468],
    [/^запоріжж[ія]$|^запорізьк/i, 'Запоріжжя', 755, 413],
    [/^криворіжж/i, 'Криворіжжя', 628, 375],
    [/^уманщ/i, 'Уманщина', 450, 305],
    [/^кіровоградщ|^кіровoградщ|^кіровоградськ/i, 'Кіровоградщина', 549, 335],
    [/^житомирщ|^житомирськ/i, 'Житомирщина', 356, 147],
    [/^чернігівщ|^чернігівськ/i, 'Чернігівщина', 548, 91],
    [/^сумщ|^сумськ/i, 'Сумщина', 654, 115],
    [/^донеччин|^донецьк[аіоу]/i, 'Донеччина', 870, 346],
    [/^луганщ|^луганськ[аіоу]/i, 'Луганщина', 937, 281],
    [/^рівненщ/i, 'Рівненщина', 246, 107],
    [/^волин/i, 'Волинь', 177, 102],
    [/^львівщ/i, 'Львівщина', 108, 206],
    [/^тернопільщ/i, 'Тернопільщина', 193, 238],
    [/^хмельниччин|^хмельницьк[аіоу]/i, 'Хмельниччина', 276, 236],
    [/^івано-франківщ/i, 'Івано-Франківщина', 144, 293],
    [/^закарпатт/i, 'Закарпаття', 48, 309],
    [/^чернівеччин|^буковин/i, 'Чернівеччина', 208, 332],
    [/^крим/i, 'Крим', 681, 592],
  ];
  // Short names the channels use for towns.
  const ALIASES = [
    [/^(?:кроп|кропа|кропі|кропу)$/i, 'Кропивницький'],
    [/^(?:знам|знамі)$/i, 'Знам’янка'],
    [/^(?:долік|доліку)$/i, 'Долинська'],
    [/^(?:кривого|кривому|кривий|кривий-ріг)$/i, 'Кривий Ріг'],
    [/^(?:олек|олександрії)$/i, 'Олександрія'],
    [/^(?:канат|канатове|канатовому)$/i, 'Канатове'],
    [/^(?:байраки|байраків)$/i, 'Високі Байраки'],
    [/^(?:нове|нового|новому)$/i, 'Нове'],
  ];
  // Parts of Kropyvnytskyi and villages next to it the gazetteer has not got (map units, as in places.js).
  const EXTRA = [
    [562.0, 323.0, 'Лелеківка', 6],
    [561.0, 326.0, 'Балашівка', 6],
    [566.5, 327.5, 'Кущівка', 6],
    [566.5, 324.0, 'Аерополь', 6],
    [563.5, 322.5, 'Катранівка', 6],
    [571.4, 323.6, 'Канатове', 6],
    [558.5, 363.6, 'Бобринець', 5],
    [579.7, 371.0, 'Устинівка', 5],
    [572.1, 358.3, 'Кетрисанівка', 6],
    [597.0, 381.6, 'Казанка', 5],
    [574.9, 418.1, 'Баштанка', 5],
    [598.6, 426.1, 'Березнегуватське', 5],
    [581.1, 279.3, 'Холодний Яр', 6],
    [578.7, 394.3, 'Новий Буг', 5],
  ];
  // Capitalized words at the start of a sentence that happen to be village names too.
  const NOT_PLACES = new Set(
    [
      'Центр', 'Тут', 'Так', 'Увага', 'Друзі', 'Область', 'Місто', 'Район', 'Поки', 'Наразі', 'Чисто', 'Гучно', 'Курс', 'Над', 'Біля',
      'Далі', 'Знову', 'Ще', 'Вибух', 'Вибухи', 'Пролітає', 'Заходить', 'Вийшов', 'Вилетів', 'Летить', 'Кружляє', 'Маневрує',
      'Перший', 'Другий', 'Третій', 'Реактивний', 'Реактив', 'Червоний', 'Жовтий', 'Дорозвідка', 'Транзит', 'Північ',
      'Південь', 'Схід', 'Захід', 'Вперед', 'Слава', 'Добре', 'Мирне', 'Тихе', 'Ясне', 'Світле', 'Спокійне', 'Надія', 'Дружба',
      'Перемога', 'Свобода', 'Нива', 'Зоря', 'Весна', 'Луг', 'Гай', 'Степ', 'Поле', 'Сад', 'Діброва', 'Вишневе', 'Аеропорт',
      'Шляхове', 'Рух', 'Шанс', 'Хто', 'Цей', 'Той', 'Оці', 'Один', 'Одне', 'Єдиний', 'Йде', 'Йдуть', 'Відпочив', 'Видихайте',
      'Вночі', 'Скоріш', 'Наче', 'Можливо', 'Може', 'Схоже', 'Ймовірно', 'Буде', 'Дякую', 'Очікуємо', 'Кажу', 'Вже', 'Все',
      'Багато', 'Мінусують', 'Збивають', 'Працюють', 'Валять', 'Акустично', 'Оперативно', 'Керована', 'Уходить', 'Курсує',
      'Новий', 'Нових', 'Західний', 'Східний', 'Північний', 'Південний', 'Західним', 'Південним', 'Понеділок', 'Вівторок', 'Середа',
      'Четвер', 'Пʼятниця', 'Субота', 'Неділя', 'Вектор', 'Ціль', 'Загальна', 'Україна', 'України', 'Україні',
    ].map(placeKey)
  );
  // Of these "Вишневе" and "Мирне" are real villages the channels write about: they count after "на", "→", "в бік".
  const SOFT = new Set(['Вишневе', 'Мирне', 'Аеропорт'].map(placeKey));

  // ---------- gazetteer ----------

  function Gazetteer(data) {
    const exact = new Map(); // key -> [{ x, y, name, rank }]
    const part = new Map(); // a word of a two-word name ("Байраки") -> the places it is part of
    const add = (map, k, p) => {
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    };
    for (const [x, y, name, rank] of [...(data.places || []), ...EXTRA]) {
      const p = { x, y, name, rank };
      const k = placeKey(name);
      add(exact, k, p);
      const ws = k.split(' ');
      if (ws.length > 1) for (const w of ws) if (w.length >= 5) add(part, w, p);
    }
    // A word many places share ("Станція ...", "Нова ...") names none of them.
    for (const [w, list] of part) if (new Set(list.map((p) => p.name)).size > 6) part.delete(w);
    this.exact = exact;
    this.part = part;
    this.byName = (name) => exact.get(placeKey(name)) || [];
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---------- one line ----------

  const WORD = /[A-Za-zА-Яа-яІіЇїЄєҐґ'’ʼ-]+/g;

  // Tokens of a line with their positions: { w, key, start, end, cap }.
  function tokens(line) {
    const out = [];
    for (const m of line.matchAll(WORD)) {
      const w = m[0].replace(/^[-'’ʼ]+|[-'’ʼ]+$/g, '');
      if (w.replace(/[-'’ʼ]/g, '').length < 3) continue;
      const start = m.index + m[0].indexOf(w);
      out.push({ w, key: placeKey(w), start, end: start + w.length, cap: /^[A-ZА-ЯІЇЄҐ]/.test(w) });
    }
    return out;
  }

  // The role of a place from the words before it: 'from', 'to' or 'at'.
  function roleOf(before) {
    const b = before.toLowerCase().replace(/[.,:;!]+\s*$/, ' ').trimEnd();
    if (/(?:^|[\s(])(?:від|з|із|зі|звідти)$/.test(b)) return 'from';
    if (/(?:→|->|➡️?|➡)$/.test(b)) return 'to';
    if (/(?:^|\s)(?:в|у)\s+(?:бік|сторону|напрямку|напрямі)$|(?:^|\s)курс(?:ом)?(?:\s+на)?$|(?:^|\s)(?:на|до|по курсу|на виліт в|через)$/.test(b)) {
      return /через$/.test(b) ? 'at' : 'to';
    }
    return 'at';
  }

  // Places named in a line: [{ role, names: [..], cands: [[place..]..], region }], in order. Names joined by "/"
  // ("Підлісне/Зелений Гай") make one group: the target is between them.
  function placesIn(line, gaz) {
    const toks = tokens(line);
    const found = [];
    for (let i = 0; i < toks.length; ) {
      let hit = null;
      for (let n = Math.min(3, toks.length - i); n >= 1 && !hit; n--) {
        const run = toks.slice(i, i + n);
        const key = run.map((t) => t.key).join(' ');
        const text = line.slice(run[0].start, run[n - 1].end);
        const region = n === 1 ? REGIONS.find(([re]) => re.test(run[0].w)) : null;
        if (region) {
          hit = { n, start: run[0].start, end: run[0].end, region: region[1], name: region[1], center: { x: region[2], y: region[3], name: region[1] } };
          break;
        }
        const alias = n === 1 && ALIASES.find(([re]) => re.test(run[0].w));
        let cands = alias ? gaz.byName(alias[1]) : gaz.exact.get(key);
        // Genitive plural drops the ending and puts in a vowel: "П'ятихаток" ~ "П'ятихатки" (пятихатк).
        if ((!cands || !cands.length) && !alias) cands = gaz.exact.get(key.replace(/[ои]([бвгджзклмнпрстфхцчшщ])$/, '$1'));
        let weak = false;
        if ((!cands || !cands.length) && n === 1) {
          cands = gaz.part.get(key);
          weak = true;
        }
        if (!cands || !cands.length) continue;
        const before = line.slice(0, run[0].start);
        const lead = /(?:→|->|➡|(?:^|\s)(?:на|в бік|у бік|курс|курсом на|до|від|біля|через|повз|над|с|смт)\.?\s*)$/i.test(before);
        if (!run[0].cap && !lead) continue; // places are written with a capital letter
        if (/^\s*(?:рн|р-н|район|районі|районах|районів|районом)(?![а-яіїєґ])/i.test(line.slice(run[n - 1].end))) continue; // a raion, not the town
        if (n === 1 && !alias && NOT_PLACES.has(key) && !(SOFT.has(key) && lead)) continue;
        if (n === 1 && key.length < 4 && run[0].w.length < 5 && !alias) continue;
        if (weak && !run[0].cap) continue;
        hit = { n, start: run[0].start, end: run[n - 1].end, cands, name: alias ? alias[1] : weak ? cands[0].name : text };
      }
      if (!hit) {
        i++;
        continue;
      }
      found.push(hit);
      i += hit.n;
    }
    const groups = [];
    let prevEnd = -1;
    for (const h of found) {
      const gap = prevEnd >= 0 ? line.slice(prevEnd, h.start) : null;
      const last = groups[groups.length - 1];
      if (last && gap != null && /^\s*(?:\d?[а-яіїєґ]{1,3}\s*)?[/|\\]\s*$|^\s*-\s*$/i.test(gap) && !!last.region === !!h.region) {
        last.names.push(h.name);
        last.cands.push(h.cands);
      } else {
        let role = roleOf(line.slice(prevEnd >= 0 ? prevEnd : 0, h.start));
        // "на Дніпропетровщині", "в Черкаській": in the region, not flying to it.
        if (h.region && role === 'to' && /(?:щині|ській|цькій|жжі|ькій)$/i.test(line.slice(h.start, h.end))) role = 'at';
        groups.push({ role, names: [h.name], cands: [h.cands], region: h.region || null, center: h.center || null, start: h.start });
      }
      prevEnd = h.end;
    }
    // "Реактивний від Дніпропетровщини до нас - Попельнасте": the bare name after "до нас -" is where it is.
    return groups;
  }

  function kindOf(line) {
    const k = KIND.find(([, re]) => re.test(line));
    return k ? k[0] : null;
  }

  // ---------- reading posts ----------

  class Routes {
    constructor(places) {
      this.gaz = new Gazetteer(places || { places: [] });
      this.channels = new Map(); // channel -> { tracks: Map, postTracks: Map, home: {x,y}|null, homePts: [], kind, kindAt }
      this.sightings = []; // [{ channel, post, at, track, kind, count, pos, from, to, heading, gone, text }]
      this.seq = 0;
      this.defaultHome = null; // { x, y }: where to look for names before a channel shows its own area (your point)
    }

    state(channel) {
      if (!this.channels.has(channel)) this.channels.set(channel, { tracks: new Map(), postTracks: new Map(), posts: new Map(), homePts: [], home: null, kind: null, kindAt: 0 });
      return this.channels.get(channel);
    }

    // The village of that name nearest to ref; null when even that one is too far for this channel.
    pick(cands, ref, home) {
      if (!cands || !cands.length) return null;
      const r = ref || home || this.defaultHome;
      if (!r) {
        const top = cands.slice().sort((a, b) => a.rank - b.rank)[0];
        return cands.length === 1 || top.rank <= 4 ? top : null;
      }
      let best = null;
      let bd = Infinity;
      for (const p of cands) {
        // A town before a village not much nearer: "П'ятихатки" is the town in Dnipro oblast, not the village
        // of that name half as far away.
        const d = (dist(p, r) + 2) / (RANK_WEIGHT[p.rank] || 1);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      const h = home || this.defaultHome;
      const far = h ? dist(best, h) * this.kmPerUnit : 0;
      if (far > FAR_KM && best.rank > 3) return null;
      return best;
    }

    // One point for a group of names: their middle when they are close together, else the first one.
    point(group, ref, home) {
      const pts = [];
      for (const cands of group.cands) {
        const p = this.pick(cands, pts[0] || ref, home);
        if (p) pts.push(p);
      }
      if (!pts.length) return null;
      const close = pts.filter((p) => dist(p, pts[0]) * this.kmPerUnit < 35);
      const x = close.reduce((s, p) => s + p.x, 0) / close.length;
      const y = close.reduce((s, p) => s + p.y, 0) / close.length;
      return { x, y, name: close.map((p) => p.name).join('/'), said: group.names.join('/'), rank: Math.min(...close.map((p) => p.rank)) };
    }

    learnHome(st, p) {
      if (!p || p.rank > 6) return;
      st.homePts.push({ x: p.x, y: p.y });
      if (st.homePts.length > 60) st.homePts.shift();
      const xs = st.homePts.map((q) => q.x).sort((a, b) => a - b);
      const ys = st.homePts.map((q) => q.y).sort((a, b) => a - b);
      const mid = (a) => a[Math.floor(a.length / 2)];
      if (st.homePts.length >= 3) st.home = { x: mid(xs), y: mid(ys) };
    }

    // posts: [{ channel, id, date, text, reply: { id, text } | null }], oldest first or not.
    // Returns the sightings these posts gave.
    add(posts, now = Date.now()) {
      const fresh = [];
      const list = posts.filter((p) => p && typeof p.text === 'string' && p.id != null).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id - b.id);
      for (const post of list) {
        const st = this.state(post.channel);
        if (st.posts.has(post.id)) continue;
        const out = this.read(st, post);
        st.posts.set(post.id, out);
        for (const s of out) {
          this.sightings.push(s);
          fresh.push(s);
        }
      }
      this.prune(now);
      return fresh;
    }

    prune(now) {
      const cut = now - KEEP_MS;
      this.sightings = this.sightings.filter((s) => s.at >= cut);
      for (const st of this.channels.values()) {
        for (const [id, t] of st.tracks) if (t.updated < cut) st.tracks.delete(id);
        for (const [id, out] of st.posts) if (out.at < cut) st.posts.delete(id);
      }
    }

    // The tracks a reply continues: those of the post it answers, or of that post's own reply chain.
    replyTracks(st, post) {
      let id = post.reply && post.reply.id;
      for (let i = 0; id != null && i < 30; i++) {
        const ids = st.postTracks.get(id);
        if (ids && ids.length) return ids.map((k) => st.tracks.get(k)).filter(Boolean);
        const parent = st.posts.get(id);
        id = parent ? parent.replyId : null;
      }
      return [];
    }

    read(st, post) {
      const at = Date.parse(post.date) || Date.now();
      const out = [];
      out.at = at;
      out.replyId = post.reply ? post.reply.id : null;
      const text = post.text.replace(/\r/g, '');
      if (!text.trim() || (NOISE_POST.test(text) && text.length > 60) || NEWS.test(text) || (GREETING.test(text) && text.length > 40) || text.length > 700) return out;

      // The kind and place of the post this one answers, from Telegram's quote of it.
      const quoted = post.reply && post.reply.text ? post.reply.text : '';
      const quoteKind = quoted ? kindOf(quoted) : null;
      const thread = post.reply ? this.replyTracks(st, post) : [];
      let postKind = null;
      let area = null; // "✈️Житомирщина:" — the region the next lines are about (all-Ukraine channels)
      let body = text;
      for (const [re, to] of REWRITE) body = body.replace(re, to);
      const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const used = new Set();
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lk = kindOf(line);
        if (lk) postKind = lk; // "Загроза по Бандеролям": what the next posts are about
        if (ALERT.test(line) || /^\s*\+/.test(line) || AIR.test(line) || BOOM.test(line)) continue;
        const head = /^[^А-Яа-яІіЇїЄєҐґA-Za-z]*([А-ЯІЇЄҐ][^:()]{3,40}?)(?:\s*\([^)]*\))?\s*:\s*$/.exec(line);
        if (head) {
          const g = placesIn(head[1], this.gaz)[0];
          area = g && g.region ? g.center : null;
          continue;
        }
        if (CLEAR.test(line) && !/кроп|місто/i.test(line)) {
          for (const t of st.tracks.values()) {
            if (t.updated > at) continue; // not those named after it
            t.gone = true;
            t.fate = 'left';
          }
          continue;
        }
        const groups = placesIn(line, this.gaz);
        const gone = GONE.test(line);
        const fate = gone ? fateOf(line) : null;
        if (!groups.length && !gone) continue;
        if (SAFE.test(line) && groups.length <= 1 && !gone) continue; // "Кроп без загроз ✅"
        if (/^\s*(?:якщо|може|можливо|ймовірно|очікуємо|будуть|буде)\s/i.test(line) && !thread.length) continue; // what may come
        const ord = ORDINAL.exec(line);
        const ordinal = ord ? (ord[1] ? Number(ord[1]) : { перший: 1, другий: 2, третій: 3 }[ord[2].toLowerCase()]) : 0;
        // A list of targets ("1 на Смоліне" / "2х БпЛА Тишківка") names new ones; so do "ще", "за ним".
        const listed = !ord && (lines.length > 1 || !post.reply) && /^\s*\d+\s*(?:х|x|шт\S*)?(?:\s|→|-|$)/i.test(line);
        // "Зелене, ще 2 позаду йде": the place is of this one, the others come after it.
        const nw = NEW.exec(line);
        const isNew = (nw && ordinal !== 1 && !(groups.length && groups[0].start < nw.index)) || listed;
        const cnt = COUNT.exec(line);
        const count = cnt && !ord ? Math.max(1, Number(cnt[1] || cnt[2])) : 1;
        const kindHint = lk || postKind || quoteKind;
        const minutes = (t) => Math.max(0, (at - t.updated) / 60000);

        // The track: of the thread this post answers, or the nearest live one of the channel that could have
        // got there (names are read near each one: of thirteen Веселівка the one next to it), or a new one.
        let track = null;
        if (thread.length && !isNew) {
          if (ordinal) track = thread.find((t) => (t.ordinal || 1) === ordinal) || null;
          else {
            // Of a thread of several ("1 Смоліне / 1 Новомиргород / 1 Вільне" -> "Нова Павлівка") the one nearest.
            const free = thread.filter((t) => !used.has(t.id));
            track = free.length > 1 ? this.nearest(free, groups, area || st.home) : free[0] || (used.size ? null : thread[0]);
          }
        }
        // "Затока/Чорноморськ (Одещина)": the region named in the line is where to look for the names.
        const inRegion = groups.find((g) => g.region && g.role === 'at');
        const where = (inRegion && inRegion.center) || area;
        const near = track ? track.last : thread.length ? thread[0].last : where;
        let r = this.resolve(groups, near, where || st.home, isNew);
        if (!track && !thread.length && (!isNew || ordinal) && (r.pos || groups.length)) {
          let best = null;
          let bd = Infinity;
          for (const t of st.tracks.values()) {
            if (t.gone || !t.last || at - t.updated > TRACK_MS || t.updated - at > 60000 || used.has(t.id)) continue;
            // A "БпЛА" may turn out jet in a reply; a line that names its kind is about a target of that kind.
            if (lk && t.kind && lk !== t.kind) continue;
            if (!lk && kindHint && t.kind && kindHint !== t.kind) continue;
            const rr = this.resolve(groups, t.last, where || st.home, false);
            if (!rr.pos) continue;
            if (where && dist(rr.pos, where) * this.kmPerUnit > AREA_KM) continue; // a namesake outside the region
            const km = dist(t.last, rr.pos) * this.kmPerUnit;
            // "Реактив Голованівськ" names a target of its own unless one was just next to it.
            const reach = lk ? 15 + 4 * minutes(t) : Math.min(90, 20 + minutes(t) * (KM_PER_MIN[t.kind] || 8));
            if (km <= reach && km < bd) {
              bd = km;
              best = { t, rr };
            }
          }
          if (best) {
            track = best.t;
            r = best.rr;
          }
        }
        // A target cannot have got that far since it was last named: it is another one.
        if (track && track.last && r.pos && !ordinal) {
          const km = dist(track.last, r.pos) * this.kmPerUnit;
          if (km > 40 + minutes(track) * (KM_PER_MIN[track.kind] || 11) * 1.5) {
            track = null;
            r = this.resolve(groups, where, where || st.home, true);
          }
        }
        const { pos, toG, fromG, toPt } = r;
        if (!pos && !gone && !toG) continue;
        if (!track && !pos && gone) {
          track = thread.find((t) => !used.has(t.id)) || null; // "Вилітає з області": the one of the thread
          if (!track) continue; // "1 мінус": which one is not said
        }
        if (!track && thread.length && pos) {
          // "Другий за ним йде, Інгулецьке": a new target in the same thread, of the same kind.
          track = this.newTrack(st, post, li, kindHint || thread[0].kind, count);
          track.ordinal = ordinal || thread.length + 1;
          for (const c of thread) {
            if (!c.ordinal) c.ordinal = 1;
            if (c.count > 1 && !listed) c.count--; // "2х реактивних ..." -> "Другий за ним": one of the two
          }
          thread.push(track);
        }
        if (!track) {
          if (!pos || gone) continue; // "Зник в П'ятихатках" of a target not seen before
          const ctxKind = at - st.kindAt < CONTEXT_MS ? st.kind : null;
          track = this.newTrack(st, post, li, kindHint || ctxKind, count);
        }
        used.add(track.id);
        if (lk && (!track.kind || track.kind === 'plain' || lk === 'jet')) track.kind = lk;
        else if (!track.kind) track.kind = kindHint || (at - st.kindAt < CONTEXT_MS ? st.kind : null);
        if (count > 1 && isNew) track.count = count;

        const prev = track.last;
        const fromPt = fromG && !fromG.region ? this.point(fromG, prev || pos, st.home) : null;
        let heading = null;
        // The course over at least STEADY_KM of its way (the last 15 min), so a village to the side does not
        // swing it; a turn ("Відвернув на …") shows once it has gone that far the new way.
        let a = null;
        if (pos) {
          for (let i = track.points.length - 1; i >= 0; i--) {
            const q = track.points[i];
            if (at - q.at > 15 * 60000) break;
            a = q;
            if (dist(q, pos) * this.kmPerUnit >= STEADY_KM) break;
          }
          if (!a && prev) a = prev; // named long ago: still the way it came
          if (a && dist(a, pos) * this.kmPerUnit < 3) a = null;
        }
        if (!a) a = fromPt;
        if (pos && a && dist(a, pos) * this.kmPerUnit >= 3) heading = bearing(a, pos);
        if (pos && toPt && dist(pos, toPt) * this.kmPerUnit >= 3) heading = bearing(pos, toPt);
        const prevName = track.points.length ? [...track.points].reverse().find((q) => !pos || q.name !== pos.name) : null;
        const s = {
          channel: post.channel,
          post: post.id,
          at,
          track: track.id,
          kind: track.kind,
          count: track.count,
          // a "Не спостерігається" without a place: where it was last
          pos: pos ? { x: pos.x, y: pos.y, name: pos.name, est: !!pos.est } : gone && track.last ? { x: track.last.x, y: track.last.y, name: track.last.name, est: true, last: true } : null,
          from: fromG ? fromG.names.join('/') : prevName ? prevName.name : null,
          to: toG ? toG.names.join('/') : null,
          heading,
          gone,
          fate,
          text: line.length > 120 ? line.slice(0, 119) + '…' : line,
        };
        if (pos) {
          track.last = { x: pos.x, y: pos.y, name: pos.name, at };
          track.points.push(track.last);
          if (!pos.est && pos.rank <= 6) this.learnHome(st, pos);
        }
        if (gone) {
          track.gone = true;
          track.fate = fate;
          track.goneAt = at;
        } else if (pos) {
          track.gone = false;
          track.fate = null;
        }
        track.updated = at;
        if (track.kind) {
          st.kind = track.kind;
          st.kindAt = at;
        }
        out.push(s);
      }
      if (postKind) {
        st.kind = postKind;
        st.kindAt = at;
      }
      const ids = [...new Set(out.map((s) => s.track))];
      if (ids.length) st.postTracks.set(post.id, ids);
      else if (thread.length) st.postTracks.set(post.id, thread.map((t) => t.id));
      return out;
    }

    // Points of the place groups of a line read near ref (or the channel's area): where the target is (named
    // bare or after "біля", "над"; else where it flies, "на Х" is said as it comes up to Х; else, for a new
    // target, where it comes from: "Реактивний від Жовті Води до нас"), where it flies and where from.
    resolve(groups, ref, home, isNew) {
      const pts = groups.map((g) => (g.region ? null : this.point(g, ref, home)));
      const atIdx = groups.findIndex((g, i) => g.role === 'at' && pts[i]);
      const toIdx = groups.findIndex((g, i) => g.role === 'to' && pts[i]);
      const fromIdx = groups.findIndex((g, i) => g.role === 'from' && pts[i]);
      let pos = atIdx >= 0 ? pts[atIdx] : toIdx >= 0 ? { ...pts[toIdx], est: true } : null;
      if (!pos && fromIdx >= 0 && !(ref && !isNew)) pos = { ...pts[fromIdx], est: true };
      const toI = groups.findIndex((g, i) => g.role === 'to' && i !== atIdx && (pts[i] || g.region));
      return { pos, toG: toI >= 0 ? groups[toI] : null, toPt: toI >= 0 ? pts[toI] : null, fromG: groups.find((g) => g.role === 'from') || null };
    }

    // The track of the list whose last point is nearest to where the line's names are read near it.
    nearest(list, groups, home) {
      let best = list[0];
      let bd = Infinity;
      for (const t of list) {
        if (!t.last) continue;
        const rr = this.resolve(groups, t.last, home, false);
        if (!rr.pos) continue;
        const d = dist(t.last, rr.pos);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      return best;
    }

    newTrack(st, post, line, kind, count) {
      const t = { id: `${post.channel}#${post.id}.${line}`, kind: kind || null, count: count || 1, last: null, points: [], updated: Date.parse(post.date) || 0, gone: false, ordinal: 0 };
      t.thread = t.id;
      st.tracks.set(t.id, t);
      return t;
    }

    // The recent sightings of live tracks: [{ ...sighting }], the latest one per track. A lost one ("Зник")
    // stays LOST_MS, with lost: true.
    live(now = Date.now(), maxAge = TRACK_MS) {
      const last = new Map();
      for (const s of this.sightings) if (now - s.at <= maxAge && s.pos) last.set(s.track, s);
      const out = [];
      for (const s of last.values()) {
        const t = this.track(s.channel, s.track);
        if (!t) continue;
        if (!t.gone) out.push(s);
        else if (t.fate === 'lost' && now - t.goneAt <= LOST_MS) out.push({ ...s, lost: true });
        else if (t.fate === 'down' && now - t.goneAt <= DOWN_MS) out.push({ ...s, down: true });
      }
      return out;
    }

    track(channel, id) {
      const st = this.channels.get(channel);
      return st ? st.tracks.get(id) || null : null;
    }

    // The latest sighting of a track.
    lastOf(id) {
      for (let i = this.sightings.length - 1; i >= 0; i--) if (this.sightings[i].track === id) return this.sightings[i];
      return null;
    }

    // The route of a track so far: [{ name, at }], oldest first.
    route(trackId) {
      for (const st of this.channels.values()) {
        const t = st.tracks.get(trackId);
        if (t) return t.points.map((p) => ({ name: p.name, at: p.at, x: p.x, y: p.y }));
      }
      return [];
    }
  }
  Routes.prototype.kmPerUnit = 1.3234; // map.json: 1 / (proj.k * 1000); widget.js sets the exact one

  // Degrees clockwise from north between two map points (y grows to the south).
  function bearing(a, b) {
    return ((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI + 360) % 360;
  }

  Routes.placesIn = placesIn;
  Routes.kindOf = kindOf;
  Routes.Gazetteer = Gazetteer;
  root.NeptunRoutes = Routes;
  if (typeof module === 'object' && module.exports) module.exports = { Routes };
})(typeof self !== 'undefined' ? self : this);
