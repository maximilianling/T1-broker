// ================================================================
// T1 BROKER MOBILE — ADMIN DASHBOARD SCREEN
// AUM, stats, revenue chart, compliance alerts, system health
// ================================================================
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, RefreshControl, SafeAreaView, Dimensions } from 'react-native';
import { LineChart, BarChart } from 'react-native-chart-kit';
import { useStore } from '../../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../../utils/theme';
import api from '../../services/api';

const W = Dimensions.get('window').width;
const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtM = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n}`;

const MOCK_STATS = {
  totalAUM: 284500000, activeClients: 1247, pendingOrders: 34, pendingKYC: 8,
  todayVolume: 12400000, todayTrades: 892, todayRevenue: 45800, marginUtilization: 62,
  complianceAlerts: 3, systemHealth: 99.7,
};

const MOCK_REVENUE = [32000, 41000, 38000, 45000, 42000, 48000, 45800];
const MOCK_TRADES = [720, 810, 780, 890, 850, 920, 892];

export default function AdminDashboardScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const [stats, setStats] = useState(MOCK_STATS);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api.get('/admin/dashboard');
      if (!res.error && res.stats) setStats(res.stats);
    } catch (e) {}
    setRefreshing(false);
  }, []);

  const chartConfig = {
    backgroundColor: 'transparent',
    backgroundGradientFrom: colors.card, backgroundGradientTo: colors.card,
    decimalPlaces: 0,
    color: () => colors.blue, labelColor: () => colors.text4,
    strokeWidth: 2,
    propsForBackgroundLines: { strokeDasharray: '4 4', stroke: colors.border, strokeWidth: 0.5 },
    propsForLabels: { fontSize: 9 },
  };

  function StatCard({ label, value, sub, color, icon, onPress }) {
    return (
      <TouchableOpacity onPress={onPress} style={{
        flex: 1, backgroundColor: colors.card, borderRadius: Radius.md,
        padding: 14, borderWidth: 1, borderColor: colors.cardBorder, minWidth: '46%',
      }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ ...Fonts.caption, color: colors.text3 }}>{label}</Text>
          {icon && <Text style={{ fontSize: 14 }}>{icon}</Text>}
        </View>
        <Text style={{ fontSize: 20, fontWeight: '800', color: color || colors.text, fontFamily: 'Courier' }}>{value}</Text>
        {sub && <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 2 }}>{sub}</Text>}
      </TouchableOpacity>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue} />}>

        <Text style={styles.title}>Admin Dashboard</Text>
        <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>Platform overview</Text>

        {/* KPIs Row 1 */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
          <StatCard label="Total AUM" value={fmtM(stats.totalAUM)} icon="💰" color={colors.blue} />
          <StatCard label="Active Clients" value={stats.activeClients.toLocaleString()} icon="👥"
            onPress={() => navigation.navigate('AdminClients')} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
          <StatCard label="Pending Orders" value={stats.pendingOrders} icon="📋" color={colors.yellow}
            onPress={() => navigation.navigate('AdminOrders')} />
          <StatCard label="Pending KYC" value={stats.pendingKYC} icon="📄" color={colors.yellow}
            onPress={() => navigation.navigate('AdminCompliance')} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: Spacing.md }}>
          <StatCard label="Today's Volume" value={fmtM(stats.todayVolume)} sub={`${stats.todayTrades} trades`} icon="📊" />
          <StatCard label="Today's Revenue" value={fmt(stats.todayRevenue)} icon="💵" color={colors.green} />
        </View>

        {/* Revenue Chart */}
        <Text style={styles.sectionTitle}>Revenue (7 days)</Text>
        <View style={[styles.card, { paddingHorizontal: 0, overflow: 'hidden' }]}>
          <BarChart
            data={{
              labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
              datasets: [{ data: MOCK_REVENUE.map(v => v / 1000) }],
            }}
            width={W - 32} height={180} yAxisLabel="$" yAxisSuffix="K"
            chartConfig={{ ...chartConfig, color: () => colors.green, fillShadowGradientFrom: colors.green,
              fillShadowGradientFromOpacity: 0.8, fillShadowGradientTo: colors.green, fillShadowGradientToOpacity: 0.3 }}
            style={{ marginLeft: -8, borderRadius: Radius.md }}
          />
        </View>

        {/* Trade Volume Chart */}
        <Text style={styles.sectionTitle}>Trade Volume (7 days)</Text>
        <View style={[styles.card, { paddingHorizontal: 0, overflow: 'hidden' }]}>
          <LineChart
            data={{ labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets: [{ data: MOCK_TRADES }] }}
            width={W - 32} height={180}
            withDots={true} withShadow={true} bezier
            chartConfig={{ ...chartConfig,
              fillShadowGradientFrom: colors.blue, fillShadowGradientFromOpacity: 0.2,
              fillShadowGradientTo: colors.card, fillShadowGradientToOpacity: 0 }}
            style={{ marginLeft: -8, borderRadius: Radius.md }}
          />
        </View>

        {/* System Health */}
        <Text style={styles.sectionTitle}>System Health</Text>
        <View style={styles.card}>
          {[
            { label: 'Uptime', value: `${stats.systemHealth}%`, color: colors.green, icon: '🟢' },
            { label: 'Margin Utilization', value: `${stats.marginUtilization}%`, color: stats.marginUtilization > 80 ? colors.red : colors.yellow, icon: stats.marginUtilization > 80 ? '🔴' : '🟡' },
            { label: 'Compliance Alerts', value: stats.complianceAlerts, color: stats.complianceAlerts > 0 ? colors.red : colors.green, icon: stats.complianceAlerts > 0 ? '⚠️' : '✅' },
            { label: 'API Latency', value: '42ms', color: colors.green, icon: '⚡' },
          ].map((item, i, arr) => (
            <View key={item.label} style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingVertical: 12, borderBottomWidth: i < arr.length - 1 ? 1 : 0, borderBottomColor: colors.border,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ fontSize: 16 }}>{item.icon}</Text>
                <Text style={{ ...Fonts.medium, color: colors.text }}>{item.label}</Text>
              </View>
              <Text style={{ ...Fonts.mono, color: item.color, fontWeight: '700' }}>{item.value}</Text>
            </View>
          ))}
        </View>

        {/* Quick Links */}
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: 'Clients', icon: '👥', screen: 'AdminClients' },
            { label: 'Orders', icon: '📋', screen: 'AdminOrders' },
            { label: 'Compliance', icon: '🔍', screen: 'AdminCompliance' },
            { label: 'Reports', icon: '📊', screen: 'AdminDashboard' },
          ].map(item => (
            <TouchableOpacity key={item.label} onPress={() => navigation.navigate(item.screen)}
              style={{ flex: 1, minWidth: '46%', backgroundColor: colors.card, borderRadius: Radius.md,
                padding: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder }}>
              <Text style={{ fontSize: 28, marginBottom: 6 }}>{item.icon}</Text>
              <Text style={{ ...Fonts.caption, color: colors.text2, fontWeight: '600' }}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
