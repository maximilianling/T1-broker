// ================================================================
// T1 BROKER — DRIVEWEALTH API INTEGRATION SERVICE
// Handles: US equities, ETFs, fractional shares
// Docs: https://developer.drivewealth.com
// ================================================================
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class DriveWealthService {
  constructor() {
    this.baseUrl = config.drivewealth.baseUrl;
    this.sessionToken = null;
    this.tokenExpiry = null;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.client.interceptors.request.use(async (cfg) => {
      const token = await this.getSessionToken();
      cfg.headers['dw-auth-token'] = token;
      return cfg;
    });

    this.client.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        logger.error('DriveWealth API error', {
          status,
          data: err.response?.data,
          url: err.config?.url,
        });
        if (status === 401) this.sessionToken = null;
        throw err;
      }
    );
  }

  // ----------------------------------------------------------------
  // Authentication
  // ----------------------------------------------------------------
  async getSessionToken() {
    if (this.sessionToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.sessionToken;
    }

    try {
      const res = await axios.post(`${this.baseUrl}/auth/tokens`, {
        clientID: config.drivewealth.apiKey,
        clientSecret: config.drivewealth.apiSecret,
      });

      this.sessionToken = res.data.access_token;
      this.tokenExpiry = new Date(Date.now() + 3500 * 1000); // ~1 hour
      logger.info('DriveWealth token refreshed');
      return this.sessionToken;
    } catch (err) {
      logger.error('DriveWealth auth failed', { error: err.message });
      throw new Error('DriveWealth authentication failed');
    }
  }

  // ----------------------------------------------------------------
  // Instruments
  // ----------------------------------------------------------------
  async searchInstruments(symbol) {
    const res = await this.client.get('/instruments', {
      params: { symbol, status: 'ACTIVE' },
    });
    return res.data;
  }

  async getInstrument(instrumentId) {
    const res = await this.client.get(`/instruments/${instrumentId}`);
    return res.data;
  }

  async getMarketData(instrumentId) {
    const res = await this.client.get(`/marketdata/quotes/${instrumentId}`);
    return res.data;
  }

  // ----------------------------------------------------------------
  // Account Management (Omnibus sub-accounts)
  // ----------------------------------------------------------------
  async createAccount(userDetails) {
    const res = await this.client.post('/accounts', {
      userID: userDetails.userId,
      accountType: 'LIVE',
      accountManagementType: 'SELF',
      tradingType: 'CASH',
      currency: userDetails.currency || 'USD',
      metadata: {
        t1ClientId: userDetails.clientId,
        t1PartnerId: userDetails.partnerId,
      },
    });

    logger.info('DriveWealth account created', {
      accountId: res.data.id,
      clientId: userDetails.clientId,
    });

    return res.data;
  }

  async getAccount(accountId) {
    const res = await this.client.get(`/accounts/${accountId}`);
    return res.data;
  }

  async getAccountSummary(accountId) {
    const res = await this.client.get(`/accounts/${accountId}/summary`);
    return res.data;
  }

  // ----------------------------------------------------------------
  // Order Management
  // ----------------------------------------------------------------
  async placeOrder(accountId, { instrumentId, side, orderType, quantity, price }) {
    const orderData = {
      accountID: accountId,
      instrumentID: instrumentId,
      side: side.toUpperCase(),
      type: this._mapOrderType(orderType),
      quantity: quantity.toString(),
    };

    if (['LIMIT', 'STOP_LIMIT'].includes(orderData.type) && price) {
      orderData.price = price.toString();
    }

    // Add idempotency key to prevent duplicate orders
    const idempotencyKey = `T1-${accountId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const res = await this.client.post('/orders', orderData, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });

    logger.info('DriveWealth order placed', {
      orderId: res.data.id,
      accountId,
      side,
      quantity,
      instrumentId,
    });

    return {
      brokerOrderId: res.data.id,
      status: this._mapStatus(res.data.status),
      idempotencyKey,
    };
  }

  async cancelOrder(orderId) {
    const res = await this.client.delete(`/orders/${orderId}`);
    logger.info('DriveWealth order cancelled', { orderId });
    return res.data;
  }

  async getOrder(orderId) {
    const res = await this.client.get(`/orders/${orderId}`);
    return res.data;
  }

  async getOrders(accountId, status) {
    const params = { accountID: accountId };
    if (status) params.status = status;
    const res = await this.client.get('/orders', { params });
    return res.data;
  }

  // ----------------------------------------------------------------
  // Positions
  // ----------------------------------------------------------------
  async getPositions(accountId) {
    const res = await this.client.get(`/accounts/${accountId}/positions`);
    return res.data;
  }

  async getPosition(accountId, instrumentId) {
    const res = await this.client.get(`/accounts/${accountId}/positions/${instrumentId}`);
    return res.data;
  }

  // ----------------------------------------------------------------
  // Funding (Deposits / Withdrawals via omnibus)
  // ----------------------------------------------------------------
  async createDeposit(accountId, amount, currency = 'USD') {
    const res = await this.client.post('/funding/deposits', {
      accountID: accountId,
      amount: amount.toString(),
      currency,
      type: 'WIRE',
    });
    return res.data;
  }

  async createWithdrawal(accountId, amount, currency = 'USD') {
    const res = await this.client.post('/funding/withdrawals', {
      accountID: accountId,
      amount: amount.toString(),
      currency,
    });
    return res.data;
  }

  // ----------------------------------------------------------------
  // Statements & Reports
  // ----------------------------------------------------------------
  async getStatements(accountId, startDate, endDate) {
    const res = await this.client.get(`/accounts/${accountId}/statements`, {
      params: { from: startDate, to: endDate },
    });
    return res.data;
  }

  async getTransactions(accountId, startDate, endDate) {
    const res = await this.client.get(`/accounts/${accountId}/transactions`, {
      params: { from: startDate, to: endDate },
    });
    return res.data;
  }

  // ----------------------------------------------------------------
  // WebSocket streaming
  // ----------------------------------------------------------------
  createMarketDataStream(instrumentIds) {
    // In production: establish WebSocket to DW streaming endpoint
    return {
      url: config.drivewealth.wsUrl,
      instruments: instrumentIds,
      channels: ['quotes', 'trades'],
    };
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  _mapOrderType(type) {
    const map = {
      market: 'MARKET',
      limit: 'LIMIT',
      stop: 'STOP',
      stop_limit: 'STOP_LIMIT',
      trailing_stop: 'TRAILING_STOP',
    };
    return map[type] || 'MARKET';
  }

  _mapStatus(dwStatus) {
    const map = {
      NEW: 'submitted',
      PARTIAL_FILL: 'partially_filled',
      FILL: 'filled',
      CANCELED: 'cancelled',
      REJECTED: 'rejected',
    };
    return map[dwStatus] || 'pending';
  }
}

module.exports = new DriveWealthService();
