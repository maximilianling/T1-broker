// ================================================================
// T1 BROKER — CIRCUIT BREAKER & RETRY UTILITIES
// Protects against broker API outages, implements exponential backoff
// ================================================================
const logger = require('./logger');

// ================================================================
// CIRCUIT BREAKER
// States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing)
// ================================================================
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;

    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 3;
    this.timeout = options.timeout || 30000; // 30s before trying again
    this.monitorInterval = options.monitorInterval || 10000;

    this._listeners = { stateChange: [], failure: [], success: [] };
  }

  async execute(fn, fallback) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttemptTime) {
        logger.warn(`Circuit breaker ${this.name}: OPEN — using fallback`, {
          nextAttempt: new Date(this.nextAttemptTime).toISOString(),
        });
        if (fallback) return fallback();
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
      // Try half-open
      this.state = 'HALF_OPEN';
      this._emit('stateChange', { from: 'OPEN', to: 'HALF_OPEN' });
      logger.info(`Circuit breaker ${this.name}: HALF_OPEN — testing`);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      if (fallback) return fallback();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this._emit('stateChange', { from: 'HALF_OPEN', to: 'CLOSED' });
        logger.info(`Circuit breaker ${this.name}: CLOSED — recovered`);
      }
    } else {
      this.failureCount = Math.max(0, this.failureCount - 1); // Decay on success
    }
    this._emit('success');
  }

  _onFailure(err) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this._emit('failure', { error: err.message, count: this.failureCount });

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      const prevState = this.state;
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.timeout;
      this.successCount = 0;
      this._emit('stateChange', { from: prevState, to: 'OPEN' });
      logger.error(`Circuit breaker ${this.name}: OPEN — ${this.failureCount} failures`, {
        lastError: err.message,
        retryAt: new Date(this.nextAttemptTime).toISOString(),
      });
    }
  }

  on(event, handler) {
    if (this._listeners[event]) this._listeners[event].push(handler);
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach(h => h({ breaker: this.name, state: this.state, ...data }));
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      nextAttempt: this.nextAttemptTime ? new Date(this.nextAttemptTime).toISOString() : null,
    };
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;
  }
}

// ================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ================================================================
async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    retryOn = null,       // function(err) => boolean — which errors to retry
    onRetry = null,       // callback(err, attempt) on each retry
    timeout = 0,          // per-attempt timeout (0 = none)
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (timeout > 0) {
        return await Promise.race([
          fn(attempt),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
          ),
        ]);
      }
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Check if we should retry this error
      if (retryOn && !retryOn(err)) throw err;
      // Don't retry on client errors (4xx)
      if (err.response?.status >= 400 && err.response?.status < 500) throw err;

      if (attempt < maxRetries) {
        let delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
        if (jitter) delay = delay * (0.5 + Math.random() * 0.5);

        if (onRetry) onRetry(err, attempt + 1, delay);
        logger.warn(`Retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`, {
          error: err.message,
          function: fn.name || 'anonymous',
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ================================================================
// TIMEOUT WRAPPER
// ================================================================
function withTimeout(promise, ms, message = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// ================================================================
// IDEMPOTENCY KEY MANAGER
// ================================================================
class IdempotencyManager {
  constructor(redis) {
    this.redis = redis;
    this.ttl = 86400; // 24 hours
  }

  generateKey(prefix, ...parts) {
    const crypto = require('crypto');
    const data = parts.join(':');
    const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    return `${prefix}:${hash}:${Date.now()}`;
  }

  async check(key) {
    const existing = await this.redis.get(`idempotent:${key}`);
    return existing; // null if not seen before, result if already processed
  }

  async store(key, result) {
    await this.redis.set(`idempotent:${key}`, result, this.ttl);
  }
}

// ================================================================
// PRE-CONFIGURED BROKER CIRCUIT BREAKERS
// ================================================================
const breakers = {
  saxo: new CircuitBreaker('saxo-bank', {
    failureThreshold: 5,
    timeout: 30000,
    successThreshold: 2,
  }),
  drivewealth: new CircuitBreaker('drivewealth', {
    failureThreshold: 5,
    timeout: 30000,
    successThreshold: 2,
  }),
};

// Log state changes
Object.values(breakers).forEach(b => {
  b.on('stateChange', (data) => {
    logger.warn(`Circuit breaker state change: ${data.breaker} ${data.from} → ${data.to}`);
  });
});

module.exports = { CircuitBreaker, retry, withTimeout, IdempotencyManager, breakers };
