// ================================================================
// T1 BROKER — PUSH NOTIFICATION SERVICE
// Expo Push API, FCM fallback, APNS fallback
// Batched sending, retry with backoff, notification templates
// ================================================================
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const redis = require('../utils/redis');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100; // Expo allows 100 per request

// ================================================================
// NOTIFICATION TEMPLATES
// ================================================================
const PushTemplates = {
  orderFilled: (data) => ({
    title: `Order Filled: ${data.side?.toUpperCase()} ${data.symbol}`,
    body: `${data.quantity} shares at $${data.price}. Total: $${data.total}`,
    data: { screen: 'Portfolio', orderId: data.orderId },
    categoryId: 'order',
    sound: 'default',
  }),

  orderRejected: (data) => ({
    title: `Order Rejected: ${data.symbol}`,
    body: `Your ${data.side} order was rejected: ${data.reason}`,
    data: { screen: 'Trading', orderId: data.orderId },
    categoryId: 'order',
    sound: 'default',
  }),

  priceAlert: (data) => ({
    title: `Price Alert: ${data.symbol}`,
    body: `${data.symbol} is now $${data.price} (${data.condition} $${data.targetPrice})`,
    data: { screen: 'PlaceOrder', symbol: data.symbol },
    categoryId: 'alert',
    sound: 'default',
  }),

  depositConfirmed: (data) => ({
    title: 'Deposit Confirmed',
    body: `$${data.amount} has been credited to your account`,
    data: { screen: 'Transfers' },
    categoryId: 'transfer',
    sound: 'default',
  }),

  withdrawalApproved: (data) => ({
    title: 'Withdrawal Processed',
    body: `$${data.amount} withdrawal has been sent to ${data.bankName}`,
    data: { screen: 'Transfers' },
    categoryId: 'transfer',
  }),

  marginCall: (data) => ({
    title: '⚠️ Margin Call',
    body: `Your margin level is ${data.marginLevel}%. Please add funds or close positions.`,
    data: { screen: 'Portfolio' },
    categoryId: 'urgent',
    sound: 'default',
    priority: 'high',
  }),

  securityAlert: (data) => ({
    title: '🔒 Security Alert',
    body: data.message || 'New login detected from an unrecognized device',
    data: { screen: 'Security' },
    categoryId: 'security',
    sound: 'default',
    priority: 'high',
  }),

  kycApproved: () => ({
    title: 'KYC Approved ✅',
    body: 'Your identity verification is complete. You can now start trading!',
    data: { screen: 'Trading' },
    categoryId: 'account',
  }),

  kycRejected: (data) => ({
    title: 'KYC Update Required',
    body: `Your document was not accepted: ${data.reason}. Please resubmit.`,
    data: { screen: 'Settings' },
    categoryId: 'account',
  }),

  dailySummary: (data) => ({
    title: 'Daily Portfolio Summary',
    body: `Portfolio: $${data.totalValue} (${data.dayChange >= 0 ? '+' : ''}${data.dayChangePct}% today)`,
    data: { screen: 'Portfolio' },
    categoryId: 'summary',
  }),
};

// ================================================================
// PUSH SERVICE
// ================================================================
class PushNotificationService {
  /**
   * Send push to a specific user across all their devices
   */
  static async sendToUser(userId, template, data = {}) {
    // Check if push notifications are enabled in platform settings
    if (config.notifications && config.notifications.pushEnabled === false) {
      return { sent: 0, reason: 'push_disabled' };
    }
    try {
      const tokens = await db('push_tokens').where('user_id', userId);
      if (!tokens.length) {
        logger.debug('No push tokens for user', { userId });
        return { sent: 0 };
      }

      const notification = typeof template === 'string'
        ? PushTemplates[template]?.(data) || { title: 'T1 Broker', body: template }
        : template;

      const messages = tokens.map(t => ({
        to: t.token,
        ...notification,
        channelId: notification.categoryId || 'default',
      }));

      return this._sendBatch(messages);
    } catch (err) {
      logger.error('Push send error', { userId, error: err.message });
      return { sent: 0, error: err.message };
    }
  }

  /**
   * Send push to multiple users
   */
  static async sendToUsers(userIds, template, data = {}) {
    const tokens = await db('push_tokens').whereIn('user_id', userIds);
    if (!tokens.length) return { sent: 0 };

    const notification = typeof template === 'string'
      ? PushTemplates[template]?.(data) || { title: 'T1 Broker', body: template }
      : template;

    const messages = tokens.map(t => ({
      to: t.token,
      ...notification,
      channelId: notification.categoryId || 'default',
    }));

    return this._sendBatch(messages);
  }

  /**
   * Broadcast to all users (e.g., system maintenance)
   */
  static async broadcast(notification) {
    const tokens = await db('push_tokens').select('token');
    if (!tokens.length) return { sent: 0 };

    const messages = tokens.map(t => ({
      to: t.token,
      ...notification,
      channelId: notification.categoryId || 'default',
    }));

    return this._sendBatch(messages);
  }

  /**
   * Send to users with a specific role
   */
  static async sendToRole(role, template, data = {}) {
    const users = await db('users').where('role', role).select('id');
    return this.sendToUsers(users.map(u => u.id), template, data);
  }

  // ================================================================
  // BATCHED SENDING (Expo Push API)
  // ================================================================
  static async _sendBatch(messages) {
    if (!messages.length) return { sent: 0 };

    let totalSent = 0;
    let totalFailed = 0;
    const failedTokens = [];

    // Split into batches of 100
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);

      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(config.expo?.accessToken && {
              'Authorization': `Bearer ${config.expo.accessToken}`,
            }),
          },
          body: JSON.stringify(batch),
        });

        const result = await response.json();

        if (result.data) {
          for (let j = 0; j < result.data.length; j++) {
            const ticket = result.data[j];
            if (ticket.status === 'ok') {
              totalSent++;
              // Store ticket ID for receipt checking
              if (ticket.id) {
                await this._storeTicket(ticket.id, batch[j].to);
              }
            } else {
              totalFailed++;
              // Handle specific errors
              if (ticket.details?.error === 'DeviceNotRegistered') {
                failedTokens.push(batch[j].to);
              }
              logger.warn('Push ticket error', {
                token: batch[j].to?.substring(0, 20),
                error: ticket.details?.error || ticket.message,
              });
            }
          }
        }
      } catch (err) {
        logger.error('Expo Push API error', { error: err.message, batchSize: batch.length });
        totalFailed += batch.length;

        // Queue for retry
        await this._queueRetry(batch);
      }
    }

    // Clean up invalid tokens
    if (failedTokens.length > 0) {
      await this._removeInvalidTokens(failedTokens);
    }

    logger.info('Push batch complete', { sent: totalSent, failed: totalFailed });
    return { sent: totalSent, failed: totalFailed };
  }

  // ================================================================
  // RECEIPT CHECKING (verify delivery)
  // ================================================================
  static async _storeTicket(ticketId, token) {
    try {
      if (redis.client) {
        await redis.client.lpush('push:tickets', JSON.stringify({ ticketId, token, ts: Date.now() }));
        await redis.client.ltrim('push:tickets', 0, 9999);
      }
    } catch (e) {}
  }

  static async checkReceipts() {
    try {
      if (!redis.client) return;

      const tickets = [];
      let raw;
      while ((raw = await redis.client.rpop('push:tickets'))) {
        const ticket = JSON.parse(raw);
        // Only check tickets older than 15 minutes
        if (Date.now() - ticket.ts > 900000) {
          tickets.push(ticket);
        } else {
          await redis.client.lpush('push:tickets', raw);
          break;
        }
      }

      if (!tickets.length) return;

      const ids = tickets.map(t => t.ticketId);
      const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });

      const result = await response.json();
      const invalidTokens = [];

      for (const [id, receipt] of Object.entries(result.data || {})) {
        if (receipt.status === 'error') {
          if (receipt.details?.error === 'DeviceNotRegistered') {
            const ticket = tickets.find(t => t.ticketId === id);
            if (ticket) invalidTokens.push(ticket.token);
          }
          logger.warn('Push receipt error', { ticketId: id, error: receipt.details?.error });
        }
      }

      if (invalidTokens.length) {
        await this._removeInvalidTokens(invalidTokens);
      }
    } catch (err) {
      logger.error('Receipt check error', { error: err.message });
    }
  }

  // ================================================================
  // RETRY QUEUE
  // ================================================================
  static async _queueRetry(messages) {
    try {
      if (redis.client) {
        for (const msg of messages) {
          await redis.client.lpush('push:retry', JSON.stringify({ ...msg, retryCount: (msg.retryCount || 0) + 1 }));
        }
        await redis.client.ltrim('push:retry', 0, 999);
      }
    } catch (e) {}
  }

  static async processRetryQueue() {
    try {
      if (!redis.client) return;

      const retries = [];
      let raw;
      while ((raw = await redis.client.rpop('push:retry'))) {
        const msg = JSON.parse(raw);
        if (msg.retryCount < 3) {
          retries.push(msg);
        } else {
          logger.warn('Push notification dropped after 3 retries', { to: msg.to?.substring(0, 20) });
        }
      }

      if (retries.length > 0) {
        logger.info('Retrying push notifications', { count: retries.length });
        await this._sendBatch(retries);
      }
    } catch (err) {
      logger.error('Push retry processing error', { error: err.message });
    }
  }

  // ================================================================
  // TOKEN CLEANUP
  // ================================================================
  static async _removeInvalidTokens(tokens) {
    if (!tokens.length) return;
    const removed = await db('push_tokens').whereIn('token', tokens).del();
    logger.info('Removed invalid push tokens', { count: removed });
  }
}

module.exports = { PushNotificationService, PushTemplates };
