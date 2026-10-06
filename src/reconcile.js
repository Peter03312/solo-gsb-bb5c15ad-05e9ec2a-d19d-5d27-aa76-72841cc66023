'use strict';

/**
 * 源字幕集写操作（重新导入 / 重排 / 单条编辑，及修订采纳、逐词修正确认）的
 * 统一级联对账。
 *
 * 每次源变更都把三件事与“字幕写入 + 版本推进”放进同一个数据库事务（必须由调用方
 * 在事务内调用本模块）：
 *   1. 译文对账 syncTranslations：删除的源行 → 译文留作 history（subtitle_id 置空，
 *      不按序号挪用）；源文本/时间/词区间相对保存快照漂移的 current 译文 → review；
 *      仅锁定或展示顺序变化不动状态；
 *   2. 说话人归属对账 syncAttributions：删除的源行 → 归属留作 history（不按序号转移）；
 *      保留 ID 的行（仅 idx/锁定变化或原地更新）归属继续有效；
 *   3. 复核意见对账 syncComments：旧导入代次意见 → history（仅历史查看）；
 *      closed 意见的相交字幕快照（文本/时间/词区间，按词序）漂移 → review；
 *      仅锁定/展示顺序变化不触发。
 *
 * 对账写入完成后立即执行一致性断言：任何不变量被破坏（理论上不应发生，例如唯一索引
 * 失效、快照损坏、对账漏处理一行）都抛出 ReconcileError，由 better-sqlite3 在事务
 * 边界整批回滚——连同字幕/词/切点写入与 sub_version / import_version 推进一起撤销，
 * 用户仍可基于旧版本重试。
 */

const { syncTranslations } = require('./translation');
const { syncAttributions } = require('./speaker');
const {
  syncComments, intersectingSubtitles, snapshotOf, snapshotEquals,
} = require('./comment');

/** 对账失败：任何写入或对账断言触发，外层事务必须整体回滚 */
class ReconcileError extends Error {
  constructor(reasons) {
    const list = Array.isArray(reasons) ? reasons : [reasons];
    super(`状态对账失败，整次操作已回滚：${list.join('；')}`);
    this.name = 'ReconcileError';
    this.reasons = list;
  }
}

const MAX_REPORT_REASONS = 20;

/**
 * 在当前事务内执行级联对账并做一致性断言。必须在 db.transaction(...) 回调内调用。
 * 返回各类本次受影响条数，便于调用方写入响应（失败时不返回、整事务回滚）。
 */
function reconcileCascade(db, projectId) {
  let counts;
  try {
    const translations = syncTranslations(db, projectId);
    const attributions = syncAttributions(db, projectId);
    const comments = syncComments(db, projectId);
    counts = { translations, attributions, comments };
  } catch (err) {
    if (err instanceof ReconcileError) throw err;
    throw new ReconcileError([`对账写入失败（${err && err.message ? err.message : err}）`]);
  }

  const problems = verifyReconciled(db, projectId);
  if (problems.length > 0) throw new ReconcileError(problems);
  return counts;
}

/**
 * 对账后的不变量断言。返回中文原因列表；空数组表示一致。
 * 刻意只比较 文本/时间/词区间/导入代次：锁定标记与展示序号 idx 不参与，
 * 因此“纯锁定或排序变化”不会被误判失效。
 */
function verifyReconciled(db, projectId) {
  const problems = [];
  const fail = (reason) => {
    if (problems.length < MAX_REPORT_REASONS) problems.push(reason);
  };

  // ---- 译文 ----
  const trOrphans = db.prepare(
    `SELECT COUNT(*) AS n FROM translations
      WHERE project_id = ? AND status != 'history'
        AND (subtitle_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM subtitles s WHERE s.id = subtitle_id))`
  ).get(projectId).n;
  if (trOrphans > 0) fail(`仍有 ${trOrphans} 条非历史译文指向已删除的源字幕行`);

  const trDrift = db.prepare(
    `SELECT COUNT(*) AS n FROM translations
      WHERE project_id = ? AND status = 'current'
        AND EXISTS (SELECT 1 FROM subtitles s WHERE s.id = translations.subtitle_id)
        AND (src_text != (SELECT text FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_start_ms != (SELECT start_ms FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_end_ms   != (SELECT end_ms   FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_word_start != (SELECT word_start FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_word_end   != (SELECT word_end   FROM subtitles s WHERE s.id = translations.subtitle_id))`
  ).get(projectId).n;
  if (trDrift > 0) fail(`仍有 ${trDrift} 条 current 译文的源文本/时间/词区间已漂移（应为待复核）`);

  // 部分唯一索引已在库内强制“每语言每条当前字幕至多一份非历史译文”，此处再查一次，
  // 索引异常（理论上不可能）也会在提交前挡住半一致状态。
  const trDup = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT lang, subtitle_id FROM translations
        WHERE project_id = ? AND status != 'history'
        GROUP BY lang, subtitle_id HAVING COUNT(*) > 1
     )`
  ).get(projectId).n;
  if (trDup > 0) fail(`存在 ${trDup} 组同语言同源行的重复非历史译文`);

  // ---- 说话人归属 ----
  const atOrphans = db.prepare(
    `SELECT COUNT(*) AS n FROM attributions
      WHERE project_id = ? AND status = 'active'
        AND (subtitle_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM subtitles s WHERE s.id = subtitle_id))`
  ).get(projectId).n;
  if (atOrphans > 0) fail(`仍有 ${atOrphans} 条有效归属指向已删除的源字幕行`);

  const atDup = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT subtitle_id FROM attributions
        WHERE project_id = ? AND status = 'active'
        GROUP BY subtitle_id HAVING COUNT(*) > 1
     )`
  ).get(projectId).n;
  if (atDup > 0) fail(`存在 ${atDup} 条当前字幕被重复标注有效归属`);

  // ---- 复核意见 ----
  const project = db.prepare('SELECT import_version FROM projects WHERE id = ?').get(projectId);
  if (!project) fail(`项目 ${projectId} 在对账后不存在`);

  if (project) {
    const cOldGen = db.prepare(
      `SELECT COUNT(*) AS n FROM review_comments
        WHERE project_id = ? AND status != 'history' AND import_version != ?`
    ).get(projectId, project.import_version).n;
    if (cOldGen > 0) fail(`仍有 ${cOldGen} 条旧导入代次意见未转历史`);
  }

  // closed 意见：相交当前字幕的快照必须与现状逐字段一致，否则应为 review。
  // 快照 JSON 损坏也按失败处理（整次操作回滚，不留下无法判态的意见）。
  const closed = db.prepare(
    `SELECT id, word_start, word_end, snapshot_json FROM review_comments
      WHERE project_id = ? AND status = 'closed'`
  ).all(projectId);
  if (closed.length > 0) {
    const subtitles = db.prepare(
      `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
         FROM subtitles WHERE project_id = ? ORDER BY idx`
    ).all(projectId);
    for (const row of closed) {
      let snap = null;
      try {
        snap = row.snapshot_json ? JSON.parse(row.snapshot_json) : null;
      } catch {
        fail(`复核意见 ${row.id} 的关闭快照已损坏，无法对账`);
        continue;
      }
      const current = snapshotOf(intersectingSubtitles(subtitles, row.word_start, row.word_end));
      if (!snapshotEquals(snap, current)) {
        fail(`复核意见 ${row.id} 已关闭但其相交字幕快照已漂移（应为待复核）`);
      }
    }
  }

  return problems;
}

module.exports = {
  ReconcileError,
  reconcileCascade,
  verifyReconciled,
};
