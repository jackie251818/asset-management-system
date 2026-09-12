#!/usr/bin/env bash
# ============================================================
# nginx + 自签证书 + 反向代理 一键配置 (Ubuntu)
# 服务端监听 127.0.0.1:3456, nginx 对外 80/443
# ============================================================
set -e

SERVER_IP="192.168.40.247"
HOSTNAME_STR="$(hostname)"

echo "==== 1. 安装 nginx ===="
apt-get install -y nginx

echo "==== 2. 生成自签证书 (SAN 覆盖 localhost/主机名/127.0.0.1/${SERVER_IP}, 有效期 10 年) ===="
mkdir -p /etc/nginx/cert
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout /etc/nginx/cert/server.key -out /etc/nginx/cert/server.crt \
  -subj "/CN=asset-server" \
  -addext "subjectAltName=DNS:localhost,DNS:${HOSTNAME_STR},IP:127.0.0.1,IP:${SERVER_IP}" 2>&1 | grep -v '\.' || true
chmod 600 /etc/nginx/cert/server.key
chmod 644 /etc/nginx/cert/server.crt
echo "证书已生成"

echo "==== 3. 写入 nginx 站点配置 (80 + 443) ===="
# 移除默认站点避免冲突
rm -f /etc/nginx/sites-enabled/default

# HTTP 80 反向代理
cat > /etc/nginx/conf.d/asset.conf <<'EOF'
server {
    listen 80;
    server_name _;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
EOF

# HTTPS 443 反向代理
cat > /etc/nginx/conf.d/asset-ssl.conf <<'EOF'
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/nginx/cert/server.crt;
    ssl_certificate_key /etc/nginx/cert/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
EOF

echo "==== 4. 测试并启用配置 ===="
nginx -t
systemctl enable nginx
systemctl restart nginx
echo "==== 5. nginx 配置完成 ===="
systemctl is-active nginx
echo "DONE"
