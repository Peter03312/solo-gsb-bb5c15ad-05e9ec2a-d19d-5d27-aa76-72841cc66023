#!/usr/bin/env bash
# 正文“可无损冻结”限制的完整调用示例。
#
# 背景：字幕/译文会冻结为 WebVTT 不可变快照，返修核对与批次差异都以对快照的
# 严格解析为准。正文若含【首尾换行、段内空白行（连续换行）、回车(CR/CRLF)、
# 纯空白】，写出的快照会解析成另一个 cue（被判损坏）或尾部换行被静默丢失。
# 因此：
#   - 项目导入、字幕编辑与修订采纳、译文单条/整批回填及历史恢复一律拒绝这类正文，
#     并在错误中指出问题行；合法的“段内单换行”（多行正文）照常可用；
#   - 旧库已存在的不合格正文不影响下载旧快照，但原文/单语/署名/多语交付会在
#     写快照前明确列出问题行（多文件交付整批失败、不占任何导出版本）；
#     修正文后即可照常导出。
#
# 本脚本演示：导入拒绝 → 编辑拒绝 → 合法多行正文 → 修订拒绝/采纳 →
#            译文单条/整批/恢复拒绝 → 旧库坏行导出闸门（原文/单语/署名/多语）→
#            修正后导出成功。
#
# 依赖：bash + curl + python3（仅用于解析 JSON）。
# 用法：bash examples/cue-text-api.sh [BASE_URL]
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
show() { echo "HTTP $(echo "$1" | code_of)  $(echo "$1" | body_of | head -c 400)"; echo; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版 ==="
WORDS='{"name":"正文无损 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "项目 id=$PID，字幕 id=$SID1 / $SID2"

echo
echo "=== 1. 项目导入拒绝：词文本含段内空白行 / 回车（指出词序号与行） ==="
echo "-- 词 0 内部空白行（422）："
req POST /api/projects "$(python3 -c 'import json; print(json.dumps({"name":"坏导入-空白行","words":[
  {"text":"你好\n\n世界","start_ms":0,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2500}],"cuts":[]}))')" | body_of
echo
echo "-- 词 0 含 CRLF 回车（422）："
req POST /api/projects "$(python3 -c 'import json; print(json.dumps({"name":"坏导入-回车","words":[
  {"text":"你好\r\n世界","start_ms":0,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2500}],"cuts":[]}))')" | body_of

echo
echo "=== 2. 字幕编辑拒绝：首尾换行 / 段内空白行（422，指出问题行，不改数据） ==="
echo "-- 首部换行："
show "$(req PATCH "/api/projects/$PID/subtitles/$SID1" "$(python3 -c 'import json; print(json.dumps({"version":1,"text":"\n首部空行"}))')")"
echo "-- 尾部换行（导出时会被静默丢失）："
show "$(req PATCH "/api/projects/$PID/subtitles/$SID1" "$(python3 -c 'import json; print(json.dumps({"version":1,"text":"尾部空行\n"}))')")"
echo "-- 段内空白行（会把一个 cue 劈成两个块）："
show "$(req PATCH "/api/projects/$PID/subtitles/$SID1" "$(python3 -c 'import json; print(json.dumps({"version":1,"text":"第一行\n\n第二行"}))')")"

echo
echo "=== 3. 合法的段内单换行：可保存、可无损导出（读回仍为两行） ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"上行\n下行"}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
show "$out"
out="$(req POST "/api/projects/$PID/exports" "{\"sub_version\":$SUBV}")"
echo "导出 HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin); print("快照正文片段："); print("\n".join(d["content"].splitlines()[:8]))'
# 上面的导出占用 v1；后续“旧库坏行”闸门示例需要重新排版过的干净状态，不影响演示

echo
echo "=== 4. 批量修订提议：坏文本提交即 400；好文本可采纳 ==="
echo "-- 提交坏文本（400，不保存提议）："
show "$(req POST "/api/projects/$PID/revisions" \
  "$(python3 -c 'import json,sys; print(json.dumps({"items":[{"subtitle_id":int(sys.argv[1]),"cue_version":2,"text":"坏\n"}]}))' "$SID1")")"
echo "-- 提交合法多行正文并采纳（201 → 200）："
out="$(req POST "/api/projects/$PID/revisions" \
  "$(python3 -c 'import json,sys; print(json.dumps({"items":[{"subtitle_id":int(sys.argv[1]),"cue_version":2,"text":"修订\n多行"}]}))' "$SID1")")"
RID="$(echo "$out" | body_of | jget id)"
show "$(req POST "/api/projects/$PID/revisions/$RID/accept")"

echo
echo "=== 5. 译文单条保存：坏文本 → 422（指出行，不写入）；多行合法 → 201 ==="
echo "-- 尾部换行："
show "$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" "$(python3 -c 'import json; print(json.dumps({"text":"Hello\n","cue_version":3}))')")"
echo "-- 段内单换行（合法）："
show "$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Line one\nLine two","cue_version":3}')"

echo
echo "=== 6. 整批译文回填：任一行坏文本 → 422 按行给原因，整批不写入、不占编号 ==="
show "$(req POST "/api/projects/$PID/translations/ja/batches" "$(python3 -c 'import json,sys
s1,s2=int(sys.argv[1]),int(sys.argv[2])
print(json.dumps({"batch_no":"J-0001","sub_version":3,"rules_version":1,"items":[
  {"subtitle_id":s1,"cue_version":3,"version":0,"text":"こんにちは"},
  {"subtitle_id":s2,"cue_version":1,"version":0,"text":"ありがとう\n"}
]}))' "$SID1" "$SID2")")"
echo "（修正第 2 行后用同一编号 J-0001 即可成功；见 examples/translation-batches-api.sh）"

echo
echo "=== 7. 旧库已有的不合格源正文：导出闸门明确列出问题行，不生成快照 ==="
echo "说明：旧库（限制收紧前）可能已有坏正文。此处通过接口侧效果演示——先把字幕改成"
echo "合法但多行的正文，再演示闸门返回形状（cue_text_unsafe 冲突）。"
echo "-- 正常情况下当前正文均合规，原文导出成功；若库中存在坏行，响应形如："
cat <<'JSON'
{
  "error": "字幕未通过导出校验（N 处问题），未生成文件",
  "conflicts": [{
    "type": "cue_text_unsafe",
    "subtitle_id": 12, "idx": 5, "line": 2, "label": "tail",
    "word_start": 10, "word_end": 12,
    "message": "字幕 12（第 6 行）正文第 2 行后存在尾部空行，无法无损写成单个 WebVTT cue：……"
  }]
}
JSON
echo
echo "单语言导出额外在 conflicts 给出源坏行、在 invalid[] 给出坏译文；"
echo "署名版导出额外在 rows[].codes 给出 cue_text_unsafe / translation_invalid；"
echo "多语交付任一语言任一行坏都 422，原文/各语言快照均不生成、不占任何序列版本。"
echo "修正对应行后重新调用 POST …/exports、…/translations/:lang/exports、"
echo "…/attributed-exports、…/deliveries 即可照常冻结。"

echo
echo "=== 8. 最终：把全部译文补齐后，单语言导出成功且多行正文读回无损 ==="
show "$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}')"
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/translations/en/exports" "{\"sub_version\":$SUBV}")"
echo "导出 HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(d["content"].splitlines()[:8]))'
