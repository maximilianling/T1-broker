// ================================================================
// T1 BROKER MOBILE — MARKETS SCREEN
// ================================================================
import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, SafeAreaView } from 'react-native';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';
import api from '../services/api';

const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
const fmtPct = (n) => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + '%';

const INDICES = [
  { name: 'S&P 500', value: 5024, change: 0.67 }, { name: 'NASDAQ', value: 17842, change: 1.12 },
  { name: 'DOW', value: 38994, change: 0.33 }, { name: 'BTC/USD', value: 97842, change: 1.87 },
  { name: 'EUR/USD', value: 1.0842, change: -0.12 }, { name: 'Gold', value: 2042, change: 0.45 },
];

const MOVERS = [
  { symbol: 'SMCI', name: 'Super Micro Computer', price: 875.50, change: 12.4, volume: '45.2M' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 875.28, change: 4.67, volume: '38.1M' },
  { symbol: 'ARM', name: 'Arm Holdings', price: 148.90, change: 3.88, volume: '12.5M' },
  { symbol: 'META', name: 'Meta Platforms', price: 485.20, change: 2.45, volume: '22.8M' },
  { symbol: 'TSLA', name: 'Tesla Inc.', price: 248.42, change: -2.15, volume: '89.3M' },
  { symbol: 'NFLX', name: 'Netflix', price: 582.10, change: -1.23, volume: '8.7M' },
  { symbol: 'COIN', name: 'Coinbase', price: 205.80, change: 5.67, volume: '15.4M' },
  { symbol: 'PLTR', name: 'Palantir', price: 22.45, change: -3.21, volume: '42.1M' },
];

export default function MarketsScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [tab, setTab] = useState('overview'); // 'overview' | 'movers' | 'sectors'

  async function handleSearch(q) {
    setSearch(q);
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const res = await api.searchInstruments(q);
    setResults(res?.data || []);
    setSearching(false);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        <Text style={[styles.title, { marginBottom: 4 }]}>Markets</Text>
        <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>Global market data</Text>

        {/* Search */}
        <View style={{ marginBottom: Spacing.md }}>
          <TextInput
            style={[styles.input, { paddingLeft: 40 }]}
            placeholder="Search stocks, ETFs, crypto..."
            placeholderTextColor={colors.text4}
            value={search}
            onChangeText={handleSearch}
            autoCapitalize="characters"
          />
          <Text style={{ position: 'absolute', left: 14, top: 14, fontSize: 16 }}>🔍</Text>
        </View>

        {/* Search Results */}
        {search.length >= 2 && (
          <View style={[styles.card, { marginBottom: Spacing.md }]}>
            {searching ? (
              <Text style={{ ...Fonts.caption, color: colors.text3, textAlign: 'center', padding: 16 }}>Searching...</Text>
            ) : results.length === 0 ? (
              <Text style={{ ...Fonts.caption, color: colors.text3, textAlign: 'center', padding: 16 }}>No results</Text>
            ) : results.slice(0, 8).map((r, i, arr) => (
              <TouchableOpacity key={r.symbol || i} style={[styles.listItem, i === arr.length - 1 && { borderBottomWidth: 0 }]}
                onPress={() => { setSearch(''); navigation.navigate('PlaceOrder', { symbol: r.symbol }); }}>
                <View>
                  <Text style={{ ...Fonts.semibold, color: colors.text }}>{r.symbol}</Text>
                  <Text style={{ ...Fonts.caption, color: colors.text3 }}>{r.name}</Text>
                </View>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>{r.exchange || r.assetClass}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Indices */}
        <Text style={styles.sectionTitle}>Global Indices</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.lg, marginHorizontal: -Spacing.md }}
          contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 10 }}>
          {INDICES.map(idx => (
            <View key={idx.name} style={{
              backgroundColor: colors.card, borderRadius: Radius.md, padding: 14,
              borderWidth: 1, borderColor: colors.cardBorder, minWidth: 140,
            }}>
              <Text style={{ ...Fonts.caption, color: colors.text3, marginBottom: 4 }}>{idx.name}</Text>
              <Text style={{ ...Fonts.monoLg, color: colors.text, fontSize: 16 }}>{fmt(idx.value)}</Text>
              <Text style={{ ...Fonts.caption, fontWeight: '600', color: idx.change >= 0 ? colors.green : colors.red }}>
                {fmtPct(idx.change)}
              </Text>
            </View>
          ))}
        </ScrollView>

        {/* Tabs */}
        <View style={{ flexDirection: 'row', marginBottom: Spacing.md, gap: 8 }}>
          {[['overview', 'Top Movers'], ['movers', 'Most Active'], ['sectors', 'Sectors']].map(([key, label]) => (
            <TouchableOpacity key={key} onPress={() => setTab(key)} style={{
              paddingVertical: 8, paddingHorizontal: 16, borderRadius: Radius.full,
              backgroundColor: tab === key ? colors.blueLight : 'transparent',
            }}>
              <Text style={{ ...Fonts.caption, fontWeight: '600', color: tab === key ? colors.blue : colors.text3 }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Movers Table */}
        <View style={styles.card}>
          {MOVERS.map((m, i, arr) => (
            <TouchableOpacity key={m.symbol} style={[styles.listItem, i === arr.length - 1 && { borderBottomWidth: 0 }]}
              onPress={() => navigation.navigate('PlaceOrder', { symbol: m.symbol })}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ ...Fonts.semibold, color: colors.text }}>{m.symbol}</Text>
                  <Text style={{ ...Fonts.caption, color: colors.text4 }}>{m.volume}</Text>
                </View>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>{m.name}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ ...Fonts.mono, color: colors.text }}>${fmt(m.price)}</Text>
                <Text style={{ ...Fonts.caption, fontWeight: '600', color: m.change >= 0 ? colors.green : colors.red }}>
                  {fmtPct(m.change)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
