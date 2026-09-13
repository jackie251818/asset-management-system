/**
 * 连接设置窗口 preload —— 通过 contextBridge 向页面暴露最小 IPC 面
 * (窗口本身 contextIsolation: true + nodeIntegration: false + sandbox: false, 页面无任何 Node 能力)
 */
(function () {
    'use strict';
    try {
        const { contextBridge, ipcRenderer } = require('electron');
        if (!contextBridge || !ipcRenderer) {
            console.error('[conn-preload] contextBridge/ipcRenderer 缺失');
            return;
        }
        contextBridge.exposeInMainWorld('connApi', {
            /** 当前连接设置: { mode, serverUrl, appSettingExists, fileConfigExists } */
            get: () => ipcRenderer.invoke('conn:get'),
            /** 测试服务端连通性: { ok, message } */
            test: (url) => ipcRenderer.invoke('conn:test', url),
            /** 保存设置: { mode: 'client'|'standalone', serverUrl } → { ok, file } */
            save: (cfg) => ipcRenderer.invoke('conn:save', cfg),
            /** 清除应用内设置(恢复按 exe 旁 server.config.json / 默认单机) */
            clear: () => ipcRenderer.invoke('conn:clear'),
            /** 重启应用使设置生效 */
            apply: () => ipcRenderer.invoke('conn:apply'),
            /** 获取服务端信息(免鉴权 /api/info): { ok, info:{ name, version, dbPath, serverTime } | error } */
            serverInfo: (url) => ipcRenderer.invoke('conn:serverInfo', url),
            /** 服务端 → 本地: 拉取全部数据键写入本地 data/ 目录
             *  payload: { url, username, password }
             *  returns: { ok, pulled:{ key:count }, errors:[], totalAssets, serverInfo:{ name, version } } */
            syncPull: (payload) => ipcRenderer.invoke('conn:syncPull', payload),
            /** 本地 → 服务端: 读取本地 data/ 目录推送到服务端(全量替换,需登录)
             *  payload: { url, username, password }
             *  returns: { ok, pushed:{ key:count }, errors:[], totalAssets, serverInfo:{ name, version } } */
            syncPush: (payload) => ipcRenderer.invoke('conn:syncPush', payload),
            /** 打印资产登记卡: 主进程开 Electron 子窗口 → 系统原生打印对话框 → 关闭
             *  payload: { html: 完整 HTML 字符串(含内联 CSS) } */
            printCard: (html) => ipcRenderer.invoke('printCard', html),

            /** 检查应用更新(设置页入口)
             *  返回 { status:'dev'|'standalone'|'running'|'error'|'latest'|'available',
             *         current, version, notes, message } */
            checkUpdate: () => ipcRenderer.invoke('update:check'),

            /** 确认安装更新: 主进程重新校验后下载并自替换重启, 返回 { ok, message? } */
            applyUpdate: () => ipcRenderer.invoke('update:apply'),

            /** 监听更新下载进度 frac(0~1); 返回取消监听函数 */
            onUpdateProgress: (cb) => {
                const listener = (_e, frac) => { try { cb(frac); } catch (_) {} };
                ipcRenderer.on('update:progress', listener);
                return () => { try { ipcRenderer.removeListener('update:progress', listener); } catch (_) {} };
            },

            /** 监听更新失败事件 { message }; 返回取消监听函数 */
            onUpdateError: (cb) => {
                const listener = (_e, payload) => { try { cb(payload || {}); } catch (_) {} };
                ipcRenderer.on('update:error', listener);
                return () => { try { ipcRenderer.removeListener('update:error', listener); } catch (_) {} };
            }
        });
        console.log('[conn-preload] connApi 注入成功');
    } catch (e) {
        console.error('[conn-preload] 初始化失败:', e && e.stack || e);
    }
})();
