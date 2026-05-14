const CACHE = 'vitalisera-inv-v115';
// Egna assets — om någon av dessa failar är appen trasig, all-or-nothing är OK.
const PRECACHE_OWN = [
  './',
  'style.css',
  'app.js',
  'autocomplete.js',
  'changelog.json',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];
// Externa CDN-beroenden — om unpkg/fonts är nere ska inte hela installationen falla.
const PRECACHE_EXTERNAL = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap',
  'https://unpkg.com/@zxing/library@0.20.0'
];

// Network-first for app files, cache-first for static assets.
// vision.js är network-first men INTE i PRECACHE_OWN — den lazy-loadas vid första
// byte till "Bild"-läge i kamera-toggeln, sen cachas via NETWORK_FIRST-strategin.
const NETWORK_FIRST = ['app.js', 'autocomplete.js', 'vision.js', 'style.css', 'index.html', 'changelog.json'];

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
    )
    // INGEN skipWaiting() — vänta på explicit SKIP_WAITING-message från klienten,
    // så användaren ser update-banner och kan välja när omstart sker.
  );
});

// Klienten postMessage('SKIP_WAITING') när användaren trycker "Starta om" i banner.
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Rensa gamla versioner och CLAIM:a öppna klienter direkt. Utan claim()
  // skickar SKIP_WAITING-meddelandet från banner-knappen aldrig en
  // controllerchange-event till klienten → location.reload() triggas inte
  // → user trycker på en "död" knapp. Med claim() tar nya SW kontroll
  // över existing tab → controllerchange → reload → ny version laddas.
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null))
      ),
      self.clients.claim()
    ])
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
