import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { Asset } from '../types/api';
import { formatCurrency } from '../utils/format';

interface Props {
  asset: Asset;
  onPress: () => void;
}

const statusMap: Record<string, { label: string; color: string; icon: string }> = {
  active: { label: '在用', color: '#52c41a', icon: 'check-circle' },
  repair: { label: '维修', color: '#faad14', icon: 'wrench' },
  scrap: { label: '报废', color: '#a0aec0', icon: 'delete' },
  lost: { label: '遗失', color: '#f5222d', icon: 'alert-octagon' },
};

export default function AssetCard({ asset, onPress }: Props) {
  const { theme } = useTheme();
  const st = statusMap[asset.status] || statusMap.active;

  return (
    <TouchableOpacity style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.header}>
        <Text style={[styles.id, { color: theme.primary }]}>{asset.id}</Text>
        <View style={[styles.badge, { backgroundColor: st.color + '1a' }]}>
          <Icon name={st.icon} size={12} color={st.color} />
          <Text style={[styles.badgeText, { color: st.color }]}>{st.label}</Text>
        </View>
      </View>
      <Text style={[styles.model, { color: theme.text }]} numberOfLines={1}>{asset.brandModel || '-'}</Text>
      <Text style={[styles.meta, { color: theme.textSecondary }]} numberOfLines={1}>
        {asset.user || '未分配'} · {asset.department || '-'} · {asset.location || '-'}
      </Text>
      <View style={styles.footer}>
        <Text style={[styles.value, { color: theme.textSecondary }]}>{formatCurrency(asset.value)}</Text>
        <Icon name="chevron-right" size={16} color={theme.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  id: { fontSize: fontSize.md, fontWeight: '700' },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill },
  badgeText: { fontSize: fontSize.xs, marginLeft: 3 },
  model: { fontSize: fontSize.md, marginBottom: spacing.xs },
  meta: { fontSize: fontSize.sm },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.sm },
  value: { fontSize: fontSize.sm, fontWeight: '600' },
});
