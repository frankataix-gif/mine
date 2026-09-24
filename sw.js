// ECOBOX 现场工具箱 — 统一 Service Worker
// 缓存门户 + 全部子应用页面，离线可打开；API 请求不拦截
const CACHE = 'ecobox-tools-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/mine_production.html',
  '/sampling_helper.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // 清掉旧版各 app 独立缓存（mine-prod-*、sampling-* 等）
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  // 只接管白名单页面/静态资源 + 已同步的照片；API（/sample /samples /ocr /ping 等）直接放行
  const isAsset = ASSETS.includes(u.pathname) || u.pathname.startsWith('/photos/');
  if (!isAsset) return;
  // 网络优先：有网拿最新并更新缓存，断网回退缓存
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/index.html')))
  );
});
