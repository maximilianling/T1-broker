// ================================================================
// T1 BROKER — ADVANCED SECURITY MIDDLEWARE
// CSRF tokens, webhook HMAC, session fingerprinting,
// request anomaly detection, content security
// ================================================================
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const AuditService = require('../utils/audit');

// ================================================================
// CSRF PROTECTION (Double Submit Cookie pattern)
// ================================================================
class CSRFProtection {
  static generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  static middleware() {
    return (req, res, next) => {
      // Skip safe methods and webhooks
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      if (req.path.includes('/webhooks/')) return next();
      if (req.path.includes('/health') || req.path.includes('/live')) return next();

      // Skip if Bearer token auth (API clients use tokens, not cookies)
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) return next();

      // For cookie-based sessions, validate CSRF token
      if (req.cookies?.access_token) {
        const csrfHeader = req.headers['x-csrf-token'];
        const csrfCookie = req.cookies?.csrf_token;

        if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
          logger.warn('CSRF validation failed', {
            ip: req.ip, path: req.path, method: req.method,
          });
          return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_FAILED' });
        }
      }

      next();
    };
  }

  // Set CSRF cookie on login responses
  static setCookie(res) {
    const token = this.generateToken();
    res.cookie('csrf_token', token, {
      httpOnly: false,    // JS needs to read it for the header
      secure: config.env === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
    return token;
  }
}

// ================================================================
// WEBHOOK HMAC VERIFICATION
// Validates webhook signatures from Saxo Bank and DriveWealth
// ================================================================
class WebhookVerifier {
  static verifySignature(payload, signature, secret, algorithm = 'sha256') {
    if (!signature || !secret) return false;
    const expected = crypto.createHmac(algorithm, secret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  static driveWealthMiddleware() {
    return (req, res, next) => {
      const secret = config.drivewealth.webhookSecret;
      if (!secret) return next(); // Skip verification if no secret configured

      const signature = req.headers['x-dw-signature'] || req.headers['x-signature'];
      if (!signature) {
        logger.warn('DriveWealth webhook missing signature', { ip: req.ip });
        return res.status(401).json({ error: 'Missing webhook signature' });
      }

      const rawBody = JSON.stringify(req.body);
      if (!this.verifySignature(rawBody, signature, secret)) {
        logger.error('DriveWealth webhook signature verification failed', { ip: req.ip });
        AuditService.log({
          action: 'Invalid webhook signature: DriveWealth',
          resourceType: 'security', level: 'critical', ipAddress: req.ip,
        });
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      next();
    };
  }

  static saxoMiddleware() {
    return (req, res, next) => {
      const secret = config.saxo.webhookSecret;
      if (!secret) return next();

      const signature = req.headers['x-saxo-signature'] || req.headers['x-signature'];
      if (!signature) {
        logger.warn('Saxo webhook missing signature', { ip: req.ip });
        return res.status(401).json({ error: 'Missing webhook signature' });
      }

      const rawBody = JSON.stringify(req.body);
      if (!this.verifySignature(rawBody, signature, secret, 'sha256')) {
        logger.error('Saxo webhook signature verification failed', { ip: req.ip });
        AuditService.log({
          action: 'Invalid webhook signature: Saxo',
          resourceType: 'security', level: 'critical', ipAddress: req.ip,
        });
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      next();
    };
  }
}

// ================================================================
// SESSION FINGERPRINTING
// Detects session hijacking by binding sessions to device characteristics
// ================================================================
class SessionFingerprint {
  static generate(req) {
    const components = [
      req.get('User-Agent') || '',
      req.get('Accept-Language') || '',
      req.get('Accept-Encoding') || '',
    ].join('|');

    return crypto.createHash('sha256').update(components).digest('hex').substring(0, 32);
  }

  static middleware() {
    return (req, res, next) => {
      // Only check authenticated requests
      if (!req.user) return next();

      const currentFingerprint = this.generate(req);

      // If session has stored fingerprint, validate it
      if (req.sessionFingerprint && req.sessionFingerprint !== currentFingerprint) {
        logger.error('Session fingerprint mismatch — possible session hijacking', {
          userId: req.user.id, ip: req.ip,
          expected: req.sessionFingerprint?.substring(0, 8),
          actual: currentFingerprint.substring(0, 8),
        });

        AuditService.log({
          userId: req.user.id,
          action: 'Session fingerprint mismatch detected',
          resourceType: 'security', level: 'critical',
          ipAddress: req.ip, metadata: { fingerprint: currentFingerprint.substring(0, 8) },
        });

        return res.status(401).json({
          error: 'Session validation failed. Please log in again.',
          code: 'SESSION_FINGERPRINT_MISMATCH',
        });
      }

      // Store fingerprint on request for new sessions
      req.currentFingerprint = currentFingerprint;
      next();
    };
  }
}

// ================================================================
// REQUEST ANOMALY DETECTOR
// Detects automated attacks, credential stuffing, API abuse
// ================================================================
class AnomalyDetector {
  constructor() {
    this.suspiciousPatterns = [
      // Common scanner user agents
      /sqlmap/i, /nikto/i, /nmap/i, /masscan/i, /zgrab/i,
      /dirbuster/i, /gobuster/i, /wfuzz/i, /burp/i,
      /havij/i, /acunetix/i, /nessus/i, /openvas/i,
      // Bots
      /python-requests/i, /curl\/\d/i, /wget/i, /httpie/i,
      /postman/i, /insomnia/i,
    ];
  }

  middleware() {
    return async (req, res, next) => {
      const ua = req.get('User-Agent') || '';
      const ip = req.ip;

      // 1. Block requests with no User-Agent on sensitive endpoints
      if (!ua && req.path.includes('/auth/')) {
        logger.warn('Auth request with no User-Agent', { ip, path: req.path });
        return res.status(400).json({ error: 'Bad request', code: 'MISSING_UA' });
      }

      // 2. Check for known scanner patterns (log only, don't block — could be legit pentesting)
      const isScanner = this.suspiciousPatterns.some(p => p.test(ua));
      if (isScanner) {
        logger.warn('Scanner detected', { ip, ua: ua.substring(0, 100), path: req.path });
        // In production, could rate-limit more aggressively or block
      }

      // 3. Detect rapid credential stuffing (many different emails from same IP)
      if (req.path.includes('/auth/login') && req.method === 'POST') {
        try {
          const key = `anomaly:login:${ip}`;
          const email = req.body?.email?.toLowerCase() || '';
          const emailsKey = `anomaly:emails:${ip}`;

          // Track unique emails attempted from this IP
          if (redis.client) {
            await redis.client.sadd(emailsKey, email);
            await redis.client.expire(emailsKey, 600); // 10 min window
            const uniqueEmails = await redis.client.scard(emailsKey);

            if (uniqueEmails > 10) {
              logger.error('Credential stuffing detected', { ip, uniqueEmails });
              AuditService.log({
                action: `Credential stuffing: ${uniqueEmails} unique emails from ${ip}`,
                resourceType: 'security', level: 'critical', ipAddress: ip,
              });
              return res.status(429).json({
                error: 'Too many login attempts',
                code: 'CREDENTIAL_STUFFING_DETECTED',
              });
            }
          }
        } catch (e) {
          // Redis unavailable — skip check
        }
      }

      // 4. Block path traversal attempts
      if (req.path.includes('..') || req.path.includes('%2e%2e')) {
        logger.warn('Path traversal attempt blocked', { ip, path: req.path });
        return res.status(400).json({ error: 'Invalid path', code: 'PATH_TRAVERSAL' });
      }

      // 5. Block oversized headers (potential header injection)
      const totalHeaderSize = Object.entries(req.headers)
        .reduce((size, [k, v]) => size + k.length + String(v).length, 0);
      if (totalHeaderSize > 16384) { // 16KB total headers
        logger.warn('Oversized headers blocked', { ip, size: totalHeaderSize });
        return res.status(431).json({ error: 'Request header too large' });
      }

      next();
    };
  }
}

// ================================================================
// IP REPUTATION / GEO-BLOCKING (simplified — use MaxMind in production)
// ================================================================
class IPReputationChecker {
  constructor() {
    // Known bad IP ranges (example — in production, use a threat intelligence feed)
    this.blocklist = new Set();
    this.allowlist = new Set();
  }

  async isBlocked(ip) {
    if (this.allowlist.has(ip)) return false;
    if (this.blocklist.has(ip)) return true;

    // Check Redis for dynamically blocked IPs
    try {
      if (redis.client) {
        const blocked = await redis.client.sismember('security:blocked_ips', ip);
        return blocked === 1;
      }
    } catch (e) {}
    return false;
  }

  async blockIP(ip, reason, durationSeconds = 86400) {
    try {
      if (redis.client) {
        await redis.client.sadd('security:blocked_ips', ip);
        await redis.client.set(`security:block_reason:${ip}`, reason, 'EX', durationSeconds);
      }
      this.blocklist.add(ip);
      logger.warn('IP blocked', { ip, reason, duration: durationSeconds });
      AuditService.log({
        action: `IP blocked: ${ip} — ${reason}`,
        resourceType: 'security', level: 'critical', ipAddress: ip,
      });
    } catch (e) {}
  }

  middleware() {
    return async (req, res, next) => {
      const blocked = await this.isBlocked(req.ip);
      if (blocked) {
        return res.status(403).json({ error: 'Access denied', code: 'IP_BLOCKED' });
      }
      next();
    };
  }
}

// ================================================================
// SECURE RESPONSE HEADERS (beyond Helmet)
// ================================================================
function advancedSecurityHeaders(req, res, next) {
  // Prevent clickjacking in iframes
  res.setHeader('X-Frame-Options', 'DENY');

  // Cross-Origin isolation
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Disable DNS prefetch (prevents data leaks)
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  // Prevent Adobe products from loading data
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // Remove server info
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  next();
}

// ================================================================
// API KEY VALIDATION (for partner/B2B integrations)
// ================================================================
async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next(); // Fall through to JWT auth

  try {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const partner = await require('../config/database')('partners')
      .where('api_key_hash', keyHash)
      .where('status', 'active')
      .first();

    if (!partner) {
      return res.status(401).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
    }

    // Attach partner context
    req.partner = { id: partner.id, name: partner.name };
    req.isApiKeyAuth = true;

    // Update last API usage
    await require('../config/database')('partners')
      .where('id', partner.id)
      .update({ last_api_call: new Date() });

    next();
  } catch (err) {
    logger.error('API key validation error', { error: err.message });
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// ================================================================
// EXPORTS
// ================================================================
const anomalyDetector = new AnomalyDetector();
const ipReputation = new IPReputationChecker();

module.exports = {
  CSRFProtection,
  WebhookVerifier,
  SessionFingerprint,
  AnomalyDetector,
  anomalyDetector,
  IPReputationChecker,
  ipReputation,
  advancedSecurityHeaders,
  validateApiKey,
};
