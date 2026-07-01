// sw.js — Service Worker(オフライン対応・アプリシェルのキャッシュ)
const CACHE = 'nai-studio-v10';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/dedup.js',
  './js/db.js',
  './js/storage.js',
  './js/tags.js',
  './js/prompt.js',
  './js/naimeta.js',
  './js/metaexport.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './fonts/ibm-plex-sans.woff2',
  './fonts/jetbrains-mono.woff2',
  './fonts/space-grotesk.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先(最新を常に取得)。オフライン時はキャッシュへフォールバック。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
