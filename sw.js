/* The app opens with no internet (b241).

   Without this, refreshing the page with no signal showed the browser's own
   "no internet" page instead of the app, so nobody could sell, and nobody
   could see that their waiting changes were still safe on the device.

   The page itself, its settings and its pictures are kept on the device every
   time they load. While online the newest copy always wins (the network is
   asked first), so an update is never held back. With no signal, or one too
   slow to answer, the kept copy opens instead, and the app draws the last data
   it saw plus every change still waiting to send.

   Only this site's own files and the Google fonts pass through here. The app's
   saves and reads go to the server directly and are never stored or answered
   from here. */
const CACHE = 'tbs-shell-v1';
const SHELL = ['./', 'index.html', 'config.js', 'favicon.ico', 'favicon.png', 'favicon-192.png',
               'apple-touch-icon.png', 'Srila_Prabhupada.jpeg', 'Gurudeva.jpeg'];
const SLOW_MS = 6000;      // a signal this slow is treated as none, for opening the page

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('tbs-shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  if (!own && !FONTS.test(req.url)) return;          // the server, and everything else: untouched
  e.respondWith(fresh(req, own));
});

/* The network first; the kept copy when it fails or is too slow. */
async function fresh(req, own) {
  const cache = await caches.open(CACHE);
  // The page is one file whatever follows the "?" (?practice, a share link).
  const kept = () => cache.match(req, { ignoreSearch: own && req.mode === 'navigate' })
    .then(r => r || (req.mode === 'navigate' ? cache.match('index.html') : undefined));
  const net = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      // Keep the page under one name, so any address of it opens offline.
      const key = own && req.mode === 'navigate' ? 'index.html' : req;
      cache.put(key, copy).catch(() => {});
    }
    return res;
  });
  let timer;
  const slow = new Promise(r => { timer = setTimeout(r, SLOW_MS); }).then(kept);
  try {
    const first = await Promise.race([net.catch(() => null), slow]);
    clearTimeout(timer);
    if (first) return first;
    const k = await kept();
    if (k) return k;
    return await net;               // nothing kept yet: whatever the network says
  } catch (err) {
    const k = await kept();
    if (k) return k;
    throw err;
  }
}
