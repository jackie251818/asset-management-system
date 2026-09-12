import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

export default function LoadingSpinner({ size = 'large' }: { size?: 'small' | 'large' }) {
  const { theme } = useTheme();
  return (
    <View style={styles.wrap}>
      <ActivityIndicator size={size} color={theme.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
