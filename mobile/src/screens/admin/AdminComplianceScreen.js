// ================================================================
// T1 BROKER MOBILE — ADMIN COMPLIANCE SCREEN
// KYC review queue, compliance alerts, audit log
// ================================================================
import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, SafeAreaView, Alert, Linking } from 'react-native';
import { useStore } from '../../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../../utils/theme';
import api from '../../services/api';

const MOCK_KYC_QUEUE = [
  { id: 1, client: 'Elena Rossi', email: 'elena@example.com', docType: 'passport', submitted: '2025-02-14', status: 'pending', notes: '', risk: 'low' },
  { id: 2, client: 'Yuki Tanaka', email: 'yuki@example.com', docType: 'id_card', submitted: '2025-02-15', status: 'pending', notes: '', risk: 'low' },
  { id: 3, client: 'Alex Rivera', email: 'alex@example.com', docType: 'drivers_license', submitted: '2025-02-15', status: 'pending', notes: 'Blurry photo', risk: 'medium' },
  { id: 4, client: 'Nina Kowalski', email: 'nina@example.com', docType: 'proof_of_address', submitted: '2025-02-16', status: 'pending', notes: 'Utility bill > 3 months old', risk: 'medium' },
];

const MOCK_ALERTS = [
  { id: 1, type: 'suspicious_activity', severity: 'high', message: 'Unusual trading pattern detected for client #1247 — 15 rapid trades in 2 minutes', time: '2025-02-16T10:42:00Z', resolved: false },
  { id: 2, type: 'large_transfer', severity: 'medium', message: 'Wire transfer $250,000 from client David Müller to external account', time: '2025-02-16T09:15:00Z', resolved: false },
  { id: 3, type: 'failed_logins', severity: 'low', message: '5 failed login attempts for account elena@example.com from IP 185.42.x.x', time: '2025-02-16T08:30:00Z', resolved: true },
];

const MOCK_AUDIT = [
  { id: 1, action: 'KYC approved', user: 'Admin Smith', target: 'Sarah Chen', time: '2025-02-16T09:00:00Z', ip: '10.0.1.x' },
  { id: 2, action: 'Order manually approved', user: 'Admin Smith', target: 'ORD-006', time: '2025-02-16T10:30:00Z', ip: '10.0.1.x' },
  { id: 3, action: 'Account frozen', user: 'Compliance Bot', target: 'Client #1247', time: '2025-02-16T10:45:00Z', ip: 'system' },
  { id: 4, action: 'IP blocked', user: 'Security System', target: '185.42.x.x', time: '2025-02-16T08:32:00Z', ip: 'system' },
  { id: 5, action: 'Password reset', user: 'Admin Smith', target: 'Tom Williams', time: '2025-02-15T16:20:00Z', ip: '10.0.1.x' },
];

export default function AdminComplianceScreen() {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);
  const [tab, setTab] = useState('kyc');
  const [kycQueue, setKycQueue] = useState(MOCK_KYC_QUEUE);
  const [alerts, setAlerts] = useState(MOCK_ALERTS);

  const docTypeLabels = { passport: '🛂 Passport', id_card: '🪪 ID Card', drivers_license: '🚗 Driver\'s License', proof_of_address: '📄 Proof of Address', tax_doc: '📋 Tax Document' };
  const severityColors = { high: colors.red, medium: colors.yellow, low: colors.blue };

  function handleApproveKYC(id) {
    Alert.alert('Approve KYC', 'Approve this document?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', onPress: () => {
        setKycQueue(prev => prev.filter(k => k.id !== id));
        api.post(`/admin/kyc/${id}/approve`).catch(() => {});
      }},
    ]);
  }

  function handleRejectKYC(id) {
    Alert.prompt('Reject KYC', 'Enter rejection reason:', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: (reason) => {
        setKycQueue(prev => prev.filter(k => k.id !== id));
        api.post(`/admin/kyc/${id}/reject`, { reason }).catch(() => {});
      }},
    ]);
  }

  function resolveAlert(id) {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, resolved: true } : a));
    api.post(`/admin/alerts/${id}/resolve`).catch(() => {});
  }

  const pendingKYC = kycQueue.filter(k => k.status === 'pending').length;
  const openAlerts = alerts.filter(a => !a.resolved).length;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        <Text style={styles.title}>Compliance</Text>
        <Text style={[styles.subtitle, { marginBottom: Spacing.md }]}>{pendingKYC} pending reviews · {openAlerts} open alerts</Text>

        {/* Tabs */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: Spacing.lg, backgroundColor: colors.bg3, padding: 4, borderRadius: Radius.md }}>
          {[['kyc', `KYC (${pendingKYC})`], ['alerts', `Alerts (${openAlerts})`], ['audit', 'Audit Log']].map(([k, l]) => (
            <TouchableOpacity key={k} onPress={() => setTab(k)} style={{
              flex: 1, paddingVertical: 10, borderRadius: Radius.sm, alignItems: 'center',
              backgroundColor: tab === k ? colors.card : 'transparent',
            }}>
              <Text style={{ ...Fonts.caption, fontWeight: '600', color: tab === k ? colors.text : colors.text3 }}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* KYC Review Queue */}
        {tab === 'kyc' && (
          <>
            {kycQueue.filter(k => k.status === 'pending').map(doc => (
              <View key={doc.id} style={[styles.card, { marginBottom: 8 }]}>
                <View style={styles.spaceBetween}>
                  <View>
                    <Text style={{ ...Fonts.medium, color: colors.text }}>{doc.client}</Text>
                    <Text style={{ ...Fonts.caption, color: colors.text4 }}>{doc.email}</Text>
                  </View>
                  <View style={{ backgroundColor: `${severityColors[doc.risk] || colors.blue}20`, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 }}>
                    <Text style={{ ...Fonts.caption, color: severityColors[doc.risk] || colors.blue, fontWeight: '600' }}>{doc.risk} risk</Text>
                  </View>
                </View>
                <View style={{ marginTop: Spacing.sm }}>
                  <Text style={{ ...Fonts.caption, color: colors.text2 }}>{docTypeLabels[doc.docType] || doc.docType}</Text>
                  <Text style={{ ...Fonts.caption, color: colors.text4 }}>Submitted: {new Date(doc.submitted).toLocaleDateString()}</Text>
                  {doc.notes ? <Text style={{ ...Fonts.caption, color: colors.yellow, marginTop: 4 }}>⚠️ {doc.notes}</Text> : null}
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: Spacing.md }}>
                  <TouchableOpacity onPress={() => Alert.alert('Preview', 'Open document in viewer')}
                    style={{ flex: 1, backgroundColor: colors.blueLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}>
                    <Text style={{ ...Fonts.caption, color: colors.blue, fontWeight: '600' }}>👁 View Doc</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleApproveKYC(doc.id)}
                    style={{ flex: 1, backgroundColor: colors.greenLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}>
                    <Text style={{ ...Fonts.caption, color: colors.green, fontWeight: '700' }}>✓ Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleRejectKYC(doc.id)}
                    style={{ flex: 1, backgroundColor: colors.redLight, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' }}>
                    <Text style={{ ...Fonts.caption, color: colors.red, fontWeight: '700' }}>✗ Reject</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {kycQueue.filter(k => k.status === 'pending').length === 0 && (
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>✅</Text>
                <Text style={styles.emptyText}>All KYC reviews complete</Text>
              </View>
            )}
          </>
        )}

        {/* Compliance Alerts */}
        {tab === 'alerts' && (
          <>
            {alerts.map(alert => (
              <View key={alert.id} style={[styles.card, { marginBottom: 8, opacity: alert.resolved ? 0.5 : 1,
                borderLeftWidth: 3, borderLeftColor: severityColors[alert.severity] }]}>
                <View style={styles.spaceBetween}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <Text style={{ fontSize: 12 }}>
                        {alert.severity === 'high' ? '🔴' : alert.severity === 'medium' ? '🟡' : '🔵'}
                      </Text>
                      <Text style={{ ...Fonts.caption, color: severityColors[alert.severity], fontWeight: '700', textTransform: 'uppercase' }}>
                        {alert.severity} · {alert.type.replace(/_/g, ' ')}
                      </Text>
                    </View>
                    <Text style={{ ...Fonts.regular, color: colors.text, fontSize: 13 }}>{alert.message}</Text>
                    <Text style={{ ...Fonts.caption, color: colors.text4, marginTop: 4 }}>{new Date(alert.time).toLocaleString()}</Text>
                  </View>
                  {!alert.resolved && (
                    <TouchableOpacity onPress={() => resolveAlert(alert.id)}
                      style={{ backgroundColor: colors.greenLight, paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.sm }}>
                      <Text style={{ ...Fonts.caption, color: colors.green, fontWeight: '600' }}>Resolve</Text>
                    </TouchableOpacity>
                  )}
                  {alert.resolved && <Text style={{ ...Fonts.caption, color: colors.green }}>✓ Resolved</Text>}
                </View>
              </View>
            ))}
          </>
        )}

        {/* Audit Log */}
        {tab === 'audit' && (
          <>
            {MOCK_AUDIT.map(entry => (
              <View key={entry.id} style={[styles.card, { marginBottom: 6, padding: 12 }]}>
                <View style={styles.spaceBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ ...Fonts.medium, color: colors.text, fontSize: 13 }}>{entry.action}</Text>
                    <Text style={{ ...Fonts.caption, color: colors.text4 }}>
                      by {entry.user} → {entry.target}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ ...Fonts.caption, color: colors.text4 }}>{new Date(entry.time).toLocaleTimeString()}</Text>
                    <Text style={{ ...Fonts.caption, color: colors.text4 }}>{entry.ip}</Text>
                  </View>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
