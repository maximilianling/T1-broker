// ================================================================
// T1 BROKER MOBILE — ADMIN CLIENTS SCREEN
// Client list, search, KYC status, AUM, account details
// ================================================================
import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, SafeAreaView, Alert } from 'react-native';
import { useStore } from '../../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../../utils/theme';
import api from '../../services/api';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0 });

const MOCK_CLIENTS = [
  { id: 1, name: 'Sarah Chen', email: 'sarah@example.com', kyc: 'approved', aum: 485200, positions: 12, joinDate: '2024-08-15', riskLevel: 'moderate' },
  { id: 2, name: 'Marcus Johnson', email: 'marcus@example.com', kyc: 'approved', aum: 1250000, positions: 28, joinDate: '2024-03-22', riskLevel: 'aggressive' },
  { id: 3, name: 'Elena Rossi', email: 'elena@example.com', kyc: 'pending', aum: 25000, positions: 3, joinDate: '2025-02-01', riskLevel: 'conservative' },
  { id: 4, name: 'James Park', email: 'james@example.com', kyc: 'approved', aum: 892000, positions: 18, joinDate: '2024-06-10', riskLevel: 'moderate' },
  { id: 5, name: 'Aisha Patel', email: 'aisha@example.com', kyc: 'rejected', aum: 0, positions: 0, joinDate: '2025-01-28', riskLevel: 'conservative' },
  { id: 6, name: 'Tom Williams', email: 'tom@example.com', kyc: 'approved', aum: 345000, positions: 9, joinDate: '2024-11-05', riskLevel: 'moderate' },
  { id: 7, name: 'Yuki Tanaka', email: 'yuki@example.com', kyc: 'pending', aum: 50000, positions: 2, joinDate: '2025-02-10', riskLevel: 'conservative' },
  { id: 8, name: 'David Müller', email: 'david@example.com', kyc: 'approved', aum: 2100000, positions: 42, joinDate: '2023-12-01', riskLevel: 'aggressive' },
];

export default function AdminClientsScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const [clients, setClients] = useState(MOCK_CLIENTS);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'approved' | 'pending' | 'rejected'
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    api.get('/admin/clients').then(res => {
      if (res?.data?.length) setClients(res.data);
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    let list = clients;
    if (filter !== 'all') list = list.filter(c => c.kyc === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
    }
    return list;
  }, [clients, filter, search]);

  const kycColors = { approved: colors.green, pending: colors.yellow, rejected: colors.red };
  const riskColors = { conservative: colors.blue, moderate: colors.yellow, aggressive: colors.red };

  const totalAUM = clients.reduce((s, c) => s + (c.aum || 0), 0);
  const pendingCount = clients.filter(c => c.kyc === 'pending').length;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        <Text style={styles.title}>Clients</Text>
        <Text style={[styles.subtitle, { marginBottom: Spacing.md }]}>{clients.length} accounts · {fmt(totalAUM)} AUM</Text>

        {/* Summary */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: Spacing.md }}>
          {[
            { label: 'Total', value: clients.length, color: colors.blue },
            { label: 'Approved', value: clients.filter(c => c.kyc === 'approved').length, color: colors.green },
            { label: 'Pending', value: pendingCount, color: colors.yellow },
            { label: 'Rejected', value: clients.filter(c => c.kyc === 'rejected').length, color: colors.red },
          ].map(s => (
            <TouchableOpacity key={s.label} onPress={() => setFilter(s.label.toLowerCase() === 'total' ? 'all' : s.label.toLowerCase())}
              style={{ flex: 1, backgroundColor: colors.card, borderRadius: Radius.sm, padding: 10, alignItems: 'center',
                borderWidth: 1, borderColor: filter === s.label.toLowerCase() || (filter === 'all' && s.label === 'Total') ? s.color : colors.cardBorder }}>
              <Text style={{ ...Fonts.monoLg, color: s.color, fontSize: 18 }}>{s.value}</Text>
              <Text style={{ ...Fonts.caption, color: colors.text3 }}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Search */}
        <TextInput style={[styles.input, { marginBottom: Spacing.md }]}
          placeholder="Search clients..." placeholderTextColor={colors.text4}
          value={search} onChangeText={setSearch} />

        {/* Client List */}
        {filtered.map(client => (
          <TouchableOpacity key={client.id} style={[styles.card, { marginBottom: 8 }]}
            onPress={() => setExpandedId(expandedId === client.id ? null : client.id)}>
            <View style={styles.spaceBetween}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.blueLight,
                  alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: colors.blue, fontWeight: '700', fontSize: 14 }}>
                    {client.name.split(' ').map(n => n[0]).join('')}
                  </Text>
                </View>
                <View>
                  <Text style={{ ...Fonts.medium, color: colors.text }}>{client.name}</Text>
                  <Text style={{ ...Fonts.caption, color: colors.text4 }}>{client.email}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ ...Fonts.mono, color: colors.text, fontSize: 13 }}>{fmt(client.aum)}</Text>
                <View style={{ backgroundColor: `${kycColors[client.kyc]}20`, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, marginTop: 2 }}>
                  <Text style={{ ...Fonts.caption, color: kycColors[client.kyc], fontWeight: '600' }}>{client.kyc}</Text>
                </View>
              </View>
            </View>

            {/* Expanded Detail */}
            {expandedId === client.id && (
              <View style={{ marginTop: Spacing.md, paddingTop: Spacing.md, borderTopWidth: 1, borderTopColor: colors.border }}>
                {[
                  ['Positions', client.positions],
                  ['Risk Level', client.riskLevel],
                  ['Joined', new Date(client.joinDate).toLocaleDateString()],
                ].map(([label, val]) => (
                  <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                    <Text style={{ ...Fonts.caption, color: colors.text3 }}>{label}</Text>
                    <Text style={{ ...Fonts.caption, color: label === 'Risk Level' ? riskColors[val] || colors.text : colors.text, fontWeight: '600', textTransform: 'capitalize' }}>{val}</Text>
                  </View>
                ))}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: Spacing.sm }}>
                  <TouchableOpacity style={{ flex: 1, backgroundColor: colors.blueLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}
                    onPress={() => Alert.alert('View', `View ${client.name}'s full profile`)}>
                    <Text style={{ ...Fonts.caption, color: colors.blue, fontWeight: '600' }}>View Profile</Text>
                  </TouchableOpacity>
                  {client.kyc === 'pending' && (
                    <TouchableOpacity style={{ flex: 1, backgroundColor: colors.greenLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}
                      onPress={() => Alert.alert('KYC', 'Approve KYC documents')}>
                      <Text style={{ ...Fonts.caption, color: colors.green, fontWeight: '600' }}>Review KYC</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </TouchableOpacity>
        ))}

        {filtered.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔍</Text>
            <Text style={styles.emptyText}>No clients match your search</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
