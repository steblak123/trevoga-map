// The channel posts behind the tracks (GET /api/v1/messages, e.g. "1 Реактивний 🛵 на Кладьківку /Вересоч"):
// - jet or not: NEPTUN's own map knows a jet Shahed by an internal subtype the open API does not send, so a
//   Shahed track is called jet when the latest post that names its place says "реактивний", and plain when
//   that post speaks of an ordinary Shahed;
// - sources: which channels wrote about the track's place lately, with the time and the line.
// The feed is polled every 30 s (the API allows every 5 s) and kept for 45 minutes.
// Your own Telegram channels (main.js reads them) come in too, with the post number and the post each one
// answers: routes.js follows their targets from post to post ("Реактивний на Новий Стародуб" -> "→Нова Прага")
// and a track then takes the posts of the channel targets near it, not only those that name its place.
// A post that comes both from the feed and from Telegram (the same channel and text) counts once.
(function (root) {
  const URL = 'https://neptun.in.ua/api/v1/messages';
  const EVERY = 30000;
  const FAST_EVERY = 10000; // while a target is in your radius (the API allows every 5 s)
  const KEEP_MS = 45 * 60000;
  const BEFORE_MS = 20 * 60000; // a post may name a place up to this long before the track was last updated
  const SAME_MS = 3 * 60000; // the same text of the same channel within this time is the same post
  const NEAR_KM = 15; // a channel target this close to a track is that track (where it flies to: 25 km)
  const NEAR_EST_KM = 25;
  const JET = /реактивн/i;
  const NOT_JET = /не\s+реактивн/i;
  // What a line is about, checked in this order; a line naming none continues the line before it.
  const KINDS = [
    ['fpv', /fpv|фпв/i],
    ['recon', /розвід|орлан|zala|(?:^|[^а-яіїєґ])зала(?![а-яіїєґ])|supercam|суперкам/i],
    ['missile', /ракет|крилат|балістик|калібр|іскандер|кинджал|х-?101|х-?59|х-?22/i],
    ['kab', /(?:^|[^а-яіїєґ])каб(?:и|ів|ами|ам|ах|у)?(?![а-яіїєґ])|авіабомб|керован/i], // \b knows no Cyrillic
    ['plain', /шахед|мопед|бпла|герань|гербер|дрон|балалайк|🛵|🏍/i],
  ];
  const ALERT_LINE = /відбій|тривог|укритт/i; // air-raid notices name districts, not targets
  // Explosions: a line that says they were heard or hit, not a warning that they may come.
  const BOOM = /вибух|прил[іи]т|прильот|влучанн|детонац/i;
  const NOT_BOOM = /не\s+чут|не\s+було|можлив|без\s+вибух|загроз|якщо|попередж|не\s+підтвердж|бережіть|укритт|фейк/i;
  const AHEAD_KM = 70; // a "→Х" post reaches this far ahead of a target whose course points at Х
  const FAR_WORD_KM = 30; // a track's latest word counts for a target only while that point is this near it
  const BOOM_MS = 40 * 60000; // an explosion stays on the map this long, fading
  const OFFICIAL = /повітряні сили|air force|kpszsu/i;
  // Line kinds that may speak of a target of each kind (null: a line that names no kind at all).
  // The first one is the target's own kind.
  const FITS = { uav: ['plain', 'jet', null], jet: ['jet', 'plain', null], fpv: ['fpv', null], recon: ['recon', 'plain', null], missile: ['missile', null], ballistic: ['missile', null], kab: ['kab', null] };
  // Case endings, longest first, cut off to compare declined place names: "Кладьківку" ~ "Кладьківка".
  const ENDINGS = ['ами', 'ями', 'ові', 'еві', 'ого', 'ому', 'ою', 'ею', 'ям', 'ах', 'ях', 'ів', 'їв', 'ам', 'ом', 'ем', 'ий', 'ій', 'ої', 'ім', 'их', 'іх', 'а', 'я', 'у', 'ю', 'і', 'ї', 'е', 'є', 'о', 'и'];

  // Lower case, Ukrainian and Russian spellings brought together, apostrophes and soft signs dropped.
  const norm = (w) =>
    w
      .toLowerCase()
      .replace(/[’ʼ`'ь]/g, '')
      .replace(/[їі]/g, 'и')
      .replace(/[єе]/g, 'и') // and е: "Київ" / "Києві" alternate the vowel
      .replace(/ґ/g, 'г')
      .replace(/ы/g, 'и')
      .replace(/э/g, 'е')
      .replace(/ё/g, 'е');

  function stem(word) {
    const w = norm(word);
    for (const e of ENDINGS.map(norm)) if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length);
    return w;
  }

  const words = (text) => text.split(/[^A-Za-zА-Яа-яІіЇїЄєҐґЁёЫыЭэ'’ʼ-]+/).filter((w) => w.replace(/[-'’ʼ]/g, '').length >= 3);
  const placeKey = (name) => words(String(name || '')).map(stem).join(' ');

  class Intel {
    constructor() {
      this.posts = new Map(); // channel|date|text -> { at, channel, lines: [{ mode, keys:Set, text }] }
      this.index = new Map(); // place key -> [{ at, mode, channel, text }] newest first
      this.timer = null;
      this.listeners = new Set();
      this.trusted = new Set(); // your own channels ('@name', lower case): one of them is enough for a jet
      this.seen = new Map(); // channel|text -> times: the same post from the feed and from Telegram
      this.feedChannels = new Set(); // '@name' (lower case) of the channels in NEPTUN's own feed
      this.routes = null; // routes.js over the basemap gazetteer (setPlaces)
      this.nearCache = new Map(); // track id -> its near() for this version
      this.project = null; // (lat, lon) -> [x, y] in map units, set by widget.js
      this.kmPerUnit = 1;
      this.version = 0;
    }

    onUpdate(fn) {
      this.listeners.add(fn);
    }

    start() {
      if (this.timer) return;
      this.poll();
      this.timer = setInterval(() => this.poll(), this.fast ? FAST_EVERY : EVERY);
    }

    // Faster while something is close (widget.js).
    setFast(on) {
      if (!!on === !!this.fast) return;
      this.fast = !!on;
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
      this.start();
    }

    stop() {
      clearInterval(this.timer);
      this.timer = null;
    }

    async poll() {
      try {
        const res = await fetch(URL, { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json();
        // the channels NEPTUN reads itself: their targets are NEPTUN's (widget.js makes none of its own of them)
        for (const m of body.messages || []) if (m && m.channel) this.feedChannels.add(String(m.channel).trim().toLowerCase());
        if (this.add(body.messages || [])) this.changed();
      } catch (e) {
        console.log('[intel] messages:', e.message);
      }
    }

    // Each line takes the kind it names; a line naming none continues the line before it
    // ("1 Реактивний 🛵 на Сновськ" + "воловики" on the next line). A header line before any kind names none.
    add(messages, now = Date.now()) {
      let added = false;
      for (const m of messages) {
        if (!m || typeof m.text !== 'string') continue;
        const key = `${m.channel}|${m.date}|${m.text}`;
        if (this.posts.has(key)) continue;
        const at = Date.parse(m.date) || now;
        const same = `${String(m.channel || '').trim().toLowerCase()}|${norm(m.text).replace(/[^a-zа-я0-9]+/g, '')}`;
        const times = this.seen.get(same) || [];
        if (times.some((x) => Math.abs(x - at) <= SAME_MS)) continue; // came already from the other source
        times.push(at);
        this.seen.set(same, times);
        let mode = null;
        const lines = [];
        for (const raw of m.text.split(/\n+/)) {
          const line = raw.trim();
          if (!line) continue;
          if (JET.test(line) && !NOT_JET.test(line)) mode = 'jet';
          else {
            const k = KINDS.find(([, re]) => re.test(line));
            if (k) mode = k[0];
          }
          if (ALERT_LINE.test(line)) continue;
          const ws = words(line).map(stem);
          if (!ws.length) continue;
          const keys = new Set(ws);
          for (let i = 0; i + 1 < ws.length; i++) keys.add(`${ws[i]} ${ws[i + 1]}`); // two-word places: "Біла Церква"
          lines.push({ mode, keys, text: line.length > 120 ? line.slice(0, 119) + '…' : line, boom: BOOM.test(line) && !NOT_BOOM.test(line) });
        }
        this.posts.set(key, { at, channel: String(m.channel || '').trim(), lines });
        added = true;
      }
      for (const [key, p] of this.posts) if (now - p.at > KEEP_MS) this.posts.delete(key);
      if (this.seen.size > 2000 || added) {
        for (const [k, times] of this.seen) {
          const keep = times.filter((x) => now - x <= KEEP_MS);
          if (keep.length) this.seen.set(k, keep);
          else this.seen.delete(k);
        }
      }
      if (added) this.reindex();
      return added;
    }

    reindex() {
      this.index.clear();
      for (const p of this.posts.values()) {
        for (const line of p.lines) {
          for (const k of line.keys) {
            if (!this.index.has(k)) this.index.set(k, []);
            this.index.get(k).push({ at: p.at, mode: line.mode, channel: p.channel, text: line.text });
          }
        }
      }
      for (const list of this.index.values()) list.sort((a, b) => b.at - a.at);
    }

    // Posts from elsewhere (your own Telegram channels, read by main.js).
    addExternal(posts, now = Date.now()) {
      const list = (posts || []).filter((p) => p && typeof p.text === 'string');
      this.early = this.routes ? null : list; // the gazetteer may come after the first posts
      const routed = this.routes ? this.routes.add(list.filter((p) => p.id != null), now).length : 0;
      if (this.add(list, now) || routed) this.changed();
    }

    // The gazetteer of the basemap (basemap/places.js): place names -> map points, for routes.js.
    setPlaces(data, project, kmPerUnit, home) {
      const Routes = root.NeptunRoutes || (typeof require === 'function' ? require('./routes').Routes : null);
      if (project) this.project = project;
      if (kmPerUnit) this.kmPerUnit = kmPerUnit;
      if (!Routes || !data) return;
      if (!this.routes) this.routes = new Routes(data);
      this.routes.kmPerUnit = this.kmPerUnit;
      if (home !== undefined) this.routes.defaultHome = home;
      if (this.early) this.addExternal(this.early);
    }

    // Sightings of the channels' targets near the track ([lat, lon] of it and of its trail), in the window
    // of mentions(): [{ at, mode, channel, text, route }], newest first.
    near(t) {
      if (!this.routes || !this.project || !t || t.areaOnly || !Number.isFinite(t.lat)) return [];
      const ck = `${this.version}|${t.updatedAt}|${t.lat},${t.lon}`;
      const c = this.nearCache.get(t.id);
      if (c && c.k === ck) return c.list;
      const list = this.nearNow(t);
      if (this.nearCache.size > 3000) this.nearCache.clear();
      this.nearCache.set(t.id, { k: ck, list });
      return list;
    }

    nearNow(t) {
      const pts = [[t.lat, t.lon], ...(Array.isArray(t.trail) ? t.trail : []).filter((q) => q && Number.isFinite(q.lat)).map((q) => [q.lat, q.lon])].map(([la, lo]) => this.project(la, lo));
      const since = (Date.parse(t.updatedAt || t.confirmedAt) || Date.now()) - BEFORE_MS;
      const out = [];
      for (const s of this.routes.sightings) {
        if (s.at < since || !s.pos) continue;
        const lim = (s.pos.est ? NEAR_EST_KM : NEAR_KM) / this.kmPerUnit;
        let hit = pts.some(([x, y]) => Math.hypot(x - s.pos.x, y - s.pos.y) <= lim);
        // "на Канатове": the place is where it heads, and may be far ahead of it — a target whose own course
        // points at that place (within 35°) and is not farther than AHEAD_KM from it is the one meant
        if (!hit && s.pos.est && Number.isFinite(t.heading)) {
          const [x, y] = pts[0];
          const km = Math.hypot(x - s.pos.x, y - s.pos.y) * this.kmPerUnit;
          if (km <= AHEAD_KM) {
            const bearing = (Math.atan2(s.pos.x - x, y - s.pos.y) * 180) / Math.PI;
            const d = Math.abs((((bearing - t.heading) % 360) + 540) % 360 - 180);
            hit = d <= 35;
          }
        }
        if (!hit) continue;
        out.push({ at: s.at, mode: s.kind || null, channel: s.channel, text: s.text, route: s });
      }
      return out.sort((a, b) => b.at - a.at);
    }

    // What your channel last said of the target near this track, if it is newer than NEPTUN's update and the
    // channel has written nothing of it since: { fate: 'down' | 'lost' | 'left', channel, at, text } or null.
    fateOf(t) {
      if (!this.routes) return null;
      const since = Date.parse(t.updatedAt || t.confirmedAt) || 0;
      let found = null;
      for (const x of this.near(t)) {
        const s = x.route;
        if (!s.fate || s.at <= since) continue;
        if (this.routes.lastOf(s.track) !== s) continue;
        const f = { fate: s.fate, channel: s.channel, at: s.at, text: s.text };
        if (s.fate === 'down') return f; // "мінус" in one channel beats "—" in another
        if (!found) found = f;
      }
      return found;
    }

    // A course from the words of the posts about the track: "Ракета з Харківщини курсом на Полтаву", "КАБ від
    // Вовчанська на Харків" — from the place or region named after "з", "від" towards the track. Degrees or null.
    courseFromText(t) {
      if (!this.routes || !this.project || !Number.isFinite(t.lat)) return null;
      const Routes = this.routes.constructor;
      const [x, y] = this.project(t.lat, t.lon);
      const here = { x, y };
      const texts = [t.title, t.explanationShort, ...this.mentions(t).map((m) => m.text)];
      for (const text of texts) {
        if (!text) continue;
        for (const line of String(text).split(/\n+/)) {
          const from = Routes.placesIn(line, this.routes.gaz).find((g) => g.role === 'from');
          if (!from) continue;
          const p = from.region ? from.center : this.routes.point(from, here, here);
          if (!p) continue;
          const km = Math.hypot(p.x - x, p.y - y) * this.kmPerUnit;
          if (km < 15 || km > 600) continue;
          return ((Math.atan2(x - p.x, p.y - y) * 180) / Math.PI + 360) % 360;
        }
      }
      return null;
    }

    // The channel route of a track: the latest sighting near it that has a route, as
    // { channel, at, heading, points: [{ name, at }] } (oldest first), or null.
    routeOf(t, maxAgeMs = 12 * 60000) {
      const s = this.near(t).find((x) => x.route.track && Date.now() - x.at <= maxAgeMs);
      if (!s) return null;
      // The track is matched by an older point of its way, but what it says now is its latest word: NEPTUN
      // lags behind the channel, which has already written "→Димине" while the match was "Червоновершка".
      let last = this.routes.lastOf(s.route.track) || s.route;
      // …unless that word is already about a point far ahead of this target (the track is another, faster one
      // that passed here: "Долинська → Компаніївка → Помічна"): then the word at this very point stands.
      if (last !== s.route && last.pos && this.project && Number.isFinite(t.lat)) {
        const [x, y] = this.project(t.lat, t.lon);
        if (Math.hypot(x - last.pos.x, y - last.pos.y) * this.kmPerUnit > FAR_WORD_KM) last = s.route;
      }
      const points = this.routes.route(s.route.track).filter((p, i, a) => !i || p.name !== a[i - 1].name);
      const to = last.to || (last.pos && last.pos.est ? last.pos.name : null);
      return { channel: last.channel, at: last.at, heading: last.heading, kind: last.kind, points, to };
    }

    changed() {
      this.version++;
      for (const fn of this.listeners) fn();
    }

    // Posts that name the track's place, newest first, from BEFORE_MS before its last update on.
    // And, of your own channels, the posts about targets near it (near()).
    mentions(t) {
      if (!t) return [];
      const since = (Date.parse(t.updatedAt || t.confirmedAt) || Date.now()) - BEFORE_MS;
      const named = t.locality && t.locality !== t.region ? (this.index.get(placeKey(t.locality)) || []).filter((x) => x.at >= since) : [];
      const geo = this.near(t);
      if (!geo.length) return named;
      const have = new Set(named.map((x) => `${x.channel.toLowerCase()}|${x.at}|${x.text}`));
      const more = geo.filter((x) => !have.has(`${x.channel.toLowerCase()}|${x.at}|${x.text}`));
      return [...named, ...more].sort((a, b) => b.at - a.at);
    }

    // Jet or plain from the Shahed posts naming the track's place: { mode, at, channel } or null.
    // A jet needs the Air Force or two channels: one channel alone often calls any fast-looking Shahed
    // "реактивний", and NEPTUN's own map then still shows an ordinary one — that is mode 'maybe'.
    about(t) {
      if (!t || t.type !== 'uav') return null;
      const list = this.mentions(t).filter((x) => x.mode === 'jet' || x.mode === 'plain');
      const jets = list.filter((x) => x.mode === 'jet');
      const channels = new Set(jets.map((x) => x.channel));
      const official = jets.find((x) => OFFICIAL.test(x.channel) || this.trusted.has(String(x.channel).toLowerCase()));
      if (official || channels.size >= 2) {
        const x = official || jets[0];
        return { mode: 'jet', at: x.at, channel: x.channel };
      }
      if (jets.length) return { mode: 'maybe', at: jets[0].at, channel: jets[0].channel };
      const plain = list[0];
      return plain ? { mode: 'plain', at: plain.at, channel: plain.channel } : null;
    }

    // Explosions of the last 40 minutes: [{ place, at, sources: [{ channel, at, text }] }], one per town;
    // find(keys) names the town a line speaks of (basemap.js), or null.
    booms(find, now = Date.now()) {
      const byPlace = new Map();
      for (const p of this.posts.values()) {
        if (now - p.at > BOOM_MS) continue;
        for (const line of p.lines) {
          if (!line.boom) continue;
          const place = find([...line.keys]);
          if (!place) continue;
          const e = byPlace.get(place) || { place, at: 0, sources: [] };
          e.at = Math.max(e.at, p.at);
          if (!e.sources.some((x) => x.channel === p.channel)) e.sources.push({ channel: p.channel, at: p.at, text: line.text });
          byPlace.set(place, e);
        }
      }
      for (const e of byPlace.values()) e.sources.sort((a, b) => b.at - a.at);
      return [...byPlace.values()];
    }

    // Up to n channels that wrote about this target lately: [{ channel, at, text }]. Posts that name the
    // target's own kind come first ("реактивний БпЛА на Звенигородку" before "→Звенигородка/р-н."), then the
    // newest. Lines about another kind of target (a KAB post for a Shahed) do not count.
    sources(t, kind = t && t.type, n = 3) {
      const fits = FITS[kind] || [null];
      const own = fits[0];
      const score = (x) => (x.mode === own ? 2 : x.mode ? 1 : 0);
      const best = new Map(); // channel -> its best line
      for (const x of this.mentions(t)) {
        if (!fits.includes(x.mode) || !x.channel) continue;
        const b = best.get(x.channel);
        if (!b || score(x) > score(b)) best.set(x.channel, x);
      }
      return [...best.values()]
        .sort((a, b) => score(b) - score(a) || b.at - a.at)
        .slice(0, n)
        .map((x) => ({ channel: x.channel, at: x.at, text: x.text }));
    }
  }

  Intel.placeKey = placeKey; // the same keys for town names (basemap.js)
  root.NeptunIntel = Intel;
  if (typeof module === 'object' && module.exports) module.exports = { Intel, stem, placeKey };
})(typeof self !== 'undefined' ? self : this);
