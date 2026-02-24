// ================================================================
// T1 BROKER MOBILE — GLOBAL STATE (Zustand)
// ================================================================
import { create } from 'zustand';
import api from '../services/api';

export const useStore = create((set, get) => ({
  // ── Auth ──────────────────────────────────────────────────
  user: null,
  isAuthenticated: false,
  isLoading: true,
  mfaPending: null, // { mfaToken, mfaMethod, emailSent }

  setUser: (user) => set({ user, isAuthenticated: !!user }),

  login: async (email, password) => {
    const res = await api.login(email, password);
    if (res.error) return res;
    if (res.requiresMFA) {
      set({ mfaPending: { mfaToken: res.mfaToken, mfaMethod: res.mfaMethod, emailSent: res.emailSent } });
      return res;
    }
    set({ user: res.user, isAuthenticated: true, mfaPending: null });
    get().loadPortfolio();
    return res;
  },

  verifyMFA: async (code, opts) => {
    const pending = get().mfaPending;
    if (!pending) return { error: 'No MFA session' };
    const res = await api.verifyMFA(code, pending.mfaToken, opts);
    if (res.error) return res;
    set({ user: res.user, isAuthenticated: true, mfaPending: null });
    get().loadPortfolio();
    return res;
  },

  logout: async () => {
    await api.logout();
    set({ user: null, isAuthenticated: false, positions: [], orders: [], balance: null });
  },

  restoreSession: async () => {
    const hasToken = await api.loadTokens();
    if (!hasToken) { set({ isLoading: false }); return false; }
    const user = await api.loadUser();
    if (user) {
      set({ user, isAuthenticated: true, isLoading: false });
      get().loadPortfolio();
      return true;
    }
    // Try fetching profile to validate token
    const profile = await api.getProfile();
    if (profile.error) {
      await api.clearTokens();
      set({ isLoading: false });
      return false;
    }
    set({ user: profile, isAuthenticated: true, isLoading: false });
    return true;
  },

  // ── Portfolio ─────────────────────────────────────────────
  positions: [],
  balance: null,
  portfolioHistory: [],
  portfolioLoading: false,

  loadPortfolio: async () => {
    set({ portfolioLoading: true });
    const [positions, balance, history] = await Promise.all([
      api.getPositions().catch(() => ({ data: [] })),
      api.getBalance().catch(() => null),
      api.getPortfolioHistory().catch(() => ({ data: [] })),
    ]);
    set({
      positions: positions?.data || positions || [],
      balance: balance,
      portfolioHistory: history?.data || [],
      portfolioLoading: false,
    });
  },

  // ── Orders ────────────────────────────────────────────────
  orders: [],
  ordersLoading: false,

  loadOrders: async () => {
    set({ ordersLoading: true });
    const res = await api.getOrders();
    set({ orders: res?.data || [], ordersLoading: false });
  },

  placeOrder: async (order) => {
    const res = await api.placeOrder(order);
    if (!res.error) get().loadOrders();
    return res;
  },

  cancelOrder: async (id) => {
    const res = await api.cancelOrder(id);
    if (!res.error) get().loadOrders();
    return res;
  },

  // ── Watchlist ─────────────────────────────────────────────
  watchlist: [],
  loadWatchlist: async () => {
    const res = await api.getWatchlist();
    set({ watchlist: res?.data || [] });
  },
  toggleWatchlist: async (symbol) => {
    const exists = get().watchlist.find(w => w.symbol === symbol);
    if (exists) { await api.removeFromWatchlist(symbol); }
    else { await api.addToWatchlist(symbol); }
    get().loadWatchlist();
  },

  // ── Alerts ────────────────────────────────────────────────
  alerts: [],
  loadAlerts: async () => {
    const res = await api.getAlerts();
    set({ alerts: res?.data || [] });
  },

  // ── Settings ──────────────────────────────────────────────
  biometricEnabled: false,
  theme: 'dark', // 'dark' | 'light'

  setBiometric: (enabled) => set({ biometricEnabled: enabled }),
  setTheme: (theme) => set({ theme }),
}));
