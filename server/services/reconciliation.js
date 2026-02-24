// ================================================================
// T1 BROKER — RECONCILIATION SERVICE
// Daily position & cash reconciliation: T1 ↔ Saxo Bank ↔ DriveWealth
// ================================================================
const db = require('../config/database');
const saxo = require('./saxo');
const drivewealth = require('./drivewealth');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');

class ReconciliationService {
  /**
   * Run full reconciliation for a specific broker
   */
  static async runReconciliation(broker) {
    const runDate = new Date().toISOString().slice(0, 10);
    logger.info(`Starting reconciliation for ${broker}`, { runDate });

    const [run] = await db('reconciliation_runs').insert({
      broker,
      run_date: runDate,
      status: 'running',
    }).returning('*');

    try {
      // 1. Get internal positions
      const internalPositions = await db('positions')
        .where('broker', broker)
        .whereNull('closed_at')
        .select('*');

      // 2. Get broker positions
      let brokerPositions = [];
      if (broker === 'drivewealth') {
        brokerPositions = await this._getDriveWealthPositions();
      } else if (broker === 'saxo') {
        brokerPositions = await this._getSaxoPositions();
      }

      // 3. Match positions
      let matched = 0;
      let unmatched = 0;
      const breaks = [];

      for (const internal of internalPositions) {
        const brokerId = broker === 'drivewealth'
          ? internal.broker_position_id
          : internal.broker_position_id;

        const external = brokerPositions.find(bp => bp.id === brokerId);

        if (!external) {
          breaks.push({
            run_id: run.id,
            client_id: internal.client_id,
            instrument_id: internal.instrument_id,
            break_type: 'missing_position',
            internal_value: parseFloat(internal.quantity),
            broker_value: 0,
            difference: parseFloat(internal.quantity),
          });
          unmatched++;
          continue;
        }

        const internalQty = parseFloat(internal.quantity);
        const externalQty = parseFloat(external.quantity);

        if (Math.abs(internalQty - externalQty) > 0.0001) {
          breaks.push({
            run_id: run.id,
            client_id: internal.client_id,
            instrument_id: internal.instrument_id,
            break_type: 'position_mismatch',
            internal_value: internalQty,
            broker_value: externalQty,
            difference: internalQty - externalQty,
          });
          unmatched++;
        } else {
          matched++;
        }
      }

      // 4. Check for positions at broker that we don't have internally
      for (const bp of brokerPositions) {
        const hasInternal = internalPositions.find(ip => ip.broker_position_id === bp.id);
        if (!hasInternal) {
          breaks.push({
            run_id: run.id,
            break_type: 'missing_position',
            internal_value: 0,
            broker_value: parseFloat(bp.quantity),
            difference: -parseFloat(bp.quantity),
          });
          unmatched++;
        }
      }

      // 5. Cash reconciliation
      const [{ sum: internalCash }] = await db('accounts')
        .where('broker', broker)
        .sum('cash_balance as sum');

      let brokerCash = 0;
      try {
        if (broker === 'drivewealth') {
          // Sum all DW account balances
          const accounts = await db('accounts')
            .where('broker', 'drivewealth')
            .whereNotNull('broker_account_id');
          for (const acct of accounts) {
            const summary = await drivewealth.getAccountSummary(acct.broker_account_id);
            brokerCash += parseFloat(summary.cash?.cashAvailableForWithdrawal || 0);
          }
        }
      } catch (e) {
        logger.warn('Could not fetch broker cash for reconciliation', { error: e.message });
      }

      const cashDiff = parseFloat(internalCash?.sum || 0) - brokerCash;
      const cashMatched = Math.abs(cashDiff) < 0.01;

      if (!cashMatched) {
        breaks.push({
          run_id: run.id,
          break_type: 'cash_mismatch',
          internal_value: parseFloat(internalCash?.sum || 0),
          broker_value: brokerCash,
          difference: cashDiff,
        });
      }

      // 6. Save breaks
      if (breaks.length > 0) {
        await db('reconciliation_breaks').insert(breaks);
      }

      // 7. Update run status
      const status = breaks.length === 0 ? 'matched' : 'discrepancy';
      await db('reconciliation_runs').where('id', run.id).update({
        status,
        positions_matched: matched,
        positions_unmatched: unmatched,
        cash_matched: cashMatched,
        cash_difference: cashDiff,
        completed_at: new Date(),
        details: JSON.stringify({
          internalPositions: internalPositions.length,
          brokerPositions: brokerPositions.length,
          breaks: breaks.length,
        }),
      });

      AuditService.log({
        action: `Reconciliation ${status}: ${broker} (${matched} matched, ${unmatched} breaks)`,
        resourceType: 'reconciliation',
        resourceId: run.id,
        level: status === 'matched' ? 'success' : 'warning',
      });

      logger.info(`Reconciliation complete for ${broker}`, { status, matched, unmatched, breaks: breaks.length });

      return { runId: run.id, status, matched, unmatched, breaks: breaks.length, cashMatched };
    } catch (err) {
      await db('reconciliation_runs').where('id', run.id).update({
        status: 'failed',
        completed_at: new Date(),
        details: JSON.stringify({ error: err.message }),
      });

      logger.error('Reconciliation failed', { broker, error: err.message });
      throw err;
    }
  }

  static async _getDriveWealthPositions() {
    try {
      const accounts = await db('accounts')
        .where('broker', 'drivewealth')
        .whereNotNull('broker_account_id');

      const allPositions = [];
      for (const acct of accounts) {
        const positions = await drivewealth.getPositions(acct.broker_account_id);
        allPositions.push(...(positions || []).map(p => ({
          id: p.instrumentID,
          quantity: parseFloat(p.openQty),
          avgCost: parseFloat(p.avgPrice),
          accountId: acct.broker_account_id,
        })));
      }
      return allPositions;
    } catch (err) {
      logger.error('Failed to fetch DW positions for recon', { error: err.message });
      return [];
    }
  }

  static async _getSaxoPositions() {
    try {
      const accounts = await db('accounts')
        .where('broker', 'saxo')
        .whereNotNull('broker_account_id');

      const allPositions = [];
      for (const acct of accounts) {
        const positions = await saxo.getPositions(acct.broker_account_id);
        allPositions.push(...(positions || []).map(p => ({
          id: p.PositionId,
          quantity: parseFloat(p.PositionBase?.Amount || 0),
          avgCost: parseFloat(p.PositionBase?.AverageOpenPrice || 0),
          accountKey: acct.broker_account_id,
        })));
      }
      return allPositions;
    } catch (err) {
      logger.error('Failed to fetch Saxo positions for recon', { error: err.message });
      return [];
    }
  }

  /**
   * Schedule daily reconciliation (call from cron or startup)
   */
  static scheduleDaily() {
    // Run at 6:00 AM UTC daily
    const now = new Date();
    const next6am = new Date(now);
    next6am.setUTCHours(6, 0, 0, 0);
    if (next6am <= now) next6am.setDate(next6am.getDate() + 1);

    const delay = next6am - now;
    setTimeout(async () => {
      try {
        await ReconciliationService.runReconciliation('drivewealth');
        await ReconciliationService.runReconciliation('saxo');
      } catch (e) {
        logger.error('Scheduled reconciliation failed', { error: e.message });
      }
      // Reschedule for next day
      ReconciliationService.scheduleDaily();
    }, delay);

    logger.info(`Reconciliation scheduled for ${next6am.toISOString()}`);
  }
}

module.exports = ReconciliationService;
