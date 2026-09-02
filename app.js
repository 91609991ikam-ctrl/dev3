/*
 * app.js
 * さんぽビンゴ本体。
 * 毎週月曜に9マスのミッションが自動で入れ替わる（週番号から決定的に生成するので、
 * 同じ端末でなくても、同じ週なら同じ盤面になる）。
 */
(function () {
  'use strict';

  var CATS = window.MISSION_CATEGORIES;
  var SIZE = 9;
  var LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  var DAY_MS = 86400000;
  var WEEK_MS = 7 * DAY_MS;
  var MAX_REROLLS = 1;

  /* ---------- 乱数（週番号から決定的に） ---------- */

  function hashString(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(list, seed) {
    var rnd = mulberry32(seed);
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  /* ---------- 週の計算（週のはじまりは月曜） ---------- */

  function startOfWeek(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var offset = (d.getDay() + 6) % 7; // 月曜=0
    d.setDate(d.getDate() - offset);
    return d;
  }

  function weekIndexOf(date) {
    var base = startOfWeek(new Date(1970, 0, 5)); // 1970-01-05 は月曜
    return Math.round((startOfWeek(date) - base) / WEEK_MS);
  }

  function weekKey(index) { return 'w' + index; }

  function weekRange(index) {
    var base = startOfWeek(new Date(1970, 0, 5));
    var start = new Date(base.getTime() + index * WEEK_MS);
    var end = new Date(start.getTime() + 6 * DAY_MS);
    return { start: start, end: end };
  }

  function formatRange(index) {
    var r = weekRange(index);
    var f = function (d) { return (d.getMonth() + 1) + '/' + d.getDate(); };
    return f(r.start) + ' 〜 ' + f(r.end);
  }

  function remainingText(index) {
    var r = weekRange(index);
    var endAt = new Date(r.end.getFullYear(), r.end.getMonth(), r.end.getDate() + 1).getTime();
    var left = endAt - Date.now();
    if (left <= 0) return '入れ替わりました';
    var days = Math.floor(left / DAY_MS);
    if (days >= 1) return 'あと' + days + '日';
    var hours = Math.floor(left / 3600000);
    if (hours >= 1) return 'あと' + hours + '時間';
    return 'あと' + Math.max(1, Math.floor(left / 60000)) + '分';
  }

  /* ---------- 盤面の生成 ---------- */

  function missionRef(catKey, itemIndex) {
    var cat = null;
    for (var i = 0; i < CATS.length; i++) if (CATS[i].key === catKey) cat = CATS[i];
    if (!cat) cat = CATS[0];
    var item = cat.items[itemIndex % cat.items.length];
    return {
      id: cat.key + '#' + (itemIndex % cat.items.length),
      catKey: cat.key,
      itemIndex: itemIndex % cat.items.length,
      label: cat.label,
      icon: cat.icon,
      title: item.t,
      hint: item.h
    };
  }

  // カテゴリごとに「シャッフルした山札を1枚ずつめくる」ので、
  // 同じカテゴリのミッションは山札を一周するまで再登場しない。
  function rawDeck(cat, round) {
    var indices = cat.items.map(function (_, i) { return i; });
    return shuffled(indices, hashString(cat.key) ^ ((round * 2654435761) >>> 0));
  }

  // 山札を切り直した直後に、前の山札の最後のほうと同じミッションが
  // すぐ出てしまわないように、必要なら山札を回してずらす。
  // 前の山札に依存するので round 0 から順に組み立てる（結果はキャッシュする）。
  var deckCache = {};

  function nextDeck(cat, prevDeck, round) {
    var deck = rawDeck(cat, round);
    var tail = prevDeck.slice(-3);
    var guard = 0;
    while (guard++ < deck.length &&
      (tail.indexOf(deck[0]) >= 0 || tail.indexOf(deck[1]) >= 0 || tail.indexOf(deck[2]) >= 0)) {
      deck = deck.slice(1).concat(deck[0]);
    }
    return deck;
  }

  function categoryDeck(cat, round) {
    if (round < 0) round = 0;
    var cached = deckCache[cat.key];
    if (!cached || cached.round > round) {
      cached = deckCache[cat.key] = { round: 0, deck: rawDeck(cat, 0) };
    }
    while (cached.round < round) {
      cached = deckCache[cat.key] = {
        round: cached.round + 1,
        deck: nextDeck(cat, cached.deck, cached.round + 1)
      };
    }
    return cached.deck;
  }

  function pickFromCategory(cat, index) {
    var n = cat.items.length;
    var round = Math.floor(index / n);
    var deck = categoryDeck(cat, round);
    return missionRef(cat.key, deck[((index % n) + n) % n]);
  }

  // 9マスのカテゴリは毎週くじ引き。重複を避けないので、同じジャンルが
  // 2〜3マス並ぶ週もあれば、まったく出ないジャンルもある。
  function categoriesForWeek(index) {
    var rnd = mulberry32(hashString('slots:' + index));
    var out = [];
    for (var i = 0; i < SIZE; i++) out.push(CATS[Math.floor(rnd() * CATS.length)]);
    return out;
  }

  // カテゴリごとの山札は「そのカテゴリが今までに何回引かれたか」で進む。
  // 週によって引かれる回数が変わるので、最初の週から数え上げてキャッシュする。
  var stream = null;

  function usageBefore(index) {
    if (!stream || stream.week > index) stream = { week: 0, use: {} };
    while (stream.week < index) {
      categoriesForWeek(stream.week).forEach(function (cat) {
        stream.use[cat.key] = (stream.use[cat.key] || 0) + 1;
      });
      stream.week++;
    }
    return stream.use;
  }

  function buildBoard(index, rerolls) {
    var use = {};
    var before = usageBefore(index);
    Object.keys(before).forEach(function (k) { use[k] = before[k]; });

    var board = categoriesForWeek(index).map(function (cat) {
      var drawn = use[cat.key] || 0;
      use[cat.key] = drawn + 1;
      return pickFromCategory(cat, drawn);
    });

    Object.keys(rerolls || {}).forEach(function (cell) {
      var ref = rerolls[cell];
      var n = Number(cell);
      if (ref && n >= 0 && n < SIZE) board[n] = missionRef(ref.catKey, ref.itemIndex);
    });
    return board;
  }

  // 引き直し：いま盤面に出ていないカテゴリから1つ選び直す。
  function rerollMission(index, cell, used) {
    var pool = CATS.filter(function (c) { return used.indexOf(c.key) === -1; });
    if (!pool.length) pool = CATS.slice();
    var order = shuffled(pool, hashString('reroll:' + index + ':' + cell));
    return pickFromCategory(order[0], index + cell + 3);
  }

  /* ---------- 画像の縮小 ---------- */

  function shrinkImage(file) {
    var MAX = 1400;
    return loadBitmap(file).then(function (img) {
      var w = img.width, h = img.height;
      var scale = Math.min(1, MAX / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();
      return new Promise(function (resolve) {
        // toBlob が空を返すこともある。その場合も元画像をそのまま渡さない
        canvas.toBlob(function (blob) {
          resolve(blob || stripJpegMetadata(file));
        }, 'image/jpeg', 0.82);
      });
    }).catch(function () {
      // 縮小に失敗しても写真は残す。ただし位置情報などを載せたままにはしない
      return stripJpegMetadata(file);
    });
  }

  // JPEGからAPP1〜APP15（EXIF・GPS・XMPなど）を取り除く。
  // 通常はcanvasを通す時点で消えるが、縮小に失敗した写真はここで剥がす。
  function stripJpegMetadata(file) {
    if (!file || file.type !== 'image/jpeg' || !file.arrayBuffer) return Promise.resolve(file);
    return file.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return file;

      var parts = [bytes.subarray(0, 2)];
      var i = 2;
      var reachedImage = false;

      while (i + 3 < bytes.length) {
        if (bytes[i] !== 0xFF) break;
        var marker = bytes[i + 1];
        if (marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD8)) { i += 2; continue; }
        if (marker === 0xDA) {           // ここから先は画像データ本体
          parts.push(bytes.subarray(i));
          reachedImage = true;
          break;
        }
        var length = (bytes[i + 2] << 8) | bytes[i + 3];
        if (length < 2 || i + 2 + length > bytes.length) break;
        if (marker < 0xE1 || marker > 0xEF) parts.push(bytes.subarray(i, i + 2 + length));
        i += 2 + length;
      }

      if (!reachedImage) return file;   // 読み解けなかったときは触らない
      return new Blob(parts, { type: 'image/jpeg' });
    }).catch(function () { return file; });
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  /* ---------- 画面の状態 ---------- */

  var state = {
    weekIndex: weekIndexOf(new Date()),
    board: [],
    weekData: { week: '', rerolls: {}, celebrated: 0 },
    photos: {},        // cell -> record
    urls: {},          // cell -> objectURL
    openCell: null,
    tab: 'board',
    albumWeek: null,      // null = 週フォルダの一覧を表示
    selecting: false,     // 「選んで送る」モード
    selectable: {},       // cell -> 写真レコード
    selected: {}
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  function revokeUrls(map) {
    Object.keys(map).forEach(function (k) { URL.revokeObjectURL(map[k]); });
  }

  function bingoLines() {
    return LINES.filter(function (line) {
      return line.every(function (c) { return !!state.photos[c]; });
    });
  }

  function clearedCount() { return Object.keys(state.photos).length; }

  /* ---------- 描画 ---------- */

  function renderHeader() {
    el.weekRange.textContent = formatRange(state.weekIndex);
    el.weekLeft.textContent = remainingText(state.weekIndex);
    var done = clearedCount();
    var lines = bingoLines().length;
    el.statCleared.textContent = done + ' / ' + SIZE;
    el.statBingo.textContent = String(lines);
    el.progressBar.style.width = (done / SIZE * 100) + '%';
    var msg = 'まずは1マス。歩けば見つかる。';
    if (done === SIZE) msg = 'ぜんぶ制覇！おつかれさま 🎉';
    else if (lines >= 2) msg = 'ダブルビンゴ以上！すごい。';
    else if (lines === 1) msg = 'ビンゴ！もう一列いける？';
    else if (done >= 6) msg = 'あと少しで一列そろいそう。';
    else if (done >= 1) msg = 'いい調子。次はどのマス？';
    el.headline.textContent = msg;
  }

  function renderBoard() {
    var lineCells = {};
    bingoLines().forEach(function (line) {
      line.forEach(function (c) { lineCells[c] = true; });
    });

    el.board.innerHTML = '';
    state.board.forEach(function (mission, cell) {
      var photo = state.photos[cell];
      var btn = document.createElement('button');
      btn.className = 'cell' + (photo ? ' is-done' : '') + (lineCells[cell] ? ' is-line' : '');
      btn.type = 'button';
      btn.setAttribute('aria-label', mission.title + (photo ? '（クリア済み）' : ''));

      if (photo) {
        var img = document.createElement('img');
        img.className = 'cell-photo';
        img.alt = '';
        img.src = photoUrl(cell, photo);
        btn.appendChild(img);
        var check = document.createElement('span');
        check.className = 'cell-check';
        check.textContent = '✓';
        btn.appendChild(check);
      }

      var body = document.createElement('span');
      body.className = 'cell-body';
      body.innerHTML = '<span class="cell-cat">' + mission.icon + ' ' + escapeHtml(mission.label) + '</span>' +
        '<span class="cell-title">' + escapeHtml(mission.title) + '</span>';
      btn.appendChild(body);

      btn.addEventListener('click', function () { openSheet(cell); });
      el.board.appendChild(btn);
    });
  }

  function photoUrl(cell, record) {
    if (!state.urls[cell]) state.urls[cell] = URL.createObjectURL(record.blob);
    return state.urls[cell];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    renderHeader();
    renderBoard();
  }

  /* ---------- ミッションのシート ---------- */

  function openSheet(cell) {
    state.openCell = cell;
    var mission = state.board[cell];
    var photo = state.photos[cell];

    el.sheetCat.textContent = mission.icon + ' ' + mission.label;
    el.sheetTitle.textContent = mission.title;
    el.sheetHint.textContent = mission.hint;

    if (photo) {
      el.sheetPhoto.hidden = false;
      el.sheetPhoto.src = photoUrl(cell, photo);
      el.sheetMeta.hidden = false;
      el.sheetMeta.textContent = new Date(photo.at).toLocaleString('ja-JP', {
        month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) + ' にクリア';
      el.btnShoot.textContent = '📷 撮りなおす';
      el.btnDelete.hidden = false;
    } else {
      el.sheetPhoto.hidden = true;
      el.sheetPhoto.removeAttribute('src');
      el.sheetMeta.hidden = true;
      el.btnShoot.textContent = '📷 写真をとってクリア';
      el.btnDelete.hidden = true;
    }

    var rerollsUsed = Object.keys(state.weekData.rerolls || {}).length;
    var canReroll = !photo && rerollsUsed < MAX_REROLLS;
    el.btnReroll.hidden = !!photo;
    el.btnReroll.disabled = !canReroll;
    el.btnReroll.textContent = canReroll
      ? '🔄 このミッションを引き直す（今週あと' + (MAX_REROLLS - rerollsUsed) + '回）'
      : '🔄 今週の引き直しはもう使いました';

    disarmDelete();
    el.sheet.hidden = false;
    document.body.classList.add('is-locked');
    requestAnimationFrame(function () { el.sheet.classList.add('is-open'); });
  }

  function closeSheet() {
    disarmDelete();
    el.sheet.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    state.openCell = null;
    setTimeout(function () { if (!el.sheet.classList.contains('is-open')) el.sheet.hidden = true; }, 200);
  }

  /* ---------- 写真の保存・削除 ---------- */

  function handleFile(file) {
    if (!file || state.openCell === null) return;
    var cell = state.openCell;
    var mission = state.board[cell];
    el.btnShoot.disabled = true;
    el.btnShoot.textContent = '保存中…';

    shrinkImage(file).then(function (blob) {
      var record = {
        id: Store.photoId(weekKey(state.weekIndex), cell),
        week: weekKey(state.weekIndex),
        weekIndex: state.weekIndex,
        cell: cell,
        missionId: mission.id,
        title: mission.title,
        hint: mission.hint,
        category: mission.label,
        icon: mission.icon,
        at: Date.now(),
        blob: blob
      };
      return Store.putPhoto(record).then(function () {
        if (state.urls[cell]) { URL.revokeObjectURL(state.urls[cell]); delete state.urls[cell]; }
        var before = bingoLines().length;
        state.photos[cell] = record;
        var after = bingoLines().length;
        render();
        closeSheet();
        if (after > before) celebrate(after, clearedCount() === SIZE);
        else toast('クリア！ 📸');
      });
    }).catch(function (e) {
      console.error(e);
      toast('保存できませんでした…');
    }).then(function () {
      el.btnShoot.disabled = false;
    });
  }

  var deleteArmed = false;
  var deleteTimer = null;

  function armDelete() {
    if (!deleteArmed) {
      // 誤タップで消えないよう、1回目は確認に変えるだけ
      deleteArmed = true;
      el.btnDelete.textContent = '⚠️ もう一度タップで削除';
      el.btnDelete.classList.add('is-armed');
      clearTimeout(deleteTimer);
      deleteTimer = setTimeout(disarmDelete, 5000);
      return;
    }
    disarmDelete();
    deletePhoto();
  }

  function disarmDelete() {
    deleteArmed = false;
    clearTimeout(deleteTimer);
    el.btnDelete.textContent = '🗑 写真を削除';
    el.btnDelete.classList.remove('is-armed');
  }

  function deletePhoto() {
    var cell = state.openCell;
    if (cell === null) return;
    Store.deletePhoto(weekKey(state.weekIndex), cell).then(function () {
      if (state.urls[cell]) { URL.revokeObjectURL(state.urls[cell]); delete state.urls[cell]; }
      delete state.photos[cell];
      state.weekData.celebrated = bingoLines().length;
      Store.putWeek(state.weekData);
      render();
      closeSheet();
      toast('写真を削除しました');
    });
  }

  function doReroll() {
    var cell = state.openCell;
    if (cell === null || state.photos[cell]) return;
    var used = state.board.map(function (m) { return m.catKey; });
    var next = rerollMission(state.weekIndex, cell, used);
    state.weekData.rerolls[String(cell)] = { catKey: next.catKey, itemIndex: next.itemIndex };
    state.board[cell] = next;
    Store.putWeek(state.weekData).then(function () {
      render();
      openSheet(cell);
      toast('引き直しました 🔄');
    });
  }

  /* ---------- お祝い ---------- */

  function celebrate(lines, full) {
    state.weekData.celebrated = lines;
    Store.putWeek(state.weekData);
    el.celebrateTitle.textContent = full ? 'コンプリート！' : (lines >= 2 ? lines + '本目のビンゴ！' : 'ビンゴ！');
    el.celebrateText.textContent = full
      ? '9マスぜんぶ、よく歩きました。'
      : 'そろいました。おつかれさまです。';
    el.celebrate.hidden = false;
    el.celebrate.classList.add('is-open');
    dropConfetti();
    setTimeout(closeCelebrate, 3600);
  }

  function closeCelebrate() {
    el.celebrate.classList.remove('is-open');
    setTimeout(function () { el.celebrate.hidden = true; el.confetti.innerHTML = ''; }, 300);
  }

  function dropConfetti() {
    var marks = ['🎉', '✨', '🍃', '🌤', '🐦', '🎈'];
    el.confetti.innerHTML = '';
    for (var i = 0; i < 24; i++) {
      var s = document.createElement('span');
      s.textContent = marks[i % marks.length];
      s.style.left = Math.random() * 100 + '%';
      s.style.animationDelay = (Math.random() * 0.6) + 's';
      s.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      el.confetti.appendChild(s);
    }
  }

  var toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('is-open'); }, 1800);
  }

  /* ---------- 書き出し ---------- */

  function safeName(text) {
    return String(text).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '');
  }

  function fileNameOf(record) {
    var d = new Date(record.at);
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes());
    return stamp + '_' + safeName(record.title) + '.jpg';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 同じ日に同じミッション名があってもファイル名が衝突しないようにする
  function uniqueNames(rows) {
    var used = {};
    return rows.map(function (r) {
      var base = fileNameOf(r);
      var name = base;
      var dot = base.lastIndexOf('.');
      var n = 2;
      while (used[name]) name = base.slice(0, dot) + '-' + (n++) + base.slice(dot);
      used[name] = true;
      return { record: r, name: name };
    });
  }

  function buildZip(rows) {
    var named = uniqueNames(rows.slice().sort(function (a, b) { return a.at - b.at; }));
    var list = named.map(function (n) {
      return { name: n.name, data: n.record.blob, date: new Date(n.record.at) };
    });
    // 何をいつ撮ったかのメモも一緒に入れておく
    var memo = named.map(function (n) {
      return [n.name, n.record.title, n.record.category,
        new Date(n.record.at).toLocaleString('ja-JP'), formatRange(weekIndexFrom(n.record))].join('\t');
    });
    memo.unshift(['ファイル名', 'ミッション', 'カテゴリ', '撮影日時', '週'].join('\t'));
    list.push({ name: 'ミッション一覧.txt', data: memo.join('\r\n') + '\r\n', date: new Date() });
    return makeZip(list);
  }

  function weekIndexFrom(record) {
    return typeof record.weekIndex === 'number' ? record.weekIndex : Number(String(record.week).slice(1));
  }

  function zipName(rows) {
    var weeks = rows.map(weekIndexFrom);
    var single = weeks.every(function (w) { return w === weeks[0]; });
    var r = weekRange(single ? weeks[0] : Math.max.apply(null, weeks));
    var stamp = r.start.getFullYear() + '-' + pad(r.start.getMonth() + 1) + '-' + pad(r.start.getDate());
    return 'さんぽビンゴ_' + stamp + (single ? '' : '_まとめて') + '.zip';
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function exportRows(rows, button) {
    if (!rows.length) { toast('書き出す写真がありません'); return; }
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = '書き出し中…'; }
    buildZip(rows).then(function (blob) {
      saveBlob(blob, zipName(rows));
      toast(rows.length + '枚を書き出しました');
    }).catch(function (e) {
      console.error(e);
      toast('書き出せませんでした…');
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = label; }
    });
  }

  // スマホでは、共有シート経由のほうが写真アプリに直接しまえる
  function canSharePhotos(rows) {
    if (!navigator.canShare || !navigator.share || !window.File) return false;
    try {
      return navigator.canShare({ files: [new File([rows[0].blob], 'test.jpg', { type: 'image/jpeg' })] });
    } catch (e) { return false; }
  }

  function sharePhotos(rows, button) {
    var named = uniqueNames(rows.slice().sort(function (a, b) { return a.at - b.at; }));
    var files = named.map(function (n) {
      return new File([n.record.blob], n.name, { type: n.record.blob.type || 'image/jpeg' });
    });
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; }
    navigator.share({ files: files, title: 'さんぽビンゴの写真' }).catch(function (e) {
      if (e && e.name === 'AbortError') return;   // ユーザーが共有をやめただけ
      console.error(e);
      toast('共有できませんでした…');
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = label; }
    });
  }

  /* ---------- アルバム（週ごとのフォルダ） ---------- */

  var albumUrls = [];

  function releaseAlbumUrls() {
    albumUrls.forEach(URL.revokeObjectURL);
    albumUrls = [];
  }

  function albumUrl(blob) {
    var url = URL.createObjectURL(blob);
    albumUrls.push(url);
    return url;
  }

  function renderAlbum() {
    releaseAlbumUrls();
    exitSelectMode();
    el.album.innerHTML = '';
    if (state.albumWeek === null) renderWeekList();
    else renderWeekFolder(state.albumWeek);
  }

  // 週フォルダの一覧。写真は各週1枚しか読まないので、たまっても重くならない。
  function renderWeekList() {
    Store.countByWeek().then(function (counts) {
      var weeks = Object.keys(counts).map(function (key) {
        return { week: key, index: Number(key.slice(1)), count: counts[key] };
      }).sort(function (a, b) { return b.index - a.index; });

      if (!weeks.length) {
        el.album.innerHTML = '<p class="empty">まだ写真がありません。<br>今週のビンゴから始めましょう。</p>';
        return;
      }

      var total = weeks.reduce(function (n, w) { return n + w.count; }, 0);
      el.album.appendChild(exportBar(total));

      var grid = document.createElement('div');
      grid.className = 'folder-grid';
      el.album.appendChild(grid);

      weeks.forEach(function (w) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'folder';
        card.innerHTML =
          '<span class="folder-cover"></span>' +
          '<span class="folder-body">' +
            '<span class="folder-title">' + formatRange(w.index) + '</span>' +
            '<span class="folder-meta">' + w.count + '/' + SIZE + 'マス' +
              (w.index === state.weekIndex ? '<em class="folder-now">今週</em>' : '') + '</span>' +
          '</span>';
        card.addEventListener('click', function () {
          state.albumWeek = w.index;
          renderAlbum();
        });
        grid.appendChild(card);

        Store.getCover(w.week).then(function (rec) {
          if (!rec) return;
          var img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.src = albumUrl(rec.blob);
          card.querySelector('.folder-cover').appendChild(img);
        });
      });
    });
  }

  // 1週ぶんの中身。撮れなかったマスも、そのときの盤面のまま並べる。
  function renderWeekFolder(weekIndex) {
    var key = weekKey(weekIndex);

    Promise.all([Store.getWeek(key), Store.getPhotosOfWeek(key)]).then(function (res) {
      var board = buildBoard(weekIndex, (res[0] && res[0].rerolls) || {});
      var photos = {};
      res[1].forEach(function (r) { photos[r.cell] = r; });

      var head = document.createElement('div');
      head.className = 'folder-head';
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'back-btn';
      back.textContent = '‹ 週の一覧';
      back.addEventListener('click', function () {
        state.albumWeek = null;
        renderAlbum();
      });
      head.appendChild(back);
      var title = document.createElement('h2');
      title.className = 'folder-head-title';
      title.innerHTML = formatRange(weekIndex) +
        '<small>' + res[1].length + '/' + SIZE + 'マス・ビンゴ' + countLines(photos) + '</small>';
      head.appendChild(title);
      el.album.appendChild(head);

      var actions = document.createElement('div');
      actions.className = 'folder-actions';
      var zip = document.createElement('button');
      zip.type = 'button';
      zip.className = 'btn';
      zip.textContent = '⬇️ この週をZIPで書き出す';
      zip.disabled = !res[1].length;
      zip.addEventListener('click', function () { exportRows(res[1], zip); });
      actions.appendChild(zip);

      if (res[1].length && canSharePhotos(res[1])) {
        var pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'btn';
        pick.textContent = '📤 写真を選んで送る';
        pick.addEventListener('click', function () { enterSelectMode(photos); });
        actions.appendChild(pick);
      }
      el.album.appendChild(actions);

      var grid = document.createElement('div');
      grid.className = 'folder-board';
      board.forEach(function (mission, cell) {
        var record = photos[cell];
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'shot' + (record ? '' : ' is-empty');
        item.dataset.cell = String(cell);

        if (record) {
          var url = albumUrl(record.blob);
          item.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(record.title) + '" loading="lazy">' +
            '<span class="shot-check">✓</span>' +
            '<span class="shot-title">' + escapeHtml(record.title) + '</span>';
          item.addEventListener('click', function () {
            if (state.selecting) toggleSelected(cell, item);
            else openViewer(url, record);
          });
        } else {
          item.innerHTML = '<span class="shot-title">' + escapeHtml(mission.title) + '</span>' +
            '<span class="shot-miss">とれなかった</span>';
          item.disabled = true;
        }
        grid.appendChild(item);
      });
      el.album.appendChild(grid);
    });
  }

  function countLines(photos) {
    return LINES.filter(function (line) {
      return line.every(function (c) { return !!photos[c]; });
    }).length;
  }

  /* ---------- 選んで送る ---------- */

  function enterSelectMode(photos) {
    state.selecting = true;
    state.selectable = photos;
    state.selected = {};
    el.album.classList.add('is-selecting');
    el.selectBar.hidden = false;
    updateSelectBar();
  }

  function exitSelectMode() {
    state.selecting = false;
    state.selectable = {};
    state.selected = {};
    el.album.classList.remove('is-selecting');
    el.selectBar.hidden = true;
    // 選択の見た目も戻す
    Array.prototype.forEach.call(el.album.querySelectorAll('.shot.is-picked'), function (node) {
      node.classList.remove('is-picked');
    });
  }

  function toggleSelected(cell, node) {
    if (state.selected[cell]) delete state.selected[cell];
    else state.selected[cell] = true;
    node.classList.toggle('is-picked', !!state.selected[cell]);
    updateSelectBar();
  }

  function selectedRows() {
    return Object.keys(state.selected).map(function (cell) { return state.selectable[cell]; })
      .filter(Boolean)
      .sort(function (a, b) { return a.cell - b.cell; });
  }

  function updateSelectBar() {
    var n = selectedRows().length;
    var all = Object.keys(state.selectable).length;
    el.selectCount.textContent = n ? n + '枚を選択中' : '送る写真をタップ';
    el.btnSelectAll.textContent = (n === all && all > 0) ? 'すべて解除' : 'すべて選ぶ';
    el.btnSendSelected.disabled = n === 0;
    el.btnSendSelected.textContent = n ? '📤 ' + n + '枚を送る' : '📤 送る';
  }

  function toggleSelectAll() {
    var cells = Object.keys(state.selectable);
    var pickAll = selectedRows().length !== cells.length;
    state.selected = {};
    if (pickAll) cells.forEach(function (c) { state.selected[c] = true; });
    Array.prototype.forEach.call(el.album.querySelectorAll('.shot:not(.is-empty)'), function (node) {
      node.classList.toggle('is-picked', !!state.selected[node.dataset.cell]);
    });
    updateSelectBar();
  }

  function sendSelected() {
    var rows = selectedRows();
    if (!rows.length) return;
    sharePhotos(rows, el.btnSendSelected);
  }

  /* ---------- 書き出しの案内 ---------- */

  function exportBar(total) {
    var bar = document.createElement('div');
    bar.className = 'export-bar';

    var text = document.createElement('p');
    text.className = 'export-text';
    text.textContent = '写真' + total + '枚。端末の中にしかないので、ときどき書き出しておくと安心です。';
    bar.appendChild(text);

    var zip = document.createElement('button');
    zip.type = 'button';
    zip.className = 'btn btn-primary';
    zip.textContent = '⬇️ すべてZIPで書き出す';
    zip.addEventListener('click', function () {
      zip.disabled = true;
      Store.getAllPhotos().then(function (rows) {
        zip.disabled = false;
        exportRows(rows, zip);
      }).catch(function () { toast('書き出せませんでした…'); zip.disabled = false; });
    });
    bar.appendChild(zip);
    return bar;
  }

  /* ---------- 写真ビューア ---------- */

  function openViewer(url, record) {
    el.viewerImg.src = url;
    el.viewerCaption.textContent = record.title + '（' + new Date(record.at).toLocaleDateString('ja-JP') + '）';
    el.viewer.hidden = false;
    document.body.classList.add('is-locked');
  }

  function closeViewer() {
    el.viewer.hidden = true;
    el.viewerImg.removeAttribute('src');
    document.body.classList.remove('is-locked');
  }

  function setTab(tab) {
    if (tab !== 'album') state.albumWeek = null;
    state.tab = tab;
    el.viewBoard.hidden = tab !== 'board';
    el.viewAlbum.hidden = tab !== 'album';
    // アルバムを見ている間は「今週」の進捗を出さない（別の週を見ていると紛らわしい）
    el.headline.hidden = tab !== 'board';
    el.stats.hidden = tab !== 'board';
    el.tabBoard.classList.toggle('is-active', tab === 'board');
    el.tabAlbum.classList.toggle('is-active', tab === 'album');
    if (tab === 'album') renderAlbum();
    window.scrollTo(0, 0);
  }

  /* ---------- 読み込み ---------- */

  // ミッション一覧を後から編集しても、すでにクリアしたマスは
  // 「その写真を撮ったときのミッション」を表示しつづける
  function applyClearedMissions() {
    Object.keys(state.photos).forEach(function (cell) {
      var record = state.photos[cell];
      var mission = state.board[cell];
      if (!record || !mission || !record.title || record.title === mission.title) return;
      state.board[cell] = {
        id: record.missionId || mission.id,
        catKey: mission.catKey,
        itemIndex: mission.itemIndex,
        label: record.category || mission.label,
        icon: record.icon || mission.icon,
        title: record.title,
        hint: record.hint || 'この写真を撮ったときのミッションです。'
      };
    });
  }

  function loadWeek() {
    var key = weekKey(state.weekIndex);
    return Store.getWeek(key).then(function (wd) {
      state.weekData = wd;
      state.weekData.rerolls = wd.rerolls || {};
      state.board = buildBoard(state.weekIndex, state.weekData.rerolls);
      return Store.getPhotosOfWeek(key);
    }).then(function (rows) {
      revokeUrls(state.urls);
      state.urls = {};
      state.photos = {};
      rows.forEach(function (r) { state.photos[r.cell] = r; });
      applyClearedMissions();
      render();
    });
  }

  function checkWeekRollover() {
    var now = weekIndexOf(new Date());
    if (now !== state.weekIndex) {
      state.weekIndex = now;
      loadWeek().then(function () {
        toast('新しい週のミッションが届きました 🎁');
        if (state.tab === 'album') renderAlbum();
      });
    } else {
      el.weekLeft.textContent = remainingText(state.weekIndex);
    }
  }

  // ブラウザに「このデータは勝手に消さないで」と申請する。
  // 断られても動作に影響はないので、結果は気にしない。
  function requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) return;
    var check = navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false);
    check.then(function (already) {
      if (!already) return navigator.storage.persist();
    }).catch(function () { /* 使えない環境では何もしない */ });
  }

  function init() {
    ['board', 'headline', 'stats', 'weekRange', 'weekLeft', 'statCleared', 'statBingo', 'progressBar',
      'sheet', 'sheetCat', 'sheetTitle', 'sheetHint', 'sheetPhoto', 'sheetMeta',
      'btnShoot', 'btnPick', 'btnDelete', 'btnReroll', 'btnCloseSheet',
      'fileCamera', 'filePick', 'toast', 'celebrate', 'celebrateTitle', 'celebrateText', 'confetti',
      'viewBoard', 'viewAlbum', 'album', 'tabBoard', 'tabAlbum',
      'viewer', 'viewerImg', 'viewerCaption',
      'selectBar', 'selectCount', 'btnSelectAll', 'btnSendSelected', 'btnCancelSelect'].forEach(function (id) { el[id] = $(id); });

    el.btnShoot.addEventListener('click', function () { el.fileCamera.click(); });
    el.btnPick.addEventListener('click', function () { el.filePick.click(); });
    el.btnDelete.addEventListener('click', armDelete);
    el.btnReroll.addEventListener('click', doReroll);
    el.btnCloseSheet.addEventListener('click', closeSheet);
    el.sheet.addEventListener('click', function (e) { if (e.target === el.sheet) closeSheet(); });

    [el.fileCamera, el.filePick].forEach(function (input) {
      input.addEventListener('change', function () {
        handleFile(input.files && input.files[0]);
        input.value = '';
      });
    });

    el.celebrate.addEventListener('click', closeCelebrate);
    el.viewer.addEventListener('click', closeViewer);
    el.btnSelectAll.addEventListener('click', toggleSelectAll);
    el.btnSendSelected.addEventListener('click', sendSelected);
    el.btnCancelSelect.addEventListener('click', exitSelectMode);
    el.tabBoard.addEventListener('click', function () { setTab('board'); });
    el.tabAlbum.addEventListener('click', function () { setTab('album'); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.viewer.hidden) closeViewer();
      else if (!el.sheet.hidden) closeSheet();
      else if (state.selecting) exitSelectMode();
    });

    loadWeek().catch(function (e) {
      console.error(e);
      el.headline.textContent = 'この端末では写真を保存できないかもしれません…';
      state.board = buildBoard(state.weekIndex, {});
      render();
    });

    requestPersistence();
    setInterval(checkWeekRollover, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkWeekRollover();
    });

    if (!window.SANPO_SINGLE_FILE && 'serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* オフライン対応は任意 */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // テスト用に内部関数を公開
  window.__bingo = {
    stripJpegMetadata: stripJpegMetadata,
    buildBoard: buildBoard, weekIndexOf: weekIndexOf, weekRange: weekRange,
    formatRange: formatRange, pickFromCategory: pickFromCategory, rerollMission: rerollMission
  };
})();
