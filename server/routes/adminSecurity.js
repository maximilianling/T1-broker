// ================================================================
// T1 BROKER — ADMIN SECURITY API ROUTES
// IP blocklist management, threat intelligence dashboard,
// WAF event log, security settings, and scanner detection
// ================================================================
const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const redis = require('../utils/redis');
const db = require('../config/database');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const { logSecurityEvent, SecurityEvent } = require('../middleware/securityHardening');

router.use(authenticate);
router.use(authorize('super_admin', 'admin'));

// ================================================================
// GET /admin/security/dashboard — Security overview stats
// ================================================================
router.get('/dashboard', async (req, res) => {
  try {
    const stats = {};

    // Blocked IPs count
    stats.blockedIPs = 0;
    if (redis.client) {
      stats.blockedIPs = await redis.client.scard('security:blocked_ips') || 0;
    }

    // Recent security events from audit log (last 24h)
    const since = new Date(Date.now() - 86400000);
    const secEvents = await db('audit_log')
      .where('resource_type', 'security')
      .where('created_at', '>', since)
      .count()
      .first();
    stats.securityEvents24h = parseInt(secEvents?.count || 0);

    // Critical events last 24h
    const critEvents = await db('audit_log')
      .where('resource_type', 'security')
      .where('level', 'critical')
      .where('created_at', '>', since)
      .count()
      .first();
    stats.criticalEvents24h = parseInt(critEvents?.count || 0);

    // Failed logins last 24h
    const failedLogins = await db('audit_log')
      .where('action', 'like', '%login failed%')
      .where('created_at', '>', since)
      .count()
      .first();
    stats.failedLogins24h = parseInt(failedLogins?.count || 0);

    // Active sessions count
    const activeSessions = await db('user_sessions')
      .whereNull('revoked_at')
      .where('expires_at', '>', new Date())
      .count()
      .first();
    stats.activeSessions = parseInt(activeSessions?.count || 0);

    // WAF blocks (from Redis counter)
    stats.wafBlocks24h = 0;
    if (redis.client) {
      stats.wafBlocks24h = parseInt(await redis.client.get('stats:waf_blocks_24h') || '0');
    }

    // Threat score breakdown
    stats.highThreatIPs = 0;
    if (redis.client) {
      const keys = await redis.client.keys('threat:score:*');
      let highCount = 0;
      for (const key of keys.slice(0, 500)) {
        const score = parseInt(await redis.client.get(key) || '0');
        if (score >= 50) highCount++;
      }
      stats.highThreatIPs = highCount;
    }

    res.json(stats);
  } catch (err) {
    logger.error('Security dashboard error', { error: err.message });
    res.status(500).json({ error: 'Failed to load security dashboard' });
  }
});

// ================================================================
// GET /admin/security/events — Security event log
// ================================================================
router.get('/events', async (req, res) => {
  try {
    const { limit = 100, level, since } = req.query;
    let query = db('audit_log')
      .where('resource_type', 'security')
      .orderBy('created_at', 'desc')
      .limit(Math.min(parseInt(limit), 500));

    if (level) query = query.where('level', level);
    if (since) query = query.where('created_at', '>', new Date(since));

    const events = await query.select(
      'id', 'action', 'level', 'ip_address', 'user_id',
      'metadata', 'created_at'
    );

    res.json({ data: events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load security events' });
  }
});

// ================================================================
// GET /admin/security/blocked-ips — List all blocked IPs
// ================================================================
router.get('/blocked-ips', async (req, res) => {
  try {
    const ips = [];
    if (redis.client) {
      const blocked = await redis.client.smembers('security:blocked_ips');
      for (const ip of blocked) {
        const reason = await redis.client.get(`security:block_reason:${ip}`) || 'Manual block';
        const ttl = await redis.client.ttl(`security:block_reason:${ip}`);
        ips.push({ ip, reason, expiresIn: ttl > 0 ? ttl : null });
      }
    }
    res.json({ data: ips });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list blocked IPs' });
  }
});

// ================================================================
// POST /admin/security/block-ip — Manually block an IP
// ================================================================
router.post('/block-ip', async (req, res) => {
  try {
    const { ip, reason, durationHours = 24 } = req.body;
    if (!ip || !/^[\d.:a-fA-F]+$/.test(ip)) {
      return res.status(400).json({ error: 'Invalid IP address' });
    }

    const durationSec = Math.min(durationHours * 3600, 30 * 86400); // max 30 days

    if (redis.client) {
      await redis.client.sadd('security:blocked_ips', ip);
      await redis.client.set(
        `security:block_reason:${ip}`,
        reason || `Manual block by ${req.user.email}`,
        'EX', durationSec
      );
    }

    logSecurityEvent(SecurityEvent.IP_BLOCKED, 'high', {
      ip, reason, blockedBy: req.user.email, durationHours,
    });

    AuditService.log({
      userId: req.user.id,
      action: `IP blocked: ${ip} — ${reason || 'Manual'} (${durationHours}h)`,
      resourceType: 'security', level: 'warning',
      ipAddress: req.ip,
    });

    res.json({ success: true, ip, expiresIn: durationSec });
  } catch (err) {
    res.status(500).json({ error: 'Failed to block IP' });
  }
});

// ================================================================
// DELETE /admin/security/block-ip/:ip — Unblock an IP
// ================================================================
router.delete('/block-ip/:ip', async (req, res) => {
  try {
    const { ip } = req.params;
    if (redis.client) {
      await redis.client.srem('security:blocked_ips', ip);
      await redis.client.del(`security:block_reason:${ip}`);
      await redis.client.del(`threat:score:${ip}`);
    }

    AuditService.log({
      userId: req.user.id,
      action: `IP unblocked: ${ip}`,
      resourceType: 'security', level: 'info',
      ipAddress: req.ip,
    });

    res.json({ success: true, ip });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock IP' });
  }
});

// ================================================================
// GET /admin/security/threat-scores — Active threat scores
// ================================================================
router.get('/threat-scores', async (req, res) => {
  try {
    const threats = [];
    if (redis.client) {
      const keys = await redis.client.keys('threat:score:*');
      for (const key of keys.slice(0, 200)) {
        const ip = key.replace('threat:score:', '');
        const score = parseInt(await redis.client.get(key) || '0');
        const ttl = await redis.client.ttl(key);
        if (score > 0) {
          threats.push({ ip, score, ttl, severity: score >= 100 ? 'critical' : score >= 50 ? 'high' : 'medium' });
        }
      }
      threats.sort((a, b) => b.score - a.score);
    }
    res.json({ data: threats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load threat scores' });
  }
});

// ================================================================
// POST /admin/security/reset-threat/:ip — Reset threat score
// ================================================================
router.post('/reset-threat/:ip', async (req, res) => {
  try {
    const { ip } = req.params;
    if (redis.client) {
      await redis.client.del(`threat:score:${ip}`);
    }
    res.json({ success: true, ip });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset threat score' });
  }
});

// ================================================================
// GET /admin/security/sessions — Active user sessions
// ================================================================
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await db('user_sessions as s')
      .join('users as u', 's.user_id', 'u.id')
      .whereNull('s.revoked_at')
      .where('s.expires_at', '>', new Date())
      .select(
        's.id', 'u.email', 'u.role',
        's.ip_address', 's.user_agent',
        's.created_at', 's.expires_at', 's.last_active_at'
      )
      .orderBy('s.last_active_at', 'desc')
      .limit(200);

    res.json({ data: sessions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ================================================================
// POST /admin/security/revoke-session/:id — Force-terminate session
// ================================================================
router.post('/revoke-session/:id', async (req, res) => {
  try {
    await db('user_sessions')
      .where('id', req.params.id)
      .update({ revoked_at: new Date() });

    AuditService.log({
      userId: req.user.id,
      action: `Session forcefully revoked: ${req.params.id}`,
      resourceType: 'security', level: 'warning',
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// ================================================================
// POST /admin/security/revoke-all-sessions — Nuclear option
// ================================================================
router.post('/revoke-all-sessions',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const result = await db('user_sessions')
        .whereNull('revoked_at')
        .where('expires_at', '>', new Date())
        .update({ revoked_at: new Date() });

      AuditService.log({
        userId: req.user.id,
        action: `ALL sessions revoked (${result} sessions)`,
        resourceType: 'security', level: 'critical',
        ipAddress: req.ip,
      });

      res.json({ success: true, revoked: result });
    } catch (err) {
      res.status(500).json({ error: 'Failed to revoke sessions' });
    }
  }
);

// ================================================================
// POST /admin/security/flush-threats — Clear all threat scores
// ================================================================
router.post('/flush-threats',
  authorize('super_admin'),
  async (req, res) => {
    try {
      if (redis.client) {
        const keys = await redis.client.keys('threat:score:*');
        if (keys.length) await redis.client.del(...keys);
        await redis.client.del('security:blocked_ips');
      }

      AuditService.log({
        userId: req.user.id,
        action: 'All threat scores and IP blocks flushed',
        resourceType: 'security', level: 'critical',
        ipAddress: req.ip,
      });

      res.json({ success: true, cleared: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to flush threats' });
    }
  }
);

module.exports = router;
