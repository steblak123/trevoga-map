// Builds app/assets/map.json from OCHA / HDX administrative boundaries of Ukraine
// (COD-AB, CC BY-IGO): https://data.humdata.org/dataset/cod-ab-ukr
//
// Usage: download ukr_admin_boundaries.geojson.zip from the page above, unzip it, then
//   node build/make-map.js <path-to/ukr_admin2.geojson>
const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');
const Regions = require('../app/regions');

const WIDTH = 1000; // output coordinate width
const SIMPLIFY = '3%';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node build/make-map.js <ukr_admin2.geojson>');
  process.exit(1);
}

const norm = (s) => String(s).replace(/[’ʼ`]/g, "'").trim();
const uidByName = {};
for (const [uid, name] of Object.entries(require('./raion-uids.json'))) uidByName[norm(name)] = Number(uid);

// OCHA units that are not separate alert areas.
const EXTRA = {
  UA3200: 'Вишгородський район', // Chornobyl exclusion zone: alerts are announced with Vyshhorod raion
  UA8000: 31, // м. Київ
  UA8500: 30, // м. Севастополь
};

const src = JSON.parse(fs.readFileSync(input, 'utf8'));
const features = [];
for (const f of src.features) {
  const p = f.properties;
  let uid = EXTRA[p.adm2_pcode];
  if (typeof uid === 'string') uid = uidByName[norm(uid)];
  if (uid == null) uid = uidByName[norm(p.adm2_name1) + ' район'];
  if (uid == null) throw new Error(`No alerts UID for ${p.adm2_name1} (${p.adm2_pcode})`);
  features.push({ type: 'Feature', geometry: f.geometry, properties: { uid, oblast: Regions.oblastOf(uid) } });
}
const missing = Object.values(uidByName).filter((u) => !features.some((f) => f.properties.uid === u));
if (missing.length) throw new Error(`Raions without geometry: ${missing.join(', ')}`);

(async () => {
  const out = await mapshaper.applyCommands(
    [
      '-i raions.json name=raions',
      '-proj +proj=lcc +lat_1=45 +lat_2=51 +lat_0=48.5 +lon_0=31.5 +datum=WGS84',
      '-dissolve uid copy-fields=oblast', // merge multi-part units (e.g. Chornobyl zone into Vyshhorod)
      `-simplify ${SIMPLIFY} keep-shapes`,
      '-clean',
      '-dissolve oblast target=raions + name=oblasts',
      '-points inner target=oblasts + name=labels',
      '-o target=* format=geojson precision=1',
    ].join(' '),
    { 'raions.json': { type: 'FeatureCollection', features } },
  );
  const layer = (name) => JSON.parse(out[`${name}.json`]);
  const raions = layer('raions').features;
  const oblasts = layer('oblasts').features;
  const labels = layer('labels').features;

  // Fit into a WIDTH-wide box with y pointing down.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const eachPoint = (geom, fn) => {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) for (const ring of poly) for (const pt of ring) fn(pt);
  };
  for (const f of raions) eachPoint(f.geometry, ([x, y]) => {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  });
  const k = WIDTH / (x1 - x0);
  const tx = (x) => Math.round((x - x0) * k * 10) / 10;
  const ty = (y) => Math.round((y1 - y) * k * 10) / 10;

  const toPath = (geom) => {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    let d = '';
    for (const poly of polys) {
      for (const ring of poly) {
        let px = null;
        let py = null;
        ring.slice(0, -1).forEach(([x, y], i) => {
          const X = tx(x);
          const Y = ty(y);
          if (i === 0) d += `M${X} ${Y}`;
          else d += `l${+(X - px).toFixed(1)} ${+(Y - py).toFixed(1)}`;
          px = X;
          py = Y;
        });
        d += 'z';
      }
    }
    return d;
  };

  const nameOf = (uid) => require('./raion-uids.json')[uid] || Regions.OBLAST_BY_UID[uid].name;
  const map = {
    source: 'OCHA / HDX COD-AB Ukraine (CC BY-IGO), https://data.humdata.org/dataset/cod-ab-ukr',
    width: WIDTH,
    height: Math.ceil((y1 - y0) * k),
    raions: raions
      .map((f) => ({ uid: f.properties.uid, name: nameOf(f.properties.uid), d: toPath(f.geometry) }))
      .sort((a, b) => a.uid - b.uid),
    oblasts: oblasts
      .map((f) => ({ uid: f.properties.oblast, name: Regions.OBLAST_BY_UID[f.properties.oblast].name, d: toPath(f.geometry) }))
      .sort((a, b) => a.uid - b.uid),
    labels: labels
      .filter((f) => !Regions.OBLAST_BY_UID[f.properties.oblast].city)
      .map((f) => {
        const [x, y] = f.geometry.coordinates;
        const name = Regions.OBLAST_BY_UID[f.properties.oblast].name.replace(' область', '').replace('Автономна Республіка Крим', 'АР Крим');
        return { name, x: tx(x), y: ty(y) };
      }),
  };
  const file = path.join(__dirname, '..', 'app', 'assets', 'map.json');
  fs.writeFileSync(file, JSON.stringify(map));
  console.log(`${file}: ${map.raions.length} raions, ${map.oblasts.length} oblasts, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
})();
