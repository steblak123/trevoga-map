// Shared region data and helpers. Loaded by the main process (require) and by
// renderer pages (<script src>), so it must not depend on Node or the DOM.
(function (root) {
  // Oblasts and special-status cities, UIDs per devs.alerts.in.ua "Location UID".
  const OBLASTS = [
    { uid: 29, name: 'Автономна Республіка Крим' },
    { uid: 8, name: 'Волинська область' },
    { uid: 4, name: 'Вінницька область' },
    { uid: 9, name: 'Дніпропетровська область' },
    { uid: 28, name: 'Донецька область' },
    { uid: 10, name: 'Житомирська область' },
    { uid: 11, name: 'Закарпатська область' },
    { uid: 12, name: 'Запорізька область' },
    { uid: 13, name: 'Івано-Франківська область' },
    { uid: 31, name: 'м. Київ', city: true },
    { uid: 14, name: 'Київська область' },
    { uid: 15, name: 'Кіровоградська область' },
    { uid: 16, name: 'Луганська область' },
    { uid: 27, name: 'Львівська область' },
    { uid: 17, name: 'Миколаївська область' },
    { uid: 18, name: 'Одеська область' },
    { uid: 19, name: 'Полтавська область' },
    { uid: 5, name: 'Рівненська область' },
    { uid: 30, name: 'м. Севастополь', city: true },
    { uid: 20, name: 'Сумська область' },
    { uid: 21, name: 'Тернопільська область' },
    { uid: 22, name: 'Харківська область' },
    { uid: 23, name: 'Херсонська область' },
    { uid: 3, name: 'Хмельницька область' },
    { uid: 24, name: 'Черкаська область' },
    { uid: 26, name: 'Чернівецька область' },
    { uid: 25, name: 'Чернігівська область' },
  ];

  // Raion UID ranges -> oblast UID (raion UIDs come from alerts.in.ua districts.svg).
  const RAION_RANGES = [
    [32, 37, 4], [38, 41, 8], [42, 48, 9], [49, 56, 28], [57, 60, 10],
    [61, 66, 11], [67, 72, 13], [73, 79, 14], [80, 83, 15], [84, 87, 16],
    [88, 94, 27], [95, 98, 17], [99, 105, 18], [106, 109, 19], [110, 113, 5],
    [114, 118, 20], [119, 121, 21], [122, 128, 22], [129, 133, 23], [134, 136, 3],
    [137, 139, 26], [140, 144, 25], [145, 149, 12], [150, 153, 24],
    [1801, 1804, 16], [1805, 1814, 29],
  ];

  const OBLAST_BY_UID = Object.fromEntries(OBLASTS.map((o) => [o.uid, o]));
  const OBLAST_BY_NAME = Object.fromEntries(OBLASTS.map((o) => [o.name, o]));

  function oblastOf(uid) {
    uid = Number(uid);
    if (OBLAST_BY_UID[uid]) return uid;
    for (const [a, b, o] of RAION_RANGES) if (uid >= a && uid <= b) return o;
    return null;
  }

  function isRaion(uid) {
    return !OBLAST_BY_UID[Number(uid)] && oblastOf(uid) != null;
  }

  // Effective status of a location from the IoT string: 'A' full alert, 'P' partial, 'N' none.
  // A raion is under alert when the raion itself or its whole oblast is.
  function statusOf(iot, uid) {
    if (!iot) return 'N';
    uid = Number(uid);
    const own = iot[uid] || 'N';
    if (!isRaion(uid)) return own === 'A' || own === 'P' ? own : 'N';
    const ob = iot[oblastOf(uid)] || 'N';
    if (own === 'A' || ob === 'A') return 'A';
    if (own === 'P') return 'P';
    return 'N';
  }

  // Active alerts (from /v1/alerts/active.json) that cover a location.
  // Hromada alerts carry their own UID in location_oblast_uid, so they are
  // matched to a raion by raion + oblast name instead.
  function alertsFor(alerts, uid, raionName) {
    if (!alerts) return [];
    uid = Number(uid);
    const ob = oblastOf(uid);
    const obName = OBLAST_BY_UID[ob] ? OBLAST_BY_UID[ob].name : null;
    return alerts.filter((a) => {
      const loc = Number(a.location_uid);
      if (a.location_type === 'raion' || a.location_type === 'oblast') {
        if (loc === uid) return true;
        return a.location_type === 'oblast' && loc === ob && ob !== uid;
      }
      if (loc === uid) return true;
      return !!raionName && a.location_raion === raionName && (!a.location_oblast || a.location_oblast === obName);
    });
  }

  // Start time (ms) of the air-raid alert covering the whole raion / oblast / city.
  function alertSince(alerts, uid, raionName) {
    const list = alertsFor(alerts, uid, raionName).filter((a) => a.alert_type === 'air_raid');
    const whole = list.filter((a) => a.location_type === 'raion' || a.location_type === 'oblast' || Number(a.location_uid) === Number(uid));
    const times = (whole.length ? whole : list).map((a) => Date.parse(a.started_at)).filter(Boolean);
    return times.length ? Math.max(...times) : null;
  }

  // Hromadas / cities inside a raion that have their own air-raid alert.
  function partialPlaces(alerts, uid, raionName) {
    const titles = alertsFor(alerts, uid, raionName)
      .filter((a) => a.alert_type === 'air_raid' && (a.location_type === 'hromada' || a.location_type === 'city'))
      .map((a) => a.location_title.replace(' територіальна громада', ' громада'));
    return [...new Set(titles)];
  }

  const ALERT_TYPES = {
    air_raid: 'Повітряна тривога',
    artillery_shelling: 'Загроза артобстрілу',
    urban_fights: 'Загроза вуличних боїв',
    chemical: 'Хімічна загроза',
    nuclear: 'Радіаційна загроза',
  };

  const THREAT_TYPES = {
    tactic_aircraft_activity: 'Тактична авіація',
    strategic_aircraft_activity: 'Стратегічна авіація',
    mig31k_departure: 'Зліт МіГ-31К',
    ballistic_missiles: 'Балістичні ракети',
    cruise_missiles: 'Крилаті ракети',
    unspecified_missiles: 'Ракетна загроза',
    drones: 'Ударні БпЛА',
    guided_aerial_bombs: 'КАБи',
    air_defense: 'Робота ППО',
    unknown: 'Невідома загроза',
  };

  function formatDuration(ms) {
    if (!(ms > 0)) return '';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d >= 2) return `${d} дн.`;
    if (h > 0) return `${h} год ${m % 60} хв`;
    return `${m} хв`;
  }

  function shortName(name) {
    return String(name).replace(' район', ' р-н').replace(' область', ' обл.');
  }

  const api = {
    OBLASTS, RAION_RANGES, OBLAST_BY_UID, OBLAST_BY_NAME,
    oblastOf, isRaion, statusOf, alertsFor, alertSince, partialPlaces,
    ALERT_TYPES, THREAT_TYPES, formatDuration, shortName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Regions = api;
})(this);
