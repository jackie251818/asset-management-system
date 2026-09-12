import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useAsset } from '../hooks/useAsset';
import StatusBadge from '../components/StatusBadge';
import PhotoPreview from '../components/PhotoPreview';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatCurrency, formatDate } from '../utils/format';

export default function AssetDetailScreen() {
  const { theme } = useTheme();
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { id } = route.params;
  const { data: asset, isLoading } = useAsset(id);

  if (isLoading || !asset) return <LoadingSpinner />;

  const photos = (asset.attachments || [])
    .filter((a) => a.type?.startsWith('image/'))
    .map((a) => a.url);

  const rows: [string, string][] = [
    ['编号', asset.id],
    ['类型', asset.type],
    ['品牌型号', asset.brandModel],
    ['主体', asset.owner],
    ['使用人', asset.user],
    ['责任人', asset.manager],
    ['部门', asset.department],
    ['地点', asset.location],
    ['购入日期', formatDate(asset.purchaseDate)],
    ['价值', formatCurrency(asset.value)],
    ['数量', String(asset.quantity)],
  ];

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      {photos.length > 0 && (
        <View style={styles.photoSection}>
          <PhotoPreview photos={photos} />
        </View>
      )}

      <View style={[styles.statusRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <StatusBadge status={asset.status} />
      </View>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
            <Text style={[styles.value, { color: theme.text }]}>{value || '-'}</Text>
          </View>
        ))}
      </View>

      {asset.damageReason && (
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.danger, marginBottom: spacing.sm }]}>损坏原因</Text>
          <Text style={{ color: theme.text }}>{asset.damageReason}</Text>
        </View>
      )}

      <View style={styles.btnRow}>
        <TouchableOpacity
          style={[styles.btn, { borderColor: theme.border, backgroundColor: theme.surface }]}
          onPress={() => Alert.alert('提示', '打印功能开发中')}
        >
          <Text style={{ color: theme.text }}>打印标签</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.primaryBtn, { backgroundColor: theme.primary }]}
          onPress={() => navigation.navigate('AddAsset', { id: asset.id })}
        >
          <Text style={{ color: '#fff' }}>编辑</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  photoSection: { padding: spacing.lg },
  statusRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  card: { margin: spacing.lg, padding: spacing.lg, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', paddingVertical: spacing.sm },
  label: { width: 90, fontSize: fontSize.sm },
  value: { flex: 1, fontSize: fontSize.sm, fontWeight: '500' },
  btnRow: { flexDirection: 'row', padding: spacing.lg, gap: spacing.md },
  btn: { flex: 1, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  primaryBtn: { borderWidth: 0 },
});
