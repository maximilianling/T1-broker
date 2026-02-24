// ================================================================
// T1 BROKER MOBILE — LOGIN SCREEN
// ================================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Animated,
} from 'react-native';
import { useStore } from '../services/store';
import { useBiometric } from '../hooks/useBiometric';
import { Colors, createStyles, Spacing, Radius, Fonts } from '../utils/theme';
import api from '../services/api';

export default function LoginScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const login = useStore(s => s.login);
  const { available: bioAvail, enabled: bioEnabled, label: bioLabel, icon: bioIcon, authenticate: bioAuth } = useBiometric();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();

    // Auto biometric on mount
    if (bioAvail && bioEnabled) tryBiometric();
  }, []);

  async function tryBiometric() {
    const result = await bioAuth('Log in to T1 Broker');
    if (result.success) {
      const hasToken = await api.loadTokens();
      if (hasToken) {
        const refreshed = await api.refreshAuth();
        if (refreshed) {
          const user = await api.loadUser();
          if (user) {
            useStore.getState().setUser(user);
            useStore.getState().loadPortfolio();
          }
        }
      }
    }
  }

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      setError('Please enter email and password');
      return;
    }
    setError('');
    setLoading(true);

    const res = await login(email.trim(), password);
    setLoading(false);

    if (res.error) {
      setError(res.error);
    } else if (res.requiresMFA) {
      navigation.navigate('MFA');
    }
    // If success, store auto-navigates via isAuthenticated
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { flex: 1 }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: Spacing.lg }}
        keyboardShouldPersistTaps="handled">

        <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
          {/* Logo */}
          <View style={{ alignItems: 'center', marginBottom: 48 }}>
            <View style={{
              width: 72, height: 72, borderRadius: Radius.xl,
              backgroundColor: colors.blueLight, alignItems: 'center', justifyContent: 'center',
              marginBottom: 16,
            }}>
              <Text style={{ fontSize: 32, fontWeight: '800', color: colors.blue }}>T1</Text>
            </View>
            <Text style={{ ...Fonts.h1, color: colors.text }}>T1 Broker</Text>
            <Text style={{ ...Fonts.regular, color: colors.text3, marginTop: 4 }}>Multi-asset trading platform</Text>
          </View>

          {/* Form */}
          <View style={{ marginBottom: 24 }}>
            <Text style={styles.inputLabel}>Email</Text>
            <TextInput
              style={[styles.input, error && { borderColor: colors.red }]}
              placeholder="you@example.com"
              placeholderTextColor={colors.text4}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>

          <View style={{ marginBottom: 8 }}>
            <Text style={styles.inputLabel}>Password</Text>
            <View style={{ position: 'relative' }}>
              <TextInput
                style={styles.input}
                placeholder="••••••••"
                placeholderTextColor={colors.text4}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                returnKeyType="go"
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity
                style={{ position: 'absolute', right: 14, top: 14 }}
                onPress={() => setShowPassword(!showPassword)}
              >
                <Text style={{ color: colors.text3, fontSize: 16 }}>{showPassword ? '🙈' : '👁'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Error */}
          {error ? (
            <View style={{ backgroundColor: colors.redLight, padding: Spacing.sm, borderRadius: Radius.sm, marginBottom: Spacing.md }}>
              <Text style={{ color: colors.red, ...Fonts.caption, textAlign: 'center' }}>{error}</Text>
            </View>
          ) : null}

          {/* Forgot password */}
          <TouchableOpacity style={{ alignSelf: 'flex-end', marginBottom: 24 }}>
            <Text style={{ color: colors.blue, ...Fonts.caption }}>Forgot password?</Text>
          </TouchableOpacity>

          {/* Login button */}
          <TouchableOpacity
            style={[styles.btnPrimary, loading && { opacity: 0.6 }]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnPrimaryText}>Sign In</Text>
            )}
          </TouchableOpacity>

          {/* Biometric */}
          {bioAvail && bioEnabled && (
            <TouchableOpacity
              style={[styles.btnGhost, { marginTop: Spacing.md, flexDirection: 'row', justifyContent: 'center', gap: 8 }]}
              onPress={tryBiometric}
            >
              <Text style={{ fontSize: 20 }}>{bioIcon}</Text>
              <Text style={styles.btnGhostText}>Sign in with {bioLabel}</Text>
            </TouchableOpacity>
          )}

          {/* Footer */}
          <View style={{ alignItems: 'center', marginTop: 32 }}>
            <Text style={{ ...Fonts.caption, color: colors.text4 }}>🔒 256-bit TLS · End-to-end encrypted</Text>
          </View>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
