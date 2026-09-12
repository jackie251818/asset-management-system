import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';

interface Props {
  label: string;
  value: string | number;
  icon?: string;
  color?: string;
}

export default function StatCard({ label, value, icon, color }: Props) {
  const { theme } = useTheme();
  const accent = color || theme.primary;

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {icon ? (
        <View style={[styles.iconBox, { backgroundColor: accent + '1a' }]}>
          <Icon name={icon} size={22} color={accent} />
        </View>
      ) : null}
      <Text style={[styles.value, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  value: { fontSize: fontSize.xxl, fontWeight: '700' },
  label: { fontSize: fontSize.sm, marginTop: 2 },
});
