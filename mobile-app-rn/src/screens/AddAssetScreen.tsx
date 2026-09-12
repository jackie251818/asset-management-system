import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, TouchableOpacity, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useAsset } from '../hooks/useAsset';
import { assetsApi } from '../api/assets';
import { useQueryClient } from '@tanstack/react-query';
import StatusBadge from '../components/StatusBadge';
import PhotoPreview from '../components/PhotoPreview';
import { AssetStatus } from '../types/api';

const TYPES = ['笔记本电脑', '台式机', '显示器', '打印机', '服务器', '网络设备', '办公家具', '其他'];
const STATUSES: { value: AssetStatus; label: string }[] = [
  { value: 'active', label: '在用' },
  { value: 'repair', label: '维修' },
  { value: 'scrap', label: '报废' },
  { value: 'lost', label: '遗失' },
];

export default function AddAssetScreen() {
  const { theme } = useTheme();
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const editId = route.params?.id;
  const { data: existing } = useAsset(editId);

  const isEdit = !!editId;
  const [form, setForm] = useState({
    id: existing?.id || '',
    type: existing?.type || TYPES[0],
    brandModel: existing?.brandModel || '',
    owner: existing?.owner || '',
    manager: existing?.manager || '',
    user: existing?.user || '',
    department: existing?.department || '',
    location: existing?.location || '',
    status: (existing?.status as AssetStatus) || 'active',
    purchaseDate: existing?.purchaseDate || new Date().toISOString().slice(0, 10),
    value: existing?.value ? String(existing.value) : '',
    quantity: existing?.quantity ? String(existing.quantity) : '1',
    damageReason: existing?.damageReason || '',
    attachments: existing?.attachments || [],
  });
  const [saving, setSaving] = useState(false);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);

  const update = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.id || !form.type) {
      Alert.alert('提示', '请填写编号和类型');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        value: parseFloat(form.value) || 0,
        quantity: parseInt(form.quantity) || 1,
      };
      if (isEdit) {
        await assetsApi.update(editId, payload);
      } else {
        await assetsApi.create(payload);
      }
      qc.invalidateQueries({ queryKey: ['assets'] });
      qc.invalidateQueries({ queryKey: ['asset', editId] });
      Alert.alert('成功', isEdit ? '资产已更新' : '资产已新增', [{ text: '确定', onPress: () => navigation.goBack() }]);
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '请重试');
    } finally {
      setSaving(false);
    }
  };

  const Field = ({ label, value, onChangeText, placeholder, keyboardType }: any) => (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>{label}</Text>
      <TextInput
        style={[styles.textInput, { color: theme.text, backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        keyboardType={keyboardType}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={{ padding: spacing.lg, paddingBottom: 100 }}>
        <Field label="编号" value={form.id} onChangeText={(v: string) => update('id', v)} placeholder="如 FYM-001" />
        <Field label="品牌型号" value={form.brandModel} onChangeText={(v: string) => update('brandModel', v)} placeholder="如 ThinkPad X1" />
        <Field label="主体" value={form.owner} onChangeText={(v: string) => update('owner', v)} placeholder="如 花满堂" />
        <Field label="使用人" value={form.user} onChangeText={(v: string) => update('user', v)} />
        <Field label="责任人" value={form.manager} onChangeText={(v: string) => update('manager', v)} />
        <Field label="部门" value={form.department} onChangeText={(v: string) => update('department', v)} />
        <Field label="地点" value={form.location} onChangeText={(v: string) => update('location', v)} />
        <Field label="购入日期" value={form.purchaseDate} onChangeText={(v: string) => update('purchaseDate', v)} placeholder="2025-09-08" />
        <Field label="价值" value={form.value} onChangeText={(v: string) => update('value', v)} placeholder="0" keyboardType="decimal-pad" />
        <Field label="数量" value={form.quantity} onChangeText={(v: string) => update('quantity', v)} placeholder="1" keyboardType="number-pad" />

        <View style={styles.field}>
          <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>类型</Text>
          <TouchableOpacity style={[styles.pickerBtn, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]} onPress={() => setTypePickerOpen(true)}>
            <Text style={{ color: theme.text }}>{form.type}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.field}>
          <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>状态</Text>
          <View style={styles.statusRow}>
            {STATUSES.map((s) => (
              <TouchableOpacity
                key={s.value}
                style={[styles.statusChip, form.status === s.value ? { backgroundColor: theme.primary } : { borderColor: theme.border }, { borderWidth: 1 }]}
                onPress={() => update('status', s.value)}
              >
                <StatusBadge status={s.value} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>附件/照片</Text>
          <PhotoPreview
            photos={(form.attachments || []).map((a: any) => a.url).filter(Boolean)}
            editable
            onAdd={() => Alert.alert('提示', '请先安装 vision-camera 并配置拍照功能')}
            onRemove={(i: number) => {
              const next = [...form.attachments];
              next.splice(i, 1);
              update('attachments', next);
            }}
          />
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: saving ? theme.textMuted : theme.primary }]}
          onPress={handleSave}
          disabled={saving}
        >
          <Text style={styles.saveText}>{saving ? '保存中...' : isEdit ? '保存修改' : '保存资产'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  field: { marginBottom: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, marginBottom: spacing.xs },
  textInput: { height: 44, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, fontSize: fontSize.md },
  pickerBtn: { height: 44, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  statusRow: { flexDirection: 'row', gap: spacing.sm },
  statusChip: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm },
  saveBtn: { height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  saveText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
});
