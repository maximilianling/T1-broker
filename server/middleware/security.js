// ================================================================
// T1 BROKER — SECURITY HARDENING MIDDLEWARE
// XSS prevention, input sanitization, parameter pollution, CSRF
// ================================================================
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');

/**
 * Sanitize all string inputs — removes potential XSS vectors
 */
function sanitizeInputs(req, res, next) {
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const clean = Array.isArray(obj) ? [] : {};
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        clean[key] = val
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/javascript:/gi, '')
          .replace(/on\w+\s*=/gi, '')
          .replace(/data:text\/html/gi, '');
      } else if (typeof val === 'object' && val !== null) {
        clean[key] = sanitize(val);
      } else {
        clean[key] = val;
      }
    }
    return clean;
  };

  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);
  next();
}

/**
 * HTTP parameter pollution protection
 */
function parameterPollutionProtection(req, res, next) {
  // Whitelist params that can be arrays
  const arrayWhitelist = ['channels', 'symbols', 'status', 'assetClass'];

  if (req.query) {
    for (const [key, val] of Object.entries(req.query)) {
      if (Array.isArray(val) && !arrayWhitelist.includes(key)) {
        req.query[key] = val[val.length - 1]; // Take last value
      }
    }
  }
  next();
}

/**
 * Detect and block suspicious request patterns
 */
function requestGuard(req, res, next) {
  const suspicious = [
    /\.\.\//, /\.\.\\/, // Path traversal
    /\0/, // Null bytes
    /<\?php/i, /<%/, // Server-side injection
    /UNION\s+SELECT/i, /OR\s+1\s*=\s*1/i, /DROP\s+TABLE/i, // SQL injection
    /\$\{.*\}/, /\{\{.*\}\}/, // Template injection
  ];

  const checkValue = (val) => {
    if (typeof val !== 'string') return false;
    return suspicious.some(pattern => pattern.test(val));
  };

  const allValues = [
    ...Object.values(req.query || {}),
    ...Object.values(req.params || {}),
    ...(typeof req.body === 'object' ? Object.values(req.body || {}) : []),
    req.path,
  ].filter(v => typeof v === 'string');

  for (const val of allValues) {
    if (checkValue(val)) {
      logger.warn('Suspicious request blocked', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        userId: req.user?.id,
      });

      AuditService.log({
        userId: req.user?.id,
        action: `Suspicious request blocked: ${req.method} ${req.path}`,
        resourceType: 'security',
        level: 'critical',
        ipAddress: req.ip,
        metadata: { path: req.path, method: req.method },
      }).catch(() => {});

      return res.status(400).json({ error: 'Malformed request', code: 'BLOCKED' });
    }
  }

  next();
}

/**
 * Additional security response headers
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Request size guard — additional protection beyond express.json limit
 */
function requestSizeGuard(maxBytes = 10 * 1024 * 1024) {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > maxBytes) {
      return res.status(413).json({ error: 'Request too large', code: 'PAYLOAD_TOO_LARGE' });
    }
    next();
  };
}

/**
 * Slow down repeated requests (before rate limit kicks in)
 */
function createSlowDown(options = {}) {
  try {
    const slowDown = require('express-slow-down');
    return slowDown({
      windowMs: options.windowMs || 15 * 60 * 1000,
      delayAfter: options.delayAfter || 50,
      delayMs: (hits) => (hits - (options.delayAfter || 50)) * (options.delayMs || 200),
      maxDelayMs: options.maxDelayMs || 5000,
      keyGenerator: (req) => req.user?.id || req.ip,
    });
  } catch (e) {
    // Module may not be installed — return no-op
    return (req, res, next) => next();
  }
}

module.exports = {
  sanitizeInputs,
  parameterPollutionProtection,
  requestGuard,
  securityHeaders,
  requestSizeGuard,
  createSlowDown,
};
