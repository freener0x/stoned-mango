// stoned-mango's service worker: keeps every file the app needs on the device, so it
// works offline and loads without the network. It only ever serves the app's own files
// from its cache; it never sends anything anywhere.
// Written into dist/sw.js at build time, with the file list and a version (vite.config.ts).

const VERSION = '__VERSION__';
const FILES = __FILES__;
const BASE = '__BASE__';
const CACHE = `stoned-mango-${VERSION}`;

// Hosts may answer with a redirect (Cloudflare Pages sends /index.html to /), and browsers refuse
// a page that a service worker serves from a redirected response (Safari: "Response served by
// service worker has redirections"). So responses are stored as plain copies, without the
// redirect, and the page itself is kept under BASE.
async function plain(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

self.addEventListener('install', (event) => {
  // Every file, fresh from the server, or the install fails and the old version stays.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(FILES.map(async (file) => {
      const response = await fetch(new Request(file, { cache: 'reload' }));
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      await cache.put(file, await plain(response));
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('stoned-mango-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// A new version waits until the page asks it to take over ("Reload to update").
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  const page = request.mode === 'navigate' && (path === BASE || path === `${BASE}index.html`);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreVary: the server may answer with "Vary: Origin", and module scripts are requested with an Origin header
    const hit = await cache.match(page ? BASE : request, { ignoreSearch: true, ignoreVary: true });
    return hit ? plain(hit) : fetch(request);
  })());
});
