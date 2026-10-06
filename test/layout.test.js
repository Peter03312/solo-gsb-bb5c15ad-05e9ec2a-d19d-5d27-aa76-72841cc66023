'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeLayout, validateStructure, validateRules } = require('../src/layout');

const RULES = { max_chars: 10, min_duration_ms: 1000, max_cps: 10 };

function W(list) {
  // [[text, start, end], ...] -> words
  return list.map(([text, start_ms, end_ms], idx) => ({ idx, text, start_ms, end_ms }));
}

test('基本排版：覆盖全部词、不重叠、含词时段', () => {
  const words = W([
    ['hello', 0, 400], ['world', 450, 900],
    ['foo', 1500, 1900], ['bar', 1950, 2400],
  ]);
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 12, min_duration_ms: 500, max_cps: 20 }, locked: [] });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  // 覆盖：每词恰好一次
  const covered = new Array(words.length).fill(0);
  for (const c of r.cues) for (let k = c.word_start; k <= c.word_end; k++) covered[k]++;
  assert.deepEqual(covered, [1, 1, 1, 1]);
  // 不重叠 & 词时段未被缩短
  for (let i = 0; i < r.cues.length; i++) {
    const c = r.cues[i];
    if (i > 0) assert.ok(r.cues[i - 1].end_ms <= c.start_ms, '字幕重叠');
    assert.ok(c.start_ms <= words[c.word_start].start_ms);
    assert.ok(c.end_ms >= words[c.word_end].end_ms);
  }
  assert.equal(validateStructure(r.cues, words, []).length, 0);
});

test('最大字数：超出即断，不跨 max_chars', () => {
  const words = W([
    ['aaaa', 0, 300], ['bbbb', 350, 700], ['cccc', 750, 1100], ['dddd', 1150, 1500],
  ]);
  // max_chars=10：'aaaa bbbb' = 9，再加 ' cccc' 变 14 > 10 → 两条
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 10, min_duration_ms: 0, max_cps: 20 }, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, 'aaaa bbbb');
  assert.equal(r.cues[1].text, 'cccc dddd');
});

test('CJK 拼接不加空格', () => {
  const words = W([['你好', 0, 500], ['世界', 550, 1000]]);
  const r = computeLayout({ words, cuts: [], rules: RULES, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues[0].text, '你好世界');
});

test('镜头切点：强制断开，不跨切点', () => {
  const words = W([
    ['aaa', 0, 500], ['bbb', 550, 1000], ['ccc', 1500, 2000], ['ddd', 2050, 2500],
  ]);
  const r = computeLayout({ words, cuts: [1200], rules: RULES, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues.length, 2);
  assert.deepEqual([r.cues[0].word_start, r.cues[0].word_end], [0, 1]);
  assert.deepEqual([r.cues[1].word_start, r.cues[1].word_end], [2, 3]);
  for (const c of r.cues) assert.ok(!(c.start_ms < 1200 && 1200 < c.end_ms), '跨切点');
});

test('切点落在词内部 → 报告冲突，不输出结果', () => {
  const words = W([['hello', 0, 1000], ['world', 1050, 1500]]);
  const r = computeLayout({ words, cuts: [500], rules: RULES, locked: [] });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, 'cut_inside_word');
  assert.equal(r.conflicts[0].word_start, 0);
  assert.match(r.conflicts[0].message, /500ms/);
  assert.match(r.conflicts[0].message, /跨镜头切点/);
});

test('最短时长：向后扩展空闲间隙', () => {
  // max_chars=1 → 每词一条；第一条 [0,300] 需扩到 1000ms，后方间隙足够
  const words = W([['短', 0, 300], ['词', 2000, 2400]]);
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 10 }, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues[0].end_ms - r.cues[0].start_ms, 1000); // 300 扩到 1000
  assert.ok(r.cues[0].end_ms <= r.cues[1].start_ms);
});

test('最短时长无法满足 → 报告受影响词段与条件', () => {
  // 两词紧贴，各 300ms，最短 1000ms → 第一条最多扩到 1000ms（第二词 start），刚好够；
  // 把第二词提前到 500ms：第一条可用空间只有 500ms < 1000ms → 冲突
  const words = W([['甲', 0, 300], ['乙', 500, 800]]);
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 10 }, locked: [] });
  assert.equal(r.ok, false);
  const c = r.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, '应有 duration 冲突');
  assert.equal(c.word_start, 0);
  assert.match(c.message, /1000ms/);
});

test('相邻字幕联合分配：前条向前借位，给后条留出切点前显示时间', () => {
  // 题目场景：max_chars=1 → 每词一条；A、B 各需 600ms，切点 1700。
  // 旧算法先把 A 向后延到 [1000,1600]，B 在 [1100,1700] 只剩 200ms 可用 → 误报冲突。
  // 正确做法：A 提前到 [500,1100]，B 取 [1100,1700]。
  const words = W([['A', 1000, 1100], ['B', 1500, 1600]]);
  const r = computeLayout({
    words, cuts: [1700],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[500, 1100], [1100, 1700]]
  );
  for (const c of r.cues) {
    assert.ok(c.end_ms - c.start_ms >= 600);
    assert.ok(!(c.start_ms < 1700 && 1700 < c.end_ms), '跨切点');
    assert.ok(c.start_ms <= words[c.word_start].start_ms);
    assert.ok(c.end_ms >= words[c.word_end].end_ms);
  }
});

test('联合分配：切点恰等于后段首词开始时允许相接（floor 不错误抬高）', () => {
  // 切点 1500 == B.start 且在两词间隙：A 必须在 1500 前结束、B 可从 1500 起
  // （S 与切点相接合法，floor 不应错误地抬到切点之后）。
  // A 需 600：[900,1500]；B 需 600，右侧无切点：[1500,2100]
  const words = W([['A', 1000, 1100], ['B', 1500, 1600]]);
  const r = computeLayout({
    words, cuts: [1500],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[900, 1500], [1500, 2100]]
  );
});

test('联合分配：切点夹在两词之间且两侧都需要借位时，前条贴切点结束', () => {
  // 切点 1300 在间隙 (1100,1500)：A 最迟 1300 结束、需 600 → A[700,1300]；
  // B 默认从其首词开始 1500（已在切点之后，无需提前），向后延到 [1500,2100]
  const words = W([['A', 1000, 1100], ['B', 1500, 1600]]);
  const r = computeLayout({
    words, cuts: [1300],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[700, 1300], [1500, 2100]]
  );
  assert.equal(validateStructure(r.cues, words, [1300]).length, 0);
});

test('联合分配：后条必须向左借过间隙切点时，切点成为其后条开始下界', () => {
  // 切点 1300 在间隙；B 词时段 [1250,1350]？——不，词不跨切点。构造：
  // B[1500,1600] 右侧 1650 再有切点，B 需 600 → 必须向左借；切点 1300 为下界，
  // A 又在 [1000,1100] 需 600：整体无解（B 窗口 [1300,1650]=350ms）→ 冲突
  const words = W([['A', 1000, 1100], ['B', 1500, 1600]]);
  const r = computeLayout({
    words, cuts: [1300, 1650],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.type === 'duration'));
});

test('联合分配：无切点约束时前条仍优先向后延长到空闲间隙', () => {
  // 与"向后扩展空闲间隙"行为一致：没有后条挤压时，A 仍向后延，不提前
  const words = W([['甲', 0, 300], ['乙', 2000, 2400]]);
  const r = computeLayout({
    words, cuts: [], rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 10 }, locked: [],
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.cues[0].start_ms, r.cues[0].end_ms], [0, 1000]);
});

test('联合分配：三条链同时挤压时逐段借位，互不重叠且不跨切点', () => {
  // A/B/C 各需 600ms；切点 2200。三段默认延长会逐级挤占，联合分配应：
  // C 卡切点 [1600,2200]，B 提前 [1000,1600]，A 提前 [400,1000]
  const words = W([['A', 900, 1000], ['B', 1400, 1500], ['C', 1900, 2000]]);
  const r = computeLayout({
    words, cuts: [2200],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[400, 1000], [1000, 1600], [1600, 2200]]
  );
  assert.equal(validateStructure(r.cues, words, [2200]).length, 0);
});

test('联合分配：链条总空间确实不足时仍报 duration 冲突，且冲突窗口说明正确', () => {
  // A[0,300]、B[500,800]：第一段窗口 [0,500] 仅 500ms，需 1000ms；
  // B 自身右侧虽有空闲，但 A 最多只能借到 B 开始（非重叠），整体仍无解
  const words = W([['甲', 0, 300], ['乙', 500, 800]]);
  const r = computeLayout({
    words, cuts: [], rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 10 }, locked: [],
  });
  assert.equal(r.ok, false);
  const c = r.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, '应有 duration 冲突');
  assert.equal(c.word_start, 0);
  assert.match(c.message, /1000ms/);
  assert.match(c.message, /可用空间只有 500ms/);
});

test('锁定行隔开的区域各自独立分配，锁定时间原样保留', () => {
  // 锁定行 [0,0] 固定 [1000,1100]；其后的 B[1500,1600] 独立成区，切点 1700。
  // B 需 600ms、下限 1100，可排 [1100,1700]；锁定行时间一个毫秒都不变
  const words = W([['A', 1000, 1100], ['B', 1500, 1600]]);
  const locked = [{ word_start: 0, word_end: 0, text: 'A', start_ms: 1000, end_ms: 1100 }];
  const r = computeLayout({
    words, cuts: [1700],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked,
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  const lk = r.cues.find((c) => c.locked === 1);
  assert.deepEqual([lk.start_ms, lk.end_ms], [1000, 1100]);
  const b = r.cues.find((c) => c.word_start === 1);
  assert.deepEqual([b.start_ms, b.end_ms], [1100, 1700]);
});

test('每秒字数：密集词段无法拆分 → 冲突', () => {
  // 一个词 10 字占 500ms = 20 字/秒，上限 10 → 需要 1000ms；后无空间（被切点卡住）
  const words = W([['一二三四五六七八九十', 0, 500], ['尾', 1500, 1800]]);
  const r = computeLayout({
    words, cuts: [600], rules: { max_chars: 30, min_duration_ms: 0, max_cps: 10 }, locked: [],
  });
  assert.equal(r.ok, false);
  const c = r.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, '应有 duration/cps 冲突');
  assert.match(c.message, /每秒最多 10 字/);
});

test('单词超过最大字数 → 冲突', () => {
  const words = W([['超长的词超过限制', 0, 1000]]);
  const r = computeLayout({ words, cuts: [], rules: { ...RULES, max_chars: 4 }, locked: [] });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].type, 'max_chars');
});

test('锁定字幕原样保留，只重排未锁定词段', () => {
  const words = W([
    ['a', 0, 400], ['b', 450, 900],           // 锁定区间
    ['c', 2000, 2400], ['d', 2450, 2900],     // 未锁定
    ['e', 4000, 4400], ['f', 4450, 4900],     // 未锁定
  ]);
  const locked = [{ word_start: 0, word_end: 1, text: '手工校对 a b', start_ms: 0, end_ms: 1200 }];
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 5, min_duration_ms: 500, max_cps: 20 }, locked });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  const lockedCue = r.cues.find((c) => c.locked === 1);
  assert.equal(lockedCue.text, '手工校对 a b');
  assert.equal(lockedCue.end_ms, 1200); // 未被改动
  // 未锁定部分被重排（max_chars=5 → 'c d' 一条、'e f' 一条）
  const fresh = r.cues.filter((c) => c.locked === 0);
  assert.equal(fresh.length, 2);
  // 重排结果不得与锁定字幕重叠
  assert.ok(fresh[0].start_ms >= 1200);
});

test('锁定字幕互相重叠 → 冲突', () => {
  const words = W([['a', 0, 400], ['b', 450, 900], ['c', 1000, 1400]]);
  const locked = [
    { word_start: 0, word_end: 1, text: 'x', start_ms: 0, end_ms: 900 },
    { word_start: 1, word_end: 2, text: 'y', start_ms: 800, end_ms: 1400 },
  ];
  const r = computeLayout({ words, cuts: [], rules: RULES, locked });
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.type === 'locked_overlap'));
});

test('validateRules 检出锁定字幕的规则违例（导出前把关）', () => {
  const cues = [{ word_start: 0, word_end: 0, text: '十二个字的一段字幕文本内容', start_ms: 0, end_ms: 500, locked: 1 }];
  const problems = validateRules(cues, { max_chars: 5, min_duration_ms: 1000, max_cps: 10 });
  assert.equal(problems.length, 3); // 字数、时长、cps 各一
  assert.ok(problems.every((p) => p.message.includes('已锁定')));
});
