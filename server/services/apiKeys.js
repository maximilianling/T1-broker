// ================================================================
// T1 BROKER — API KEY SERVICE
// Enables clients to generate API keys for programmatic trading.
// Keys are hashed (SHA-256) before storage — the raw key is only
// shown once at creation time.
// ================================================================
const crypto = require('crypto');
const db = require('../config/database');
const { hashToken, encrypt, decrypt } = require('../utils/encryption');
const AuditService = require('../utils/audit');
const logger = require('../utils/logger');

class APIKeyService {
  /**
   * Generate a new API key for a user.
   * @param {number} userId
   * @param {object} options - { label, permissions, ipWhitelist, expiresInDays }
   * @returns {{ apiKey, keyId, prefix }} — raw key is returned ONCE only
   */
  static async createKey(userId, options = {}) {
    const {
      label = 'Default API Key',
      permissions = ['read', 'trade'],
      ipWhitelist = [],
      expiresInDays = 365,
    } = options;

    // Enforce max 5 active keys per user
    const activeCount = await db('api_keys')
      .where('user_id', userId)
      .where('is_active', true)
      .count('id as cnt')
      .first();

    if (parseInt(activeCount.cnt) >= 5) {
      throw new Error('Maximum 5 active API keys allowed. Revoke an existing key first.');
    }

    // Generate key: t1_live_ prefix + 48 random bytes (hex)
    const rawSecret = crypto.randomBytes(48).toString('hex');
    const prefix = 't1_live_';
    const rawKey = prefix + rawSecret;
    const keyHash = hashToken(rawKey);
    const keyPreview = rawKey.substring(0, 16) + '...' + rawKey.substring(rawKey.length - 6);

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const [record] = await db('api_keys').insert({
      user_id: userId,
      key_hash: keyHash,
      key_preview: keyPreview,
      label,
      permissions: JSON.stringify(permissions),
      ip_whitelist: ipWhitelist.length ? JSON.stringify(ipWhitelist) : null,
      expires_at: expiresAt,
      is_active: true,
      created_at: new Date(),
      last_used_at: null,
      usage_count: 0,
    }).returning('*');

    AuditService.log({
      userId,
      action: `API key created: "${label}" (${keyPreview})`,
      resourceType: 'api_key',
      resourceId: record.id,
      level: 'info',
    });

    logger.info('API key created', { userId, keyId: record.id, label });

    return {
      apiKey: rawKey,           // Only shown once!
      keyId: record.id,
      keyPreview,
      label,
      permissions,
      expiresAt,
    };
  }

  /**
   * Validate an API key and return the associated user.
   * Called by auth middleware on every request with X-API-Key header.
   */
  static async validateKey(rawKey, requestIP) {
    if (!rawKey || !rawKey.startsWith('t1_live_')) {
      return { valid: false, error: 'Invalid API key format' };
    }

    const keyHash = hashToken(rawKey);

    const record = await db('api_keys')
      .where('key_hash', keyHash)
      .where('is_active', true)
      .first();

    if (!record) {
      return { valid: false, error: 'Invalid or revoked API key' };
    }

    // Check expiry
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      await db('api_keys').where('id', record.id).update({ is_active: false });
      return { valid: false, error: 'API key expired' };
    }

    // Check IP whitelist
    if (record.ip_whitelist) {
      const allowed = JSON.parse(record.ip_whitelist);
      if (allowed.length > 0 && !allowed.includes(requestIP)) {
        AuditService.log({
          userId: record.user_id,
          action: `API key used from non-whitelisted IP: ${requestIP}`,
          resourceType: 'api_key',
          resourceId: record.id,
          level: 'warning',
        });
        return { valid: false, error: 'IP address not whitelisted for this API key' };
      }
    }

    // Get user
    const user = await db('users')
      .where('id', record.user_id)
      .where('is_active', true)
      .first();

    if (!user) {
      return { valid: false, error: 'User account inactive' };
    }

    // Update usage stats (non-blocking)
    db('api_keys').where('id', record.id).update({
      last_used_at: new Date(),
      last_used_ip: requestIP,
      usage_count: db.raw('usage_count + 1'),
    }).catch(() => {});

    return {
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mfaEnabled: user.mfa_enabled,
      },
      keyId: record.id,
      permissions: JSON.parse(record.permissions),
      isAPIKey: true,
    };
  }

  /**
   * List all API keys for a user (hashes are never returned).
   */
  static async listKeys(userId) {
    const keys = await db('api_keys')
      .where('user_id', userId)
      .orderBy('created_at', 'desc')
      .select('id', 'key_preview', 'label', 'permissions', 'ip_whitelist',
        'is_active', 'created_at', 'expires_at', 'last_used_at', 'last_used_ip', 'usage_count');

    return keys.map(k => ({
      ...k,
      permissions: JSON.parse(k.permissions),
      ipWhitelist: k.ip_whitelist ? JSON.parse(k.ip_whitelist) : [],
    }));
  }

  /**
   * Revoke an API key.
   */
  static async revokeKey(userId, keyId) {
    const key = await db('api_keys')
      .where('id', keyId)
      .where('user_id', userId)
      .first();

    if (!key) throw new Error('API key not found');
    if (!key.is_active) throw new Error('API key already revoked');

    await db('api_keys').where('id', keyId).update({
      is_active: false,
      revoked_at: new Date(),
    });

    AuditService.log({
      userId,
      action: `API key revoked: "${key.label}" (${key.key_preview})`,
      resourceType: 'api_key',
      resourceId: keyId,
      level: 'info',
    });

    return { success: true };
  }

  /**
   * Update API key settings (label, permissions, IP whitelist).
   */
  static async updateKey(userId, keyId, updates) {
    const key = await db('api_keys')
      .where('id', keyId)
      .where('user_id', userId)
      .where('is_active', true)
      .first();

    if (!key) throw new Error('API key not found or revoked');

    const updateData = {};
    if (updates.label) updateData.label = updates.label;
    if (updates.permissions) updateData.permissions = JSON.stringify(updates.permissions);
    if (updates.ipWhitelist !== undefined) {
      updateData.ip_whitelist = updates.ipWhitelist.length
        ? JSON.stringify(updates.ipWhitelist) : null;
    }

    await db('api_keys').where('id', keyId).update(updateData);

    AuditService.log({
      userId,
      action: `API key updated: "${updates.label || key.label}"`,
      resourceType: 'api_key',
      resourceId: keyId,
      level: 'info',
    });

    return { success: true };
  }

  /**
   * Admin: revoke all API keys for a user.
   */
  static async revokeAllKeys(userId, adminId) {
    const count = await db('api_keys')
      .where('user_id', userId)
      .where('is_active', true)
      .update({ is_active: false, revoked_at: new Date() });

    AuditService.log({
      userId: adminId,
      action: `All API keys revoked for user ${userId} (${count} keys)`,
      resourceType: 'api_key',
      level: 'warning',
    });

    return { revoked: count };
  }
}

module.exports = APIKeyService;
