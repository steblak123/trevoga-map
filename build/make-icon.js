// Renders build/icon.png (256x256) from the oblast outlines. Run with: electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'map.json'), 'utf8'));
  const paths = map.oblasts.map((o) => o.d);
  const html = `<html><body style="margin:0;background:transparent">
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect x="8" y="8" width="240" height="240" rx="52" fill="#141b26"/>
      <g id="ua" fill="#d32f2f" stroke="#ffcdd2" stroke-width="10" stroke-linejoin="round">
        ${paths.map((d) => `<path d="${d}"/>`).join('')}
      </g>
    </svg>
    <script>
      const g = document.getElementById('ua');
      const b = g.getBBox();
      const s = 200 / Math.max(b.width, b.height);
      g.setAttribute('transform', 'translate(' + (128 - (b.x + b.width / 2) * s) + ',' + (128 - (b.y + b.height / 2) * s) + ') scale(' + s + ')');
      g.setAttribute('stroke-width', 1.2 / s);
    </script></body></html>`;
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.resize({ width: 256, height: 256 }).toPNG());
  console.log('build/icon.png written');
  app.quit();
});
