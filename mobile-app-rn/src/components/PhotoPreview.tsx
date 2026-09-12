import React from 'react';
import { View, Image, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';

interface Props {
  photos: string[];
  onAdd?: () => void;
  onRemove?: (index: number) => void;
  editable?: boolean;
}

export default function PhotoPreview({ photos, onAdd, onRemove, editable = false }: Props) {
  const { theme } = useTheme();
  return (
    <View style={styles.wrap}>
      {photos.map((uri, i) => (
        <View key={i} style={styles.photoBox}>
          <Image source={{ uri }} style={styles.photo} />
          {editable && (
            <TouchableOpacity style={styles.delBtn} onPress={() => onRemove?.(i)}>
              <Icon name="close" size={14} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      ))}
      {editable && (
        <TouchableOpacity style={[styles.addBox, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]} onPress={onAdd}>
          <Icon name="camera-plus" size={28} color={theme.textMuted} />
          <Text style={[styles.addText, { color: theme.textMuted }]}>拍照</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  photoBox: { position: 'relative', marginRight: spacing.sm, marginBottom: spacing.sm },
  photo: { width: 80, height: 80, borderRadius: radius.md },
  delBtn: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: '#f5222d', alignItems: 'center', justifyContent: 'center' },
  addBox: { width: 80, height: 80, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  addText: { fontSize: fontSize.xs, marginTop: 2 },
});
