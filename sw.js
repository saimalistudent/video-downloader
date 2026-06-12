const CACHE_VERSION = 'v4';
const CACHE_NAME = 'omni-downloader-' + CACHE_VERSION;
const SHELL = [
  '/',
  '/index.html',
  '/icon.svg',
  '/favicon.svg',
  '/icon-512.png',
  '/icon-192.png',
  '/apple-touch-icon.png',
  '/og-image.jpg',
  '/site.webmanifest',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL);
    }).catch(function () {})
  );
  self.skipWaiting();
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE_NAME;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isAppShellRequest(request, url) {
  return request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html';
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.indexOf('/api/') === 0 ||
      url.pathname.indexOf('/.netlify/functions/') === 0 ||
      url.pathname.indexOf('/admin') === 0) {
    return;
  }

  if (url.pathname === '/sw.js') {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isAppShellRequest(event.request, url)) {
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      }).catch(function () {
        return caches.match('/index.html');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      });
      return cached || networkFetch;
    })
  );
});
