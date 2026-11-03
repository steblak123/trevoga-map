// Geographic helpers shared by the main process (require) and renderer pages (<script src>).
// No Node or DOM dependencies.
(function (root) {
  const RAD = Math.PI / 180;
  const EARTH_KM = 6371;

  // Ellipsoidal Lambert conformal conic (2 standard parallels, WGS84), Snyder 1987, eq. 15-1..15-10.
  // Matches the "+proj=lcc +datum=WGS84" projection build/make-map.js uses for map.json.
  function lcc({ lat1, lat2, lat0, lon0 }) {
    const a = 6378137;
    const e = Math.sqrt(0.00669437999014); // WGS84 first eccentricity
    const m = (phi) => Math.cos(phi) / Math.sqrt(1 - (e * Math.sin(phi)) ** 2);
    const t = (phi) => {
      const es = e * Math.sin(phi);
      return Math.tan(Math.PI / 4 - phi / 2) / ((1 - es) / (1 + es)) ** (e / 2);
    };
    const p1 = lat1 * RAD;
    const p2 = lat2 * RAD;
    const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
    const F = m(p1) / (n * t(p1) ** n);
    const rho0 = a * F * t(lat0 * RAD) ** n;
    return (lat, lon) => {
      const rho = a * F * t(lat * RAD) ** n;
      const theta = n * (lon - lon0) * RAD;
      return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
    };
  }

  // lat/lon -> map.json units (y down) for a map built by build/make-map.js.
  function mapProjector(proj) {
    const fwd = lcc(proj);
    return (lat, lon) => {
      const [x, y] = fwd(lat, lon);
      return [(x - proj.x0) * proj.k, (proj.y1 - y) * proj.k];
    };
  }

  // Point reached from lat/lon after `km` along the great circle with initial bearing `deg`.
  function dest(lat, lon, deg, km) {
    if (!(km > 0)) return [lat, lon];
    const d = km / EARTH_KM;
    const b = deg * RAD;
    const p1 = lat * RAD;
    const l1 = lon * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const dp = (lat2 - lat1) * RAD;
    const dl = (lon2 - lon1) * RAD;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // 0..360 -> "на північний схід".
  const COMPASS = ['північ', 'північний схід', 'схід', 'південний схід', 'південь', 'південний захід', 'захід', 'північний захід'];
  function compass(deg) {
    if (deg == null || !Number.isFinite(deg)) return '';
    return 'на ' + COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  // Rings of an SVG path from map.json ("M x y l dx dy … z", one M per ring) as [[x, y], …].
  function pathRings(d) {
    const rings = [];
    const re = /([Mlz])([^Mlz]*)/g;
    let ring = null;
    let x = 0;
    let y = 0;
    for (const [, cmd, args] of d.matchAll(re)) {
      if (cmd === 'z') {
        if (ring) rings.push(ring);
        ring = null;
        continue;
      }
      const v = args.trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i + 1 < v.length; i += 2) {
        if (cmd === 'M' && i === 0) {
          x = v[0];
          y = v[1];
          ring = [];
        } else {
          x += v[i];
          y += v[i + 1];
        }
        ring.push([x, y]);
      }
    }
    if (ring && ring.length) rings.push(ring);
    return rings;
  }

  // Even-odd point-in-polygon over all rings of a shape.
  function insideRings(rings, px, py) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i];
        const [xj, yj] = r[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  // Distance from a point to the nearest edge of the rings, in the same units.
  function ringsDistance(rings, px, py) {
    let best = Infinity;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ax, ay] = r[j];
        const [bx, by] = r[i];
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const u = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
        best = Math.min(best, Math.hypot(px - ax - u * dx, py - ay - u * dy));
      }
    }
    return best;
  }

  const api = { lcc, mapProjector, dest, distanceKm, compass, pathRings, insideRings, ringsDistance };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof self !== 'undefined' ? self : this);
