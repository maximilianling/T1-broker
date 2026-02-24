// ================================================================
// T1 BROKER MOBILE — TRADING SCREEN (Home)
// ================================================================
import React, { useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  SafeAreaView, FlatList,
} from 'react-native';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + '%';

export default function TradingScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);

  const user = useStore(s => s.user);
  const balance = useStore(s => s.balance);
  const positions = useStore(s => s.positions);
  const orders = useStore(s => s.orders);
  const watchlist = useStore(s => s.watchlist);
  const loadPortfolio = useStore(s => s.loadPortfolio);
  const loadOrders = useStore(s => s.loadOrders);
  const loadWatchlist = useStore(s => s.loadWatchlist);
  const portfolioLoading = useStore(s => s.portfolioLoading);

  useEffect(() => {
    loadOrders();
    loadWatchlist();
  }, []);

  const onRefresh = useCallback(() => {
    loadPortfolio();
    loadOrders();
    loadWatchlist();
  }, []);

  const totalValue = balance?.totalValue || 142850.00;
  const dayChange = balance?.dayChange || 1234.56;
  const dayChangePct = balance?.dayChangePct || 0.87;
  const buyingPower = balance?.buyingPower || 45320.00;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={portfolioLoading} onRefresh={onRefresh} tintColor={colors.blue} />}
      >
        {/* Header */}
        <View style={[styles.spaceBetween, { marginBottom: 20 }]}>
          <View>
            <Text style={{ ...Fonts.caption, color: colors.text3 }}>
              Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}
            </Text>
            <Text style={{ ...Fonts.h2, color: colors.text }}>{user?.name?.split(' ')[0] || 'Trader'}</Text>
          </View>
          <TouchableOpacity
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.blueLight, alignItems: 'center', justifyContent: 'center' }}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={{ color: colors.blue, fontWeight: '700', fontSize: 14 }}>
              {(user?.name || 'U').substring(0, 2).toUpperCase()}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Portfolio Value Card */}
        <View style={[styles.card, { backgroundColor: colors.blue, borderColor: 'transparent' }]}>
          <Text style={{ ...Fonts.caption, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>Total Portfolio Value</Text>
          <Text style={{ fontSize: 32, fontWeight: '800', color: '#fff', fontFamily: 'Courier', marginBottom: 4 }}>
            {fmt(totalValue)}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 }}>
              <Text style={{ color: dayChange >= 0 ? '#86efac' : '#fca5a5', ...Fonts.caption, fontWeight: '600' }}>
                {dayChange >= 0 ? '↑' : '↓'} {fmt(Math.abs(dayChange))} ({fmtPct(dayChangePct)})
              </Text>
            </View>
            <Text style={{ ...Fonts.caption, color: 'rgba(255,255,255,0.5)' }}>Today</Text>
          </View>
        </View>

        {/* Quick Stats */}
        <View style={styles.statRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Buying Power</Text>
            <Text style={[styles.statValue, { fontSize: 16, color: colors.green }]}>{fmt(buyingPower)}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Positions</Text>
            <Text style={[styles.statValue, { fontSize: 16 }]}>{positions?.length || 0}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Open Orders</Text>
            <Text style={[styles.statValue, { fontSize: 16, color: colors.yellow }]}>
              {orders?.filter?.(o => o.status === 'pending' || o.status === 'open')?.length || 0}
            </Text>
          </View>
        </View>

        {/* Quick Trade Button */}
        <TouchableOpacity
          style={[styles.btnPrimary, { marginBottom: Spacing.lg, flexDirection: 'row', justifyContent: 'center', gap: 8 }]}
          onPress={() => navigation.navigate('PlaceOrder')}
        >
          <Text style={{ fontSize: 18 }}>⚡</Text>
          <Text style={styles.btnPrimaryText}>Quick Trade</Text>
        </TouchableOpacity>

        {/* Watchlist */}
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Watchlist</Text>
          <TouchableOpacity><Text style={{ color: colors.blue, ...Fonts.caption }}>Edit</Text></TouchableOpacity>
        </View>
        <View style={styles.card}>
          {(watchlist.length > 0 ? watchlist : [
            { symbol: 'AAPL', name: 'Apple Inc.', price: 189.84, change: 1.23 },
            { symbol: 'TSLA', name: 'Tesla Inc.', price: 248.42, change: -2.15 },
            { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 875.28, change: 4.67 },
            { symbol: 'AMZN', name: 'Amazon.com', price: 178.25, change: 0.89 },
            { symbol: 'MSFT', name: 'Microsoft', price: 415.50, change: -0.32 },
          ]).map((item, i, arr) => (
            <TouchableOpacity
              key={item.symbol}
              style={[styles.listItem, i === arr.length - 1 && { borderBottomWidth: 0 }]}
              onPress={() => navigation.navigate('PlaceOrder', { symbol: item.symbol })}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ ...Fonts.semibold, color: colors.text }}>{item.symbol}</Text>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>{item.name}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ ...Fonts.mono, color: colors.text }}>{fmt(item.price)}</Text>
                <Text style={{ ...Fonts.caption, color: (item.change || 0) >= 0 ? colors.green : colors.red, fontWeight: '600' }}>
                  {fmtPct(item.change)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Recent Orders */}
        <Text style={styles.sectionTitle}>Recent Orders</Text>
        <View style={styles.card}>
          {(orders.length > 0 ? orders.slice(0, 5) : [
            { id: '1', symbol: 'AAPL', side: 'buy', quantity: 10, price: 188.50, status: 'filled', type: 'market' },
            { id: '2', symbol: 'TSLA', side: 'sell', quantity: 5, price: 250.00, status: 'pending', type: 'limit' },
            { id: '3', symbol: 'NVDA', side: 'buy', quantity: 3, price: 870.00, status: 'filled', type: 'market' },
          ]).map((order, i, arr) => (
            <View key={order.id} style={[styles.listItem, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: order.side === 'buy' ? colors.greenLight : colors.redLight,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Text style={{ fontSize: 14 }}>{order.side === 'buy' ? '↗' : '↘'}</Text>
                </View>
                <View>
                  <Text style={{ ...Fonts.medium, color: colors.text }}>
                    {order.side.toUpperCase()} {order.quantity} {order.symbol}
                  </Text>
                  <Text style={{ ...Fonts.caption, color: colors.text3 }}>{order.type} · {fmt(order.price)}</Text>
                </View>
              </View>
              <View style={[
                styles.badge,
                order.status === 'filled' ? styles.badgeGreen : order.status === 'pending' ? styles.badgeYellow : styles.badgeRed,
                { paddingHorizontal: 8, paddingVertical: 3 }
              ]}>
                <Text style={{ ...Fonts.caption, fontWeight: '600', color: order.status === 'filled' ? colors.green : order.status === 'pending' ? colors.yellow : colors.red }}>
                  {order.status}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
