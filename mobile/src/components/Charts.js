// ================================================================
// T1 BROKER MOBILE — CHART COMPONENTS
// Line chart, candlestick, pie chart, mini sparkline
// Uses react-native-chart-kit + custom SVG
// ================================================================
import React, { useMemo } from 'react';
import { View, Text, Dimensions } from 'react-native';
import { LineChart, PieChart } from 'react-native-chart-kit';
import Svg, { Rect, Line, Circle, G, Text as SvgText, Path } from 'react-native-svg';
import { Colors, Fonts } from '../utils/theme';
import { useStore } from '../services/store';

const SCREEN_W = Dimensions.get('window').width;

// ================================================================
// PORTFOLIO LINE CHART
// ================================================================
export function PortfolioChart({ data = [], height = 200, period = '1M', color }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const lineColor = color || colors.blue;

  // Generate mock data if none provided
  const chartData = useMemo(() => {
    if (data.length > 2) return data.map(d => d.totalValue || d.value || d);

    // Generate realistic portfolio curve
    const points = period === '1D' ? 78 : period === '1W' ? 35 : period === '1M' ? 30 : period === '3M' ? 90 : 365;
    const base = 142850;
    const values = [base];
    for (let i = 1; i < points; i++) {
      const prev = values[i - 1];
      const change = prev * (0.0002 + (Math.random() - 0.48) * 0.015);
      values.push(prev + change);
    }
    return values;
  }, [data, period]);

  const labels = useMemo(() => {
    const len = chartData.length;
    const count = Math.min(5, len);
    const step = Math.floor(len / count);
    return Array.from({ length: count }, (_, i) => {
      if (period === '1D') return `${9 + Math.floor(i * 7 / count)}:00`;
      if (period === '1W') return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i % 5];
      if (period === '1M') return `${i * 6 + 1}`;
      return `M${i + 1}`;
    });
  }, [chartData.length, period]);

  const isPositive = chartData[chartData.length - 1] >= chartData[0];

  return (
    <View style={{ marginHorizontal: -16 }}>
      <LineChart
        data={{
          labels,
          datasets: [{ data: chartData, color: () => isPositive ? colors.green : colors.red, strokeWidth: 2 }],
        }}
        width={SCREEN_W - 16}
        height={height}
        withDots={false}
        withInnerLines={false}
        withOuterLines={false}
        withVerticalLabels={true}
        withHorizontalLabels={true}
        withShadow={false}
        chartConfig={{
          backgroundColor: 'transparent',
          backgroundGradientFrom: colors.card,
          backgroundGradientTo: colors.card,
          decimalPlaces: 0,
          color: () => isPositive ? colors.green : colors.red,
          labelColor: () => colors.text4,
          propsForBackgroundLines: { stroke: colors.border, strokeDasharray: '4,4' },
          propsForLabels: { fontSize: 10, fontFamily: 'Courier' },
          fillShadowGradientFrom: isPositive ? colors.green : colors.red,
          fillShadowGradientFromOpacity: 0.15,
          fillShadowGradientTo: isPositive ? colors.green : colors.red,
          fillShadowGradientToOpacity: 0,
        }}
        bezier
        style={{ borderRadius: 12, paddingRight: 0 }}
      />
    </View>
  );
}

// ================================================================
// CANDLESTICK CHART (Custom SVG)
// ================================================================
export function CandlestickChart({ candles = [], height = 200, width }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const W = width || SCREEN_W - 32;

  const data = useMemo(() => {
    if (candles.length > 5) return candles.slice(-60);
    // Generate mock candles
    let price = 189.84;
    return Array.from({ length: 60 }, () => {
      const o = price;
      const move = (Math.random() - 0.48) * 3;
      const c = o + move;
      const h = Math.max(o, c) + Math.random() * 1.5;
      const l = Math.min(o, c) - Math.random() * 1.5;
      price = c;
      return { o, h, l, c, v: Math.floor(Math.random() * 10000 + 1000) };
    });
  }, [candles]);

  if (!data.length) return null;

  const padding = { top: 10, bottom: 20, left: 0, right: 0 };
  const chartW = W - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const allPrices = data.flatMap(c => [c.h, c.l]);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice || 1;

  const candleW = Math.max(2, (chartW / data.length) * 0.7);
  const gap = chartW / data.length;

  const yScale = (price) => padding.top + chartH - ((price - minPrice) / priceRange) * chartH;

  return (
    <Svg width={W} height={height}>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(pct => {
        const y = padding.top + chartH * (1 - pct);
        const price = minPrice + priceRange * pct;
        return (
          <G key={pct}>
            <Line x1={padding.left} y1={y} x2={W} y2={y} stroke={colors.border} strokeWidth={0.5} strokeDasharray="3,3" />
            <SvgText x={W - 2} y={y - 3} fontSize={9} fill={colors.text4} textAnchor="end" fontFamily="Courier">
              {price.toFixed(2)}
            </SvgText>
          </G>
        );
      })}

      {/* Candles */}
      {data.map((c, i) => {
        const x = padding.left + i * gap + gap / 2;
        const isGreen = c.c >= c.o;
        const bodyTop = yScale(Math.max(c.o, c.c));
        const bodyBot = yScale(Math.min(c.o, c.c));
        const bodyH = Math.max(1, bodyBot - bodyTop);

        return (
          <G key={i}>
            {/* Wick */}
            <Line x1={x} y1={yScale(c.h)} x2={x} y2={yScale(c.l)}
              stroke={isGreen ? colors.green : colors.red} strokeWidth={1} />
            {/* Body */}
            <Rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH}
              fill={isGreen ? colors.green : colors.red}
              rx={1} />
          </G>
        );
      })}
    </Svg>
  );
}

// ================================================================
// ALLOCATION PIE CHART
// ================================================================
export function AllocationPieChart({ allocation = [], size = 180 }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];

  const chartColors = [colors.blue, colors.green, colors.purple, colors.yellow, colors.red, '#06b6d4', '#f97316'];

  const data = useMemo(() => {
    if (allocation.length > 0) {
      return allocation.map((a, i) => ({
        name: a.assetClass || a.name,
        value: a.percentage || a.value,
        color: chartColors[i % chartColors.length],
        legendFontColor: colors.text2,
        legendFontSize: 12,
      }));
    }
    return [
      { name: 'Tech', value: 45, color: colors.blue, legendFontColor: colors.text2, legendFontSize: 12 },
      { name: 'Finance', value: 20, color: colors.green, legendFontColor: colors.text2, legendFontSize: 12 },
      { name: 'Crypto', value: 15, color: colors.purple, legendFontColor: colors.text2, legendFontSize: 12 },
      { name: 'ETFs', value: 12, color: colors.yellow, legendFontColor: colors.text2, legendFontSize: 12 },
      { name: 'Other', value: 8, color: colors.red, legendFontColor: colors.text2, legendFontSize: 12 },
    ];
  }, [allocation]);

  return (
    <PieChart
      data={data}
      width={SCREEN_W - 32}
      height={size}
      chartConfig={{
        color: () => colors.text,
        labelColor: () => colors.text2,
      }}
      accessor="value"
      backgroundColor="transparent"
      paddingLeft="0"
      absolute={false}
    />
  );
}

// ================================================================
// MINI SPARKLINE (for watchlist rows)
// ================================================================
export function Sparkline({ data = [], width = 60, height = 24, color }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];

  const points = useMemo(() => {
    const d = data.length > 2 ? data : Array.from({ length: 20 }, () => Math.random());
    const min = Math.min(...d);
    const max = Math.max(...d);
    const range = max - min || 1;
    return d.map((v, i) => `${(i / (d.length - 1)) * width},${height - ((v - min) / range) * height}`).join(' ');
  }, [data, width, height]);

  const lineColor = color || (data.length > 1 && data[data.length - 1] >= data[0] ? colors.green : colors.red);

  return (
    <Svg width={width} height={height}>
      <Path d={`M ${points.split(' ').map((p, i) => `${i === 0 ? 'M' : 'L'} ${p}`).join(' ')}`}
        stroke={lineColor} strokeWidth={1.5} fill="none" />
    </Svg>
  );
}

// ================================================================
// VOLUME BARS (for candlestick chart footer)
// ================================================================
export function VolumeBars({ candles = [], height = 40, width }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const W = width || SCREEN_W - 32;

  if (!candles.length) return null;

  const maxVol = Math.max(...candles.map(c => c.v || 0)) || 1;
  const barW = Math.max(2, (W / candles.length) * 0.7);
  const gap = W / candles.length;

  return (
    <Svg width={W} height={height}>
      {candles.map((c, i) => {
        const x = i * gap + gap / 2 - barW / 2;
        const barH = ((c.v || 0) / maxVol) * (height - 4);
        const isGreen = (c.c || 0) >= (c.o || 0);
        return (
          <Rect key={i} x={x} y={height - barH} width={barW} height={barH}
            fill={isGreen ? colors.green : colors.red} opacity={0.5} rx={1} />
        );
      })}
    </Svg>
  );
}
