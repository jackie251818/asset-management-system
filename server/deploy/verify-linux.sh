#!/usr/bin/env bash
# ==============================================================
# 固定资产管理系统 - Linux 部署验证脚本 (只读, 不修改任何配置)
#
# 用法:
#   bash verify-linux.sh                 # 常规验证(建议 root/sudo 运行以读取服务日志)
#   PORT=3456 SERVICE_NAME=asset-server bash verify-linux.sh
#
# 可用环境变量:
#   SERVICE_NAME  systemd 服务名         (默认 asset-server)
#   PORT          服务端端口             (默认 3456)
#   WEB_HOST      nginx 探活地址         (默认 127.0.0.1)
#   DATA_DIR      数据目录               (默认自动在常见路径中查找)
#
# 退出码: 0=无 FAIL 项; 1=存在 FAIL 项; 2=环境不满足(缺 curl)
# 覆盖部署文档 11.13 节验证清单(含手工命令对照表)。
# ==============================================================
set -u

SERVICE_NAME="${SERVICE_NAME:-asset-server}"
PORT="${PORT:-3456}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m[PASS]\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33m[SKIP]\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$1"; }
hr()   { printf '\n==== %s ====\n' "$1"; }

echo "=============================================="
echo "  固定资产管理系统 - Linux 部署验证"
echo "  $(date '+%F %T')"
echo "=============================================="

# ---------- 前置工具 ----------
for t in curl grep; do
    if ! command -v "$t" >/dev/null 2>&1; then
        echo "[错误] 缺少 $t, 请先安装后重试 (如: sudo apt install curl)"
        exit 2
    fi
done
command -v ss >/dev/null 2>&1 && HAVE_SS=1 || HAVE_SS=0

# ---------- [1] 系统环境 (第 11 章前置要求) ----------
hr "1. 系统环境"
ARCH="$(uname -m)"
ok "架构: $ARCH"
if [ "$ARCH" != "x86_64" ]; then
    warn "打包产物 asset-server-linux 仅支持 x86_64; 当前架构需源码方式部署"
fi
if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    ok "系统: ${PRETTY_NAME:-未知}"
fi
GLIBC_VER="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | tail -1)"
if [ -n "${GLIBC_VER:-}" ]; then
    LOWEST="$(printf '2.28\n%s\n' "$GLIBC_VER" | sort -V | head -1)"
    if [ "$LOWEST" = "2.28" ]; then
        ok "glibc: $GLIBC_VER (≥ 2.28, 满足打包产物要求)"
    else
        warn "glibc: $GLIBC_VER < 2.28, 打包产物无法运行, 需源码方式并升级系统"
    fi
else
    skip "glibc 版本未知(未找到 ldd)"
fi

# ---------- [2] systemd 服务状态 (11.13-服务状态) ----------
hr "2. systemd 服务 ($SERVICE_NAME)"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    ST="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
    if [ "$ST" = "active" ]; then
        ok "服务状态: active (running)"
    else
        bad "服务状态: $ST (期望 active) — 查看日志: journalctl -u $SERVICE_NAME -n 50"
    fi
    EN="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
    if [ "$EN" = "enabled" ]; then
        ok "开机自启: enabled"
    else
        warn "开机自启: ${EN:-未知} — 建议: sudo systemctl enable $SERVICE_NAME"
    fi
else
    skip "未发现 systemd 单元 $SERVICE_NAME.service (非 systemd 部署或单元未安装)"
fi

# ---------- [3] 端口监听 ----------
hr "3. 端口监听"
port_listening() { # $1=port
    if [ "$HAVE_SS" = "1" ]; then
        ss -tln 2>/dev/null | grep -qE "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\*):$1([^0-9]|$)" && return 0
    fi
    # 兜底: netstat(Linux net-tools 用 -tln; 其他环境用 -an + LISTEN 行)
    netstat -tln 2>/dev/null | grep -qE "[:.]$1([^0-9]|$)" && return 0
    netstat -an 2>/dev/null | grep -i listen | grep -qE "[:.]$1([^0-9]|$)"
}
if port_listening "$PORT"; then
    ok "服务端端口 $PORT 监听中"
else
    bad "服务端端口 $PORT 未监听 — 检查服务是否启动 / ASSET_HOST 是否误设为回环但探活用了其他地址"
fi
for p in 80 443; do
    if port_listening "$p"; then
        ok "Web 端口 $p 监听中 (nginx)"
    else
        skip "Web 端口 $p 未监听 (未部署 nginx 反代时属正常)"
    fi
done

# ---------- [4] 服务端 API 探活 (11.13-服务端探活) ----------
hr "4. 服务端 API (http://127.0.0.1:$PORT)"
PING_BODY="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)"
if printf '%s' "$PING_BODY" | grep -q '"pong"'; then
    ok "/api/ping 响应正常: $PING_BODY"
else
    bad "/api/ping 无有效响应 (响应: ${PING_BODY:-空}) — 服务未启动或端口不对"
fi
INFO_BODY="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/info" 2>/dev/null || true)"
if [ -n "$INFO_BODY" ]; then
    echo "  [INFO] /api/info: $(printf '%s' "$INFO_BODY" | head -c 200)"
fi

# ---------- [5] 前端页面 (静态资源) ----------
hr "5. 前端页面"
for page in login.html index.html; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/$page" 2>/dev/null || echo 000)"
    if [ "$CODE" = "200" ]; then
        ok "/$page → HTTP 200"
    else
        bad "/$page → HTTP $CODE (期望 200)"
    fi
done

# ---------- [6] nginx HTTP 反代 (11.13-nginx 探活) ----------
hr "6. nginx 反代 (http://$WEB_HOST)"
if port_listening 80; then
    P80="$(curl -fsS -m 5 "http://$WEB_HOST/api/ping" 2>/dev/null || true)"
    if printf '%s' "$P80" | grep -q '"pong"'; then
        ok "80 端口反代正常"
    else
        bad "80 端口反代失败 (响应: ${P80:-空}) — 检查 nginx 配置 proxy_pass 与 upstream"
    fi
else
    skip "80 端口未监听, 跳过 HTTP 反代检查"
fi

# ---------- [7] HTTPS 探活 (11.13-HTTPS 探活) ----------
hr "7. HTTPS (https://$WEB_HOST)"
if port_listening 443; then
    P443="$(curl -kfsS -m 5 "https://$WEB_HOST/api/ping" 2>/dev/null || true)"
    if printf '%s' "$P443" | grep -q '"pong"'; then
        ok "443 端口 HTTPS 反代正常 (-k 忽略自签告警)"
    else
        bad "443 端口 HTTPS 探活失败 — 检查证书路径与 nginx ssl 配置"
    fi
    if command -v openssl >/dev/null 2>&1; then
        CERT_INFO="$(echo | openssl s_client -connect "$WEB_HOST":443 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null || true)"
        if [ -n "$CERT_INFO" ]; then
            echo "  [INFO] 证书信息: $(printf '%s' "$CERT_INFO" | tr '\n' ' ')"
        fi
    fi
else
    skip "443 端口未监听, 跳过 HTTPS 检查"
fi

# ---------- [8] 数据目录与数据库 (11.13-浏览器登录前置) ----------
hr "8. 数据目录与数据库"
DATA_FOUND=""
for d in "${DATA_DIR:-}" "/opt/asset-server/data" "/opt/asset-server/server/data" "/var/lib/asset-server" "$PWD/data"; do
    if [ -n "$d" ] && [ -f "$d/asset.db" ]; then DATA_FOUND="$d"; break; fi
done
if [ -n "$DATA_FOUND" ]; then
    ok "数据库: $DATA_FOUND/asset.db ($(du -h "$DATA_FOUND/asset.db" 2>/dev/null | cut -f1))"
    if [ -f "$DATA_FOUND/secret.key" ]; then
        ok "JWT 密钥: secret.key 存在"
    else
        warn "secret.key 不存在 (首次启动会自动生成; 若为迁移而来请确认已拷贝, 否则已登录客户端 token 会失效)"
    fi
    if [ -f "$DATA_FOUND/asset.db-wal" ]; then
        echo "  [INFO] WAL 文件存在(运行中属正常): $(du -h "$DATA_FOUND/asset.db-wal" | cut -f1)"
    fi
    if [ ! -w "$DATA_FOUND" ]; then
        bad "数据目录不可写: $DATA_FOUND — 检查属主(应为服务运行用户, 如 asset)"
    else
        ok "数据目录可写"
    fi
else
    bad "未找到 asset.db — 检查 ASSET_DATA_DIR / 数据目录挂载; 可用 DATA_DIR=/路径 bash verify-linux.sh 指定"
fi

# ---------- [9] 磁盘空间 ----------
hr "9. 磁盘空间"
DISK_CHECK_DIR="${DATA_FOUND:-/opt/asset-server}"
if [ -d "$DISK_CHECK_DIR" ]; then
    FREE_MB="$(df -Pm "$DISK_CHECK_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
    if [ -n "$FREE_MB" ]; then
        if [ "$FREE_MB" -lt 100 ]; then
            bad "剩余空间仅 ${FREE_MB}MB (<100MB), 立即清理或扩容"
        elif [ "$FREE_MB" -lt 1024 ]; then
            warn "剩余空间 ${FREE_MB}MB (<1GB), 建议关注(数据库随附件增长)"
        else
            ok "剩余空间 ${FREE_MB}MB"
        fi
    fi
else
    skip "未找到部署目录, 跳过"
fi

# ---------- [10] 近 24h 服务错误日志 ----------
hr "10. 近 24h 服务错误日志"
if command -v journalctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    ERR_LINES="$(journalctl -u "$SERVICE_NAME" --since '-24h' --no-pager 2>/dev/null | grep -icE 'error|exception|fatal' || true)"
    if [ "${ERR_LINES:-0}" -gt 0 ]; then
        warn "发现 $ERR_LINES 行错误关键字, 最近样例:"
        journalctl -u "$SERVICE_NAME" --since '-24h' --no-pager 2>/dev/null \
            | grep -iE 'error|exception|fatal' | tail -3 | sed 's/^/         /'
    else
        ok "近 24h 无错误关键字"
    fi
else
    skip "无 systemd 日志可查(非 systemd 部署)"
fi

# ---------- 汇总 ----------
hr "汇总"
echo "  PASS: $PASS   FAIL: $FAIL   SKIP: $SKIP"
if [ "$FAIL" -eq 0 ]; then
    echo ""
    printf '  结论: \033[32m验证通过\033[0m — 部署符合预期 (SKIP 项为可选组件)\n'
    exit 0
else
    echo ""
    printf '  结论: \033[31m存在 %s 项未通过\033[0m — 请按上方提示修复后重试\n' "$FAIL"
    echo "  更多排查: 部署文档第 10 章 FAQ / 第 11.13 节验证清单"
    exit 1
fi
