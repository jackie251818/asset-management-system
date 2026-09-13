#!/usr/bin/env bash
# ============================================================
# 固定资产管理系统 - Ubuntu 源码一键部署脚本 (生产 192.168.40.247 同款)
#
# 与 install-ubuntu.sh (pkg 二进制版) 的区别:
#   生产环境采用源码部署 (V8 字节码跨平台坑, 见 CS架构部署文档.md 11.3),
#   本脚本按生产实际布局部署: systemd 跑 node src/index.js
#
# 用法:
#   sudo bash install-ubuntu-source.sh                  # 部署包 = 脚本所在目录的上两级 (保持项目结构拷贝)
#   sudo bash install-ubuntu-source.sh /opt/asset-deploy  # 显式指定部署包根目录
#
# 部署包根目录需包含 (即项目根的拷贝, 保持相对结构):
#   server/                    服务端源码 (src/ package.json backup.js reset-admin.js deploy/...)
#   index.html login.html styles.css asset_label_print.html
#   final_chart_fix.js build-info.json js/ libs/    前端静态文件
#
# 特性:
#   ✓ 自动安装 Node 22 (无 Node 时, NodeSource) 与编译工具链
#   ✓ 全新安装 + 原地升级 (幂等), 旧版自动备份到 /opt/asset-server.bak-<时间戳>/
#   ✓ 自动迁移旧数据 (asset.db + secret.key)
#   ✓ systemd 源码单元 (User=asset, 与生产 /etc/systemd/system/asset-server.service 一致)
#   ✓ nginx 反代 HTTP 80 + HTTPS 443 自签证书 + /downloads/ 更新文件目录
#   ✓ ufw 防火墙 (SSH + 80 + 443)
#   ✓ 完成后自动探活验证
# ============================================================
set -euo pipefail

GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; }
info() { printf '\033[36m[INFO]\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

DEPLOY_SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
INSTALL_DIR="/opt/asset-server"
SERVICE_NAME="asset-server"
RUN_USER="asset"
RUN_GROUP="asset"
PORT=3456
STATIC_FILES="index.html login.html styles.css asset_label_print.html final_chart_fix.js build-info.json"

echo "=============================================="
echo "  固定资产管理系统 - Ubuntu 源码部署 (生产同款)"
echo "  部署包: $DEPLOY_SRC"
echo "  安装到: $INSTALL_DIR"
echo "  $(date '+%F %T')"
echo "=============================================="

# ---------- Step 0: 环境检查 ----------
step "0. 环境检查"
[ "$(id -u)" -ne 0 ] && { err "请用 sudo 或 root 运行"; exit 1; }
if [ ! -f /etc/os-release ]; then err "无法检测系统"; exit 1; fi
. /etc/os-release
case "$ID" in
    ubuntu|debian) ok "系统: $PRETTY_NAME" ;;
    *) warn "当前系统 $ID 非 Ubuntu/Debian, 建议改用手动步骤 (CS架构部署文档.md 11.4)";;
esac
[ "$(uname -m)" != "x86_64" ] && { err "仅支持 x86_64"; exit 1; }

# 部署包完整性
[ -f "$DEPLOY_SRC/server/src/index.js" ] || { err "缺 $DEPLOY_SRC/server/src/index.js"; exit 1; }
for f in $STATIC_FILES; do
    [ -f "$DEPLOY_SRC/$f" ] || { err "部署包缺前端文件: $f (需与 server/ 同级)"; exit 1; }
done
[ -d "$DEPLOY_SRC/js" ] && [ -d "$DEPLOY_SRC/libs" ] || { err "部署包缺 js/ 或 libs/ 目录"; exit 1; }
ok "部署包完整性检查通过"

# ---------- Step 1: Node.js 与编译工具链 ----------
step "1. Node.js 与编译工具链"
if command -v node &>/dev/null; then
    NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
    [ "$NODE_MAJOR" -lt 18 ] && { err "Node $(node -v) 过旧, 需 ≥ 18 (建议 22)"; exit 1; }
    ok "Node.js $(node -v)"
else
    info "未检测到 Node.js, 通过 NodeSource 安装 Node 22..."
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs
    ok "Node.js $(node -v) 安装完成"
fi
# better-sqlite3 原生模块: 有预编译二进制时无需编译, 工具链装上以备源码编译
if command -v make &>/dev/null && command -v g++ &>/dev/null; then
    ok "编译工具链已存在"
else
    info "安装编译工具链 (build-essential python3)..."
    apt-get update -qq && apt-get install -y -qq build-essential python3
    ok "编译工具链安装完成"
fi

# ---------- Step 2: 创建运行用户 ----------
step "2. 创建运行用户 ($RUN_USER)"
if id "$RUN_USER" &>/dev/null; then
    ok "用户 $RUN_USER 已存在"
else
    useradd -r -s /usr/sbin/nologin "$RUN_USER"
    ok "已创建用户 $RUN_USER (system account)"
fi

# ---------- Step 3: 备份旧版 ----------
step "3. 备份旧版 (如存在)"
OLD_DATA_DIR=""
if [ -d "$INSTALL_DIR" ]; then
    TS="$(date '+%Y%m%d-%H%M%S')"
    BAK_DIR="/opt/asset-server.bak-$TS"
    mv "$INSTALL_DIR" "$BAK_DIR"
    ok "旧版已备份到: $BAK_DIR"
    # 旧数据目录兼容两种布局: 源码版 server/data / 二进制版 data
    for cand in "$BAK_DIR/server/data" "$BAK_DIR/data"; do
        [ -f "$cand/asset.db" ] && OLD_DATA_DIR="$cand" && break
    done
else
    info "全新安装, 无需备份"
fi

# ---------- Step 4: 部署文件 ----------
step "4. 部署文件"
mkdir -p "$INSTALL_DIR/server" "$INSTALL_DIR/downloads"

# 服务端源码 (剔除 node_modules —— 原生模块必须在服务器上按 Linux 重装;
# 剔除 data —— 数据从旧版迁移, 避免把开发机测试数据带上来)
tar -C "$DEPLOY_SRC" -cf - \
    --exclude='server/node_modules' --exclude='server/data' --exclude='server/tests' \
    --exclude='server/dist' --exclude='server/deploy/nginx' --exclude='server/deploy/asset-server.exe' \
    server | tar -C "$INSTALL_DIR" -xf -
ok "服务端源码已部署到 $INSTALL_DIR/server/"

# 前端静态文件 → /opt/asset-server/ 根 (STATIC_ROOT = server/..)
for f in $STATIC_FILES; do cp "$DEPLOY_SRC/$f" "$INSTALL_DIR/$f"; done
cp -r "$DEPLOY_SRC/js" "$INSTALL_DIR/js"
cp -r "$DEPLOY_SRC/libs" "$INSTALL_DIR/libs"
ok "前端静态文件已部署到 $INSTALL_DIR/"

# 迁移旧数据 (asset.db + secret.key + kv_store)
if [ -n "$OLD_DATA_DIR" ]; then
    DATA_TARGET="$INSTALL_DIR/server/data"
    mkdir -p "$DATA_TARGET"
    for f in "$OLD_DATA_DIR"/*; do
        [ -f "$f" ] && cp -n "$f" "$DATA_TARGET/" || true
    done
    ok "旧数据已迁移: $OLD_DATA_DIR → $DATA_TARGET"
    info "旧备份保留在 ${BAK_DIR} (确认新部署正常后可删除)"
fi

# ---------- Step 5: 安装依赖 ----------
step "5. 安装依赖 (npm)"
cd "$INSTALL_DIR/server"
if [ -f package-lock.json ]; then
    npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev
else
    npm install --omit=dev
fi
node -e "require('better-sqlite3')" && ok "依赖安装完成 (better-sqlite3 可加载)"

# ---------- Step 6: systemd 服务 (生产同款) ----------
step "6. systemd 服务"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<'UNITEOF'
[Unit]
Description=Asset Management Server (Koa + SQLite)
After=network.target

[Service]
Type=simple
User=asset
WorkingDirectory=/opt/asset-server/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
Environment=ASSET_HOST=127.0.0.1
Environment=ASSET_PORT=3456
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF
chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo -n "  等待服务就绪 "
READY=0
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PORT/api/ping" 2>/dev/null | grep -q pong; then
        echo " ✓ (${i}s)"; READY=1; break
    fi
    echo -n "."
    sleep 1
done
if [ "$READY" != "1" ]; then
    err "服务未启动 (状态: $(systemctl is-active "$SERVICE_NAME"))"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager
    exit 1
fi
ok "服务运行中 (active), 已设置开机自启"

# ---------- Step 7: nginx 反代 + 自签证书 + downloads ----------
step "7. nginx 反向代理 (HTTP 80 + HTTPS 443 + /downloads/)"
if ! command -v nginx &>/dev/null; then
    apt-get install -y -qq nginx
    ok "nginx 已安装"
else
    ok "nginx 已存在 ($(nginx -v 2>&1))"
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$SERVER_IP" ] && SERVER_IP="192.168.40.247"
HOSTNAME_STR="$(hostname)"

if [ ! -f /etc/nginx/cert/server.crt ]; then
    mkdir -p /etc/nginx/cert
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
        -keyout /etc/nginx/cert/server.key -out /etc/nginx/cert/server.crt \
        -subj "/CN=asset-server" \
        -addext "subjectAltName=DNS:localhost,DNS:${HOSTNAME_STR},IP:127.0.0.1,IP:${SERVER_IP}" 2>/dev/null
    chmod 600 /etc/nginx/cert/server.key
    chmod 644 /etc/nginx/cert/server.crt
    ok "自签证书已生成 (SAN: $SERVER_IP, 10年有效)"
else
    info "自签证书已存在, 跳过生成"
fi

rm -f /etc/nginx/sites-enabled/default

# HTTP 80 (含 /downloads/ 客户端更新文件目录)
cat > /etc/nginx/conf.d/asset.conf <<NGINXEOF
server {
    listen 80;
    server_name _;
    client_max_body_size 64m;
    location /downloads/ {
        alias /opt/asset-server/downloads/;
        autoindex on;
        autoindex_exact_size off;
    }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINXEOF

# HTTPS 443
cat > /etc/nginx/conf.d/asset-ssl.conf <<NGINXEOF
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/nginx/cert/server.crt;
    ssl_certificate_key /etc/nginx/cert/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    client_max_body_size 64m;
    location /downloads/ {
        alias /opt/asset-server/downloads/;
        autoindex on;
        autoindex_exact_size off;
    }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINXEOF

chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR/downloads"
nginx -t
systemctl enable nginx
systemctl restart nginx
ok "nginx 已配置并重启 (80 + 443 + /downloads/)"

# ---------- Step 8: 防火墙 ----------
step "8. 防火墙 (ufw)"
if command -v ufw &>/dev/null; then
    ufw allow OpenSSH 2>/dev/null || ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable 2>/dev/null || true
    ok "ufw 已放行 SSH + 80 + 443"
else
    info "未安装 ufw, 跳过 (如用其他防火墙请自行放行 80/443)"
fi

# ---------- Step 9: 最终验证 ----------
step "9. 最终验证"
check_url() {
    local url="$1" label="$2"
    local code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then ok "$label → 200"
    else err "$label → $code"; return 1; fi
}
VERIFY_FAILED=0
check_url "http://127.0.0.1:$PORT/api/ping"            "API /api/ping (直连)"      || VERIFY_FAILED=1
check_url "http://127.0.0.1/index.html"                "前端 index.html (经 nginx)" || VERIFY_FAILED=1
check_url "http://127.0.0.1/login.html"                "登录页 login.html"          || VERIFY_FAILED=1
check_url "http://127.0.0.1/downloads/"                "/downloads/ 更新文件目录"    || VERIFY_FAILED=1
if [ "$VERIFY_FAILED" = "0" ]; then
    ok "全部检查通过"
else
    warn "存在未通过项, 请按 CS架构部署文档.md 11.13 验证清单排查"
fi

# ---------- 完成 ----------
echo ""
echo "=============================================="
printf "  \033[32m✓ 部署完成 (源码方式, 生产同款)\033[0m\n"
echo "=============================================="
echo ""
echo "  访问地址:  http://$SERVER_IP  |  https://$SERVER_IP (自签证书)"
echo "  服务管理:  systemctl status $SERVICE_NAME"
echo "  查看日志:  journalctl -u $SERVICE_NAME -f"
echo "  数据目录:  $INSTALL_DIR/server/data"
echo "  手动备份:  sudo -u $RUN_USER node $INSTALL_DIR/server/backup.js"
echo "  重置密码:  sudo -u $RUN_USER node $INSTALL_DIR/server/reset-admin.js 新密码"
echo "  默认账号:  admin / admin123 (登录后请立即修改)"
echo "  客户端更新: 发版文件放 $INSTALL_DIR/downloads/ (见 docs/EXE客户端发布更新流程.md)"
echo ""
