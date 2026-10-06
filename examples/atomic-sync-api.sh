#!/usr/bin/env bash
# 原子提交与一致对账调用示例（本轮新增）：
#   重新导入 / 重排 / 单条编辑，每次操作把 词/切点或字幕写入 + 版本推进
#   （sub_version / import_version）+ 译文、说话人归属、复核意见的状态对账
#   合并为一次原子提交；成功后立刻查询即得一致结果。任一步数据库写入或
#   对账失败时整次操作连同版本一起回滚（不留半提交），可基于旧版本重试。
#
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/atomic-sync-api.sh [BASE_URL]
# 例如：bash examples/atomic-sync-api.sh http://localhost:3000
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
jlen() { python3 -c 'import json,sys; print(len(json.load(sys.stdin)[sys.argv[1]]))' "$1"; }

echo "=== 0. 新建项目并排版（2 条字幕：词0-1 / 词2-3） ==="
out="$(req POST /api/projects '{"name":"原子对账 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}')"
PID="$(echo "$out" | body_of | jget id)"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "项目 id=$PID，字幕集 v$SUBV，字幕 id=$SID1（词0-1）/ id=$SID2（词2-3）"

echo
echo "=== 1. 准备联动状态：译文、说话人归属、已关闭复核意见 ==="
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world","cue_version":1,"version":0}')"
echo "译文1   → HTTP $(echo "$out" | code_of)（201 current）"
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" \
  '{"text":"Welcome","cue_version":1,"version":0}')"
echo "译文2   → HTTP $(echo "$out" | code_of)（201 current）"
out="$(req POST "/api/projects/$PID/speakers" '{"display_name":"甲"}')"
AV="$(echo "$out" | body_of | jget attribution_version)"
out="$(req PUT "/api/projects/$PID/attributions/subtitles/$SID1" \
  "{\"attribution_version\":$AV,\"cue_version\":1,\"speaker_number\":1}")"
AV="$(echo "$out" | body_of | jget attribution_version)"
out="$(req PUT "/api/projects/$PID/attributions/subtitles/$SID2" \
  "{\"attribution_version\":$AV,\"cue_version\":1,\"speaker_number\":1}")"
AV="$(echo "$out" | body_of | jget attribution_version)"
echo "归属2行 → 归属版本 v$AV"
out="$(req POST "/api/projects/$PID/comments" \
  "{\"import_version\":1,\"sub_version\":$SUBV,\"word_start\":0,\"word_end\":1,\"text\":\"注意断句\"}")"
CID1="$(echo "$out" | body_of | jget comment.id)"
out="$(req POST "/api/projects/$PID/comments/$CID1/close" '{"version":1}')"
echo "意见1   → 创建并关闭（id=$CID1，快照已保存）"

echo
echo "=== 2. 单条编辑：一次原子提交（字幕写入 + sub_version 推进 + 译文/意见对账） ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好世界呀"}')"
echo "PATCH   → HTTP $(echo "$out" | code_of)，字幕集 v$(echo "$out" | body_of | jget sub_version)（恰好 +1）"
echo "-- 立刻查询（同一一致结果）--"
out="$(req GET "/api/projects/$PID/translations/en")"
echo "译文1状态=$(echo "$out" | body_of | jget entries.0.state)（review：源文本变了）  译文2状态=$(echo "$out" | body_of | jget entries.1.state)（current）"
out="$(req GET "/api/projects/$PID/comments")"
echo "意见1状态=$(echo "$out" | body_of | jget comments.0.status)（review：已关闭且快照漂移）"
out="$(req GET "/api/projects/$PID/attributions")"
echo "归属：有效 $(echo "$out" | body_of | jget counts.attributed) 条 / 历史 $(echo "$out" | body_of | jget counts.history) 条（行保留 ID → 归属继续有效）"

echo
echo "=== 3. 纯锁定切换：不得误判失效 ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID2" '{"version":1,"locked":true}')"
echo "PATCH lock → HTTP $(echo "$out" | code_of)"
out="$(req GET "/api/projects/$PID/translations/en")"
echo "译文2状态=$(echo "$out" | body_of | jget entries.1.state)（仍 current：仅锁定变化不失效）"

echo
echo "=== 4. 改规则后重排：一次原子提交（重排写入 + sub_version 推进 + 三方对账） ==="
out="$(req GET "/api/projects/$PID")"
SUBV="$(echo "$out" | body_of | jget sub_version)"
RV="$(echo "$out" | body_of | jget rules.version)"
out="$(req PUT "/api/projects/$PID/rules" \
  "{\"version\":$RV,\"max_chars\":2,\"min_duration_ms\":400,\"max_cps\":20}")"
echo "规则收紧（每条最多 2 字）→ HTTP $(echo "$out" | code_of)"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUBV}")"
echo "重排    → HTTP $(echo "$out" | code_of)，共 $(echo "$out" | body_of | jlen subtitles) 条字幕（锁定行原样保留，未锁定区间重排为新行），字幕集 v$(echo "$out" | body_of | jget sub_version)（恰好 +1）"
echo "-- 立刻查询（删除行留历史，不按序号挪用）--"
out="$(req GET "/api/projects/$PID/translations/en")"
echo "译文：缺译 $(echo "$out" | body_of | jget counts.missing) 行（新行）/ 历史 $(echo "$out" | body_of | jlen history) 条（被删行）；锁定行译文状态=$(echo "$out" | body_of | jget entries.2.state)（保留 ID → 仍 current）"
out="$(req GET "/api/projects/$PID/attributions")"
echo "归属：有效 $(echo "$out" | body_of | jget counts.attributed) 条（锁定行）/ 历史 $(echo "$out" | body_of | jget counts.history) 条（被删行）/ 待标注 $(echo "$out" | body_of | jget counts.unattributed) 条（新行）"
out="$(req GET "/api/projects/$PID/comments")"
echo "意见：待复核 $(echo "$out" | body_of | jget counts.review) 条（相交字幕快照漂移）"

echo
echo "=== 5. 重新导入：一次原子提交（词/切点写入 + sub_version 与 import_version 推进 + 三方对账） ==="
out="$(req POST "/api/projects/$PID/import" '{"words":[
  {"text":"早上","start_ms":0,"end_ms":400},
  {"text":"你好","start_ms":500,"end_ms":900}
],"cuts":[],"force":true}')"
echo "导入    → HTTP $(echo "$out" | code_of)，字幕集 v$(echo "$out" | body_of | jget sub_version)，导入代次 第 $(echo "$out" | body_of | jget import_version) 代"
echo "-- 立刻查询 --"
out="$(req GET "/api/projects/$PID/translations/en")"
echo "译文：当前条目 $(echo "$out" | body_of | jget counts.cues) 行，历史 $(echo "$out" | body_of | jlen history) 条（全部留作历史）"
out="$(req GET "/api/projects/$PID/attributions")"
echo "归属：历史 $(echo "$out" | body_of | jget counts.history) 条（新行待标注）"
out="$(req GET "/api/projects/$PID/comments")"
echo "意见：历史 $(echo "$out" | body_of | jget counts.history) 条（旧代次仅查看，不可关闭/重开）"

echo
echo "=== 6. 原子性说明 ==="
echo "以上每次操作（单条编辑 / 重排 / 重新导入）都是一次原子提交："
echo "词/切点或字幕写入、版本推进与译文/归属/意见对账同事务落库；"
echo "任一步数据库写入或对账失败 → 整次操作连同版本一起回滚，不留半提交，"
echo "客户端可携带旧版本号重试（乐观锁语义不变）。"
echo
echo "完成。"
