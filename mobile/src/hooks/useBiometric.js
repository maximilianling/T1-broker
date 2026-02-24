// ================================================================
// T1 BROKER MOBILE — BIOMETRIC AUTHENTICATION HOOK
// ================================================================
import { useState, useEffect, useCallback } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform, Alert } from 'react-native';

const BIOMETRIC_KEY = 't1_biometric_enabled';

export function useBiometric() {
  const [available, setAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState(null); // 'faceid' | 'fingerprint' | 'iris'
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setAvailable(compatible && enrolled);

      if (compatible && enrolled) {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType('faceid');
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType('fingerprint');
        } else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
          setBiometricType('iris');
        }
      }

      const stored = await SecureStore.getItemAsync(BIOMETRIC_KEY);
      setEnabled(stored === 'true');
    })();
  }, []);

  const authenticate = useCallback(async (reason) => {
    if (!available) return { success: false, error: 'Biometric not available' };

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason || 'Authenticate to access T1 Broker',
        cancelLabel: 'Use Password',
        disableDeviceFallback: false,
        fallbackLabel: 'Use Passcode',
      });

      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }, [available]);

  const toggle = useCallback(async () => {
    if (!available) {
      Alert.alert('Not Available', 'Biometric authentication is not set up on this device.');
      return;
    }

    if (enabled) {
      await SecureStore.deleteItemAsync(BIOMETRIC_KEY);
      setEnabled(false);
    } else {
      // Verify biometric first
      const result = await authenticate('Verify to enable biometric login');
      if (result.success) {
        await SecureStore.setItemAsync(BIOMETRIC_KEY, 'true');
        setEnabled(true);
      }
    }
  }, [available, enabled, authenticate]);

  const label = biometricType === 'faceid'
    ? (Platform.OS === 'ios' ? 'Face ID' : 'Face Unlock')
    : biometricType === 'iris' ? 'Iris'
    : 'Fingerprint';

  const icon = biometricType === 'faceid' ? '👤' : '🔒';

  return { available, enabled, biometricType, label, icon, authenticate, toggle };
}
