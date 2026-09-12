#!/usr/bin/env bash
# ufw 防火墙配置 (务必先放 SSH 再 enable)
set -e
echo '==== ufw 防火墙配置 ===='
# 1. 先放行 SSH (防止自锁)
ufw allow OpenSSH
ufw allow 22/tcp
# 2. 放行 Web 端口 (服务端 3456 仅回环, 无需对外放行)
ufw allow 80/tcp
ufw allow 443/tcp
# 3. 启用 (--force 跳过交互确认)
ufw --force enable
echo '==== ufw 状态 ===='
ufw status verbose
echo 'DONE'
