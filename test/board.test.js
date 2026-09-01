/*
 * 盤面生成のテスト:  node test/board.test.js
 * ブラウザなしで、週ごとのミッション抽選だけを検証する。
 */
const assert = require('assert');
const path = require('path');

global.window = {};
global.document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };
global.location = { protocol: 'file:' };
global.navigator = {};
global.setInterval = () => 0;

require(path.join(__dirname, '..', 'missions.js'));
require(path.join(__dirname, '..', 'app.js'));

const CATS = window.MISSION_CATEGORIES;
const B = window.__bingo;
const WEEKS = 400;
const start = B.weekIndexOf(new Date());

// ミッション名は全体で重複していないこと
const titles = CATS.flatMap(c => c.items.map(i => i.t));
assert.strictEqual(new Set(titles).size, titles.length, 'ミッション名が重複している');
assert.ok(CATS.length >= 9, 'カテゴリは9つ以上必要');

// 消し忘れの穴（[a, , b] のような抜け）や項目落ちがないこと
CATS.forEach(c => {
  assert.ok(c.items.length >= 1, `${c.key}: ミッションが空`);
  c.items.forEach((it, i) => {
    assert.ok(it && it.t && it.h, `${c.key}#${i}: ミッションが欠けている`);
  });
});

const seen = new Map();
const gaps = [];
const used = new Set();

for (let i = 0; i < WEEKS; i++) {
  const week = start + i;
  const board = B.buildBoard(week, {});
  assert.strictEqual(board.length, 9, '盤面は9マス');
  assert.strictEqual(new Set(board.map(m => m.title)).size, 9, `週${week}: 同じミッションが並んでいる`);
  assert.strictEqual(new Set(board.map(m => m.catKey)).size, 9, `週${week}: 同じカテゴリが並んでいる`);
  board.forEach(m => {
    assert.ok(m.title && m.hint && m.icon && m.label, 'ミッションの項目が欠けている');
    used.add(m.title);
    if (seen.has(m.title)) gaps.push(week - seen.get(m.title));
    seen.set(m.title, week);
  });
  // 同じ週なら何度組み立てても同じ盤面になること
  assert.deepStrictEqual(B.buildBoard(week, {}).map(m => m.id), board.map(m => m.id), '盤面が安定していない');
}

const minGap = Math.min(...gaps);
assert.ok(minGap >= 4, `同じミッションが${minGap}週で再登場している`);
assert.strictEqual(used.size, titles.length, `${WEEKS}週で全ミッションが出ていない (${used.size}/${titles.length})`);

// 引き直しは、いま盤面にないカテゴリから引かれること
const board = B.buildBoard(start, {});
const cats = board.map(m => m.catKey);
const rerolled = B.rerollMission(start, 4, cats);
assert.ok(cats.indexOf(rerolled.catKey) === -1, '引き直しが盤面と同じカテゴリを引いた');

// 引き直しは盤面に反映されること
const patched = B.buildBoard(start, { 4: { catKey: rerolled.catKey, itemIndex: rerolled.itemIndex } });
assert.strictEqual(patched[4].title, rerolled.title, '引き直しが盤面に反映されない');

console.log('OK  ミッション', titles.length, '種 /', CATS.length, 'カテゴリ');
console.log('OK ', WEEKS, '週ぶんの盤面: 重複なし・全ミッション登場・再登場は最短', minGap, '週');
console.log('OK  引き直しと盤面の再現性');
