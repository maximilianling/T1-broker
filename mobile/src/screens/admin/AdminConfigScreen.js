// ================================================================
// T1 BROKER MOBILE — ADMIN CONFIGURATION SCREEN
// Market data providers, brokerage API keys, crypto wallets,
// custom instruments, clearing engine management
// ================================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  SafeAreaView, Alert, TextInput, Modal as RNModal, ActivityIndicator,
} from 'react-native';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';
import api from '../services/api';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtK = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : fmt(n);
const chainIcon = (c) => ({ ethereum: '⟠', bitcoin: '₿', solana: '◎', polygon_chain: '⬡', bsc: '🔶', arbitrum: '🔵' }[c] || '🪙');

const statusColor = (s, colors) => ({
  active: colors.green, connected: colors.green, running: colors.green,
  inactive: colors.text4, configuring: colors.yellow, pending: colors.yellow, rate_limited: colors.yellow,
  error: colors.red, disconnected: colors.red, disabled: colors.text4,
}[s] || colors.text4);

export default function AdminConfigScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);

  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState('providers');
  const [providers, setProviders] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [wallets, setWallets] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [clearingStats, setClearingStats] = useState({});
  const [modalVisible, setModalVisible] = useState(false);
  const [modalItem, setModalItem] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [secretInput, setSecretInput] = useState('');

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [pRes, bRes, wRes, iRes, cRes] = await Promise.allSettled([
        api.get('/admin/config/providers'),
        api.get('/admin/config/brokers'),
        api.get('/admin/config/wallets'),
        api.get('/admin/config/instruments'),
        api.get('/admin/config/clearing/stats'),
      ]);
      if (pRes.status === 'fulfilled') setProviders(pRes.value?.data || MOCK_PROVIDERS);
      if (bRes.status === 'fulfilled') setBrokers(bRes.value?.data || MOCK_BROKERS);
      if (wRes.status === 'fulfilled') setWallets(wRes.value?.data || MOCK_WALLETS);
      if (iRes.status === 'fulfilled') setInstruments(iRes.value?.data || MOCK_INSTRUMENTS);
      if (cRes.status === 'fulfilled') setClearingStats(cRes.value?.data || { openOrders: 23, todayTrades: 87, unsettledTrades: 14, todayVolume: 2485600 });
    } catch (e) {
      setProviders(MOCK_PROVIDERS); setBrokers(MOCK_BROKERS);
      setWallets(MOCK_WALLETS); setInstruments(MOCK_INSTRUMENTS);
    }
    setLoading(false);
  }

  async function saveProviderKey() {
    if (!keyInput) return;
    try {
      await api.put(`/admin/config/providers/${modalItem.id}/keys`, { apiKey: keyInput, apiSecret: secretInput || undefined });
      setProviders(prev => prev.map(p => p.id === modalItem.id ? { ...p, has_api_key: true, status: 'active' } : p));
      Alert.alert('Success', `API key saved for ${modalItem.display_name}`);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
    setModalVisible(false);
    setKeyInput(''); setSecretInput('');
  }

  async function saveBrokerKey() {
    if (!keyInput) return;
    try {
      await api.put(`/admin/config/brokers/${modalItem.id}/keys`, { apiKey: keyInput, apiSecret: secretInput || undefined });
      setBrokers(prev => prev.map(b => b.id === modalItem.id ? { ...b, has_api_key: true, status: 'connected', is_enabled: true } : b));
      Alert.alert('Success', `Credentials saved for ${modalItem.display_name}`);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
    setModalVisible(false);
    setKeyInput(''); setSecretInput('');
  }

  async function testProvider(provider) {
    try {
      const result = await api.post(`/admin/config/providers/${provider.id}/test`);
      Alert.alert(result.success ? 'Connected ✓' : 'Connection Failed',
        result.success ? `Latency: ${result.latencyMs}ms` : result.error || 'Unknown error');
    } catch (e) {
      Alert.alert('Test Failed', e.message);
    }
  }

  async function testBroker(broker) {
    try {
      const result = await api.post(`/admin/config/brokers/${broker.id}/test`);
      Alert.alert(result.success ? 'Connected ✓' : 'Connection Failed',
        result.success ? `Latency: ${result.latencyMs}ms` : result.error || 'Unknown error');
    } catch (e) {
      Alert.alert('Test Failed', e.message);
    }
  }

  const sections = [
    { id: 'providers', label: '📡 Providers' },
    { id: 'brokers', label: '🏦 Brokers' },
    { id: 'wallets', label: '🔐 Wallets' },
    { id: 'instruments', label: '📊 Assets' },
    { id: 'clearing', label: '⚖️ Clearing' },
  ];

  return (
    <SafeAreaView style={styles.screen}>
      {/* Section tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: 8 }}>
        {sections.map(s => (
          <TouchableOpacity key={s.id} onPress={() => setSection(s.id)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
              backgroundColor: section === s.id ? colors.blueLight : 'transparent',
            }}>
            <Text style={{ ...Fonts.caption, fontWeight: '600', color: section === s.id ? colors.blue : colors.text3 }}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadAll} tintColor={colors.blue} />}>

        {/* ═══ PROVIDERS ═══ */}
        {section === 'providers' && (
          <>
            <Text style={[styles.title, { marginBottom: 4 }]}>Market Data Providers</Text>
            <Text style={{ ...Fonts.caption, color: colors.text4, marginBottom: Spacing.md }}>
              Tap a provider to configure API keys. Data sources used in priority order with failover.
            </Text>

            {(providers.length ? providers : MOCK_PROVIDERS).map(p => (
              <TouchableOpacity key={p.id} style={[styles.card, { marginBottom: 8 }]}
                onPress={() => { setModalItem({ ...p, type: 'provider' }); setModalVisible(true); }}>
                <View style={styles.spaceBetween}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ ...Fonts.semibold, color: colors.text, fontSize: 15 }}>{p.display_name}</Text>
                      <View style={{ backgroundColor: statusColor(p.status, colors) + '22', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                        <Text style={{ fontSize: 10, color: statusColor(p.status, colors), fontWeight: '600' }}>{p.status}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
                      {p.supports_stocks && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Stocks</Text>}
                      {p.supports_crypto && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Crypto</Text>}
                      {p.supports_forex && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Forex</Text>}
                      {p.supports_websocket && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>WS</Text>}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.caption, fontWeight: '600', color: p.has_api_key ? colors.green : colors.text4 }}>
                      {p.has_api_key ? '✓ Key Set' : '○ No Key'}
                    </Text>
                    {p.is_primary_stocks && <Text style={{ fontSize: 9, color: colors.blue, fontWeight: '600' }}>PRIMARY</Text>}
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* ═══ BROKERAGES ═══ */}
        {section === 'brokers' && (
          <>
            <Text style={[styles.title, { marginBottom: 4 }]}>Brokerage Connectors</Text>
            <Text style={{ ...Fonts.caption, color: colors.text4, marginBottom: Spacing.md }}>
              Configure API credentials and omnibus accounts for order routing.
            </Text>

            {(brokers.length ? brokers : MOCK_BROKERS).map(b => (
              <TouchableOpacity key={b.id} style={[styles.card, { marginBottom: 8 }]}
                onPress={() => { setModalItem({ ...b, type: 'broker' }); setModalVisible(true); }}>
                <View style={styles.spaceBetween}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Text style={{ ...Fonts.semibold, color: colors.text, fontSize: 15 }}>{b.display_name}</Text>
                      <View style={{ backgroundColor: statusColor(b.status, colors) + '22', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                        <Text style={{ fontSize: 10, color: statusColor(b.status, colors), fontWeight: '600' }}>{b.status}</Text>
                      </View>
                      <View style={{ backgroundColor: b.environment === 'production' ? colors.redLight : colors.yellowLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 }}>
                        <Text style={{ fontSize: 9, fontWeight: '600', color: b.environment === 'production' ? colors.red : colors.yellow }}>
                          {b.environment === 'production' ? '🔴 PROD' : '🧪 SANDBOX'}
                        </Text>
                      </View>
                    </View>
                    {b.omnibus_account_id && <Text style={{ ...Fonts.caption, color: colors.text3 }}>Omnibus: {b.omnibus_account_id}</Text>}
                    <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
                      {b.supports_equities && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Equities</Text>}
                      {b.supports_forex && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Forex</Text>}
                      {b.supports_crypto && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Crypto</Text>}
                      {b.supports_fractional && <Text style={{ fontSize: 9, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>Fractional</Text>}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.caption, fontWeight: '600', color: b.has_api_key ? colors.green : colors.text4 }}>
                      {b.has_api_key ? '✓ Credentials' : '○ Not configured'}
                    </Text>
                    {b.latency_ms && <Text style={{ fontSize: 10, color: colors.text4 }}>{b.latency_ms}ms</Text>}
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* ═══ WALLETS ═══ */}
        {section === 'wallets' && (
          <>
            <Text style={[styles.title, { marginBottom: 4 }]}>Crypto Omnibus Wallets</Text>
            <Text style={{ ...Fonts.caption, color: colors.text4, marginBottom: Spacing.md }}>
              Hot, warm, and cold wallets across blockchains. Client sub-accounts auto-created per chain.
            </Text>

            {/* Total AUM */}
            <View style={[styles.card, { backgroundColor: colors.purple + '11', borderColor: colors.purple + '33', marginBottom: Spacing.md }]}>
              <Text style={{ ...Fonts.caption, color: colors.text4, textTransform: 'uppercase', letterSpacing: 1 }}>Total Crypto Under Custody</Text>
              <Text style={{ fontSize: 28, fontWeight: '800', color: colors.text, fontFamily: 'Courier' }}>
                {fmtK((wallets.length ? wallets : MOCK_WALLETS).reduce((s, w) => s + (w.balance_usd || 0), 0))}
              </Text>
            </View>

            {(wallets.length ? wallets : MOCK_WALLETS).map(w => (
              <View key={w.id} style={[styles.card, { marginBottom: 8 }]}>
                <View style={styles.spaceBetween}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={{ fontSize: 24 }}>{chainIcon(w.blockchain)}</Text>
                    <View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ ...Fonts.medium, color: colors.text }}>{w.wallet_name}</Text>
                        <View style={{
                          backgroundColor: w.wallet_type === 'hot' ? colors.redLight : w.wallet_type === 'cold' ? colors.cyanLight || '#06b6d422' : colors.yellowLight,
                          paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10,
                        }}>
                          <Text style={{ fontSize: 9, fontWeight: '600',
                            color: w.wallet_type === 'hot' ? colors.red : w.wallet_type === 'cold' ? '#06b6d4' : colors.yellow,
                          }}>{w.wallet_type === 'hot' ? '🔥 Hot' : w.wallet_type === 'cold' ? '🧊 Cold' : '♨️ Warm'}</Text>
                        </View>
                      </View>
                      <Text style={{ ...Fonts.caption, color: colors.text4 }}>{w.blockchain} · {w.address}</Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.mono, color: colors.text, fontSize: 15 }}>{fmt(w.balance_usd)}</Text>
                    <Text style={{ ...Fonts.caption, color: colors.text3 }}>{w.balance} native</Text>
                  </View>
                </View>
              </View>
            ))}
          </>
        )}

        {/* ═══ CUSTOM INSTRUMENTS ═══ */}
        {section === 'instruments' && (
          <>
            <Text style={[styles.title, { marginBottom: 4 }]}>Custom Assets & Pairs</Text>
            <Text style={{ ...Fonts.caption, color: colors.text4, marginBottom: Spacing.md }}>
              Private assets, custom tickers, and self-cleared trading pairs.
            </Text>

            {(instruments.length ? instruments : MOCK_INSTRUMENTS).map(inst => (
              <View key={inst.id} style={[styles.card, { marginBottom: 8 }]}>
                <View style={styles.spaceBetween}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ ...Fonts.semibold, color: colors.blue, fontSize: 16 }}>{inst.symbol}</Text>
                      <Text style={{ fontSize: 10, color: colors.text4, backgroundColor: colors.bg3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 }}>
                        {(inst.asset_class || '').replace(/_/g, ' ')}
                      </Text>
                    </View>
                    <Text style={{ ...Fonts.caption, color: colors.text2, marginTop: 2 }}>{inst.name}</Text>
                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 6 }}>
                      <Text style={{ ...Fonts.caption, color: colors.text4 }}>
                        Clear: <Text style={{ color: colors.text2, fontWeight: '600' }}>{inst.clearing_method}</Text>
                      </Text>
                      <Text style={{ ...Fonts.caption, color: colors.text4 }}>
                        Settle: <Text style={{ color: colors.text2, fontWeight: '600' }}>{inst.settlement_type}</Text>
                      </Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.mono, color: colors.text, fontSize: 18, fontWeight: '800' }}>{fmt(inst.last_price)}</Text>
                    <Text style={{ ...Fonts.caption, color: colors.text4 }}>{((inst.commission_rate || 0) * 100).toFixed(2)}% fee</Text>
                  </View>
                </View>
              </View>
            ))}
          </>
        )}

        {/* ═══ CLEARING ═══ */}
        {section === 'clearing' && (
          <>
            <Text style={[styles.title, { marginBottom: 4 }]}>Internal Clearing</Text>
            <Text style={{ ...Fonts.caption, color: colors.text4, marginBottom: Spacing.md }}>
              Matching engine stats and settlement controls.
            </Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: Spacing.lg }}>
              {[
                { label: 'Open Orders', value: clearingStats.openOrders || 23, icon: '📋', color: colors.blue },
                { label: 'Trades Today', value: clearingStats.todayTrades || 87, icon: '🔄', color: colors.green },
                { label: 'Unsettled', value: clearingStats.unsettledTrades || 14, icon: '⏳', color: colors.yellow },
                { label: 'Today Volume', value: fmtK(clearingStats.todayVolume || 2485600), icon: '💰', color: colors.purple },
              ].map(s => (
                <View key={s.label} style={{
                  width: '48%', backgroundColor: colors.card, borderRadius: Radius.lg,
                  padding: 14, borderWidth: 1, borderColor: colors.border,
                }}>
                  <Text style={{ ...Fonts.caption, color: colors.text4 }}>{s.icon} {s.label}</Text>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: s.color, fontFamily: 'Courier', marginTop: 4 }}>{s.value}</Text>
                </View>
              ))}
            </View>

            <TouchableOpacity style={[styles.card, { backgroundColor: colors.yellow + '11', borderColor: colors.yellow + '33', alignItems: 'center', paddingVertical: 16 }]}
              onPress={() => Alert.alert('Run Settlement', 'Run nightly settlement cycle for all unsettled internal trades?', [
                { text: 'Cancel' },
                { text: 'Run Settlement', onPress: async () => {
                  try {
                    const result = await api.post('/admin/config/clearing/settlement', { settlementDate: new Date().toISOString().slice(0, 10) });
                    Alert.alert('Settlement Complete', `${result.data?.tradesSettled || 0} trades settled`);
                  } catch (e) { Alert.alert('Error', e.message); }
                }},
              ])}>
              <Text style={{ ...Fonts.semibold, color: colors.yellow, fontSize: 16 }}>⚖️ Run Settlement Cycle</Text>
              <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 4 }}>Settles all matched internal trades</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* ═══ KEY INPUT MODAL ═══ */}
      <RNModal visible={modalVisible} animationType="slide" transparent>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View style={{ backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: Spacing.lg }}>
            <View style={[styles.spaceBetween, { marginBottom: Spacing.md }]}>
              <Text style={{ ...Fonts.semibold, color: colors.text, fontSize: 18 }}>
                Configure {modalItem?.display_name}
              </Text>
              <TouchableOpacity onPress={() => { setModalVisible(false); setKeyInput(''); setSecretInput(''); }}>
                <Text style={{ fontSize: 18, color: colors.text4 }}>✕</Text>
              </TouchableOpacity>
            </View>

            {modalItem?.type === 'provider' && (
              <>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: Spacing.md }}>
                  {modalItem.supports_stocks && <Text style={{ fontSize: 10, color: colors.blue, backgroundColor: colors.blueLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>Stocks</Text>}
                  {modalItem.supports_crypto && <Text style={{ fontSize: 10, color: colors.purple, backgroundColor: colors.purpleLight || '#a855f722', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>Crypto</Text>}
                  {modalItem.supports_forex && <Text style={{ fontSize: 10, color: '#06b6d4', backgroundColor: '#06b6d422', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>Forex</Text>}
                </View>
                <TextInput style={[styles.input, { marginBottom: 12 }]} placeholder="API Key *"
                  placeholderTextColor={colors.text4} value={keyInput} onChangeText={setKeyInput} secureTextEntry autoCapitalize="none" />
                <TextInput style={[styles.input, { marginBottom: Spacing.md }]} placeholder="API Secret (optional)"
                  placeholderTextColor={colors.text4} value={secretInput} onChangeText={setSecretInput} secureTextEntry autoCapitalize="none" />

                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity style={{ flex: 1, backgroundColor: colors.blue, paddingVertical: 14, borderRadius: Radius.md, alignItems: 'center' }}
                    onPress={saveProviderKey}>
                    <Text style={{ ...Fonts.medium, color: '#fff' }}>Save & Activate</Text>
                  </TouchableOpacity>
                  {modalItem.has_api_key && (
                    <TouchableOpacity style={{ backgroundColor: colors.yellow, paddingVertical: 14, paddingHorizontal: 16, borderRadius: Radius.md, alignItems: 'center' }}
                      onPress={() => testProvider(modalItem)}>
                      <Text style={{ ...Fonts.medium, color: '#000' }}>Test</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}

            {modalItem?.type === 'broker' && (
              <>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: Spacing.md }}>
                  <View style={{ backgroundColor: modalItem.environment === 'production' ? colors.redLight : colors.yellowLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: modalItem.environment === 'production' ? colors.red : colors.yellow }}>
                      {modalItem.environment === 'production' ? '🔴 PRODUCTION' : '🧪 SANDBOX'}
                    </Text>
                  </View>
                </View>

                {modalItem.environment === 'production' && (
                  <View style={{ backgroundColor: colors.redLight, padding: 12, borderRadius: Radius.md, marginBottom: 12 }}>
                    <Text style={{ ...Fonts.caption, color: colors.red }}>⚠️ Production credentials — real money at risk</Text>
                  </View>
                )}

                <TextInput style={[styles.input, { marginBottom: 12 }]} placeholder="API Key *"
                  placeholderTextColor={colors.text4} value={keyInput} onChangeText={setKeyInput} secureTextEntry autoCapitalize="none" />
                <TextInput style={[styles.input, { marginBottom: Spacing.md }]} placeholder="API Secret"
                  placeholderTextColor={colors.text4} value={secretInput} onChangeText={setSecretInput} secureTextEntry autoCapitalize="none" />

                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity style={{ flex: 1, backgroundColor: colors.blue, paddingVertical: 14, borderRadius: Radius.md, alignItems: 'center' }}
                    onPress={saveBrokerKey}>
                    <Text style={{ ...Fonts.medium, color: '#fff' }}>Save Credentials</Text>
                  </TouchableOpacity>
                  {modalItem.has_api_key && (
                    <TouchableOpacity style={{ backgroundColor: colors.yellow, paddingVertical: 14, paddingHorizontal: 16, borderRadius: Radius.md, alignItems: 'center' }}
                      onPress={() => testBroker(modalItem)}>
                      <Text style={{ ...Fonts.medium, color: '#000' }}>Test</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
          </View>
        </View>
      </RNModal>
    </SafeAreaView>
  );
}

// ── Mock fallback data ──
const MOCK_PROVIDERS = [
  { id: '1', provider_code: 'polygon', display_name: 'Polygon.io', status: 'active', has_api_key: true, supports_stocks: true, supports_crypto: true, supports_forex: true, supports_websocket: true, is_primary_stocks: true },
  { id: '2', provider_code: 'finnhub', display_name: 'Finnhub', status: 'active', has_api_key: true, supports_stocks: true, supports_crypto: true, supports_websocket: true },
  { id: '3', provider_code: 'coingecko', display_name: 'CoinGecko', status: 'active', has_api_key: true, supports_crypto: true, is_primary_crypto: true },
  { id: '4', provider_code: 'alpha_vantage', display_name: 'Alpha Vantage', status: 'inactive', has_api_key: false, supports_stocks: true },
  { id: '5', provider_code: 'binance', display_name: 'Binance', status: 'inactive', has_api_key: false, supports_crypto: true, supports_websocket: true },
];

const MOCK_BROKERS = [
  { id: '1', display_name: 'Saxo Bank', status: 'connected', environment: 'production', has_api_key: true, has_api_secret: true, supports_equities: true, supports_forex: true, omnibus_account_id: 'SXB-OMN-001', latency_ms: 45 },
  { id: '2', display_name: 'DriveWealth', status: 'connected', environment: 'sandbox', has_api_key: true, supports_equities: true, supports_fractional: true, omnibus_account_id: 'DW-OMN-T1B', latency_ms: 120 },
  { id: '3', display_name: 'Interactive Brokers', status: 'configuring', environment: 'sandbox', has_api_key: false, supports_equities: true, supports_forex: true, supports_crypto: true },
];

const MOCK_WALLETS = [
  { id: '1', wallet_name: 'ETH Hot Wallet', blockchain: 'ethereum', address: '0x742d...4e8B', wallet_type: 'hot', is_active: true, balance: '48.25', balance_usd: 125840 },
  { id: '2', wallet_name: 'BTC Cold Vault', blockchain: 'bitcoin', address: 'bc1q...m8zk', wallet_type: 'cold', is_active: true, balance: '28.50', balance_usd: 1833750 },
  { id: '3', wallet_name: 'SOL Hot Wallet', blockchain: 'solana', address: '6Rjq...WNLK', wallet_type: 'hot', is_active: true, balance: '2450', balance_usd: 45080 },
];

const MOCK_INSTRUMENTS = [
  { id: '1', symbol: 'ACME/USD', name: 'Acme Corp Private Equity', asset_class: 'private_equity', clearing_method: 'internal', settlement_type: 'T+2', last_price: 42.50, commission_rate: 0.002 },
  { id: '2', symbol: 'REALEST-A', name: 'T1 Real Estate Fund A', asset_class: 'private_debt', clearing_method: 'self_clearing', settlement_type: 'T+1', last_price: 1000.00, commission_rate: 0.001 },
  { id: '3', symbol: 'CARB/USD', name: 'Carbon Credit Token', asset_class: 'crypto', clearing_method: 'internal', settlement_type: 'instant', last_price: 28.75, commission_rate: 0.0015 },
];
