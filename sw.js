// Network-first service worker: always fresh when online, works offline from cache.
const CACHE = 'tango-ear-v2';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/data.js', 'js/library.js', 'js/store.js', 'js/tags.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/fraunces-latin.woff2', 'fonts/fraunces-latin-ext.woff2',
  'fonts/inter-latin.woff2', 'fonts/inter-latin-ext.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
