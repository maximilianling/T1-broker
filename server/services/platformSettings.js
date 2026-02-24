// ================================================================
// T1 BROKER — PLATFORM SETTINGS SERVICE
// Runtime-configurable system variables with DB persistence,
// Redis caching, typed access, audit trail
// ================================================================
const db = require('../config/database');
const redis = require('../utils/redis');
const logger = require('../utils/logger');

const CACHE_KEY = 'platform:settings';
const CACHE_TTL = 300; // 5 min

class PlatformSettings {
  constructor() {
    this._cache = null;           // In-memory fallback if Redis down
    this._cacheTimestamp = 0;
    this._memTTL = 60000;         // 60s in-memory TTL
  }

  // ── Load all settings into cache ──
  async _loadAll() {
    try {
      const rows = await db('platform_settings').select('key', 'value', 'value_type');
      const map = {};
      for (const r of rows) map[r.key] = this._cast(r.value, r.value_type);
      this._cache = map;
      this._cacheTimestamp = Date.now();

      // Store in Redis
      if (redis.client) {
        await redis.client.set(CACHE_KEY, JSON.stringify(map), 'EX', CACHE_TTL).catch(() => {});
      }
      return map;
    } catch (err) {
      logger.warn('Failed to load platform settings from DB', { error: err.message });
      return this._cache || {};
    }
  }

  _cast(value, type) {
    switch (type) {
      case 'number': return parseFloat(value);
      case 'boolean': return value === 'true' || value === true;
      case 'json': try { return JSON.parse(value); } catch { return value; }
      case 'secret': return value; // stored encrypted in production
      default: return value;
    }
  }

  _serialize(value) {
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  // ── Get all settings (from cache or DB) ──
  async getAll() {
    // Try Redis first
    if (redis.client) {
      try {
        const cached = await redis.client.get(CACHE_KEY);
        if (cached) return JSON.parse(cached);
      } catch {}
    }

    // Try in-memory
    if (this._cache && (Date.now() - this._cacheTimestamp) < this._memTTL) {
      return this._cache;
    }

    // Load from DB
    return this._loadAll();
  }

  // ── Get single setting ──
  async get(key, defaultValue = null) {
    const all = await this.getAll();
    return all[key] !== undefined ? all[key] : defaultValue;
  }

  // ── Get multiple settings by prefix ──
  async getCategory(category) {
    const all = await this.getAll();
    const prefix = category + '.';
    const result = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(prefix)) {
        const shortKey = k.slice(prefix.length);
        result[shortKey] = v;
      }
    }
    return result;
  }

  // ── Typed convenience getters ──
  async getNumber(key, defaultValue = 0) {
    const v = await this.get(key);
    return v !== null ? Number(v) : defaultValue;
  }

  async getBool(key, defaultValue = false) {
    const v = await this.get(key);
    return v !== null ? Boolean(v) : defaultValue;
  }

  async getJSON(key, defaultValue = null) {
    const v = await this.get(key);
    if (v === null) return defaultValue;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return defaultValue; }
  }

  // ── Update a setting ──
  async set(key, value, { userId, ipAddress, reason } = {}) {
    const row = await db('platform_settings').where('key', key).first();
    if (!row) throw new Error(`Unknown setting: ${key}`);

    const newValue = this._serialize(value);
    const oldValue = row.value;

    // Validate constraints
    if (row.value_type === 'number') {
      const num = parseFloat(newValue);
      if (isNaN(num)) throw new Error(`${key} must be a number`);
      if (row.min_value !== null && num < parseFloat(row.min_value))
        throw new Error(`${key} must be >= ${row.min_value}`);
      if (row.max_value !== null && num > parseFloat(row.max_value))
        throw new Error(`${key} must be <= ${row.max_value}`);
    }
    if (row.allowed_values) {
      const allowed = typeof row.allowed_values === 'string'
        ? JSON.parse(row.allowed_values) : row.allowed_values;
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(newValue)) {
        throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
      }
    }

    // Update
    await db('platform_settings').where('key', key).update({
      value: newValue,
      updated_by: userId || null,
      updated_at: new Date(),
    });

    // Audit trail
    await db('platform_settings_audit').insert({
      setting_key: key,
      old_value: row.is_sensitive ? '***' : oldValue,
      new_value: row.is_sensitive ? '***' : newValue,
      changed_by: userId || null,
      ip_address: ipAddress || null,
      reason: reason || null,
    }).catch(err => logger.warn('Settings audit insert failed', { error: err.message }));

    // Invalidate caches
    this._cache = null;
    if (redis.client) {
      await redis.client.del(CACHE_KEY).catch(() => {});
    }

    logger.info('Platform setting updated', { key, oldValue: row.is_sensitive ? '***' : oldValue, newValue: row.is_sensitive ? '***' : newValue });
    return { key, value: this._cast(newValue, row.value_type), requiresRestart: row.requires_restart };
  }

  // ── Bulk update ──
  async setMany(updates, { userId, ipAddress, reason } = {}) {
    const results = [];
    for (const [key, value] of Object.entries(updates)) {
      try {
        const r = await this.set(key, value, { userId, ipAddress, reason });
        results.push(r);
      } catch (err) {
        results.push({ key, error: err.message });
      }
    }
    return results;
  }

  // ── Reset to default ──
  async reset(key, { userId, ipAddress } = {}) {
    const row = await db('platform_settings').where('key', key).first();
    if (!row) throw new Error(`Unknown setting: ${key}`);
    if (row.default_value === null) throw new Error(`No default value for ${key}`);
    return this.set(key, row.default_value, { userId, ipAddress, reason: 'Reset to default' });
  }

  // ── List all (for admin UI) ──
  async listAll() {
    return db('platform_settings')
      .orderBy('category')
      .orderBy('sort_order')
      .select('key', 'value', 'value_type', 'category', 'label', 'description',
        'default_value', 'min_value', 'max_value', 'allowed_values',
        'is_sensitive', 'requires_restart', 'updated_at');
  }

  // ── Audit history ──
  async getAuditLog(key = null, limit = 100) {
    let query = db('platform_settings_audit as a')
      .leftJoin('users as u', 'u.id', 'a.changed_by')
      .orderBy('a.changed_at', 'desc')
      .limit(limit);
    if (key) query = query.where('a.setting_key', key);
    return query.select(
      'a.setting_key', 'a.old_value', 'a.new_value',
      'a.reason', 'a.ip_address', 'a.changed_at',
      db.raw("COALESCE(u.email, 'system') as changed_by_email")
    );
  }
}

module.exports = new PlatformSettings();
