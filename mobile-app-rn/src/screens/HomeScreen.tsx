import React, { useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useAssets } from '../hooks/useAssets';
import { useAuthStore } from '../store/authStore';
import StatCard from '../components/StatCard';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';
import { formatCurrency, formatRelativeTime } from '../utils/format';

export default function HomeScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const { data, isLoading, refetch, isRefetching } = useAssets();

  const stats = useMemo(() => {
    const list = data || [];
    const total = list.length;
    const active = list.filter((a) => a.status === 'active').length;
    const damaged = list.filter((a) => a.status === 'repair' || a.status === 'lost').length;
    const totalValue = list.reduce((s, a) => s + (a.value || 0), 0);
    const intactRate = total ? Math.round((active / total) * 100) : 0;
    return { total, damaged, totalValue, intactRate, recent: list.slice(0, 5) };
  }, [data]);

  if (isLoading) return <LoadingSpinner />;

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>固定资产管理</Text>
        <Text style={[styles.userText, { color: theme.textSecondary }]}>
          {user?.displayName || user?.username || '用户'}
        </Text>
      </View>

      <FlatList
        data={stats.recent}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <View>
            <View style={styles.statsRow}>
              <StatCard label="总资产" value={stats.total} icon="laptop" color={theme.primary} />
              <StatCard label="损坏/遗失" value={stats.damaged} icon="alert" color={theme.danger} />
            </View>
            <View style={styles.statsRow}>
              <StatCard label="总价值" value={formatCurrency(stats.totalValue)} icon="cash" color={theme.success} />
              <StatCard label="完好率" value={`${stats.intactRate}%`} icon="check-decagram" color={theme.warning} />
            </View>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>最近变更</Text>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="database" text="暂无资产数据" />}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.recentItem, { backgroundColor: theme.surface, borderColor: theme.border }]}
            onPress={() => navigation.navigate('AssetDetail', { id: item.id })}
          >
            <View style={styles.recentMain}>
              <Text style={[styles.recentId, { color: theme.primary }]}>{item.id}</Text>
              <Text style={[styles.recentModel, { color: theme.text }]} numberOfLines={1}>{item.brandModel}</Text>
            </View>
            <Text style={[styles.recentTime, { color: theme.textMuted }]}>{formatRelativeTime(item.updateTime || item.purchaseDate)}</Text>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} colors={[theme.primary]} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { fontSize: fontSize.xl, fontWeight: '700' },
  userText: { fontSize: fontSize.sm },
  statsRow: { flexDirection: 'row', paddingHorizontal: spacing.sm },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '700', marginHorizontal: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.md },
  listContent: { paddingBottom: spacing.xxl },
  recentItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: spacing.lg, padding: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  recentMain: { flex: 1 },
  recentId: { fontSize: fontSize.md, fontWeight: '600' },
  recentModel: { fontSize: fontSize.sm, marginTop: 2 },
  recentTime: { fontSize: fontSize.xs },
});
