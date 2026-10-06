#!/usr/bin/env bash
# 相邻未锁定字幕时间分配（重排）完整调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/layout-api.sh [BASE_URL]
# 例如：bash examples/layout-api.sh http://localhost:3000
#
# 场景：词 A[1000,1100]、B[1500,1600]，镜头切点 1700；每条最多 1 字、
# 最短显示 600ms、字速上限 100。两条都需要 600ms，旧版逐条贪心会先把 A
# 向后延长、挤占 B 在切点前的时间而误报 duration 冲突；联合时间分配后可排出
# A[500,1100]、B[1100,1700]。
set -euo pipefail

BASE="${1:-http://localhost:3000}"

# ---- 小工具：POST/PUT JSON，输出响应体 + 末尾 HTTP 状态码 ----
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

echo "=== 1. 新建项目：词 A/B + 1700ms 切点 + 每条 1 字/最短 600ms/字速 100 ==="
CREATE='{
  "name": "重排时间分配示例",
  "words": [
    {"text": "A", "start_ms": 1000, "end_ms": 1100},
    {"text": "B", "start_ms": 1500, "end_ms": 1600}
  ],
  "cuts": [1700],
  "rules": {"max_chars": 1, "min_duration_ms": 600, "max_cps": 100}
}'
out="$(req POST /api/projects "$CREATE")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID（初始字幕为空，sub_version=0）"

echo
echo "=== 2. 重排（携带 sub_version 乐观锁）==="
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
code="$(echo "$out" | code_of)"
echo "HTTP $code（200=重排成功；422=冲突且不改动任何字幕）"
echo "$out" | body_of | python3 -m json.tool --no-ensure-ascii
# 期望：A[500,1100]（向前借 500ms）、B[1100,1700]（贴切点结束），两条各 600ms
SUB_VER="$(echo "$out" | body_of | jget sub_version)"
SID_A="$(echo "$out" | body_of | jget subtitles.0.id)"
SID_B="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "sub_version=$SUB_VER，行 id：A=$SID_A / B=$SID_B"

echo
echo "=== 3. 相同参数再次重排：幂等，行 ID 与行版本保持不变 ==="
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUB_VER}")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in d["subtitles"]:
  print("  id=%s v%s %s[%s,%s]" % (s["id"], s["version"], s["text"], s["start_ms"], s["end_ms"]))
'
SUB_VER="$(echo "$out" | body_of | jget sub_version)"

echo
echo "=== 4. 改成确实无解的规则（两条各需 900ms，切点前总空间不够）→ 422 duration ==="
out="$(req PUT "/api/projects/$PID/rules" \
  "{\"version\":1,\"max_chars\":1,\"min_duration_ms\":900,\"max_cps\":100}")"
echo "规则已更新：HTTP $(echo "$out" | code_of)"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUB_VER}")"
echo "HTTP $(echo "$out" | code_of)，响应："
echo "$out" | body_of | python3 -m json.tool --no-ensure-ascii
echo "→ 冲突按词段说明所需毫秒数与可用空间；未写入，项目里现有字幕仍是第 2 步的结果。"

echo
echo "=== 5. 恢复可行规则后重排恢复正常 ==="
out="$(req PUT "/api/projects/$PID/rules" \
  '{"version":2,"max_chars":1,"min_duration_ms":600,"max_cps":100}')"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUB_VER}")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("sub_version:", d["sub_version"])
for s in d["subtitles"]:
  print("  id=%s v%s %s[%s,%s] locked=%s" % (s["id"], s["version"], s["text"], s["start_ms"], s["end_ms"], s["locked"]))
'

echo
echo "=== 6. 锁定行原样保留：锁定 A 后再重排，A 的时间一个毫秒都不变 ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID_A" '{"version":1,"locked":true}')"
echo "锁定 A：HTTP $(echo "$out" | code_of)"
CUR_SV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$CUR_SV}")"
echo "重排：HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in d["subtitles"]:
  tag="（锁定，原样保留）" if s["locked"] else ""
  print("  id=%s %s[%s,%s] locked=%s %s" % (s["id"], s["text"], s["start_ms"], s["end_ms"], s["locked"], tag))
'

echo
echo "=== 7. 过期 sub_version 提交 → 409，带当前字幕集 ==="
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
echo "HTTP $(echo "$out" | code_of)：$(echo "$out" | body_of | jget error)"
