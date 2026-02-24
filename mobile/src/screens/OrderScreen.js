// ================================================================
// T1 BROKER MOBILE — ORDER PLACEMENT SCREEN
// ================================================================
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  SafeAreaView, Alert, ActivityIndicator,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function OrderScreen({ navigation, route }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const placeOrder = useStore(s => s.placeOrder);

  const [symbol, setSymbol] = useState(route?.params?.symbol || '');
  const [side, setSide] = useState('buy');
  const [orderType, setOrderType] = useState('market');
  const [quantity, setQuantity] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('entry'); // 'entry' | 'preview'

  const mockPrice = 189.84; // Would come from live quote
  const total = parseFloat(quantity || 0) * (orderType === 'market' ? mockPrice : parseFloat(limitPrice || 0));

  function handlePreview() {
    if (!symbol.trim()) { Alert.alert('Missing', 'Enter a stock symbol'); return; }
    if (!quantity || parseFloat(quantity) <= 0) { Alert.alert('Missing', 'Enter a valid quantity'); return; }
    if (orderType !== 'market' && (!limitPrice || parseFloat(limitPrice) <= 0)) {
      Alert.alert('Missing', 'Enter a limit price'); return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep('preview');
  }

  async function handleSubmit() {
    setLoading(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const order = {
      symbol: symbol.toUpperCase(),
      side,
      type: orderType,
      quantity: parseFloat(quantity),
      ...(orderType !== 'market' && { limitPrice: parseFloat(limitPrice) }),
      ...(orderType === 'stop' && { stopPrice: parseFloat(stopPrice) }),
    };

    const res = await placeOrder(order);
    setLoading(false);

    if (res.error) {
      Alert.alert('Order Failed', res.error);
    } else {
      Alert.alert(
        'Order Placed',
        `${side.toUpperCase()} ${quantity} ${symbol.toUpperCase()} at ${orderType === 'market' ? 'market' : fmt(limitPrice)}`,
        [{ text: 'Done', onPress: () => navigation.goBack() }]
      );
    }
  }

  // ── Preview Step ──
  if (step === 'preview') {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
          <Text style={[styles.title, { textAlign: 'center', marginBottom: 8 }]}>Confirm Order</Text>

          <View style={[styles.card, { marginTop: Spacing.lg }]}>
            <View style={{ alignItems: 'center', marginBottom: Spacing.lg }}>
              <View style={{
                width: 64, height: 64, borderRadius: 32,
                backgroundColor: side === 'buy' ? colors.greenLight : colors.redLight,
                alignItems: 'center', justifyContent: 'center', marginBottom: 12,
              }}>
                <Text style={{ fontSize: 28 }}>{side === 'buy' ? '↗' : '↘'}</Text>
              </View>
              <Text style={{ ...Fonts.h2, color: colors.text }}>{side.toUpperCase()} {symbol.toUpperCase()}</Text>
            </View>

            {[
              ['Order Type', orderType.charAt(0).toUpperCase() + orderType.slice(1)],
              ['Quantity', quantity + ' shares'],
              ['Price', orderType === 'market' ? `~${fmt(mockPrice)} (market)` : fmt(limitPrice)],
              ...(orderType === 'stop' ? [['Stop Price', fmt(stopPrice)]] : []),
              ['Est. Total', fmt(total)],
            ].map(([label, value]) => (
              <View key={label} style={[styles.spaceBetween, { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                <Text style={{ ...Fonts.regular, color: colors.text3 }}>{label}</Text>
                <Text style={{ ...Fonts.semibold, color: colors.text }}>{value}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.btnPrimary, {
              backgroundColor: side === 'buy' ? colors.green : colors.red,
              marginTop: Spacing.md,
            }, loading && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.btnPrimaryText}>Confirm {side.toUpperCase()} Order</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btnGhost, { marginTop: Spacing.sm }]} onPress={() => setStep('entry')}>
            <Text style={styles.btnGhostText}>← Edit Order</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Entry Step ──
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg }} keyboardShouldPersistTaps="handled">
        {/* Symbol */}
        <Text style={styles.inputLabel}>SYMBOL</Text>
        <TextInput style={[styles.input, { fontSize: 20, fontWeight: '700', marginBottom: Spacing.md }]}
          value={symbol} onChangeText={s => setSymbol(s.toUpperCase())}
          placeholder="AAPL" placeholderTextColor={colors.text4} autoCapitalize="characters" />

        {/* Side Toggle */}
        <View style={{ flexDirection: 'row', marginBottom: Spacing.lg, gap: 8 }}>
          {['buy', 'sell'].map(s => (
            <TouchableOpacity key={s} onPress={() => { setSide(s); Haptics.selectionAsync(); }} style={{
              flex: 1, paddingVertical: 14, borderRadius: Radius.md, alignItems: 'center',
              backgroundColor: side === s ? (s === 'buy' ? colors.green : colors.red) : colors.bg3,
            }}>
              <Text style={{ ...Fonts.semibold, fontSize: 16, color: side === s ? '#fff' : colors.text3 }}>
                {s === 'buy' ? '↗ BUY' : '↘ SELL'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Order Type */}
        <Text style={styles.inputLabel}>ORDER TYPE</Text>
        <View style={{ flexDirection: 'row', marginBottom: Spacing.md, gap: 8 }}>
          {['market', 'limit', 'stop'].map(t => (
            <TouchableOpacity key={t} onPress={() => setOrderType(t)} style={{
              flex: 1, paddingVertical: 10, borderRadius: Radius.md, alignItems: 'center',
              backgroundColor: orderType === t ? colors.blueLight : 'transparent',
              borderWidth: 1, borderColor: orderType === t ? colors.blue : colors.border,
            }}>
              <Text style={{ ...Fonts.caption, fontWeight: '600', color: orderType === t ? colors.blue : colors.text3 }}>
                {t.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Quantity */}
        <Text style={styles.inputLabel}>QUANTITY</Text>
        <TextInput style={[styles.input, { fontSize: 20, fontFamily: 'Courier', marginBottom: Spacing.md }]}
          value={quantity} onChangeText={setQuantity}
          placeholder="0" placeholderTextColor={colors.text4} keyboardType="numeric" />

        {/* Quick quantity buttons */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: Spacing.md }}>
          {['1', '5', '10', '25', '50', '100'].map(q => (
            <TouchableOpacity key={q} onPress={() => { setQuantity(q); Haptics.selectionAsync(); }}
              style={{ flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: colors.bg3, alignItems: 'center' }}>
              <Text style={{ ...Fonts.caption, color: colors.text3 }}>{q}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Limit Price */}
        {orderType !== 'market' && (
          <>
            <Text style={styles.inputLabel}>LIMIT PRICE</Text>
            <TextInput style={[styles.input, { fontSize: 20, fontFamily: 'Courier', marginBottom: Spacing.md }]}
              value={limitPrice} onChangeText={setLimitPrice}
              placeholder="0.00" placeholderTextColor={colors.text4} keyboardType="decimal-pad" />
          </>
        )}

        {orderType === 'stop' && (
          <>
            <Text style={styles.inputLabel}>STOP PRICE</Text>
            <TextInput style={[styles.input, { fontSize: 20, fontFamily: 'Courier', marginBottom: Spacing.md }]}
              value={stopPrice} onChangeText={setStopPrice}
              placeholder="0.00" placeholderTextColor={colors.text4} keyboardType="decimal-pad" />
          </>
        )}

        {/* Estimated total */}
        {total > 0 && (
          <View style={[styles.card, { marginBottom: Spacing.md }]}>
            <View style={styles.spaceBetween}>
              <Text style={{ ...Fonts.regular, color: colors.text3 }}>Estimated Total</Text>
              <Text style={{ ...Fonts.monoLg, color: colors.text }}>{fmt(total)}</Text>
            </View>
          </View>
        )}

        {/* Preview Button */}
        <TouchableOpacity style={styles.btnPrimary} onPress={handlePreview}>
          <Text style={styles.btnPrimaryText}>Preview Order</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
