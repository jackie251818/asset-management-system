/**
 * 自更新弹窗：发现新版本 → 下载（进度条 + SHA256 校验）→ 申请未知来源授权 → 调起系统安装器
 * 由 useUpdateStore 驱动，挂在 App 根部，全局可见。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  AppState,
  AppStateStatus,
  ActivityIndicator,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useUpdateStore } from '../store/updateStore';
import {
  subscribeDownloadProgress,
  downloadApk,
  canInstallPackages,
  openInstallPermissionSettings,
  installApk,
} from '../utils/apkUpdate';

type Phase = 'prompt' | 'downloading' | 'error';

function fmtMB(bytes: number): string {
  if (bytes < 0) return '--';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export default function UpdateModal() {
  const { theme } = useTheme();
  const visible = useUpdateStore((s) => s.visible);
  const info = useUpdateStore((s) => s.info);
  const closeModal = useUpdateStore((s) => s.closeModal);

  const [phase, setPhase] = useState<Phase>('prompt');
  const [percent, setPercent] = useState(0);
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(-1);
  const [errorMsg, setErrorMsg] = useState('');
  const [pendingPermissionPath, setPendingPermissionPath] = useState<string | null>(null);
  const appStateRef = useRef(AppState.currentState);

  // 每次弹窗打开重置为询问态
  useEffect(() => {
    if (visible) {
      setPhase('prompt');
      setPercent(0);
      setReceived(0);
      setTotal(-1);
      setErrorMsg('');
      setPendingPermissionPath(null);
    }
  }, [visible]);

  // 从系统"未知来源"授权页返回 App 时自动继续安装
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (
        appStateRef.current.match(/inactive|background/) &&
        next === 'active' &&
        pendingPermissionPath
      ) {
        const path = pendingPermissionPath;
        setPendingPermissionPath(null);
        canInstallPackages()
          .then((ok) => {
            if (ok) {
              installApk(path)
                .then(() => closeModal())
                .catch((e) => setErrorMsg(e?.message || '调起安装器失败'));
            }
          })
          .catch(() => {});
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, [pendingPermissionPath, closeModal]);

  if (!info) return null;

  const startInstall = async (path: string) => {
    const ok = await canInstallPackages();
    if (!ok) {
      setPendingPermissionPath(path);
      await openInstallPermissionSettings();
      return;
    }
    await installApk(path);
    // 系统安装器已接管，关闭弹窗（安装完成后用户点"打开"即进入新版）
    closeModal();
  };

  const handleDownload = async () => {
    setPhase('downloading');
    setPercent(0);
    setReceived(0);
    setTotal(-1);
    setErrorMsg('');
    const unsubscribe = subscribeDownloadProgress((r, t, p) => {
      setReceived(r);
      setTotal(t);
      setPercent(p);
    });
    try {
      const res = await downloadApk(info!);
      unsubscribe();
      await startInstall(res.path);
    } catch (e: any) {
      unsubscribe();
      setErrorMsg(e?.message || '下载失败，请稍后重试');
      setPhase('error');
    }
  };

  const progressText =
    percent >= 0 ? `${percent}%` : total > 0 ? `${fmtMB(received)} / ${fmtMB(total)}` : `${fmtMB(received)}`;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.header}>
            <View style={[styles.iconBadge, { backgroundColor: theme.primaryLight }]}>
              <Icon name="cellphone-arrow-down" size={26} color={theme.primary} />
            </View>
            <Text style={[styles.title, { color: theme.text }]}>发现新版本</Text>
            <Text style={[styles.version, { color: theme.textSecondary }]}>
              v{info.versionName}（版本号 {info.versionCode}）
            </Text>
          </View>

          {phase === 'prompt' && (
            <>
              <ScrollableNotes notes={info.notes} textColor={theme.text} secondaryColor={theme.textSecondary} />
              {!!info.publishedAt && (
                <Text style={[styles.published, { color: theme.textMuted }]}>
                  发布时间：{String(info.publishedAt).replace('T', ' ').slice(0, 16)}
                </Text>
              )}
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnGhost, { borderColor: theme.border }]}
                  onPress={closeModal}
                >
                  <Text style={{ color: theme.textSecondary }}>以后再说</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { backgroundColor: theme.primary }]}
                  onPress={handleDownload}
                >
                  <Icon name="download" size={18} color="#fff" />
                  <Text style={styles.btnPrimaryText}>立即更新</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {phase === 'downloading' && (
            <View style={styles.downloadBox}>
              <Text style={[styles.downloadHint, { color: theme.textSecondary }]}>
                正在下载更新包，下载完成后将自动调起安装，请勿关闭应用…
              </Text>
              <View style={[styles.progressTrack, { backgroundColor: theme.surfaceAlt }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.max(2, Math.min(100, percent >= 0 ? percent : 5))}%`,
                      backgroundColor: theme.primary,
                    },
                  ]}
                />
              </View>
              <View style={styles.progressMeta}>
                <Text style={{ color: theme.text, fontWeight: '700' }}>{progressText}</Text>
                {percent < 0 && <ActivityIndicator size="small" color={theme.primary} />}
              </View>
              {percent >= 0 && total > 0 && (
                <Text style={[styles.bytesText, { color: theme.textMuted }]}>
                  {fmtMB(received)} / {fmtMB(total)}
                </Text>
              )}
            </View>
          )}

          {phase === 'error' && (
            <View style={styles.errorBox}>
              <View style={[styles.errorIcon, { backgroundColor: theme.danger + '22' }]}>
                <Icon name="alert-circle-outline" size={26} color={theme.danger} />
              </View>
              <Text style={[styles.errorText, { color: theme.danger }]}>{errorMsg}</Text>
              <Text style={[styles.errorHint, { color: theme.textMuted }]}>
                更新失败不影响当前版本使用，可稍后到"我的 → 检查更新"重试。
              </Text>
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnGhost, { borderColor: theme.border }]}
                  onPress={closeModal}
                >
                  <Text style={{ color: theme.textSecondary }}>关闭</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { backgroundColor: theme.primary }]}
                  onPress={handleDownload}
                >
                  <Text style={styles.btnPrimaryText}>重试</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ScrollableNotes({
  notes,
  textColor,
  secondaryColor,
}: {
  notes?: string;
  textColor: string;
  secondaryColor: string;
}) {
  if (!notes) {
    return (
      <Text style={[styles.notes, { color: secondaryColor }]}>新版本包含功能改进与问题修复，建议立即更新。</Text>
    );
  }
  return (
    <View style={styles.notesBox}>
      {String(notes)
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line, i) => (
          <View key={i} style={styles.noteLine}>
            <Text style={[styles.noteDot, { color: secondaryColor }]}>{i === 0 ? '•' : '◦'}</Text>
            <Text style={[styles.notes, { color: textColor, flex: 1 }]}>{line.replace(/^[-•*]\s*/, '')}</Text>
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
  },
  header: { alignItems: 'center', marginBottom: spacing.md },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700' },
  version: { fontSize: fontSize.sm, marginTop: 2 },
  notesBox: { marginTop: spacing.xs, marginBottom: spacing.sm },
  noteLine: { flexDirection: 'row', gap: spacing.sm, marginBottom: 4 },
  noteDot: { fontSize: fontSize.md, lineHeight: 22 },
  notes: { fontSize: fontSize.md, lineHeight: 22 },
  published: { fontSize: fontSize.xs, marginBottom: spacing.sm },
  btnRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  btn: {
    flex: 1,
    height: 44,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  btnGhost: { borderWidth: 1 },
  btnPrimary: {},
  btnPrimaryText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
  downloadBox: { paddingVertical: spacing.sm },
  downloadHint: { fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.md, textAlign: 'center' },
  progressTrack: { height: 10, borderRadius: 5, overflow: 'hidden' },
  progressFill: { height: 10, borderRadius: 5 },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  bytesText: { fontSize: fontSize.xs, textAlign: 'center', marginTop: 2 },
  errorBox: { alignItems: 'center', paddingVertical: spacing.sm },
  errorIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  errorText: { fontSize: fontSize.md, fontWeight: '600', textAlign: 'center' },
  errorHint: { fontSize: fontSize.sm, textAlign: 'center', marginTop: spacing.sm, lineHeight: 19 },
});
