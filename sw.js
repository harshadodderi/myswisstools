// Keeps the app working offline. Never sees user files: tools work on them in memory.
const VERSION = 'mypdftools-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'icon.svg', 'manifest.webmanifest',
  'js/app.js', 'js/lib.js', 'js/ui.js', 'js/icons.js', 'js/editor.js', 'js/pagegrid.js', 'js/htmlpdf.js',
  'js/tools/pages.js', 'js/tools/edit.js', 'js/tools/convert.js', 'js/tools/formats.js', 'js/books.js', 'js/tools/security.js',
  'vendor/pdf-lib.esm.min.js', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/qpdf/qpdf.js', 'vendor/qpdf/qpdf.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const keep = async (res) => {
    if (res.ok) (await caches.open(VERSION)).put(e.request, res.clone());
    return res;
  };
  // Libraries are pinned, so cache first. App code prefers the network to pick up updates.
  e.respondWith(url.pathname.includes('/vendor/')
    ? caches.match(e.request).then((hit) => hit || fetch(e.request).then(keep))
    : fetch(e.request).then(keep).catch(() => caches.match(e.request)));
});
