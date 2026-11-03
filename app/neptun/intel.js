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
      .replace(/є/g, 'е')
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
          lines.push({ mode, keys, text: line.length > 120 ? line.slice(0, 119) + '…' : line });
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

    // { mode: 'jet' | 'plain', at, channel } from the newest Shahed post naming the track's place, or null.
    about(t) {
      if (!t || t.type !== 'uav') return null;
      return this.mentions(t).find((x) => x.mode === 'jet' || x.mode === 'plain') || null;
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

  root.NeptunIntel = Intel;
  if (typeof module === 'object' && module.exports) module.exports = { Intel, stem, placeKey };
})(typeof self !== 'undefined' ? self : this);
