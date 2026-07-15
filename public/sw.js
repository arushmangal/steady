// Installability only, not a caching strategy — the app's existing
// localStorage fallback (see public/index.html) already covers real
// offline data resilience. This just needs a fetch handler to exist for
// the browser to consider Steady installable.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
