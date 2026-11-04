// The channel posts behind the tracks (GET /api/v1/messages, e.g. "1 Реактивний 🛵 на Кладьківку /Вересоч"):
// - jet or not: NEPTUN's own map knows a jet Shahed by an internal subtype the open API does not send, so a
//   Shahed track is called jet when the latest post that names its place says "реактивний", and plain when
//   that post speaks of an ordinary Shahed;
// - sources: which channels wrote about the track's place lately, with the time and the line.
// The feed is polled every 30 s (the API allows every 5 s) and kept for 45 minutes.
(function (root) {
  const URL = 'https://neptun.in.ua/api/v1/messages';
  const EVERY = 30000;
  const KEEP_MS = 45 * 60000;
  const BEFORE_MS = 20 * 60000; // a post may name a place up to this long before the track was last updated
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
      this.trusted = new Set(); // your own channels ('@name'): one of them is enough for a jet
      this.version = 0;
    }

    onUpdate(fn) {
      this.listeners.add(fn);
    }

    start() {
      if (this.timer) return;
      this.poll();
      this.timer = setInterval(() => this.poll(), EVERY);
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
    addExternal(posts) {
      if (this.add(posts)) this.changed();
    }

    changed() {
      this.version++;
      for (const fn of this.listeners) fn();
    }

    // Posts that name the track's place, newest first, from BEFORE_MS before its last update on.
    mentions(t) {
      if (!t || !t.locality || t.locality === t.region) return [];
      const list = this.index.get(placeKey(t.locality));
      if (!list) return [];
      const since = (Date.parse(t.updatedAt || t.confirmedAt) || Date.now()) - BEFORE_MS;
      return list.filter((x) => x.at >= since);
    }

    // Jet or plain from the Shahed posts naming the track's place: { mode, at, channel } or null.
    // A jet needs the Air Force or two channels: one channel alone often calls any fast-looking Shahed
    // "реактивний", and NEPTUN's own map then still shows an ordinary one — that is mode 'maybe'.
    about(t) {
      if (!t || t.type !== 'uav') return null;
      const list = this.mentions(t).filter((x) => x.mode === 'jet' || x.mode === 'plain');
      const jets = list.filter((x) => x.mode === 'jet');
      const channels = new Set(jets.map((x) => x.channel));
      const official = jets.find((x) => OFFICIAL.test(x.channel) || this.trusted.has(x.channel));
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
