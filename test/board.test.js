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
const WEEKS = 520;
const start = B.weekIndexOf(new Date());

// ミッション名は全体で重複していないこと
const titles = CATS.flatMap(c => c.items.map(i => i.t));
assert.strictEqual(new Set(titles).size, titles.length, 'ミッション名が重複している');
assert.ok(CATS.length >= 2, 'カテゴリが少なすぎる');

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
let weeksWithRepeatedCategory = 0;

for (let i = 0; i < WEEKS; i++) {
  const week = start + i;
  const board = B.buildBoard(week, {});
  assert.strictEqual(board.length, 9, '盤面は9マス');
  assert.strictEqual(new Set(board.map(m => m.title)).size, 9, `週${week}: 同じミッションが並んでいる`);
  board.forEach(m => {
    assert.ok(m.title && m.hint && m.icon && m.label, 'ミッションの項目が欠けている');
    used.add(m.title);
    if (seen.has(m.title)) gaps.push(week - seen.get(m.title));
    seen.set(m.title, week);
  });
  if (new Set(board.map(m => m.catKey)).size < 9) weeksWithRepeatedCategory++;
  // 同じ週なら何度組み立てても同じ盤面になること
  assert.deepStrictEqual(B.buildBoard(week, {}).map(m => m.id), board.map(m => m.id), '盤面が安定していない');
}

// カテゴリは配分せずくじ引きなので、同じジャンルが並ぶ週があるのが正しい
assert.ok(weeksWithRepeatedCategory > WEEKS * 0.5,
  `同じジャンルが並ぶ週が少なすぎる (${weeksWithRepeatedCategory}/${WEEKS})。配分してしまっていないか`);

assert.strictEqual(used.size, titles.length, `${WEEKS}週で全ミッションが出ていない (${used.size}/${titles.length})`);

// 完全ランダムなので短い間隔での再登場は起きうるが、めったに起きないこと
gaps.sort((a, b) => a - b);
const median = gaps[Math.floor(gaps.length / 2)];
const soon = gaps.filter(g => g <= 4).length;
assert.ok(median >= 12, `再登場の中央値が短すぎる (${median}週)`);
assert.ok(soon / gaps.length < 0.02, `4週以内の再登場が多すぎる (${soon}/${gaps.length})`);

// 引き直しは、いま盤面にないカテゴリから引かれること
const board = B.buildBoard(start, {});
const cats = board.map(m => m.catKey);
const rerolled = B.rerollMission(start, 4, cats);
assert.ok(cats.indexOf(rerolled.catKey) === -1, '引き直しが盤面と同じカテゴリを引いた');

// 引き直しは盤面に反映されること
const patched = B.buildBoard(start, { 4: { catKey: rerolled.catKey, itemIndex: rerolled.itemIndex } });
assert.strictEqual(patched[4].title, rerolled.title, '引き直しが盤面に反映されない');

console.log('OK  ミッション', titles.length, '種 /', CATS.length, 'カテゴリ');
console.log('OK ', WEEKS, '週ぶん: 週内の重複なし・全ミッション登場・盤面は再現可能');
console.log('OK  ジャンルはくじ引き:', weeksWithRepeatedCategory, '週で同じジャンルが2マス以上');
console.log('OK  再登場の間隔: 中央値', median, '週 / 4週以内は', soon, '/', gaps.length, '回');
console.log('OK  引き直し');
