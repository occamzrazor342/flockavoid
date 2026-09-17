// Minimal service worker -- exists mainly so Chrome/etc. recognize this as
// an installable PWA (add-to-home-screen), with the cache as an offline
// fallback only. Network-first, NOT cache-first: an earlier cache-first
// version of this file caused a real bug (confirmed live) -- since
// CACHE_NAME never changed across deploys, the service worker's own
// `install` event never re-fired (browsers only re-run it when this
// script's bytes change), so SHELL_FILES never got re-cached and every
// installed user was stuck on whatever version happened to be cached on
// their very first visit, silently, no matter how many times the app was
// actually updated and redeployed. Network-first means every visit with
// connectivity gets the real current version; the cache only matters when
// there's genuinely no network at all.
//
// The plain fetch() call below still isn't enough on its own: GitHub Pages
// serves these files with `cache-control: max-age=600`, and a bare fetch()
// honors that HTTP header via the browser's own HTTP cache -- so for up to
// 10 minutes after every deploy, "network-first" could silently hand back a
// stale response without the request ever reaching the real server at all
// (confirmed live: a just-shipped fix was still missing minutes after
// deploy). `cache: 'no-store'` forces every request here to actually hit
// the network and skip the HTTP cache entirely, so deploys take effect
// immediately instead of up to 10 minutes later.

const CACHE_NAME = 'camroute-shell-v4';
// app.js is intentionally not precached here -- index.html now references it
// with a bumped ?v= query string on every deploy that touches it, so a fixed
// unversioned './app.js' entry here would go stale and never match what's
// actually requested. The fetch handler below still caches it dynamically
// (whatever URL is actually requested) for the offline fallback case.
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

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
  // Never intercept calls to the routing/geocoding APIs or the bridge
  // worker -- those must always hit the network live, never served from
  // cache, and are cross-origin anyway (this check is what actually
  // enforces that regardless of the strategy below).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
