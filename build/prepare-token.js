// Writes app/embedded.json with the default API token for the installer build.
// Token source: ALERTS_TOKEN env var or build/token.txt (both kept out of the sources).
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'token.txt');
const token = (process.env.ALERTS_TOKEN || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')).trim();
const out = path.join(__dirname, '..', 'app', 'embedded.json');

if (!token) {
  if (fs.existsSync(out)) fs.unlinkSync(out);
  console.log('No token: build without an embedded token.');
  process.exit(0);
}

// Light masking so the token is not a plain string in the package (not real protection).
const key = Buffer.from('trevoga-map');
const bytes = Buffer.from(token, 'utf8').map((b, i) => b ^ key[i % key.length]);
fs.writeFileSync(out, JSON.stringify({ t: bytes.toString('base64') }));
console.log('Embedded token written to app/embedded.json');
