const CACHE = 'run-pacer-v1';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/auth.js', '/js/app.js', '/js/voice.js', '/js/music.js', '/js/route.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return; // API 호출은 캐시하지 않음
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
