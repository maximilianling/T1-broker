// ================================================================
// T1 BROKER MOBILE — APP ENTRY POINT
// ================================================================
import React, { useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar, Platform, AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { useStore } from './src/services/store';
import { Colors } from './src/utils/theme';
import RootNavigator from './src/navigation/RootNavigator';

// Keep splash visible while loading
SplashScreen.preventAutoHideAsync();

// Push notification handler config
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Deep link config
const linking = {
  prefixes: ['t1broker://', 'https://app.t1broker.com'],
  config: {
    screens: {
      Home: {
        screens: {
          Trading: 'trading',
          Portfolio: 'portfolio',
          Markets: 'markets',
          Transfers: 'transfers',
          Settings: 'settings',
        },
      },
      PlaceOrder: 'order/:symbol?',
      Security: 'security',
      Login: 'login',
      MFA: 'mfa',
    },
  },
};

export default function App() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const restoreSession = useStore(s => s.restoreSession);
  const isLoading = useStore(s => s.isLoading);
  const notificationListener = useRef();
  const responseListener = useRef();

  useEffect(() => {
    // Restore session
    restoreSession().finally(() => {
      SplashScreen.hideAsync();
    });

    // Push notification listeners
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      // Handle foreground notification (e.g., order filled, price alert)
      const { title, body, data } = notification.request.content;
      console.log('Notification received:', title, body, data);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      // User tapped notification — navigate to relevant screen
      const data = response.notification.request.content.data;
      if (data?.screen) {
        // navigation.navigate(data.screen, data.params) — handled via deep linking
      }
    });

    // App state listener — refresh data when coming to foreground
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const store = useStore.getState();
        if (store.isAuthenticated) {
          store.loadPortfolio();
        }
      }
    });

    return () => {
      notificationListener.current && Notifications.removeNotificationSubscription(notificationListener.current);
      responseListener.current && Notifications.removeNotificationSubscription(responseListener.current);
      sub.remove();
    };
  }, []);

  const navTheme = {
    dark: theme === 'dark',
    colors: {
      primary: colors.blue,
      background: colors.bg,
      card: colors.tabBar,
      text: colors.text,
      border: colors.border,
      notification: colors.red,
    },
  };

  return (
    <>
      <StatusBar barStyle={colors.statusBar === 'light' ? 'light-content' : 'dark-content'} />
      <NavigationContainer theme={navTheme} linking={linking}>
        <RootNavigator />
      </NavigationContainer>
    </>
  );
}
