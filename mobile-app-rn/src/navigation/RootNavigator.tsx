import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useAuthStore } from '../store/authStore';
import MainTabBar from './MainTabBar';
import LoginScreen from '../screens/LoginScreen';
import SettingsScreen from '../screens/SettingsScreen';
import { useTheme } from '../theme/ThemeProvider';

const Stack = createStackNavigator();

export default function RootNavigator() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const { theme } = useTheme();

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          cardStyle: { backgroundColor: theme.background },
        }}
      >
        {isLoggedIn ? (
          <Stack.Screen name="Main" component={MainTabBar} />
        ) : (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen
              name="ServerSettings"
              component={SettingsScreen}
              options={{ headerShown: true, title: '服务器设置', headerTintColor: theme.primary }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
