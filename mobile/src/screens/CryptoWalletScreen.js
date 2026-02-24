// ================================================================
// T1 BROKER MOBILE — CRYPTO WALLET SCREEN
// View omnibus sub-accounts, deposit addresses, withdraw, history
// ================================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  SafeAreaView, Alert, TextInput, Clipboard, ActivityIndicator,
} from 'react-native';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';
import api from '../services/api';

const CHAIN_ICONS = {
  bitcoin: '₿', ethereum: 'Ξ', solana: '◎', polygon_chain: '⬡',
  bsc: '🔶', avalanche: '🔺', arbitrum: '🔷', optimism: '🔴',
  tron: '⚡', litecoin: 'Ł', ripple: '✕', cardano: '₳', polkadot: '⦿',
};

export default function CryptoWalletScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);

  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('accounts'); // accounts | withdraw | history

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [accRes, txRes, tokRes] = await Promise.allSettled([
      api.get('/crypto/accounts'),
      api.get('/crypto/transactions?limit=30'),
      api.get('/crypto/tokens'),
    ]);
    if (accRes.status === 'fulfilled') setAccounts(accRes.value?.data || []);
    if (txRes.status === 'fulfilled') setTransactions(txRes.value?.data || []);
    if (tokRes.status === 'fulfilled') setTokens(tokRes.value?.data || []);
    setLoading(false);
  }

  async function createAccount(blockchain) {
    try {
      const result = await api.post('/crypto/accounts', { blockchain });
      if (result.error) { Alert.alert('Error', result.error); return; }
      Alert.alert('Account Created', `Your ${blockchain} deposit address is ready.`);
      load();
    } catch (e) { Alert.alert('Error', e.message); }
  }

  function copyAddress(address) {
    Clipboard.setString(address);
    Alert.alert('Copied', 'Deposit address copied to clipboard');
  }

  const [withdrawChain, setWithdrawChain] = useState('');
  const [withdrawAddr, setWithdrawAddr] = useState('');
  const [withdrawAmt, setWithdrawAmt] = useState('');

  async function submitWithdrawal() {
    if (!withdrawChain || !withdrawAddr || !withdrawAmt) {
      Alert.alert('Missing Fields', 'Fill in all withdrawal fields'); return;
    }
    Alert.alert('Confirm Withdrawal', `Withdraw ${withdrawAmt} from ${withdrawChain} to ${withdrawAddr.slice(0, 12)}...?`, [
      { text: 'Cancel' },
      { text: 'Confirm', onPress: async () => {
        try {
          const result = await api.post('/crypto/withdraw', {
            blockchain: withdrawChain, toAddress: withdrawAddr, amount: parseFloat(withdrawAmt),
          });
          if (result.error) { Alert.alert('Error', result.error); return; }
          Alert.alert('Submitted', 'Withdrawal request submitted for approval');
          setWithdrawChain(''); setWithdrawAddr(''); setWithdrawAmt('');
          load();
        } catch (e) { Alert.alert('Error', e.message); }
      }},
    ]);
  }

  const statusColor = (s) => ({
    confirmed: colors.green, active: colors.green,
    confirming: colors.yellow, pending: colors.yellow,
    failed: colors.red, cancelled: colors.red,
  }[s] || colors.text3);

  const availableChains = ['bitcoin', 'ethereum', 'solana', 'polygon_chain', 'bsc', 'avalanche', 'arbitrum'];
  const existingChains = accounts.map(a => a.blockchain);
  const missingChains = availableChains.filter(c => !existingChains.includes(c));

  return (
    <SafeAreaView style={styles.screen}>
      {/* Tab bar */}
      <View style={{ flexDirection: 'row', paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, gap: 8 }}>
        {[['accounts', '💰 Accounts'], ['withdraw', '📤 Withdraw'], ['history', '📋 History']].map(([id, label]) => (
          <TouchableOpacity key={id} onPress={() => setTab(id)}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
              backgroundColor: tab === id ? colors.blueLight : 'transparent' }}>
            <Text style={{ ...Fonts.caption, fontWeight: '600', color: tab === id ? colors.blue : colors.text3 }}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.blue} />}>

        {/* ── ACCOUNTS ── */}
        {tab === 'accounts' && (
          <>
            <Text style={[styles.title, { marginBottom: 4 }]}>Crypto Wallets</Text>
            <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>
              Receive crypto to your deposit addresses
            </Text>

            {accounts.map(acc => (
              <View key={acc.id} style={[styles.card, { marginBottom: 10 }]}>
                <View style={styles.spaceBetween}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={{ fontSize: 24 }}>{CHAIN_ICONS[acc.blockchain] || '🔗'}</Text>
                    <View>
                      <Text style={{ ...Fonts.semibold, color: colors.text, textTransform: 'capitalize' }}>{acc.blockchain.replace('_', ' ')}</Text>
                      <Text style={{ ...Fonts.caption, color: colors.text3 }}>via {acc.omnibus_name}</Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.monoLg, color: colors.text }}>{parseFloat(acc.balance || 0).toFixed(8)}</Text>
                    <Text style={{ ...Fonts.caption, color: acc.locked_balance > 0 ? colors.yellow : colors.text4 }}>
                      {acc.locked_balance > 0 ? `🔒 ${parseFloat(acc.locked_balance).toFixed(6)}` : 'Available'}
                    </Text>
                  </View>
                </View>

                {/* Deposit address */}
                <TouchableOpacity onPress={() => copyAddress(acc.deposit_address)}
                  style={{ marginTop: 12, backgroundColor: colors.bg3, borderRadius: 8, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ flex: 1, ...Fonts.mono, fontSize: 10, color: colors.text2 }} numberOfLines={1} ellipsizeMode="middle">
                    {acc.deposit_address}
                  </Text>
                  <Text style={{ color: colors.blue, fontSize: 12 }}>📋</Text>
                </TouchableOpacity>
                <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 4 }}>Tap to copy deposit address</Text>
              </View>
            ))}

            {/* Add new chains */}
            {missingChains.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { marginTop: Spacing.md }]}>Add Blockchain</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {missingChains.map(chain => (
                    <TouchableOpacity key={chain} onPress={() => createAccount(chain)}
                      style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: Radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
                      <Text style={{ ...Fonts.caption, color: colors.blue }}>
                        {CHAIN_ICONS[chain] || '🔗'} {chain.replace('_', ' ')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </>
        )}

        {/* ── WITHDRAW ── */}
        {tab === 'withdraw' && (
          <>
            <Text style={[styles.title, { marginBottom: Spacing.md }]}>Withdraw Crypto</Text>

            <View style={styles.card}>
              <Text style={{ ...Fonts.caption, color: colors.text3, marginBottom: 4 }}>Blockchain</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: Spacing.md }}>
                {accounts.map(acc => (
                  <TouchableOpacity key={acc.blockchain} onPress={() => setWithdrawChain(acc.blockchain)}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
                      backgroundColor: withdrawChain === acc.blockchain ? colors.blueLight : colors.bg3,
                    }}>
                    <Text style={{ ...Fonts.caption, color: withdrawChain === acc.blockchain ? colors.blue : colors.text3 }}>
                      {CHAIN_ICONS[acc.blockchain]} {acc.blockchain.replace('_', ' ')} ({parseFloat(acc.available_balance || 0).toFixed(6)})
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={{ ...Fonts.caption, color: colors.text3, marginBottom: 4 }}>Destination Address</Text>
              <TextInput style={[styles.input, { marginBottom: Spacing.md }]}
                placeholder="Paste wallet address" placeholderTextColor={colors.text4}
                value={withdrawAddr} onChangeText={setWithdrawAddr} autoCapitalize="none" />

              <Text style={{ ...Fonts.caption, color: colors.text3, marginBottom: 4 }}>Amount</Text>
              <TextInput style={[styles.input, { marginBottom: Spacing.md }]}
                placeholder="0.00" placeholderTextColor={colors.text4}
                value={withdrawAmt} onChangeText={setWithdrawAmt} keyboardType="decimal-pad" />

              <TouchableOpacity onPress={submitWithdrawal}
                style={{ backgroundColor: colors.blue, paddingVertical: 14, borderRadius: Radius.md, alignItems: 'center' }}>
                <Text style={{ ...Fonts.semibold, color: '#fff' }}>Submit Withdrawal</Text>
              </TouchableOpacity>

              <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 8, textAlign: 'center' }}>
                Withdrawals require admin approval
              </Text>
            </View>
          </>
        )}

        {/* ── HISTORY ── */}
        {tab === 'history' && (
          <>
            <Text style={[styles.title, { marginBottom: Spacing.md }]}>Transaction History</Text>
            {transactions.length === 0 ? (
              <View style={[styles.card, styles.center, { paddingVertical: 40 }]}>
                <Text style={{ fontSize: 36, marginBottom: 8 }}>📭</Text>
                <Text style={{ ...Fonts.medium, color: colors.text3 }}>No transactions yet</Text>
              </View>
            ) : transactions.map(tx => (
              <View key={tx.id} style={[styles.card, { marginBottom: 8 }]}>
                <View style={styles.spaceBetween}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={{ fontSize: 20 }}>
                      {tx.tx_type === 'deposit' ? '📥' : tx.tx_type === 'withdrawal' ? '📤' : '🔄'}
                    </Text>
                    <View>
                      <Text style={{ ...Fonts.medium, color: colors.text, textTransform: 'capitalize' }}>{tx.tx_type}</Text>
                      <Text style={{ ...Fonts.caption, color: colors.text3 }}>{tx.blockchain?.replace('_', ' ')}</Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.mono, color: tx.tx_type === 'deposit' ? colors.green : colors.text }}>
                      {tx.tx_type === 'deposit' ? '+' : '-'}{parseFloat(tx.amount || 0).toFixed(8)}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusColor(tx.status) }} />
                      <Text style={{ ...Fonts.caption, color: statusColor(tx.status) }}>{tx.status}</Text>
                    </View>
                  </View>
                </View>
                {tx.tx_hash && (
                  <TouchableOpacity onPress={() => copyAddress(tx.tx_hash)}
                    style={{ marginTop: 8, flexDirection: 'row', gap: 4 }}>
                    <Text style={{ ...Fonts.mono, fontSize: 9, color: colors.text4 }} numberOfLines={1}>
                      TX: {tx.tx_hash}
                    </Text>
                  </TouchableOpacity>
                )}
                <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 4 }}>
                  {new Date(tx.created_at).toLocaleString()}
                  {tx.confirmations !== undefined ? ` · ${tx.confirmations}/${tx.required_confirmations} confirms` : ''}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
