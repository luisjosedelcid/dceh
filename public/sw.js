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
const SW_VERSION = 'dce-v53';
const SHELL_CACHE = `dce-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `dce-runtime-${SW_VERSION}`;
const API_CACHE     = `dce-api-${SW_VERSION}`;

// Read-only GET endpoints that are safe to serve stale.
// Anything NOT in this list is passed straight to network.
const API_SWR_ALLOW = [
  '/api/cockpit',
  '/api/screener-query',
  '/api/screener-snapshot',
  '/api/universe',
  '/api/sector-tracker',
  '/api/superinvestors',
  '/api/idea-feed',
  '/api/performance',
  '/api/calendar',
  '/api/news',
  '/api/portfolio',
  '/api/covered'
];
const API_TTL_MS = 15 * 60 * 1000; // 15 min freshness window

const SHELL_ASSETS = [
  '/manifest.webmanifest',
  '/pwa-shell.css',
  '/pwa-shell.js',
  '/offline.html',
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
      keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== API_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim()).then(() => {
      // Notify all open pages there's a new active SW.
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API calls: SWR only for whitelisted read endpoints; everything else network-only.
  if (url.pathname.startsWith('/api/')) {
    const allowed = API_SWR_ALLOW.some(p => url.pathname === p || url.pathname.startsWith(p + '/'));
    if (!allowed) return; // let it hit the network un-cached
    event.respondWith(swrApi(req));
    return;
  }

  // Only handle same-origin.
  if (url.origin !== self.location.origin) return;

  // HTML documents: network-first with cache fallback (offline home screen still opens).
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/offline.html') || caches.match('/index.html')))
    );
    return;
  }

  // Static icons/fonts/splash: cache-first.
  if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/splash/')) {
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

/**
 * Stale-While-Revalidate for whitelisted /api/* GETs.
 * Serves cached response instantly (if any), then updates cache from network.
 * Adds x-dce-cache: hit|miss|stale so pages can flag stale data if needed.
 */
async function swrApi(req) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res && res.status === 200) {
      const copy = res.clone();
      const headers = new Headers(copy.headers);
      headers.set('x-dce-cached-at', Date.now().toString());
      // Rewrap so we can attach the timestamp header.
      copy.blob().then(body => {
        cache.put(req, new Response(body, { status: copy.status, statusText: copy.statusText, headers }));
      }).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (cached) {
    const ts = parseInt(cached.headers.get('x-dce-cached-at') || '0', 10);
    const age = Date.now() - ts;
    // Return cache immediately; fire network in background.
    networkPromise; // no await
    const hdrs = new Headers(cached.headers);
    hdrs.set('x-dce-cache', age < API_TTL_MS ? 'hit' : 'stale');
    hdrs.set('x-dce-cache-age-ms', age.toString());
    return new Response(await cached.blob(), { status: cached.status, statusText: cached.statusText, headers: hdrs });
  }

  // No cache — wait for network. If offline, return a synthetic 503.
  const res = await networkPromise;
  if (res) {
    const hdrs = new Headers(res.headers);
    hdrs.set('x-dce-cache', 'miss');
    return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers: hdrs });
  }
  return new Response(JSON.stringify({ error: 'offline', cached: false }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'x-dce-cache': 'offline' }
  });
}

// ─── Web Push ───────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {
    payload = { title: 'DCE Holdings', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'DCE Holdings';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-96.png',
    tag: payload.tag || 'dce-notification',
    data: { url: payload.url || '/', ...(payload.data || {}) },
    // iOS Web Push requires user-visible=true; leave defaults for max compatibility.
    // vibrate not supported on iOS but harmless elsewhere.
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const absolute = new URL(targetUrl, self.location.origin).href;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing window if we already have one open.
    for (const client of all) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          await client.focus();
          if (client.url !== absolute && 'navigate' in client) {
            try { await client.navigate(absolute); } catch (e) { /* ignored */ }
          }
          return;
        }
      } catch (e) { /* ignored */ }
    }
    // Otherwise open a fresh window.
    if (self.clients.openWindow) await self.clients.openWindow(absolute);
  })());
});
