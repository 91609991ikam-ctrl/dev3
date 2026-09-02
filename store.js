/*
 * store.js
 * 写真と週ごとの状態を IndexedDB に保存する薄いラッパー。
 * 写真は Blob のまま端末内に置くだけで、外部には一切送らない。
 */
(function () {
  var DB_NAME = 'sanpo-bingo';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('photos')) {
          var photos = db.createObjectStore('photos', { keyPath: 'id' });
          photos.createIndex('week', 'week', { unique: false });
        }
        if (!db.objectStoreNames.contains('weeks')) {
          db.createObjectStore('weeks', { keyPath: 'week' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        // out が IDBRequest なら、その結果を返す（該当なしのときは undefined）
        t.oncomplete = function () {
          resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  var Store = {
    photoId: function (week, cell) { return week + ':' + cell; },

    getPhoto: function (week, cell) {
      return tx('photos', 'readonly', function (s) { return s.get(Store.photoId(week, cell)); });
    },

    getPhotosOfWeek: function (week) {
      return tx('photos', 'readonly', function (s) {
        return s.index('week').getAll(week);
      }).then(function (rows) { return rows || []; });
    },

    // 週ごとの枚数だけを、写真本体を読まずに数える（アルバム一覧を軽くするため）
    countByWeek: function () {
      return tx('photos', 'readonly', function (s) {
        return s.index('week').getAllKeys();
      }).then(function (keys) {
        var counts = {};
        (keys || []).forEach(function (id) {
          var week = String(id).split(':')[0];
          counts[week] = (counts[week] || 0) + 1;
        });
        return counts;
      });
    },

    // その週の代表として、いちばん若いマスの写真を1枚だけ読む
    getCover: function (week) {
      return tx('photos', 'readonly', function (s) {
        return s.index('week').getAll(week, 1);
      }).then(function (rows) { return (rows && rows[0]) || null; });
    },

    getAllPhotos: function () {
      return tx('photos', 'readonly', function (s) { return s.getAll(); })
        .then(function (rows) { return rows || []; });
    },

    putPhoto: function (record) {
      return tx('photos', 'readwrite', function (s) { s.put(record); });
    },

    deletePhoto: function (week, cell) {
      return tx('photos', 'readwrite', function (s) { s.delete(Store.photoId(week, cell)); });
    },

    getWeek: function (week) {
      return tx('weeks', 'readonly', function (s) { return s.get(week); })
        .then(function (row) { return row || { week: week, rerolls: {}, celebrated: 0 }; });
    },

    putWeek: function (record) {
      return tx('weeks', 'readwrite', function (s) { s.put(record); });
    },

    clearAll: function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(['photos', 'weeks'], 'readwrite');
          t.objectStore('photos').clear();
          t.objectStore('weeks').clear();
          t.oncomplete = function () { resolve(); };
          t.onerror = function () { reject(t.error); };
        });
      });
    }
  };

  window.Store = Store;
})();
