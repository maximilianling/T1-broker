// ================================================================
// T1 BROKER — AUDIT SERVICE
// Immutable, hash-chained audit log
// ================================================================
const db = require('../config/database');
const logger = require('./logger');

class AuditService {
  /**
   * Log an audit event
   * @param {Object} params
   * @param {string} params.userId - User performing the action
   * @param {string} params.userEmail
   * @param {string} params.userRole
   * @param {string} params.action - Description of the action
   * @param {string} params.resourceType - e.g., 'client', 'order', 'position'
   * @param {string} params.resourceId
   * @param {string} params.level - 'info', 'warning', 'critical', 'success'
   * @param {string} params.ipAddress
   * @param {string} params.userAgent
   * @param {Object} params.oldValues - Previous state (for updates)
   * @param {Object} params.newValues - New state (for updates)
   * @param {Object} params.metadata - Additional context
   */
  static async log({
    userId, userEmail, userRole, action, resourceType, resourceId,
    level = 'info', ipAddress, userAgent, oldValues, newValues, metadata,
  }) {
    try {
      const [entry] = await db('audit_log')
        .insert({
          user_id: userId,
          user_email: userEmail,
          user_role: userRole,
          action,
          resource_type: resourceType,
          resource_id: resourceId,
          level,
          ip_address: ipAddress,
          user_agent: userAgent,
          old_values: oldValues ? JSON.stringify(oldValues) : null,
          new_values: newValues ? JSON.stringify(newValues) : null,
          metadata: metadata ? JSON.stringify(metadata) : null,
        })
        .returning('*');

      if (level === 'critical') {
        logger.error(`CRITICAL AUDIT EVENT: ${action}`, {
          userId, resourceType, resourceId, ipAddress,
        });
        // In production: trigger SIEM alert, send Slack/PagerDuty notification
      }

      return entry;
    } catch (err) {
      // Audit logging must never fail silently — log to stderr as backup
      logger.error('AUDIT LOG FAILURE — this is critical', {
        error: err.message,
        action,
        userId,
        resourceType,
        resourceId,
      });
      // In production: write to fallback file, trigger alert
    }
  }

  /**
   * Query audit log with filters
   */
  static async query({
    userId, action, resourceType, resourceId, level,
    startDate, endDate, limit = 50, offset = 0,
  }) {
    let query = db('audit_log').select('*').orderBy('timestamp', 'desc');

    if (userId) query = query.where('user_id', userId);
    if (action) query = query.where('action', 'ilike', `%${action}%`);
    if (resourceType) query = query.where('resource_type', resourceType);
    if (resourceId) query = query.where('resource_id', resourceId);
    if (level) query = query.where('level', level);
    if (startDate) query = query.where('timestamp', '>=', startDate);
    if (endDate) query = query.where('timestamp', '<=', endDate);

    const [{ count }] = await query.clone().count();
    const entries = await query.limit(limit).offset(offset);

    return { entries, total: parseInt(count), limit, offset };
  }

  /**
   * Verify hash chain integrity
   */
  static async verifyChainIntegrity(startId, endId) {
    const entries = await db('audit_log')
      .where('id', '>=', startId)
      .where('id', '<=', endId)
      .orderBy('id', 'asc');

    let valid = true;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].prev_hash !== entries[i - 1].event_hash) {
        valid = false;
        logger.error('AUDIT CHAIN BREAK DETECTED', {
          brokenAt: entries[i].id,
          expected: entries[i - 1].event_hash,
          got: entries[i].prev_hash,
        });
        break;
      }
    }
    return { valid, checked: entries.length };
  }
}

module.exports = AuditService;
