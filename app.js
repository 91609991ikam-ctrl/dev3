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

  function buildBoard(index, rerolls) {
    var cats = shuffled(CATS, hashString('week:' + index)).slice(0, SIZE);
    // マス番号ではなく週番号だけで引くので、同じミッションはカテゴリの山札
    // （12枚）を一周するまで戻ってこない。
    var board = cats.map(function (cat) {
      return pickFromCategory(cat, index);
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
        canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', 0.82);
      });
    }).catch(function () {
      return file; // 縮小に失敗しても、元の写真は保存する
    });
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
    tab: 'board'
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

    el.sheet.hidden = false;
    document.body.classList.add('is-locked');
    requestAnimationFrame(function () { el.sheet.classList.add('is-open'); });
  }

  function closeSheet() {
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

  /* ---------- アルバム ---------- */

  var albumUrls = [];

  function renderAlbum() {
    albumUrls.forEach(URL.revokeObjectURL);
    albumUrls = [];
    el.album.innerHTML = '';

    Store.getAllPhotos().then(function (rows) {
      if (!rows.length) {
        el.album.innerHTML = '<p class="empty">まだ写真がありません。<br>今週のビンゴから始めましょう。</p>';
        return;
      }
      var groups = {};
      rows.forEach(function (r) {
        var wi = typeof r.weekIndex === 'number' ? r.weekIndex : Number(String(r.week).slice(1));
        (groups[wi] = groups[wi] || []).push(r);
      });
      Object.keys(groups).map(Number).sort(function (a, b) { return b - a; }).forEach(function (wi) {
        var list = groups[wi].sort(function (a, b) { return a.cell - b.cell; });
        var head = document.createElement('h2');
        head.className = 'album-week';
        head.innerHTML = '<span>' + formatRange(wi) + '</span><small>' + list.length + '/' + SIZE + 'マス' +
          (wi === state.weekIndex ? '・今週' : '') + '</small>';
        el.album.appendChild(head);

        var grid = document.createElement('div');
        grid.className = 'album-grid';
        list.forEach(function (r) {
          var url = URL.createObjectURL(r.blob);
          albumUrls.push(url);
          var fig = document.createElement('figure');
          fig.className = 'album-item';
          fig.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(r.title) + '" loading="lazy">' +
            '<figcaption>' + escapeHtml(r.title) + '</figcaption>';
          fig.addEventListener('click', function () { openViewer(url, r); });
          grid.appendChild(fig);
        });
        el.album.appendChild(grid);
      });
    });
  }

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
    state.tab = tab;
    el.viewBoard.hidden = tab !== 'board';
    el.viewAlbum.hidden = tab !== 'album';
    el.tabBoard.classList.toggle('is-active', tab === 'board');
    el.tabAlbum.classList.toggle('is-active', tab === 'album');
    if (tab === 'album') renderAlbum();
    window.scrollTo(0, 0);
  }

  /* ---------- 読み込み ---------- */

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

  function init() {
    ['board', 'headline', 'weekRange', 'weekLeft', 'statCleared', 'statBingo', 'progressBar',
      'sheet', 'sheetCat', 'sheetTitle', 'sheetHint', 'sheetPhoto', 'sheetMeta',
      'btnShoot', 'btnPick', 'btnDelete', 'btnReroll', 'btnCloseSheet',
      'fileCamera', 'filePick', 'toast', 'celebrate', 'celebrateTitle', 'celebrateText', 'confetti',
      'viewBoard', 'viewAlbum', 'album', 'tabBoard', 'tabAlbum',
      'viewer', 'viewerImg', 'viewerCaption'].forEach(function (id) { el[id] = $(id); });

    el.btnShoot.addEventListener('click', function () { el.fileCamera.click(); });
    el.btnPick.addEventListener('click', function () { el.filePick.click(); });
    el.btnDelete.addEventListener('click', deletePhoto);
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
    el.tabBoard.addEventListener('click', function () { setTab('board'); });
    el.tabAlbum.addEventListener('click', function () { setTab('album'); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.viewer.hidden) closeViewer();
      else if (!el.sheet.hidden) closeSheet();
    });

    loadWeek().catch(function (e) {
      console.error(e);
      el.headline.textContent = 'この端末では写真を保存できないかもしれません…';
      state.board = buildBoard(state.weekIndex, {});
      render();
    });

    setInterval(checkWeekRollover, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkWeekRollover();
    });

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
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
    buildBoard: buildBoard, weekIndexOf: weekIndexOf, weekRange: weekRange,
    formatRange: formatRange, pickFromCategory: pickFromCategory, rerollMission: rerollMission
  };
})();
