// ================================================================
// T1 BROKER MOBILE — PORTFOLIO SCREEN
// Real chart rendering with react-native-chart-kit + SVG donut
// ================================================================
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  SafeAreaView, Dimensions,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import Svg, { Circle, G, Text as SvgText } from 'react-native-svg';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts } from '../utils/theme';
import api from '../services/api';

const SCREEN_W = Dimensions.get('window').width;
const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + '%';
const fmtK = (n) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : fmt(n);

const MOCK_POSITIONS = [
  { symbol: 'AAPL', name: 'Apple Inc.', quantity: 50, avgCost: 175.20, currentPrice: 189.84, marketValue: 9492.00, unrealizedPL: 732.00, unrealizedPLPct: 8.35, assetClass: 'Tech' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', quantity: 12, avgCost: 680.00, currentPrice: 875.28, marketValue: 10503.36, unrealizedPL: 2343.36, unrealizedPLPct: 28.73, assetClass: 'Tech' },
  { symbol: 'MSFT', name: 'Microsoft', quantity: 25, avgCost: 380.00, currentPrice: 415.50, marketValue: 10387.50, unrealizedPL: 887.50, unrealizedPLPct: 9.34, assetClass: 'Tech' },
  { symbol: 'AMZN', name: 'Amazon.com', quantity: 30, avgCost: 160.00, currentPrice: 178.25, marketValue: 5347.50, unrealizedPL: 547.50, unrealizedPLPct: 11.41, assetClass: 'Consumer' },
  { symbol: 'TSLA', name: 'Tesla Inc.', quantity: 15, avgCost: 265.00, currentPrice: 248.42, marketValue: 3726.30, unrealizedPL: -248.70, unrealizedPLPct: -6.26, assetClass: 'Auto' },
  { symbol: 'JPM', name: 'JPMorgan Chase', quantity: 20, avgCost: 185.00, currentPrice: 198.75, marketValue: 3975.00, unrealizedPL: 275.00, unrealizedPLPct: 7.43, assetClass: 'Finance' },
];

function generateChartData(period, totalValue) {
  const points = { '1D': 24, '1W': 7, '1M': 30, '3M': 90, '1Y': 252, 'ALL': 504 }[period] || 30;
  const labels = [];
  const data = [];
  const base = totalValue * 0.85;
  const vol = { '1D': 0.005, '1W': 0.015, '1M': 0.04, '3M': 0.08, '1Y': 0.2, 'ALL': 0.35 }[period] || 0.04;
  let val = base;
  const drift = (totalValue - base) / points;
  for (let i = 0; i <= points; i++) {
    val += drift + (Math.random() - 0.45) * base * vol * 0.15;
    val = Math.max(val, base * 0.7);
    data.push(val);
    if (period === '1D') labels.push(i % 6 === 0 ? `${9 + Math.floor(i * 7 / 24)}:00` : '');
    else if (period === '1W') labels.push(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i] || '');
    else { const step = Math.ceil(points / 5); labels.push(i % step === 0 ? `${i}` : ''); }
  }
  data[data.length - 1] = totalValue;
  return { labels, data };
}

function DonutChart({ data, size = 150, strokeWidth = 22, sliceColors }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const total = data.reduce((s, d) => s + d.value, 0);
  let accumulated = 0;
  const slices = data.map((item, i) => {
    const pct = total > 0 ? item.value / total : 0;
    const len = pct * circumference;
    const offset = circumference - (accumulated * circumference);
    accumulated += pct;
    return { ...item, pct, len, offset, color: sliceColors[i % sliceColors.length] };
  });
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        <G rotation="-90" origin={`${center}, ${center}`}>
          {slices.map((s, i) => (
            <Circle key={i} cx={center} cy={center} r={radius} stroke={s.color}
              strokeWidth={strokeWidth} fill="none" strokeLinecap="butt"
              strokeDasharray={`${s.len} ${circumference - s.len}`}
              strokeDashoffset={-s.offset + circumference} />
          ))}
        </G>
        <SvgText x={center} y={center - 4} textAnchor="middle" fill="#94a3b8" fontSize="9">Allocation</SvgText>
        <SvgText x={center} y={center + 12} textAnchor="middle" fill="#f0f4ff" fontSize="13" fontWeight="700">{data.length} sectors</SvgText>
      </Svg>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8 }}>
        {slices.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.color }} />
            <Text style={{ fontSize: 10, color: '#94a3b8' }}>{s.label} {(s.pct * 100).toFixed(0)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function PortfolioScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const positions = useStore(s => s.positions);
  const portfolioHistory = useStore(s => s.portfolioHistory);
  const loadPortfolio = useStore(s => s.loadPortfolio);
  const portfolioLoading = useStore(s => s.portfolioLoading);
  const [period, setPeriod] = useState('1M');
  const [sortBy, setSortBy] = useState('value');

  const data = positions?.length > 0 ? positions : MOCK_POSITIONS;
  const totalValue = data.reduce((s, p) => s + (p.marketValue || 0), 0);
  const totalPL = data.reduce((s, p) => s + (p.unrealizedPL || 0), 0);
  const totalPLPct = totalValue > 0 ? (totalPL / (totalValue - totalPL)) * 100 : 0;

  const chartInfo = useMemo(() => {
    if (portfolioHistory?.length > 5) {
      const pts = portfolioHistory;
      const step = Math.ceil(pts.length / 6);
      return {
        labels: pts.map((p, i) => i % step === 0 ? new Date(p.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : ''),
        data: pts.map(p => p.totalValue || 0),
      };
    }
    return generateChartData(period, totalValue);
  }, [period, totalValue, portfolioHistory]);

  const chartStart = chartInfo.data[0] || 0;
  const chartEnd = chartInfo.data[chartInfo.data.length - 1] || 0;
  const chartChange = chartEnd - chartStart;
  const isUp = chartChange >= 0;

  const allocation = useMemo(() => {
    const map = {};
    data.forEach(p => { const c = p.assetClass || 'Other'; map[c] = (map[c] || 0) + (p.marketValue || 0); });
    return Object.entries(map).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [data]);

  const sortedData = useMemo(() => {
    const s = [...data];
    if (sortBy === 'change') s.sort((a, b) => (b.unrealizedPLPct || 0) - (a.unrealizedPLPct || 0));
    else if (sortBy === 'name') s.sort((a, b) => a.symbol.localeCompare(b.symbol));
    else s.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
    return s;
  }, [data, sortBy]);

  const onRefresh = useCallback(() => loadPortfolio(), []);
  const donutColors = [colors.blue, colors.green, colors.purple, colors.yellow, colors.red, '#06b6d4', '#ec4899'];

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={portfolioLoading} onRefresh={onRefresh} tintColor={colors.blue} />}>
        <Text style={[styles.title, { marginBottom: 4 }]}>Portfolio</Text>
        <Text style={styles.subtitle}>Your investment positions</Text>

        {/* Summary */}
        <View style={[styles.card, { marginTop: Spacing.lg }]}>
          <View style={styles.spaceBetween}>
            <View>
              <Text style={{ ...Fonts.caption, color: colors.text3 }}>Market Value</Text>
              <Text style={{ fontSize: 28, fontWeight: '800', color: colors.text, fontFamily: 'Courier' }}>{fmt(totalValue)}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ ...Fonts.caption, color: colors.text3 }}>Unrealized P&L</Text>
              <Text style={{ ...Fonts.monoLg, color: totalPL >= 0 ? colors.green : colors.red }}>
                {totalPL >= 0 ? '+' : ''}{fmt(totalPL)}
              </Text>
              <Text style={{ ...Fonts.caption, color: totalPLPct >= 0 ? colors.green : colors.red, fontWeight: '600' }}>
                {fmtPct(totalPLPct)}
              </Text>
            </View>
          </View>
        </View>

        {/* Period Pills */}
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: Spacing.sm }}>
          {['1D','1W','1M','3M','1Y','ALL'].map(p => (
            <TouchableOpacity key={p} onPress={() => setPeriod(p)} style={{
              flex: 1, paddingVertical: 8, borderRadius: 8,
              backgroundColor: period === p ? colors.blueLight : 'transparent', alignItems: 'center',
            }}>
              <Text style={{ ...Fonts.caption, fontWeight: '600', color: period === p ? colors.blue : colors.text3 }}>{p}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Performance Line Chart */}
        <View style={[styles.card, { paddingHorizontal: 0, paddingBottom: 0, overflow: 'hidden' }]}>
          <View style={{ paddingHorizontal: Spacing.md, marginBottom: 8 }}>
            <Text style={{ ...Fonts.caption, color: isUp ? colors.green : colors.red, fontWeight: '600' }}>
              {isUp ? '↑' : '↓'} {fmtK(Math.abs(chartChange))} ({fmtPct(chartStart > 0 ? (chartChange / chartStart) * 100 : 0)}) this period
            </Text>
          </View>
          <LineChart
            data={{ labels: chartInfo.labels, datasets: [{ data: chartInfo.data.length > 1 ? chartInfo.data : [0, 1] }] }}
            width={SCREEN_W - 32} height={200}
            withDots={false} withInnerLines={true} withOuterLines={false}
            withHorizontalLabels={true} withVerticalLabels={true} withShadow={true}
            yAxisLabel="" yLabelsOffset={8}
            formatYLabel={(v) => fmtK(parseFloat(v))}
            chartConfig={{
              backgroundColor: 'transparent',
              backgroundGradientFrom: colors.card, backgroundGradientTo: colors.card,
              decimalPlaces: 0,
              color: () => isUp ? colors.green : colors.red,
              labelColor: () => colors.text4,
              strokeWidth: 2.5,
              fillShadowGradientFrom: isUp ? colors.green : colors.red,
              fillShadowGradientFromOpacity: 0.2,
              fillShadowGradientTo: colors.card, fillShadowGradientToOpacity: 0,
              propsForBackgroundLines: { strokeDasharray: '4 4', stroke: colors.border, strokeWidth: 0.5 },
              propsForLabels: { fontSize: 9 },
            }}
            bezier
            style={{ borderRadius: 0, marginLeft: -8 }}
          />
        </View>

        {/* Allocation Donut */}
        <Text style={styles.sectionTitle}>Allocation</Text>
        <View style={[styles.card, { alignItems: 'center', paddingVertical: Spacing.lg }]}>
          <DonutChart data={allocation} sliceColors={donutColors} />
        </View>

        {/* Positions Header */}
        <View style={[styles.spaceBetween, { marginTop: Spacing.lg, marginBottom: Spacing.md }]}>
          <Text style={styles.cardTitle}>Positions ({data.length})</Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {[['value','$'],['change','%'],['name','A-Z']].map(([k, l]) => (
              <TouchableOpacity key={k} onPress={() => setSortBy(k)} style={{
                paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
                backgroundColor: sortBy === k ? colors.blueLight : 'transparent',
              }}>
                <Text style={{ ...Fonts.caption, color: sortBy === k ? colors.blue : colors.text4, fontWeight: '600' }}>{l}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {sortedData.map((pos) => (
          <TouchableOpacity key={pos.symbol} style={[styles.card, { marginBottom: 8 }]}
            onPress={() => navigation.navigate('PlaceOrder', { symbol: pos.symbol })}>
            <View style={styles.spaceBetween}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ ...Fonts.semibold, color: colors.text, fontSize: 16 }}>{pos.symbol}</Text>
                  <Text style={{ ...Fonts.caption, color: colors.text3 }}>{pos.quantity} shares</Text>
                </View>
                <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 2 }}>{pos.name}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ ...Fonts.mono, color: colors.text }}>{fmt(pos.marketValue)}</Text>
                <Text style={{ ...Fonts.caption, fontWeight: '600', color: (pos.unrealizedPL || 0) >= 0 ? colors.green : colors.red }}>
                  {(pos.unrealizedPL || 0) >= 0 ? '+' : ''}{fmt(pos.unrealizedPL)} ({fmtPct(pos.unrealizedPLPct)})
                </Text>
              </View>
            </View>
            <View style={{ marginTop: 8, height: 3, backgroundColor: colors.bg3, borderRadius: 2, overflow: 'hidden' }}>
              <View style={{ height: 3, borderRadius: 2,
                backgroundColor: (pos.unrealizedPLPct || 0) >= 0 ? colors.green : colors.red,
                width: `${Math.min(Math.abs(pos.unrealizedPLPct || 0) * 2, 100)}%` }} />
            </View>
            <View style={[styles.spaceBetween, { marginTop: Spacing.xs }]}>
              <Text style={{ ...Fonts.caption, color: colors.text4 }}>Avg: {fmt(pos.avgCost)}</Text>
              <Text style={{ ...Fonts.caption, color: colors.text4 }}>Current: {fmt(pos.currentPrice)}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
