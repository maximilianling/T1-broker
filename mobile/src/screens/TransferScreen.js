// ================================================================
// T1 BROKER MOBILE — TRANSFERS SCREEN
// ================================================================
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, SafeAreaView, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';
import api from '../services/api';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HISTORY = [
  { id: 1, type: 'deposit', amount: 25000, account: '••••4521', status: 'completed', date: '2025-02-14' },
  { id: 2, type: 'withdrawal', amount: 5000, account: '••••4521', status: 'completed', date: '2025-02-10' },
  { id: 3, type: 'deposit', amount: 100000, account: 'Wire', status: 'completed', date: '2025-01-28' },
  { id: 4, type: 'withdrawal', amount: 10000, account: '••••4521', status: 'pending', date: '2025-02-15' },
];

export default function TransferScreen() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const balance = useStore(s => s.balance);

  const [tab, setTab] = useState('deposit'); // 'deposit' | 'withdraw'
  const [amount, setAmount] = useState('');

  async function handleSubmit() {
    const val = parseFloat(amount);
    if (!val || val <= 0) { Alert.alert('Invalid', 'Enter a valid amount'); return; }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    if (tab === 'deposit') {
      const res = await api.deposit(val, 'bank');
      if (res.error) Alert.alert('Failed', res.error);
      else Alert.alert('Deposit Submitted', `${fmt(val)} deposit is being processed.`);
    } else {
      if (val > (balance?.cashBalance || 45320)) {
        Alert.alert('Insufficient Funds', 'Withdrawal amount exceeds available balance');
        return;
      }
      const res = await api.withdraw(val, 'default');
      if (res.error) Alert.alert('Failed', res.error);
      else Alert.alert('Withdrawal Requested', `${fmt(val)} withdrawal requires dual authorization (24-48h).`);
    }
    setAmount('');
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        <Text style={[styles.title, { marginBottom: 4 }]}>Fund Transfers</Text>
        <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>Deposit and withdraw funds</Text>

        {/* Balance card */}
        <View style={[styles.card, { marginBottom: Spacing.lg }]}>
          <Text style={{ ...Fonts.caption, color: colors.text3 }}>Available Cash Balance</Text>
          <Text style={{ fontSize: 28, fontWeight: '800', color: colors.green, fontFamily: 'Courier' }}>
            {fmt(balance?.cashBalance || 45320)}
          </Text>
        </View>

        {/* Deposit / Withdraw Toggle */}
        <View style={{ flexDirection: 'row', marginBottom: Spacing.lg, gap: 8, backgroundColor: colors.bg3, padding: 4, borderRadius: Radius.md }}>
          {['deposit', 'withdraw'].map(t => (
            <TouchableOpacity key={t} onPress={() => { setTab(t); Haptics.selectionAsync(); }}
              style={{ flex: 1, paddingVertical: 12, borderRadius: Radius.sm, alignItems: 'center',
                backgroundColor: tab === t ? colors.card : 'transparent' }}>
              <Text style={{ ...Fonts.semibold, color: tab === t ? (t === 'deposit' ? colors.green : colors.red) : colors.text3 }}>
                {t === 'deposit' ? '↓ Deposit' : '↑ Withdraw'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Amount */}
        <View style={styles.card}>
          <Text style={styles.inputLabel}>AMOUNT (USD)</Text>
          <TextInput
            style={[styles.input, { fontSize: 28, fontFamily: 'Courier', fontWeight: '700', textAlign: 'center', marginBottom: Spacing.md }]}
            value={amount} onChangeText={setAmount}
            placeholder="0.00" placeholderTextColor={colors.text4} keyboardType="decimal-pad"
          />

          {/* Quick amounts */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: Spacing.md }}>
            {['1,000', '5,000', '10,000', '25,000'].map(q => (
              <TouchableOpacity key={q} onPress={() => { setAmount(q.replace(/,/g, '')); Haptics.selectionAsync(); }}
                style={{ flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.bg3, alignItems: 'center' }}>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>${q}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.inputLabel}>{tab === 'deposit' ? 'FROM' : 'TO'}</Text>
          <View style={[styles.input, { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: Spacing.md }]}>
            <Text style={{ fontSize: 18 }}>🏦</Text>
            <Text style={{ ...Fonts.regular, color: colors.text }}>Bank ••••4521 (Chase)</Text>
          </View>

          <TouchableOpacity
            style={[styles.btnPrimary, { backgroundColor: tab === 'deposit' ? colors.green : colors.red }]}
            onPress={handleSubmit}
          >
            <Text style={styles.btnPrimaryText}>
              {tab === 'deposit' ? 'Deposit Funds' : 'Request Withdrawal'}
            </Text>
          </TouchableOpacity>

          {tab === 'withdraw' && (
            <Text style={{ ...Fonts.caption, color: colors.text4, textAlign: 'center', marginTop: 8 }}>
              ⏱ Requires dual authorization (24-48h processing)
            </Text>
          )}
        </View>

        {/* History */}
        <Text style={styles.sectionTitle}>Transfer History</Text>
        <View style={styles.card}>
          {HISTORY.map((h, i, arr) => (
            <View key={h.id} style={[styles.listItem, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: h.type === 'deposit' ? colors.greenLight : colors.redLight,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Text style={{ fontSize: 16 }}>{h.type === 'deposit' ? '↓' : '↑'}</Text>
                </View>
                <View>
                  <Text style={{ ...Fonts.medium, color: colors.text, textTransform: 'capitalize' }}>{h.type}</Text>
                  <Text style={{ ...Fonts.caption, color: colors.text4 }}>{h.date} · {h.account}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ ...Fonts.mono, color: h.type === 'deposit' ? colors.green : colors.red }}>
                  {h.type === 'deposit' ? '+' : '-'}{fmt(h.amount)}
                </Text>
                <Text style={{
                  ...Fonts.caption, fontWeight: '600',
                  color: h.status === 'completed' ? colors.green : colors.yellow,
                }}>{h.status}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
