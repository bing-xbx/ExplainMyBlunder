// Offline support for the installed app (home-screen web app on the phone).
// Built into web/sw.js by tools/build-web.mjs, which fills in FILES and VERSION (a hash of
// every app file), so each deploy that changes a file is a new service worker.
// A new version downloads every file into its own cache before it takes over: if any download
// fails, it waits and the old version keeps working, so old and new files never mix.
// The page switches to it when it is ready (at launch, or when you tap "New version").
// Only the app's own files are cached: games come from Lichess, and reviews live in IndexedDB.
const FILES = __FILES__;
const VERSION = __VERSION__;
// The last commit that changed the app (its time and short id), for About; not used here.
const BUILT = __BUILT__;
const PREFIX = 'blunder-';
const CACHE = PREFIX + VERSION;
const LEGACY = 'blunder-app'; // the cache of the first service worker, which refreshed file by file

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 'reload' skips the browser's HTTP cache, so every file is this deploy's copy.
      await cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })));
    } catch (err) {
      await caches.delete(CACHE); // a failed install leaves nothing behind; the browser retries later
      throw err;
    }
    // The first service worker never asks the page; take over at once from it.
    if (await caches.has(LEGACY)) self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'activate') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Only board navigations use the offline page. Checkout and API URLs must reach
  // the network rather than receiving cached HTML (and never enter this cache).
  if (req.mode === 'navigate' && !['/', '/index.html'].includes(url.pathname)) return;
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  if (!FILES.includes(key)) return;
  e.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(key);
    return cached || fetch(req);
  })());
});
