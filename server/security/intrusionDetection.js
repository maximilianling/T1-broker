// ================================================================
// T1 BROKER — INTRUSION DETECTION & PREVENTION SYSTEM (IDS/IPS)
// Behavioral analysis, auto-blocking, threat escalation,
// honeypot endpoints, session anomaly detection, geo-fencing
// ================================================================
const crypto = require('crypto');
const redis = require('../utils/redis');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const { logSecurityEvent, SecurityEvent } = require('../middleware/securityHardening');

// ================================================================
// 1. THREAT SCORING ENGINE
// Tracks cumulative threat score per IP with automatic escalation
// ================================================================
const THREAT_THRESHOLDS = {
  MONITOR:  10,  // Start enhanced logging
  THROTTLE: 25,  // Slow down responses (tarpit)
  CAPTCHA:  40,  // Would require CAPTCHA (flag in response)
  TEMP_BAN: 60,  // 15-minute block
  HARD_BAN: 100, // 24-hour block
};

const THREAT_WEIGHTS = {
  failed_login:         5,
  invalid_token:        3,
  blocked_request:      8,
  sql_injection:       15,
  xss_attempt:         10,
  path_traversal:      12,
  scanner_detected:     7,
  credential_stuffing: 20,
  rate_limit_hit:       4,
  session_mismatch:    15,
  honeypot_trigger:    30,
  forbidden_access:     6,
  malformed_request:    5,
  oversized_payload:    3,
  replay_attack:       12,
  brute_force_mfa:     10,
  unauthorized_admin:  15,
  data_exfil_attempt:  20,
};

class ThreatScorer {
  /**
   * Increment threat score for an IP
   * @returns {object} { score, action, blocked }
   */
  static async score(ip, reason, extraWeight = 0) {
    if (!redis.client || !ip) return { score: 0, action: 'none', blocked: false };

    const weight = (THREAT_WEIGHTS[reason] || 5) + extraWeight;
    const key = `ids:threat:${ip}`;
    const historyKey = `ids:history:${ip}`;

    try {
      // Increment score with 1-hour decay window
      const score = await redis.client.incrbyfloat(key, weight);
      await redis.client.expire(key, 3600); // Reset after 1 hour of inactivity

      // Store event in history (capped list)
      await redis.client.lpush(historyKey, JSON.stringify({
        reason, weight, time: Date.now(),
      }));
      await redis.client.ltrim(historyKey, 0, 49); // Keep last 50 events
      await redis.client.expire(historyKey, 7200);

      // Determine action based on score
      let action = 'none';
      let blocked = false;

      if (score >= THREAT_THRESHOLDS.HARD_BAN) {
        action = 'hard_ban';
        blocked = true;
        await this.banIP(ip, 86400, `Threat score ${score}: ${reason}`);
      } else if (score >= THREAT_THRESHOLDS.TEMP_BAN) {
        action = 'temp_ban';
        blocked = true;
        await this.banIP(ip, 900, `Threat score ${score}: ${reason}`);
      } else if (score >= THREAT_THRESHOLDS.CAPTCHA) {
        action = 'captcha_required';
      } else if (score >= THREAT_THRESHOLDS.THROTTLE) {
        action = 'throttle';
      } else if (score >= THREAT_THRESHOLDS.MONITOR) {
        action = 'enhanced_monitoring';
      }

      if (action !== 'none') {
        logger.warn(`IDS: IP ${ip} — score ${Math.round(score)}, action: ${action}`, {
          reason, weight, totalScore: Math.round(score),
        });
      }

      return { score: Math.round(score), action, blocked };
    } catch (e) {
      return { score: 0, action: 'none', blocked: false };
    }
  }

  static async getScore(ip) {
    if (!redis.client) return 0;
    try {
      return parseFloat(await redis.client.get(`ids:threat:${ip}`)) || 0;
    } catch (e) { return 0; }
  }

  static async banIP(ip, durationSeconds, reason) {
    if (!redis.client) return;
    try {
      await redis.client.set(`ids:banned:${ip}`, reason, 'EX', durationSeconds);
      await redis.client.sadd('security:blocked_ips', ip);
      // Auto-expire from set
      if (durationSeconds < 86400) {
        setTimeout(async () => {
          try { await redis.client.srem('security:blocked_ips', ip); } catch (e) {}
        }, durationSeconds * 1000);
      }

      logSecurityEvent(SecurityEvent.IP_BLOCKED, 'critical', {
        ip, reason, duration: durationSeconds,
      });
    } catch (e) {}
  }

  static async isBanned(ip) {
    if (!redis.client) return false;
    try {
      return !!(await redis.client.get(`ids:banned:${ip}`));
    } catch (e) { return false; }
  }
}

// ================================================================
// 2. IDS MIDDLEWARE — Real-time threat detection
// ================================================================
function idsMiddleware() {
  return async (req, res, next) => {
    const ip = req.ip;

    // Check if already banned
    if (await ThreatScorer.isBanned(ip)) {
      logSecurityEvent(SecurityEvent.IP_BLOCKED, 'high', {
        ip, path: req.path, method: req.method,
      });
      return res.status(403).json({
        error: 'Access denied',
        code: 'IP_BANNED',
      });
    }

    // Check threat score for throttling
    const score = await ThreatScorer.getScore(ip);
    if (score >= THREAT_THRESHOLDS.THROTTLE && score < THREAT_THRESHOLDS.TEMP_BAN) {
      // Tarpit: add artificial delay proportional to threat score
      const delay = Math.min((score - THREAT_THRESHOLDS.THROTTLE) * 100, 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Set header to signal threat level to client
    if (score >= THREAT_THRESHOLDS.CAPTCHA) {
      res.setHeader('X-Security-Challenge', 'required');
    }

    // Hook into response to detect failures
    const originalEnd = res.end;
    res.end = function(...args) {
      // Score failed auth attempts
      if (res.statusCode === 401 && req.path.includes('/auth/')) {
        ThreatScorer.score(ip, 'failed_login');
      }
      if (res.statusCode === 401 && req.path.includes('/mfa/')) {
        ThreatScorer.score(ip, 'brute_force_mfa');
      }
      if (res.statusCode === 403) {
        ThreatScorer.score(ip, 'forbidden_access');
      }
      if (res.statusCode === 429) {
        ThreatScorer.score(ip, 'rate_limit_hit');
      }
      originalEnd.apply(res, args);
    };

    next();
  };
}

// ================================================================
// 3. HONEYPOT ENDPOINTS
// Fake endpoints that no legitimate user would access.
// Any hit = immediate high threat score.
// ================================================================
function honeypotRouter() {
  const express = require('express');
  const router = express.Router();

  // Common attack targets that don't exist in our app
  const traps = [
    '/wp-admin', '/wp-login.php', '/administrator',
    '/phpmyadmin', '/pma', '/adminer', '/dbadmin',
    '/.env', '/.git/config', '/.git/HEAD',
    '/xmlrpc.php', '/wp-content', '/wp-includes',
    '/cgi-bin', '/shell', '/cmd', '/command',
    '/api/v1/debug', '/api/v1/test', '/api/v1/internal',
    '/console', '/server-status', '/server-info',
    '/actuator', '/actuator/health', '/actuator/env',
    '/graphql', '/graphiql',
    '/swagger.json', '/api-docs',
    '/config', '/configuration',
    '/.aws/credentials', '/.docker/config.json',
    '/backup', '/backup.sql', '/dump.sql', '/db.sql',
    '/admin.php', '/login.php', '/shell.php',
    '/.htaccess', '/.htpasswd', '/web.config',
  ];

  traps.forEach(path => {
    router.all(path, async (req, res) => {
      const ip = req.ip;
      const ua = req.get('User-Agent') || 'none';

      // Immediate high threat score
      await ThreatScorer.score(ip, 'honeypot_trigger', 10);

      logSecurityEvent('honeypot.triggered', 'critical', {
        ip, path: req.path, method: req.method,
        userAgent: ua.substring(0, 200),
        headers: {
          host: req.get('Host'),
          referer: req.get('Referer'),
          origin: req.get('Origin'),
        },
      });

      // Respond with plausible-looking error after delay (tarpit)
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      res.status(404).json({ error: 'Not found' });
    });
  });

  return router;
}

// ================================================================
// 4. SESSION ANOMALY DETECTOR
// Detects impossible travel, simultaneous sessions, device changes
// ================================================================
class SessionAnomalyDetector {
  /**
   * Check for suspicious session patterns
   */
  static async check(userId, ip, userAgent, sessionId) {
    if (!redis.client || !userId) return { suspicious: false };

    const flags = [];
    const key = `ids:sessions:${userId}`;

    try {
      // Get recent session data
      const sessionsRaw = await redis.client.get(key);
      const sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];

      const current = {
        ip, userAgent: userAgent?.substring(0, 200), sessionId,
        time: Date.now(),
      };

      // Check 1: Simultaneous sessions from vastly different IPs
      const recentSessions = sessions.filter(s => Date.now() - s.time < 300000); // Last 5 min
      const differentIPs = new Set(recentSessions.map(s => s.ip));
      if (differentIPs.size > 3) {
        flags.push('multiple_ips');
      }

      // Check 2: Rapid IP changes (possible proxy rotation)
      const last5 = sessions.slice(-5);
      const ipChanges = last5.reduce((count, s, i) => {
        if (i > 0 && s.ip !== last5[i - 1].ip) return count + 1;
        return count;
      }, 0);
      if (ipChanges >= 3) {
        flags.push('rapid_ip_rotation');
      }

      // Check 3: User-Agent change within same session
      const sameSession = sessions.filter(s => s.sessionId === sessionId);
      if (sameSession.length > 0) {
        const lastUA = sameSession[sameSession.length - 1].userAgent;
        if (lastUA && userAgent && lastUA !== userAgent.substring(0, 200)) {
          flags.push('user_agent_changed');
        }
      }

      // Store current session
      sessions.push(current);
      // Keep last 100 entries, expire in 1 hour
      const trimmed = sessions.slice(-100);
      await redis.client.set(key, JSON.stringify(trimmed), 'EX', 3600);

      if (flags.length > 0) {
        logSecurityEvent('session.anomaly', 'high', {
          userId, ip, flags,
          sessionCount: recentSessions.length,
        });

        // Score the threat
        await ThreatScorer.score(ip, 'session_mismatch', flags.length * 3);
      }

      return {
        suspicious: flags.length > 0,
        flags,
      };
    } catch (e) {
      return { suspicious: false };
    }
  }
}

// ================================================================
// 5. REQUEST CONTEXT INJECTOR
// Sets PostgreSQL session variables for RLS and audit triggers
// ================================================================
function injectDatabaseContext() {
  return async (req, res, next) => {
    if (req.user) {
      try {
        const db = require('../config/database');
        // Set session variables that RLS policies and audit triggers can read
        await db.raw(`
          SET LOCAL app.current_user_id = ?;
          SET LOCAL app.user_role = ?;
          SET LOCAL app.client_ip = ?;
          SET LOCAL app.session_id = ?;
        `, [
          req.user.id || '',
          req.user.role || '',
          req.ip || '',
          req.sessionId || '',
        ]);
      } catch (e) {
        // Non-fatal: RLS might not be enabled yet
        // Log but don't block the request
      }
    }
    next();
  };
}

// ================================================================
// 6. WEBSOCKET SECURITY
// Rate limiting and authentication for WebSocket connections
// ================================================================
class WebSocketSecurity {
  static connectionLimits = new Map(); // ip -> { count, lastReset }

  static validateConnection(req) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();

    // Rate limit: max 10 WS connections per IP per minute
    let limit = this.connectionLimits.get(ip);
    if (!limit || now - limit.lastReset > 60000) {
      limit = { count: 0, lastReset: now };
    }
    limit.count++;
    this.connectionLimits.set(ip, limit);

    if (limit.count > 10) {
      logger.warn('WebSocket connection rate limit exceeded', { ip, count: limit.count });
      ThreatScorer.score(ip, 'rate_limit_hit');
      return false;
    }

    // Validate origin header
    const origin = req.headers.origin;
    if (origin) {
      const config = require('../config');
      const allowedOrigins = [
        config.cors.origin,
        'http://localhost:3000',
        'http://localhost:3001',
      ].filter(Boolean);

      if (config.env === 'production' && !allowedOrigins.includes(origin)) {
        logger.warn('WebSocket connection from unauthorized origin', { ip, origin });
        ThreatScorer.score(ip, 'forbidden_access');
        return false;
      }
    }

    // Message size limit validation hook
    return true;
  }

  static validateMessage(ws, message) {
    // Max message size: 64KB
    if (typeof message === 'string' && message.length > 65536) {
      logger.warn('WebSocket oversized message', { size: message.length });
      return false;
    }
    // Check for injection patterns in message
    if (typeof message === 'string') {
      const dangerous = /<script/i.test(message) || /UNION\s+SELECT/i.test(message);
      if (dangerous) {
        logger.warn('WebSocket suspicious message content');
        return false;
      }
    }
    return true;
  }

  // Cleanup stale entries periodically
  static cleanup() {
    const now = Date.now();
    for (const [ip, limit] of this.connectionLimits) {
      if (now - limit.lastReset > 120000) {
        this.connectionLimits.delete(ip);
      }
    }
  }
}

// Periodic cleanup
setInterval(() => WebSocketSecurity.cleanup(), 60000);

// ================================================================
// 7. SECURITY DASHBOARD DATA
// Aggregated security metrics for the admin interface
// ================================================================
async function getSecurityMetrics() {
  if (!redis.client) return null;

  try {
    const blockedCount = await redis.client.scard('security:blocked_ips');
    const recentEvents = await redis.client.xlen('security:events');

    // Top threat IPs
    const keys = await redis.client.keys('ids:threat:*');
    const threats = [];
    for (const key of keys.slice(0, 20)) {
      const ip = key.replace('ids:threat:', '');
      const score = parseFloat(await redis.client.get(key)) || 0;
      if (score > 5) threats.push({ ip, score: Math.round(score) });
    }
    threats.sort((a, b) => b.score - a.score);

    return {
      blockedIPs: blockedCount,
      securityEvents: recentEvents,
      topThreats: threats.slice(0, 10),
      thresholds: THREAT_THRESHOLDS,
    };
  } catch (e) {
    return null;
  }
}

// ================================================================
// EXPORTS
// ================================================================
module.exports = {
  ThreatScorer,
  idsMiddleware,
  honeypotRouter,
  SessionAnomalyDetector,
  injectDatabaseContext,
  WebSocketSecurity,
  getSecurityMetrics,
  THREAT_THRESHOLDS,
  THREAT_WEIGHTS,
};
