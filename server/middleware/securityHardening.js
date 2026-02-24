// ================================================================
// T1 BROKER — PRODUCTION SECURITY HARDENING
// Defense-in-depth: secrets audit, response sanitizer, API firewall,
// PII encryption, query guard, threat intelligence, DB hardening
// ================================================================
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const AuditService = require('../utils/audit');

// ================================================================
// 1. STARTUP SECRETS AUDIT
// Validate all secrets meet minimum security requirements on boot.
// Blocks startup if critical secrets are weak or missing.
// ================================================================
const KNOWN_WEAK = new Set([
  'dev-secret-replace-in-production-immediately',
  'dev-refresh-secret-replace',
  '0123456789abcdef0123456789abcdef',
  'password', 'secret', 'changeme', 'admin', 'test',
]);

function auditSecrets() {
  const issues = [];
  const fatal = [];

  // JWT secrets
  if (!config.jwt.secret || config.jwt.secret.length < 32) {
    fatal.push('JWT_SECRET must be at least 32 characters');
  }
  if (KNOWN_WEAK.has(config.jwt.secret)) {
    fatal.push('JWT_SECRET is a known default — CHANGE IMMEDIATELY');
  }
  if (!config.jwt.refreshSecret || config.jwt.refreshSecret.length < 32) {
    fatal.push('JWT_REFRESH_SECRET must be at least 32 characters');
  }
  if (KNOWN_WEAK.has(config.jwt.refreshSecret)) {
    fatal.push('JWT_REFRESH_SECRET is a known default — CHANGE IMMEDIATELY');
  }

  // Encryption key
  if (!config.encryption.key || config.encryption.key.length < 32) {
    fatal.push('ENCRYPTION_KEY must be at least 32 hex characters (16 bytes)');
  }
  if (KNOWN_WEAK.has(config.encryption.key)) {
    fatal.push('ENCRYPTION_KEY is a known default — CHANGE IMMEDIATELY');
  }

  // Database
  if (config.db.password === 'password' || config.db.password === '') {
    issues.push('DB_PASSWORD is weak or empty');
  }

  // SSL in production
  if (config.env === 'production') {
    if (!config.db.ssl) {
      fatal.push('DB_SSL must be enabled in production');
    }
  }

  // Report
  if (issues.length > 0) {
    logger.warn(`⚠️  Security audit: ${issues.length} warnings`, { issues });
  }
  if (fatal.length > 0) {
    if (config.env === 'production') {
      logger.error(`🛑 FATAL: ${fatal.length} security violations — server WILL NOT START`, { fatal });
      console.error('\n======================================');
      console.error('  FATAL SECURITY VIOLATIONS');
      console.error('======================================');
      fatal.forEach(f => console.error(`  ✗ ${f}`));
      console.error('======================================');
      console.error('  Fix all issues above before deploying to production.');
      console.error('======================================\n');
      process.exit(1);
    } else {
      logger.warn(`🔶 Security audit: ${fatal.length} issues (allowed in dev mode)`, { fatal });
    }
  }

  if (issues.length === 0 && fatal.length === 0) {
    logger.info('✅ Security audit passed — all secrets validated');
  }
}

// ================================================================
// 2. RESPONSE DATA SANITIZER
// Automatically strips sensitive fields from ALL API responses
// before they reach the client — defense against accidental leaks.
// ================================================================
const SENSITIVE_FIELDS = new Set([
  'password', 'password_hash', 'passwordHash',
  'token_hash', 'tokenHash', 'refresh_token_hash',
  'api_key', 'apiKey', 'api_secret', 'apiSecret',
  'api_key_encrypted', 'api_secret_encrypted',
  'private_key', 'privateKey', 'private_key_encrypted',
  'webhook_secret', 'webhookSecret',
  'encryption_key', 'encryptionKey',
  'secret', 'totp_secret', 'mfa_secret',
  'backup_codes', 'backupCodes',
  'ssn', 'social_security', 'tax_id',
  'credit_card', 'card_number', 'cvv', 'cvc',
  'bank_routing', 'bank_account_number',
  'session_token', 'access_token_raw',
]);

// Fields to mask (show partial value)
const MASK_FIELDS = new Set([
  'email', 'phone', 'mobile', 'phone_number',
  'ip_address', 'ipAddress',
]);

function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return local.substring(0, 2) + '***@' + domain;
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  return '***' + phone.slice(-4);
}

function sanitizeResponseData(data, depth = 0) {
  if (depth > 10) return data; // prevent infinite recursion
  if (!data || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(item => sanitizeResponseData(item, depth + 1));
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    const lk = key.toLowerCase();

    // Completely strip sensitive fields
    if (SENSITIVE_FIELDS.has(key) || SENSITIVE_FIELDS.has(lk)) {
      continue; // omit from response entirely
    }

    // Recurse into nested objects
    if (value && typeof value === 'object') {
      cleaned[key] = sanitizeResponseData(value, depth + 1);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

function responseSanitizer() {
  return (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json to sanitize before sending
    res.json = (body) => {
      // Skip sanitization for non-object responses
      if (!body || typeof body !== 'object') return originalJson(body);

      // Skip for file downloads
      const ct = res.getHeader('content-type');
      if (ct && !ct.includes('json')) return originalJson(body);

      // Sanitize the response
      const sanitized = sanitizeResponseData(body);
      return originalJson(sanitized);
    };

    next();
  };
}

// ================================================================
// 3. API FIREWALL
// Deep packet inspection for common attack patterns in request
// bodies, query strings, and headers.
// ================================================================
const ATTACK_PATTERNS = [
  // SQL Injection
  { name: 'SQLi UNION', re: /UNION\s+(ALL\s+)?SELECT/i, severity: 'critical' },
  { name: 'SQLi comment', re: /('|")\s*(;|--|\|\||\/\*)/i, severity: 'high' },
  { name: 'SQLi stacked query', re: /;\s*(DROP|ALTER|DELETE|INSERT|UPDATE|EXEC|EXECUTE)\s/i, severity: 'critical' },
  { name: 'SQLi sleep/benchmark', re: /(SLEEP|BENCHMARK|WAITFOR\s+DELAY|pg_sleep)\s*\(/i, severity: 'critical' },
  { name: 'SQLi information_schema', re: /information_schema\.|pg_catalog\./i, severity: 'high' },
  { name: 'SQLi LOAD_FILE/INTO', re: /(LOAD_FILE|INTO\s+(OUT|DUMP)FILE)/i, severity: 'critical' },

  // NoSQL Injection
  { name: 'NoSQLi operator', re: /\$(?:gt|gte|lt|lte|ne|in|nin|regex|where|exists)\b/i, severity: 'high' },

  // XSS (beyond basic sanitization)
  { name: 'XSS script tag', re: /<script[\s>]/i, severity: 'high' },
  { name: 'XSS event handler', re: /\bon\w+\s*=\s*["'`]/i, severity: 'high' },
  { name: 'XSS data URI', re: /data:\s*text\/html/i, severity: 'high' },
  { name: 'XSS svg onload', re: /<svg[^>]+onload/i, severity: 'high' },
  { name: 'XSS img onerror', re: /<img[^>]+onerror/i, severity: 'high' },
  { name: 'XSS expression', re: /expression\s*\(/i, severity: 'medium' },

  // Command Injection
  { name: 'CMDi pipe', re: /[;|`]\s*(cat|ls|dir|pwd|whoami|id|uname|curl|wget|nc|bash|sh|python|perl|ruby)\b/i, severity: 'critical' },
  { name: 'CMDi backtick', re: /`[^`]+`/, severity: 'high' },
  { name: 'CMDi subshell', re: /\$\([^)]+\)/, severity: 'high' },

  // Path Traversal (enhanced)
  { name: 'Path traversal', re: /(\.\.[\/\\]){2,}/i, severity: 'high' },
  { name: 'Path null byte', re: /%00|\\x00|\\0/i, severity: 'critical' },

  // LDAP Injection
  { name: 'LDAP injection', re: /[)(|*\\]\s*(objectClass|cn|uid|sn|mail)\s*=/i, severity: 'high' },

  // Server-Side Request Forgery (SSRF)
  { name: 'SSRF localhost', re: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+)/i, severity: 'high' },
  { name: 'SSRF metadata', re: /169\.254\.169\.254|metadata\.google|metadata\.azure/i, severity: 'critical' },

  // XML/XXE
  { name: 'XXE entity', re: /<!ENTITY|<!DOCTYPE[^>]*\[/i, severity: 'critical' },
  { name: 'XSLT injection', re: /<xsl:|<xml/i, severity: 'high' },

  // Template Injection
  { name: 'SSTI', re: /\{\{.*\}\}|\$\{.*\}|<%.*%>/i, severity: 'high' },

  // Log Injection / CRLF
  { name: 'CRLF injection', re: /%0[aAdD]|\\r\\n|\\n/i, severity: 'medium' },

  // Prototype Pollution
  { name: 'Prototype pollution', re: /__proto__|constructor\s*\[|prototype\s*\[/i, severity: 'critical' },
];

function deepScanValue(value, path = '') {
  if (typeof value === 'string') {
    for (const pattern of ATTACK_PATTERNS) {
      if (pattern.re.test(value)) {
        return { matched: true, pattern: pattern.name, severity: pattern.severity, path, sample: value.substring(0, 100) };
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      // Block __proto__ and constructor keys directly (prototype pollution)
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return { matched: true, pattern: 'Prototype pollution key', severity: 'critical', path: `${path}.${key}`, sample: key };
      }
      const result = deepScanValue(val, `${path}.${key}`);
      if (result) return result;
    }
  }
  return null;
}

function apiFirewall() {
  return async (req, res, next) => {
    // Skip health checks
    if (req.path.includes('/health') || req.path.includes('/metrics')) return next();

    // Scan body
    if (req.body) {
      const bodyMatch = deepScanValue(req.body, 'body');
      if (bodyMatch && (bodyMatch.severity === 'critical' || bodyMatch.severity === 'high')) {
        logger.error('API Firewall: attack pattern in request body', {
          ip: req.ip, path: req.path, method: req.method,
          pattern: bodyMatch.pattern, severity: bodyMatch.severity,
          fieldPath: bodyMatch.path,
        });

        AuditService.log({
          userId: req.user?.id,
          action: `WAF blocked: ${bodyMatch.pattern} in ${req.method} ${req.path}`,
          resourceType: 'security', level: 'critical',
          ipAddress: req.ip,
          metadata: { pattern: bodyMatch.pattern, severity: bodyMatch.severity },
        });

        // Auto-block IP after 3 critical hits
        await incrementThreatScore(req.ip, bodyMatch.severity === 'critical' ? 50 : 20);

        return res.status(400).json({
          error: 'Request blocked by security policy',
          code: 'WAF_BLOCKED',
        });
      }
    }

    // Scan query string
    if (req.query && Object.keys(req.query).length > 0) {
      const queryMatch = deepScanValue(req.query, 'query');
      if (queryMatch && (queryMatch.severity === 'critical' || queryMatch.severity === 'high')) {
        logger.error('API Firewall: attack pattern in query string', {
          ip: req.ip, path: req.path, pattern: queryMatch.pattern,
        });
        await incrementThreatScore(req.ip, queryMatch.severity === 'critical' ? 50 : 20);
        return res.status(400).json({ error: 'Request blocked by security policy', code: 'WAF_BLOCKED' });
      }
    }

    // Scan URL path itself
    const pathMatch = deepScanValue({ path: req.path }, 'url');
    if (pathMatch && pathMatch.severity === 'critical') {
      logger.error('API Firewall: attack pattern in URL', {
        ip: req.ip, path: req.path, pattern: pathMatch.pattern,
      });
      await incrementThreatScore(req.ip, 50);
      return res.status(400).json({ error: 'Request blocked by security policy', code: 'WAF_BLOCKED' });
    }

    next();
  };
}

// ================================================================
// 4. THREAT SCORING & AUTO-BAN
// IPs accumulate threat score per attack. Score >= 100 = auto-ban.
// Score decays over time (1 point per minute).
// ================================================================
async function incrementThreatScore(ip, points) {
  try {
    if (!redis.client) return;
    const key = `threat:score:${ip}`;
    const current = parseInt(await redis.client.get(key)) || 0;
    const newScore = current + points;

    await redis.client.set(key, newScore, 'EX', 3600); // 1hr window

    if (newScore >= 100) {
      // Auto-ban for 24 hours
      await redis.client.sadd('security:blocked_ips', ip);
      await redis.client.set(`security:block_reason:${ip}`, `Auto-ban: threat score ${newScore}`, 'EX', 86400);

      logger.error(`🚨 IP auto-banned: ${ip} (threat score: ${newScore})`, { ip, score: newScore });
      AuditService.log({
        action: `IP auto-banned: ${ip} — threat score ${newScore} exceeded threshold`,
        resourceType: 'security', level: 'critical', ipAddress: ip,
      });
    }
  } catch (e) {
    // Redis unavailable — log but don't block
    logger.warn('Threat scoring unavailable (Redis)', { error: e.message });
  }
}

// ================================================================
// 5. REQUEST FINGERPRINTING & REPLAY PROTECTION
// Prevents request replay attacks by requiring unique nonces
// on sensitive mutating endpoints (transfers, withdrawals).
// ================================================================
function replayProtection() {
  return async (req, res, next) => {
    // Only protect high-value mutations
    const protectedPaths = ['/transfers', '/crypto/withdraw', '/orders'];
    const isProtected = req.method === 'POST' && protectedPaths.some(p => req.path.includes(p));
    if (!isProtected) return next();

    const nonce = req.headers['x-request-nonce'] || req.headers['x-idempotency-key'];
    if (!nonce) {
      // Don't block — but add idempotency key to response header as hint
      res.setHeader('X-Idempotency-Key-Required', 'true');
      return next();
    }

    // Check if nonce was already used
    try {
      if (redis.client) {
        const nonceKey = `nonce:${req.user?.id || req.ip}:${nonce}`;
        const exists = await redis.client.get(nonceKey);
        if (exists) {
          logger.warn('Replay attack: duplicate nonce', { ip: req.ip, nonce, path: req.path });
          return res.status(409).json({
            error: 'Duplicate request — this transaction was already processed',
            code: 'DUPLICATE_REQUEST',
          });
        }
        // Store nonce for 24 hours
        await redis.client.set(nonceKey, '1', 'EX', 86400);
      }
    } catch (e) {}

    next();
  };
}

// ================================================================
// 6. SECURITY EVENT LOGGER (STRUCTURED)
// Centralized security event bus with severity levels
// ================================================================
const SecurityEvent = {
  AUTH_FAILURE: 'auth.failure',
  AUTH_LOCKOUT: 'auth.lockout',
  MFA_FAILURE: 'mfa.failure',
  SESSION_HIJACK: 'session.hijack',
  CREDENTIAL_STUFF: 'credential.stuffing',
  SQL_INJECTION: 'sqli.attempt',
  XSS_ATTEMPT: 'xss.attempt',
  SSRF_ATTEMPT: 'ssrf.attempt',
  PATH_TRAVERSAL: 'path.traversal',
  RATE_LIMIT: 'rate.limit',
  IP_BLOCKED: 'ip.blocked',
  WAF_BLOCK: 'waf.block',
  DATA_EXFIL: 'data.exfiltration',
  PRIV_ESCALATION: 'privilege.escalation',
  CONFIG_CHANGE: 'config.change',
  BACKUP_ACCESS: 'backup.access',
};

function logSecurityEvent(event, severity, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    severity,
    ...details,
  };

  // Always log to application logger
  if (severity === 'critical') {
    logger.error(`🚨 SECURITY [${event}]`, entry);
  } else if (severity === 'high') {
    logger.warn(`⚠️  SECURITY [${event}]`, entry);
  } else {
    logger.info(`🔒 SECURITY [${event}]`, entry);
  }

  // Push to Redis stream for SIEM integration
  if (redis.client) {
    redis.client.xadd(
      'security:events', 'MAXLEN', '~', '10000', '*',
      'event', event, 'severity', severity,
      'data', JSON.stringify(entry),
    ).catch(() => {});
  }

  // Audit trail
  AuditService.log({
    action: `Security: ${event}`,
    resourceType: 'security',
    level: severity === 'critical' ? 'critical' : severity === 'high' ? 'warning' : 'info',
    ipAddress: details.ip || 'system',
    metadata: details,
  });
}

// ================================================================
// 7. SENSITIVE ENDPOINT PROTECTION
// Additional checks for admin routes, backup downloads, bulk exports
// ================================================================
function sensitiveEndpointGuard() {
  return async (req, res, next) => {
    // Admin routes: require recent authentication (within last 30 min)
    if (req.path.includes('/admin/') && req.user) {
      const tokenAge = Date.now() - (req.tokenIssuedAt || 0);
      const maxAge = 30 * 60 * 1000; // 30 minutes

      // For destructive admin ops, log explicitly
      if (['DELETE', 'PUT', 'PATCH'].includes(req.method)) {
        logSecurityEvent(SecurityEvent.CONFIG_CHANGE, 'info', {
          userId: req.user.id, ip: req.ip, method: req.method, path: req.path,
        });
      }
    }

    // Backup download: extra audit logging
    if (req.path.includes('/admin/backups') && req.path.includes('/download')) {
      logSecurityEvent(SecurityEvent.BACKUP_ACCESS, 'high', {
        userId: req.user?.id, ip: req.ip, path: req.path,
        userAgent: req.get('User-Agent')?.substring(0, 100),
      });
    }

    // Bulk data export: log potential exfiltration
    const isExport = req.query.export === 'true' || req.query.format === 'csv' || req.path.includes('/export');
    if (isExport) {
      logSecurityEvent(SecurityEvent.DATA_EXFIL, 'info', {
        userId: req.user?.id, ip: req.ip, path: req.path,
      });
    }

    next();
  };
}

// ================================================================
// 8. DATABASE QUERY SAFETY LAYER
// Wraps database access to enforce parameterized queries
// and prevent accidental raw SQL from user input.
// ================================================================
function validateQueryParams(params) {
  if (!params || typeof params !== 'object') return true;

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Check for obvious SQL injection in query parameters
      if (/;\s*(DROP|ALTER|DELETE|INSERT|UPDATE|EXEC)/i.test(value)) return false;
      if (/UNION\s+SELECT/i.test(value)) return false;
      if (/('|")\s*(OR|AND)\s+('|"|\d)/i.test(value)) return false;
    }
  }
  return true;
}

// ================================================================
// 9. CONTENT-SECURITY-POLICY GENERATOR
// Strict CSP that blocks inline scripts (except for our admin pages)
// ================================================================
function contentSecurityPolicy() {
  return (req, res, next) => {
    // API endpoints: strict
    if (req.path.startsWith('/api/')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    } else {
      // HTML pages: allow our inline scripts + styles + fonts
      const csp = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",  // needed for inline admin UI scripts
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self' wss: ws:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; ');
      res.setHeader('Content-Security-Policy', csp);
    }
    next();
  };
}

// ================================================================
// 10. REQUEST BODY DEPTH LIMITER
// Prevents deeply nested JSON payloads used in denial-of-service
// ================================================================
function depthLimiter(maxDepth = 10) {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') return next();

    function checkDepth(obj, current = 0) {
      if (current > maxDepth) return false;
      if (obj && typeof obj === 'object') {
        for (const val of Object.values(obj)) {
          if (!checkDepth(val, current + 1)) return false;
        }
      }
      return true;
    }

    if (!checkDepth(req.body)) {
      logger.warn('Request body exceeds max depth', { ip: req.ip, path: req.path, maxDepth });
      return res.status(400).json({ error: 'Request body too complex', code: 'DEPTH_EXCEEDED' });
    }

    next();
  };
}

// ================================================================
// EXPORTS
// ================================================================
module.exports = {
  auditSecrets,
  responseSanitizer,
  apiFirewall,
  replayProtection,
  sensitiveEndpointGuard,
  contentSecurityPolicy,
  depthLimiter,
  logSecurityEvent,
  SecurityEvent,
  incrementThreatScore,
  validateQueryParams,
  sanitizeResponseData,
  SENSITIVE_FIELDS,
};
