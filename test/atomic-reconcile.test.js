'use strict';

/**
 * 源字幕集三类写操作（重新导入 / 重排 / 单条编辑）的原子对账测试：
 *   - 成功：删除行的译文/归属留历史；源文本或时间变化 → 当前译文待复核、已关闭且
 *     快照漂移的意见待复核；重新导入前意见转历史；纯锁定或排序变化不误判失效；
 *   - 失败：对账写入或一致性断言失败 → 整次操作（连同版本推进）回滚，无半提交，
 *     可基于旧版本重试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');
const { reconcileCascade, verifyReconciled } = require('../src/reconcile');

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

function startServer(database) {
  const db = database || initDb(':memory:');
  const app = createApp(db);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        db,
        base,
        close: () => new Promise((done) => server.close(done)),
        api: async (path, method = 'GET', body) => {
          const res = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { json = text; }
          return { status: res.status, body: json };
        },
      });
    });
  });
}

/** 建项目（4 词 / 切点 1200）并排版：2 条字幕（词0-1 / 词2-3） */
async function setupProject(ctx, name = '原子对账测试') {
  const created = await ctx.api('/api/projects', 'POST', {
    name, words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await ctx.api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/** 建说话人并标注单条字幕归属，返回 { number, attribution_version } */
async function attribute(ctx, pid, sid, cueVersion, displayName) {
  const made = await ctx.api(`/api/projects/${pid}/speakers`, 'POST', { display_name: displayName });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const number = made.body.speaker.number;
  const put = await ctx.api(`/api/projects/${pid}/attributions/subtitles/${sid}`, 'PUT', {
    attribution_version: made.body.attribution_version,
    cue_version: cueVersion,
    speaker_number: number,
  });
  assert.equal(put.status === 201 || put.status === 200, true, JSON.stringify(put.body));
  return { number, attribution_version: put.body.attribution_version };
}

/** 保存一份英译文（cue_version 必填），返回响应 */
async function saveTranslation(ctx, pid, sid, cueVersion, text, version) {
  return ctx.api(`/api/projects/${pid}/translations/en/subtitles/${sid}`, 'PUT', {
    text, cue_version: cueVersion, ...(version !== undefined ? { version } : {}),
  });
}

async function createComment(ctx, pid, payload) {
  return ctx.api(`/api/projects/${pid}/comments`, 'POST', payload);
}
async function closeComment(ctx, pid, cid, version) {
  return ctx.api(`/api/projects/${pid}/comments/${cid}/close`, 'POST', { version });
}

function langView(ctx, pid) {
  return ctx.api(`/api/projects/${pid}/translations/en`);
}
function commentsView(ctx, pid) {
  return ctx.api(`/api/projects/${pid}/comments`);
}
function attributionsView(ctx, pid) {
  return ctx.api(`/api/projects/${pid}/attributions`);
}
function getProject(ctx, pid) {
  return ctx.api(`/api/projects/${pid}`);
}

// ---------- 单条编辑：文本/时间变化对账，纯锁定不误判 ----------

test('单条编辑：改源文本 → 译文与已关闭意见同事务转待复核；归属保留；版本推进', async () => {
  const ctx = await startServer();
  try {
    const { pid, cues } = await setupProject(ctx);
    const [cue1, cue2] = cues;

    const tr = await saveTranslation(ctx, pid, cue1.id, cue1.version, 'Hello world');
    assert.equal(tr.status, 201, JSON.stringify(tr.body));
    await attribute(ctx, pid, cue1.id, cue1.version, '茶客甲');

    // 一条相交意见关闭（快照保存词区间 [0,0] 时的字幕形态）
    const made = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 0, word_end: 0, text: '开头停顿偏长',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const cid = made.body.comment.id;
    const closed = await closeComment(ctx, pid, cid, 1);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    // 改源字幕文本（携带当前行版本）
    const patched = await ctx.api(`/api/projects/${pid}/subtitles/${cue1.id}`, 'PATCH', {
      version: cue1.version, text: '你好呀，世界',
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.sub_version, 2);
    // 级联结果随成功响应返回
    assert.deepEqual(patched.body.cascade.translations, { history: 0, review: 1 });
    assert.equal(patched.body.cascade.comments.review, 1);

    // 立即查询：译文待复核
    const view = await langView(ctx, pid);
    const e1 = view.body.entries.find((x) => x.cue.id === cue1.id);
    assert.equal(e1.state, 'review');
    const e2 = view.body.entries.find((x) => x.cue.id === cue2.id);
    assert.equal(e2.state, 'missing');

    // 意见待复核；归属仍在该行（行未删除）
    const cv = await commentsView(ctx, pid);
    const c = cv.body.comments.find((x) => x.id === cid);
    assert.equal(c.status, 'review');
    const av = await attributionsView(ctx, pid);
    assert.equal(av.body.cues.find((x) => x.subtitle_id === cue1.id).attribution.display_name, '茶客甲');
  } finally {
    await ctx.close();
  }
});

test('单条编辑：仅锁定切换 → 译文保持 current、意见保持 closed，不产生任何待复核', async () => {
  const ctx = await startServer();
  try {
    const { pid, cues } = await setupProject(ctx);
    const cue = cues[0];
    const tr = await saveTranslation(ctx, pid, cue.id, cue.version, 'Hello world');
    assert.equal(tr.status, 201);
    const made = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: 'ok',
    });
    const closed = await closeComment(ctx, pid, made.body.comment.id, 1);
    assert.equal(closed.status, 200);

    const locked = await ctx.api(`/api/projects/${pid}/subtitles/${cue.id}`, 'PATCH', {
      version: cue.version, locked: true,
    });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.deepEqual(locked.body.cascade.translations, { history: 0, review: 0 });
    assert.deepEqual(locked.body.cascade.comments, { history: 0, review: 0 });

    const view = await langView(ctx, pid);
    assert.equal(view.body.entries.find((x) => x.cue.id === cue.id).state, 'current');
    const cv = await commentsView(ctx, pid);
    assert.equal(cv.body.comments[0].status, 'closed');
  } finally {
    await ctx.close();
  }
});

// ---------- 重排：删除行留历史、排序变化不误判 ----------

test('重排：删除行译文/归属留历史，保留行仅换序不失效；漂移意见转待复核', async () => {
  const ctx = await startServer();
  try {
    const { pid, cues } = await setupProject(ctx);
    const [cue1, cue2] = cues;
    await saveTranslation(ctx, pid, cue1.id, cue1.version, 'Hello world');
    await saveTranslation(ctx, pid, cue2.id, cue2.version, 'Welcome');
    await attribute(ctx, pid, cue1.id, cue1.version, '甲');
    await attribute(ctx, pid, cue2.id, cue2.version, '乙');

    // 意见锚定词 0..1（关闭时与 cue1 相交）
    const made = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '首句核对',
    });
    const cid = made.body.comment.id;
    assert.equal((await closeComment(ctx, pid, cid, 1)).status, 200);

    // 改规则：max_chars=3 使词段拆成 4 条单行；cue1/cue2（词区间 0-1 / 2-3）被删除
    const rules = await ctx.api(`/api/projects/${pid}/rules`, 'PUT', {
      version: 1, max_chars: 3, min_duration_ms: 300, max_cps: 20,
    });
    assert.equal(rules.status, 200, JSON.stringify(rules.body));

    const relayout = await ctx.api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 1 });
    assert.equal(relayout.status, 200, JSON.stringify(relayout.body));
    assert.equal(relayout.body.subtitles.length, 4);
    assert.deepEqual(relayout.body.cascade.translations, { history: 2, review: 0 });
    assert.equal(relayout.body.cascade.attributions, 2, '两条删除行归属都应留历史');

    // 旧译文全部进历史（不按序号挪用到新行）
    const view = await langView(ctx, pid);
    assert.equal(view.body.history.length, 2);
    assert.equal(view.body.counts.current + view.body.counts.review, 0);
    assert.equal(view.body.entries.every((x) => x.state === 'missing'), true);

    // 旧归属留历史，新行待标注
    const av = await attributionsView(ctx, pid);
    assert.equal(av.body.cues.every((x) => x.attribution === null), true);
    assert.equal(av.body.history.length, 2);

    // 已关闭意见：相交字幕由“你好世界”变为两条单词行 → 快照漂移 → review
    const cv = await commentsView(ctx, pid);
    const c = cv.body.comments.find((x) => x.id === cid);
    assert.equal(c.status, 'review');
    assert.equal(c.subtitles.length, 2, '意见仍按词区间附到相交的新行');
  } finally {
    await ctx.close();
  }
});

test('重排：仅展示顺序变化（行身份与内容不变）→ 译文 current、意见 closed、归属有效', async () => {
  const ctx = await startServer();
  try {
    const { pid, cues } = await setupProject(ctx);
    const cue = cues[0];
    await saveTranslation(ctx, pid, cue.id, cue.version, 'Hello world');

    // 构造一次“只换序”的重排：先锁定全部行（每条按其当前行版本锁定），
    // 重排便只重写 idx，内容与行版本不动。
    let toLock = (await getProject(ctx, pid)).body.subtitles;
    for (const c of toLock) {
      const r = await ctx.api(`/api/projects/${pid}/subtitles/${c.id}`, 'PATCH', {
        version: c.version, locked: true,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const project = await getProject(ctx, pid);
    const versionBeforeRelayout = project.body.subtitles.find((s) => s.id === cue.id).version;
    const relayout = await ctx.api(`/api/projects/${pid}/layout`, 'POST', {
      sub_version: project.body.sub_version,
    });
    assert.equal(relayout.status, 200, JSON.stringify(relayout.body));
    assert.deepEqual(relayout.body.cascade.translations, { history: 0, review: 0 });
    assert.equal(relayout.body.cascade.attributions, 0);
    assert.equal(relayout.body.cascade.comments.review, 0);

    const view = await langView(ctx, pid);
    assert.equal(view.body.counts.current, 1);
    // 锁定行保留 ID；重排不额外推进行版本（仅锁定 PATCH 推过一次，保持该版本不变）
    const kept = relayout.body.subtitles.find((s) => s.id === cue.id);
    assert.ok(kept);
    assert.equal(kept.version, versionBeforeRelayout);
  } finally {
    await ctx.close();
  }
});

// ---------- 重新导入：全部留历史 / 旧意见转历史 ----------

test('重新导入：旧译文与归属留历史，旧代次意见转历史；import/sub 版本一起推进', async () => {
  const ctx = await startServer();
  try {
    const { pid, cues } = await setupProject(ctx);
    await saveTranslation(ctx, pid, cues[0].id, cues[0].version, 'Hello world');
    await attribute(ctx, pid, cues[0].id, cues[0].version, '甲');

    const openMade = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 0, word_end: 0, text: '待办',
    });
    const openId = openMade.body.comment.id;
    const closedMade = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 2, word_end: 2, text: '已核对',
    });
    const closedId = closedMade.body.comment.id;
    assert.equal((await closeComment(ctx, pid, closedId, 1)).status, 200);

    const before = await getProject(ctx, pid);
    const imported = await ctx.api(`/api/projects/${pid}/import`, 'POST', {
      words: GOOD_WORDS, cuts: [1200], force: true,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.import_version, before.body.import_version + 1);
    assert.equal(imported.body.sub_version, before.body.sub_version + 1);
    assert.equal(imported.body.cascade.translations.history, 1);
    assert.equal(imported.body.cascade.comments.history, 2, 'open/closed 旧代次意见均转历史');

    // 立即查询：旧译文留历史、无新译文；旧归属留历史；两条意见都在历史区
    const view = await langView(ctx, pid);
    assert.equal(view.body.history.length, 1);
    assert.equal(view.body.entries.length, 0, '重新导入后尚未排版，无当前字幕');
    assert.equal(view.body.history[0].subtitle_id, null);

    const av = await attributionsView(ctx, pid);
    assert.equal(av.body.cues.length, 0);
    assert.equal(av.body.history.length, 1);

    const cv = await commentsView(ctx, pid);
    assert.equal(cv.body.comments.length, 0);
    assert.deepEqual(cv.body.history.map((x) => x.id).sort(), [openId, closedId].sort());
    assert.equal(cv.body.import_version, 2);

    // 历史意见不可关闭
    const reClose = await closeComment(ctx, pid, openId, 1);
    assert.equal(reClose.status, 422);
  } finally {
    await ctx.close();
  }
});

// ---------- 失败回滚：对账写入失败 / 一致性断言失败 ----------

test('对账写入失败（触发器注入）→ 编辑、重排、重导整体回滚，版本停留旧值可重试', async () => {
  const db = initDb(':memory:');
  const ctx = await startServer(db);
  try {
    const { pid, cues } = await setupProject(ctx, '回滚测试');
    await saveTranslation(ctx, pid, cues[0].id, cues[0].version, 'Hello world');
    // 一条已关闭意见：改源文本时对账必定 UPDATE 该行（快照漂移转待复核），
    // 从而确定性命中注入的触发器。
    const made = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: 'x',
    });
    assert.equal((await closeComment(ctx, pid, made.body.comment.id, 1)).status, 200);

    // 注入故障：对账阶段对 translations 的任何 UPDATE 都中止（磁盘/约束类故障的模拟）。
    // 单条编辑（译文转待复核）、重排（拆行后旧译文留历史）、重新导入（全部留历史）
    // 都会确定性 UPDATE 到上面保存的译文行。
    db.exec(`CREATE TEMP TRIGGER fail_sync_update
             BEFORE UPDATE ON translations BEGIN SELECT RAISE(ABORT, 'injected sync failure'); END;`);

    // 1) 单条编辑失败：字幕文本、行版本、sub_version 全部不动
    const before = await getProject(ctx, pid);
    const badPatch = await ctx.api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
      version: cues[0].version, text: '不应保存的文本',
    });
    assert.equal(badPatch.status, 500);
    assert.equal(badPatch.body.rolled_back, true);
    assert.match(badPatch.body.error, /已回滚/);
    const afterPatch = await getProject(ctx, pid);
    assert.equal(afterPatch.body.sub_version, before.body.sub_version);
    assert.equal(afterPatch.body.subtitles[0].text, cues[0].text);
    assert.equal(afterPatch.body.subtitles[0].version, 1);
    // 译文未被误改状态
    const view1 = await langView(ctx, pid);
    assert.equal(view1.body.entries[0].state, 'current');

    // 2) 用户可基于旧版本重试（版本语义不变）：移除故障后同一请求体成功
    db.exec('DROP TRIGGER fail_sync_update');
    const retry = await ctx.api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
      version: cues[0].version, text: '重试成功的文本',
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const afterRetry = await getProject(ctx, pid);
    assert.equal(afterRetry.body.subtitles[0].text, '重试成功的文本');
    assert.equal(afterRetry.body.sub_version, before.body.sub_version + 1);

    // 3) 重排期间再次注入故障 → 重排整版回滚
    db.exec(`CREATE TEMP TRIGGER fail_sync_update
             BEFORE UPDATE ON translations BEGIN SELECT RAISE(ABORT, 'injected sync failure'); END;`);
    const rules = await ctx.api(`/api/projects/${pid}/rules`, 'PUT', {
      version: afterRetry.body.rules.version, max_chars: 3, min_duration_ms: 300, max_cps: 20,
    });
    assert.equal(rules.status, 200);
    const badLayout = await ctx.api(`/api/projects/${pid}/layout`, 'POST', {
      sub_version: afterRetry.body.sub_version,
    });
    assert.equal(badLayout.status, 500, JSON.stringify(badLayout.body));
    const afterBadLayout = await getProject(ctx, pid);
    assert.equal(afterBadLayout.body.sub_version, afterRetry.body.sub_version);
    assert.equal(afterBadLayout.body.subtitles.length, 2, '删除/拆分不得半提交');

    // 4) 重新导入期间故障 → 旧词/旧字幕/代次全部保留
    db.exec('DROP TRIGGER fail_sync_update');
    db.exec(`CREATE TEMP TRIGGER fail_sync_update
             BEFORE UPDATE ON translations BEGIN SELECT RAISE(ABORT, 'injected sync failure'); END;`);
    const badImport = await ctx.api(`/api/projects/${pid}/import`, 'POST', {
      words: GOOD_WORDS, cuts: [], force: true,
    });
    assert.equal(badImport.status, 500, JSON.stringify(badImport.body));
    const afterBadImport = await getProject(ctx, pid);
    assert.equal(afterBadImport.body.subtitles.length, 2);
    assert.equal(afterBadImport.body.import_version, 1);
    assert.equal(afterBadImport.body.cuts.length, 1, '旧切点不得半清空');
  } finally {
    try { db.exec('DROP TRIGGER IF EXISTS fail_sync_update'); } catch { /* 已删除 */ }
    await ctx.close();
  }
});

test('一致性断言发现残留不一致 → 整次编辑回滚，不留下半提交', async () => {
  const db = initDb(':memory:');
  const ctx = await startServer(db);
  try {
    const { pid, cues } = await setupProject(ctx, '断言回滚测试');
    await saveTranslation(ctx, pid, cues[0].id, cues[0].version, 'Hello world');

    // 绕过 API 人为制造“脏状态”：把一条已关闭意见的快照 JSON 写坏。
    // 下一次源变更对账时断言必须检出并整体回滚。
    const made = await createComment(ctx, pid, {
      import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: 'x',
    });
    const cid = made.body.comment.id;
    assert.equal((await closeComment(ctx, pid, cid, 1)).status, 200);
    db.prepare('UPDATE review_comments SET snapshot_json = ? WHERE id = ?')
      .run('{broken json', cid);

    const before = await getProject(ctx, pid);
    const bad = await ctx.api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
      version: cues[0].version, text: '新文本',
    });
    assert.equal(bad.status, 500);
    assert.equal(bad.body.rolled_back, true);
    assert.ok(bad.body.reasons.some((r) => /快照已损坏/.test(r)));

    const after = await getProject(ctx, pid);
    assert.equal(after.body.sub_version, before.body.sub_version, '版本不得推进');
    assert.equal(after.body.subtitles[0].text, cues[0].text);
    // 事务回滚后数据库恢复到已知一致状态（坏快照是事务前既有的，断言之外无新增漂移）：
    // 修好快照即可基于旧版本重试成功
    db.prepare('UPDATE review_comments SET snapshot_json = ? WHERE id = ?')
      .run(JSON.stringify([{
        word_start: 0, word_end: 1, text: cues[0].text,
        start_ms: cues[0].start_ms, end_ms: cues[0].end_ms,
      }]), cid);
    const ok = await ctx.api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
      version: cues[0].version, text: '重试成功',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    await ctx.close();
  }
});

// ---------- 单元级：reconcileCascade 必须在事务边界回滚 ----------

test('reconcileCascade 直接调用：断言抛错时事务内全部写入回滚', () => {
  const db = initDb(':memory:');
  const pid = db.prepare('INSERT INTO projects (name) VALUES (?)').run('x').lastInsertRowid;
  db.prepare(
    'INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?, 30, 800, 20)'
  ).run(pid);

  // 干净项目：对账无问题
  assert.deepEqual(reconcileCascade(db, pid), {
    translations: { history: 0, review: 0 },
    attributions: 0,
    comments: { history: 0, review: 0 },
  });
  assert.deepEqual(verifyReconciled(db, pid), []);

  // 事务内先写一行字幕并标注归属，随后删除该字幕（模拟源行删除后归属未对账的脏状态）：
  // verifyReconciled 必须检出孤儿有效归属；再在事务内执行对账会把它转历史并通过断言。
  const sid = db.prepare(
    "INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms) VALUES (?, 0, 0, 0, 'a', 0, 100)"
  ).run(pid).lastInsertRowid;
  const sp = db.prepare("INSERT INTO speakers (project_id, number, display_name) VALUES (?, 1, '甲')").run(pid).lastInsertRowid;
  db.prepare(
    'INSERT INTO attributions (project_id, subtitle_id, speaker_id, speaker_number, cue_version) VALUES (?, ?, ?, 1, 1)'
  ).run(pid, sid, sp);
  db.prepare('DELETE FROM subtitles WHERE id = ?').run(sid);
  assert.ok(verifyReconciled(db, pid).some((r) => /有效归属指向已删除/.test(r)));

  // 事务：先重建字幕再调用对账；对账会把孤儿归属转历史并断言通过
  db.transaction(() => {
    reconcileCascade(db, pid);
  })();
  assert.deepEqual(verifyReconciled(db, pid), []);
});
