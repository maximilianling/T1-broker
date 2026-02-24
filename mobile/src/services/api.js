// ================================================================
// T1 BROKER MOBILE — API SERVICE
// Secure token storage, request interceptor, auto-refresh
// ================================================================
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const API_URL = Constants.expoConfig?.extra?.apiUrl || 'https://api.t1broker.com/api/v1';
const WS_URL = Constants.expoConfig?.extra?.wsUrl || 'wss://api.t1broker.com/ws';

// Secure token keys
const TOKEN_KEY = 't1_access_token';
const REFRESH_KEY = 't1_refresh_token';
const BIOMETRIC_KEY = 't1_biometric_enabled';
const USER_KEY = 't1_user_data';

class ApiService {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.refreshPromise = null;
    this.ws = null;
    this.wsListeners = new Map();
    this.baseHeaders = {
      'Content-Type': 'application/json',
      'X-Client-Platform': Platform.OS,
      'X-Client-Version': Constants.expoConfig?.version || '1.0.0',
      'X-Device-Model': Device.modelName || 'unknown',
    };
  }

  // ================================================================
  // TOKEN MANAGEMENT (Secure Store)
  // ================================================================
  async saveTokens(access, refresh) {
    this.accessToken = access;
    this.refreshToken = refresh;
    await SecureStore.setItemAsync(TOKEN_KEY, access);
    await SecureStore.setItemAsync(REFRESH_KEY, refresh);
  }

  async loadTokens() {
    this.accessToken = await SecureStore.getItemAsync(TOKEN_KEY);
    this.refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
    return !!this.accessToken;
  }

  async clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
  }

  async saveUser(user) {
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
  }

  async loadUser() {
    const data = await SecureStore.getItemAsync(USER_KEY);
    return data ? JSON.parse(data) : null;
  }

  // ================================================================
  // HTTP CLIENT
  // ================================================================
  async request(method, path, body = null, extraHeaders = {}) {
    const url = `${API_URL}${path}`;
    const headers = { ...this.baseHeaders, ...extraHeaders };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const opts = { method, headers };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    try {
      let res = await fetch(url, opts);

      // Auto-refresh on 401
      if (res.status === 401 && this.refreshToken && !path.includes('/auth/')) {
        const refreshed = await this.refreshAuth();
        if (refreshed) {
          headers['Authorization'] = `Bearer ${this.accessToken}`;
          res = await fetch(url, { ...opts, headers });
        }
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { error: data.error || `Request failed (${res.status})`, status: res.status, ...data };
      }

      return data;
    } catch (err) {
      if (err.message?.includes('Network request failed')) {
        return { error: 'No internet connection', offline: true };
      }
      return { error: err.message || 'Request failed' };
    }
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  del(path) { return this.request('DELETE', path); }

  // Multipart file upload (for KYC documents, profile photos, etc.)
  async uploadFile(path, formData) {
    try {
      if (!this.accessToken) await this.refreshAccessToken();

      const response = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: {
          ...this.baseHeaders,
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: formData,
      });

      const data = await response.json();

      if (response.status === 401) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) return this.uploadFile(path, formData);
        return { error: 'Session expired' };
      }

      if (!response.ok) return { error: data.error || data.message || `Upload failed (${response.status})` };
      return data;
    } catch (err) {
      return { error: err.message || 'Upload failed' };
    }
  }

  // ================================================================
  // AUTH
  // ================================================================
  async login(email, password) {
    const res = await this.post('/auth/login', { email, password });
    if (res.error) return res;

    if (res.requiresMFA) {
      return {
        requiresMFA: true, mfaToken: res.mfaToken,
        mfaMethod: res.mfaMethod, emailSent: res.emailSent,
        riskScore: res.riskScore,
      };
    }

    await this.saveTokens(res.accessToken, res.refreshToken);
    await this.saveUser(res.user);
    this.registerPushToken().catch(() => {});
    return res;
  }

  async verifyMFA(code, mfaToken, opts = {}) {
    const body = { token: code };
    if (opts.method) body.method = opts.method;
    if (opts.trustDevice) body.trustDevice = true;

    const res = await this.request('POST', '/auth/mfa/verify', body, {
      'X-MFA-Token': mfaToken,
    });
    if (res.error) return res;

    await this.saveTokens(res.accessToken, res.refreshToken);
    await this.saveUser(res.user);
    this.registerPushToken().catch(() => {});
    return res;
  }

  async resendEmailCode(mfaToken) {
    return this.request('POST', '/auth/mfa/email/resend', {}, {
      'X-MFA-Token': mfaToken,
    });
  }

  async refreshAuth() {
    // Prevent concurrent refresh
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        const data = await res.json();
        if (data.accessToken) {
          await this.saveTokens(data.accessToken, data.refreshToken);
          return true;
        }
      } catch (e) {}
      await this.clearTokens();
      return false;
    })();

    const result = await this.refreshPromise;
    this.refreshPromise = null;
    return result;
  }

  async logout() {
    await this.post('/auth/logout').catch(() => {});
    this.disconnectWS();
    await this.clearTokens();
  }

  // ================================================================
  // BIOMETRIC AUTH
  // ================================================================
  async enableBiometric() {
    await SecureStore.setItemAsync(BIOMETRIC_KEY, 'true');
  }

  async disableBiometric() {
    await SecureStore.deleteItemAsync(BIOMETRIC_KEY);
  }

  async isBiometricEnabled() {
    return (await SecureStore.getItemAsync(BIOMETRIC_KEY)) === 'true';
  }

  // ================================================================
  // PUSH NOTIFICATIONS
  // ================================================================
  async registerPushToken() {
    if (!Device.isDevice) return;

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return;

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
    });

    // Register with backend
    await this.post('/notifications/push-token', {
      token: tokenData.data,
      platform: Platform.OS,
      deviceName: Device.modelName,
    });

    return tokenData.data;
  }

  // ================================================================
  // TRADING
  // ================================================================
  async placeOrder(order) { return this.post('/orders', order); }
  async getOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/orders${qs ? '?' + qs : ''}`);
  }
  async cancelOrder(id) { return this.del(`/orders/${id}`); }

  // ================================================================
  // PORTFOLIO
  // ================================================================
  async getPositions() { return this.get('/positions'); }
  async getPortfolioSummary() { return this.get('/portfolio/summary'); }
  async getPortfolioHistory(period = '1M') { return this.get(`/portfolio/history?period=${period}`); }

  // ================================================================
  // MARKET DATA
  // ================================================================
  async searchInstruments(query) { return this.get(`/market/instruments?search=${encodeURIComponent(query)}`); }
  async getQuote(symbol) { return this.get(`/market/quotes/${symbol}`); }

  // ================================================================
  // WATCHLIST
  // ================================================================
  async getWatchlist() { return this.get('/watchlist'); }
  async addToWatchlist(symbol) { return this.post('/watchlist', { symbol }); }
  async removeFromWatchlist(symbol) { return this.del(`/watchlist/${symbol}`); }

  // ================================================================
  // PRICE ALERTS
  // ================================================================
  async getAlerts() { return this.get('/alerts'); }
  async createAlert(alert) { return this.post('/alerts', alert); }
  async deleteAlert(id) { return this.del(`/alerts/${id}`); }

  // ================================================================
  // WALLET / FUNDING (Fiat)
  // ================================================================
  async getBalance() { return this.get('/wallet/balance'); }
  async deposit(amount, method) { return this.post('/wallet/deposit', { amount, method }); }
  async withdraw(amount, bankAccountId) { return this.post('/wallet/withdraw', { amount, bankAccountId }); }
  async getTransferHistory() { return this.get('/wallet/history'); }

  // ================================================================
  // CRYPTO WALLETS
  // ================================================================
  async getCryptoAccounts() { return this.get('/crypto/accounts'); }
  async createCryptoAccount(blockchain) { return this.post('/crypto/accounts', { blockchain }); }
  async requestCryptoWithdrawal({ blockchain, toAddress, amount, tokenSymbol, tokenContract }) {
    return this.post('/crypto/withdraw', { blockchain, toAddress, amount, tokenSymbol, tokenContract });
  }
  async getCryptoTransactions(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/crypto/transactions${query ? '?' + query : ''}`);
  }
  async getSupportedTokens(blockchain) {
    return this.get(`/crypto/tokens${blockchain ? '?blockchain=' + blockchain : ''}`);
  }

  // ================================================================
  // MFA MANAGEMENT
  // ================================================================
  async getMFAStatus() { return this.get('/mfa/status'); }
  async setupTOTP() { return this.post('/mfa/totp/setup'); }
  async confirmTOTP(code) { return this.post('/mfa/totp/confirm', { code }); }
  async setupEmailMFA() { return this.post('/mfa/email/setup'); }
  async confirmEmailMFA(code) { return this.post('/mfa/email/confirm', { code }); }
  async disableMFA(password) { return this.post('/mfa/disable', { password }); }
  async getTrustedDevices() { return this.get('/mfa/devices'); }
  async revokeDevice(id) { return this.del(`/mfa/devices/${id}`); }

  // ================================================================
  // ACCOUNT
  // ================================================================
  async getProfile() { return this.get('/clients/me'); }
  async updateProfile(data) { return this.patch('/clients/me', data); }
  async getLoginHistory() { return this.get('/mfa/login-history'); }

  // ================================================================
  // WEBSOCKET (live prices + order updates)
  // ================================================================
  connectWS() {
    if (this.ws) return;
    try {
      this.ws = new WebSocket(`${WS_URL}?token=${this.accessToken}`);
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          const listeners = this.wsListeners.get(msg.type) || [];
          listeners.forEach(fn => fn(msg.data));
        } catch (err) {}
      };
      this.ws.onclose = () => {
        this.ws = null;
        // Auto-reconnect after 5s
        setTimeout(() => { if (this.accessToken) this.connectWS(); }, 5000);
      };
      this.ws.onerror = () => { this.ws?.close(); };
    } catch (e) {}
  }

  disconnectWS() {
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  onWS(type, callback) {
    if (!this.wsListeners.has(type)) this.wsListeners.set(type, []);
    this.wsListeners.get(type).push(callback);
    return () => {
      const arr = this.wsListeners.get(type) || [];
      this.wsListeners.set(type, arr.filter(fn => fn !== callback));
    };
  }

  subscribe(symbols) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', symbols }));
    }
  }
}

export default new ApiService();
