import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider';
import HomeScreen from '../screens/HomeScreen';
import AssetListScreen from '../screens/AssetListScreen';
import InventoryListScreen from '../screens/InventoryListScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AssetDetailScreen from '../screens/AssetDetailScreen';
import AddAssetScreen from '../screens/AddAssetScreen';
import InventoryDetailScreen from '../screens/InventoryDetailScreen';
import ScanScreen from '../screens/ScanScreen';
import { createStackNavigator } from '@react-navigation/stack';

const Tab = createBottomTabNavigator();
const HomeStack = createStackNavigator();
const AssetStack = createStackNavigator();
const InventoryStack = createStackNavigator();
const SettingsStack = createStackNavigator();

function HomeStackNav() {
  const { theme } = useTheme();
  return (
    <HomeStack.Navigator screenOptions={{ headerTintColor: theme.primary, headerStyle: { backgroundColor: theme.surface }, headerTitleStyle: { color: theme.text } }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} options={{ title: '首页' }} />
      <HomeStack.Screen name="AssetDetail" component={AssetDetailScreen} options={{ title: '资产详情' }} />
    </HomeStack.Navigator>
  );
}

function AssetStackNav() {
  const { theme } = useTheme();
  return (
    <AssetStack.Navigator screenOptions={{ headerTintColor: theme.primary, headerStyle: { backgroundColor: theme.surface }, headerTitleStyle: { color: theme.text } }}>
      <AssetStack.Screen name="AssetList" component={AssetListScreen} options={{ title: '资产列表' }} />
      <AssetStack.Screen name="AssetDetail" component={AssetDetailScreen} options={{ title: '资产详情' }} />
      <AssetStack.Screen name="AddAsset" component={AddAssetScreen} options={{ title: '新增资产' }} />
    </AssetStack.Navigator>
  );
}

function InventoryStackNav() {
  const { theme } = useTheme();
  return (
    <InventoryStack.Navigator screenOptions={{ headerTintColor: theme.primary, headerStyle: { backgroundColor: theme.surface }, headerTitleStyle: { color: theme.text } }}>
      <InventoryStack.Screen name="InventoryList" component={InventoryListScreen} options={{ title: '资产盘点' }} />
      <InventoryStack.Screen name="InventoryDetail" component={InventoryDetailScreen} options={{ title: '盘点明细' }} />
      <InventoryStack.Screen name="Scan" component={ScanScreen} options={{ headerShown: false }} />
    </InventoryStack.Navigator>
  );
}

function SettingsStackNav() {
  const { theme } = useTheme();
  return (
    <SettingsStack.Navigator screenOptions={{ headerTintColor: theme.primary, headerStyle: { backgroundColor: theme.surface }, headerTitleStyle: { color: theme.text } }}>
      <SettingsStack.Screen name="SettingsMain" component={SettingsScreen} options={{ title: '我的' }} />
    </SettingsStack.Navigator>
  );
}

export default function MainTabBar() {
  const { theme } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ color, size }) => {
          const icons: Record<string, string> = {
            Home: 'view-dashboard',
            Assets: 'laptop',
            Inventory: 'clipboard-check',
            Settings: 'account-cog',
          };
          return <Icon name={icons[route.name] || 'circle'} size={size} color={color} />;
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
      })}
    >
      <Tab.Screen name="Home" component={HomeStackNav} options={{ title: '首页' }} />
      <Tab.Screen name="Assets" component={AssetStackNav} options={{ title: '资产' }} />
      <Tab.Screen name="Inventory" component={InventoryStackNav} options={{ title: '盘点' }} />
      <Tab.Screen name="Settings" component={SettingsStackNav} options={{ title: '我的' }} />
    </Tab.Navigator>
  );
}
