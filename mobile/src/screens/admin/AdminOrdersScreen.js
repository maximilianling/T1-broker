// ================================================================
// T1 BROKER MOBILE — ADMIN ORDERS SCREEN
// All orders, filtering, approve/reject, details
// ================================================================
import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, SafeAreaView, Alert } from 'react-native';
import { useStore } from '../../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../../utils/theme';
import api from '../../services/api';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });

const MOCK_ORDERS = [
  { id: 'ORD-001', client: 'Sarah Chen', symbol: 'AAPL', side: 'buy', type: 'market', quantity: 100, price: 189.84, status: 'filled', total: 18984, time: '2025-02-16T09:32:00Z' },
  { id: 'ORD-002', client: 'Marcus Johnson', symbol: 'NVDA', side: 'sell', type: 'limit', quantity: 25, price: 880.00, status: 'pending', total: 22000, time: '2025-02-16T10:15:00Z' },
  { id: 'ORD-003', client: 'James Park', symbol: 'TSLA', side: 'buy', type: 'market', quantity: 50, price: 248.42, status: 'filled', total: 12421, time: '2025-02-16T10:22:00Z' },
  { id: 'ORD-004', client: 'David Müller', symbol: 'MSFT', side: 'buy', type: 'stop', quantity: 200, price: 410.00, status: 'pending', total: 82000, time: '2025-02-16T10:45:00Z' },
  { id: 'ORD-005', client: 'Tom Williams', symbol: 'AMZN', side: 'sell', type: 'market', quantity: 30, price: 178.25, status: 'filled', total: 5347.5, time: '2025-02-16T11:01:00Z' },
  { id: 'ORD-006', client: 'Yuki Tanaka', symbol: 'META', side: 'buy', type: 'limit', quantity: 15, price: 480.00, status: 'pending_approval', total: 7200, time: '2025-02-16T11:20:00Z' },
  { id: 'ORD-007', client: 'Elena Rossi', symbol: 'JPM', side: 'buy', type: 'market', quantity: 40, price: 198.75, status: 'rejected', total: 7950, time: '2025-02-16T11:35:00Z' },
  { id: 'ORD-008', client: 'Sarah Chen', symbol: 'COIN', side: 'sell', type: 'limit', quantity: 80, price: 210.00, status: 'pending', total: 16800, time: '2025-02-16T11:50:00Z' },
];

export default function AdminOrdersScreen() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const [orders, setOrders] = useState(MOCK_ORDERS);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  const filtered = useMemo(() => {
    let list = orders;
    if (filter === 'needs_action') list = list.filter(o => ['pending', 'pending_approval'].includes(o.status));
    else if (filter !== 'all') list = list.filter(o => o.status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(o => o.symbol.toLowerCase().includes(q) || o.client.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
    }
    return list;
  }, [orders, filter, search]);

  const statusColors = { filled: colors.green, pending: colors.yellow, pending_approval: colors.purple, rejected: colors.red, cancelled: colors.text4 };
  const statusLabels = { filled: 'Filled', pending: 'Pending', pending_approval: 'Needs Approval', rejected: 'Rejected', cancelled: 'Cancelled' };

  function handleApprove(id) {
    Alert.alert('Approve Order', `Approve order ${id}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', onPress: () => {
        setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'pending' } : o));
        api.post(`/admin/orders/${id}/approve`).catch(() => {});
      }},
    ]);
  }

  function handleReject(id) {
    Alert.alert('Reject Order', `Reject order ${id}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => {
        setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'rejected' } : o));
        api.post(`/admin/orders/${id}/reject`).catch(() => {});
      }},
    ]);
  }

  const pendingCount = orders.filter(o => ['pending', 'pending_approval'].includes(o.status)).length;
  const todayVolume = orders.filter(o => o.status === 'filled').reduce((s, o) => s + (o.total || 0), 0);

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        <Text style={styles.title}>Orders</Text>
        <Text style={[styles.subtitle, { marginBottom: Spacing.md }]}>{pendingCount} pending · {fmt(todayVolume)} filled today</Text>

        {/* Filter Tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.md }}
          contentContainerStyle={{ gap: 8 }}>
          {[['all', 'All'], ['needs_action', `Action (${pendingCount})`], ['filled', 'Filled'], ['rejected', 'Rejected']].map(([key, label]) => (
            <TouchableOpacity key={key} onPress={() => setFilter(key)} style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.full,
              backgroundColor: filter === key ? colors.blueLight : colors.bg3,
            }}>
              <Text style={{ ...Fonts.caption, fontWeight: '600', color: filter === key ? colors.blue : colors.text3 }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Search */}
        <TextInput style={[styles.input, { marginBottom: Spacing.md }]}
          placeholder="Search by symbol, client, or ID..." placeholderTextColor={colors.text4}
          value={search} onChangeText={setSearch} />

        {/* Orders */}
        {filtered.map(order => (
          <View key={order.id} style={[styles.card, { marginBottom: 8 }]}>
            <View style={styles.spaceBetween}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: order.side === 'buy' ? colors.greenLight : colors.redLight,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Text style={{ fontSize: 16 }}>{order.side === 'buy' ? '↗' : '↘'}</Text>
                </View>
                <View>
                  <Text style={{ ...Fonts.medium, color: colors.text }}>
                    {order.side.toUpperCase()} {order.quantity} {order.symbol}
                  </Text>
                  <Text style={{ ...Fonts.caption, color: colors.text4 }}>{order.client} · {order.type} · {order.id}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ ...Fonts.mono, color: colors.text, fontSize: 13 }}>{fmt(order.total)}</Text>
                <View style={{ backgroundColor: `${statusColors[order.status]}20`, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, marginTop: 2 }}>
                  <Text style={{ ...Fonts.caption, color: statusColors[order.status], fontWeight: '600' }}>
                    {statusLabels[order.status] || order.status}
                  </Text>
                </View>
              </View>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Text style={{ ...Fonts.caption, color: colors.text4 }}>@ {fmt(order.price)}</Text>
              <Text style={{ ...Fonts.caption, color: colors.text4 }}>{new Date(order.time).toLocaleTimeString()}</Text>
            </View>

            {/* Action buttons for pending_approval */}
            {order.status === 'pending_approval' && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: Spacing.sm }}>
                <TouchableOpacity onPress={() => handleApprove(order.id)}
                  style={{ flex: 1, backgroundColor: colors.greenLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}>
                  <Text style={{ ...Fonts.caption, color: colors.green, fontWeight: '700' }}>✓ Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleReject(order.id)}
                  style={{ flex: 1, backgroundColor: colors.redLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}>
                  <Text style={{ ...Fonts.caption, color: colors.red, fontWeight: '700' }}>✗ Reject</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}

        {filtered.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>No orders match</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
