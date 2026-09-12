import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, radius, fontSize } from '../theme/spacing';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { authApi } from '../api/auth';

export default function LoginScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const login = useAuthStore((s) => s.login);
  const serverUrl = useSettingsStore((s) => s.serverUrl);

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) {
      Alert.alert('提示', '请输入用户名和密码');
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.login(username, password);
      login(res.token, res.user);
    } catch (e: any) {
      Alert.alert('登录失败', e.message || '请检查用户名密码或服务器地址');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.container, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.logoArea}>
          <Icon name="laptop" size={64} color={theme.primary} />
          <Text style={[styles.title, { color: theme.text }]}>固定资产管理</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>原生移动版</Text>
        </View>

        <View style={[styles.inputWrap, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="account" size={20} color={theme.textMuted} />
          <TextInput
            style={[styles.input, { color: theme.text }]}
            placeholder="用户名"
            placeholderTextColor={theme.textMuted}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
          />
        </View>

        <View style={[styles.inputWrap, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="lock" size={20} color={theme.textMuted} />
          <TextInput
            style={[styles.input, { color: theme.text }]}
            placeholder="密码"
            placeholderTextColor={theme.textMuted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPwd}
          />
          <TouchableOpacity onPress={() => setShowPwd(!showPwd)}>
            <Icon name={showPwd ? 'eye-off' : 'eye'} size={20} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.loginBtn, { backgroundColor: loading ? theme.textMuted : theme.primary }]}
          onPress={handleLogin}
          disabled={loading}
        >
          <Text style={styles.loginText}>{loading ? '登录中...' : '登 录'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.serverRow} onPress={() => navigation.navigate('ServerSettings')}>
          <Icon name="server" size={16} color={theme.textSecondary} />
          <Text style={[styles.serverText, { color: theme.textSecondary }]}>服务器: {serverUrl}</Text>
          <Text style={[styles.changeText, { color: theme.primary }]}>修改</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: spacing.xxxl, justifyContent: 'center' },
  logoArea: { alignItems: 'center', marginBottom: spacing.xxxl },
  title: { fontSize: fontSize.title, fontWeight: '700', marginTop: spacing.md },
  subtitle: { fontSize: fontSize.md, marginTop: spacing.xs },
  inputWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 50, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.md },
  input: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, padding: 0 },
  loginBtn: { height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
  loginText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  serverRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl, gap: spacing.sm },
  serverText: { fontSize: fontSize.sm },
  changeText: { fontSize: fontSize.sm, fontWeight: '600' },
});
