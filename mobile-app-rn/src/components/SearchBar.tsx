import React from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';

interface Props {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
}

export default function SearchBar({ value, onChangeText, placeholder = '搜索' }: Props) {
  const { theme } = useTheme();
  return (
    <View style={[styles.wrap, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
      <Icon name="magnify" size={18} color={theme.textMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        style={[styles.input, { color: theme.text }]}
        returnKeyType="search"
      />
      {value ? (
        <Icon name="close-circle" size={16} color={theme.textMuted} onPress={() => onChangeText('')} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.lg, marginVertical: spacing.sm, paddingHorizontal: spacing.md, height: 40, borderRadius: radius.md, borderWidth: 1 },
  input: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, padding: 0 },
});
