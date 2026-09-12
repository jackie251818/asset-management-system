import React, { useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl, Alert, TextInput, Modal } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useInventorySession, useSaveInventorySession } from '../hooks/useInventory';
import { parseAssetQR } from '../utils/qrParser';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';
import { InventoryItem } from '../types/api';
import { formatPercent } from '../utils/format';
import type { ScanLookupResult } from './ScanScreen';

export default function InventoryDetailScreen() {
  const { theme } = useTheme();
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { id } = route.params;
  const { data: detail, isLoading, refetch, isRefetching } = useInventorySession(id);
  const saveSession = useSaveInventorySession();

  const [filter, setFilter] = useState<'all' | 'pending' | 'counted' | 'exception'>('all');
  const [keyword, setKeyword] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [manualId, setManualId] = useState('');

  const items = detail?.items || [];
  const stats = useMemo(() => {
    const counted = items.filter((i) => i.status === 'counted').length;
    const pending = items.filter((i) => i.status === 'pending').length;
    const exception = items.filter((i) => i.status === 'exception').length;
    return { total: items.length, counted, pending, exception };
  }, [items]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter !== 'all') list = list.filter((i) => i.status === filter);
    if (keyword) {
      const kw = keyword.toLowerCase();
      list = list.filter((i) =>
        i.assetId.toLowerCase().includes(kw) ||
        (i.snapshot.brandModel || '').toLowerCase().includes(kw),
      );
    }
    return list;
  }, [items, filter, keyword]);

  const updateItem = async (assetId: string, patch: Partial<InventoryItem>) => {
    if (!detail) return;
    const newItems = detail.items.map((i) => (i.assetId === assetId ? { ...i, ...patch } : i));
    const counted = newItems.filter((i) => i.status === 'counted').length;
    const exception = newItems.filter((i) => i.status === 'exception').length;
    const newDetail = { ...detail, items: newItems, countedAssets: counted, exceptionCount: exception, updatedAt: new Date().toISOString(), version: detail.version + 1 };
    await saveSession.mutateAsync({ id, detail: newDetail });
  };

  // 扫码页扫到二维码后回调：只做查询，不直接改状态（弹窗由用户确认）
  const lookupScanned = (code: string): ScanLookupResult => {
    const assetId = parseAssetQR(code);
    if (!assetId) return { kind: 'invalid' };
    const item = items.find((i) => i.assetId === assetId);
    if (!item) return { kind: 'outOfScope', assetId };
    return { kind: 'found', item };
  };

  // 用户在扫码弹窗点「确认盘点」后回调
  const confirmCounted = (assetId: string) => {
    updateItem(assetId, { status: 'counted', countedBy: '', countedAt: new Date().toISOString() });
  };

  const handleManual = () => {
    if (!manualId) return;
    const assetId = parseAssetQR(manualId) || manualId.trim();
    const item = items.find((i) => i.assetId === assetId);
    if (!item) {
      Alert.alert('提示', `资产 ${assetId} 不在本次盘点范围内`);
      return;
    }
    if (item.status === 'counted') {
      Alert.alert('提示', `${assetId} 已盘点`);
      return;
    }
    updateItem(assetId, { status: 'counted', countedBy: '', countedAt: new Date().toISOString() });
    setManualId('');
    setShowManual(false);
  };

  const handleComplete = () => {
    if (!detail) return;
    const pending = stats.pending;
    if (pending > 0) {
      Alert.alert('确认完成', `还有 ${pending} 项未盘点，确认完成本次盘点？未盘点项将标记为异常`, [
        { text: '取消' },
        {
          text: '确认完成',
          onPress: async () => {
            const newItems = detail.items.map((i) =>
              i.status === 'pending' ? { ...i, status: 'exception' as const, exceptionNote: '盘点时未找到' } : i,
            );
            const counted = newItems.filter((i) => i.status === 'counted').length;
            const exception = newItems.filter((i) => i.status === 'exception').length;
            const newDetail = { ...detail, items: newItems, countedAssets: counted, exceptionCount: exception, status: 'completed' as const, updatedAt: new Date().toISOString(), version: detail.version + 1 };
            await saveSession.mutateAsync({ id, detail: newDetail });
            navigation.goBack();
          },
        },
      ]);
    } else {
      Alert.alert('确认完成', '确认完成本次盘点？', [
        { text: '取消' },
        { text: '确认', onPress: async () => {
          const newDetail = { ...detail, status: 'completed' as const, updatedAt: new Date().toISOString(), version: detail.version + 1 };
          await saveSession.mutateAsync({ id, detail: newDetail });
          navigation.goBack();
        }},
      ]);
    }
  };

  if (isLoading || !detail) return <LoadingSpinner />;

  const pct = stats.total ? Math.round((stats.counted / stats.total) * 100) : 0;

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.statsBar, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={styles.statItem}>
          <Text style={[styles.statNum, { color: theme.text }]}>{stats.total}</Text>
          <Text style={[styles.statLabel, { color: theme.textSecondary }]}>应盘</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNum, { color: theme.success }]}>{stats.counted}</Text>
          <Text style={[styles.statLabel, { color: theme.textSecondary }]}>已盘</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNum, { color: theme.warning }]}>{stats.pending}</Text>
          <Text style={[styles.statLabel, { color: theme.textSecondary }]}>未盘</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNum, { color: theme.danger }]}>{stats.exception}</Text>
          <Text style={[styles.statLabel, { color: theme.textSecondary }]}>异常</Text>
        </View>
      </View>

      <View style={[styles.progressWrap, { backgroundColor: theme.surface }]}>
        <View style={[styles.progressBar, { backgroundColor: theme.surfaceAlt }]}>
          <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: theme.primary }]} />
        </View>
        <Text style={{ color: theme.textSecondary, fontSize: fontSize.xs }}>{formatPercent(stats.counted, stats.total)}</Text>
      </View>

      <View style={[styles.searchRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={[styles.searchInput, { backgroundColor: theme.surfaceAlt }]}>
          <Icon name="magnify" size={16} color={theme.textMuted} />
          <TextInput
            style={[styles.searchText, { color: theme.text }]}
            placeholder="搜索资产编号/型号"
            placeholderTextColor={theme.textMuted}
            value={keyword}
            onChangeText={setKeyword}
          />
        </View>
      </View>

      <View style={[styles.filterRow, { borderBottomColor: theme.border }]}>
        {(['all', 'pending', 'counted', 'exception'] as const).map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, filter === f && { backgroundColor: theme.primary }]}
            onPress={() => setFilter(f)}
          >
            <Text style={{ color: filter === f ? '#fff' : theme.textSecondary, fontSize: fontSize.xs }}>
              {f === 'all' ? '全部' : f === 'pending' ? '未盘' : f === 'counted' ? '已盘' : '异常'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.assetId}
        renderItem={({ item }) => (
          <View style={[styles.row, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
            <View style={styles.rowMain}>
              <Text style={[styles.rowId, { color: theme.primary }]}>{item.assetId}</Text>
              <Text style={[styles.rowModel, { color: theme.text }]} numberOfLines={1}>{item.snapshot.brandModel}</Text>
              <Text style={[styles.rowMeta, { color: theme.textSecondary }]}>{item.snapshot.user} · {item.snapshot.department}</Text>
            </View>
            {item.status === 'counted' ? (
              <Icon name="check-circle" size={22} color={theme.success} />
            ) : item.status === 'exception' ? (
              <View>
                <Icon name="alert-circle" size={22} color={theme.danger} />
                {item.exceptionNote ? <Text style={{ color: theme.danger, fontSize: fontSize.xs, maxWidth: 80 }} numberOfLines={1}>{item.exceptionNote}</Text> : null}
              </View>
            ) : (
              <Icon name="clock-outline" size={22} color={theme.textMuted} />
            )}
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="clipboard-outline" text="没有符合条件的资产" />}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} colors={[theme.primary]} />}
      />

      <View style={[styles.bottomBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
        <TouchableOpacity style={[styles.actionBtn, { borderColor: theme.border, backgroundColor: theme.surface }]} onPress={() => navigation.navigate('Scan', { onLookup: lookupScanned, onConfirm: confirmCounted })}>
          <Icon name="qrcode-scan" size={18} color={theme.primary} />
          <Text style={{ color: theme.primary, fontSize: fontSize.sm }}>扫码盘点</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, { borderColor: theme.border, backgroundColor: theme.surface }]} onPress={() => setShowManual(true)}>
          <Icon name="keyboard" size={18} color={theme.textSecondary} />
          <Text style={{ color: theme.textSecondary, fontSize: fontSize.sm }}>手动录入</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.completeBtn, { backgroundColor: theme.success }]} onPress={handleComplete}>
          <Text style={{ color: '#fff', fontSize: fontSize.sm }}>完成</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={showManual} transparent animationType="fade" onRequestClose={() => setShowManual(false)}>
        <TouchableOpacity style={styles.modalMask} activeOpacity={1} onPress={() => setShowManual(false)}>
          <View style={[styles.manualBox, { backgroundColor: theme.surface }]}>
            <Text style={[styles.manualTitle, { color: theme.text }]}>手动录入资产编号</Text>
            <TextInput
              style={[styles.manualInput, { color: theme.text, backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}
              value={manualId}
              onChangeText={setManualId}
              placeholder="输入资产编号"
              placeholderTextColor={theme.textMuted}
              autoFocus
            />
            <View style={styles.btnRow}>
              <TouchableOpacity style={[styles.cancelBtn, { borderColor: theme.border }]} onPress={() => setShowManual(false)}>
                <Text style={{ color: theme.text }}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.okBtn, { backgroundColor: theme.primary }]} onPress={handleManual}>
                <Text style={{ color: '#fff' }}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  statsBar: { flexDirection: 'row', padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  statItem: { flex: 1, alignItems: 'center' },
  statNum: { fontSize: fontSize.xl, fontWeight: '700' },
  statLabel: { fontSize: fontSize.xs, marginTop: 2 },
  progressWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  progressBar: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
  searchRow: { padding: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  searchInput: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 38, borderRadius: radius.sm, gap: spacing.xs },
  searchText: { flex: 1, fontSize: fontSize.sm, padding: 0 },
  filterRow: { flexDirection: 'row', padding: spacing.sm, gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  filterChip: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  rowMain: { flex: 1 },
  rowId: { fontSize: fontSize.md, fontWeight: '600' },
  rowModel: { fontSize: fontSize.sm, marginTop: 2 },
  rowMeta: { fontSize: fontSize.xs, marginTop: 2 },
  bottomBar: { flexDirection: 'row', padding: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 42, borderRadius: radius.md, borderWidth: 1, gap: 4 },
  completeBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 42, borderRadius: radius.md },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  manualBox: { width: '100%', borderRadius: radius.lg, padding: spacing.lg },
  manualTitle: { fontSize: fontSize.lg, fontWeight: '600', marginBottom: spacing.md },
  manualInput: { height: 44, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, fontSize: fontSize.md },
  btnRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  cancelBtn: { flex: 1, height: 42, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  okBtn: { flex: 1, height: 42, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
