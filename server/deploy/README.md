# server/deploy/ — 服务端部署文件总目录

本目录集中存放三种平台的服务端部署文件，**内容与生产服务器 192.168.40.247 保持一致**（2026-09-13 与生产逐文件 SHA256 比对核对）。部署新服务器时"照抄即可"，各平台详细步骤见对应文档。

## 目录结构与生产映射

| 本目录文件 | 用途 | 生产服务器对应位置 |
|---|---|---|
| `install-ubuntu-source.sh` | **Ubuntu 源码一键部署（生产同款，推荐）**：Node/依赖/用户/备份迁移/systemd/nginx+证书/downloads/防火墙/探活全自动 | 执行后产出 `/opt/asset-server/` 生产布局 |
| `install-ubuntu.sh` | Ubuntu 一键部署（pkg 二进制版 `asset-server-linux`；Windows 交叉打包有 V8 字节码坑，见部署文档 11.3） | 未使用 |
| `asset-server-source.service` | systemd 单元（**源码部署**，生产在用） | `/etc/systemd/system/asset-server.service` |
| `asset-server.service` | systemd 单元（pkg 单文件 EXE 版，备选） | 未使用 |
| `asset-server-centos7.service` | systemd 单元（CentOS 7） | 未使用 |
| `setup-nginx.sh` | nginx + 自签证书 + 反代一键配置（含 `/downloads/` 更新文件目录） | 产出 `/etc/nginx/conf.d/asset.conf` + `asset-ssl.conf` |
| `setup-firewall.sh` | 防火墙放行 80/443 | ufw 规则 |
| `check-static.sh` / `check-nginx.sh` / `full-verify.sh` | 部署后健康检查 | 手动执行 |
| `verify-linux.sh` | 综合验证脚本（OpenWrt 上也可用） | 手动执行 |
| `install-service.bat` / `uninstall-service.bat` | Windows 服务注册/卸载（NSSM + server EXE） | — |
| `一键安装.bat` | Windows 一键部署（服务端 + nginx + 证书 + 防火墙） | — |
| `make-cert.ps1` | Windows 自签证书生成 | — |
| `nginx.conf` | Windows 版 nginx 站点配置（80/443 反代 + `/downloads/`） | — |
| `nginx/`、`nssm.exe` | Windows 版 nginx 发行版与 NSSM 工具 | — |
| `cert/server.crt` `.key` | 自签证书（SAN 含 192.168.40.247，10 年期） | `server/deploy/cert/`（副本） |
| `deploy-remote.js` | 从开发机一键远程部署（node-ssh） | — |
| `downloads/` | **客户端/App 在线更新文件模板**（JSON，二进制不进 git） | `/opt/asset-server/downloads/` |
| `sync-from-prod.ps1` | **生产→仓库同步审计（每次改动收尾必跑）**：拉回更新 JSON 归档 `releases/`、全量哈希比对、漂移回灌命令；规范见 [docs/发布同步规范.md](../../docs/发布同步规范.md) | — |
| `istoreos/docker-compose.yml` | iStoreOS Docker 编排 | — |

## 生产布局速查（/opt/asset-server/）

```
/opt/asset-server/
├── index.html / login.html / styles.css / asset_label_print.html /
│   final_chart_fix.js / build-info.json     # 静态前端（服务端 STATIC_ROOT = server/..）
├── js/  libs/                               # 前端脚本与第三方库
├── server/                                  # 服务端源码（systemd 工作目录, node src/index.js）
│   ├── src/  backup.js  reset-admin.js
│   └── node_modules/ data/ deploy/
└── downloads/                               # EXE/App 自更新文件（nginx /downloads/ 别名）
```

- 服务端监听 `127.0.0.1:3456`（ASSET_HOST/ASSET_PORT），nginx 80/443 对外反代
- 系统账号 `asset`，数据目录 `server/data`（`ASSET_DATA_DIR` 未设时默认工作目录下 data）
- 静态前端必须放在 `server/` 的**上级目录**（index.js 取 `STATIC_ROOT = server/..`）

## 三平台快速开始

| 平台 | 步骤 | 详细文档 |
|---|---|---|
| **Ubuntu 22.04**（生产同款） | ① 项目根整体拷贝到部署机（保持 `server/` 与前端静态文件同级，剔除 `server/node_modules`）② `sudo bash server/deploy/install-ubuntu-source.sh` ③ 完成后自动探活；逐项手动步骤见部署文档 11.4 | [docs/CS架构部署文档.md](../../docs/CS架构部署文档.md) 第 11 章 |
| **Windows** | ① 复制 `server/dist/asset-server.exe` + 静态前端到部署目录 ② 管理员运行 `一键安装.bat`（或分步：`install-service.bat` → `make-cert.ps1` → nginx） | 同上 第 3~6 章 |
| **iStoreOS** | ① 持久盘建目录、上传 `server/` 源码（剔除 node_modules）② 容器内 `npm install --omit=dev` ③ `docker compose -f istoreos/docker-compose.yml up -d`（无 compose 插件则按文档用 `docker run`） | [docs/iStoreOS部署说明.md](../../docs/iStoreOS部署说明.md) |

## 客户端/App 在线更新（发版时才需要）

新服务器**无需**预置更新 JSON（会导致已装客户端误报更新）。首次发版时按手册生成真实文件上传到 `/opt/asset-server/downloads/`：

- EXE 客户端：[docs/EXE客户端发布更新流程.md](../../docs/EXE客户端发布更新流程.md)
- 手机 App：[docs/手机App发布更新流程.md](../../docs/手机App发布更新流程.md)
- 字段模板见本目录 [downloads/](downloads/README.md)
