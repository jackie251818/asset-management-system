import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, fontSize } from '../theme/spacing';

interface Props {
  icon?: string;
  text: string;
}

export default function EmptyState({ icon = 'clipboard-outline', text }: Props) {
  const { theme } = useTheme();
  return (
    <View style={styles.wrap}>
      <Icon name={icon} size={56} color={theme.textMuted} />
      <Text style={[styles.text, { color: theme.textSecondary }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxxl },
  text: { fontSize: fontSize.md, marginTop: spacing.md, textAlign: 'center' },
});
