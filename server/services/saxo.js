// ================================================================
// T1 BROKER — SAXO BANK OPENAPI INTEGRATION SERVICE
// Handles: FX, options, bonds, CFDs, listed derivatives
// Docs: https://www.developer.saxo/openapi/learn
// ================================================================
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');

class SaxoService {
  constructor() {
    this.baseUrl = config.saxo.baseUrl;
    this.appKey = config.saxo.appKey;
    this.accessToken = null;
    this.tokenExpiry = null;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Request interceptor to add auth
    this.client.interceptors.request.use(async (cfg) => {
      const token = await this.getAccessToken();
      cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        const data = err.response?.data;
        logger.error('Saxo API error', { status, data, url: err.config?.url });

        if (status === 401) {
          this.accessToken = null; // Force re-auth
        }
        throw err;
      }
    );
  }

  // ----------------------------------------------------------------
  // Authentication (OAuth2)
  // ----------------------------------------------------------------
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const res = await axios.post(config.saxo.tokenEndpoint, null, {
        params: {
          grant_type: 'client_credentials',
          client_id: config.saxo.appKey,
          client_secret: config.saxo.appSecret,
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      this.accessToken = res.data.access_token;
      this.tokenExpiry = new Date(Date.now() + (res.data.expires_in - 60) * 1000);
      logger.info('Saxo token refreshed');
      return this.accessToken;
    } catch (err) {
      logger.error('Saxo auth failed', { error: err.message });
      throw new Error('Saxo Bank authentication failed');
    }
  }

  // ----------------------------------------------------------------
  // Instruments
  // ----------------------------------------------------------------
  async searchInstruments(keyword, assetTypes = ['FxSpot', 'Stock', 'Bond', 'CfdOnIndex']) {
    const res = await this.client.get('/ref/v1/instruments', {
      params: {
        Keywords: keyword,
        AssetTypes: assetTypes.join(','),
        IncludeNonTradable: false,
      },
    });
    return res.data.Data || [];
  }

  async getInstrumentDetails(uic, assetType) {
    const res = await this.client.get(`/ref/v1/instruments/details/${uic}/${assetType}`);
    return res.data;
  }

  // ----------------------------------------------------------------
  // Market Data
  // ----------------------------------------------------------------
  async getQuote(uic, assetType) {
    const res = await this.client.get('/trade/v1/infoprices', {
      params: { Uic: uic, AssetType: assetType, FieldGroups: 'DisplayAndFormat,InstrumentPriceDetails,Quote' },
    });
    return res.data;
  }

  async getQuotes(uics, assetType) {
    const res = await this.client.get('/trade/v1/infoprices/list', {
      params: { Uics: uics.join(','), AssetType: assetType, FieldGroups: 'DisplayAndFormat,Quote' },
    });
    return res.data.Data || [];
  }

  // ----------------------------------------------------------------
  // Order Management
  // ----------------------------------------------------------------
  async placeOrder(accountKey, { uic, assetType, side, orderType, quantity, price, durationType = 'DayOrder' }) {
    const orderData = {
      AccountKey: accountKey,
      Uic: uic,
      AssetType: assetType,
      BuySell: side === 'buy' ? 'Buy' : 'Sell',
      Amount: quantity,
      OrderType: this._mapOrderType(orderType),
      OrderDuration: { DurationType: durationType },
      ManualOrder: false,
      ExternalReference: `T1-${Date.now()}`,
    };

    if (['limit', 'stop_limit'].includes(orderType) && price) {
      orderData.OrderPrice = price;
    }

    const res = await this.client.post('/trade/v2/orders', orderData);

    logger.info('Saxo order placed', {
      orderId: res.data.OrderId,
      uic,
      side,
      quantity,
      orderType,
    });

    return {
      brokerOrderId: res.data.OrderId,
      externalReference: orderData.ExternalReference,
      status: 'submitted',
    };
  }

  async cancelOrder(accountKey, orderId) {
    const res = await this.client.delete(`/trade/v2/orders/${orderId}`, {
      params: { AccountKey: accountKey },
    });
    logger.info('Saxo order cancelled', { orderId });
    return res.data;
  }

  async modifyOrder(accountKey, orderId, changes) {
    const res = await this.client.patch(`/trade/v2/orders/${orderId}`, {
      AccountKey: accountKey,
      ...changes,
    });
    return res.data;
  }

  async getOrders(accountKey, status = 'Working') {
    const res = await this.client.get('/port/v1/orders/me', {
      params: { AccountKey: accountKey, Status: status },
    });
    return res.data.Data || [];
  }

  // ----------------------------------------------------------------
  // Positions
  // ----------------------------------------------------------------
  async getPositions(accountKey) {
    const res = await this.client.get('/port/v1/positions/me', {
      params: { AccountKey: accountKey, FieldGroups: 'DisplayAndFormat,PositionBase,PositionView' },
    });
    return res.data.Data || [];
  }

  async getNetPositions(accountKey) {
    const res = await this.client.get('/port/v1/netpositions/me', {
      params: { AccountKey: accountKey },
    });
    return res.data.Data || [];
  }

  // ----------------------------------------------------------------
  // Account / Balance
  // ----------------------------------------------------------------
  async getAccountBalance(accountKey) {
    const res = await this.client.get('/port/v1/balances', {
      params: { AccountKey: accountKey, FieldGroups: 'All' },
    });
    return res.data;
  }

  async getAccounts(clientKey) {
    const res = await this.client.get('/port/v1/accounts/me', {
      params: { ClientKey: clientKey },
    });
    return res.data.Data || [];
  }

  // ----------------------------------------------------------------
  // Streaming (WebSocket subscription setup)
  // ----------------------------------------------------------------
  createPriceSubscription(uics, assetType, contextId) {
    // In production, this sets up a Saxo streaming subscription
    // using their WebSocket/SignalR protocol
    return {
      contextId,
      referenceId: `price_${Date.now()}`,
      subscriptionParams: {
        Arguments: { Uics: uics.join(','), AssetType: assetType },
        RefreshRate: 1000,
      },
    };
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------
  _mapOrderType(type) {
    const map = {
      market: 'Market',
      limit: 'Limit',
      stop: 'Stop',
      stop_limit: 'StopLimit',
      trailing_stop: 'TrailingStop',
    };
    return map[type] || 'Market';
  }
}

module.exports = new SaxoService();
