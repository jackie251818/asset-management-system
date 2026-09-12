import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, Switch } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import { ThemeName, themes } from '../theme/colors';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { authApi } from '../api/auth';

const themeOptions: { name: ThemeName; label: string; icon: string }[] = [
  { name: 'light', label: '浅色', icon: 'white-balance-sunny' },
  { name: 'dark', label: '深色', icon: 'moon-waning-crescent' },
  { name: 'black', label: '纯黑', icon: 'moon-full' },
  { name: 'tech', label: '科技', icon: 'flash' },
];

export default function SettingsScreen() {
  const { theme, themeName, setTheme } = useTheme();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { serverUrl, setServerUrl } = useSettingsStore();

  const [editing, setEditing] = useState(false);
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [testing, setTesting] = useState(false);

  const handleSaveUrl = async () => {
    setServerUrl(urlInput);
    setEditing(false);
    setTesting(true);
    try {
      await authApi.ping();
      Alert.alert('成功', '服务器连接正常');
    } catch (e: any) {
      Alert.alert('连接失败', e.message || '请检查地址');
    } finally {
      setTesting(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert('确认', '确定要退出登录吗？', [
      { text: '取消' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          try { await authApi.logout(); } catch {}
          logout();
        },
      },
    ]);
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.profile, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={[styles.avatar, { backgroundColor: theme.primary + '1a' }]}>
          <Icon name="account" size={36} color={theme.primary} />
        </View>
        <View>
          <Text style={[styles.userName, { color: theme.text }]}>{user?.displayName || user?.username || '用户'}</Text>
          <Text style={[styles.userRole, { color: theme.textSecondary }]}>{user?.role || ''}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>服务器</Text>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {editing ? (
            <View>
              <TextInput
                style={[styles.input, { color: theme.text, backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}
                value={urlInput}
                onChangeText={setUrlInput}
                placeholder="http://192.168.40.247"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
              />
              <View style={styles.btnRow}>
                <TouchableOpacity style={[styles.btn, { borderColor: theme.border }]} onPress={() => setEditing(false)}>
                  <Text style={{ color: theme.text }}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { backgroundColor: theme.primary }]} onPress={handleSaveUrl} disabled={testing}>
                  <Text style={{ color: '#fff' }}>{testing ? '测试中...' : '保存并测试'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.urlRow} onPress={() => { setUrlInput(serverUrl); setEditing(true); }}>
              <Icon name="server" size={20} color={theme.primary} />
              <Text style={[styles.url, { color: theme.text }]} numberOfLines={1}>{serverUrl}</Text>
              <Icon name="chevron-right" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>主题</Text>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {themeOptions.map((opt) => (
            <TouchableOpacity
              key={opt.name}
              style={[styles.themeRow, { borderBottomColor: theme.border }]}
              onPress={() => setTheme(opt.name)}
            >
              <Icon name={opt.icon} size={20} color={themes[opt.name].primary} />
              <Text style={[styles.themeLabel, { color: theme.text }]}>{opt.label}</Text>
              {themeName === opt.name && <Icon name="check" size={18} color={theme.primary} />}
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <TouchableOpacity style={[styles.logoutBtn, { backgroundColor: theme.danger }]} onPress={handleLogout}>
          <Icon name="logout" size={20} color="#fff" />
          <Text style={styles.logoutText}>退出登录</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  profile: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginRight: spacing.lg },
  userName: { fontSize: fontSize.lg, fontWeight: '700' },
  userRole: { fontSize: fontSize.sm, marginTop: 2 },
  section: { marginTop: spacing.lg, paddingHorizontal: spacing.lg },
  sectionTitle: { fontSize: fontSize.sm, marginBottom: spacing.sm, paddingHorizontal: spacing.sm },
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md },
  urlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  url: { flex: 1, fontSize: fontSize.md },
  input: { height: 44, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, fontSize: fontSize.md },
  btnRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  btn: { flex: 1, height: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  themeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.sm },
  themeLabel: { flex: 1, fontSize: fontSize.md },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: radius.md, gap: spacing.sm },
  logoutText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
});
