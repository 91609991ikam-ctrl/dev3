/*
 * オフラインでも開けるように、アプリ本体だけキャッシュする。写真は IndexedDB 側。
 *
 * 方針は stale-while-revalidate:
 *   まずキャッシュから即返して、裏で最新版を取りにいってキャッシュを更新する。
 *   歩きながら電波が悪くても起動でき、ミッションを差し替えたときは次の起動で反映される。
 */
var CACHE = 'sanpo-bingo-v3';
var ASSETS = ['./', 'index.html', 'styles.css', 'missions.js', 'store.js', 'zip.js', 'app.js', 'icon.svg', 'manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 最新版の取得。cache: 'reload' でブラウザのHTTPキャッシュを迂回しないと
  // 古いファイルをそのまま焼き直してしまう。
  var fresh = fetch(new Request(req.url, { cache: 'reload', credentials: 'same-origin' }))
    .then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { return cache.put(req, copy); });
      }
      return res;
    });

  // waitUntil と respondWith は同期的に呼ぶ（あとから呼ぶと無効になる）
  e.waitUntil(fresh.catch(function () {}));
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fresh.catch(function () { return caches.match('index.html'); });
    })
  );
});
