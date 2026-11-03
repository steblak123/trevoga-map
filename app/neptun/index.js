// Loader of the NEPTUN layer for widget.html. The page needs only
//   <script src="neptun/index.js"></script>  after widget.js
// and "connect-src https://neptun.in.ua wss://neptun.in.ua" in its Content-Security-Policy.
(function () {
  const base = document.currentScript.src.replace(/[^/]*$/, '');
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = base + 'widget.css';
  document.head.appendChild(css);
  for (const file of ['geo.js', 'types.js', 'client.js', 'widget.js']) {
    const s = document.createElement('script');
    s.src = base + file;
    s.async = false; // keep the order
    document.head.appendChild(s);
  }
})();
