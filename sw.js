const CACHE = 'run-pacer-v3';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/auth.js', '/js/spotify.js', '/js/app.js', '/js/voice.js', '/js/music.js', '/js/route.js', '/manifest.json'];

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

// 네트워크 우선: 항상 최신 파일을 먼저 받아오고, 인터넷이 끊겼을 때만 캐시된 걸로 대체.
// (전에는 캐시를 먼저 봐서, 새로 배포해도 옛날 파일이 계속 보이는 문제가 있었음)
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return; // API 호출은 캐시 대상 아님
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
