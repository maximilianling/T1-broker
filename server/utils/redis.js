// ================================================================
// T1 BROKER — REDIS SERVICE
// Session store, market data cache, rate limiting, pub/sub
// ================================================================
const Redis = require('ioredis');
const config = require('../config');
const logger = require('./logger');

class RedisService {
  constructor() {
    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this._handlers = new Map();
  }

  async connect() {
    const opts = {
      host: config.redis?.host || 'localhost',
      port: config.redis?.port || 6379,
      password: config.redis?.password || undefined,
      db: config.redis?.db || 0,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    };

    this.client = new Redis(opts);
    this.publisher = new Redis(opts);
    this.subscriber = new Redis(opts);

    this.client.on('connect', () => logger.info('Redis client connected'));
    this.client.on('error', (err) => logger.error('Redis client error', { error: err.message }));
    this.subscriber.on('error', (err) => logger.error('Redis subscriber error', { error: err.message }));

    await Promise.all([
      this.client.connect(),
      this.publisher.connect(),
      this.subscriber.connect(),
    ]);

    logger.info('✅ Redis connected (client + pub/sub)');
  }

  // ----------------------------------------------------------------
  // Basic key-value operations
  // ----------------------------------------------------------------
  async get(key) {
    const val = await this.client.get(key);
    try { return JSON.parse(val); } catch { return val; }
  }

  async set(key, value, ttlSeconds) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key) {
    await this.client.del(key);
  }

  async exists(key) {
    return (await this.client.exists(key)) === 1;
  }

  async incr(key, ttlSeconds) {
    const val = await this.client.incr(key);
    if (val === 1 && ttlSeconds) {
      await this.client.expire(key, ttlSeconds);
    }
    return val;
  }

  // ----------------------------------------------------------------
  // Session management
  // ----------------------------------------------------------------
  async storeSession(sessionId, data, ttlSeconds = 900) {
    await this.set(`session:${sessionId}`, data, ttlSeconds);
  }

  async getSession(sessionId) {
    return this.get(`session:${sessionId}`);
  }

  async destroySession(sessionId) {
    await this.del(`session:${sessionId}`);
  }

  async destroyAllUserSessions(userId) {
    const keys = await this.client.keys(`session:*`);
    for (const key of keys) {
      const session = await this.get(key);
      if (session?.userId === userId) {
        await this.del(key);
      }
    }
  }

  // ----------------------------------------------------------------
  // Market data cache
  // ----------------------------------------------------------------
  async cacheQuote(symbol, data) {
    await this.set(`quote:${symbol}`, data, 5); // 5s TTL for real-time quotes
  }

  async getCachedQuote(symbol) {
    return this.get(`quote:${symbol}`);
  }

  async cacheInstrumentList(data) {
    await this.set('instruments:list', data, 300); // 5 min
  }

  async getCachedInstruments() {
    return this.get('instruments:list');
  }

  // ----------------------------------------------------------------
  // Rate limiting (sliding window)
  // ----------------------------------------------------------------
  async checkRateLimit(key, maxRequests, windowSeconds) {
    const now = Date.now();
    const windowKey = key; // key already includes prefix from caller

    const pipe = this.client.pipeline();
    pipe.zremrangebyscore(windowKey, 0, now - windowSeconds * 1000);
    pipe.zadd(windowKey, now, `${now}:${Math.random()}`);
    pipe.zcard(windowKey);
    pipe.expire(windowKey, windowSeconds);

    const results = await pipe.exec();
    const count = results[2][1];

    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      total: maxRequests,
      resetAt: new Date(now + windowSeconds * 1000),
    };
  }

  // ----------------------------------------------------------------
  // Distributed locking (for reconciliation, etc.)
  // ----------------------------------------------------------------
  async acquireLock(lockName, ttlSeconds = 60) {
    const lockKey = `lock:${lockName}`;
    const lockValue = `${process.pid}:${Date.now()}`;
    const acquired = await this.client.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');
    return acquired === 'OK' ? lockValue : null;
  }

  async releaseLock(lockName, lockValue) {
    const lockKey = `lock:${lockName}`;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.client.eval(script, 1, lockKey, lockValue);
  }

  // ----------------------------------------------------------------
  // Pub/Sub for cross-instance communication
  // ----------------------------------------------------------------
  async publish(channel, message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    await this.publisher.publish(channel, data);
  }

  async subscribe(channel, handler) {
    // Register message handler once, then dispatch via map
    if (this._handlers.size === 0) {
      this.subscriber.on('message', (ch, msg) => {
        const h = this._handlers.get(ch);
        if (!h) return;
        try {
          const data = JSON.parse(msg);
          h(data);
        } catch {
          h(msg);
        }
      });
    }
    this._handlers.set(channel, handler);
    await this.subscriber.subscribe(channel);
  }

  // Pub/sub channels for WebSocket scaling
  async publishMarketData(symbol, data) {
    await this.publish(`ws:market:${symbol}`, data);
  }

  async publishOrderUpdate(userId, data) {
    await this.publish(`ws:order:${userId}`, data);
  }

  async publishAdminEvent(data) {
    await this.publish('ws:admin', data);
  }

  // ----------------------------------------------------------------
  // Cleanup
  // ----------------------------------------------------------------
  async disconnect() {
    await this.subscriber.quit();
    await this.publisher.quit();
    await this.client.quit();
    logger.info('Redis disconnected');
  }
}

// Singleton
const redis = new RedisService();
module.exports = redis;
