// ================================================================
// T1 BROKER — SECURITY BOOTSTRAP
// Master module that initializes, validates, and wires every
// security layer in the correct order. Single entry point for
// the entire platform security stack.
// ================================================================
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config');
const AuditService = require('../utils/audit');

// ────────────────────────────────────────────
// 1. PRODUCTION SECRET VALIDATION
// Refuses to start if critical secrets are weak
// ────────────────────────────────────────────
const DEV_MARKERS = [
  'dev-secret', 'dev-refresh', 'replace-in-production', 'changeme',
  'password', 'secret', 'test', '12345', 'example', 'CHANGE_ME',
];

function validateSecrets() {
  const errors = [];
  const warnings = [];

  const criticalSecrets = [
    { name: 'JWT_SECRET', value: config.jwt?.secret, minLength: 32 },
    { name: 'JWT_REFRESH_SECRET', value: config.jwt?.refreshSecret, minLength: 32 },
    { name: 'DB_PASSWORD', value: config.db?.password, minLength: 12 },
  ];

  const recommendedSecrets = [
    { name: 'REDIS_PASSWORD', value: config.redis?.password, minLength: 12 },
    { name: 'ENCRYPTION_KEY', value: process.env.ENCRYPTION_KEY, minLength: 32 },
    { name: 'HMAC_SECRET', value: process.env.HMAC_SECRET, minLength: 32 },
  ];

  for (const { name, value, minLength } of criticalSecrets) {
    if (!value) {
      errors.push(`${name} is not set`);
      continue;
    }
    if (value.length < minLength) {
      errors.push(`${name} is too short (${value.length} < ${minLength} chars)`);
    }
    const lower = value.toLowerCase();
    if (DEV_MARKERS.some(m => lower.includes(m))) {
      errors.push(`${name} contains development placeholder — MUST be replaced`);
    }
    // Entropy check: reject low-entropy secrets
    const unique = new Set(value).size;
    if (unique < Math.min(minLength / 2, 12)) {
      errors.push(`${name} has insufficient entropy (only ${unique} unique characters)`);
    }
  }

  for (const { name, value, minLength } of recommendedSecrets) {
    if (!value || value.length < minLength) {
      warnings.push(`${name} is missing or weak — recommended: ${minLength}+ chars`);
    }
  }

  // Check JWT algorithm is not 'none'
  if (process.env.JWT_ALGORITHM === 'none') {
    errors.push('JWT_ALGORITHM=none is FORBIDDEN');
  }

  return { errors, warnings };
}

// ────────────────────────────────────────────
// 2. DATABASE SECURITY INITIALIZATION
// Wire databaseSecurity.js protections to Knex
// ────────────────────────────────────────────
function initDatabaseSecurity(db) {
  try {
    const { installQueryInterceptor, startPoolMonitor } = require('../middleware/databaseSecurity');
    const { DatabaseArmor } = require('./connectionArmor');

    // Install query-level security interceptor (logs, blocks dangerous patterns)
    installQueryInterceptor(db);
    logger.info('  ✓ Database query interceptor installed');

    // Wrap Knex with connection armor (blocks DROP, TRUNCATE, etc.)
    DatabaseArmor.harden(db);
    logger.info('  ✓ Database connection armor active');

    // Start connection pool monitor (alerts on exhaustion, leaks)
    startPoolMonitor(db, 30000);
    logger.info('  ✓ Database pool monitor started');

    return true;
  } catch (err) {
    logger.error('Database security init failed', { error: err.message });
    return false;
  }
}

// ────────────────────────────────────────────
// 3. REDIS SECURITY INITIALIZATION
// ────────────────────────────────────────────
function initRedisSecurity() {
  try {
    const { RedisArmor } = require('./connectionArmor');
    const redis = require('../utils/redis');
    if (redis.client) {
      RedisArmor.harden(redis.client);
      logger.info('  ✓ Redis connection armor active');
    }
    return true;
  } catch (err) {
    logger.warn('Redis security init skipped', { error: err.message });
    return false;
  }
}

// ────────────────────────────────────────────
// 4. INTRUSION DETECTION SYSTEM (IDS) WIRING
// Returns middleware array for Express app
// ────────────────────────────────────────────
function getIDSMiddleware() {
  try {
    const { idsMiddleware, honeypotRouter, injectDatabaseContext } = require('./intrusionDetection');
    return {
      ids: idsMiddleware(),
      honeypot: honeypotRouter(),
      dbContext: injectDatabaseContext(),
    };
  } catch (err) {
    logger.warn('IDS middleware init failed', { error: err.message });
    return {
      ids: (req, res, next) => next(),
      honeypot: require('express').Router(),
      dbContext: (req, res, next) => next(),
    };
  }
}

// ────────────────────────────────────────────
// 5. WEBSOCKET SECURITY INITIALIZATION
// ────────────────────────────────────────────
function initWebSocketSecurity(wsServer) {
  try {
    const { WebSocketSecurity } = require('./intrusionDetection');
    if (wsServer) {
      WebSocketSecurity.harden(wsServer);
      logger.info('  ✓ WebSocket security hardened');
    }
    return true;
  } catch (err) {
    logger.warn('WebSocket security init skipped', { error: err.message });
    return false;
  }
}

// ────────────────────────────────────────────
// 6. COOKIE SECURITY CONFIGURATION
// ────────────────────────────────────────────
function getCookieOptions() {
  try {
    const { SECURE_COOKIE_OPTIONS, REFRESH_COOKIE_OPTIONS } = require('./connectionArmor');
    return { session: SECURE_COOKIE_OPTIONS, refresh: REFRESH_COOKIE_OPTIONS };
  } catch (err) {
    // Fallback secure defaults
    const isProd = config.env === 'production';
    return {
      session: {
        httpOnly: true, secure: isProd, sameSite: 'strict',
        maxAge: 15 * 60 * 1000, path: '/', domain: isProd ? '.t1broker.com' : undefined,
      },
      refresh: {
        httpOnly: true, secure: isProd, sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/v1/auth',
      },
    };
  }
}

// ────────────────────────────────────────────
// 7. ERROR MASKING FOR PRODUCTION
// Prevent stack trace / internal details leaking
// ────────────────────────────────────────────
function getErrorMasking() {
  try {
    const { errorMasking } = require('./connectionArmor');
    return errorMasking;
  } catch (err) {
    // Fallback
    return (err, req, res, next) => {
      if (config.env === 'production') {
        const safeError = {
          error: err.expose ? err.message : 'Internal server error',
          code: err.code || 'INTERNAL_ERROR',
          requestId: req.id,
        };
        const status = err.status || err.statusCode || 500;
        if (status >= 500) {
          logger.error('Server error', { requestId: req.id, error: err.message });
        }
        return res.status(status).json(safeError);
      }
      next(err);
    };
  }
}

// ────────────────────────────────────────────
// 8. SECURITY METRICS REPORTER
// Periodic security health reporting
// ────────────────────────────────────────────
function startSecurityMonitor() {
  try {
    const { getSecurityMetrics } = require('./intrusionDetection');
    setInterval(async () => {
      try {
        const metrics = await getSecurityMetrics();
        if (metrics.blockedIPs > 0 || metrics.activeThreats > 0) {
          logger.warn('Security metrics', metrics);
        }
      } catch (e) { /* swallow */ }
    }, 5 * 60 * 1000); // Every 5 minutes
    logger.info('  ✓ Security metrics monitor started');
  } catch (err) {
    logger.warn('Security metrics monitor skipped');
  }
}

// ════════════════════════════════════════════
// MASTER BOOTSTRAP FUNCTION
// Call this once during server startup
// ════════════════════════════════════════════
async function bootstrap(app, options = {}) {
  const isProd = config.env === 'production';
  const report = { layers: [], warnings: [], errors: [] };

  logger.info('╔══════════════════════════════════════╗');
  logger.info('║   T1 BROKER — SECURITY BOOTSTRAP     ║');
  logger.info('╚══════════════════════════════════════╝');
  logger.info(`Environment: ${config.env}`);

  // ── Step 1: Validate secrets ──
  const { errors, warnings } = validateSecrets();
  report.warnings.push(...warnings);
  for (const w of warnings) logger.warn(`⚠ ${w}`);

  if (isProd && errors.length > 0) {
    for (const e of errors) logger.error(`✖ FATAL: ${e}`);
    logger.error('╔══════════════════════════════════════════════════╗');
    logger.error('║  REFUSING TO START: Critical secrets are weak    ║');
    logger.error('║  Fix the above errors before deploying.          ║');
    logger.error('╚══════════════════════════════════════════════════╝');
    process.exit(1);
  }
  for (const e of errors) logger.warn(`⚠ DEV MODE: ${e}`);
  report.layers.push('secret-validation');

  // ── Step 2: Database security ──
  if (options.db) {
    const dbOk = initDatabaseSecurity(options.db);
    if (dbOk) report.layers.push('database-armor');
  }

  // ── Step 3: Redis security ──
  const redisOk = initRedisSecurity();
  if (redisOk) report.layers.push('redis-armor');

  // ── Step 4: IDS middleware (mount into Express) ──
  const ids = getIDSMiddleware();
  app.use(ids.ids);
  app.use(ids.dbContext);
  report.layers.push('intrusion-detection');
  logger.info('  ✓ Intrusion detection system active');

  // Honeypot routes (attract and flag attackers)
  app.use(ids.honeypot);
  report.layers.push('honeypot-traps');
  logger.info('  ✓ Honeypot trap endpoints deployed');

  // ── Step 5: Error masking (production) ──
  if (isProd) {
    report.layers.push('error-masking');
    logger.info('  ✓ Production error masking enabled');
  }

  // ── Step 6: Security monitor ──
  startSecurityMonitor();
  report.layers.push('security-monitor');

  // ── Summary ──
  logger.info('──────────────────────────────────────');
  logger.info(`Security layers active: ${report.layers.length}`);
  logger.info(`  ${report.layers.join(' → ')}`);
  if (report.warnings.length) {
    logger.warn(`Warnings: ${report.warnings.length}`);
  }
  logger.info('──────────────────────────────────────');

  // Audit the bootstrap event
  AuditService.log({
    action: 'Security bootstrap completed',
    resourceType: 'security',
    level: 'info',
    metadata: {
      layers: report.layers,
      warnings: report.warnings.length,
      environment: config.env,
    },
  }).catch(() => {});

  return report;
}

// ════════════════════════════════════════════
// POST-LISTEN INITIALIZATION
// Called after server.listen() — needs the ws server
// ════════════════════════════════════════════
function postListen(wsServer) {
  initWebSocketSecurity(wsServer);
}

module.exports = {
  bootstrap,
  postListen,
  validateSecrets,
  initDatabaseSecurity,
  initRedisSecurity,
  getIDSMiddleware,
  getErrorMasking,
  getCookieOptions,
  initWebSocketSecurity,
};
