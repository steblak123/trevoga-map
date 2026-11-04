// Threat types of the NEPTUN API: labels, colours, icons and dead reckoning between updates.
(function (root) {
  const Geo = root.Geo;

  // SVG markup of the icons, pointing north (up) in a 24×24 box centred on 0,0.
  // Filled with currentColor; elements with class "s" are stroked instead.
  const path = (d) => `<path d="${d}"/>`;
  const ICONS = {
    // jet Shahed: sharper swept wing, wide nozzle and exhaust at the rear
    jet: path('M0-12C1-11.5 1.6-10 1.6-8.5V-3L9.5 6V8L1.6 6.4V8.5L3.4 10.6H-3.4L-1.6 8.5V6.4L-9.5 8V6L-1.6-3V-8.5C-1.6-10-1-11.5 0-12Z') +
      path('M-1.8 11.4 0 14.6 1.8 11.4Z'),
    // Shahed-type delta wing
    uav: path('M0-12C1-11.5 1.7-10 1.7-8.5V-4L10.5 5.5V8L1.7 5.6V9H-1.7V5.6L-10.5 8V5.5L-1.7-4V-8.5C-1.7-10-1-11.5 0-12Z'),
    // quadcopter
    fpv:
      '<path class="s" stroke-width="2.4" d="M-6-6 6 6M6-6-6 6"/>' +
      [[-6, -6], [6, -6], [-6, 6], [6, 6]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.8"/>`).join('') +
      '<rect x="-2.8" y="-2.8" width="5.6" height="5.6" rx="1.2"/>',
    // straight-wing reconnaissance drone
    recon: path('M-1.3-10h2.6v5.5H10v3H1.3V5h3.4v2.6h-9.4V5h3.4v-6.5H-10v-3h8.7Z'),
    // cruise missile
    missile: path('M0-12C1.2-11 1.6-9.4 1.6-7.5V-1L5.5 2.5V4L1.6 2.5V7L3.6 10v1.2l-2-.8h-3.2l-2 .8V10l2-3V2.5L-5.5 4V2.5L-1.6-1v-6.5C-1.6-9.4-1.2-11 0-12Z'),
    // ballistic missile
    ballistic: path('M0-12 3-6V5l3.5 5h-13L-3 5V-6Z'),
    // guided glide bomb
    kab: path('M0-11.5c2.3 0 3.2 3 3.2 6V4l3.3 4v2.5h-13V8l3.3-4v-9.5c0-3 .9-6 3.2-6Z'),
    // MiG-31K / aviation
    mig31k: path('M0-12 1.6-7v3.5l8.6 6.3V5L1.6 2.6V7l3.4 3v1.3L0 10.2-5 11.3V10l3.4-3V2.6L-10.2 5V2.8l8.6-6.3V-7Z'),
    unknown:
      '<circle class="s" r="8" stroke-width="2.2"/>' +
      '<text y="4.6" text-anchor="middle" font-size="13" font-weight="700" font-family="Segoe UI, sans-serif">?</text>',
  };

  // horizonMin / maxKm: how long and how far a track is moved along its course after the
  // last report (the same limits the NEPTUN map uses).
  const TYPES = {
    missile: { label: 'Крилаті ракети', short: 'Ракета', color: '#ff3b4f', severity: 3, horizonMin: 5, maxKm: 30 },
    ballistic: { label: 'Балістика', short: 'Балістика', color: '#e0458f', severity: 3, horizonMin: 1.5, maxKm: 20 },
    mig31k: { label: 'Авіація / МіГ-31К', short: 'МіГ-31К', color: '#9a7cff', severity: 3, horizonMin: 6, maxKm: 24 },
    jet: { label: 'Реактивні шахеди', short: 'Реактивний шахед', color: '#ff5a3c', severity: 3, horizonMin: 6, maxKm: 45 },
    uav: { label: 'Шахеди', short: 'Шахед', color: '#ff8a1f', severity: 2, horizonMin: 12, maxKm: 18 },
    kab: { label: 'Керовані авіабомби', short: 'КАБ', color: '#ff6a2b', severity: 2, horizonMin: 4, maxKm: 10 },
    fpv: { label: 'FPV-дрони', short: 'FPV', color: '#ffb020', severity: 2, horizonMin: 10, maxKm: 10 },
    recon: { label: 'Розвідувальні БпЛА', short: 'Розвідка', color: '#3fa9f5', severity: 1, horizonMin: 12, maxKm: 12 },
    unknown: { label: 'Невідомі цілі', short: 'Невідомо', color: '#8a96a8', severity: 1, horizonMin: 6, maxKm: 10 },
  };
  for (const [type, meta] of Object.entries(TYPES)) Object.assign(meta, { type, icon: ICONS[type] });

  const ORDER = Object.keys(TYPES).sort((a, b) => TYPES[b].severity - TYPES[a].severity);

  // Short names for the count tiles under the map.
  const TILE = { missile: 'Ракети', ballistic: 'Балістика', mig31k: 'Авіація', jet: 'Реактивні', uav: 'Шахеди', kab: 'КАБ', fpv: 'FPV', recon: 'Розвідники', unknown: 'Невідомі' };
  for (const [type, label] of Object.entries(TILE)) TYPES[type].tile = label;

  function typeMeta(type) {
    return TYPES[type] || TYPES.unknown;
  }

  // NEPTUN has one type "uav" for both kinds of Shahed. Its own map knows a jet one by subtype "jet",
  // which only its closed API sends. So, in this order: the subtype when it comes; "реактивний" in the
  // title or the short explanation; the channel posts about the track's place (intel.js, via setHint);
  // and, when no post names the place, a measured speed no ordinary Shahed reaches (it flies up to ~185 km/h).
  // An FPV is sometimes named only in the title.
  const JET = /реактивн|jet|герань-3|shahed-23|шахед-23/i;
  const NOT_JET = /не\s*реактивн/i;
  const FPV = /fpv|фпв/i;
  const JET_KMH = 300;
  let hint = null; // (track) -> 'jet' | 'plain' | null
  function setHint(fn) {
    hint = fn;
  }
  // A course for a track NEPTUN gives none: the way your channels say it went ("→Нова Прага" after
  // "Новий Стародуб"), degrees, or null (widget.js, from intel.js / routes.js).
  let course = null;
  function setCourse(fn) {
    course = fn;
  }
  const saysJet = (s) => !!s && JET.test(s) && !NOT_JET.test(s);
  // { kind, by }: by is what told a Shahed's kind: 'subtype' | 'text' | 'post' | 'speed', 'maybe' (one
  // channel says jet: still counted as ordinary, as on NEPTUN's map), or null when nothing did (then it is
  // taken for an ordinary one, as most are).
  function classify(t) {
    if (t.type === 'fpv' || (t.type === 'uav' && FPV.test(t.title || ''))) return { kind: 'fpv', by: null };
    if (t.type !== 'uav') return { kind: TYPES[t.type] ? t.type : 'unknown', by: null };
    if (t.subtype) return { kind: t.subtype === 'jet' ? 'jet' : 'uav', by: 'subtype' };
    if (saysJet(t.title) || saysJet(t.explanationShort)) return { kind: 'jet', by: 'text' };
    const h = hint ? hint(t) : null;
    const v = t.velocity && t.velocity.speedKmh;
    const fast = Number.isFinite(v) && v >= JET_KMH;
    if (h === 'jet') return { kind: 'jet', by: 'post' };
    if (h === 'maybe') return fast ? { kind: 'jet', by: 'speed' } : { kind: 'uav', by: 'maybe' };
    if (h) return { kind: 'uav', by: 'post' };
    if (fast) return { kind: 'jet', by: 'speed' };
    return { kind: 'uav', by: null };
  }
  const kindOf = (t) => classify(t).kind;

  // Current position of a track: moved along its velocity since confirmedAt, within the type's limits.
  function predict(t, now) {
    const v = t.velocity;
    const heading = t.heading != null && Number.isFinite(t.heading) ? t.heading : null;
    if (!t.areaOnly && v && Number.isFinite(v.speedKmh) && Number.isFinite(v.bearingDeg) && t.confirmedAt && t.status !== 'stale') {
      const meta = typeMeta(kindOf(t));
      const ageMin = (now - Date.parse(t.confirmedAt)) / 60000;
      if (ageMin > 0) {
        const km = Math.min(meta.maxKm, (v.speedKmh * Math.min(ageMin, meta.horizonMin)) / 60);
        const [lat, lon] = Geo.dest(t.lat, t.lon, v.bearingDeg, km);
        return { lat, lon, heading: v.bearingDeg, km, flying: ageMin <= meta.horizonMin && km > 0.05 };
      }
      return { lat: t.lat, lon: t.lon, heading: v.bearingDeg, km: 0, flying: true };
    }
    if (heading == null && course && !t.areaOnly) {
      const c = course(t);
      if (c != null) return { lat: t.lat, lon: t.lon, heading: c, km: 0, flying: false, byPosts: true };
    }
    return { lat: t.lat, lon: t.lon, heading, km: 0, flying: false };
  }

  root.NeptunTypes = { TYPES, ORDER, typeMeta, kindOf, classify, setHint, setCourse, predict };
})(self);
