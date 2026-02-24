// ================================================================
// T1 BROKER — ERROR HANDLING MIDDLEWARE
// Centralized error handling, sanitization, correlation
// ================================================================
const logger = require('../utils/logger');
const config = require('../config');
const AuditService = require('../utils/audit');

// ----------------------------------------------------------------
// Custom error classes
// ----------------------------------------------------------------
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

class ValidationError extends AppError {
  constructor(errors) {
    super('Validation failed', 400, 'VALIDATION_ERROR', errors);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', code = 'AUTH_REQUIRED') {
    super(message, 401, code);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor(retryAfter) {
    super('Rate limit exceeded', 429, 'RATE_LIMITED');
    this.retryAfter = retryAfter;
  }
}

class BrokerError extends AppError {
  constructor(broker, message) {
    super(`${broker} error: ${message}`, 502, 'BROKER_ERROR');
    this.broker = broker;
  }
}

// ----------------------------------------------------------------
// Global error handler middleware
// ----------------------------------------------------------------

// Patterns that indicate internal-only errors that must never reach clients
const INTERNAL_ERROR_PATTERNS = [
  /relation ".*" does not exist/i,     // Postgres table errors
  /column ".*" does not exist/i,       // Postgres column errors
  /syntax error at or near/i,          // SQL syntax errors
  /duplicate key value violates/i,     // Unique constraint
  /ECONNREFUSED/i,                     // Connection refused
  /ENOTFOUND/i,                        // DNS failure
  /ETIMEDOUT/i,                        // Timeout
  /password authentication failed/i,   // DB auth failure
  /SSL connection/i,                   // SSL errors
  /Cannot read propert/i,              // JS type errors
  /is not a function/i,                // JS type errors
  /MODULE_NOT_FOUND/i,                 // Missing module
  /ENOMEM/i,                           // Out of memory
];

function isInternalError(message) {
  if (!message) return false;
  return INTERNAL_ERROR_PATTERNS.some(p => p.test(message));
}

function errorHandler(err, req, res, next) {
  // Correlation
  const requestId = req.id || 'unknown';

  // Determine if this is a known operational error
  const isOperational = err.isOperational || false;
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  // Log the error (server-side only — full details)
  const logData = {
    requestId,
    statusCode,
    code,
    message: err.message,
    url: req.originalUrl,
    method: req.method,
    userId: req.user?.id,
    ip: req.ip,
  };

  if (statusCode >= 500) {
    logData.stack = err.stack;
    logger.error('Server error', logData);

    // Log critical errors to audit
    if (statusCode === 500) {
      AuditService.log({
        userId: req.user?.id,
        action: `Server error: ${err.message}`,
        resourceType: 'system',
        level: 'critical',
        ipAddress: req.ip,
        metadata: { url: req.originalUrl, method: req.method, requestId },
      }).catch(() => {});
    }
  } else if (statusCode >= 400) {
    logger.warn('Client error', logData);
  }

  // ── Build safe response — NEVER leak internals in production ──
  let clientMessage;
  if (statusCode >= 500) {
    // 5xx: always generic message in production
    clientMessage = config.env === 'development' ? err.message : 'Internal server error';
  } else if (isOperational && !isInternalError(err.message)) {
    // Known operational 4xx: safe to show
    clientMessage = err.message;
  } else {
    // Unknown or internal-pattern 4xx: sanitize
    clientMessage = 'Request could not be processed';
  }

  const response = {
    error: clientMessage,
    code,
    requestId,
  };

  // Include details for validation errors only
  if (err.details && statusCode < 500 && isOperational) {
    response.details = err.details;
  }

  // Stack trace: ONLY in development, ONLY for 5xx
  if (config.env === 'development' && statusCode >= 500) {
    response.stack = err.stack;
  }

  // NEVER include in production: requiredRoles (leaks RBAC), SQL state, etc.
  // (authorize middleware was leaking requiredRoles — cleaned below)

  // Rate limit headers
  if (err.retryAfter) {
    res.set('Retry-After', String(err.retryAfter));
  }

  res.status(statusCode).json(response);
}

// ----------------------------------------------------------------
// Not found handler (for unmatched API routes)
// ----------------------------------------------------------------
function notFoundHandler(req, res, next) {
  if (req.path.startsWith(config.apiPrefix || '/api')) {
    const err = new NotFoundError('API endpoint');
    err.statusCode = 404;
    next(err);
  } else {
    next(); // Let Express serve static files / SPA
  }
}

// ----------------------------------------------------------------
// Async route wrapper (catches async errors)
// ----------------------------------------------------------------
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ----------------------------------------------------------------
// Multer error handler
// ----------------------------------------------------------------
function multerErrorHandler(err, req, res, next) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: 'File too large',
      code: 'FILE_TOO_LARGE',
      maxSize: config.uploads.maxFileSize,
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field', code: 'UNEXPECTED_FILE' });
  }
  if (err.message?.includes('File type')) {
    return res.status(400).json({ error: err.message, code: 'INVALID_FILE_TYPE' });
  }
  next(err);
}

module.exports = {
  AppError, ValidationError, AuthenticationError, ForbiddenError,
  NotFoundError, ConflictError, RateLimitError, BrokerError,
  errorHandler, notFoundHandler, asyncHandler, multerErrorHandler,
};
