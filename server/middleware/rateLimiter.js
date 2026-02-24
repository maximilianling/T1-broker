// ================================================================
// T1 BROKER — REDIS-BACKED RATE LIMITER
// Per-user, per-endpoint sliding window rate limiting
// ================================================================
const redis = require('../utils/redis');
const logger = require('../utils/logger');
const { RateLimitError } = require('./errors');

/**
 * Create a Redis-backed rate limiter middleware
 * @param {Object} options
 * @param {number} options.maxRequests - Max requests in window
 * @param {number} options.windowSeconds - Window size in seconds
 * @param {string} options.keyPrefix - Prefix for Redis key
 * @param {function} options.keyGenerator - Custom key generator (req) => string
 * @param {boolean} options.skipFailed - Skip counting failed requests
 */
function redisRateLimit(options = {}) {
  const {
    maxRequests = 100,
    windowSeconds = 900,
    keyPrefix = 'rl',
    keyGenerator = null,
    skipFailed = false,
  } = options;

  return async (req, res, next) => {
    try {
      // Generate rate limit key
      const identifier = keyGenerator
        ? keyGenerator(req)
        : (req.user?.id || req.ip);
      const key = `${keyPrefix}:${identifier}`;

      const result = await redis.checkRateLimit(key, maxRequests, windowSeconds);

      // Set rate limit headers
      res.set('X-RateLimit-Limit', String(result.total));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', result.resetAt.toISOString());

      if (!result.allowed) {
        logger.warn('Rate limit exceeded', {
          key,
          userId: req.user?.id,
          ip: req.ip,
          endpoint: req.originalUrl,
        });
        throw new RateLimitError(windowSeconds);
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitError) {
        return res.status(429).json({
          error: 'Too many requests',
          code: 'RATE_LIMITED',
          retryAfter: windowSeconds,
        });
      }
      // Redis down — fall through (don't block requests if Redis fails)
      logger.warn('Rate limiter Redis error, falling through', { error: err.message });
      next();
    }
  };
}

// Pre-configured limiters
const limiters = {
  // Auth: 10 attempts per 15 minutes per IP
  auth: redisRateLimit({
    maxRequests: 10,
    windowSeconds: 900,
    keyPrefix: 'rl:auth',
    keyGenerator: (req) => req.ip,
  }),

  // API: 200 requests per 15 minutes per user
  api: redisRateLimit({
    maxRequests: 200,
    windowSeconds: 900,
    keyPrefix: 'rl:api',
  }),

  // Orders: 30 per minute per user (prevent rapid-fire)
  orders: redisRateLimit({
    maxRequests: 30,
    windowSeconds: 60,
    keyPrefix: 'rl:orders',
  }),

  // Transfers: 5 per hour per user
  transfers: redisRateLimit({
    maxRequests: 5,
    windowSeconds: 3600,
    keyPrefix: 'rl:transfers',
  }),

  // File upload: 10 per hour per user
  uploads: redisRateLimit({
    maxRequests: 10,
    windowSeconds: 3600,
    keyPrefix: 'rl:uploads',
  }),

  // Password reset: 3 per hour per IP
  passwordReset: redisRateLimit({
    maxRequests: 3,
    windowSeconds: 3600,
    keyPrefix: 'rl:pwreset',
    keyGenerator: (req) => req.ip,
  }),
};

module.exports = { redisRateLimit, limiters };
