const CACHE = 'vitalisera-inv-v4';
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

// Network-first for app files, cache-first for static assets
const NETWORK_FIRST = ['app.js', 'style.css', 'index.html'];

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
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('script.google.com')) return;

  const isAppFile = NETWORK_FIRST.some(f => e.request.url.includes(f));

  if (isAppFile) {
    // Network-first: always try fresh, fall back to cache
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for static assets (icons, fonts, libraries)
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
  }
});
