// ================================================================
// T1 BROKER — LIVE MARKET DATA FEED
// Simulates realistic price ticks, broadcasts via WebSocket,
// triggers price alerts and push notifications
// ================================================================
const db = require('../config/database');
const logger = require('../utils/logger');

class MarketDataFeed {
  constructor(wsServer) {
    this.ws = wsServer;
    this.instruments = new Map(); // symbol -> { price, open, high, low, volume, bid, ask }
    this.running = false;
    this.tickInterval = null;
    this.alertCheckInterval = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // Seed instruments from DB
    try {
      const rows = await db('instruments').where('is_tradable', true).limit(200);
      for (const inst of rows) {
        const price = parseFloat(inst.last_price) || this._seedPrice(inst.symbol);
        this.instruments.set(inst.symbol, {
          symbol: inst.symbol,
          name: inst.name,
          assetClass: inst.asset_class,
          price,
          open: price,
          high: price,
          low: price,
          close: price,
          previousClose: price,
          volume: 0,
          bid: price * 0.9999,
          ask: price * 1.0001,
          change: 0,
          changePct: 0,
          lastTick: Date.now(),
        });
      }
    } catch (e) {
      // Seed some defaults if DB unavailable
      this._seedDefaults();
    }

    // Price tick every 1s (simulate real market movement)
    this.tickInterval = setInterval(() => this._generateTicks(), 1000);

    // Check price alerts every 10s
    this.alertCheckInterval = setInterval(() => this._checkAlerts(), 10000);

    logger.info(`Market data feed started with ${this.instruments.size} instruments`);
  }

  stop() {
    this.running = false;
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.alertCheckInterval) clearInterval(this.alertCheckInterval);
    logger.info('Market data feed stopped');
  }

  // ================================================================
  // PRICE SIMULATION (Geometric Brownian Motion)
  // ================================================================
  _generateTicks() {
    // Pick 10-30 random instruments per second to update (realistic sparsity)
    const symbols = Array.from(this.instruments.keys());
    const updateCount = Math.min(symbols.length, Math.floor(Math.random() * 20) + 10);
    const toUpdate = this._shuffle(symbols).slice(0, updateCount);

    for (const symbol of toUpdate) {
      const inst = this.instruments.get(symbol);
      if (!inst) continue;

      // Geometric Brownian Motion: dS = μ*S*dt + σ*S*dW
      const volatility = this._getVolatility(inst.assetClass, inst.price);
      const drift = (Math.random() - 0.502) * 0.0001; // Slight random drift
      const shock = this._normalRandom() * volatility;
      const pctChange = drift + shock;

      const oldPrice = inst.price;
      const newPrice = Math.max(0.01, inst.price * (1 + pctChange));

      // Update OHLCV
      inst.price = parseFloat(newPrice.toFixed(this._getDecimals(inst.price)));
      inst.high = Math.max(inst.high, inst.price);
      inst.low = Math.min(inst.low, inst.price);
      inst.volume += Math.floor(Math.random() * 500) + 10;
      inst.change = inst.price - inst.open;
      inst.changePct = ((inst.price - inst.open) / inst.open) * 100;
      inst.bid = parseFloat((inst.price * (1 - Math.random() * 0.0003)).toFixed(this._getDecimals(inst.price)));
      inst.ask = parseFloat((inst.price * (1 + Math.random() * 0.0003)).toFixed(this._getDecimals(inst.price)));
      inst.lastTick = Date.now();

      // Broadcast to subscribers
      if (this.ws) {
        this.ws.broadcastMarketData(symbol, {
          symbol: inst.symbol,
          price: inst.price,
          bid: inst.bid,
          ask: inst.ask,
          high: inst.high,
          low: inst.low,
          open: inst.open,
          volume: inst.volume,
          change: parseFloat(inst.change.toFixed(2)),
          changePct: parseFloat(inst.changePct.toFixed(2)),
          ts: inst.lastTick,
        });
      }
    }
  }

  _getVolatility(assetClass, price) {
    // Annualized vol / sqrt(252 trading days * 6.5 hrs * 3600 ticks/hr)
    const annualVol = {
      equity: 0.25, etf: 0.15, forex: 0.08,
      crypto: 0.65, commodity: 0.20, bond: 0.05,
    };
    const vol = annualVol[assetClass] || 0.25;
    return vol / Math.sqrt(252 * 23400); // Per-second vol
  }

  _getDecimals(price) {
    if (price < 1) return 4;
    if (price < 100) return 2;
    return 2;
  }

  _normalRandom() {
    // Box-Muller transform for standard normal
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ================================================================
  // PRICE ALERT CHECKER
  // ================================================================
  async _checkAlerts() {
    try {
      const alerts = await db('price_alerts')
        .whereNot('alert_type', 'watchlist')
        .where('is_triggered', false)
        .where('is_active', true);

      const { PushNotificationService } = require('./push');

      for (const alert of alerts) {
        const inst = this.instruments.get(alert.symbol);
        if (!inst) continue;

        let triggered = false;
        if (alert.condition === 'above' && inst.price >= parseFloat(alert.target_price)) triggered = true;
        if (alert.condition === 'below' && inst.price <= parseFloat(alert.target_price)) triggered = true;
        if (alert.condition === 'crosses') {
          const prev = inst.open;
          const target = parseFloat(alert.target_price);
          if ((prev < target && inst.price >= target) || (prev > target && inst.price <= target)) triggered = true;
        }

        if (triggered) {
          await db('price_alerts').where('id', alert.id).update({
            is_triggered: true,
            triggered_at: new Date(),
            triggered_price: inst.price,
          });

          // Send push notification
          PushNotificationService.sendToUser(alert.user_id, 'priceAlert', {
            symbol: alert.symbol,
            price: inst.price.toFixed(2),
            condition: alert.condition,
            targetPrice: parseFloat(alert.target_price).toFixed(2),
          }).catch(e => logger.error('Alert push failed', { error: e.message }));

          // Also send via WebSocket
          if (this.ws) {
            this.ws.sendNotification(alert.user_id, {
              type: 'price_alert',
              symbol: alert.symbol,
              price: inst.price,
              condition: alert.condition,
              targetPrice: parseFloat(alert.target_price),
            });
          }

          logger.info('Price alert triggered', { userId: alert.user_id, symbol: alert.symbol, price: inst.price });
        }
      }
    } catch (e) {
      // Alerts table may not have is_triggered/is_active columns yet — skip silently
    }
  }

  // ================================================================
  // PUBLIC API
  // ================================================================
  getQuote(symbol) {
    return this.instruments.get(symbol?.toUpperCase()) || null;
  }

  getQuotes(symbols) {
    return symbols.map(s => this.instruments.get(s.toUpperCase())).filter(Boolean);
  }

  getAllQuotes() {
    return Array.from(this.instruments.values());
  }

  getTopMovers(count = 10) {
    return Array.from(this.instruments.values())
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, count);
  }

  getMostActive(count = 10) {
    return Array.from(this.instruments.values())
      .sort((a, b) => b.volume - a.volume)
      .slice(0, count);
  }

  // ================================================================
  // SEED DATA
  // ================================================================
  _seedPrice(symbol) {
    const prices = {
      AAPL: 189, MSFT: 415, GOOGL: 175, AMZN: 178, NVDA: 875,
      META: 485, TSLA: 248, JPM: 198, V: 280, JNJ: 162,
      WMT: 168, PG: 155, UNH: 520, HD: 370, DIS: 112,
      NFLX: 582, PYPL: 62, AMD: 178, INTC: 42, CRM: 290,
      'BTC/USD': 97800, 'ETH/USD': 3200, 'EUR/USD': 1.08, 'GBP/USD': 1.26,
      GLD: 192, SLV: 23, SPY: 502, QQQ: 430, IWM: 202,
    };
    return prices[symbol] || (50 + Math.random() * 200);
  }

  _seedDefaults() {
    const defaults = [
      { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity' },
      { symbol: 'MSFT', name: 'Microsoft', assetClass: 'equity' },
      { symbol: 'GOOGL', name: 'Alphabet', assetClass: 'equity' },
      { symbol: 'AMZN', name: 'Amazon.com', assetClass: 'equity' },
      { symbol: 'NVDA', name: 'NVIDIA Corp.', assetClass: 'equity' },
      { symbol: 'META', name: 'Meta Platforms', assetClass: 'equity' },
      { symbol: 'TSLA', name: 'Tesla Inc.', assetClass: 'equity' },
      { symbol: 'JPM', name: 'JPMorgan Chase', assetClass: 'equity' },
      { symbol: 'NFLX', name: 'Netflix', assetClass: 'equity' },
      { symbol: 'AMD', name: 'AMD', assetClass: 'equity' },
      { symbol: 'BTC/USD', name: 'Bitcoin', assetClass: 'crypto' },
      { symbol: 'ETH/USD', name: 'Ethereum', assetClass: 'crypto' },
      { symbol: 'EUR/USD', name: 'Euro/Dollar', assetClass: 'forex' },
      { symbol: 'GBP/USD', name: 'Pound/Dollar', assetClass: 'forex' },
      { symbol: 'SPY', name: 'S&P 500 ETF', assetClass: 'etf' },
      { symbol: 'QQQ', name: 'Nasdaq 100 ETF', assetClass: 'etf' },
    ];
    for (const d of defaults) {
      const price = this._seedPrice(d.symbol);
      this.instruments.set(d.symbol, {
        ...d, price, open: price, high: price, low: price, close: price,
        previousClose: price, volume: 0, bid: price * 0.9999, ask: price * 1.0001,
        change: 0, changePct: 0, lastTick: Date.now(),
      });
    }
  }
}

module.exports = MarketDataFeed;
