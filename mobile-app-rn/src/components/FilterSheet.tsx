import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, FlatList } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';

interface Props {
  visible: boolean;
  title: string;
  options: { label: string; value: string }[];
  selected: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export default function FilterSheet({ visible, title, options, selected, onSelect, onClose }: Props) {
  const { theme } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.mask} activeOpacity={1} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: theme.surface }]}>
          <View style={styles.handle} />
          <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
          <FlatList
            data={options}
            keyExtractor={(it) => it.value}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.option, { borderBottomColor: theme.border }]}
                onPress={() => { onSelect(item.value); onClose(); }}
              >
                <Text style={[styles.optionText, { color: theme.text }]}>{item.label}</Text>
                {selected === item.value && <Icon name="check" size={18} color={theme.primary} />}
              </TouchableOpacity>
            )}
          />
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg, maxHeight: '70%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#cbd5e0', alignSelf: 'center', marginBottom: spacing.md },
  title: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.md },
  option: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  optionText: { fontSize: fontSize.md },
});
