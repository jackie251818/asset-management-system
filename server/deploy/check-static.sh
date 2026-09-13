#!/usr/bin/env bash
# 前端静态文件健康检查
for f in login.html index.html styles.css asset_label_print.html final_chart_fix.js build-info.json js/init.js js/api.js js/storage.js libs/chart.min.js libs/xlsx.full.min.js libs/pdf.min.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3456/$f")
  printf '  %-30s %s\n' "$f" "$code"
done
echo '--- API ---'
curl -s -o /dev/null -w 'ping=%{http_code}\n' http://127.0.0.1:3456/api/ping
curl -s http://127.0.0.1:3456/api/ping
echo
