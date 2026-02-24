// ================================================================
// T1 BROKER — BACKGROUND JOB SCHEDULER
// Cron-style task runner for all periodic operations
// ================================================================
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const { emailService } = require('../services/notifications');
const MarginEngine = require('../services/margin');
const ReconciliationService = require('../services/reconciliation');
const AuditService = require('../utils/audit');

class JobScheduler {
  constructor() {
    this.jobs = new Map();
    this.running = false;
    this.timers = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info('🔄 Job scheduler started');

    // ---- Email queue processor: every 5 seconds ----
    this._schedule('email-queue', 5000, async () => {
      let processed = 0;
      while (processed < 10) { // batch of 10
        const result = await emailService.processQueue();
        if (!result) break;
        processed++;
      }
      // Also process retry queue
      const retryRaw = await redis.client?.rpop('email:retry');
      if (retryRaw) {
        await redis.client.lpush('email:queue', retryRaw);
      }
      if (processed > 0) logger.debug(`Processed ${processed} emails`);
    });

    // ---- Margin sweep: every 60 seconds during market hours ----
    this._schedule('margin-sweep', 60000, async () => {
      // Only run during US market hours (simplified)
      const hour = new Date().getUTCHours();
      if (hour >= 13 && hour <= 21) { // ~9AM-5PM ET
        const lock = await redis.acquireLock('margin-sweep', 120);
        if (lock) {
          try {
            await MarginEngine.runMarginSweep();
          } finally {
            await redis.releaseLock('margin-sweep', lock);
          }
        }
      }
    });

    // ---- Position snapshot: once daily at 21:30 UTC (after US close) ----
    this._schedule('position-snapshot', 60000, async () => {
      const now = new Date();
      if (now.getUTCHours() === 21 && now.getUTCMinutes() >= 30 && now.getUTCMinutes() < 31) {
        const lock = await redis.acquireLock('position-snapshot', 600);
        if (lock) {
          try {
            await this._takePositionSnapshot();
          } finally {
            await redis.releaseLock('position-snapshot', lock);
          }
        }
      }
    });

    // ---- Reconciliation: once daily at 6:00 UTC ----
    this._schedule('reconciliation', 60000, async () => {
      const now = new Date();
      if (now.getUTCHours() === 6 && now.getUTCMinutes() >= 0 && now.getUTCMinutes() < 1) {
        const lock = await redis.acquireLock('reconciliation', 1800);
        if (lock) {
          try {
            await ReconciliationService.runReconciliation('drivewealth');
            await ReconciliationService.runReconciliation('saxo');
          } finally {
            await redis.releaseLock('reconciliation', lock);
          }
        }
      }
    });

    // ---- KYC expiry check: once daily at 8:00 UTC ----
    this._schedule('kyc-expiry', 60000, async () => {
      const now = new Date();
      if (now.getUTCHours() === 8 && now.getUTCMinutes() >= 0 && now.getUTCMinutes() < 1) {
        const lock = await redis.acquireLock('kyc-expiry', 300);
        if (lock) {
          try {
            await this._checkKycExpiry();
          } finally {
            await redis.releaseLock('kyc-expiry', lock);
          }
        }
      }
    });

    // ---- Session cleanup: every 15 minutes ----
    this._schedule('session-cleanup', 900000, async () => {
      const deleted = await db('user_sessions')
        .where('expires_at', '<', new Date())
        .del();
      if (deleted > 0) logger.debug(`Cleaned ${deleted} expired sessions`);
    });

    // ---- Stale order cleanup: every 5 minutes ----
    this._schedule('stale-orders', 300000, async () => {
      // Cancel day orders that are still "pending" from previous day
      const yesterday = new Date(Date.now() - 24 * 3600000);
      const stale = await db('orders')
        .whereIn('status', ['pending', 'submitted'])
        .where('time_in_force', 'day')
        .where('created_at', '<', yesterday.toISOString().slice(0, 10))
        .update({ status: 'expired', cancelled_at: new Date() });

      if (stale > 0) {
        logger.info(`Expired ${stale} stale day orders`);
        AuditService.log({
          action: `Expired ${stale} stale day orders`,
          resourceType: 'order',
          level: 'info',
        });
      }
    });

    // ---- Health metrics: every 30 seconds ----
    this._schedule('health-metrics', 30000, async () => {
      try {
        const [
          { count: activeOrders },
          { count: pendingTransfers },
          { count: activeSessions },
        ] = await Promise.all([
          db('orders').whereIn('status', ['pending', 'submitted', 'working', 'partially_filled']).count().first(),
          db('cash_transactions').where('status', 'pending_approval').count().first(),
          db('user_sessions').where('expires_at', '>', new Date()).whereNull('revoked_at').count().first(),
        ]);

        const metrics = {
          activeOrders: parseInt(activeOrders),
          pendingTransfers: parseInt(pendingTransfers),
          activeSessions: parseInt(activeSessions),
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: Date.now(),
        };

        await redis.set('metrics:latest', metrics, 60);
      } catch (e) { /* non-critical */ }
    });

    // ---- Internal settlement: every hour, check for due trades ----
    this._schedule('internal-settlement', 3600000, async () => {
      try {
        const { MatchingEngine } = require('../services/clearingEngine');
        const today = new Date().toISOString().slice(0, 10);
        const result = await MatchingEngine.runSettlement(today, null);
        if (result.trades > 0) {
          logger.info('Auto-settlement completed', { trades: result.trades, volume: result.volume });
        }
      } catch (e) {
        logger.warn('Auto-settlement check failed', { error: e.message });
      }
    });

    // ---- Crypto wallet sweep check: every 15 minutes ----
    this._schedule('wallet-sweep', 900000, async () => {
      try {
        const CryptoWalletService = require('../services/cryptoWallet');
        await CryptoWalletService.checkAndSweep();
      } catch (e) {
        logger.warn('Wallet sweep check failed', { error: e.message });
      }
    });

    // ---- Provider daily request counter reset: every day at midnight ----
    this._schedule('provider-reset', 3600000, async () => {
      try {
        const hour = new Date().getHours();
        if (hour === 0) {
          await db('market_data_providers').update({ requests_today: 0 });
          logger.info('Provider daily request counters reset');
        }
      } catch (e) { /* non-critical */ }
    });

    // ---- Database backup: check every minute against scheduled times ----
    this._schedule('database-backup', 60000, async () => {
      try {
        const DatabaseBackupService = require('../services/databaseBackup');
        const shouldRun = await DatabaseBackupService.shouldRunScheduledBackup();
        if (shouldRun) {
          const lock = await redis.acquireLock('database-backup', 600);
          if (lock) {
            try {
              logger.info('Running scheduled database backup');
              await DatabaseBackupService.createBackup({ triggerType: 'scheduled' });
            } finally {
              await redis.releaseLock('database-backup', lock);
            }
          }
        }
      } catch (e) {
        logger.error('Scheduled backup failed', { error: e.message });
      }
    });
  }

  // ----------------------------------------------------------------
  // Position snapshot job
  // ----------------------------------------------------------------
  async _takePositionSnapshot() {
    const today = new Date().toISOString().slice(0, 10);
    logger.info('Taking EOD position snapshot', { date: today });

    const positions = await db('positions as p')
      .join('instruments as i', 'i.id', 'p.instrument_id')
      .whereNull('p.closed_at')
      .select('p.*', 'i.last_price');

    if (positions.length === 0) return;

    const snapshots = positions.map(p => ({
      client_id: p.client_id,
      instrument_id: p.instrument_id,
      snapshot_date: today,
      side: p.side,
      quantity: p.quantity,
      avg_cost: p.avg_cost,
      market_price: p.last_price || p.avg_cost,
      market_value: parseFloat(p.quantity) * parseFloat(p.last_price || p.avg_cost),
      unrealized_pnl: p.side === 'long'
        ? (parseFloat(p.last_price || p.avg_cost) - parseFloat(p.avg_cost)) * parseFloat(p.quantity)
        : (parseFloat(p.avg_cost) - parseFloat(p.last_price || p.avg_cost)) * parseFloat(p.quantity),
    }));

    await db('position_snapshots')
      .insert(snapshots)
      .onConflict(['client_id', 'instrument_id', 'snapshot_date'])
      .merge();

    AuditService.log({
      action: `Position snapshot: ${snapshots.length} positions captured for ${today}`,
      resourceType: 'system',
      level: 'success',
    });

    logger.info(`Position snapshot complete: ${snapshots.length} positions`, { date: today });
  }

  // ----------------------------------------------------------------
  // KYC expiry check
  // ----------------------------------------------------------------
  async _checkKycExpiry() {
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 3600000);

    // Clients with KYC expiring in next 30 days
    const expiring = await db('clients')
      .where('kyc_status', 'approved')
      .where('kyc_expiry_date', '<=', thirtyDaysFromNow.toISOString().slice(0, 10))
      .where('kyc_expiry_date', '>', new Date().toISOString().slice(0, 10));

    for (const client of expiring) {
      const user = await db('users').where('id', client.user_id).first();

      // Check if we already notified in last 7 days
      const recentNotif = await db('notifications')
        .where('user_id', client.user_id)
        .where('title', 'ilike', '%kyc%renewal%')
        .where('created_at', '>=', new Date(Date.now() - 7 * 24 * 3600000))
        .first();

      if (!recentNotif) {
        const { NotificationService } = require('../services/notifications');
        await NotificationService.create({
          userId: client.user_id,
          title: 'KYC Renewal Required',
          message: `Your KYC verification expires on ${client.kyc_expiry_date}. Please update your documents.`,
          type: 'warning',
        });

        await emailService.send({
          to: user.email,
          subject: emailService.getSubject('rekycReminder', {}),
          template: 'rekycReminder',
          data: { name: client.first_name, expiryDate: client.kyc_expiry_date },
        });
      }
    }

    // Clients whose KYC has already expired
    const expired = await db('clients')
      .where('kyc_status', 'approved')
      .where('kyc_expiry_date', '<', new Date().toISOString().slice(0, 10));

    if (expired.length > 0) {
      await db('clients')
        .whereIn('id', expired.map(c => c.id))
        .update({ kyc_status: 'rekyc_required' });

      logger.warn(`${expired.length} clients flagged for re-KYC`);
    }

    if (expiring.length > 0 || expired.length > 0) {
      logger.info('KYC expiry check', { expiringSoon: expiring.length, expired: expired.length });
    }
  }

  // ----------------------------------------------------------------
  // Scheduler internals
  // ----------------------------------------------------------------
  _schedule(name, intervalMs, fn) {
    const wrappedFn = async () => {
      try {
        await fn();
      } catch (err) {
        logger.error(`Job ${name} failed`, { error: err.message, stack: err.stack });
      }
    };

    const timer = setInterval(wrappedFn, intervalMs);
    this.timers.push(timer);
    this.jobs.set(name, { interval: intervalMs, lastRun: null, timer });
    logger.debug(`Scheduled job: ${name} (every ${intervalMs / 1000}s)`);
  }

  stop() {
    this.running = false;
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
    this.jobs.clear();
    logger.info('Job scheduler stopped');
  }

  getStatus() {
    const status = {};
    this.jobs.forEach((job, name) => {
      status[name] = { interval: job.interval, running: this.running };
    });
    return status;
  }
}

module.exports = new JobScheduler();
