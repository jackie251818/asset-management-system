import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { radius, fontSize } from '../theme/spacing';

type Status = 'active' | 'repair' | 'scrap' | 'lost' | 'counted' | 'pending' | 'exception';

const map: Record<Status, { label: string; color: string; icon: string }> = {
  active: { label: '在用', color: '#52c41a', icon: 'check-circle' },
  repair: { label: '维修', color: '#faad14', icon: 'wrench' },
  scrap: { label: '报废', color: '#a0aec0', icon: 'delete' },
  lost: { label: '遗失', color: '#f5222d', icon: 'alert-octagon' },
  counted: { label: '已盘', color: '#52c41a', icon: 'check' },
  pending: { label: '未盘到', color: '#a0aec0', icon: 'clock-outline' },
  exception: { label: '异常', color: '#f5222d', icon: 'alert' },
};

export default function StatusBadge({ status }: { status: Status }) {
  const { theme } = useTheme();
  const m = map[status] || map.pending;
  return (
    <View style={[styles.badge, { backgroundColor: m.color + '1a' }]}>
      <Icon name={m.icon} size={12} color={m.color} />
      <Text style={[styles.text, { color: m.color }]}>{m.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  text: { fontSize: fontSize.xs, marginLeft: 3, fontWeight: '600' },
});
