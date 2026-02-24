// ================================================================
// T1 BROKER — LIVE MARKET DATA STREAMING ENGINE
// Real-time price generation, OHLCV candles, L2 order book,
// price alert triggering, multi-source aggregation
// ================================================================
const EventEmitter = require('events');
const logger = require('../utils/logger');
const db = require('../config/database');
const redis = require('../utils/redis');
const { PushNotificationService } = require('./push');

// ================================================================
// PRICE SIMULATION (replace with real feed in production)
// Generates realistic market tick data using geometric Brownian motion
// ================================================================
const SEED_PRICES = {
  AAPL: { price: 189.84, vol: 0.018 }, TSLA: { price: 248.42, vol: 0.035 },
  NVDA: { price: 875.28, vol: 0.028 }, MSFT: { price: 415.50, vol: 0.015 },
  AMZN: { price: 178.25, vol: 0.022 }, GOOGL: { price: 175.90, vol: 0.019 },
  META: { price: 485.20, vol: 0.025 }, JPM: { price: 198.75, vol: 0.014 },
  NFLX: { price: 582.10, vol: 0.030 }, AMD: { price: 178.50, vol: 0.032 },
  ARM: { price: 148.90, vol: 0.040 }, COIN: { price: 205.80, vol: 0.045 },
  PLTR: { price: 22.45, vol: 0.038 }, SMCI: { price: 875.50, vol: 0.050 },
  SPY: { price: 502.40, vol: 0.008 }, QQQ: { price: 435.20, vol: 0.012 },
  'BTC-USD': { price: 97842, vol: 0.025 }, 'ETH-USD': { price: 3250, vol: 0.030 },
  'EUR-USD': { price: 1.0842, vol: 0.004 }, 'GBP-USD': { price: 1.2650, vol: 0.005 },
  'XAU-USD': { price: 2042.50, vol: 0.008 },
};

class MarketDataEngine extends EventEmitter {
  constructor() {
    super();
    this.prices = {};           // symbol -> { bid, ask, last, open, high, low, volume, change, changePct, ts }
    this.candles = {};          // symbol -> { '1m': [], '5m': [], '1h': [], '1d': [] }
    this.orderBooks = {};       // symbol -> { bids: [[price, qty]], asks: [[price, qty]] }
    this.subscribers = new Map(); // symbol -> Set<callback>
    this.intervals = [];
    this.isRunning = false;

    // Initialize seed prices
    for (const [symbol, seed] of Object.entries(SEED_PRICES)) {
      this.prices[symbol] = {
        bid: seed.price * 0.9998, ask: seed.price * 1.0002,
        last: seed.price, open: seed.price, high: seed.price,
        low: seed.price, volume: 0, change: 0, changePct: 0,
        volatility: seed.vol, ts: Date.now(),
      };
      this.candles[symbol] = { '1m': [], '5m': [], '1h': [], '1d': [] };
      this._generateOrderBook(symbol);
    }
  }

  // ================================================================
  // START / STOP
  // ================================================================
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Tick generation — every 500ms for subscribed symbols, 5s for others
    this.intervals.push(
      setInterval(() => this._tickSubscribed(), 500),
      setInterval(() => this._tickAll(), 5000),
      setInterval(() => this._aggregateCandles('1m'), 60000),
      setInterval(() => this._aggregateCandles('5m'), 300000),
      setInterval(() => this._checkPriceAlerts(), 10000),
      setInterval(() => this._cacheTopPrices(), 3000),
    );

    logger.info('Market data engine started', { symbols: Object.keys(this.prices).length });
  }

  stop() {
    this.isRunning = false;
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
    logger.info('Market data engine stopped');
  }

  // ================================================================
  // PRICE TICK GENERATION (Geometric Brownian Motion)
  // ================================================================
  _generateTick(symbol) {
    const p = this.prices[symbol];
    if (!p) return null;

    const dt = 1 / (6.5 * 60 * 60 * 2); // ~0.5s as fraction of trading day
    const drift = 0.0001; // slight upward drift
    const randomWalk = (Math.random() - 0.5) * 2;
    const shock = p.volatility * Math.sqrt(dt) * randomWalk;
    const newPrice = p.last * (1 + drift * dt + shock);

    // Spread based on volatility
    const spreadPct = Math.max(0.0001, p.volatility * 0.01);
    const half = newPrice * spreadPct / 2;

    p.bid = +(newPrice - half).toFixed(symbol.includes('-') ? 4 : 2);
    p.ask = +(newPrice + half).toFixed(symbol.includes('-') ? 4 : 2);
    p.last = +newPrice.toFixed(symbol.includes('-') ? 4 : 2);
    p.high = Math.max(p.high, p.last);
    p.low = Math.min(p.low, p.last);
    p.volume += Math.floor(Math.random() * 1000 + 100);
    p.change = +(p.last - p.open).toFixed(symbol.includes('-') ? 4 : 2);
    p.changePct = +((p.change / p.open) * 100).toFixed(2);
    p.ts = Date.now();

    // Update order book
    this._updateOrderBook(symbol, p);

    return { symbol, ...p };
  }

  _tickSubscribed() {
    const subscribed = new Set();
    this.subscribers.forEach((callbacks, sym) => {
      if (callbacks.size > 0) subscribed.add(sym);
    });

    for (const symbol of subscribed) {
      const tick = this._generateTick(symbol);
      if (tick) this.emit('tick', tick);
    }
  }

  _tickAll() {
    for (const symbol of Object.keys(this.prices)) {
      this._generateTick(symbol);
    }
    this.emit('snapshot', this.getAllPrices());
  }

  // ================================================================
  // ORDER BOOK SIMULATION
  // ================================================================
  _generateOrderBook(symbol) {
    const p = this.prices[symbol];
    if (!p) return;

    const levels = 10;
    const bids = [], asks = [];
    for (let i = 0; i < levels; i++) {
      const spread = (i + 1) * p.last * 0.0003;
      bids.push([
        +(p.last - spread).toFixed(2),
        Math.floor(Math.random() * 500 + 50),
      ]);
      asks.push([
        +(p.last + spread).toFixed(2),
        Math.floor(Math.random() * 500 + 50),
      ]);
    }
    this.orderBooks[symbol] = { bids, asks, ts: Date.now() };
  }

  _updateOrderBook(symbol, p) {
    const book = this.orderBooks[symbol];
    if (!book) return;

    // Shift levels slightly around new price
    for (let i = 0; i < book.bids.length; i++) {
      book.bids[i][0] = +(p.last - (i + 1) * p.last * 0.0003).toFixed(2);
      book.bids[i][1] = Math.max(10, book.bids[i][1] + Math.floor((Math.random() - 0.5) * 50));
      book.asks[i][0] = +(p.last + (i + 1) * p.last * 0.0003).toFixed(2);
      book.asks[i][1] = Math.max(10, book.asks[i][1] + Math.floor((Math.random() - 0.5) * 50));
    }
    book.ts = Date.now();
  }

  // ================================================================
  // OHLCV CANDLE AGGREGATION
  // ================================================================
  _aggregateCandles(interval) {
    for (const symbol of Object.keys(this.prices)) {
      const p = this.prices[symbol];
      const candles = this.candles[symbol]?.[interval];
      if (!candles) continue;

      const now = Date.now();
      const last = candles[candles.length - 1];

      if (!last || now - last.ts > this._intervalMs(interval)) {
        // New candle
        candles.push({
          o: p.last, h: p.last, l: p.last, c: p.last,
          v: 0, ts: now,
        });
        // Keep max 500 candles
        if (candles.length > 500) candles.shift();
      } else {
        // Update current candle
        last.h = Math.max(last.h, p.last);
        last.l = Math.min(last.l, p.last);
        last.c = p.last;
        last.v += Math.floor(Math.random() * 100);
      }
    }
  }

  _intervalMs(interval) {
    const map = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 };
    return map[interval] || 60000;
  }

  // ================================================================
  // PRICE ALERT CHECKING
  // ================================================================
  async _checkPriceAlerts() {
    try {
      const alerts = await db('price_alerts')
        .where('is_triggered', false)
        .whereNot('alert_type', 'watchlist');

      for (const alert of alerts) {
        const p = this.prices[alert.symbol];
        if (!p) continue;

        let triggered = false;
        if (alert.condition === 'above' && p.last >= alert.target_price) triggered = true;
        if (alert.condition === 'below' && p.last <= alert.target_price) triggered = true;
        if (alert.condition === 'crosses' &&
            ((p.last >= alert.target_price && p.open < alert.target_price) ||
             (p.last <= alert.target_price && p.open > alert.target_price))) triggered = true;

        if (triggered) {
          await db('price_alerts').where('id', alert.id).update({ is_triggered: true, triggered_at: new Date() });

          // Send push notification
          PushNotificationService.sendToUser(alert.user_id, 'priceAlert', {
            symbol: alert.symbol,
            price: p.last,
            condition: alert.condition,
            targetPrice: alert.target_price,
          }).catch(() => {});

          this.emit('alert_triggered', { alert, price: p.last });
          logger.info('Price alert triggered', { alertId: alert.id, symbol: alert.symbol, price: p.last });
        }
      }
    } catch (err) {
      // Silent — alerts table might not exist yet
    }
  }

  // ================================================================
  // REDIS CACHE (for REST endpoints)
  // ================================================================
  async _cacheTopPrices() {
    try {
      if (!redis.client) return;
      const snapshot = this.getAllPrices();
      await redis.client.set('market:prices', JSON.stringify(snapshot), 'EX', 10);
    } catch (e) {}
  }

  // ================================================================
  // PUBLIC API
  // ================================================================
  getPrice(symbol) {
    return this.prices[symbol.toUpperCase()] || null;
  }

  getAllPrices() {
    const result = {};
    for (const [sym, p] of Object.entries(this.prices)) {
      result[sym] = { bid: p.bid, ask: p.ask, last: p.last, change: p.change, changePct: p.changePct, volume: p.volume, ts: p.ts };
    }
    return result;
  }

  getCandles(symbol, interval = '1m', limit = 100) {
    const c = this.candles[symbol.toUpperCase()]?.[interval];
    return c ? c.slice(-limit) : [];
  }

  getOrderBook(symbol) {
    return this.orderBooks[symbol.toUpperCase()] || null;
  }

  subscribe(symbol, callback) {
    const sym = symbol.toUpperCase();
    if (!this.subscribers.has(sym)) this.subscribers.set(sym, new Set());
    this.subscribers.get(sym).add(callback);
    return () => this.subscribers.get(sym)?.delete(callback);
  }

  addSymbol(symbol, seedPrice, volatility = 0.02) {
    const sym = symbol.toUpperCase();
    if (this.prices[sym]) return;
    this.prices[sym] = {
      bid: seedPrice * 0.9998, ask: seedPrice * 1.0002,
      last: seedPrice, open: seedPrice, high: seedPrice,
      low: seedPrice, volume: 0, change: 0, changePct: 0,
      volatility, ts: Date.now(),
    };
    this.candles[sym] = { '1m': [], '5m': [], '1h': [], '1d': [] };
    this._generateOrderBook(sym);
  }
}

// Singleton
const marketDataEngine = new MarketDataEngine();
module.exports = marketDataEngine;
