// ================================================================
// T1 BROKER — MARKET DATA PROVIDER MANAGER
// Multi-provider real-time data with failover, admin-configurable
// Polygon, Finnhub, Alpha Vantage, Twelve Data, CoinGecko, Binance
// ================================================================
const db = require('../config/database');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-cbc';
const ENC_KEY = Buffer.from(config.encryption.key.padEnd(32, '0').slice(0, 32));

// ================================================================
// ENCRYPTION HELPERS (for API keys stored in DB)
// ================================================================
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, ENC_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

function decrypt(data) {
  if (!data) return null;
  const [ivHex, enc] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, ENC_KEY, iv);
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

// ================================================================
// PROVIDER API ADAPTERS
// Each adapter normalizes the response to: { symbol, bid, ask, last, volume, change, changePct, high, low, ts }
// ================================================================
const FETCH_TIMEOUT = 5000; // 5 second timeout per provider call
async function providerFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const ProviderAdapters = {
  async polygon(provider, symbol) {
    const key = decrypt(provider.api_key_encrypted);
    const data = await providerFetch(`${provider.base_url}/v2/last/trade/${symbol}?apiKey=${key}`);
    if (data.results) {
      return { symbol, last: data.results.p, volume: data.results.s, ts: data.results.t };
    }
    // Snapshot endpoint
    const s = await providerFetch(`${provider.base_url}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${key}`);
    const t = s.ticker;
    return t ? {
      symbol, last: t.lastTrade?.p, bid: t.lastQuote?.P, ask: t.lastQuote?.p,
      volume: t.day?.v, high: t.day?.h, low: t.day?.l,
      change: t.todaysChange, changePct: t.todaysChangePerc, ts: Date.now(),
    } : null;
  },

  async finnhub(provider, symbol) {
    const key = decrypt(provider.api_key_encrypted);
    const d = await providerFetch(`${provider.base_url}/quote?symbol=${symbol}&token=${key}`);
    return d.c ? {
      symbol, last: d.c, high: d.h, low: d.l, open: d.o,
      change: d.d, changePct: d.dp, volume: d.v, ts: d.t * 1000,
    } : null;
  },

  async alpha_vantage(provider, symbol) {
    const key = decrypt(provider.api_key_encrypted);
    const d = await providerFetch(`${provider.base_url}?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${key}`);
    const q = d['Global Quote'];
    return q ? {
      symbol, last: parseFloat(q['05. price']), high: parseFloat(q['03. high']),
      low: parseFloat(q['04. low']), open: parseFloat(q['02. open']),
      volume: parseInt(q['06. volume']), change: parseFloat(q['09. change']),
      changePct: parseFloat(q['10. change percent']), ts: Date.now(),
    } : null;
  },

  async twelve_data(provider, symbol) {
    const key = decrypt(provider.api_key_encrypted);
    const d = await providerFetch(`${provider.base_url}/price?symbol=${symbol}&apikey=${key}`);
    return d.price ? { symbol, last: parseFloat(d.price), ts: Date.now() } : null;
  },

  async coingecko(provider, symbol) {
    // CoinGecko uses IDs, map common symbols
    const idMap = {
      'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'DOGE': 'dogecoin',
      'ADA': 'cardano', 'DOT': 'polkadot', 'AVAX': 'avalanche-2', 'MATIC': 'matic-network',
      'LINK': 'chainlink', 'UNI': 'uniswap', 'XRP': 'ripple', 'LTC': 'litecoin',
    };
    const sym = symbol.replace('-USD', '').replace('/USD', '');
    const id = idMap[sym] || sym.toLowerCase();
    const headers = {};
    const key = decrypt(provider.api_key_encrypted);
    if (key) headers['x-cg-demo-api-key'] = key;

    const d = await providerFetch(`${provider.base_url}/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`, { headers });
    const p = d[id];
    return p ? {
      symbol, last: p.usd, volume: p.usd_24h_vol,
      changePct: p.usd_24h_change, change: p.usd * (p.usd_24h_change / 100), ts: Date.now(),
    } : null;
  },

  async binance(provider, symbol) {
    // Binance uses pairs like BTCUSDT
    const pair = symbol.replace('-', '').replace('/', '').replace('USD', 'USDT');
    const d = await providerFetch(`${provider.base_url}/ticker/24hr?symbol=${pair}`);
    return d.lastPrice ? {
      symbol, last: parseFloat(d.lastPrice), bid: parseFloat(d.bidPrice),
      ask: parseFloat(d.askPrice), high: parseFloat(d.highPrice),
      low: parseFloat(d.lowPrice), volume: parseFloat(d.volume),
      change: parseFloat(d.priceChange), changePct: parseFloat(d.priceChangePercent),
      ts: d.closeTime,
    } : null;
  },

  async iex_cloud(provider, symbol) {
    const key = decrypt(provider.api_key_encrypted);
    const d = await providerFetch(`${provider.base_url}/stock/${symbol}/quote?token=${key}`);
    return d.latestPrice ? {
      symbol, last: d.latestPrice, high: d.high, low: d.low,
      open: d.open, volume: d.latestVolume,
      change: d.change, changePct: d.changePercent * 100, ts: d.latestUpdate,
    } : null;
  },

  async yahoo_finance(provider, symbol) {
    const d = await providerFetch(`${provider.base_url}/finance/quote?symbols=${symbol}`);
    const q = d.quoteResponse?.result?.[0];
    return q ? {
      symbol, last: q.regularMarketPrice, bid: q.bid, ask: q.ask,
      high: q.regularMarketDayHigh, low: q.regularMarketDayLow,
      volume: q.regularMarketVolume, change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent, ts: q.regularMarketTime * 1000,
    } : null;
  },
};

// ================================================================
// PROVIDER MANAGER (singleton)
// ================================================================
class MarketDataProviderManager {
  constructor() {
    this.providers = [];
    this.initialized = false;
  }

  async initialize() {
    try {
      this.providers = await db('market_data_providers')
        .orderBy('priority', 'asc');
      this.initialized = true;
      logger.info('Market data providers loaded', { count: this.providers.length });
    } catch (err) {
      logger.warn('Could not load providers from DB, using defaults');
    }
  }

  // ── Get quote with provider failover ──
  async getQuote(symbol, assetClass = 'equity') {
    if (!this.initialized) await this.initialize();

    // Check Redis cache first (1s TTL for real-time, 30s for REST)
    if (redis.client) {
      const cached = await redis.client.get(`quote:${symbol}`);
      if (cached) return JSON.parse(cached);
    }

    // Select providers by asset class priority
    const candidates = this.providers.filter(p => {
      if (p.status !== 'active' || !p.api_key_encrypted) return false;
      if (['crypto'].includes(assetClass) && p.supports_crypto) return true;
      if (['forex'].includes(assetClass) && p.supports_forex) return true;
      if (p.supports_stocks) return true;
      return false;
    });

    // Try each provider in priority order
    for (const provider of candidates) {
      try {
        const adapter = ProviderAdapters[provider.provider_code];
        if (!adapter) continue;

        const quote = await adapter(provider, symbol);
        if (quote && quote.last) {
          // Update rate limit counter
          await db('market_data_providers')
            .where('id', provider.id)
            .update({ requests_today: db.raw('requests_today + 1'), last_request_at: new Date() })
            .catch(() => {});

          // Cache the result
          if (redis.client) {
            await redis.client.set(`quote:${symbol}`, JSON.stringify(quote), 'EX', 5);
          }

          return quote;
        }
      } catch (err) {
        logger.warn('Provider failed', { provider: provider.provider_code, symbol, error: err.message });
        // Mark as error if too many failures
        await db('market_data_providers')
          .where('id', provider.id)
          .update({ error_message: err.message, updated_at: new Date() })
          .catch(() => {});
        continue;
      }
    }

    return null; // All providers failed
  }

  // ── Batch quotes ──
  async getBatchQuotes(symbols, assetClass = 'equity') {
    const results = {};
    // Try batch endpoint first (Polygon, Finnhub support batch)
    // Fall back to individual calls
    await Promise.allSettled(
      symbols.map(async (sym) => {
        const q = await this.getQuote(sym, assetClass);
        if (q) results[sym] = q;
      })
    );
    return results;
  }

  // ── Health check all providers ──
  async healthCheckAll() {
    if (!this.initialized) await this.initialize();

    const results = [];
    for (const p of this.providers) {
      if (!p.api_key_encrypted) {
        results.push({ code: p.provider_code, status: 'not_configured' });
        continue;
      }
      try {
        const testSymbol = p.supports_crypto ? 'BTC' : 'AAPL';
        const adapter = ProviderAdapters[p.provider_code];
        if (!adapter) { results.push({ code: p.provider_code, status: 'no_adapter' }); continue; }

        const start = Date.now();
        const quote = await adapter(p, testSymbol);
        const latency = Date.now() - start;

        const status = quote?.last ? 'active' : 'error';
        await db('market_data_providers').where('id', p.id).update({
          status, last_health_check: new Date(), error_message: status === 'error' ? 'No data returned' : null,
        });
        results.push({ code: p.provider_code, status, latency });
      } catch (err) {
        await db('market_data_providers').where('id', p.id).update({
          status: 'error', error_message: err.message, last_health_check: new Date(),
        });
        results.push({ code: p.provider_code, status: 'error', error: err.message });
      }
    }
    return results;
  }

  // ── Admin CRUD ──
  async listProviders() {
    return db('market_data_providers').orderBy('priority', 'asc').select(
      'id', 'provider_code', 'display_name', 'provider_type', 'status', 'priority',
      'supports_stocks', 'supports_crypto', 'supports_forex', 'supports_websocket',
      'rate_limit_per_minute', 'rate_limit_per_day', 'requests_today', 'free_tier',
      'is_primary_stocks', 'is_primary_crypto', 'is_primary_forex',
      'last_health_check', 'error_message', 'docs_url', 'notes',
      db.raw("CASE WHEN api_key_encrypted IS NOT NULL THEN true ELSE false END as has_api_key"),
      'created_at', 'updated_at'
    );
  }

  async setApiKey(providerId, apiKey, apiSecret = null) {
    const updates = { api_key_encrypted: encrypt(apiKey), updated_at: new Date() };
    if (apiSecret) updates.api_secret_encrypted = encrypt(apiSecret);
    await db('market_data_providers').where('id', providerId).update(updates);
    await this.initialize(); // Reload
  }

  async updateProvider(providerId, fields) {
    const allowed = ['status', 'priority', 'is_primary_stocks', 'is_primary_crypto',
      'is_primary_forex', 'rate_limit_per_minute', 'rate_limit_per_day', 'notes'];
    const updates = {};
    for (const k of allowed) { if (fields[k] !== undefined) updates[k] = fields[k]; }
    updates.updated_at = new Date();
    await db('market_data_providers').where('id', providerId).update(updates);
    await this.initialize();
  }

  async removeApiKey(providerId) {
    await db('market_data_providers').where('id', providerId).update({
      api_key_encrypted: null, api_secret_encrypted: null, status: 'inactive', updated_at: new Date(),
    });
    await this.initialize();
  }
}

module.exports = { MarketDataProviderManager: new MarketDataProviderManager(), encrypt, decrypt };
