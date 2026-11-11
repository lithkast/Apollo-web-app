// Apollo's Temple service worker. Its only job is to let the site install as an app and to open
// without a connection. The page always comes from the network when there is one, so a new
// version of the site shows up the next time the app is opened; the saved copy is only used offline.
// Everything else (the database, sign-in, fonts) is left to the browser.
const SHELL = 'apollo-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const req = event.request;
  // an About box shown on a Carrd (/embed/...) is left to the browser: it is not the site, so it is never the saved copy
  if (req.method !== 'GET' || req.mode !== 'navigate' || new URL(req.url).origin !== self.location.origin || new URL(req.url).pathname.startsWith('/embed/')) return;
  event.respondWith(
    fetch(req).then(res => {
      // every address (/hr, /staff/someone and so on) is the same page, so one saved copy, kept as '/', opens them all
      if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(SHELL).then(c => c.put('/', copy))); }
      return res;
    }).catch(() => caches.match('/').then(hit => hit || Response.error()))
  );
});
