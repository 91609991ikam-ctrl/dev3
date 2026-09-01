/*
 * zip.js
 * 写真をまとめて持ち出すための、最小限のZIP書き出し。
 * JPEGは圧縮済みなので、無圧縮(store)で連結するだけにしてある。
 * ライブラリを足さずに済ませるための、100行ほどの実装。
 */
(function () {
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ZIPの日時はMS-DOS形式（2秒単位、1980年起点）
  function dosTime(date) {
    return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xFFFF;
  }
  function dosDate(date) {
    return (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  }

  function bytesOf(input) {
    if (input instanceof Uint8Array) return Promise.resolve(input);
    if (typeof input === 'string') return Promise.resolve(new TextEncoder().encode(input));
    if (input.arrayBuffer) return input.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = reject;
      fr.readAsArrayBuffer(input);
    });
  }

  function writer(size) {
    var buf = new Uint8Array(size);
    var view = new DataView(buf.buffer);
    var at = 0;
    return {
      buf: buf,
      u16: function (v) { view.setUint16(at, v, true); at += 2; },
      u32: function (v) { view.setUint32(at, v >>> 0, true); at += 4; },
      raw: function (b) { buf.set(b, at); at += b.length; },
      get offset() { return at; }
    };
  }

  /**
   * files: [{ name: 'a.jpg', data: Blob|Uint8Array|string, date: Date }]
   * @return Promise<Blob>  ZIPファイル
   */
  function makeZip(files) {
    var encoder = new TextEncoder();
    return Promise.all(files.map(function (f) {
      return bytesOf(f.data).then(function (bytes) {
        return { name: encoder.encode(f.name), bytes: bytes, crc: crc32(bytes), date: f.date || new Date() };
      });
    })).then(function (entries) {
      var localSize = entries.reduce(function (n, e) { return n + 30 + e.name.length + e.bytes.length; }, 0);
      var centralSize = entries.reduce(function (n, e) { return n + 46 + e.name.length; }, 0);
      var w = writer(localSize + centralSize + 22);
      var offsets = [];

      entries.forEach(function (e) {
        offsets.push(w.offset);
        w.u32(0x04034B50);      // ローカルファイルヘッダ
        w.u16(20);              // 展開に必要なバージョン
        w.u16(0x0800);          // ファイル名はUTF-8
        w.u16(0);               // 無圧縮
        w.u16(dosTime(e.date));
        w.u16(dosDate(e.date));
        w.u32(e.crc);
        w.u32(e.bytes.length);  // 圧縮後サイズ
        w.u32(e.bytes.length);  // 元のサイズ
        w.u16(e.name.length);
        w.u16(0);               // 拡張フィールドなし
        w.raw(e.name);
        w.raw(e.bytes);
      });

      var centralStart = w.offset;
      entries.forEach(function (e, i) {
        w.u32(0x02014B50);      // セントラルディレクトリ
        w.u16(20);              // 作成したバージョン
        w.u16(20);
        w.u16(0x0800);
        w.u16(0);
        w.u16(dosTime(e.date));
        w.u16(dosDate(e.date));
        w.u32(e.crc);
        w.u32(e.bytes.length);
        w.u32(e.bytes.length);
        w.u16(e.name.length);
        w.u16(0); w.u16(0); w.u16(0); w.u16(0);
        w.u32(0);               // 外部属性
        w.u32(offsets[i]);
        w.raw(e.name);
      });

      var centralBytes = w.offset - centralStart;
      w.u32(0x06054B50);        // 終端レコード
      w.u16(0); w.u16(0);       // ディスク番号
      w.u16(entries.length);
      w.u16(entries.length);
      w.u32(centralBytes);
      w.u32(centralStart);
      w.u16(0);                 // コメントなし

      return new Blob([w.buf], { type: 'application/zip' });
    });
  }

  window.makeZip = makeZip;
})();
