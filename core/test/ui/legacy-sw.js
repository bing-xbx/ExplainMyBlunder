// Offline support for the installed app (home-screen web app on the phone).
// Every app file is cached on install. Afterwards the cached copy is served at once and
// refreshed in the background when online, so an update shows on the next launch.
// Only the app's own files are cached: games come from Lichess, and reviews live in IndexedDB.
const CACHE = 'blunder-app';
const FILES = [
  '/', '/app.js', '/core.js', '/style.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  '/vendor/chessground/chessground.min.js', '/vendor/chessground/chessground.base.css',
  '/vendor/chessground/chessground.brown.css', '/vendor/chessground/chessground.cburnett.css',
  '/vendor/stockfish/stockfish-19-lite-single.js', '/vendor/stockfish/stockfish-19-lite-single.wasm',
  '/vendor/stockfish/stockfish-19-lite.js', '/vendor/stockfish/stockfish-19-lite.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const key = req.mode === 'navigate' ? '/' : url.pathname; // "/?local=1" is still the page
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(key);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    if (cached) {
      e.waitUntil(fresh.catch(() => {}));
      return cached;
    }
    return fresh;
  }));
});
