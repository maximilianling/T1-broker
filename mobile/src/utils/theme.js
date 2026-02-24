// ================================================================
// T1 BROKER MOBILE — DESIGN SYSTEM
// ================================================================
import { StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export const Colors = {
  dark: {
    bg: '#0a0f1c', bg2: '#111827', bg3: '#1e293b',
    card: '#151d2e', cardBorder: '#1e293b',
    text: '#f0f4ff', text2: '#94a3b8', text3: '#64748b', text4: '#475569',
    blue: '#3b82f6', blueLight: 'rgba(59,130,246,0.15)',
    green: '#22c55e', greenLight: 'rgba(34,197,94,0.15)',
    red: '#ef4444', redLight: 'rgba(239,68,68,0.15)',
    yellow: '#f59e0b', yellowLight: 'rgba(245,158,11,0.15)',
    purple: '#a855f7', purpleLight: 'rgba(168,85,247,0.15)',
    border: '#1e293b', inputBg: '#111827',
    tabBar: '#0d1321', tabActive: '#3b82f6', tabInactive: '#475569',
    statusBar: 'light',
  },
  light: {
    bg: '#f8fafc', bg2: '#ffffff', bg3: '#f1f5f9',
    card: '#ffffff', cardBorder: '#e2e8f0',
    text: '#0f172a', text2: '#475569', text3: '#94a3b8', text4: '#cbd5e1',
    blue: '#2563eb', blueLight: 'rgba(37,99,235,0.1)',
    green: '#16a34a', greenLight: 'rgba(22,163,74,0.1)',
    red: '#dc2626', redLight: 'rgba(220,38,38,0.1)',
    yellow: '#d97706', yellowLight: 'rgba(217,119,6,0.1)',
    purple: '#9333ea', purpleLight: 'rgba(147,51,234,0.1)',
    border: '#e2e8f0', inputBg: '#f1f5f9',
    tabBar: '#ffffff', tabActive: '#2563eb', tabInactive: '#94a3b8',
    statusBar: 'dark',
  },
};

export const Spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
export const Radius = { sm: 6, md: 12, lg: 16, xl: 24, full: 999 };

export const Fonts = {
  regular: { fontSize: 14, fontWeight: '400' },
  medium: { fontSize: 14, fontWeight: '500' },
  semibold: { fontSize: 14, fontWeight: '600' },
  bold: { fontSize: 14, fontWeight: '700' },
  h1: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
  h2: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  h3: { fontSize: 18, fontWeight: '600' },
  caption: { fontSize: 12, fontWeight: '400' },
  mono: { fontSize: 14, fontWeight: '500', fontFamily: 'Courier' },
  monoLg: { fontSize: 20, fontWeight: '700', fontFamily: 'Courier' },
};

export const createStyles = (colors) => StyleSheet.create({
  // Layout
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, paddingHorizontal: Spacing.md },
  scrollContent: { paddingBottom: 100 },
  row: { flexDirection: 'row', alignItems: 'center' },
  spaceBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },

  // Cards
  card: {
    backgroundColor: colors.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  cardTitle: { ...Fonts.semibold, color: colors.text, fontSize: 16 },

  // Stats
  statRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  statCard: {
    flex: 1, backgroundColor: colors.card, borderRadius: Radius.md,
    padding: Spacing.md, borderWidth: 1, borderColor: colors.cardBorder,
  },
  statLabel: { ...Fonts.caption, color: colors.text3, marginBottom: 2 },
  statValue: { ...Fonts.monoLg, color: colors.text },

  // Inputs
  input: {
    backgroundColor: colors.inputBg, borderRadius: Radius.md,
    paddingHorizontal: Spacing.md, paddingVertical: 14,
    color: colors.text, fontSize: 16, borderWidth: 1, borderColor: colors.border,
  },
  inputLabel: { ...Fonts.caption, color: colors.text3, marginBottom: Spacing.xs, textTransform: 'uppercase', letterSpacing: 1 },

  // Buttons
  btnPrimary: {
    backgroundColor: colors.blue, borderRadius: Radius.md,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
  },
  btnPrimaryText: { color: '#fff', ...Fonts.semibold, fontSize: 16 },
  btnGhost: {
    borderWidth: 1, borderColor: colors.border, borderRadius: Radius.md,
    paddingVertical: 12, alignItems: 'center',
  },
  btnGhostText: { color: colors.text2, ...Fonts.medium },
  btnDanger: {
    backgroundColor: colors.redLight, borderRadius: Radius.md,
    paddingVertical: 12, alignItems: 'center',
  },
  btnDangerText: { color: colors.red, ...Fonts.semibold },

  // Badges
  badge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.full,
    ...Fonts.caption, fontWeight: '600', overflow: 'hidden',
  },
  badgeGreen: { backgroundColor: colors.greenLight, color: colors.green },
  badgeRed: { backgroundColor: colors.redLight, color: colors.red },
  badgeBlue: { backgroundColor: colors.blueLight, color: colors.blue },
  badgeYellow: { backgroundColor: colors.yellowLight, color: colors.yellow },

  // List items
  listItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  listTitle: { ...Fonts.medium, color: colors.text },
  listSub: { ...Fonts.caption, color: colors.text3, marginTop: 2 },

  // Typography
  title: { ...Fonts.h1, color: colors.text },
  subtitle: { ...Fonts.regular, color: colors.text3, marginTop: 4 },
  sectionTitle: { ...Fonts.h3, color: colors.text, marginBottom: Spacing.md, marginTop: Spacing.lg },
  mono: { ...Fonts.mono, color: colors.text },
  green: { color: colors.green },
  red: { color: colors.red },

  // Separator
  separator: { height: 1, backgroundColor: colors.border, marginVertical: Spacing.md },

  // Empty state
  empty: { alignItems: 'center', paddingVertical: Spacing.xxl },
  emptyIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { ...Fonts.medium, color: colors.text3, textAlign: 'center' },
});

export { SCREEN_W, SCREEN_H };
