// ================================================================
// T1 BROKER MOBILE — NAVIGATION
// Role-based tabs, auth stack, admin screens, KYC upload
// ================================================================
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, View, Platform } from 'react-native';
import { useStore } from '../services/store';
import { Colors } from '../utils/theme';

// Auth Screens
import LoginScreen from '../screens/LoginScreen';
import MFAScreen from '../screens/MFAScreen';

// Client Screens
import TradingScreen from '../screens/TradingScreen';
import PortfolioScreen from '../screens/PortfolioScreen';
import MarketsScreen from '../screens/MarketsScreen';
import OrderScreen from '../screens/OrderScreen';
import SettingsScreen from '../screens/SettingsScreen';
import SecurityScreen from '../screens/SecurityScreen';
import TransferScreen from '../screens/TransferScreen';
import KYCUploadScreen from '../screens/KYCUploadScreen';
import CryptoWalletScreen from '../screens/CryptoWalletScreen';

// Admin Screens
import AdminDashboardScreen from '../screens/admin/AdminDashboardScreen';
import AdminClientsScreen from '../screens/admin/AdminClientsScreen';
import AdminOrdersScreen from '../screens/admin/AdminOrdersScreen';
import AdminComplianceScreen from '../screens/admin/AdminComplianceScreen';
import AdminConfigScreen from '../screens/admin/AdminConfigScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const MainStack = createNativeStackNavigator();

const ADMIN_ROLES = ['super_admin', 'admin', 'compliance', 'operations'];

// ── Tab Icons ──
function TabIcon({ name, focused }) {
  const icons = {
    // Client tabs
    Trading: focused ? '📊' : '📈',
    Portfolio: focused ? '💼' : '📁',
    Markets: focused ? '🌍' : '🌐',
    Transfers: focused ? '💳' : '💰',
    Settings: focused ? '⚙️' : '🔧',
    // Admin tabs
    Dashboard: focused ? '🏠' : '📊',
    Clients: focused ? '👥' : '👤',
    Orders: focused ? '📋' : '📄',
    Compliance: focused ? '🔍' : '🔎',
    Config: focused ? '⚙️' : '🔧',
  };
  return (
    <View style={{ alignItems: 'center', paddingTop: 4 }}>
      <Text style={{ fontSize: 20 }}>{icons[name] || '📌'}</Text>
    </View>
  );
}

// ── Client Tab Navigator ──
function ClientTabNavigator() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: false,
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
      tabBarActiveTintColor: colors.tabActive,
      tabBarInactiveTintColor: colors.tabInactive,
      tabBarStyle: {
        backgroundColor: colors.tabBar, borderTopColor: colors.border, borderTopWidth: 1,
        paddingBottom: Platform.OS === 'ios' ? 20 : 8, paddingTop: 8,
        height: Platform.OS === 'ios' ? 88 : 65,
      },
      tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
    })}>
      <Tab.Screen name="Trading" component={TradingScreen} />
      <Tab.Screen name="Portfolio" component={PortfolioScreen} />
      <Tab.Screen name="Markets" component={MarketsScreen} />
      <Tab.Screen name="Transfers" component={TransferScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

// ── Admin Tab Navigator ──
function AdminTabNavigator() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: false,
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
      tabBarActiveTintColor: colors.tabActive,
      tabBarInactiveTintColor: colors.tabInactive,
      tabBarStyle: {
        backgroundColor: colors.tabBar, borderTopColor: colors.border, borderTopWidth: 1,
        paddingBottom: Platform.OS === 'ios' ? 20 : 8, paddingTop: 8,
        height: Platform.OS === 'ios' ? 88 : 65,
      },
      tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
    })}>
      <Tab.Screen name="Dashboard" component={AdminDashboardScreen} />
      <Tab.Screen name="Clients" component={AdminClientsScreen} />
      <Tab.Screen name="Orders" component={AdminOrdersScreen} />
      <Tab.Screen name="Compliance" component={AdminComplianceScreen} />
      <Tab.Screen name="Config" component={AdminConfigScreen} />
    </Tab.Navigator>
  );
}

// ── Main Stack ──
function MainNavigator() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const user = useStore(s => s.user);
  const isAdmin = ADMIN_ROLES.includes(user?.role);

  return (
    <MainStack.Navigator screenOptions={{
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: '600' },
      contentStyle: { backgroundColor: colors.bg },
    }}>
      <MainStack.Screen name="Home" component={isAdmin ? AdminTabNavigator : ClientTabNavigator}
        options={{ headerShown: false }} />

      {/* Shared modal screens */}
      <MainStack.Screen name="PlaceOrder" component={OrderScreen}
        options={{ title: 'Place Order', presentation: 'modal' }} />
      <MainStack.Screen name="Security" component={SecurityScreen}
        options={{ title: 'Security Center' }} />
      <MainStack.Screen name="KYCUpload" component={KYCUploadScreen}
        options={{ title: 'Upload Documents', presentation: 'modal' }} />
      <MainStack.Screen name="CryptoWallet" component={CryptoWalletScreen}
        options={{ title: 'Crypto Wallets' }} />

      {/* Admin detail screens (accessible from admin tabs) */}
      {isAdmin && (
        <>
          <MainStack.Screen name="AdminClients" component={AdminClientsScreen}
            options={{ title: 'Client Management' }} />
          <MainStack.Screen name="AdminOrders" component={AdminOrdersScreen}
            options={{ title: 'Order Management' }} />
          <MainStack.Screen name="AdminCompliance" component={AdminComplianceScreen}
            options={{ title: 'Compliance Center' }} />
        </>
      )}
    </MainStack.Navigator>
  );
}

// ── Auth Stack ──
function AuthNavigator() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="MFA" component={MFAScreen} options={{ presentation: 'modal' }} />
    </Stack.Navigator>
  );
}

// ── Root ──
export default function RootNavigator() {
  const isAuthenticated = useStore(s => s.isAuthenticated);
  const isLoading = useStore(s => s.isLoading);

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0f1c', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 36, fontWeight: '700', color: '#3b82f6' }}>T1</Text>
        <Text style={{ fontSize: 14, color: '#64748b', marginTop: 8 }}>Loading...</Text>
      </View>
    );
  }

  return isAuthenticated ? <MainNavigator /> : <AuthNavigator />;
}
