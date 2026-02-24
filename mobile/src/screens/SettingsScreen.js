// ================================================================
// T1 BROKER MOBILE — SETTINGS SCREEN
// ================================================================
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, SafeAreaView, Alert } from 'react-native';
import { useStore } from '../services/store';
import { useBiometric } from '../hooks/useBiometric';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';

function SettingRow({ icon, title, subtitle, right, onPress, last }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!onPress}
      style={{
        flexDirection: 'row', alignItems: 'center', paddingVertical: 14,
        borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border,
      }}
    >
      <Text style={{ fontSize: 20, marginRight: 14, width: 28, textAlign: 'center' }}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ ...Fonts.medium, color: colors.text }}>{title}</Text>
        {subtitle && <Text style={{ ...Fonts.caption, color: colors.text3, marginTop: 1 }}>{subtitle}</Text>}
      </View>
      {right || (onPress && <Text style={{ color: colors.text4, fontSize: 16 }}>›</Text>)}
    </TouchableOpacity>
  );
}

export default function SettingsScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const user = useStore(s => s.user);
  const logout = useStore(s => s.logout);
  const setTheme = useStore(s => s.setTheme);
  const { available: bioAvail, enabled: bioEnabled, label: bioLabel, icon: bioIcon, toggle: bioToggle } = useBiometric();

  function handleLogout() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => logout() },
    ]);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        <Text style={[styles.title, { marginBottom: Spacing.lg }]}>Settings</Text>

        {/* Profile Card */}
        <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
          <View style={{
            width: 56, height: 56, borderRadius: 28,
            backgroundColor: colors.blueLight, alignItems: 'center', justifyContent: 'center',
          }}>
            <Text style={{ color: colors.blue, fontWeight: '700', fontSize: 20 }}>
              {(user?.name || 'U').substring(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ ...Fonts.semibold, color: colors.text, fontSize: 16 }}>{user?.name || 'User'}</Text>
            <Text style={{ ...Fonts.caption, color: colors.text3 }}>{user?.email || '—'}</Text>
            <Text style={{ ...Fonts.caption, color: colors.blue, marginTop: 2, textTransform: 'capitalize' }}>{user?.role || 'client'}</Text>
          </View>
        </View>

        {/* Security Section */}
        <Text style={styles.sectionTitle}>Security</Text>
        <View style={styles.card}>
          <SettingRow
            icon="🔐"
            title="Two-Factor Authentication"
            subtitle="Manage MFA, backup codes, trusted devices"
            onPress={() => navigation.navigate('Security')}
          />
          {bioAvail && (
            <SettingRow
              icon={bioIcon}
              title={`${bioLabel} Login`}
              subtitle={bioEnabled ? 'Enabled — quick sign-in' : 'Enable for faster access'}
              right={
                <Switch value={bioEnabled} onValueChange={bioToggle}
                  trackColor={{ true: colors.blue, false: colors.bg3 }} thumbColor="#fff" />
              }
            />
          )}
          <SettingRow icon="🔑" title="Change Password" onPress={() => Alert.alert('Change Password', 'Navigate to password reset flow')} />
          <SettingRow icon="📋" title="Login History" subtitle="View recent sign-in activity"
            onPress={() => navigation.navigate('Security')} last />
        </View>

        {/* Preferences */}
        <Text style={styles.sectionTitle}>Preferences</Text>
        <View style={styles.card}>
          <SettingRow
            icon="🌙"
            title="Dark Mode"
            right={
              <Switch value={theme === 'dark'} onValueChange={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                trackColor={{ true: colors.blue, false: colors.bg3 }} thumbColor="#fff" />
            }
          />
          <SettingRow icon="🔔" title="Push Notifications" subtitle="Order fills, price alerts, security"
            right={<Switch value={true} trackColor={{ true: colors.blue, false: colors.bg3 }} thumbColor="#fff" />} />
          <SettingRow icon="💱" title="Default Currency" subtitle="USD"
            onPress={() => Alert.alert('Currency', 'Currency selection')} last />
        </View>

        {/* Trading */}
        <Text style={styles.sectionTitle}>Trading</Text>
        <View style={styles.card}>
          <SettingRow icon="📊" title="Default Order Type" subtitle="Market"
            onPress={() => Alert.alert('Order Type', 'Select default order type')} />
          <SettingRow icon="🔢" title="Default Quantity" subtitle="Not set"
            onPress={() => Alert.alert('Quantity', 'Set default trade quantity')} />
          <SettingRow icon="⚡" title="Order Confirmations" subtitle="Require preview before submit"
            right={<Switch value={true} trackColor={{ true: colors.blue, false: colors.bg3 }} thumbColor="#fff" />}
            last />
        </View>

        {/* About */}
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <SettingRow icon="ℹ️" title="App Version" subtitle="1.0.0 (Build 1)" />
          <SettingRow icon="📄" title="Terms of Service" onPress={() => {}} />
          <SettingRow icon="🔒" title="Privacy Policy" onPress={() => {}} />
          <SettingRow icon="📧" title="Contact Support" subtitle="support@t1broker.com"
            onPress={() => {}} last />
        </View>

        {/* Logout */}
        <TouchableOpacity style={[styles.btnDanger, { marginTop: Spacing.lg }]} onPress={handleLogout}>
          <Text style={styles.btnDangerText}>Sign Out</Text>
        </TouchableOpacity>

        <Text style={{ ...Fonts.caption, color: colors.text4, textAlign: 'center', marginTop: Spacing.lg }}>
          🔒 End-to-end encrypted · Biometric secured
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
