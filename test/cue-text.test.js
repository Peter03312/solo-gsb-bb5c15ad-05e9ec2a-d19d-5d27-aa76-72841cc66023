'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');
const { cueTextProblem, isCueTextSafe, cueRowTextProblems, toWebVtt, parseWebVtt } = require('../src/vtt');

let server;
let base;
let db;

before(async () => {
  db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '正文无损测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

// ---------- 纯函数：可无损冻结判定 ----------

test('cueTextProblem：合法段内单换行/普通文本/空载荷通过', () => {
  for (const t of ['你好', '第一行\n第二行', 'a\nb\nc', '']) {
    assert.equal(cueTextProblem(t), null, `${JSON.stringify(t)} 应可无损写入`);
    assert.equal(isCueTextSafe(t), true);
  }
});

test('cueTextProblem：首尾换行/段内空白行/回车/纯空白被指出具体行', () => {
  const cases = [
    ['\n你好', 'head', 1],
    ['\n\n你好', 'head', 1],
    ['你好\n', 'tail', 2],
    ['你好\n\n', 'tail', 2],
    ['你好\n\n世界', 'line', 2],
    ['a\nb\n\nc', 'line', 3],
    ['a\n \nc', 'line', 2],
    ['你好\r\n世界', 'line', 1],
    ['  ', 'line', 1],
    ['\t', 'line', 1],
  ];
  for (const [text, label, index] of cases) {
    const p = cueTextProblem(text);
    assert.ok(p, `${JSON.stringify(text)} 应被拒绝`);
    assert.equal(p.label, label, `${JSON.stringify(text)} label`);
    assert.equal(p.index, index, `${JSON.stringify(text)} 行号`);
    assert.match(p.reason, /WebVTT|空白|回车/);
  }
});

test('toWebVtt：合法段内换行可往返；非法正文直接抛错而不静默丢字', () => {
  const cues = [
    { start_ms: 0, end_ms: 1000, text: '第一行\n第二行' },
    { start_ms: 1500, end_ms: 2500, text: '结尾' },
  ];
  const vtt = toWebVtt(cues);
  const parsed = parseWebVtt(vtt);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.deepEqual(parsed.cues.map((c) => c.text), ['第一行\n第二行', '结尾']);

  assert.throws(() => toWebVtt([{ start_ms: 0, end_ms: 1000, text: '坏\n' }]), /尾部空行/);
  assert.throws(() => toWebVtt([{ start_ms: 0, end_ms: 1000, text: '\n坏' }]), /首部空行/);
  assert.throws(() => toWebVtt([{ start_ms: 0, end_ms: 1000, text: 'a\n\nb' }]), /空白行/);
});

test('cueRowTextProblems：列出字幕行问题并给出 idx/行号/原因', () => {
  const rows = [
    { id: 1, idx: 0, word_start: 0, word_end: 0, text: '好' },
    { id: 2, idx: 1, word_start: 1, word_end: 1, text: '坏\n\n尾' },
    { id: 3, idx: 2, word_start: 2, word_end: 2, text: '\n首坏' },
  ];
  const problems = cueRowTextProblems(rows);
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((q) => q.subtitle_id), [2, 3]);
  assert.equal(problems[0].idx, 1);
  assert.equal(problems[0].line, 2);
  assert.match(problems[0].message, /字幕 2/);
});

// ---------- 项目导入 ----------

test('导入：词文本含段内空白行/回车 → 422 指出词序号与行', async () => {
  const badBodies = [
    [{ text: '你\r好', start_ms: 0, end_ms: 500 }, GOOD_WORDS[1], GOOD_WORDS[2], GOOD_WORDS[3]],
    [{ text: '你好\n\n世界', start_ms: 0, end_ms: 2000 }, GOOD_WORDS[2], GOOD_WORDS[3]],
    [{ text: 'a\n\rb', start_ms: 0, end_ms: 500 }, GOOD_WORDS[1], GOOD_WORDS[2], GOOD_WORDS[3]],
  ];
  for (const words of badBodies) {
    const r = await api('/api/projects', 'POST', { name: '坏导入', words, cuts: [] });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.ok(r.body.errors.some((e) => /WebVTT|空白行|回车/.test(e)), JSON.stringify(r.body.errors));
  }
});

test('导入：词文本的首尾空白/换行被 trim 规范化，可正常导入', async () => {
  const words = [
    { text: '\n你好\n', start_ms: 0, end_ms: 500 },
    { text: '  世界  ', start_ms: 550, end_ms: 1000 },
    GOOD_WORDS[2], GOOD_WORDS[3],
  ];
  const created = await api('/api/projects', 'POST', { name: '首尾空白导入', words, cuts: [1200] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.words[0].text, '你好');
  assert.equal(created.body.words[1].text, '世界');
});

test('导入：词文本含合法段内单换行可以导入并排版导出', async () => {
  const words = [
    { text: '第一行\n第二行', start_ms: 0, end_ms: 1000 },
    { text: '再来', start_ms: 1500, end_ms: 2500 },
  ];
  const created = await api('/api/projects', 'POST', { name: '多行正文', words, cuts: [] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200);
  const exported = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: layout.body.sub_version });
  assert.equal(exported.status, 201, JSON.stringify(exported.body));
  const parsed = parseWebVtt(exported.body.content);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.cues.some((c) => c.text.includes('第一行\n第二行')));
});

// ---------- 字幕编辑 ----------

test('字幕编辑：首尾换行/段内空白行/回车 → 422 指出行，且不改数据', async () => {
  const { pid, cues } = await setupProject();
  for (const bad of ['\n首部换行', '尾部换行\n', '中间\n\n空白行', '回车\r\n坏']) {
    const r = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
      version: cues[0].version, text: bad,
    });
    assert.equal(r.status, 422, `${JSON.stringify(bad)} => ${JSON.stringify(r.body)}`);
    assert.ok(r.body.errors.join('；').includes('WebVTT'));
  }
  const view = await api(`/api/projects/${pid}`);
  assert.equal(view.body.subtitles[0].text, cues[0].text, '被拒文本不得落库');
});

test('字幕编辑：段内单换行合法，可保存并无损导出', async () => {
  const { pid, cues } = await setupProject();
  const r = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, text: '上行\n下行',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const exported = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: r.body.sub_version });
  assert.equal(exported.status, 201);
  const parsed = parseWebVtt(exported.body.content);
  assert.equal(parsed.cues[0].text, '上行\n下行');
});

// ---------- 批量修订提议 ----------

test('修订提交：非法正文 → 400 不保存提议；预览/采纳对历史坏提议 → 422', async () => {
  const { pid, cues } = await setupProject();
  const submit = async (text) => api(`/api/projects/${pid}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: cues[0].version, text }],
  });

  for (const bad of ['\n开头空行', '结尾空行\n', '中\n\n空行']) {
    const r = await submit(bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} => ${JSON.stringify(r.body)}`);
    assert.ok(r.body.errors.join('；').includes('WebVTT'));
  }
  const list = await api(`/api/projects/${pid}/revisions`);
  assert.equal(list.body.length, 0, '非法提议不得保存');

  // 合法的段内单换行可提交、预览通过
  const ok = await submit('合法\n多行');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const preview = await api(`/api/projects/${pid}/revisions/${ok.body.id}/preview`, 'POST');
  assert.equal(preview.body.evaluation.ok, true, JSON.stringify(preview.body.evaluation));
  const accept = await api(`/api/projects/${pid}/revisions/${ok.body.id}/accept`, 'POST');
  assert.equal(accept.status, 200, JSON.stringify(accept.body));

  // 历史坏提议（绕过提交校验直接落库）：预览报 cue_text_unsafe，采纳 422 整组不生效
  const badRid = db.transaction(() => {
    const rid = db.prepare(
      'INSERT INTO revisions (project_id, note, rules_version_snapshot, sub_version_snapshot) VALUES (?, ?, ?, ?)'
    ).run(pid, '旧坏提议', 1, accept.body.sub_version).lastInsertRowid;
    db.prepare(
      `INSERT INTO revision_items
         (revision_id, ord, subtitle_id, cue_version, orig_text, orig_start_ms, orig_end_ms,
          proposed_text, start_ms, end_ms)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(rid, cues[0].id, accept.body.subtitles[0].version,
      '合法\n多行', cues[0].start_ms, cues[0].end_ms, '坏文本\n');
    return rid;
  })();
  const badPreview = await api(`/api/projects/${pid}/revisions/${badRid}/preview`, 'POST');
  assert.ok(badPreview.body.evaluation.items[0].conflicts.some((c) => c.type === 'cue_text_unsafe'));
  const badAccept = await api(`/api/projects/${pid}/revisions/${badRid}/accept`, 'POST');
  assert.equal(badAccept.status, 422, JSON.stringify(badAccept.body));
  const after = await api(`/api/projects/${pid}`);
  assert.notEqual(after.body.subtitles[0].text, '坏文本\n');
});

// ---------- 译文单条保存 / 确认 ----------

test('译文保存：非法正文 → 422 指出行且不写入；段内单换行可保存', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`;
  for (const bad of ['\nHead blank', 'Trailing\n', 'Mid\n\nblank']) {
    const r = await api(url, 'PUT', { text: bad, cue_version: cues[0].version });
    assert.equal(r.status, 422, `${JSON.stringify(bad)} => ${JSON.stringify(r.body)}`);
    assert.ok(r.body.errors.join('；').includes('WebVTT'));
  }
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2);

  const ok = await api(url, 'PUT', { text: 'Line one\nLine two', cue_version: cues[0].version });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('译文确认：待复核历史坏译文无法无损冻结时 → 422', async () => {
  const { pid, cues } = await setupProject();
  // 直接落一条 review 的坏译文（旧库场景）
  db.prepare(
    `INSERT INTO translations
       (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
        src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
     VALUES (?, 'ja', ?, ?, 'review', 2, ?, ?, ?, ?, ?, ?, 1)`
  ).run(pid, cues[0].id, '日本語\n', 1, '旧原文', cues[0].start_ms, cues[0].end_ms,
    cues[0].word_start, cues[0].word_end);
  const r = await api(`/api/projects/${pid}/translations/ja/subtitles/${cues[0].id}/confirm`, 'POST', { version: 2 });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.ok(r.body.errors.join('；').includes('WebVTT'));
  const kept = db.prepare('SELECT status FROM translations WHERE lang = ?').get('ja');
  assert.equal(kept.status, 'review', '确认被拒不得改状态');
});

// ---------- 整批回填 ----------

test('整批回填：非法正文 → 422 按行给原因，整批不写入不占编号', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const body = {
    batch_no: 'B-BAD-1', sub_version, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hello world' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Bad\n' },
    ],
  };
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', body);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  const bad = r.body.items.find((it) => it.subtitle_id === cues[1].id);
  assert.equal(bad.state, 'invalid');
  assert.ok(bad.reasons.join('；').includes('WebVTT'));
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '整批回退不得写入任何译文');
  const batches = await api(`/api/projects/${pid}/translations/en/batches/list`);
  assert.equal(batches.body.batches.length, 0, '失败批次不占编号');

  // 修正后同一编号可成功提交
  body.batch_no = 'B-BAD-1';
  body.items[1].text = 'Welcome';
  const retry = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', body);
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
});

// ---------- 历史恢复 ----------

test('历史恢复：候选译文正文无法无损冻结 → invalid 422，整组不写', async () => {
  const { pid, cues } = await setupProject();
  const histId = db.prepare(
    `INSERT INTO translations
       (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
        src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
     VALUES (?, 'de', NULL, ?, 'history', 1, ?, ?, ?, ?, ?, ?, 1)`
  ).run(pid, 'Hallo\n', cues[0].version, cues[0].text,
    cues[0].start_ms, cues[0].end_ms, cues[0].word_start, cues[0].word_end).lastInsertRowid;
  const r = await api(`/api/projects/${pid}/translations/de/recover`, 'POST', {
    sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[0].id, cue_version: cues[0].version, translation_id: histId, version: 1 }],
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.items[0].state, 'invalid');
  assert.ok(r.body.items[0].reasons.join('；').includes('WebVTT'));
  const active = db.prepare(
    "SELECT COUNT(*) AS n FROM translations WHERE lang = 'de' AND status != 'history'"
  ).get().n;
  assert.equal(active, 0);
});

// ---------- 旧库坏数据：导出闸门 ----------

/** 直接在 DB 中把一条现有字幕改成“旧库坏正文”，模拟收紧限制前已落库的数据（不改时间/词区间） */
function corruptSubtitle(pid, subtitleId, text) {
  db.prepare('UPDATE subtitles SET text = ? WHERE id = ? AND project_id = ?').run(text, subtitleId, pid);
}

test('原文导出：旧库坏正文 → 422 明确列出问题行，不占版本；修正后可导出', async () => {
  const { pid, cues } = await setupProject();
  corruptSubtitle(pid, cues[1].id, '旧坏\n文本\n');
  const rejected = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(rejected.status, 422);
  const unsafe = rejected.body.conflicts.filter((c) => c.type === 'cue_text_unsafe');
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0].subtitle_id, cues[1].id);
  assert.ok(unsafe[0].line >= 1);
  assert.match(unsafe[0].message, /字幕/);
  const list = await api(`/api/projects/${pid}/exports`);
  assert.equal(list.body.length, 0, '拒绝不得占用导出版本');

  // 修正文后照常导出
  const fixed = await api(`/api/projects/${pid}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, text: '修好的文本',
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const ok = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: fixed.body.sub_version });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('单语言导出：源坏行或坏译文 → 422 分类列出，不生成快照', async () => {
  const { pid, cues } = await setupProject();

  // 1) 坏译文（current）→ invalid
  db.prepare(
    `INSERT INTO translations
       (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
        src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
     VALUES (?, 'fr', ?, 'Bonjour\n', 'current', 1, ?, ?, ?, ?, ?, ?, 1)`
  ).run(pid, cues[0].id, cues[0].version, cues[0].text,
    cues[0].start_ms, cues[0].end_ms, cues[0].word_start, cues[0].word_end);
  const badTr = await api(`/api/projects/${pid}/translations/fr/exports`, 'POST', {});
  assert.equal(badTr.status, 422, JSON.stringify(badTr.body));
  assert.equal(badTr.body.invalid.length, 1);
  assert.ok(badTr.body.invalid[0].reasons.join('；').includes('WebVTT'));
  assert.equal(badTr.body.invalid[0].subtitle_id, cues[0].id);

  // 修好译文
  const fixed = await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`, 'PUT', {
    text: 'Bonjour', cue_version: cues[0].version, version: 1,
  });
  assert.equal(fixed.status, 200);
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`, 'PUT', {
    text: 'Bienvenue', cue_version: cues[1].version,
  });

  // 2) 源行损坏 → conflicts 列 cue_text_unsafe，仍不生成快照
  corruptSubtitle(pid, cues[1].id, '\n源坏');
  const badSrc = await api(`/api/projects/${pid}/translations/fr/exports`, 'POST', {});
  assert.equal(badSrc.status, 422);
  assert.ok(badSrc.body.conflicts.some((c) => c.type === 'cue_text_unsafe'));
  const list = await api(`/api/projects/${pid}/translations/fr/exports`);
  assert.equal(list.body.length, 0);
});

test('多语交付：任一坏行 → 422 整批失败，不占任何导出版本', async () => {
  const { pid, cues, sub_version } = await setupProject();

  // 两种语言都有合规译文
  for (const lang of ['en', 'ja']) {
    for (const cue of cues) {
      const r = await api(`/api/projects/${pid}/translations/${lang}/subtitles/${cue.id}`, 'PUT', {
        text: lang === 'en' ? `T${cue.id}` : `訳${cue.id}`, cue_version: cue.version,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
  }
  const deliverBody = (lang) => ({
    sub_version, rules_version: 1, languages: [lang],
    translations: { [lang]: cues.map((c) => ({ subtitle_id: c.id, version: 1 })) },
  });

  // 1) 源正文坏 → conflicts
  corruptSubtitle(pid, cues[1].id, '源\n\n坏');
  const badSrc = await api(`/api/projects/${pid}/deliveries`, 'POST', deliverBody('en'));
  assert.equal(badSrc.status, 422, JSON.stringify(badSrc.body));
  assert.ok(badSrc.body.conflicts.some((c) => c.type === 'cue_text_unsafe'));

  // 2) 译文坏（直接改库）→ 语言级 invalid
  db.prepare("UPDATE translations SET text = 'EN BAD\n' WHERE lang = 'en' AND subtitle_id = ?")
    .run(cues[0].id);
  const badTr = await api(`/api/projects/${pid}/deliveries`, 'POST', deliverBody('en'));
  assert.equal(badTr.status, 422);
  const en = badTr.body.languages.find((l) => l.lang === 'en');
  assert.equal(en.invalid.length, 1);
  assert.ok(en.invalid[0].reasons.join('；').includes('WebVTT'));

  // 整批失败：没有任何导出/批次落库
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/ja/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.batches.length, 0);

  // 修正后整批成功（源行与译文都修好）
  db.prepare("UPDATE translations SET text = ? WHERE lang = 'en' AND subtitle_id = ?")
    .run('T' + cues[0].id, cues[0].id);
  corruptSubtitle(pid, cues[1].id, cues[1].text);
  const fresh = await api(`/api/projects/${pid}`);
  const ok = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    ...deliverBody('en'), sub_version: fresh.body.sub_version,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.files.length, 2);
});

// ---------- 署名版导出 ----------

test('署名版导出：源坏行 → 422 conflicts+rows 列出；修正后可导出', async () => {
  const { pid, cues, sub_version } = await setupProject();
  // 建说话人并逐行归属
  const sp = await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  assert.equal(sp.status, 201);
  const attr = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: cues.map((c) => ({ subtitle_id: c.id, cue_version: c.version, speaker_number: 1 })),
  });
  assert.equal(attr.status, 201, JSON.stringify(attr.body));

  corruptSubtitle(pid, cues[1].id, '署名\n坏\n');
  const rejected = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: sub_version, attribution_version: attr.body.attribution_version,
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  assert.ok(rejected.body.conflicts.some((c) => c.type === 'cue_text_unsafe'));
  assert.ok(rejected.body.rows.some((r) => r.codes.includes('cue_text_unsafe')));
  const list = await api(`/api/projects/${pid}/attributed-exports`);
  assert.equal(list.body.exports.length, 0);

  // 修正源行后可照常署名导出
  const fixed = await api(`/api/projects/${pid}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, text: '署名好',
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const ok = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: fixed.body.sub_version, attribution_version: attr.body.attribution_version,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('署名译文导出：坏译文 → 422 按行 translation_invalid', async () => {
  const { pid, cues, sub_version } = await setupProject();
  await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  const attr = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: cues.map((c) => ({ subtitle_id: c.id, cue_version: c.version, speaker_number: 1 })),
  });
  for (const cue of cues) {
    await api(`/api/projects/${pid}/translations/en/subtitles/${cue.id}`, 'PUT', {
      text: `EN ${cue.id}`, cue_version: cue.version,
    });
  }
  db.prepare("UPDATE translations SET text = 'BAD\n' WHERE lang = 'en' AND subtitle_id = ?")
    .run(cues[0].id);

  const rejected = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attr.body.attribution_version, lang: 'en',
    translations: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  const row = rejected.body.rows.find((r) => r.subtitle_id === cues[0].id);
  assert.ok(row.codes.includes('translation_invalid'));
  assert.ok(row.reasons.join('；').includes('WebVTT'));
});
