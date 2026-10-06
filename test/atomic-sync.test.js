'use strict';

/**
 * 原子提交与一致对账（重新导入 / 重排 / 单条编辑）：
 *   - 每次操作的词/切点或字幕写入、版本推进（sub_version / import_version）与
 *     译文、说话人归属、复核意见的状态对账合并为一次原子提交；
 *   - 成功后立刻查询即得一致结果：删除行译文/归属留历史；源文本/时间变化 →
 *     当前译文待复核、已关闭且快照漂移的意见待复核；重新导入前的意见转历史；
 *     纯锁定或展示顺序变化不误判失效；
 *   - 任一步数据库写入或对账失败 → 整次操作连同版本一起回滚，不留半提交，
 *     用户可基于旧版本重试。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function startServer(db) {
  const app = createApp(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { server, api };
}

/**
 * 可开关的失败注入：matcher 命中某条 SQL 时 prepare 抛错，模拟“任一步数据库
 * 写入或对账失败”。事务回滚后清除注入即可按旧版本重试。
 */
function makeFailureInjector(db) {
  const state = { matcher: null };
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql, ...args) => {
          if (state.matcher && state.matcher(sql)) {
            throw new Error('注入的数据库失败（模拟写入/对账失败）');
          }
          return target.prepare(sql, ...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db: proxied,
    failOn: (matcher) => { state.matcher = matcher; },
    clear: () => { state.matcher = null; },
  };
}

/**
 * 准备完整状态：2 条字幕（词0-1 / 词2-3），每行均有 en 译文（current）、
 * 说话人归属（active），每条词区间各有一条已关闭复核意见。
 */
async function setupFull(api) {
  const created = await api('/api/projects', 'POST', {
    name: '原子对账测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;

  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  const cues = layout.body.subtitles;
  assert.equal(cues.length, 2);
  const subVersion = layout.body.sub_version;

  for (const [i, cue] of cues.entries()) {
    const r = await api(`/api/projects/${pid}/translations/en/subtitles/${cue.id}`, 'PUT',
      { text: `Translation ${i + 1}`, cue_version: cue.version, version: 0 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }

  const sp = await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  assert.equal(sp.status, 201, JSON.stringify(sp.body));
  let attributionVersion = sp.body.attribution_version;
  for (const cue of cues) {
    const r = await api(`/api/projects/${pid}/attributions/subtitles/${cue.id}`, 'PUT',
      { attribution_version: attributionVersion, cue_version: cue.version, speaker_number: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    attributionVersion = r.body.attribution_version;
  }

  const commentIds = [];
  for (const cue of cues) {
    const r = await api(`/api/projects/${pid}/comments`, 'POST', {
      import_version: 1, sub_version: subVersion,
      word_start: cue.word_start, word_end: cue.word_end,
      text: `复核意见 ${cue.word_start}-${cue.word_end}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    commentIds.push(r.body.comment.id);
  }
  for (const cid of commentIds) {
    const r = await api(`/api/projects/${pid}/comments/${cid}/close`, 'POST', { version: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  return { pid, cues, commentIds, subVersion, attributionVersion };
}

// ---------- 成功后立刻查询：一致结果 ----------

let server;
let api;

before(async () => {
  const started = await startServer(initDb(':memory:'));
  server = started.server;
  api = started.api;
});

after(() => server.close());

test('单条编辑：一次原子提交——译文/意见待复核、归属保留、sub_version 只推进一次', async () => {
  const { pid, cues, subVersion, attributionVersion } = await setupFull(api);
  const cue = cues[0];

  const r = await api(`/api/projects/${pid}/subtitles/${cue.id}`, 'PATCH',
    { version: cue.version, text: '你好世界呀' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sub_version, subVersion + 1, '字幕集版本恰好推进一次');

  // 立刻查询译文：被改行 → review；未改行仍 current
  const tv = await api(`/api/projects/${pid}/translations/en`);
  const e1 = tv.body.entries.find((e) => e.cue.id === cue.id);
  const e2 = tv.body.entries.find((e) => e.cue.id === cues[1].id);
  assert.equal(e1.state, 'review');
  assert.equal(e2.state, 'current');
  assert.equal(tv.body.history.length, 0);

  // 立刻查询意见：相交被改行的已关闭意见快照漂移 → review；另一条仍 closed
  const cv = await api(`/api/projects/${pid}/comments`);
  const c1 = cv.body.comments.find((c) => c.word_start === 0);
  const c2 = cv.body.comments.find((c) => c.word_start === 2);
  assert.equal(c1.status, 'review');
  assert.equal(c2.status, 'closed');

  // 归属：行保留 ID → 两条归属都仍有效；归属版本不被字幕编辑推进
  const av = await api(`/api/projects/${pid}/attributions`);
  assert.equal(av.body.counts.attributed, 2);
  assert.equal(av.body.counts.history, 0);
  assert.equal(av.body.attribution_version, attributionVersion);
});

test('单条编辑：纯锁定切换不误判失效（译文仍 current、意见仍 closed）', async () => {
  const { pid, cues } = await setupFull(api);
  const cue = cues[0];

  const r = await api(`/api/projects/${pid}/subtitles/${cue.id}`, 'PATCH',
    { version: cue.version, locked: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subtitle.locked, 1);

  const tv = await api(`/api/projects/${pid}/translations/en`);
  assert.ok(tv.body.entries.every((e) => e.state === 'current'), '仅锁定变化不得使译文失效');
  const cv = await api(`/api/projects/${pid}/comments`);
  assert.equal(cv.body.counts.closed, 2);
  assert.equal(cv.body.counts.review, 0);
  const av = await api(`/api/projects/${pid}/attributions`);
  assert.equal(av.body.counts.attributed, 2);
});

test('重排：删除行译文/归属留历史、漂移意见待复核，一次原子提交后立刻可查', async () => {
  const { pid, attributionVersion } = await setupFull(api);

  // 收紧规则（每条最多 2 字）→ 重排为 4 条（每词一条），旧 2 行消失
  const before = await api(`/api/projects/${pid}`);
  const ru = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: before.body.rules.version,
    max_chars: 2, min_duration_ms: 400, max_cps: 20,
  });
  assert.equal(ru.status, 200, JSON.stringify(ru.body));

  const cur = await api(`/api/projects/${pid}`);
  const r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: cur.body.sub_version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subtitles.length, 4);
  assert.equal(r.body.sub_version, cur.body.sub_version + 1, '字幕集版本恰好推进一次');

  // 旧行译文 → history（subtitle_id 置空，不按序号挪用）；新行缺译
  const tv = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(tv.body.counts.missing, 4);
  assert.equal(tv.body.history.length, 2);
  assert.ok(tv.body.history.every((h) => h.status === 'history' && h.subtitle_id === null));

  // 旧行归属 → history；新行待标注；重排本身不推进归属版本
  const av = await api(`/api/projects/${pid}/attributions`);
  assert.equal(av.body.counts.attributed, 0);
  assert.equal(av.body.counts.unattributed, 4);
  assert.equal(av.body.counts.history, 2);
  assert.equal(av.body.attribution_version, attributionVersion);

  // 已关闭意见：相交字幕快照漂移（2 行拆为 4 行）→ review
  const cv = await api(`/api/projects/${pid}/comments`);
  assert.equal(cv.body.counts.review, 2);
  assert.equal(cv.body.counts.closed, 0);
  assert.equal(cv.body.counts.history, 0);
});

test('重排：内容不变的行保留身份——译文/归属/意见均不误判失效', async () => {
  const { pid, subVersion, attributionVersion } = await setupFull(api);

  // 同样的规则与词再次重排：候选整版与现版一致 → 全部行保留 ID/版本
  const r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: subVersion });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sub_version, subVersion + 1);

  const tv = await api(`/api/projects/${pid}/translations/en`);
  assert.ok(tv.body.entries.every((e) => e.state === 'current'));
  assert.equal(tv.body.history.length, 0);
  const av = await api(`/api/projects/${pid}/attributions`);
  assert.equal(av.body.counts.attributed, 2);
  assert.equal(av.body.counts.history, 0);
  assert.equal(av.body.attribution_version, attributionVersion);
  const cv = await api(`/api/projects/${pid}/comments`);
  assert.equal(cv.body.counts.closed, 2);
  assert.equal(cv.body.counts.review, 0);
});

test('重新导入：译文/归属留历史、旧代次意见转历史、版本推进，旧导出快照不变', async () => {
  const { pid, subVersion, attributionVersion } = await setupFull(api);

  // 先导出原文快照（重新导入不得影响旧快照）
  const exp = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: subVersion });
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  const snapshotContent = exp.body.content;

  const NEW_WORDS = [
    { text: '早上', start_ms: 0, end_ms: 400 },
    { text: '你好', start_ms: 500, end_ms: 900 },
  ];
  const r = await api(`/api/projects/${pid}/import`, 'POST',
    { words: NEW_WORDS, cuts: [], force: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sub_version, subVersion + 1, '字幕集版本恰好推进一次');
  assert.equal(r.body.import_version, 2, '导入代次恰好推进一次');
  assert.equal(r.body.words.length, 2);
  assert.equal(r.body.subtitles.length, 0);

  // 译文：全部留作历史（subtitle_id 置空）
  const tv = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(tv.body.entries.length, 0);
  assert.equal(tv.body.history.length, 2);
  assert.ok(tv.body.history.every((h) => h.status === 'history' && h.subtitle_id === null));

  // 归属：全部留作历史；归属版本不被导入推进
  const av = await api(`/api/projects/${pid}/attributions`);
  assert.equal(av.body.counts.cues, 0);
  assert.equal(av.body.counts.history, 2);
  assert.equal(av.body.attribution_version, attributionVersion);

  // 意见：旧代次 → 历史（仅查看，不附到新词段）
  const cv = await api(`/api/projects/${pid}/comments`);
  assert.equal(cv.body.comments.length, 0);
  assert.equal(cv.body.history.length, 2);
  assert.equal(cv.body.counts.history, 2);
  assert.equal(cv.body.import_version, 2);

  // 旧导出快照内容不变
  const dl = await api(`/api/projects/${pid}/exports/${exp.body.version}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, snapshotContent);
});

// ---------- 任一步失败：整次操作连同版本回滚，可按旧版本重试 ----------

test('原子回滚：单条编辑对账（意见同步）失败 → 字幕/版本/译文/意见全部保持旧值', async () => {
  const injector = makeFailureInjector(initDb(':memory:'));
  const { server: srv, api: xapi } = await startServer(injector.db);
  try {
    const { pid, cues, subVersion } = await setupFull(xapi);
    const cue = cues[0];

    injector.failOn((sql) => sql.includes('UPDATE review_comments'));
    const r = await xapi(`/api/projects/${pid}/subtitles/${cue.id}`, 'PATCH',
      { version: cue.version, text: '不应落库' });
    assert.equal(r.status, 500, '对账失败应使整次操作失败');
    injector.clear();

    // 整次回滚：字幕原文/行版本/字幕集版本均未变
    const after = await xapi(`/api/projects/${pid}`);
    const kept = after.body.subtitles.find((s) => s.id === cue.id);
    assert.equal(kept.text, cue.text);
    assert.equal(kept.version, cue.version);
    assert.equal(after.body.sub_version, subVersion, 'sub_version 不得留下半提交');
    // 译文仍 current、意见仍 closed（对账写入同样回滚）
    const tv = await xapi(`/api/projects/${pid}/translations/en`);
    assert.ok(tv.body.entries.every((e) => e.state === 'current'));
    const cv = await xapi(`/api/projects/${pid}/comments`);
    assert.equal(cv.body.counts.closed, 2);

    // 用户基于旧版本重试 → 成功，且状态一致翻转
    const retry = await xapi(`/api/projects/${pid}/subtitles/${cue.id}`, 'PATCH',
      { version: cue.version, text: '你好世界呀' });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.sub_version, subVersion + 1);
    const tv2 = await xapi(`/api/projects/${pid}/translations/en`);
    assert.equal(tv2.body.entries.find((e) => e.cue.id === cue.id).state, 'review');
  } finally {
    srv.close();
  }
});

test('原子回滚：单条编辑版本推进失败 → 字幕写入同样回滚', async () => {
  const injector = makeFailureInjector(initDb(':memory:'));
  const { server: srv, api: xapi } = await startServer(injector.db);
  try {
    const { pid, cues, subVersion } = await setupFull(xapi);
    const cue = cues[0];

    injector.failOn((sql) => sql.includes('SET sub_version'));
    const r = await xapi(`/api/projects/${pid}/subtitles/${cue.id}`, 'PATCH',
      { version: cue.version, text: '不应落库' });
    assert.equal(r.status, 500);
    injector.clear();

    const after = await xapi(`/api/projects/${pid}`);
    const kept = after.body.subtitles.find((s) => s.id === cue.id);
    assert.equal(kept.text, cue.text, '版本推进失败时字幕写入必须一并回滚');
    assert.equal(kept.version, cue.version);
    assert.equal(after.body.sub_version, subVersion);
    const tv = await xapi(`/api/projects/${pid}/translations/en`);
    assert.ok(tv.body.entries.every((e) => e.state === 'current'));
  } finally {
    srv.close();
  }
});

test('原子回滚：重排对账（归属同步）失败 → 字幕/版本/译文/归属/意见全部保持旧值', async () => {
  const injector = makeFailureInjector(initDb(':memory:'));
  const { server: srv, api: xapi } = await startServer(injector.db);
  try {
    const { pid, subVersion, attributionVersion } = await setupFull(xapi);

    const before = await xapi(`/api/projects/${pid}`);
    await xapi(`/api/projects/${pid}/rules`, 'PUT', {
      version: before.body.rules.version,
      max_chars: 2, min_duration_ms: 400, max_cps: 20,
    });
    const cur = await xapi(`/api/projects/${pid}`);

    injector.failOn((sql) => sql.includes('UPDATE attributions'));
    const r = await xapi(`/api/projects/${pid}/layout`, 'POST', { sub_version: cur.body.sub_version });
    assert.equal(r.status, 500, '对账失败应使整次重排失败');
    injector.clear();

    // 整次回滚：仍是旧 2 行、旧版本；译文仍 current（先执行的译文对账也回滚）、
    // 归属仍 active、意见仍 closed
    const after = await xapi(`/api/projects/${pid}`);
    assert.equal(after.body.subtitles.length, 2);
    assert.equal(after.body.sub_version, subVersion, 'sub_version 不得留下半提交');
    const tv = await xapi(`/api/projects/${pid}/translations/en`);
    assert.ok(tv.body.entries.every((e) => e.state === 'current'));
    assert.equal(tv.body.history.length, 0);
    const av = await xapi(`/api/projects/${pid}/attributions`);
    assert.equal(av.body.counts.attributed, 2);
    assert.equal(av.body.counts.history, 0);
    assert.equal(av.body.attribution_version, attributionVersion);
    const cv = await xapi(`/api/projects/${pid}/comments`);
    assert.equal(cv.body.counts.closed, 2);

    // 基于旧版本重试 → 成功，且重排 + 对账一致生效
    const retry = await xapi(`/api/projects/${pid}/layout`, 'POST', { sub_version: cur.body.sub_version });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.subtitles.length, 4);
    const tv2 = await xapi(`/api/projects/${pid}/translations/en`);
    assert.equal(tv2.body.history.length, 2);
    const av2 = await xapi(`/api/projects/${pid}/attributions`);
    assert.equal(av2.body.counts.history, 2);
  } finally {
    srv.close();
  }
});

test('原子回滚：重新导入对账（译文同步）失败 → 词/字幕/版本/译文/意见全部保持旧值', async () => {
  const injector = makeFailureInjector(initDb(':memory:'));
  const { server: srv, api: xapi } = await startServer(injector.db);
  try {
    const { pid, subVersion } = await setupFull(xapi);
    const NEW_WORDS = [
      { text: '早上', start_ms: 0, end_ms: 400 },
      { text: '你好', start_ms: 500, end_ms: 900 },
    ];

    injector.failOn((sql) => sql.includes('UPDATE translations') && sql.includes("SET status = 'history'"));
    const r = await xapi(`/api/projects/${pid}/import`, 'POST',
      { words: NEW_WORDS, cuts: [], force: true });
    assert.equal(r.status, 500, '对账失败应使整次导入失败');
    injector.clear();

    // 整次回滚：旧词、旧字幕、旧版本（sub_version / import_version 均未推进）
    const after = await xapi(`/api/projects/${pid}`);
    assert.equal(after.body.words.length, 4);
    assert.equal(after.body.words[0].text, '你好');
    assert.equal(after.body.subtitles.length, 2);
    assert.equal(after.body.sub_version, subVersion);
    assert.equal(after.body.import_version, 1);
    const tv = await xapi(`/api/projects/${pid}/translations/en`);
    assert.ok(tv.body.entries.every((e) => e.state === 'current'));
    assert.equal(tv.body.history.length, 0);
    const av = await xapi(`/api/projects/${pid}/attributions`);
    assert.equal(av.body.counts.attributed, 2);
    const cv = await xapi(`/api/projects/${pid}/comments`);
    assert.equal(cv.body.counts.closed, 2);
    assert.equal(cv.body.counts.history, 0);

    // 基于旧版本重试 → 成功，导入与对账一致生效
    const retry = await xapi(`/api/projects/${pid}/import`, 'POST',
      { words: NEW_WORDS, cuts: [], force: true });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.sub_version, subVersion + 1);
    assert.equal(retry.body.import_version, 2);
    const tv2 = await xapi(`/api/projects/${pid}/translations/en`);
    assert.equal(tv2.body.history.length, 2);
    const cv2 = await xapi(`/api/projects/${pid}/comments`);
    assert.equal(cv2.body.counts.history, 2);
  } finally {
    srv.close();
  }
});
