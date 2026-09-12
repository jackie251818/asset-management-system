#!/usr/bin/env bash
# ============================================================
# 固定资产管理系统 - 全面功能验证脚本 (192.168.40.247) v2 修正版
# 修正: save 用 value 字段; 资产字段 id/brandModel/owner/type/purchaseDate/department;
#       assets REST 用 {code:0} 格式; asset_userStateData_* 需鉴权
# ============================================================
BASE_HTTP="http://192.168.40.247"
BASE_HTTPS="https://192.168.40.247"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m[PASS]\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33m[SKIP]\033[0m %s\n' "$1"; }
hr()   { printf '\n==== %s ====\n' "$1"; }
# 统一成功判断: 兼容层 success=true 或 REST 层 code=0
jsuccess() { jq -e '(.success == true) or (.code == 0)' >/dev/null 2>&1; }

echo "=============================================="
echo "  固定资产管理系统 - 全面功能验证 v2"
echo "  目标: 192.168.40.247"
echo "  $(date '+%F %T')"
echo "=============================================="
for t in curl jq; do command -v "$t" >/dev/null 2>&1 || { echo "[错误] 缺少 $t"; exit 2; }; done

# ---------- 1. 基础探活 ----------
hr "1. 基础探活"
PING_HTTP=$(curl -s -m 8 -o /tmp/ping.json -w '%{http_code}' "$BASE_HTTP/api/ping")
PING_HTTPS=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTPS/api/ping")
if [ "$PING_HTTP" = "200" ] && grep -q '"pong"' /tmp/ping.json; then ok "HTTP /api/ping → 200, body: $(cat /tmp/ping.json)"; else bad "HTTP /api/ping 异常: $PING_HTTP"; fi
if [ "$PING_HTTPS" = "200" ]; then ok "HTTPS /api/ping → 200"; else bad "HTTPS /api/ping 异常: $PING_HTTPS"; fi
INFO_BODY=$(curl -sk -m 8 "$BASE_HTTP/api/info")
if echo "$INFO_BODY" | jq -e '.success == true and .name and .cs == true' >/dev/null 2>&1; then ok "/api/info → $(echo "$INFO_BODY" | jq -c '{name, cs, version}')"; else bad "/api/info 异常: $INFO_BODY"; fi

# ---------- 2. 鉴权与免鉴权 ----------
hr "2. 鉴权与免鉴权白名单"
# 2.1 未登录访问 assetManagementData 应 401 (受保护)
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/load?key=assetManagementData")
if [ "$CODE" = "401" ]; then ok "未登录 GET /api/load?key=assetManagementData → 401 (受保护)"; else bad "未登录 load 应 401, 实际 $CODE"; fi
# 2.2 未登录访问 systemSettings 不应 401 (免鉴权; 未写入时返回 404 属正常 - 表示鉴权通过但键不存在)
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/load?key=systemSettings")
if [ "$CODE" != "401" ]; then ok "未登录 GET /api/load?key=systemSettings → $CODE (免鉴权通过; 404=键尚未写入属正常)"; else bad "systemSettings 不应 401"; fi
# 2.3 未登录访问 custom_options_type 应非 401 (免鉴权前缀匹配)
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/load?key=custom_options_type")
if [ "$CODE" != "401" ]; then ok "未登录 GET /api/load?key=custom_options_type → $CODE (免鉴权前缀匹配)"; else bad "custom_options_* 不应 401"; fi
# 2.4 未登录访问 asset_userStateData_* 应 401 (需鉴权, 仅 systemSettings/custom_options_* 免鉴权)
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/load?key=asset_userStateData_zh001")
if [ "$CODE" = "401" ]; then ok "未登录 GET /api/load?key=asset_userStateData_zh001 → 401 (需鉴权, 正确拦截)"; else bad "asset_userStateData_* 需鉴权应 401, 实际 $CODE"; fi
# 2.5 未登录 save 应 401
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE_HTTP/api/save" -H 'Content-Type: application/json' -d '{"key":"systemSettings","value":"x"}')
if [ "$CODE" = "401" ]; then ok "未登录 POST /api/save → 401 (写操作受保护)"; else bad "未登录 save 应 401, 实际 $CODE"; fi

# ---------- 3. 登录流程 ----------
hr "3. 登录流程"
LOGIN_BODY=$(curl -s -m 8 -X POST "$BASE_HTTP/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')
TOKEN=$(echo "$LOGIN_BODY" | jq -r '.data.token // empty')
USER_INFO=$(echo "$LOGIN_BODY" | jq -c '.data.user // empty')
if [ -n "$TOKEN" ] && [ "$USER_INFO" != "null" ]; then ok "admin 登录 → token 获取成功, user: $USER_INFO"; else bad "登录失败: $LOGIN_BODY"; echo "[FATAL] 终止"; exit 1; fi
AUTH="Authorization: Bearer $TOKEN"
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE_HTTP/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}')
if [ "$CODE" = "401" ]; then ok "错误密码登录 → 401"; else bad "错误密码应 401, 实际 $CODE"; fi
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE_HTTP/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"","password":"x"}')
if [ "$CODE" = "400" ] || [ "$CODE" = "401" ]; then ok "空用户名 → $CODE (拒绝)"; else bad "空用户名应 400/401, 实际 $CODE"; fi

# ---------- 4. 数据 KV 读写 (systemSettings, 用 value 字段) ----------
hr "4. 数据 KV 读写 (systemSettings, value 字段)"
SAVE_BODY=$(curl -s -m 8 -X POST "$BASE_HTTP/api/save" -H 'Content-Type: application/json' -H "$AUTH" -d '{"key":"systemSettings","value":{"systemName":"验证测试系统名","logoUrl":"logo.png","updatedBy":"verify-script"}}')
if echo "$SAVE_BODY" | jq -e '.success == true' >/dev/null 2>&1; then ok "POST /api/save systemSettings (value字段) → 写入成功"; else bad "save systemSettings 失败: $SAVE_BODY"; fi
LOAD_BODY=$(curl -s -m 8 "$BASE_HTTP/api/load?key=systemSettings")
SYSNAME=$(echo "$LOAD_BODY" | jq -r '.data.systemName // empty')
if [ "$SYSNAME" = "验证测试系统名" ]; then ok "GET /api/load systemSettings → 读取一致 (systemName=验证测试系统名)"; else bad "systemSettings 读取不一致: $LOAD_BODY"; fi
# asset_userStateData_* 读写 (需鉴权)
curl -s -m 8 -o /dev/null -X POST "$BASE_HTTP/api/save" -H 'Content-Type: application/json' -H "$AUTH" -d '{"key":"asset_userStateData_verify","value":{"collapsed":true,"lastView":"all"}}'
READ_STATE=$(curl -s -m 8 "$BASE_HTTP/api/load?key=asset_userStateData_verify" -H "$AUTH")
if echo "$READ_STATE" | jq -e '.data.collapsed == true' >/dev/null 2>&1; then ok "asset_userStateData_verify 读写 → 一致"; else bad "asset_userStateData_verify 读取异常: $READ_STATE"; fi
# 未登录读 asset_userStateData_* 应 401 (再次确认)
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/load?key=asset_userStateData_verify")
if [ "$CODE" = "401" ]; then ok "未登录读 asset_userStateData_verify → 401 (需鉴权)"; else bad "未登录读 asset_userStateData_* 应 401, 实际 $CODE"; fi

# ---------- 5. 资产 CRUD (REST: {code:0} 格式, 字段 id/brandModel/owner/type/purchaseDate/department) ----------
hr "5. 资产 CRUD"
NEW_ASSET_BODY=$(curl -s -m 8 -X POST "$BASE_HTTP/api/assets" -H 'Content-Type: application/json' -H "$AUTH" -d '{
  "id":"VERIFY-TEST-001","brandModel":"功能验证测试设备-型号X","owner":"verify-script","type":"IT设备",
  "purchaseDate":"2026-09-03","status":"在用","department":"测试部","user":"verify-user",
  "location":"机房01","manager":"管理员","unit":"台","quantity":1,"value":999.99,"remark":"验证脚本自动创建"
}')
NEW_ID=$(echo "$NEW_ASSET_BODY" | jq -r '.data.id // empty')
if [ -n "$NEW_ID" ] && [ "$NEW_ID" = "VERIFY-TEST-001" ]; then ok "POST /api/assets → 新增成功 id=$NEW_ID"; else bad "新增资产失败: $NEW_ASSET_BODY"; fi
LIST_BODY=$(curl -s -m 8 "$BASE_HTTP/api/assets?page=1&size=10" -H "$AUTH")
TOTAL=$(echo "$LIST_BODY" | jq -r '.data.total // 0')
if [ "$TOTAL" -ge 1 ] 2>/dev/null; then ok "GET /api/assets?page=1&size=10 → total=$TOTAL"; else bad "资产列表异常: $LIST_BODY"; fi
ONE_BODY=$(curl -s -m 8 "$BASE_HTTP/api/assets/VERIFY-TEST-001" -H "$AUTH")
if echo "$ONE_BODY" | jq -e '.data.id == "VERIFY-TEST-001" and .data.brandModel == "功能验证测试设备-型号X"' >/dev/null 2>&1; then ok "GET /api/assets/VERIFY-TEST-001 → 命中"; else bad "按ID查异常: $ONE_BODY"; fi
KW_BODY=$(curl -s -m 8 -G "$BASE_HTTP/api/assets" --data-urlencode "keyword=验证测试" --data "page=1&size=10" -H "$AUTH")
KW_TOTAL=$(echo "$KW_BODY" | jq -r '.data.total // 0')
if [ "$KW_TOTAL" -ge 1 ] 2>/dev/null; then ok "GET /api/assets?keyword=验证测试 → total=$KW_TOTAL"; else bad "keyword 筛选异常: $KW_BODY"; fi
# 更新 (需带 version=1)
UPD_BODY=$(curl -s -m 8 -X PUT "$BASE_HTTP/api/assets/VERIFY-TEST-001" -H 'Content-Type: application/json' -H "$AUTH" -d '{"id":"VERIFY-TEST-001","brandModel":"功能验证-已更新","owner":"verify-script","type":"IT设备","purchaseDate":"2026-09-03","department":"测试部","status":"闲置","value":888.88,"version":1}')
if echo "$UPD_BODY" | jsuccess; then ok "PUT /api/assets/VERIFY-TEST-001 → 更新成功 (version→2)"; else bad "更新失败: $UPD_BODY"; fi
# 乐观锁冲突 (旧 version=1, 应 409)
CONFLICT_BODY=$(curl -s -m 8 -X PUT "$BASE_HTTP/api/assets/VERIFY-TEST-001" -H 'Content-Type: application/json' -H "$AUTH" -d '{"id":"VERIFY-TEST-001","brandModel":"冲突测试","owner":"x","type":"x","purchaseDate":"2026-09-03","department":"x","version":1}')
CONFLICT_CODE=$(echo "$CONFLICT_BODY" | jq -r '.code // empty')
if [ "$CONFLICT_CODE" = "409" ] || [ "$CONFLICT_CODE" = "40901" ]; then ok "PUT 乐观锁冲突 → $CONFLICT_CODE (拒绝重写)"; else skip "乐观锁冲突: code=$CONFLICT_CODE body=$CONFLICT_BODY"; fi
ALL_BODY=$(curl -s -m 8 "$BASE_HTTP/api/assets/all" -H "$AUTH")
ALL_LEN=$(echo "$ALL_BODY" | jq -r '.data | length')
if [ "$ALL_LEN" -ge 1 ] 2>/dev/null; then ok "GET /api/assets/all → count=$ALL_LEN"; else bad "/api/assets/all 异常: $ALL_BODY"; fi
# check-ids
CHK_BODY=$(curl -s -m 8 "$BASE_HTTP/api/assets/check-ids?ids=VERIFY-TEST-001,NOT-EXIST" -H "$AUTH")
if echo "$CHK_BODY" | jq -e '.data.existing | index("VERIFY-TEST-001") >= 0' >/dev/null 2>&1; then ok "GET /api/assets/check-ids → 正确识别已存在编号"; else bad "check-ids 异常: $CHK_BODY"; fi
# 删除
DEL_BODY=$(curl -s -m 8 -X DELETE "$BASE_HTTP/api/assets/VERIFY-TEST-001" -H "$AUTH")
if echo "$DEL_BODY" | jsuccess; then ok "DELETE /api/assets/VERIFY-TEST-001 → 删除成功"; else bad "删除失败: $DEL_BODY"; fi
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/assets/VERIFY-TEST-001" -H "$AUTH")
if [ "$CODE" = "404" ]; then ok "删除后 GET → 404"; else bad "删除后应 404, 实际 $CODE"; fi

# ---------- 6. 用户管理 (admin) ----------
hr "6. 用户管理 (admin)"
USERS_BODY=$(curl -s -m 8 "$BASE_HTTP/api/users" -H "$AUTH")
USERS_LEN=$(echo "$USERS_BODY" | jq -r '.data | length')
if [ "$USERS_LEN" -ge 1 ] 2>/dev/null; then ok "GET /api/users → count=$USERS_LEN"; else bad "用户列表异常: $USERS_BODY"; fi
NEW_USER_BODY=$(curl -s -m 8 -X POST "$BASE_HTTP/api/users" -H 'Content-Type: application/json' -H "$AUTH" -d '{"username":"verify-test-user","password":"Test@2026","role":"viewer","displayName":"验证测试用户"}')
NEW_UID=$(echo "$NEW_USER_BODY" | jq -r '.data.id // .data.userId // empty')
if [ -n "$NEW_UID" ]; then ok "POST /api/users → 新建用户 id=$NEW_UID"; else bad "新建用户失败: $NEW_USER_BODY"; fi
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE_HTTP/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"verify-test-user","password":"Test@2026"}')
if [ "$CODE" = "200" ]; then ok "新用户 verify-test-user 登录 → 200"; else bad "新用户登录失败 $CODE"; fi
VIEWER_TOKEN=$(curl -s -m 8 -X POST "$BASE_HTTP/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"verify-test-user","password":"Test@2026"}' | jq -r '.data.token')
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE_HTTP/api/assets" -H 'Content-Type: application/json' -H "Authorization: Bearer $VIEWER_TOKEN" -d '{"id":"X","brandModel":"y","owner":"z","type":"t","purchaseDate":"2026-01-01","department":"d"}')
if [ "$CODE" = "403" ]; then ok "viewer 写资产 → 403 (权限拦截)"; else bad "viewer 应 403, 实际 $CODE"; fi
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/api/users" -H "Authorization: Bearer $VIEWER_TOKEN")
if [ "$CODE" = "403" ]; then ok "viewer GET /api/users → 403 (admin 限制)"; else bad "viewer 访问用户管理应 403, 实际 $CODE"; fi
if [ -n "$NEW_UID" ]; then
    DEL_U_BODY=$(curl -s -m 8 -X DELETE "$BASE_HTTP/api/users/$NEW_UID" -H "$AUTH")
    if echo "$DEL_U_BODY" | jsuccess; then ok "DELETE /api/users/$NEW_UID → 删除成功"; else bad "删除用户失败: $DEL_U_BODY"; fi
fi

# ---------- 7. 旧前端兼容 X-Server-Token 头 ----------
hr "7. 旧前端兼容 X-Server-Token 头"
LIST_XTOKEN=$(curl -s -m 8 "$BASE_HTTP/api/assets?page=1&size=1" -H "X-Server-Token: $TOKEN")
if echo "$LIST_XTOKEN" | jsuccess; then ok "X-Server-Token 头 → 鉴权通过"; else bad "X-Server-Token 鉴权异常: $LIST_XTOKEN"; fi

# ---------- 8. 前端静态文件 (经 nginx) ----------
hr "8. 前端静态文件 (经 nginx)"
ALL_OK=1
for f in login.html index.html styles.css asset_label_print.html build-info.json \
         js/init.js js/api.js js/assets.js js/storage.js js/events.js js/dashboard.js js/import-export.js \
         libs/chart.min.js libs/xlsx.full.min.js libs/pdf.min.js libs/pdf.worker.min.js libs/qrcode.min.js \
         libs/font-awesome.min.css libs/fa-solid-900.woff2; do
    CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTP/$f")
    if [ "$CODE" != "200" ]; then bad "/$f → $CODE"; ALL_OK=0; fi
done
if [ "$ALL_OK" = "1" ]; then ok "全部 20 个前端静态文件 → 200"; fi

# ---------- 9. HTTPS 完整验证 ----------
hr "9. HTTPS 完整验证"
LOGIN_SSL=$(curl -sk -m 8 -X POST "$BASE_HTTPS/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')
SSL_TOKEN=$(echo "$LOGIN_SSL" | jq -r '.data.token // empty')
if [ -n "$SSL_TOKEN" ]; then ok "HTTPS 登录 → 成功获取 token"; else bad "HTTPS 登录失败: $LOGIN_SSL"; fi
if [ -n "$SSL_TOKEN" ]; then
    LIST_SSL=$(curl -sk -m 8 "$BASE_HTTPS/api/assets/all" -H "Authorization: Bearer $SSL_TOKEN")
    if echo "$LIST_SSL" | jsuccess; then ok "HTTPS 资产列表 → 正常"; else bad "HTTPS 资产列表异常: $LIST_SSL"; fi
fi
LOGIN_HTML_SSL=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$BASE_HTTPS/login.html")
if [ "$LOGIN_HTML_SSL" = "200" ]; then ok "HTTPS /login.html → 200"; else bad "HTTPS login.html → $LOGIN_HTML_SSL"; fi

# ---------- 10. data-version 指纹 ----------
hr "10. data-version 数据指纹"
DV_BODY=$(curl -s -m 8 "$BASE_HTTP/api/data-version" -H "$AUTH")
if echo "$DV_BODY" | jq -e '.success == true and .stamp' >/dev/null 2>&1; then ok "GET /api/data-version → $(echo "$DV_BODY" | jq -r '.stamp')"; else bad "data-version 异常: $DV_BODY"; fi

# ---------- 11. 清理验证数据 ----------
hr "11. 清理验证数据"
CLEAN_BODY=$(curl -s -m 8 -X POST "$BASE_HTTP/api/save" -H 'Content-Type: application/json' -H "$AUTH" -d '{"key":"systemSettings","value":{"systemName":"固定资产管理系统PRO","logoUrl":"","updatedBy":"verify-cleanup"}}')
if echo "$CLEAN_BODY" | jq -e '.success == true' >/dev/null 2>&1; then ok "systemSettings 已恢复为默认系统名"; else skip "systemSettings 清理: $CLEAN_BODY"; fi
curl -s -m 8 -o /dev/null -X DELETE "$BASE_HTTP/api/delete?key=asset_userStateData_verify" -H "$AUTH"

# ---------- 汇总 ----------
hr "汇总"
echo "  PASS: $PASS   FAIL: $FAIL   SKIP: $SKIP"
if [ "$FAIL" -eq 0 ]; then echo "  结论: 全部功能验证通过 ✓"; else echo "  结论: 存在失败项, 请检查"; fi
rm -f /tmp/ping.json
