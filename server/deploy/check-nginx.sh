#!/usr/bin/env bash
echo '==== nginx 反代验证 ===='
echo -n 'HTTP 80  /api/ping   : '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/ping
echo -n 'HTTPS 443 /api/ping  : '; curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/api/ping
echo -n 'HTTP 80  /login.html : '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/login.html
echo -n 'HTTPS 443 /login.html: '; curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/login.html
echo '---- ping body ----'
curl -s http://127.0.0.1/api/ping; echo
echo '---- 服务状态 ----'
systemctl is-active asset-server nginx
echo '==== 远程IP验证 ===='
echo -n 'http://192.168.40.247/api/ping : '; curl -s -o /dev/null -w '%{http_code}\n' http://192.168.40.247/api/ping
echo -n 'https://192.168.40.247/api/ping: '; curl -sk -o /dev/null -w '%{http_code}\n' https://192.168.40.247/api/ping
