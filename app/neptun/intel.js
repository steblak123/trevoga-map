// Jet or not: NEPTUN's own map knows a jet Shahed by an internal subtype the open API does not send.
// The open API does publish the channel posts behind the tracks (GET /api/v1/messages, e.g.
// "1 Реактивний 🛵 на Кладьківку /Вересоч /Дрімайлівку"), so a Shahed track is called jet when the
// latest post that names its place says "реактивний", and plain when that post speaks of an ordinary
// Shahed. The feed is polled every 30 s (the API allows every 5 s) and kept for 45 minutes.
(function (root) {
  const URL = 'https://neptun.in.ua/api/v1/messages';
  const EVERY = 30000;
  const KEEP_MS = 45 * 60000;
  const BEFORE_MS = 20 * 60000; // a post may name a place up to this long before the track was last updated
  const JET = /реактивн/i;
  const NOT_JET = /не\s+реактивн/i;
  const PLAIN = /шахед|мопед|бпла|герань|гербер|дрон|🛵|🏍/i;
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
      this.posts = new Map(); // channel|date|text -> { at, lines: [{ mode, keys:Set }] }
      this.index = new Map(); // place key -> [{ at, mode }] newest first
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
        for (const line of m.text.split(/\n+/)) {
          if (JET.test(line) && !NOT_JET.test(line)) mode = 'jet';
          else if (PLAIN.test(line)) mode = 'plain';
          if (!mode) continue;
          const ws = words(line).map(stem);
          const keys = new Set(ws);
          for (let i = 0; i + 1 < ws.length; i++) keys.add(`${ws[i]} ${ws[i + 1]}`); // two-word places: "Біла Церква"
          lines.push({ mode, keys });
        }
        this.posts.set(key, { at, lines });
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
            this.index.get(k).push({ at: p.at, mode: line.mode });
          }
        }
      }
      for (const list of this.index.values()) list.sort((a, b) => b.at - a.at);
    }

    changed() {
      this.version++;
      for (const fn of this.listeners) fn();
    }

    // { mode: 'jet' | 'plain', at } from the newest post naming the track's place, or null.
    about(t) {
      if (!t || t.type !== 'uav' || !t.locality || t.locality === t.region) return null;
      const list = this.index.get(placeKey(t.locality));
      if (!list) return null;
      const since = (Date.parse(t.updatedAt || t.confirmedAt) || Date.now()) - BEFORE_MS;
      return list.find((x) => x.at >= since) || null;
    }
  }

  root.NeptunIntel = Intel;
  if (typeof module === 'object' && module.exports) module.exports = { Intel, stem, placeKey };
})(typeof self !== 'undefined' ? self : this);
