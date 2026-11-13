// One target, several tracks. NEPTUN makes a track for every place the channels name: a jet written of as
// "на Долину / Хоростків", then "курсом на Хоростків", "на Копичинці", "на Чортків" stands on its map four times,
// "Яблуневе на Мрин" twice, and a cruise missile ("бандероль") over Світловодськ three times. Tracks of a
// "курсом на X" post stand at X, not where the target is, and live ~8 minutes after their one post, so every
// target is on the map once for each place it was reported to head for in the last minutes.
// Here the tracks of one target are found and all but the newest are hidden (their places stay as "the way so far"):
//
// 1. by the words of the posts (strong): a line that names the places of two tracks as one route or as
//    alternatives — "Яблуневе на Мрин", "від Біленьке в бік Василівки", "Мрин / Носівку", "Путивль > Дубов'язівка" —
//    is about one target. Lists ("Біленьке, Комишуваха", "Реактивний на Миролюбівку. ⏎ Реактивний на Біленьке")
//    and groups ("2х") are not.
// 2. by the way it flew (when no post puts two places together): a track that is no longer updated and a new one
//    that appeared within a few minutes and is not farther from it than the kind can fly in that time. Only when
//    it is clear: the pair is the nearest one for both of them and the next candidate is clearly worse, and the
//    course (when both have one) does not turn back. Of three jets circling over Zaporizhzhia none is taken for
//    another; a lone jet reported at Хоростків, Копичинці and Чортків in turn is one.
//
// What is decided about the second kind stays decided (links only go when a track goes or its old one is
// updated again after the new one appeared): a hidden track does not come back as the newer one is updated.
// Pure: tests/routes.test.js runs it.
(function (root) {
  const Intel = root.NeptunIntel || (typeof require === 'function' ? require('./intel').Intel : null);
  const stem = Intel && Intel.stem ? Intel.stem : (w) => String(w).toLowerCase();
  const placeKey = Intel && Intel.placeKey ? Intel.placeKey : (w) => String(w).toLowerCase();

  const RATE = { jet: 11, uav: 3.2, missile: 14 }; // km a minute, with slack
  const FAMILY = { jet: 'drone', uav: 'drone', missile: 'missile' };
  const SLACK_KM = 8; // the places of the posts are no exact points
  const DEST_SLACK_KM = 10; // …and a "курсом на X" track stands at X, ahead of the target
  const LINE_BEFORE_MS = 150000; // a line names two tracks' places: it was written this long before the first…
  const LINE_AFTER_MS = 90000; // …or this long after the last of them was updated
  const RETIRED_MS = 6 * 60000; // a new track follows one not updated for at most this long
  const GAP_MS = 15000; // the old one was last updated at least this long before the new one appeared (else both are of one post)
  const MAX_COST = 0.75; // of reach: a chain link more stretched than this is no clear one
  const CLEAR = 1.5; // the next candidate must cost this many times more (and 0.15 more) than the chosen one
  const SAME_POST_MS = 20000; // tracks updated within this of each other are of one post (alternatives)
  const SAME_KM = 160; // places of one line are no farther apart than this (a namesake)
  const GROUP_MAX = 20; // a group of tracks is at most this many (a long flight is reported at ten places in eight minutes)
  const NAMED_MAX = 6; // a line names at most this many places of tracks
  const SEQ_MIN_MS = 10000; // a channel writes of one target one place after another: this soon after each other, not sooner…
  const SEQ_MAX_MS = 5 * 60000; // …and not later
  const SEQ_NEW = /(?:^|[\s(])(?:ще|інший|інша|інше|другий|другого|друга|другу|новий|нова|нові|нового|також|за ним|окремо)(?![а-яіїєґ])/i; // another one, not the same
  const CROSS_KM = 20; // a Shahed that nothing called a Shahed, of the same place as a missile, this near it…
  const CROSS_MS = 5 * 60000; // …and reported this soon after (or before) it is that missile

  // The words that may stand between the two places of one target: "Яблуневе [на] Мрин", "від Біленьке [в бік]
  // Василівки", "повз Іваницю на Ряшки".
  const BETWEEN = new Set(['на', 'в', 'у', 'бік', 'сторону', 'напрямку', 'напрямі', 'до', 'від', 'з', 'із', 'зі', 'через', 'повз', 'курсом', 'курс', 'далі', 'над', 'біля', 'коло', 'летить', 'йде', 'пішов', 'пішла', 'рухається', 'прямує', 'заходить', 'повертає', 'повертається', 'розвертається', 'розвернувся', 'відвернув', 'вже', 'тепер', 'потім', 'знову', 'спершу']);
  const ALT_WORDS = new Set(['або', 'чи']);
  const WORD = /[A-Za-zА-Яа-яІіЇїЄєҐґ'’ʼ-]+/g;
  // A line about more than one target ("ці 2 реактивні стандартно Корюківка - Мена - Борзна", "2х на Ніжин") puts no places together.
  const MANY = /(?:^|[^\d])(?:[2-9]|1\d)\s*(?:х|x|шт|реактив|бпла|шахед|ціл|гер)|(?:^|\s)(?:два|дві|три|чотири|обидва|обидві|двоє|група|групи|кілька|декілька)(?![а-яіїєґ])/i;

  // [{ k: stem, s, e }] of the words of a line (those a place key is made of: three letters and more).
  function tokens(raw) {
    const out = [];
    for (const m of String(raw).matchAll(WORD)) {
      const w = m[0].replace(/^[-'’ʼ]+|[-'’ʼ]+$/g, '');
      if (w.replace(/[-'’ʼ]/g, '').length < 3) continue;
      const s = m.index + m[0].indexOf(w);
      out.push({ k: stem(w), s, e: s + w.length });
    }
    return out;
  }

  // Where the place of a key stands in the tokens: { s, e } of its first occurrence, or null.
  function spanOf(toks, key) {
    const parts = key.split(' ');
    for (let i = 0; i + parts.length <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < parts.length; j++) if (toks[i + j].k !== parts[j]) ok = false;
      if (ok) return { s: toks[i].s, e: toks[i + parts.length - 1].e, i, n: parts.length };
    }
    return null;
  }

  // How a line puts two places together: 'alt' ("Мрин / Носівку", "Біленьке або Комишуваха"), 'route' ("Яблуневе на
  // Мрин", "від Біленьке в бік Василівки", "Путивль > Дубов'язівка") or null (a list, another sentence).
  // order: 1 when keyA stands before keyB in the line, else -1.
  function relation(raw, keyA, keyB) {
    if (MANY.test(raw)) return null;
    const toks = tokens(raw);
    const a = spanOf(toks, keyA);
    const b = spanOf(toks, keyB);
    if (!a || !b || a.i === b.i) return null;
    const first = a.s < b.s ? a : b;
    const second = first === a ? b : a;
    if (second.i < first.i + first.n) return null; // one name inside the other
    const between = raw.slice(first.e, second.s).toLowerCase();
    if (/[,;+&?]/.test(between)) return null; // a list
    // "і далі на": the "і" joins nothing here
    const words = (between.match(WORD) || []).filter((w) => w.replace(/-/g, '') !== '');
    for (let i = 0; i < words.length; i++) if (words[i] === 'і' && words[i + 1] === 'далі') words.splice(i, 1);
    if (words.some((w) => !BETWEEN.has(w) && !ALT_WORDS.has(w))) return null;
    const marks = between.replace(WORD, ' ');
    const dash = /(?:^|\s)[-–—](?:\s|$)/.test(between);
    // "на Славгород з Запоріжжя": the second place is where it came from
    const fromSecond = /(?:^|\s)(?:з|із|зі|від)\s*$/.test(between);
    const order = (second === b ? 1 : -1) * (fromSecond ? -1 : 1);
    if (/[/|\\]/.test(marks) || words.some((w) => ALT_WORDS.has(w))) return { type: 'alt', order };
    if (/[→>➡]/.test(marks) || dash || words.length) return { type: 'route', order };
    return null;
  }

  // The tracks of the same target as a sequence of those that fit it: an object that is told about from posts;
  // `update(tracks, ctx)` is called at every change of the data.
  class Fuser {
    constructor() {
      this.seen = new Map(); // id -> { at, lat, lon, initial }: the first update of a track as it was seen
      this.links = new Map(); // old id -> { to, kind: 'chain', at }: decided by the way it flew (kept)
      this.primed = false; // the tracks seen first are of unknown age
      this.words = new Map(); // 'a>b' -> { a, b, type }: what the posts said of two tracks stays said while both live
    }

    // tracks: [{ id, lat, lon, at, kind, proven, count, dest, heading, key, loc }] (kind: 'jet' | 'uav' | 'missile' | …).
    // ctx: { distanceKm(a, b), bearing(a, b), lines: [{ at, channel, mode, keys, raw }], base(t) -> km to your point or 0 }
    update(tracks, ctx) {
      const ids = new Set(tracks.map((t) => t.id));
      const first = !this.primed && tracks.length > 0;
      if (tracks.length) this.primed = true;
      for (const t of tracks) {
        if (!this.seen.has(t.id)) this.seen.set(t.id, { at: Math.min(t.at, t.born || t.at), lat: t.lat, lon: t.lon, initial: first });
      }
      for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id);
      const byId = new Map(tracks.map((t) => [t.id, t]));
      for (const [from, l] of [...this.links]) {
        const a = byId.get(from);
        const b = byId.get(l.to);
        const born = this.seen.get(l.to);
        // gone, or the old one was updated well after the new one appeared: it flies on by itself
        if (!a || !b || (born && a.at > born.at + 90000)) this.links.delete(from);
      }
      const fits = (t) => FAMILY[t.kind] && !(t.count > 1) && !!t.key; // a track with no place of its own has no way to tell
      const pool = tracks.filter(fits);
      // a Shahed nothing has called a Shahed (NEPTUN's default kind): it may be a missile the posts did not name
      const weak = (t) => t.kind === 'uav' && !t.proven && !(t.count > 1);
      const same = (x, y) => FAMILY[x.kind] === FAMILY[y.kind] || (weak(x) && y.kind === 'missile') || (weak(y) && x.kind === 'missile');

      // ---- 1. the words of the posts
      const edges = []; // { a, b (a is the earlier place of the route), type }
      const lines = (ctx.lines || []).filter((l) => l.keys.size > 1);
      const withKey = pool.filter((t) => t.key);
      for (const line of lines) {
        const named = withKey.filter((t) => line.keys.has(t.key));
        if (named.length < 2 || named.length > NAMED_MAX) continue;
        for (let i = 0; i < named.length; i++) {
          for (let j = i + 1; j < named.length; j++) {
            const x = named[i];
            const y = named[j];
            if (x.key === y.key || !same(x, y)) continue;
            // a line that names a kind is about tracks of that kind (a Shahed nothing called one may be any)
            const lf = line.mode ? FAMILY[line.mode === 'plain' ? 'uav' : line.mode] : null;
            if (line.mode && ![x, y].some((t) => !weak(t) && FAMILY[t.kind] === lf) && ![x, y].every(weak)) continue;
            const fx = this.seen.get(x.id) || { at: x.at };
            const fy = this.seen.get(y.id) || { at: y.at };
            const lo = Math.min(fx.at, fy.at) - LINE_BEFORE_MS;
            const hi = Math.max(x.at, y.at) + LINE_AFTER_MS;
            if (line.at < lo || line.at > hi) continue;
            if (ctx.distanceKm(x, y) > SAME_KM) continue;
            const rel = relation(line.raw, x.key, y.key);
            if (!rel) continue;
            // x is the earlier place when the line says "x на y" (order 1)
            const e = rel.order > 0 ? { a: x, b: y, type: rel.type, line } : { a: y, b: x, type: rel.type, line };
            edges.push(e);
            if (ctx.log) ctx.log({ type: rel.type, a: e.a, b: e.b, line });
          }
        }
      }

      // what a post said stays said (its line goes out of the window long before the tracks do)
      for (const e of edges) this.words.set(`${e.a.id}>${e.b.id}`, { a: e.a.id, b: e.b.id, type: e.type });
      for (const [k, w] of [...this.words]) {
        if (!byId.has(w.a) || !byId.has(w.b)) this.words.delete(k);
      }
      const spoken = [...this.words.values()].map((w) => ({ a: byId.get(w.a), b: byId.get(w.b), type: w.type }));

      // ---- 1a. one channel, one target, one place after another: "реактивний далі на Седнів", a minute later
      // "реактивний далі на Вересоч", then "…на Ядути". Only posts that are about one target (they name the places of
      // one track, or of tracks the line puts together), that do not say "another", one after the other within a few
      // minutes, no post about other targets between them, and the flight is as far as the kind can go.
      const bysPost = new Map(); // channel|at -> { channel, at, lines, tracks: Set of ids }
      const keyCount = new Map();
      for (const t of withKey) keyCount.set(t.key, (keyCount.get(t.key) || 0) + 1);
      for (const line of ctx.lines || []) {
        const k = `${line.channel}|${line.at}`;
        if (!bysPost.has(k)) bysPost.set(k, { channel: line.channel, at: line.at, lines: [], tracks: new Map(), many: false });
        const post = bysPost.get(k);
        post.lines.push(line);
        if (SEQ_NEW.test(line.raw) || MANY.test(line.raw)) post.many = true;
        for (const t of withKey) {
          if (!line.keys.has(t.key)) continue;
          if (line.mode && FAMILY[line.mode === 'plain' ? 'uav' : line.mode] !== FAMILY[t.kind] && !weak(t)) continue;
          if (keyCount.get(t.key) > 1) post.many = true; // a namesake: which one?
          post.tracks.set(t.id, t);
        }
      }
      const seqCand = [];
      const byChannel = new Map();
      for (const post of bysPost.values()) {
        if (!post.tracks.size) continue;
        if (!byChannel.has(post.channel)) byChannel.set(post.channel, []);
        byChannel.get(post.channel).push(post);
      }
      for (const posts of byChannel.values()) {
        posts.sort((x, y) => x.at - y.at);
        // one target? the tracks of a post are one when the lines of it put them together
        const single = (post) => {
          if (post.many) return false;
          const ids = [...post.tracks.keys()];
          if (ids.length === 1) return true;
          const par = new Map(ids.map((i) => [i, i]));
          const f = (i) => (par.get(i) === i ? i : f(par.get(i)));
          for (const e of edges) if (e.line.channel === post.channel && e.line.at === post.at && par.has(e.a.id) && par.has(e.b.id)) par.set(f(e.a.id), f(e.b.id));
          return new Set(ids.map(f)).size === 1;
        };
        for (let i = 0; i + 1 < posts.length; i++) {
          const p1 = posts[i];
          const p2 = posts[i + 1];
          const dt = p2.at - p1.at;
          if (dt < SEQ_MIN_MS || dt > SEQ_MAX_MS || !single(p1) || !single(p2)) continue;
          for (const a of p1.tracks.values()) {
            for (const b of p2.tracks.values()) {
              if (a.id === b.id || a.key === b.key || !same(a, b) || p2.tracks.has(a.id) || p1.tracks.has(b.id)) continue;
              // each track is of the post that updated it last (an older decision stays, see below)
              if (a.at < p1.at - 60000 || a.at > p1.at + 150000 || b.at < p2.at - 60000 || b.at > p2.at + 150000 || a.at > b.at + 30000) continue;
              const rate = Math.max(RATE[a.kind] || 0, RATE[b.kind] || 0);
              const reach = (rate * Math.max(dt, 90000)) / 60000 + SLACK_KM + (a.dest ? DEST_SLACK_KM : 0) + (b.dest ? DEST_SLACK_KM : 0);
              const d = ctx.distanceKm(a, b);
              if (d <= reach) seqCand.push({ a, b, cost: d / reach, p1, p2 });
            }
          }
        }
      }

      // ---- 1b. a Shahed nothing has called a Shahed at the same place as a missile is that missile:
      // "1 крилата ракета на Світловодськ" and "Над водою, летить в бік Світловодська" are one target
      const cross = [];
      for (const m of tracks.filter((t) => t.kind === 'missile' && !(t.count > 1))) {
        for (const u of tracks.filter(weak)) {
          if (u.key && u.key === m.key && Math.abs(u.at - m.at) <= CROSS_MS && ctx.distanceKm(u, m) <= CROSS_KM) cross.push({ a: u, b: m });
        }
      }

      // ---- 2. the way it flew
      const out = new Set([...this.links.keys()]); // already have a newer one
      for (const e of spoken) if (e.type !== 'alt') out.add(e.a.id);
      const into = new Set([...this.links.values()].map((l) => l.to));
      // sequences of one channel: decided now, kept (like the flights below)
      seqCand.sort((x, y) => x.cost - y.cost);
      for (const c of seqCand) {
        if (out.has(c.a.id) || into.has(c.b.id)) continue;
        out.add(c.a.id);
        into.add(c.b.id);
        this.links.set(c.a.id, { to: c.b.id, kind: 'seq', at: ctx.now || 0 });
        if (ctx.log) ctx.log({ type: 'seq', a: c.a, b: c.b, line: c.p2.lines[0], p1: c.p1, p2: c.p2 });
      }
      // a post that says "інший", "ще 1", "другий" about a track's place: that track is another target, not the next place
      // of the one before
      const another = (b, born) => (ctx.lines || []).some((l) => l.keys.has(b.key) && SEQ_NEW.test(l.raw) && l.at >= born.at - 90000 && l.at <= born.at + 60000);
      const cand = [];
      for (const b of pool) {
        const born = this.seen.get(b.id);
        if (!born || born.initial) continue; // how old it is, nobody knows
        if (another(b, born)) continue;
        for (const a of pool) {
          if (a.id === b.id || FAMILY[a.kind] !== FAMILY[b.kind] || out.has(a.id) || a.at > born.at - GAP_MS || a.at < born.at - RETIRED_MS) continue;
          if (into.has(b.id) || spoken.some((e) => e.type !== 'alt' && ((e.b.id === b.id && e.a.id !== a.id) || (e.a.id === a.id && e.b.id === b.id)))) continue;
          const dt = (born.at - a.at) / 60000;
          const rate = Math.max(RATE[a.kind] || 0, RATE[b.kind] || 0);
          const reach = rate * dt + SLACK_KM + (a.dest ? DEST_SLACK_KM : 0) + (b.dest ? DEST_SLACK_KM : 0);
          const d = ctx.distanceKm(a, { lat: born.lat, lon: born.lon });
          if (d > reach) continue;
          let cost = d / reach;
          if (Number.isFinite(a.heading) && Number.isFinite(b.heading) && d >= 5) {
            const turn = Math.abs((((a.heading - b.heading) % 360) + 540) % 360 - 180);
            if (turn > 100) continue; // turned back: another one
            cost *= 1 + turn / 180;
          }
          if (cost > MAX_COST) continue;
          cand.push({ a, b, cost });
        }
      }
      const next = (list, pair, side) => {
        let best = Infinity;
        for (const c of list) if (c !== pair && c[side].id === pair[side].id) best = Math.min(best, c.cost);
        return best;
      };
      cand.sort((x, y) => x.cost - y.cost);
      const usedA = new Set();
      const usedB = new Set();
      for (const c of cand) {
        if (usedA.has(c.a.id) || usedB.has(c.b.id)) continue;
        const other = Math.min(next(cand, c, 'a'), next(cand, c, 'b'));
        if (other < Math.max(c.cost * CLEAR, c.cost + 0.15)) continue; // not clear
        usedA.add(c.a.id);
        usedB.add(c.b.id);
        this.links.set(c.a.id, { to: c.b.id, kind: 'chain', at: ctx.now || 0 });
        if (ctx.log) ctx.log({ type: 'chain', a: c.a, b: c.b, cost: c.cost, other, km: ctx.distanceKm(c.a, this.seen.get(c.b.id)), dt: (this.seen.get(c.b.id).at - c.a.at) / 60000 });
      }

      // ---- groups
      const parent = new Map(tracks.map((t) => [t.id, t.id]));
      const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
      const union = (aId, bId) => {
        const ra = find(aId);
        const rb = find(bId);
        if (ra !== rb) parent.set(ra, rb);
      };
      const altIds = new Set();
      const followed = new Set(); // has a later place (a route or a chain goes on from it)
      for (const e of spoken) {
        union(e.a.id, e.b.id);
        if (e.type === 'alt') altIds.add(e.a.id).add(e.b.id);
        else followed.add(e.a.id);
      }
      for (const [from, l] of this.links) {
        if (!byId.has(from) || !byId.has(l.to)) continue;
        union(from, l.to);
        followed.add(from);
      }
      for (const c of cross) {
        union(c.a.id, c.b.id);
        followed.add(c.a.id);
      }
      const groups = new Map();
      for (const t of tracks) {
        const r = find(t.id);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(t);
      }
      const hidden = new Set();
      const of = new Map(); // survivor id -> [the tracks it stands for, newest first]
      const alts = new Map(); // survivor id -> [the places it may be at instead]
      const base = ctx.base || (() => 0);
      for (const g of groups.values()) {
        if (g.length < 2 || g.length > GROUP_MAX) continue;
        // the survivor: the newest — those within 20 s of the latest count as one time, then the one nothing
        // follows, then the one nearest to you (of "Мрин / Носівку" the worse case)
        const sure = g.some((t) => !weak(t)) ? g.filter((t) => !weak(t)) : g; // not a Shahed nothing called one
        const latest = Math.max(...sure.map((t) => t.at));
        const top = sure
          .filter((t) => t.at >= latest - SAME_POST_MS)
          .sort((a, b) => followed.has(a.id) - followed.has(b.id) || base(a) - base(b) || b.at - a.at)[0];
        const rest = g.filter((t) => t !== top && ctx.distanceKm(t, top) <= SAME_KM);
        if (!rest.length) continue;
        for (const t of rest) hidden.add(t.id);
        of.set(top.id, rest.sort((a, b) => b.at - a.at));
        const alt = rest.filter((t) => altIds.has(t.id) && Math.abs(t.at - top.at) <= SAME_POST_MS);
        if (alt.length) alts.set(top.id, alt);
      }
      return { hidden, of, alts };
    }
  }

  root.NeptunFuse = Fuser;
  Fuser.relation = relation;
  if (typeof module === 'object' && module.exports) module.exports = { Fuser, relation };
})(typeof self !== 'undefined' ? self : this);
