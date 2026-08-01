/**
 * DCE Holdings — minimal service worker for PWA installability.
 *
 * Strategy:
 *  - Precache app shell (icons + manifest) so home-screen launch is instant offline.
 *  - Network-first for HTML (never serve stale UI once online).
 *  - Never cache /api/* — data must always be fresh.
 *  - Cache-first for static assets under /icons/ and /fonts/ (immutable).
 *
 * Bump SW_VERSION whenever the app shell needs a fresh install.
 */
const SW_VERSION = 'dce-v1';
const SHELL_CACHE = `dce-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `dce-runtime-${SW_VERSION}`;

const SHELL_ASSETS = [
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch API calls — always network.
  if (url.pathname.startsWith('/api/')) return;

  // Only handle same-origin.
  if (url.origin !== self.location.origin) return;

  // HTML documents: network-first with cache fallback (offline home screen still opens).
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html') || caches.match('/')))
    );
    return;
  }

  // Static icons/fonts: cache-first.
  if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  // Everything else: network with cache fallback.
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
