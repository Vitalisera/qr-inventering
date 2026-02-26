const CACHE = 'vitalisera-inv-v2';
const PRECACHE = [
  './',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap',
  'https://unpkg.com/@zxing/library@0.20.0'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never cache POST (API calls)
  if (e.request.method !== 'GET') return;

  // Never cache GAS API responses
  if (e.request.url.includes('script.google.com')) return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
