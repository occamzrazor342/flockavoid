// Minimal service worker -- exists mainly so Chrome recognizes this as an
// installable PWA (add-to-home-screen). Caches the app shell so it opens
// even with a flaky connection; the actual routing call always needs live
// network (it's hitting a real API), so this deliberately doesn't try to
// cache or fake that.

const CACHE_NAME = 'camroute-shell-v1';
const SHELL_FILES = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept calls to the routing/geocoding APIs -- those must always
  // hit the network live, never served from cache.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
