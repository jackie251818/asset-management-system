import React, { useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl, Modal, TextInput, Alert } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useInventorySessions, useSaveInventoryList } from '../hooks/useInventory';
import { useAssets } from '../hooks/useAssets';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';
import { InventorySession, InventoryDetail } from '../types/api';
import { inventoryApi } from '../api/inventory';
import { formatDateTime, formatPercent } from '../utils/format';

export default function InventoryListScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const { data: sessions, isLoading, refetch, isRefetching } = useInventorySessions();
  const { data: assets } = useAssets();
  const saveList = useSaveInventoryList();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'all' | 'department' | 'location'>('all');

  const handleCreate = async () => {
    if (!name) {
      Alert.alert('提示', '请输入盘点名称');
      return;
    }
    const list = sessions || [];
    const id = 'inv_' + Date.now();
    const now = new Date().toISOString();
    let scopeAssets = assets || [];
    if (scope === 'department') {
      // 简化：全量
    }
    const items = scopeAssets.map((a) => ({
      assetId: a.id,
      snapshot: { id: a.id, brandModel: a.brandModel, user: a.user, department: a.department, location: a.location, status: a.status },
      status: 'pending' as const,
      countedBy: '',
      countedAt: '',
      exceptionNote: '',
    }));
    const detail: InventoryDetail = {
      id,
      name,
      creator: '',
      createdAt: now,
      updatedAt: now,
      status: 'in_progress',
      scope: { mode: scope },
      totalAssets: items.length,
      countedAssets: 0,
      exceptionCount: 0,
      version: 1,
      items,
    };
    try {
      await inventoryApi.saveSession(id, detail);
      const newSession: InventorySession = {
        id, name, creator: '', createdAt: now, updatedAt: now,
        status: 'in_progress', scope: { mode: scope },
        totalAssets: items.length, countedAssets: 0, exceptionCount: 0, version: 1,
      };
      await saveList.mutateAsync([newSession, ...list]);
      setShowCreate(false);
      setName('');
      Alert.alert('成功', '盘点批次已创建', [{ text: '查看', onPress: () => navigation.navigate('InventoryDetail', { id }) }]);
    } catch (e: any) {
      Alert.alert('创建失败', e.message || '请重试');
    }
  };

  if (isLoading) return <LoadingSpinner />;

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>资产盘点</Text>
        <TouchableOpacity style={[styles.addBtn, { backgroundColor: theme.primary }]} onPress={() => setShowCreate(true)}>
          <Icon name="plus" size={18} color="#fff" />
          <Text style={styles.addText}>发起盘点</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const pct = item.totalAssets ? Math.round((item.countedAssets / item.totalAssets) * 100) : 0;
          const done = item.status === 'completed';
          return (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => navigation.navigate('InventoryDetail', { id: item.id })}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.cardName, { color: theme.text }]} numberOfLines={1}>{item.name}</Text>
                <View style={[styles.statusBadge, { backgroundColor: done ? theme.success + '1a' : theme.primary + '1a' }]}>
                  <Text style={{ color: done ? theme.success : theme.primary, fontSize: fontSize.xs }}>{done ? '已完成' : '进行中'}</Text>
                </View>
              </View>
              <Text style={[styles.cardMeta, { color: theme.textSecondary }]}>{item.creator || 'admin'} · {formatDateTime(item.createdAt)}</Text>
              <Text style={[styles.cardProgress, { color: theme.textSecondary }]}>已盘 {item.countedAssets}/{item.totalAssets} · {pct}%</Text>
              <View style={[styles.progressBar, { backgroundColor: theme.surfaceAlt }]}>
                <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: done ? theme.success : theme.primary }]} />
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<EmptyState icon="clipboard-check-outline" text="暂无盘点批次，点击右上角发起盘点" />}
        contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} colors={[theme.primary]} />}
      />

      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <TouchableOpacity style={styles.modalMask} activeOpacity={1} onPress={() => setShowCreate(false)}>
          <View style={[styles.modal, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>发起盘点</Text>
            <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>批次名称</Text>
            <TextInput
              style={[styles.input, { color: theme.text, backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}
              value={name}
              onChangeText={setName}
              placeholder="如 2026年9月例行盘点"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={[styles.fieldLabel, { color: theme.textSecondary, marginTop: spacing.md }]}>盘点范围</Text>
            <View style={styles.scopeRow}>
              {(['all', 'department', 'location'] as const).map((s) => (
                <TouchableOpacity
                  key={s}
                  style={[styles.scopeChip, scope === s ? { backgroundColor: theme.primary } : { borderColor: theme.border, borderWidth: 1 }]}
                  onPress={() => setScope(s)}
                >
                  <Text style={{ color: scope === s ? '#fff' : theme.text }}>
                    {s === 'all' ? '全部' : s === 'department' ? '按部门' : '按地点'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.btnRow}>
              <TouchableOpacity style={[styles.cancelBtn, { borderColor: theme.border }]} onPress={() => setShowCreate(false)}>
                <Text style={{ color: theme.text }}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.createBtn, { backgroundColor: theme.primary }]} onPress={handleCreate}>
                <Text style={{ color: '#fff' }}>创建</Text>
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
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: fontSize.xl, fontWeight: '700' },
  addBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md },
  addText: { color: '#fff', marginLeft: 4, fontSize: fontSize.sm, fontWeight: '600' },
  card: { marginBottom: spacing.md, padding: spacing.lg, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardName: { fontSize: fontSize.md, fontWeight: '600', flex: 1 },
  statusBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill },
  cardMeta: { fontSize: fontSize.xs, marginTop: spacing.xs },
  cardProgress: { fontSize: fontSize.sm, marginTop: spacing.sm },
  progressBar: { height: 6, borderRadius: 3, marginTop: spacing.xs, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.lg },
  fieldLabel: { fontSize: fontSize.sm, marginBottom: spacing.xs },
  input: { height: 44, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, fontSize: fontSize.md },
  scopeRow: { flexDirection: 'row', gap: spacing.sm },
  scopeChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm },
  btnRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  cancelBtn: { flex: 1, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  createBtn: { flex: 1, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
