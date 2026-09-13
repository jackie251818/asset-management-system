/**
 * 应用内自更新 —— 原生模块（ApkUpdateModule.kt）JS 桥接层
 *
 * 与电脑端 EXE 自更新对应：版本源为服务器静态文件
 *   <serverUrl>/downloads/apk-update.json
 * 字段：{ versionCode:number, versionName:string, url:string, notes?:string, sha256?:string, publishedAt?:string }
 *
 * 判定口径：以 versionCode（整数）比较为准，versionName 仅用于展示；与原生 build.gradle 保持一致。
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { useSettingsStore } from '../store/settingsStore';

export interface UpdateInfo {
  versionCode: number;
  versionName: string;
  /** 绝对 http(s) URL，或 /downloads/ 下的相对文件名 */
  url: string;
  notes?: string;
  sha256?: string;
  publishedAt?: string;
}

export interface CurrentVersion {
  versionName: string;
  versionCode: number;
}

export interface DownloadResult {
  path: string;
  sha256: string;
}

export type ProgressListener = (received: number, total: number, percent: number) => void;

// iOS 不存在该模块；非 Android 平台 supported=false，调用方静默跳过
const ApkUpdate: any = Platform.OS === 'android' ? NativeModules.ApkUpdate : null;
export const apkUpdateSupported = Platform.OS === 'android' && !!ApkUpdate;

function serverOrigin(): string {
  return (useSettingsStore.getState().serverUrl || 'http://192.168.40.247').replace(/\/+$/, '');
}

export function getCurrentVersion(): Promise<CurrentVersion> {
  return ApkUpdate.getVersion();
}

/** 拉取版本描述 JSON；调用方负责超时控制与异常吞掉（静默检查场景） */
export async function fetchUpdateInfo(signal?: AbortSignal): Promise<UpdateInfo | null> {
  const resp = await fetch(`${serverOrigin()}/downloads/apk-update.json?ts=${Date.now()}`, {
    method: 'GET',
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  if (!j || typeof j.versionCode !== 'number' || typeof j.url !== 'string' || !j.url) {
    return null;
  }
  return j as UpdateInfo;
}

export function resolveDownloadUrl(info: UpdateInfo): string {
  if (/^https?:\/\//i.test(info.url)) return info.url;
  return `${serverOrigin()}/downloads/${info.url.replace(/^\/+/, '')}`;
}

/** 唯一判定依据：versionCode 整数大小 */
export function hasUpdate(currentCode: number, info: UpdateInfo): boolean {
  return info.versionCode > currentCode;
}

/** 订阅下载进度，返回取消订阅函数。percent=-1 表示服务器未返回 Content-Length（不确定进度） */
export function subscribeDownloadProgress(listener: ProgressListener): () => void {
  const emitter = new NativeEventEmitter(ApkUpdate);
  const sub = emitter.addListener('ApkUpdateProgress', (e: any) => {
    listener(
      typeof e?.received === 'number' ? e.received : 0,
      typeof e?.total === 'number' ? e.total : -1,
      typeof e?.percent === 'number' ? e.percent : -1,
    );
  });
  return () => sub.remove();
}

export function downloadApk(info: UpdateInfo): Promise<DownloadResult> {
  return ApkUpdate.downloadApk(resolveDownloadUrl(info), info.sha256 || null);
}

export function canInstallPackages(): Promise<boolean> {
  return ApkUpdate.canInstallPackages();
}

export function openInstallPermissionSettings(): Promise<void> {
  return ApkUpdate.openInstallPermissionSettings();
}

/** 调起系统安装器；未授予"未知来源"时 reject code=E_NO_PERMISSION */
export function installApk(filePath: string): Promise<void> {
  return ApkUpdate.installApk(filePath);
}
