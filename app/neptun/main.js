// Main-process part of the NEPTUN layer: links in app windows (the NEPTUN attribution link
// in the widget) open in the default browser, never inside an app window.
// main.js needs only:  require('./neptun/main');
const { app, shell } = require('electron');

const external = (url) => {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
};

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    e.preventDefault();
    external(url);
  });
});
