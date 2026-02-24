// ================================================================
// T1 BROKER MOBILE — MFA VERIFICATION SCREEN
// ================================================================
import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Switch } from 'react-native';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Radius, Fonts } from '../utils/theme';

export default function MFAScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);

  const mfaPending = useStore(s => s.mfaPending);
  const verifyMFA = useStore(s => s.verifyMFA);

  const [code, setCode] = useState('');
  const [method, setMethod] = useState(mfaPending?.mfaMethod || 'totp');
  const [trustDevice, setTrustDevice] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resending, setResending] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, [method]);

  const instructions = {
    totp: 'Enter the 6-digit code from your authenticator app',
    email: mfaPending?.emailSent
      ? `Enter the code sent to ${mfaPending.emailSent}`
      : 'Check your email for a verification code',
    backup: 'Enter one of your backup recovery codes',
  };

  async function handleVerify() {
    const trimmed = code.trim();
    if (!trimmed) { setError('Please enter a code'); return; }
    setError('');
    setLoading(true);

    const res = await verifyMFA(trimmed, { method, trustDevice });
    setLoading(false);

    if (res.error) {
      setError(res.error + (res.attemptsRemaining != null ? ` (${res.attemptsRemaining} left)` : ''));
      setCode('');
      inputRef.current?.focus();
    }
    // Success auto-navigates via isAuthenticated
  }

  async function handleResend() {
    setResending(true);
    const api = require('../services/api').default;
    const res = await api.resendEmailCode(mfaPending?.mfaToken);
    setResending(false);
    if (res.error) setError(res.error);
    else setError('');
  }

  function switchMethod(m) {
    setMethod(m);
    setCode('');
    setError('');
    if (m === 'email') handleResend();
  }

  return (
    <View style={[styles.screen, { padding: Spacing.lg, justifyContent: 'center' }]}>
      {/* Header */}
      <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginBottom: Spacing.lg }}>
        <Text style={{ color: colors.blue, ...Fonts.medium }}>← Back to login</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Two-Factor{'\n'}Authentication</Text>
      <Text style={[styles.subtitle, { marginBottom: 32 }]}>{instructions[method]}</Text>

      {/* Code input */}
      <Text style={styles.inputLabel}>
        {method === 'totp' ? 'AUTHENTICATOR CODE' : method === 'email' ? 'EMAIL CODE' : 'BACKUP CODE'}
      </Text>
      <TextInput
        ref={inputRef}
        style={[styles.input, {
          fontSize: 28, textAlign: 'center', letterSpacing: method === 'backup' ? 4 : 10,
          fontFamily: 'Courier', fontWeight: '700', marginBottom: Spacing.md,
        }]}
        value={code}
        onChangeText={setCode}
        placeholder={method === 'backup' ? 'XXXX-XXXX' : '000000'}
        placeholderTextColor={colors.text4}
        keyboardType={method === 'backup' ? 'default' : 'number-pad'}
        maxLength={method === 'backup' ? 9 : 6}
        autoFocus
        returnKeyType="go"
        onSubmitEditing={handleVerify}
      />

      {/* Trust device */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 10 }}>
        <Switch
          value={trustDevice}
          onValueChange={setTrustDevice}
          trackColor={{ true: colors.blue, false: colors.bg3 }}
          thumbColor="#fff"
        />
        <Text style={{ ...Fonts.caption, color: colors.text2 }}>Trust this device for 30 days</Text>
      </View>

      {/* Error */}
      {error ? (
        <View style={{ backgroundColor: colors.redLight, padding: Spacing.sm, borderRadius: Radius.sm, marginBottom: Spacing.md }}>
          <Text style={{ color: colors.red, ...Fonts.caption, textAlign: 'center' }}>{error}</Text>
        </View>
      ) : null}

      {/* Verify button */}
      <TouchableOpacity
        style={[styles.btnPrimary, loading && { opacity: 0.6 }]}
        onPress={handleVerify}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Verify</Text>}
      </TouchableOpacity>

      {/* Alternative methods */}
      <View style={{ marginTop: 24, alignItems: 'center', gap: 12 }}>
        {method === 'email' && (
          <TouchableOpacity onPress={handleResend} disabled={resending}>
            <Text style={{ color: colors.blue, ...Fonts.caption }}>
              {resending ? 'Sending...' : '📧 Resend email code'}
            </Text>
          </TouchableOpacity>
        )}

        {method !== 'totp' && (
          <TouchableOpacity onPress={() => switchMethod('totp')}>
            <Text style={{ color: colors.text3, ...Fonts.caption }}>📱 Use authenticator app</Text>
          </TouchableOpacity>
        )}

        {method !== 'email' && (
          <TouchableOpacity onPress={() => switchMethod('email')}>
            <Text style={{ color: colors.text3, ...Fonts.caption }}>📧 Send code to email</Text>
          </TouchableOpacity>
        )}

        {method !== 'backup' && (
          <TouchableOpacity onPress={() => switchMethod('backup')}>
            <Text style={{ color: colors.text3, ...Fonts.caption }}>🔑 Use a backup code</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
