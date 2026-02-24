// ================================================================
// T1 BROKER — API CLIENT
// Connects frontend to backend REST API + WebSocket
// Falls back to mock data when backend is unavailable
// ================================================================
const API_BASE = '/api/v1';
let authToken = null;
let refreshToken = null;
let wsConnection = null;

class T1API {
  // ----------------------------------------------------------------
  // HTTP helpers
  // ----------------------------------------------------------------
  static async request(method, path, body = null, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (opts.mfaToken) headers['X-MFA-Token'] = opts.mfaToken;

    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    try {
      const res = await fetch(`${API_BASE}${path}`, config);

      // Auto-refresh on 401
      if (res.status === 401 && refreshToken) {
        const refreshed = await this.refreshAuth();
        if (refreshed) {
          headers['Authorization'] = `Bearer ${authToken}`;
          const retry = await fetch(`${API_BASE}${path}`, { ...config, headers });
          return this._handleResponse(retry);
        }
      }

      return this._handleResponse(res);
    } catch (err) {
      console.warn(`API unavailable (${method} ${path}), using mock data`);
      return { error: 'API_UNAVAILABLE', offline: true };
    }
  }

  static async _handleResponse(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: data.error || 'Request failed', code: data.code, status: res.status };
    }
    return data;
  }

  static get(path) { return this.request('GET', path); }
  static post(path, body) { return this.request('POST', path, body); }
  static patch(path, body) { return this.request('PATCH', path, body); }
  static del(path, body) { return this.request('DELETE', path, body); }

  // ----------------------------------------------------------------
  // Auth
  // ----------------------------------------------------------------
  static async login(email, password) {
    const res = await this.post('/auth/login', { email, password });
    if (res.error) return res;

    if (res.requiresMFA) {
      return {
        requiresMFA: true, mfaToken: res.mfaToken,
        mfaMethod: res.mfaMethod, emailSent: res.emailSent,
        riskScore: res.riskScore,
      };
    }

    authToken = res.accessToken;
    refreshToken = res.refreshToken;
    localStorage.setItem('t1_access', authToken);
    localStorage.setItem('t1_refresh', refreshToken);
    this.connectWS();
    return res;
  }

  static async verifyMFA(code, mfaToken, opts = {}) {
    const body = { token: code };
    if (opts.method) body.method = opts.method;       // 'totp', 'email', 'backup'
    if (opts.trustDevice) body.trustDevice = true;
    const res = await this.request('POST', '/auth/mfa/verify', body, { mfaToken });
    if (res.error) return res;

    authToken = res.accessToken;
    refreshToken = res.refreshToken;
    localStorage.setItem('t1_access', authToken);
    localStorage.setItem('t1_refresh', refreshToken);
    this.connectWS();
    return res;
  }

  static async resendEmailCode(mfaToken) {
    return this.request('POST', '/auth/mfa/email/resend', {}, { mfaToken });
  }

  static async refreshAuth() {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await res.json();
      if (data.accessToken) {
        authToken = data.accessToken;
        refreshToken = data.refreshToken;
        localStorage.setItem('t1_access', authToken);
        localStorage.setItem('t1_refresh', refreshToken);
        return true;
      }
    } catch (e) {}
    return false;
  }

  static async logout() {
    await this.post('/auth/logout').catch(() => {});
    authToken = null;
    refreshToken = null;
    localStorage.removeItem('t1_access');
    localStorage.removeItem('t1_refresh');
    if (wsConnection) wsConnection.close();
  }

  static restoreSession() {
    authToken = localStorage.getItem('t1_access');
    refreshToken = localStorage.getItem('t1_refresh');
    return !!authToken;
  }

  // ----------------------------------------------------------------
  // MFA Management
  // ----------------------------------------------------------------
  static async getMFAStatus() { return this.get('/mfa/status'); }

  static async setupTOTP() { return this.post('/mfa/totp/setup'); }
  static async confirmTOTP(code) { return this.post('/mfa/totp/confirm', { code }); }

  static async setupEmailMFA() { return this.post('/mfa/email/setup'); }
  static async confirmEmailMFA(code) { return this.post('/mfa/email/confirm', { code }); }

  static async disableMFA(password) { return this.post('/mfa/disable', { password }); }

  static async regenerateBackupCodes(password) { return this.post('/mfa/backup/regenerate', { password }); }
  static async getBackupCodeCount() { return this.get('/mfa/backup/count'); }

  static async getTrustedDevices() { return this.get('/mfa/devices'); }
  static async revokeTrustedDevice(id) { return this.del(`/mfa/devices/${id}`); }
  static async revokeAllDevices() { return this.del('/mfa/devices'); }

  static async getLoginHistory() { return this.get('/mfa/login-history'); }

  // ----------------------------------------------------------------
  // Orders
  // ----------------------------------------------------------------
  static async placeOrder(order) {
    return this.post('/orders', order);
  }

  static async getOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/orders?${qs}`);
  }

  static async cancelOrder(orderId, reason) {
    return this.del(`/orders/${orderId}`, { reason });
  }

  // ----------------------------------------------------------------
  // Positions
  // ----------------------------------------------------------------
  static async getPositions() {
    return this.get('/positions');
  }

  // ----------------------------------------------------------------
  // Market Data
  // ----------------------------------------------------------------
  static async searchInstruments(search, assetClass) {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (assetClass) params.set('assetClass', assetClass);
    return this.get(`/market/instruments?${params}`);
  }

  static async getQuote(symbol) {
    return this.get(`/market/quotes/${symbol}`);
  }

  static async getWatchlist() {
    return this.get('/market/watchlist');
  }

  // ----------------------------------------------------------------
  // Client
  // ----------------------------------------------------------------
  static async getProfile() {
    return this.get('/clients/me');
  }

  static async getClients(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/clients?${qs}`);
  }

  static async getClient(id) {
    return this.get(`/clients/${id}`);
  }

  static async createClient(data) {
    return this.post('/clients', data);
  }

  static async updateClient(id, data) {
    return this.patch(`/clients/${id}`, data);
  }

  // ----------------------------------------------------------------
  // Transfers
  // ----------------------------------------------------------------
  static async createTransfer(data) {
    return this.post('/transfers', data);
  }

  static async getTransfers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/transfers?${qs}`);
  }

  // ----------------------------------------------------------------
  // Admin
  // ----------------------------------------------------------------
  static async getDashboard() {
    return this.get('/admin/dashboard');
  }

  static async getAuditLog(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/admin/audit?${qs}`);
  }

  static async getPartners() {
    return this.get('/partners');
  }

  static async getReport(type, startDate, endDate) {
    return this.get(`/admin/reports/${type}?startDate=${startDate}&endDate=${endDate}`);
  }

  static async approveTransfer(id) {
    return this.post(`/admin/transfers/${id}/approve`);
  }

  static async getReconciliation() {
    return this.get('/admin/reconciliation');
  }

  // ----------------------------------------------------------------
  // WebSocket
  // ----------------------------------------------------------------
  static connectWS() {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsConnection = new WebSocket(`${protocol}//${window.location.host}/ws`);

    wsConnection.onopen = () => {
      console.log('🔌 WebSocket connected');
      // Authenticate
      wsConnection.send(JSON.stringify({ type: 'auth', token: authToken }));
    };

    wsConnection.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleWSMessage(msg);
      } catch (e) {}
    };

    wsConnection.onclose = () => {
      console.log('WebSocket disconnected — reconnecting in 5s');
      setTimeout(() => {
        if (authToken) this.connectWS();
      }, 5000);
    };

    wsConnection.onerror = (err) => {
      console.warn('WebSocket error', err);
    };
  }

  static subscribeMarket(symbols) {
    if (wsConnection?.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({
        type: 'subscribe',
        channels: symbols.map(s => `market:${s}`),
      }));
    }
  }

  static subscribeAdmin() {
    if (wsConnection?.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({ type: 'subscribe', channels: ['admin'] }));
    }
  }

  static _handleWSMessage(msg) {
    switch (msg.type) {
      case 'authenticated':
        console.log('✅ WS authenticated');
        break;
      case 'market_data':
        // Update watchlist prices in real-time
        if (typeof window.onMarketData === 'function') {
          window.onMarketData(msg.symbol, msg.data);
        }
        break;
      case 'order_update':
        if (typeof window.onOrderUpdate === 'function') {
          window.onOrderUpdate(msg.data);
        }
        if (typeof toast === 'function') {
          toast(`Order ${msg.data.orderId}: ${msg.data.status}`, 's');
        }
        break;
      case 'notification':
        if (typeof toast === 'function') {
          toast(msg.data.message, 'i');
        }
        break;
      case 'admin_event':
        if (typeof window.onAdminEvent === 'function') {
          window.onAdminEvent(msg.data);
        }
        break;
    }
  }
}

// Make globally available
window.T1API = T1API;

// ================================================================
// Wire up login to use API when available
// ================================================================
const _originalLogin = window.doLogin;
window.doLogin = async function () {
  const email = document.querySelector('.linput[type="email"]').value;
  const password = document.querySelector('.linput[type="password"]').value;

  const res = await T1API.login(email, password);

  if (res.offline) {
    // Fall back to mock login
    if (typeof _originalLogin === 'function') _originalLogin();
    return;
  }

  if (res.requiresMFA) {
    // Show MFA input modal
    showModal('Two-Factor Authentication', `
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:40px;margin-bottom:8px">🔐</div>
        <div style="font-size:14px;color:var(--t2)">Enter the 6-digit code from your authenticator app</div>
      </div>
      <div class="fg">
        <input class="input mono" id="mfaInput" maxlength="6" placeholder="000000"
               style="font-size:28px;text-align:center;letter-spacing:8px;padding:16px"
               oninput="if(this.value.length===6)document.getElementById('mfaSubmit').click()">
      </div>
    `, `
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mfaSubmit" onclick="verifyMFA('${res.mfaToken}')">Verify</button>
    `);
    setTimeout(() => document.getElementById('mfaInput')?.focus(), 200);
    return;
  }

  if (res.error) {
    toast(res.error, 'e');
    return;
  }

  // Successful API login
  const user = res.user;
  S.user = {
    id: user.id,
    name: user.email.split('@')[0],
    email: user.email,
    role: user.role === 'client' ? 'Client' : user.role === 'partner_admin' ? 'Partner' : 'Admin',
    ini: user.email.substring(0, 2).toUpperCase(),
  };
  S.role = user.role === 'client' ? 'client' : user.role === 'partner_admin' ? 'partner' : 'admin';

  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('appShell').classList.add('show');
  document.getElementById('uavTop').textContent = S.user.ini;
  document.getElementById('unTop').textContent = S.user.name;
  document.getElementById('urTop').textContent = S.user.role;

  buildNav();
  nav(S.role === 'client' ? 'trading' : 'admin-dash');
  toast(`Welcome back!`, 's');
};

window.verifyMFA = async function (mfaToken) {
  const code = document.getElementById('mfaInput').value;
  const res = await T1API.verifyMFA(code, mfaToken);
  if (res.error) {
    toast(res.error, 'e');
    return;
  }
  closeModal();

  // Proceed directly to authenticated state (don't re-call doLogin)
  const user = res.user;
  S.user = {
    id: user.id,
    name: user.email.split('@')[0],
    email: user.email,
    role: user.role === 'client' ? 'Client' : user.role === 'partner_admin' ? 'Partner' : 'Admin',
    ini: user.email.substring(0, 2).toUpperCase(),
  };
  S.role = user.role === 'client' ? 'client' : user.role === 'partner_admin' ? 'partner' : 'admin';

  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('appShell').classList.add('show');
  document.getElementById('uavTop').textContent = S.user.ini;
  document.getElementById('unTop').textContent = S.user.name;
  document.getElementById('urTop').textContent = S.user.role;

  buildNav();
  nav(S.role === 'client' ? 'trading' : 'admin-dash');
  toast('Welcome back!', 's');
};

// ================================================================
// Wire up order placement to use API
// ================================================================
const _originalSubOrd = window.subOrd;
window.subOrd = async function () {
  const w = WL[S.sym];
  const qty = parseInt(document.getElementById('qI')?.value) || 0;
  const orderType = document.getElementById('oType')?.value?.toLowerCase()?.replace(' ', '_') || 'market';
  const limitPrice = document.getElementById('lpI')?.value;

  // Resolve instrument UUID from symbol (backend requires UUID)
  let instrumentId = w.uuid; // cached from prior lookup
  if (!instrumentId) {
    const lookup = await T1API.searchInstruments(w.s);
    if (lookup.offline) {
      if (typeof _originalSubOrd === 'function') _originalSubOrd();
      return;
    }
    const match = lookup.data?.find(i => i.symbol === w.s);
    if (match) {
      instrumentId = match.id;
      w.uuid = match.id; // cache for next time
    } else {
      toast(`Instrument ${w.s} not found`, 'e');
      return;
    }
  }

  const res = await T1API.placeOrder({
    instrumentId,
    side: S.side,
    orderType,
    quantity: qty,
    price: ['limit', 'stop_limit'].includes(orderType) ? parseFloat(limitPrice) : undefined,
    timeInForce: 'day',
  });

  if (res.offline) {
    if (typeof _originalSubOrd === 'function') _originalSubOrd();
    return;
  }

  if (res.error) {
    toast(res.error, 'e');
    return;
  }

  const btn = document.getElementById('subO');
  btn.textContent = '✓ Order Submitted';
  btn.style.opacity = '.7';
  toast(`Order ${res.order_ref || 'submitted'} — ${w.s} ${S.side} ${qty}`, 's');
  setTimeout(() => { btn.style.opacity = '1'; updOS(); }, 2000);
};

console.log('🔗 T1 API Client loaded — connects to backend when available, falls back to mock data');
