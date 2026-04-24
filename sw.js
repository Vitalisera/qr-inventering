const CACHE = 'vitalisera-inv-v35';
// Egna assets — om någon av dessa failar är appen trasig, all-or-nothing är OK.
const PRECACHE_OWN = [
  './',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];
// Externa CDN-beroenden — om unpkg/fonts är nere ska inte hela installationen falla.
const PRECACHE_EXTERNAL = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap',
  'https://unpkg.com/@zxing/library@0.20.0'
];

// Network-first for app files, cache-first for static assets
const NETWORK_FIRST = ['app.js', 'style.css', 'index.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      c.addAll(PRECACHE_OWN).then(() =>
        Promise.allSettled(PRECACHE_EXTERNAL.map(url =>
          fetch(url, { mode: 'no-cors' })
            .then(r => c.put(url, r))
            .catch(err => console.warn('[sw] precache external failed:', url, err))
        ))
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Rensa gamla versioner men claimar INTE öppna tabs — gamla tabs får behålla sin gamla
  // app.js-instans i minnet tills användaren reloadar, så att HTML/JS/CSS alltid matchar.
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null))
    )
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('script.google.com')) return;

  const isAppFile = e.request.mode === 'navigate' ||
                    NETWORK_FIRST.some(f => e.request.url.includes(f));

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
