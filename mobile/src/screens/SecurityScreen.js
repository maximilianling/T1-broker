// ================================================================
// T1 BROKER MOBILE — SECURITY CENTER SCREEN
// ================================================================
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, SafeAreaView, Alert, Image } from 'react-native';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';
import api from '../services/api';

export default function SecurityScreen() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);

  const [mfaStatus, setMfaStatus] = useState(null);
  const [devices, setDevices] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [setupStep, setSetupStep] = useState(null); // null | 'totp-qr' | 'totp-confirm' | 'email-sent' | 'email-confirm'
  const [qrData, setQrData] = useState(null);
  const [code, setCode] = useState('');

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    const [s, d, h] = await Promise.all([
      api.getMFAStatus().catch(() => null),
      api.getTrustedDevices().catch(() => ({ data: [] })),
      api.getLoginHistory().catch(() => ({ data: [] })),
    ]);
    setMfaStatus(s);
    setDevices(d?.data || []);
    setHistory(h?.data || []);
    setLoading(false);
  }

  // ── TOTP Setup ──
  async function startTOTP() {
    const res = await api.setupTOTP();
    if (res.error) { Alert.alert('Error', res.error); return; }
    setQrData(res);
    setSetupStep('totp-qr');
  }

  async function confirmTOTP() {
    if (code.length !== 6) { Alert.alert('Invalid', 'Enter the 6-digit code'); return; }
    const res = await api.confirmTOTP(code);
    if (res.error) { Alert.alert('Error', res.error); return; }
    Alert.alert('MFA Enabled', `Save your backup codes:\n\n${res.backupCodes.join('\n')}`, [
      { text: 'Done', onPress: () => { setSetupStep(null); setCode(''); loadAll(); } },
    ]);
  }

  // ── Email MFA ──
  async function startEmailMFA() {
    const res = await api.setupEmailMFA();
    if (res.error) { Alert.alert('Error', res.error); return; }
    setSetupStep('email-confirm');
  }

  async function confirmEmailMFA() {
    if (code.length !== 6) { Alert.alert('Invalid', 'Enter the 6-digit code'); return; }
    const res = await api.confirmEmailMFA(code);
    if (res.error) { Alert.alert('Error', res.error); return; }
    Alert.alert('Email MFA Enabled', `Save your backup codes:\n\n${res.backupCodes.join('\n')}`, [
      { text: 'Done', onPress: () => { setSetupStep(null); setCode(''); loadAll(); } },
    ]);
  }

  // ── Disable ──
  function handleDisable() {
    Alert.prompt('Disable MFA', 'Enter your password to confirm:', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disable', style: 'destructive', onPress: async (pw) => {
        const res = await api.disableMFA(pw);
        if (res.error) Alert.alert('Error', res.error);
        else { Alert.alert('Disabled', 'MFA has been disabled'); loadAll(); }
      }},
    ], 'secure-text');
  }

  async function revokeDevice(id) {
    await api.revokeDevice(id);
    loadAll();
  }

  // ── Setup Flow ──
  if (setupStep === 'totp-qr') {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
          <Text style={styles.title}>Setup Authenticator</Text>
          <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>Scan this QR code with Google Authenticator or Authy</Text>

          {qrData?.qrCode && (
            <View style={{ alignItems: 'center', marginBottom: Spacing.lg }}>
              <Image source={{ uri: qrData.qrCode }} style={{ width: 220, height: 220, borderRadius: Radius.md }} />
            </View>
          )}

          <Text style={{ ...Fonts.caption, color: colors.text3, textAlign: 'center', marginBottom: Spacing.lg }}>
            Manual key: {qrData?.secret}
          </Text>

          <Text style={styles.inputLabel}>ENTER CODE FROM APP</Text>
          <TextInput style={[styles.input, { fontSize: 24, textAlign: 'center', letterSpacing: 8, fontFamily: 'Courier', marginBottom: Spacing.md }]}
            value={code} onChangeText={setCode} maxLength={6} keyboardType="number-pad" placeholder="000000"
            placeholderTextColor={colors.text4} />

          <TouchableOpacity style={styles.btnPrimary} onPress={confirmTOTP}>
            <Text style={styles.btnPrimaryText}>Confirm & Enable</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btnGhost, { marginTop: Spacing.sm }]} onPress={() => setSetupStep(null)}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (setupStep === 'email-confirm') {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
          <Text style={styles.title}>Verify Email Code</Text>
          <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>Enter the 6-digit code sent to your email</Text>

          <TextInput style={[styles.input, { fontSize: 24, textAlign: 'center', letterSpacing: 8, fontFamily: 'Courier', marginBottom: Spacing.md }]}
            value={code} onChangeText={setCode} maxLength={6} keyboardType="number-pad" placeholder="000000"
            placeholderTextColor={colors.text4} autoFocus />

          <TouchableOpacity style={styles.btnPrimary} onPress={confirmEmailMFA}>
            <Text style={styles.btnPrimaryText}>Confirm & Enable</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btnGhost, { marginTop: Spacing.sm }]} onPress={() => setSetupStep(null)}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Main View ──
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        {/* MFA Status */}
        <View style={[styles.card, {
          backgroundColor: mfaStatus?.enabled ? colors.greenLight : colors.redLight,
          borderColor: mfaStatus?.enabled ? colors.green : colors.red,
        }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ fontSize: 28 }}>{mfaStatus?.enabled ? '✅' : '⚠️'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ ...Fonts.semibold, fontSize: 16, color: mfaStatus?.enabled ? colors.green : colors.red }}>
                MFA {mfaStatus?.enabled ? 'Enabled' : 'Disabled'}
              </Text>
              <Text style={{ ...Fonts.caption, color: colors.text2 }}>
                {mfaStatus?.enabled
                  ? `Method: ${mfaStatus.method === 'email' ? 'Email' : 'Authenticator'} · ${mfaStatus.backupCodesRemaining} backup codes`
                  : 'Your account is not protected with 2FA'}
              </Text>
            </View>
          </View>
        </View>

        {/* Setup or Manage */}
        {mfaStatus?.enabled ? (
          <View style={styles.card}>
            <TouchableOpacity style={styles.listItem} onPress={handleDisable}>
              <Text style={{ ...Fonts.medium, color: colors.red }}>🔓 Disable MFA</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            <TouchableOpacity style={styles.listItem} onPress={startTOTP}>
              <View>
                <Text style={{ ...Fonts.medium, color: colors.text }}>📱 Google Authenticator / Authy</Text>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>Time-based codes (recommended)</Text>
              </View>
              <Text style={{ color: colors.blue, fontSize: 16 }}>›</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.listItem, { borderBottomWidth: 0 }]} onPress={startEmailMFA}>
              <View>
                <Text style={{ ...Fonts.medium, color: colors.text }}>📧 Email Verification</Text>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>Codes sent to your email</Text>
              </View>
              <Text style={{ color: colors.blue, fontSize: 16 }}>›</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Trusted Devices */}
        <Text style={styles.sectionTitle}>Trusted Devices ({devices.length})</Text>
        <View style={styles.card}>
          {devices.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyText}>No trusted devices</Text></View>
          ) : devices.map((d, i) => (
            <View key={d.id} style={[styles.listItem, i === devices.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ ...Fonts.medium, color: colors.text }}>{d.name || 'Unknown'}</Text>
                <Text style={{ ...Fonts.caption, color: colors.text4 }}>
                  {d.ip} · Expires {new Date(d.expiresAt).toLocaleDateString()}
                </Text>
              </View>
              <TouchableOpacity onPress={() => revokeDevice(d.id)}>
                <Text style={{ ...Fonts.caption, color: colors.red }}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {/* Login History */}
        <Text style={styles.sectionTitle}>Recent Logins</Text>
        <View style={styles.card}>
          {history.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyText}>No login history</Text></View>
          ) : history.slice(0, 10).map((h, i) => (
            <View key={h.id || i} style={[styles.listItem, i === Math.min(9, history.length - 1) && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{
                    width: 8, height: 8, borderRadius: 4,
                    backgroundColor: h.result === 'success' ? colors.green : h.result === 'failed' ? colors.red : colors.yellow,
                  }} />
                  <Text style={{ ...Fonts.medium, color: colors.text }}>{h.device || 'Unknown'}</Text>
                </View>
                <Text style={{ ...Fonts.caption, color: colors.text4 }}>
                  {new Date(h.timestamp).toLocaleString()} · {h.ip}
                  {h.mfaMethod ? ` · ${h.mfaMethod}` : ''}
                </Text>
              </View>
              {h.riskScore >= 50 && (
                <View style={{ backgroundColor: colors.redLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ ...Fonts.caption, color: colors.red }}>High risk</Text>
                </View>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
