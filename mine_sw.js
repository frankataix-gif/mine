const CACHE = 'mine-prod-v2';
const ASSETS = ['./mine_production.html', './'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  // 数据同步请求不缓存，直接走网络
  if (e.request.method !== 'GET') return;
  // 网络优先：有网拿最新版并更新缓存，断网回退到缓存（离线可用）
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && e.request.url.startsWith(self.location.origin)) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./mine_production.html')))
  );
});
