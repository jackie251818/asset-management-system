import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Vibration, Modal, ScrollView } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { Camera } from 'react-native-vision-camera';
import { useScanner } from '../hooks/useScanner';
import { InventoryItem } from '../types/api';

// 扫码查询结果（由盘点明细页通过导航参数提供的 onLookup 同步返回）
export type ScanLookupResult =
  | { kind: 'invalid' }
  | { kind: 'outOfScope'; assetId: string }
  | { kind: 'found'; item: InventoryItem };

export default function ScanScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const onLookup = route.params?.onLookup as ((code: string) => ScanLookupResult) | undefined;
  const onConfirm = route.params?.onConfirm as ((assetId: string) => void) | undefined;

  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState<ScanLookupResult | null>(null);
  const [confirmedCount, setConfirmedCount] = useState(0);

  const handleScan = useCallback(
    (code: string) => {
      Vibration.vibrate(50);
      // 查到结果后立即暂停扫码，弹窗等待人工确认
      const lookup = onLookup ? onLookup(code) : { kind: 'invalid' as const };
      setResult(lookup);
      setPaused(true);
    },
    [onLookup],
  );

  const { hasPermission, device, codeScanner, isScanning, setIsScanning } = useScanner(handleScan);

  const resumeScan = () => {
    setResult(null);
    setPaused(false);
  };

  const handleConfirm = () => {
    if (result?.kind === 'found') {
      Vibration.vibrate([0, 60, 60, 60]);
      onConfirm?.(result.item.assetId);
      setConfirmedCount((c) => c + 1);
    }
    resumeScan();
  };

  if (!hasPermission) {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        <Text style={{ color: '#fff', textAlign: 'center', padding: spacing.lg }}>需要相机权限才能扫码</Text>
        <TouchableOpacity style={[styles.closeBtn, { backgroundColor: theme.primary }]} onPress={() => navigation.goBack()}>
          <Text style={{ color: '#fff' }}>返回</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        <Text style={{ color: '#fff', textAlign: 'center' }}>未找到后置摄像头</Text>
      </View>
    );
  }

  const foundItem = result?.kind === 'found' ? result.item : null;
  const alreadyCounted = foundItem?.status === 'counted';

  return (
    <View style={styles.container}>
      {/* 弹窗期间暂停相机，停止识别与释放预览 */}
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!paused && isScanning}
        codeScanner={codeScanner}
      />
      <TouchableOpacity style={styles.closeBtn} onPress={() => navigation.goBack()}>
        <Icon name="close" size={24} color="#fff" />
      </TouchableOpacity>

      <View style={styles.scanFrame}>
        <View style={[styles.corner, styles.tl]} />
        <View style={[styles.corner, styles.tr]} />
        <View style={[styles.corner, styles.bl]} />
        <View style={[styles.corner, styles.br]} />
      </View>

      <Text style={styles.hint}>{paused ? '已暂停' : '将二维码对准框内'}</Text>

      <View style={styles.bottomArea}>
        <Text style={styles.countText}>本次已盘 {confirmedCount} 条</Text>
        <TouchableOpacity
          style={[styles.stopBtn, { backgroundColor: isScanning ? theme.danger : theme.success }]}
          onPress={() => setIsScanning(!isScanning)}
        >
          <Icon name={isScanning ? 'pause' : 'play'} size={20} color="#fff" />
          <Text style={{ color: '#fff', marginLeft: 6 }}>{isScanning ? '暂停扫码' : '继续扫码'}</Text>
        </TouchableOpacity>
      </View>

      {/* 扫码结果：资产信息确认弹窗 */}
      <Modal visible={paused} transparent animationType="slide" onRequestClose={resumeScan}>
        <TouchableOpacity style={styles.sheetMask} activeOpacity={1} onPress={resumeScan}>
          <View style={[styles.sheet, { backgroundColor: theme.surface }]} onStartShouldSetResponder={() => true}>
            {result?.kind === 'invalid' && (
              <>
                <View style={[styles.iconBadge, { backgroundColor: theme.warning + '22' }]}>
                  <Icon name="help-circle-outline" size={32} color={theme.warning} />
                </View>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>未识别到资产编号</Text>
                <Text style={[styles.sheetDesc, { color: theme.textSecondary }]}>请扫描资产标签上的二维码</Text>
              </>
            )}

            {result?.kind === 'outOfScope' && (
              <>
                <View style={[styles.iconBadge, { backgroundColor: theme.danger + '22' }]}>
                  <Icon name="alert-circle-outline" size={32} color={theme.danger} />
                </View>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>不在本次盘点范围</Text>
                <Text style={[styles.sheetDesc, { color: theme.textSecondary }]}>资产编号：{result.assetId}</Text>
              </>
            )}

            {foundItem && (
              <ScrollView>
                <View style={[styles.iconBadge, { backgroundColor: alreadyCounted ? theme.textMuted + '22' : theme.success + '22' }]}>
                  <Icon
                    name={alreadyCounted ? 'check-circle-outline' : 'cube-scan'}
                    size={32}
                    color={alreadyCounted ? theme.textMuted : theme.success}
                  />
                </View>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>{foundItem.assetId}</Text>
                {alreadyCounted && (
                  <View style={[styles.countedTag, { backgroundColor: theme.success + '22' }]}>
                    <Text style={{ color: theme.success, fontSize: fontSize.xs, fontWeight: '600' }}>该资产已盘点</Text>
                  </View>
                )}

                <View style={[styles.infoCard, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
                  <InfoRow label="型号" value={foundItem.snapshot.brandModel} />
                  <InfoRow label="类别" value={foundItem.snapshot.type} />
                  <InfoRow label="使用人" value={foundItem.snapshot.user} />
                  <InfoRow label="部门" value={foundItem.snapshot.department} />
                  <InfoRow label="存放地点" value={foundItem.snapshot.location} />
                  {foundItem.snapshot.remark ? <InfoRow label="备注" value={foundItem.snapshot.remark} /> : null}
                </View>
              </ScrollView>
            )}

            <View style={styles.sheetBtns}>
              <TouchableOpacity style={[styles.resumeBtn, { borderColor: theme.border }]} onPress={resumeScan}>
                <Text style={{ color: theme.text, fontSize: fontSize.md }}>继续扫码</Text>
              </TouchableOpacity>
              {foundItem && !alreadyCounted && (
                <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: theme.success }]} onPress={handleConfirm}>
                  <Icon name="check" size={18} color="#fff" />
                  <Text style={styles.confirmText}>确认盘点</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value?: string }) {
  const { theme } = useTheme();
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={2}>{value || '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  closeBtn: { position: 'absolute', top: 50, right: spacing.lg, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  scanFrame: { position: 'absolute', top: '26%', left: '15%', width: '70%', aspectRatio: 1 },
  corner: { position: 'absolute', width: 30, height: 30, borderColor: '#06b6d4' },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 8 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 8 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 8 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 8 },
  hint: { position: 'absolute', top: '60%', alignSelf: 'center', color: '#fff', fontSize: fontSize.md, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.sm },
  bottomArea: { position: 'absolute', bottom: spacing.xxxl, left: 0, right: 0, alignItems: 'center' },
  countText: { color: '#fff', fontSize: fontSize.md, marginBottom: spacing.md },
  stopBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.pill },

  sheetMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.xl, paddingBottom: spacing.xxxl, maxHeight: '72%' },
  iconBadge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: spacing.md },
  sheetTitle: { fontSize: fontSize.xl, fontWeight: '700', textAlign: 'center' },
  sheetDesc: { fontSize: fontSize.sm, textAlign: 'center', marginTop: spacing.xs },
  countedTag: { alignSelf: 'center', marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.pill },
  infoCard: { marginTop: spacing.lg, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md },
  infoRow: { flexDirection: 'row', paddingVertical: 6 },
  infoLabel: { width: 72, fontSize: fontSize.sm },
  infoValue: { flex: 1, fontSize: fontSize.sm },
  sheetBtns: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  resumeBtn: { flex: 1, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  confirmBtn: { flex: 1.4, height: 48, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  confirmText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '700' },
});
