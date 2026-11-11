// One target, several tracks. NEPTUN puts a track at every place the channels name, so a jet that is written of
// as "на Долину / Хоростків", then "курсом на Хоростків", "на Копичинці", "на Чортків" stands on the map four
// times, and a cruise missile ("бандероль") over Світловодськ three times, once as a missile and twice as a
// Shahed. Tracks are taken for one target when a newer one could be the older one flown on:
// - the same family (Shahed and jet Shahed; missile), one target each, the newer updated 20 s – 8 min after the
//   older and not farther from it than that kind flies in that time (+10 km);
// - the newer one appeared when the older had stopped being updated (within 90 s): of two jets on the same
//   route a few minutes apart both tracks go on living, and they stay two;
// - or a Shahed nothing has named a Shahed (NEPTUN's default kind) stands within 20 km and 5 min of a missile.
// The newest one stays (the missile, of a missile and a Shahed); the others are its way so far.
// Pure: tests/routes.test.js runs it. tracks: [{ id, lat, lon, at, born, kind, proven, fast, count }].
(function (root) {
  const WINDOW_MS = 8 * 60000;
  const MIN_GAP_MS = 20000;
  const BORN_SLACK_MS = 90000;
  const SLACK_KM = 10;
  const KM_PER_MIN = { missile: 15, jet: 12, uav: 3.5 };
  const CROSS_KM = 20;
  const CROSS_MS = 5 * 60000;
  const family = (k) => (k === 'jet' || k === 'uav' ? 'drone' : k);

  // -> { hidden: Set of ids, of: Map id -> [the tracks it stands for, newest first] }
  function fuse(tracks, distanceKm) {
    const hidden = new Set();
    const of = new Map();
    const take = (n, o) => {
      hidden.add(o.id);
      const list = of.get(n.id) || [];
      list.push(o, ...(of.get(o.id) || []));
      list.sort((a, b) => b.at - a.at);
      of.set(n.id, list);
      of.delete(o.id);
    };
    const kept = [];
    for (const o of tracks.slice().sort((a, b) => b.at - a.at)) {
      if (!KM_PER_MIN[o.kind] || o.count > 1) {
        kept.push(o);
        continue;
      }
      // a missile: the unproven Shaheds next to it are it
      if (o.kind === 'missile') {
        for (let i = kept.length - 1; i >= 0; i--) {
          const n = kept[i];
          if (n.kind !== 'uav' || n.proven || n.count > 1 || n.at - o.at > CROSS_MS || distanceKm(n, o) > CROSS_KM) continue;
          kept.splice(i, 1);
          take(o, n);
        }
      }
      const n = kept.find((n) => {
        if (n.count > 1 || !KM_PER_MIN[n.kind]) return false;
        const dt = n.at - o.at;
        const km = distanceKm(n, o);
        if (family(n.kind) !== family(o.kind)) return n.kind === 'missile' && o.kind === 'uav' && !o.proven && dt <= CROSS_MS && km <= CROSS_KM;
        if (dt < MIN_GAP_MS || dt > WINDOW_MS || n.born < o.at - BORN_SLACK_MS) return false;
        const rate = Math.max(KM_PER_MIN[n.kind], KM_PER_MIN[o.kind], n.fast || o.fast ? KM_PER_MIN.jet : 0);
        return km <= SLACK_KM + (rate * dt) / 60000;
      });
      if (n) take(n, o);
      else kept.push(o);
    }
    return { hidden, of };
  }

  root.NeptunFuse = fuse;
  if (typeof module === 'object' && module.exports) module.exports = { fuse };
})(typeof self !== 'undefined' ? self : this);
