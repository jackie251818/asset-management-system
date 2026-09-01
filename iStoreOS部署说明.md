# 固定资产管理系统 iStoreOS 部署说明（Docker 容器方案）

| 项目 | 说明 |
| --- | --- |
| 适用系统 | iStoreOS（OpenWrt 系软路由系统），x86_64 软路由与 ARM 设备（R2S/R4S/R5S 等）均适用 |
| 部署形态 | Docker 容器（官方 node:20 镜像）+ SQLite 数据库 |
| 配套文档 | 《CS架构部署文档.md》（第 11 章 Linux 部署、第 12 章 CentOS 7）、《CS架构改造收口文档.md》 |
| 文档版本 | v1.0 |

---

## 1. iStoreOS 与部署可行性

### 1.1 iStoreOS 是什么

iStoreOS 是基于 OpenWrt 的软路由操作系统，常见于 x86 软路由（N100 等）与 NanoPi R 系列 ARM 设备，内置 iStore 应用市场与 Docker 支持。与本系统部署相关的两个关键事实：

1. **libc 为 musl**（不是主流发行版的 glibc）——这直接决定了部署路径的选择；
2. **80/443 端口被 LuCI/iStore 管理界面占用**——业务服务不能抢占管理端口。

### 1.2 可行性结论

| 路径 | x86_64 | ARM | 结论与原因 |
| --- | --- | --- | --- |
| 独立产物 `asset-server-linux` | ❌ | ❌ | 双重不匹配：pkg 打包基座要求 glibc ≥ 2.28（musl 不满足），且产物仅提供 x64 版本 |
| opkg 装 Node + 源码裸跑 | ⚠️ | ⚠️ | OpenWrt 源的 node 包是 musl 原生编译可用，但 better-sqlite3 **没有 musl 预编译二进制**，需在路由器上装 gcc/python3 现场编译，脆弱且升级困难，不推荐 |
| **Docker 容器（本方案）** | ✅ | ✅ | 官方 node:20 镜像自带完整 glibc 环境，完全绕开 musl 差异；iStoreOS 内置 Docker，容器内 `npm install` 自动匹配容器架构（x64/arm64），无跨架构问题 |

### 1.3 硬件与资源要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| CPU 架构 | x86_64 或 aarch64 | `uname -m` 确认；镜像为多架构，自动匹配 |
| 内存 | ≥ 1GB，建议 2GB+ | node:20-slim + 本服务约 100-150MB；R2S（1GB）可跑但偏紧，建议加 swap |
| 磁盘 | 镜像约 250MB + 数据目录 | **数据必须放外挂持久盘**（见 2.3），勿放 overlay 根分区 |
| Docker | iStoreOS 内置 | 需在 Web 界面启用（见 2.2） |

### 1.4 部署定位建议（必读）

路由器是网关设备，把业务系统与网关混部意味着**故障域与安全域耦合**：路由器重启/固件升级会中断资产系统，业务端口也增大路由器暴露面。因此：

- **适合**：试用评估、小团队低负载场景、已有 iStoreOS 且不愿加设备；
- **不适合**：正式生产——建议独立主机（Windows 部署包或标准 Linux，见主部署文档第 3、6.4、11 章）；
- 混部期间务必：仅内网使用、不放行 WAN、登录后立即修改默认密码。

---

## 2. 部署前准备

### 2.1 系统检查

SSH 登录 iStoreOS（默认 `root@<路由器IP>`），逐项确认：

```bash
uname -m                # 期望 x86_64 或 aarch64
free -h                 # 内存
df -h                   # 查看挂载点, 确认持久盘已挂载(如 /mnt/sda1)
date                    # 系统时间是否正确(影响日志与备份时间戳)
```

### 2.2 启用 Docker

- Web 界面：左侧菜单 **Docker**（或 iStore 中安装 Docker），确保 Docker 服务已启动并设为开机自启；
- 命令行确认：`docker version` 能输出 Client/Server 版本即可。

### 2.3 持久盘准备（关键）

OpenWrt 的根分区是 overlay 文件系统，**系统升级（sysupgrade）会清空 overlay 上的所有数据**。因此：

```bash
# 以挂载在 /mnt/sda1 的 ext4 硬盘为例(磁盘管理在 Web 界面"系统-磁盘"完成)
mkdir -p /mnt/sda1/asset-server/{server,data,backup,cert}
df -h /mnt/sda1/asset-server    # 确认落在持久盘上
```

> 数据目录不要放在 SMB/NFS 网络挂载或 exFAT/FAT32 分区上（SQLite 文件锁与权限不可靠，同主部署文档 11.12 第 6 条）。

### 2.4 文件清单与上传

需要上传的只有一个目录：**`server/` 源码**（上表中的 `server` 目录）。

- **必须剔除** `server/node_modules`（原生模块需在容器内按容器架构重装）；
- 可一并剔除 `server/data`（保留则首次启动会用其内 .js 数据文件初始化数据库，见主部署文档 4.2）、`server/tests`；
- 上传方式（任选）：
  - Windows PowerShell：`scp -r <项目路径>\server root@<IP>:/mnt/sda1/asset-server/`（上传前先删 node_modules）；
  - WinSCP 图形工具拖拽；
- 上传后确认：`ls /mnt/sda1/asset-server/server/src/index.js` 存在。

### 2.5 部署前检查清单

- [ ] `uname -m` 已确认架构，内存/磁盘满足 1.3
- [ ] Docker 已启用且开机自启（2.2）
- [ ] 持久盘已挂载并创建目录（2.3），不在 overlay 上
- [ ] `server/` 源码已上传且不含 node_modules（2.4）
- [ ] 已知晓默认账号 `admin / admin123`（首次登录改密）

---

## 3. 部署步骤（六步）

### 3.1 容器内安装依赖（首次一次性）

```bash
docker run --rm \
  -v /mnt/sda1/asset-server/server:/app -w /app \
  node:20-slim npm install --omit=dev
```

- 依赖安装在挂载目录内（`server/node_modules`），**容器删除后仍保留**，升级应用时无需重装；
- better-sqlite3 的预编译二进制按容器架构自动匹配（x64/arm64），无需人工干预；
- 完成后检查：`ls /mnt/sda1/asset-server/server/node_modules/better-sqlite3/build/Release/*.node` 存在。

### 3.2 启动服务容器

```bash
docker run -d --name asset-server \
  --restart unless-stopped \
  -p 3456:3456 \
  -e ASSET_DATA_DIR=/app/data \
  -e TZ=Asia/Shanghai \
  -v /mnt/sda1/asset-server/server:/app/server \
  -v /mnt/sda1/asset-server/data:/app/data \
  node:20-slim node /app/server/src/index.js
```

要点：

| 参数 | 作用 |
| --- | --- |
| `--restart unless-stopped` | 容器崩溃自动拉起 + 路由器重启后自动运行（配合 2.2 的 Docker 自启） |
| `-p 3456:3456` | 映射到宿主 3456；**不要映射 80/443**（LuCI 占用，见第 4 章第 1 条） |
| `-e ASSET_DATA_DIR=/app/data` | 数据指向挂载目录，落盘到持久盘 |
| `-e TZ=Asia/Shanghai` | 容器时区，保证日志/备份时间戳正确 |

### 3.3 验证

```bash
docker ps                                    # asset-server 状态 Up
docker logs --tail 20 asset-server           # 启动日志: 监听 0.0.0.0:3456
curl http://127.0.0.1:3456/api/ping          # 返回含 "pong"
```

浏览器访问 `http://<路由器IP>:3456` → 跳转登录页 → `admin / admin123` 登录 → **立即修改密码**。Electron 客户端接入：启动后按 Alt → 设置 → 连接服务器设置 → 填 `http://<路由器IP>:3456` 测试后保存重启（批量预配置也可在 exe 旁放 `server.config.json`）。

### 3.4 开机自启确认

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' asset-server   # unless-stopped
# 重启路由器实测: reboot 后 docker ps 应显示 asset-server 自动 Up
```

### 3.5 防火墙确认（默认即安全，只需不改坏）

OpenWrt 防火墙默认策略对 LAN 区 input 为 **ACCEPT**（内网可访问 3456），对 WAN 区为 **REJECT**（外网不可达）。两条纪律：

1. **不要**在防火墙里给 WAN 区放行 3456——本服务不应暴露公网；
2. 若改过 LAN input 规则导致客户端连不上，在 Web 界面"网络-防火墙"恢复 lan 区"接受输入"。

### 3.6 备份目录

第 3.2 步已把数据目录挂载到 `/mnt/sda1/asset-server/data`，备份会自动落在 `/mnt/sda1/asset-server/data/backups`（持久盘上），详见 5.3。

---

## 4. iStoreOS 特有注意事项

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 80/443 被 LuCI 占用 | 管理界面固定占用；业务一律走 3456，HTTPS 用 8443（第 6 章），**不要**停 LuCI 或抢其端口 |
| 2 | musl libc | 一切"在宿主机直接跑 Node/better-sqlite3"的想法都不可行；全部操作进容器完成 |
| 3 | overlay 根分区易失 | 数据/备份/证书必须在外挂持久盘；sysupgrade 刷机会清空 overlay |
| 4 | 默认 shell 是 ash 不是 bash | 直接执行 `./verify-linux.sh` 会报错；用 `bash verify-linux.sh`（先 `opkg install bash curl`） |
| 5 | ARM 设备（R2S/R4S/R5S） | 流程完全相同，镜像自动 arm64；1GB 机型建议加 swap 并控制并发人数 |
| 6 | 不要装 nginx 宿主服务 | 会与 iStoreOS 自带服务抢端口/资源；反代用容器方案（第 6 章） |
| 7 | 时间同步 | OpenWrt 默认 NTP 一般可用；时间不对会导致 JWT 12h 有效期判断异常（`date` 核查） |
| 8 | 路径全英文 | 挂载目录与上传路径避免中文/空格 |

---

## 5. 日常运维

### 5.1 常用命令

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker ps` / `docker stats asset-server` |
| 查看日志 | `docker logs -f --tail 100 asset-server` |
| 重启 | `docker restart asset-server` |
| 停止/启动 | `docker stop asset-server` / `docker start asset-server` |
| 进入容器 | `docker exec -it asset-server sh` |
| 查看数据 | `ls /mnt/sda1/asset-server/data` |

### 5.2 应用升级

```bash
# 1) 上传新源码覆盖 server/ 目录(剔除 node_modules —— 依赖无变化时无需重装)
# 2) 依赖有变更时重跑 3.1 一次性安装
# 3) 重启容器(数据在挂载目录, 升级不影响)
docker restart asset-server
curl http://127.0.0.1:3456/api/ping
```

回滚：保留旧版 `server/` 目录副本（如 `server.bak-<日期>`），覆盖回去并 restart 即可；数据库带 `dataVersion` 兼容检查，版本回退异常时参考主部署文档 4.5。

### 5.3 备份（在线热备，保留 10 份）

容器内自带工具脚本 `backup.js`（使用 SQLite backup API，**备份期间服务不中断**，自动保留最近 10 份）：

```bash
# 手动备份
docker exec asset-server node /app/server/backup.js
# 备份落在 /mnt/sda1/asset-server/data/backups/asset-<时间戳>.db

# 定时备份(OpenWrt busybox crontab): 每日 02:00
crontab -e
0 2 * * * docker exec asset-server node /app/server/backup.js >> /mnt/sda1/asset-server/backup/cron.log 2>&1
/etc/init.d/cron restart
```

> 备份文件随 data 目录同盘落盘，但**同盘备份不能替代异地备份**——建议每周手动拷一份到其他机器/NAS。

### 5.4 恢复与跨平台迁移

```bash
# 恢复: 停容器 → 用备份 db 覆盖 asset.db → 启动
docker stop asset-server
cp /mnt/sda1/asset-server/data/backups/asset-<时间戳>.db /mnt/sda1/asset-server/data/asset.db
rm -f /mnt/sda1/asset-server/data/asset.db-wal /mnt/sda1/asset-server/data/asset.db-shm
docker start asset-server

# 迁移到 Windows/标准 Linux: 拷 asset.db + secret.key 两个文件即可(跨平台通用, 详见主部署文档 11.10)
```

### 5.5 忘记 admin 密码（容器内重置，无需另装 Node）

```bash
docker exec -e ASSET_DB_PATH=/app/data/asset.db asset-server node /app/server/reset-admin.js 新密码
# 重置后立即登录并再次修改; 重启容器非必需
```

---

## 6. 可选：HTTPS（8443 容器反代）

LuCI 占用 80/443，故用 nginx 容器在 **8443** 提供 HTTPS（内网自签方案，客户端导入证书后无告警；公网正式证书场景请用独立主机）。

```bash
# ① 生成自签证书(SAN 含路由器 IP, 任选其一)
docker run --rm -v /mnt/sda1/asset-server/cert:/cert alpine/openssl req -x509 \
  -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout /cert/server.key -out /cert/server.crt \
  -subj "/CN=asset-server" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<路由器IP>"

# ② 反代配置
cat > /mnt/sda1/asset-server/cert/asset-https.conf <<'EOF'
server {
    listen 8443 ssl;
    ssl_certificate     /etc/nginx/certs/server.crt;
    ssl_certificate_key /etc/nginx/certs/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    location / {
        proxy_pass         http://asset-server:3456;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 64m;
    }
}
EOF

# ③ 同一网络内启动反代容器
docker network create assetnet && docker network connect assetnet asset-server
docker run -d --name asset-https --restart unless-stopped \
  --network assetnet -p 8443:8443 \
  -v /mnt/sda1/asset-server/cert/server.crt:/etc/nginx/certs/server.crt:ro \
  -v /mnt/sda1/asset-server/cert/server.key:/etc/nginx/certs/server.key:ro \
  -v /mnt/sda1/asset-server/cert/asset-https.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx:alpine

# ④ 验证: curl -k https://127.0.0.1:8443/api/ping
```

> 客户端 `serverUrl` 可写 `https://<路由器IP>:8443`；浏览器首次访问需信任证书（或导入 `server.crt`）。

---

## 7. 验证清单

一键脚本验证（SKIP 项为预期）：

```bash
opkg update && opkg install bash curl
DATA_DIR=/mnt/sda1/asset-server/data bash /mnt/sda1/asset-server/server/deploy/verify-linux.sh
```

> 脚本中 systemd/journalctl 相关检查在 OpenWrt（无 systemd）上自动 SKIP，属预期；其余端口/API/数据目录检查正常执行。

| # | 验证项 | 命令/方式 | 期望 |
| --- | --- | --- | --- |
| 1 | 容器状态 | `docker ps` | asset-server Up，重启策略 unless-stopped |
| 2 | API 探活 | `curl http://127.0.0.1:3456/api/ping` | 含 `"pong"` |
| 3 | 前端页面 | 浏览器开 `http://<IP>:3456` | 跳转登录页 |
| 4 | 登录与改密 | admin 登录后修改密码 | 修改成功并可重新登录 |
| 5 | 数据落盘 | `ls -la /mnt/sda1/asset-server/data` | asset.db 存在且在持久盘 |
| 6 | 重启存活 | `reboot` 后 `docker ps` | 自动 Up |
| 7 | WAN 隔离 | 从外网（或断开内网模拟）访问 3456 | 不可达 |
| 8 | 备份链路 | `docker exec asset-server node /app/server/backup.js` | data/backups 生成 .db |
| 9 | （可选）HTTPS | `curl -k https://127.0.0.1:8443/api/ping` | 含 `"pong"` |
| 10 | 客户端接入 | Electron 应用内"连接服务器设置"指向本机（或 `server.config.json`） | 正常登录与增删改查 |

---

## 8. 故障排查 FAQ

**Q1：`docker: command not found`**
Docker 未启用。Web 界面确认 Docker 已安装并启动（2.2），或 iStore 中安装后重试。

**Q2：容器反复重启 / `Exited (1)`**
`docker logs asset-server` 看最后几行。最常见：`Cannot find module ...` = 漏了 3.1 依赖安装步骤；`SQLITE_CANTOPEN` = 数据目录挂载不对或权限问题。

**Q3：报 `better_sqlite3.node: invalid ELF header` 或 `NODE_MODULE_VERSION` 不匹配**
混用了从 Windows 或其他机器拷来的 `node_modules`。删除后重跑 3.1：`rm -rf /mnt/sda1/asset-server/server/node_modules`。

**Q4：3456 端口被占用**
`netstat -tlnp | grep 3456` 找到占用者；改映射端口 `-p 3457:3456`，客户端地址相应带端口。

**Q5：映射 80/443 启动失败**
正常现象——LuCI 占用。业务永远不用这两个端口，见第 4 章第 1 条。

**Q6：路由器重启后数据丢失**
数据目录写到了 overlay 或未用 `-v` 挂载。检查 3.2 的两个 `-v` 参数；`ls /mnt/sda1/asset-server/data/asset.db` 确认。

**Q7：时间不对 / token 频繁过期**
容器缺 TZ 环境变量或宿主时间不同步：核对 3.2 的 `-e TZ` 与系统 NTP（第 4 章第 7 条）。

**Q8：忘记 admin 密码**
容器内重置，见 5.5（无需另装 Node）。

**Q9：根分区空间告警**
Docker 镜像累积：`docker image prune -f`；确认数据目录在外挂盘；必要时 Web 界面"系统-磁盘"扩容。

**Q10：内网其他电脑连不上**
依次：`docker ps` 容器在跑 → 宿主 `curl 127.0.0.1:3456/api/ping` 通 → 客户端 `ping <IP>` 通 → 防火墙 lan 区 input 未被改（3.5）→ 客户端"连接服务器设置"里"测试连接"验证地址与端口。

---

## 9. 与主部署文档的章节对照

| 本文档 | 主部署文档（CS架构部署文档.md） |
| --- | --- |
| 1.2 可行性 | 11 章开头（glibc 要求）、12.1（CentOS 7 同源问题） |
| 3 部署步骤 | 11.4 方式 B（源码）+ 12.3 路径二（Docker） |
| 5.3 备份 | 11.9 定时备份 / 4.4 备份实施 |
| 5.4 恢复/迁移 | 4.5 / 11.10 |
| 6 HTTPS | 11.7（方案二自签证书同源） |
| 7 验证清单 | 11.13（verify-linux.sh 同一脚本） |
| 8 FAQ | 10 章（Q2/Q3 与宿主 FAQ 对应） |
