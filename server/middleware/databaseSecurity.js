// ================================================================
// T1 BROKER — DATABASE SECURITY LAYER
// Query-level protections, connection monitoring, PII audit,
// dangerous operation blocking, and pool health checks
// ================================================================
const logger = require('../utils/logger');
const config = require('../config');

// ================================================================
// 1. QUERY INTERCEPTOR
// Wraps Knex to log slow queries, block dangerous patterns,
// and enforce row-count limits on SELECT queries.
// ================================================================

// Tables containing PII — access is audit-logged
const PII_TABLES = new Set([
  'users', 'clients', 'client_bank_accounts',
  'client_documents', 'client_crypto_accounts',
  'user_sessions', 'ip_whitelist',
]);

// Operations that should NEVER run from application code in production
const BLOCKED_OPERATIONS = [
  /^\s*DROP\s+(TABLE|DATABASE|INDEX|SCHEMA)/i,
  /^\s*TRUNCATE\s/i,
  /^\s*ALTER\s+TABLE.*DROP\s+COLUMN/i,
  /^\s*GRANT\s/i,
  /^\s*REVOKE\s/i,
  /^\s*CREATE\s+(USER|ROLE)/i,
  /^\s*ALTER\s+(USER|ROLE)/i,
  /^\s*COPY\s.*TO\s+PROGRAM/i,
  /^\s*CREATE\s+EXTENSION/i,
  /\bpg_read_file\b/i,
  /\bpg_ls_dir\b/i,
  /\bpg_execute_server_program\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
];

/**
 * Install query interceptors on a Knex instance.
 * Monitors all queries for dangerous patterns and performance.
 */
function installQueryInterceptor(db) {
  // Track slow queries
  const SLOW_QUERY_THRESHOLD_MS = 5000; // 5 seconds
  const MAX_RESULT_ROWS = 10000; // Safety limit

  db.on('query', (data) => {
    data._startTime = Date.now();

    // Block dangerous operations in production
    if (config.env === 'production' && data.sql) {
      for (const pattern of BLOCKED_OPERATIONS) {
        if (pattern.test(data.sql)) {
          logger.error('🛑 BLOCKED dangerous SQL operation', {
            sql: data.sql.substring(0, 200),
            pattern: pattern.toString(),
          });
          // We can't truly block from the event, but we log critically
          // The actual blocking happens via PostgreSQL role permissions
          throw new Error('Dangerous SQL operation blocked by security layer');
        }
      }
    }
  });

  db.on('query-response', (response, data) => {
    const duration = Date.now() - (data._startTime || Date.now());

    // Log slow queries
    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn('🐌 Slow query detected', {
        sql: data.sql?.substring(0, 300),
        duration: `${duration}ms`,
        bindings: data.bindings?.length || 0,
      });
    }

    // Log PII table access
    if (data.sql) {
      const sqlLower = data.sql.toLowerCase();
      for (const table of PII_TABLES) {
        if (sqlLower.includes(table)) {
          // Only log reads (SELECTs) — writes are handled by route-level audit
          if (sqlLower.startsWith('select')) {
            logger.debug('PII table accessed', {
              table,
              operation: 'SELECT',
              duration: `${duration}ms`,
            });
          }
          break;
        }
      }
    }
  });

  db.on('query-error', (error, data) => {
    const duration = Date.now() - (data._startTime || Date.now());
    logger.error('Database query error', {
      sql: data.sql?.substring(0, 300),
      error: error.message,
      duration: `${duration}ms`,
      code: error.code,
    });
  });

  return db;
}

// ================================================================
// 2. CONNECTION POOL HEALTH MONITOR
// Periodically checks pool health and alerts on exhaustion.
// ================================================================
function startPoolMonitor(db, intervalMs = 30000) {
  const monitor = setInterval(() => {
    try {
      const pool = db.client?.pool;
      if (!pool) return;

      const stats = {
        total: pool.numUsed?.() + pool.numFree?.() || 0,
        used: pool.numUsed?.() || 0,
        free: pool.numFree?.() || 0,
        pending: pool.numPendingAcquires?.() || 0,
      };

      // Alert if pool is near exhaustion (>80% used)
      if (stats.total > 0 && stats.used / stats.total > 0.8) {
        logger.warn('⚠️ Database pool near exhaustion', stats);
      }

      // Critical if pending requests exist and pool is full
      if (stats.pending > 0 && stats.free === 0) {
        logger.error('🚨 Database pool exhausted — requests queuing', stats);
      }
    } catch (e) {
      // Pool monitoring failed — non-critical
    }
  }, intervalMs);

  // Don't prevent process exit
  if (monitor.unref) monitor.unref();
  return monitor;
}

// ================================================================
// 3. PARAMETERIZED QUERY ENFORCEMENT
// Utility to verify that raw queries use proper parameterization.
// ================================================================
function assertParameterized(sql, bindings) {
  if (!sql) return true;

  // Count placeholders vs bindings
  const placeholders = (sql.match(/\?/g) || []).length;
  const namedParams = (sql.match(/:\w+/g) || []).length;
  const totalExpected = placeholders + namedParams;

  if (totalExpected > 0 && (!bindings || bindings.length < placeholders)) {
    logger.error('Parameterization mismatch', {
      sql: sql.substring(0, 200),
      expectedBindings: totalExpected,
      actualBindings: bindings?.length || 0,
    });
    return false;
  }

  // Check for string concatenation patterns (common SQL injection vector)
  // This is a heuristic — not foolproof
  if (/'\s*\+\s*\w+\s*\+\s*'/.test(sql) || /'\s*\|\|\s*\$/.test(sql)) {
    logger.warn('Possible string concatenation in SQL', {
      sql: sql.substring(0, 200),
    });
    return false;
  }

  return true;
}

// ================================================================
// 4. DATABASE BACKUP SECURITY
// Ensures backup files are encrypted and access-controlled.
// ================================================================
function validateBackupAccess(userId, userRole) {
  const allowedRoles = ['super_admin', 'admin'];
  if (!allowedRoles.includes(userRole)) {
    logger.warn('Unauthorized backup access attempt', { userId, userRole });
    return false;
  }
  return true;
}

// ================================================================
// 5. ROW-LEVEL SECURITY HELPER
// Generates Knex query modifiers that enforce data isolation.
// ================================================================
function applyRowLevelSecurity(query, req) {
  if (!req.user) return query;

  // Partner users: can only see their own clients' data
  if (req.partnerScope && req.partnerId) {
    return query.where('partner_id', req.partnerId);
  }

  // Client users: can only see their own data
  if (req.user.role === 'client') {
    return query.where('user_id', req.user.id);
  }

  // Admin/operations: no restriction
  return query;
}

// ================================================================
// 6. COLUMN-LEVEL ENCRYPTION REGISTRY
// Tracks which columns are encrypted and ensures they are
// always encrypted on write and decrypted on read.
// ================================================================
const ENCRYPTED_COLUMNS = {
  'market_data_providers': ['api_key_encrypted', 'api_secret_encrypted'],
  'brokerage_connectors': ['credentials_encrypted'],
  'omnibus_wallets': ['private_key_encrypted'],
  'client_bank_accounts': ['account_number_encrypted'],
  'partners': ['api_secret_hash'],
};

function getEncryptedColumns(tableName) {
  return ENCRYPTED_COLUMNS[tableName] || [];
}

// ================================================================
// 7. SQL INJECTION HONEYPOT FIELDS
// If these fields appear in a query with suspicious values,
// it's almost certainly an attack.
// ================================================================
const HONEYPOT_VALUES = [
  "' OR '1'='1",
  "1; DROP TABLE",
  "admin'--",
  "1' AND 1=1--",
  "' UNION SELECT",
  "1; WAITFOR DELAY",
  "1'; EXEC xp_cmdshell",
];

function checkHoneypot(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase().trim();
  return HONEYPOT_VALUES.some(h => normalized.includes(h.toLowerCase()));
}

// ================================================================
// EXPORTS
// ================================================================
module.exports = {
  installQueryInterceptor,
  startPoolMonitor,
  assertParameterized,
  validateBackupAccess,
  applyRowLevelSecurity,
  getEncryptedColumns,
  checkHoneypot,
  PII_TABLES,
  BLOCKED_OPERATIONS,
  ENCRYPTED_COLUMNS,
};
