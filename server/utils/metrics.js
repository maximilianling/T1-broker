// ================================================================
// T1 BROKER — PROMETHEUS METRICS
// Request latency, order throughput, error rates, business metrics
// ================================================================
const client = require('prom-client');

// Create a registry
const register = new client.Registry();

// Default Node.js metrics (GC, event loop, memory)
client.collectDefaultMetrics({ register, prefix: 't1_' });

// ================================================================
// HTTP Metrics
// ================================================================
const httpRequestDuration = new client.Histogram({
  name: 't1_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
register.registerMetric(httpRequestDuration);

const httpRequestTotal = new client.Counter({
  name: 't1_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});
register.registerMetric(httpRequestTotal);

const httpErrorTotal = new client.Counter({
  name: 't1_http_errors_total',
  help: 'Total number of HTTP errors (4xx and 5xx)',
  labelNames: ['method', 'route', 'status_code'],
});
register.registerMetric(httpErrorTotal);

// ================================================================
// Business Metrics
// ================================================================
const ordersPlaced = new client.Counter({
  name: 't1_orders_placed_total',
  help: 'Total orders placed',
  labelNames: ['side', 'order_type', 'broker', 'status'],
});
register.registerMetric(ordersPlaced);

const orderLatency = new client.Histogram({
  name: 't1_order_submission_duration_seconds',
  help: 'Time to submit order to broker',
  labelNames: ['broker'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});
register.registerMetric(orderLatency);

const fillsProcessed = new client.Counter({
  name: 't1_fills_processed_total',
  help: 'Total order fills processed',
  labelNames: ['broker'],
});
register.registerMetric(fillsProcessed);

const transfersTotal = new client.Counter({
  name: 't1_transfers_total',
  help: 'Total transfers processed',
  labelNames: ['type', 'status'],
});
register.registerMetric(transfersTotal);

const activeConnections = new client.Gauge({
  name: 't1_ws_active_connections',
  help: 'Active WebSocket connections',
});
register.registerMetric(activeConnections);

const authenticatedUsers = new client.Gauge({
  name: 't1_ws_authenticated_users',
  help: 'Authenticated WebSocket users',
});
register.registerMetric(authenticatedUsers);

// ================================================================
// Broker Health Metrics
// ================================================================
const brokerCircuitState = new client.Gauge({
  name: 't1_broker_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['broker'],
});
register.registerMetric(brokerCircuitState);

const brokerApiLatency = new client.Histogram({
  name: 't1_broker_api_duration_seconds',
  help: 'Broker API call duration',
  labelNames: ['broker', 'operation'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
});
register.registerMetric(brokerApiLatency);

const brokerApiErrors = new client.Counter({
  name: 't1_broker_api_errors_total',
  help: 'Broker API errors',
  labelNames: ['broker', 'operation', 'error_type'],
});
register.registerMetric(brokerApiErrors);

// ================================================================
// Database Metrics
// ================================================================
const dbQueryDuration = new client.Histogram({
  name: 't1_db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
});
register.registerMetric(dbQueryDuration);

const dbPoolSize = new client.Gauge({
  name: 't1_db_pool_size',
  help: 'Database connection pool size',
  labelNames: ['state'],
});
register.registerMetric(dbPoolSize);

// ================================================================
// Auth Metrics
// ================================================================
const loginAttempts = new client.Counter({
  name: 't1_login_attempts_total',
  help: 'Login attempts',
  labelNames: ['result'], // 'success', 'failed', 'locked', 'mfa_required'
});
register.registerMetric(loginAttempts);

const rateLimitHits = new client.Counter({
  name: 't1_rate_limit_hits_total',
  help: 'Rate limit rejections',
  labelNames: ['endpoint'],
});
register.registerMetric(rateLimitHits);

// ================================================================
// Middleware — tracks request metrics
// ================================================================
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const route = req.route?.path || req.path.replace(/[0-9a-f-]{36}/g, ':id');
    const labels = {
      method: req.method,
      route: route.substring(0, 50),
      status_code: res.statusCode,
    };

    httpRequestDuration.observe(labels, durationSec);
    httpRequestTotal.inc(labels);

    if (res.statusCode >= 400) {
      httpErrorTotal.inc(labels);
    }
  });

  next();
}

// ================================================================
// Metrics endpoint handler
// ================================================================
async function metricsHandler(req, res) {
  try {
    // Update WebSocket gauges
    if (global.wsServer) {
      const stats = global.wsServer.getStats();
      activeConnections.set(stats.totalConnections || 0);
      authenticatedUsers.set(stats.authenticatedUsers || 0);
    }

    // Update circuit breaker gauges
    const { breakers } = require('../utils/resilience');
    const stateMap = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
    brokerCircuitState.set({ broker: 'saxo' }, stateMap[breakers.saxo.state] || 0);
    brokerCircuitState.set({ broker: 'drivewealth' }, stateMap[breakers.drivewealth.state] || 0);

    // Update DB pool gauges
    try {
      const db = require('../config/database');
      const pool = db.client?.pool;
      if (pool) {
        dbPoolSize.set({ state: 'used' }, pool.numUsed?.() || 0);
        dbPoolSize.set({ state: 'free' }, pool.numFree?.() || 0);
        dbPoolSize.set({ state: 'pending' }, pool.numPendingAcquires?.() || 0);
      }
    } catch (e) { /* pool metrics unavailable */ }

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end('Error collecting metrics');
  }
}

module.exports = {
  register,
  metrics: {
    httpRequestDuration, httpRequestTotal, httpErrorTotal,
    ordersPlaced, orderLatency, fillsProcessed, transfersTotal,
    activeConnections, authenticatedUsers,
    brokerCircuitState, brokerApiLatency, brokerApiErrors,
    dbQueryDuration, dbPoolSize,
    loginAttempts, rateLimitHits,
  },
  metricsMiddleware,
  metricsHandler,
};
