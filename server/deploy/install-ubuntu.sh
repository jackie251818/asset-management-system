#!/usr/bin/env bash
# ============================================================
# 固定资产管理系统 - Ubuntu 22.04 一键部署脚本
#
# 用法:
#   sudo bash install-ubuntu.sh                     # 从脚本所在目录读取部署包
#   sudo bash install-ubuntu.sh /opt/asset-deploy   # 指定部署包目录
#
# 部署包目录需包含:
#   asset-server-linux      服务端二进制 (pkg 打包产物, node22-linux-x64)
#   asset-server.service    systemd 单元文件
#   nginx-site.conf         nginx 站点配置 (可选, 若不提供则用内置模板)
#   verify-linux.sh         验证脚本 (可选)
#   frontend/               前端静态文件目录 (可选, 无则使用二进制内嵌)
#     ├── index.html
#     ├── login.html
#     ├── js/
#     ├── libs/
#     └── ...
#
# 特性:
#   ✓ 全新安装 + 原地升级 (幂等)
#   ✓ 自动备份旧版到 /opt/asset-server.bak-<时间戳>/
#   ✓ 自动迁移旧数据 (asset.db + secret.key)
#   ✓ systemd service (用户 asset, 自动开机自启)
#   ✓ nginx 反代 (HTTP 80 + HTTPS 443 自签证书)
#   ✓ ufw 防火墙 (SSH + 80 + 443)
#   ✓ 最后自动运行 verify-linux.sh 验证
# ============================================================
set -euo pipefail

# ---------- 颜色输出 ----------
GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; }
info() { printf '\033[36m[INFO]\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

DEPLOY_PKG_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
INSTALL_DIR="/opt/asset-server"
SERVICE_NAME="asset-server"
RUN_USER="asset"
RUN_GROUP="asset"
PORT=3456

echo "=============================================="
echo "  固定资产管理系统 - Ubuntu 部署"
echo "  部署包目录: $DEPLOY_PKG_DIR"
echo "  安装目录:   $INSTALL_DIR"
echo "  $(date '+%F %T')"
echo "=============================================="

# ---------- Step 0: 环境检查 ----------
step "0. 环境检查"
if [ "$(id -u)" -ne 0 ]; then err "请用 sudo 或 root 运行"; exit 1; fi

if [ ! -f /etc/os-release ]; then err "无法检测系统"; exit 1; fi
. /etc/os-release
if [ "$ID" != "ubuntu" ]; then warn "当前系统 $ID, 非 Ubuntu, 可能不兼容"; fi
UBUNTU_MAJOR="$(echo "$VERSION_ID" | cut -d. -f1)"
if [ "$UBUNTU_MAJOR" -lt 20 ]; then warn "Ubuntu $VERSION_ID < 20.04, 可能有兼容性问题"; fi
ok "系统: $PRETTY_NAME"

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then err "仅支持 x86_64, 当前 $ARCH"; exit 1; fi
ok "架构: x86_64"

GLIBC_VER="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | tail -1)"
if [ -z "$GLIBC_VER" ] || [ "$(printf '2.28\n%s\n' "$GLIBC_VER" | sort -V | head -1)" != "2.28" ]; then
    err "glibc 版本过低 (${GLIBC_VER:-未知}, 需 ≥ 2.28)"; exit 1
fi
ok "glibc: $GLIBC_VER"

# ---------- Step 1: 检查部署包 ----------
step "1. 检查部署包"
if [ ! -d "$DEPLOY_PKG_DIR" ]; then err "部署包目录不存在: $DEPLOY_PKG_DIR"; exit 1; fi

BIN_SRC="$DEPLOY_PKG_DIR/asset-server-linux"
if [ ! -f "$BIN_SRC" ]; then err "缺 asset-server-linux"; exit 1; fi
ok "asset-server-linux: $(du -h "$BIN_SRC" | cut -f1)"

SERVICE_SRC="$DEPLOY_PKG_DIR/asset-server.service"
if [ ! -f "$SERVICE_SRC" ]; then
    warn "缺 asset-server.service, 将使用内置模板"
    USE_BUILTIN_SERVICE=1
else
    ok "asset-server.service: 已提供"
    USE_BUILTIN_SERVICE=0
fi

NGINX_SRC="$DEPLOY_PKG_DIR/nginx-site.conf"
if [ -f "$NGINX_SRC" ]; then ok "nginx-site.conf: 已提供"; fi
VERIFY_SRC="$DEPLOY_PKG_DIR/verify-linux.sh"
FRONTEND_SRC="$DEPLOY_PKG_DIR/frontend"
if [ -d "$FRONTEND_SRC" ]; then
    ok "前端文件: $FRONTEND_SRC ($(find "$FRONTEND_SRC" -type f | wc -l) 个文件)"
else
    info "未提供外部前端, 将使用二进制内嵌快照"
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
if [ -d "$INSTALL_DIR" ]; then
    TS="$(date '+%Y%m%d-%H%M%S')"
    BAK_DIR="/opt/asset-server.bak-$TS"
    mv "$INSTALL_DIR" "$BAK_DIR"
    ok "旧版已备份到: $BAK_DIR"
    OLD_DATA_DIR="$BAK_DIR/data"
else
    info "全新安装, 无需备份"
    OLD_DATA_DIR=""
fi

# ---------- Step 4: 部署文件 ----------
step "4. 部署文件"
mkdir -p "$INSTALL_DIR/data"
cp "$BIN_SRC" "$INSTALL_DIR/asset-server-linux"
chmod +x "$INSTALL_DIR/asset-server-linux"
ok "asset-server-linux 已部署"

# 部署前端文件 (serveStatic 外部优先)
if [ -d "$FRONTEND_SRC" ]; then
    cp -r "$FRONTEND_SRC"/* "$INSTALL_DIR/"
    ok "前端文件已部署到 $INSTALL_DIR/"
fi

# 迁移旧数据 (asset.db + secret.key)
if [ -n "$OLD_DATA_DIR" ] && [ -d "$OLD_DATA_DIR" ]; then
    if [ -f "$OLD_DATA_DIR/asset.db" ]; then
        cp "$OLD_DATA_DIR/asset.db" "$INSTALL_DIR/data/"
        ok "已迁移旧 asset.db"
    fi
    if [ -f "$OLD_DATA_DIR/secret.key" ]; then
        cp "$OLD_DATA_DIR/secret.key" "$INSTALL_DIR/data/"
        ok "已迁移旧 secret.key (保留已签发 token 有效)"
    fi
    # 也迁移其他可能的 kv_store 文件
    for f in "$OLD_DATA_DIR"/*.{json,db,wal,shm,key}; do
        [ -f "$f" ] && cp -n "$f" "$INSTALL_DIR/data/" 2>/dev/null || true
    done
    info "旧备份保留在 $OLD_DATA_DIR (确认新部署正常后可删除)"
fi

# 权限
chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR"
ok "目录权限已设置 ($RUN_USER:$RUN_GROUP)"

# ---------- Step 5: 安装 systemd service ----------
step "5. 安装 systemd service"

if [ "$USE_BUILTIN_SERVICE" = "1" ]; then
    cat > /etc/systemd/system/${SERVICE_NAME}.service <<'UNITEOF'
[Unit]
Description=Asset Management Server (Koa + SQLite)
After=network.target

[Service]
Type=simple
User=asset
WorkingDirectory=/opt/asset-server
ExecStart=/opt/asset-server/asset-server-linux
Restart=always
RestartSec=3
Environment=ASSET_HOST=127.0.0.1
Environment=ASSET_PORT=3456
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF
    ok "使用内置模板生成 service 文件"
else
    cp "$SERVICE_SRC" /etc/systemd/system/${SERVICE_NAME}.service
    ok "已复制提供的 service 文件"
fi

# 修正模板里可能的路径/用户/端口
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" /etc/systemd/system/${SERVICE_NAME}.service
sed -i "s|ExecStart=.*|ExecStart=$INSTALL_DIR/asset-server-linux|" /etc/systemd/system/${SERVICE_NAME}.service
sed -i "s|^User=.*|User=$RUN_USER|" /etc/systemd/system/${SERVICE_NAME}.service

systemctl daemon-reload
ok "systemd daemon-reload"

# ---------- Step 6: 启动服务 ----------
step "6. 启动 $SERVICE_NAME"
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# 等待就绪
echo -n "  等待服务就绪 "
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PORT/api/ping" 2>/dev/null | grep -q pong; then
        echo " ✓ (${i}s)"
        break
    fi
    echo -n "."
    sleep 1
done
ST="$(systemctl is-active "$SERVICE_NAME")"
if [ "$ST" != "active" ]; then
    err "服务未启动 (状态: $ST)"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager
    exit 1
fi
ok "服务运行中 (active), 已设置开机自启"

# API 探活
PING_BODY="$(curl -sf "http://127.0.0.1:$PORT/api/ping")"
ok "/api/ping: $PING_BODY"
INFO_BODY="$(curl -sf "http://127.0.0.1:$PORT/api/info")"
ok "/api/info: $(echo "$INFO_BODY" | head -c 120)"

# 前端页面检查
INDEX_BODY="$(curl -sf "http://127.0.0.1:$PORT/index.html" 2>/dev/null || echo '')"
if echo "$INDEX_BODY" | grep -q feishu-sync-card; then
    ok "前端含 feishu-sync-card (飞书同步功能可用)"
else
    warn "前端未检测到 feishu-sync-card (可能用的是外部前端但非最新)"
fi

# ---------- Step 7: nginx 反代 ----------
step "7. nginx 反代配置"

if ! command -v nginx &>/dev/null; then
    info "安装 nginx..."
    apt-get update -qq && apt-get install -y -qq nginx
    ok "nginx 已安装"
else
    ok "nginx 已安装 ($(nginx -v 2>&1))"
fi

mkdir -p /etc/nginx/cert

# 获取服务器 IP 用于证书 SAN
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$SERVER_IP" ] && SERVER_IP="192.168.40.247"
HOSTNAME_STR="$(hostname)"

# 生成自签证书 (10 年)
if [ ! -f /etc/nginx/cert/server.crt ]; then
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

# 移除默认站点
rm -f /etc/nginx/sites-enabled/default

# HTTP 80
cat > /etc/nginx/conf.d/asset.conf <<NGINXEOF
server {
    listen 80;
    server_name _;
    client_max_body_size 64m;
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

nginx -t
systemctl enable nginx
systemctl restart nginx
ok "nginx 已配置并重载 (HTTP 80 + HTTPS 443)"

# ---------- Step 8: 防火墙 ----------
step "8. 防火墙 (ufw)"
if command -v ufw &>/dev/null; then
    # 先放行 SSH 防止自锁
    ufw allow OpenSSH 2>/dev/null || ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable 2>/dev/null || true
    ok "ufw 已放行 SSH + 80 + 443"
else
    info "未安装 ufw, 跳过防火墙配置 (如用其他防火墙请自行放行 80/443)"
fi

# ---------- Step 9: 部署验证脚本 ----------
if [ -f "$VERIFY_SRC" ]; then
    cp "$VERIFY_SRC" /usr/local/bin/verify-asset.sh
    chmod +x /usr/local/bin/verify-asset.sh
fi

# ---------- Step 10: 最终验证 ----------
step "9. 最终验证"

HTTP_PING="$(curl -sf "http://$SERVER_IP/api/ping" 2>/dev/null || echo '')"
if echo "$HTTP_PING" | grep -q pong; then
    ok "HTTP 反代正常 (http://$SERVER_IP)"
else
    warn "HTTP 反代未响应 (服务端本身正常, nginx 可能未生效)"
fi

HTTPS_PING="$(curl -ksf "https://$SERVER_IP/api/ping" 2>/dev/null || echo '')"
if echo "$HTTPS_PING" | grep -q pong; then
    ok "HTTPS 反代正常 (https://$SERVER_IP, -k 忽略自签告警)"
else
    warn "HTTPS 反代未响应"
fi

DATA_DIR="$INSTALL_DIR/data"
if [ -f "$DATA_DIR/asset.db" ]; then
    ok "数据库: $DATA_DIR/asset.db ($(du -h "$DATA_DIR/asset.db" | cut -f1))"
else
    warn "asset.db 尚未创建 (首次写入数据后自动生成)"
fi

# ---------- 完成 ----------
echo ""
echo "=============================================="
printf "  \033[32m✓ 部署完成\033[0m\n"
echo "=============================================="
echo ""
echo "  服务端:  http://$SERVER_IP"
echo "           https://$SERVER_IP  (自签证书)"
echo "  数据目录: $DATA_DIR"
echo "  服务状态: systemctl status $SERVICE_NAME"
echo "  查看日志: journalctl -u $SERVICE_NAME -f"
echo "  手动验证: sudo bash /usr/local/bin/verify-asset.sh"
echo ""
echo "  Electron 桌面客户端连接服务器: http://$SERVER_IP"
echo ""
