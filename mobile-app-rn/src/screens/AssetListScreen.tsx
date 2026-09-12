import React, { useState, useCallback } from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity, RefreshControl, Text } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius } from '../theme/spacing';
import { useAssets } from '../hooks/useAssets';
import AssetCard from '../components/AssetCard';
import SearchBar from '../components/SearchBar';
import FilterSheet from '../components/FilterSheet';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '在用', value: 'active' },
  { label: '维修', value: 'repair' },
  { label: '报废', value: 'scrap' },
  { label: '遗失', value: 'lost' },
];

export default function AssetListScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('all');
  const [showStatusSheet, setShowStatusSheet] = useState(false);
  const [searchText, setSearchText] = useState('');

  // 防抖
  const debouncedSetKeyword = useCallback((text: string) => {
    setSearchText(text);
    const timer = setTimeout(() => setKeyword(text), 300);
    return () => clearTimeout(timer);
  }, []);

  const { data, isLoading, refetch, isRefetching } = useAssets(keyword, undefined, status);

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <SearchBar value={searchText} onChangeText={debouncedSetKeyword} placeholder="搜索编号/型号/使用人" />

      <View style={styles.filterRow}>
        <TouchableOpacity style={[styles.filterBtn, { borderColor: theme.border, backgroundColor: theme.surface }]} onPress={() => setShowStatusSheet(true)}>
          <Text style={{ color: theme.text }}>{statusOptions.find((o) => o.value === status)?.label}</Text>
          <Icon name="chevron-down" size={14} color={theme.textSecondary} />
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <LoadingSpinner />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <AssetCard asset={item} onPress={() => navigation.navigate('AssetDetail', { id: item.id })} />
          )}
          ListEmptyComponent={<EmptyState icon="laptop" text="没有符合条件的资产" />}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} colors={[theme.primary]} />}
          contentContainerStyle={{ paddingVertical: spacing.sm, flexGrow: 1 }}
        />
      )}

      <TouchableOpacity style={[styles.fab, { backgroundColor: theme.primary }]} onPress={() => navigation.navigate('AddAsset')}>
        <Icon name="plus" size={28} color="#fff" />
      </TouchableOpacity>

      <FilterSheet
        visible={showStatusSheet}
        title="选择状态"
        options={statusOptions}
        selected={status}
        onSelect={setStatus}
        onClose={() => setShowStatusSheet(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  filterRow: { flexDirection: 'row', paddingHorizontal: spacing.lg, marginBottom: spacing.xs },
  filterBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 34, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, gap: 4 },
  fab: { position: 'absolute', right: spacing.lg, bottom: spacing.xl, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 },
});
