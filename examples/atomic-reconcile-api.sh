#!/usr/bin/env bash
# 字幕集三类写操作（重新导入 / 重排 / 单条编辑）的原子对账完整调用示例。
#
# 每次源字幕变更，服务端都在同一个数据库事务内完成：
#   词/切点/字幕写入 + 版本推进（sub_version，重新导入另推进 import_version）
#   + 译文 / 说话人归属 / 复核意见的级联对账 + 对账后一致性断言；
# 任何写入或对账失败 → 整批回滚（连同版本），响应 500 且带 "rolled_back": true，
# 用户可基于旧版本重试。成功响应额外带 cascade：本次各状态受影响条数。
#
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/atomic-reconcile-api.sh [BASE_URL]
# 例如：bash examples/atomic-reconcile-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

# ---- 公共数据：4 词 1 切点，排版后 2 条字幕 ----
WORDS='[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
]'

mkproject() {
  req POST /api/projects "$(python3 -c "
import json,sys
print(json.dumps({'name':'原子对账 API 示例','words':json.loads(sys.argv[1]),'cuts':[1200]},ensure_ascii=False))" "$WORDS")"
}

echo "=== 0. 建项目并排版（sub_version: 0 → 1） ==="
out="$(mkproject)"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
V1="$(echo "$out" | body_of | jget subtitles.0.version)"
echo "字幕 id=$SID1 / $SID2（行版本 v$V1），sub_version=1"

echo
echo "=== 1. 准备附属状态：英译文 + 说话人归属 + 一条已关闭复核意见 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" \
  '{"text":"Welcome","cue_version":1}' >/dev/null
echo "已保存两条英译文（status=current）"

out="$(req POST "/api/projects/$PID/speakers" '{"display_name":"茶客甲"}')"
N1="$(echo "$out" | body_of | jget speaker.number)"
req PUT "/api/projects/$PID/attributions/subtitles/$SID1" \
  "{\"attribution_version\":0,\"cue_version\":1,\"speaker_number\":$N1}" >/dev/null
echo "字幕 $SID1 已归属给说话人 #$N1"

out="$(req POST "/api/projects/$PID/comments" \
  '{"import_version":1,"sub_version":1,"word_start":0,"word_end":1,"text":"首句核对"}')"
CID="$(echo "$out" | body_of | jget comment.id)"
req POST "/api/projects/$PID/comments/$CID/close" '{"version":1}' >/dev/null
echo "复核意见 #$CID 已关闭（保存相交字幕快照）"

echo
echo "=== 2. 单条编辑改源文本：译文转 review、已关闭意见转 review（同事务） ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" \
  '{"version":1,"text":"你好呀，世界"}')"
echo "HTTP $(echo "$out" | code_of)；$(echo "$out" | body_of)"
echo "→ cascade.translations.review=1 / cascade.comments.review=1；行未删除，归属保留"

echo
echo "--- 立即查询，看到一致结果 ---"
req GET "/api/projects/$PID/translations/en" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d['entries']:
    print(f\"字幕 {e['cue']['id']} 译文状态: {e['state']}\")"
req GET "/api/projects/$PID/comments" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d['comments']:
    print(f\"意见 {c['id']} 状态: {c['status']}\")"
req GET "/api/projects/$PID/attributions" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d['cues']:
    who = c['attribution']['display_name'] if c['attribution'] else None
    print(f\"字幕 {c['subtitle_id']} 归属: {who}\")"

echo
echo "=== 3. 改严规则后重排：旧行删除 → 译文/归属留历史，意见按词区间漂移转 review ==="
req PUT "/api/projects/$PID/rules" \
  '{"version":1,"max_chars":3,"min_duration_ms":300,"max_cps":20}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":2}')"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('新字幕条数:', len(d['subtitles']))
print('cascade:', json.dumps(d['cascade'], ensure_ascii=False))"

echo
echo "--- 旧译文在历史区（subtitle_id 已置空，不按序号挪用到新行） ---"
req GET "/api/projects/$PID/translations/en" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('当前行状态:', {s: d['counts'][s] for s in ('missing','current','review')})
for h in d['history']:
    print(f\"历史译文 id={h['id']} subtitle_id={h['subtitle_id']} src_import_id={h['src_import_id']}\")"
req GET "/api/projects/$PID/attributions" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('当前行已归属条数:', d['counts']['attributed'], '；历史归属条数:', d['counts']['history'])"

echo
echo "=== 4. 纯锁定变化不误判：锁定一条新行后再重排，无任何状态被置失效 ==="
NEW_SID="$(req GET "/api/projects/$PID" | body_of | jget subtitles.0.id)"
NEW_VER="$(req GET "/api/projects/$PID" | body_of | jget subtitles.0.version)"
CUR_SUB="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
req PATCH "/api/projects/$PID/subtitles/$NEW_SID" \
  "{\"version\":$NEW_VER,\"locked\":true}" >/dev/null
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$((CUR_SUB+1))}")"
echo "纯锁定/排序重排 cascade：$(echo "$out" | body_of | jget cascade)"
echo
echo "=== 5. 重新导入（force）：旧译文/归属留历史，旧代次意见转历史 ==="
out="$(req POST "/api/projects/$PID/import" "$(python3 -c "
import json,sys
print(json.dumps({'words':json.loads(sys.argv[1]),'cuts':[1200],'force':True},ensure_ascii=False))" "$WORDS")")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('import_version =', d['import_version'], '；sub_version =', d['sub_version'], '；当前字幕行数 =', len(d['subtitles']))
print('cascade:', json.dumps(d['cascade'], ensure_ascii=False))"
echo "--- 旧意见全部进入历史（不可关闭/重开） ---"
req GET "/api/projects/$PID/comments" | body_of | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('当前代次意见:', len(d['comments']), '；历史意见:', len(d['history']))"

echo
echo "=== 6. 失败即整体回滚：基于过期 sub_version 的重排被 409 拒绝，什么都不写 ==="
CUR_SUB="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":1}')"
echo "HTTP $(echo "$out" | code_of)（当前已是 v$CUR_SUB；409 乐观锁，过期请求不推进任何版本）"
echo "$out" | body_of | python3 -c "import json,sys; print(json.load(sys.stdin)['error'])"

echo
echo "（数据库写入或对账失败时同理：响应 500 且 {\"rolled_back\":true}，"
echo " 字幕/词/切点与 sub_version/import_version 一起回滚，可基于旧版本重试。）"
echo
echo "完成。所有接口与请求/响应字段沿用既有 HTTP API，未新增端点。"
