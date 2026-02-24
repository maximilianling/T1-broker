// ================================================================
// T1 BROKER PLATFORM — SERVER ENTRY POINT (PRODUCTION)
// ================================================================
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('./config');
const logger = require('./utils/logger');
const db = require('./config/database');
const redis = require('./utils/redis');
const { requestLogger } = require('./middleware/auth');
const { errorHandler, notFoundHandler, multerErrorHandler, asyncHandler } = require('./middleware/errors');
const { limiters } = require('./middleware/rateLimiter');
const { sanitizeInputs, parameterPollutionProtection, requestGuard, securityHeaders, requestSizeGuard } = require('./middleware/security');
const { advancedSecurityHeaders, anomalyDetector, ipReputation, CSRFProtection, WebhookVerifier } = require('./middleware/advancedSecurity');
const { auditSecrets, responseSanitizer, apiFirewall, replayProtection, sensitiveEndpointGuard, contentSecurityPolicy, depthLimiter } = require('./middleware/securityHardening');
const { responseDataMasking, piiQueryGuard } = require('./middleware/piiShield');
const { bootstrap: securityBootstrap, postListen: securityPostListen, getErrorMasking } = require('./security/securityBootstrap');
const { metricsMiddleware } = require('./utils/metrics');
const WSServer = require('./services/websocket');
const jobScheduler = require('./jobs/scheduler');

const app = express();
const server = http.createServer(app);

// Trust proxy
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

// Request ID
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: config.env === 'production' ? {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"], imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  hsts: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

// CORS
app.use(cors({
  origin: config.env === 'production' ? config.cors.origin
    : [config.cors.origin, 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-MFA-Token', 'X-Request-ID', 'X-CSRF-Token', 'X-Request-Nonce', 'X-Idempotency-Key'],
  exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Idempotency-Key-Required'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(compression());

// Security hardening — layer 1: headers & IP filtering
app.use(advancedSecurityHeaders);
app.use(contentSecurityPolicy());
app.use(securityHeaders);
app.use(requestSizeGuard(10 * 1024 * 1024));
app.use(sanitizeInputs);
app.use(parameterPollutionProtection);
app.use(requestGuard);
app.use(ipReputation.middleware());
app.use(anomalyDetector.middleware());
app.use(CSRFProtection.middleware());

// Security hardening — layer 2: deep packet inspection & response protection
app.use(depthLimiter(10));
app.use(apiFirewall());
app.use(responseSanitizer());
app.use(replayProtection());
app.use(sensitiveEndpointGuard());

// Security hardening — layer 3: PII protection
app.use(piiQueryGuard());                 // Block PII in URL query strings
app.use(responseDataMasking());           // Auto-mask PII in API responses for non-admin roles

// Prometheus metrics collection
app.use(metricsMiddleware);

if (config.env !== 'test') {
  app.use(morgan(':method :url :status :response-time ms', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.path.includes('/health') || req.path.includes('/live'),
  }));
}
app.use(requestLogger);

// White-label theming — resolves partner branding from custom domains
const WhiteLabelService = require('./services/whiteLabel');
app.use(WhiteLabelService.middleware());

// Static files (hardened)
app.use(express.static(path.join(__dirname, '../client/public'), {
  maxAge: config.env === 'production' ? '1d' : 0,
  etag: true,
  dotfiles: 'deny',     // block .env, .git, .htaccess etc.
  index: 'index.html',
  redirect: false,        // don't auto-redirect directories
  setHeaders: (res, filePath) => {
    // Block source maps in production
    if (config.env === 'production' && filePath.endsWith('.map')) {
      res.status(404).end();
    }
    // Security headers for HTML files
    if (filePath.endsWith('.html')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
    }
  },
}));

// ================================================================
// API ROUTES
// ================================================================
const prefix = config.apiPrefix;
const { authenticate, authorize } = require('./middleware/auth');

// Monitoring (unauthenticated)
const { monitorRouter, documentRouter, passwordRouter, notificationRouter } = require('./routes/extended');
app.use(`${prefix}`, monitorRouter);

// Auth (rate limited)
app.use(`${prefix}/auth`, limiters.auth, require('./routes/auth'));
app.use(`${prefix}/password`, passwordRouter);
app.use(`${prefix}/mfa`, require('./routes/mfa'));

// All API routes — base rate limit
app.use(`${prefix}`, limiters.api);

// Maintenance mode gate — blocks non-admin API calls when enabled
app.use(`${prefix}`, (req, res, next) => {
  if (!config.system?.maintenanceMode) return next();
  // Always allow admin, auth, health, and settings routes through
  const path = req.path;
  if (path.startsWith('/admin') || path.startsWith('/auth') || path.startsWith('/mfa') ||
      path.startsWith('/password') || path.startsWith('/health') || path.startsWith('/monitor')) {
    return next();
  }
  // Allow if authenticated admin
  if (req.user && ['super_admin', 'admin', 'operations'].includes(req.user.role)) {
    return next();
  }
  res.status(503).json({
    error: 'Platform is under maintenance',
    message: config.system.maintenanceMessage || 'We are performing scheduled maintenance. Please try again later.',
    maintenance: true,
  });
});

// Core routes
app.use(`${prefix}/orders`, limiters.orders, require('./routes/orders'));
app.use(`${prefix}/clients`, require('./routes/clients'));
app.use(`${prefix}/api-keys`, require('./routes/apiKeys'));
const { positionsRouter } = require('./routes/positions');
app.use(`${prefix}/positions`, positionsRouter);

const { marketRouter, transferRouter, partnerRouter, adminRouter } = require('./routes/api');
app.use(`${prefix}/market`, marketRouter);
app.use(`${prefix}/transfers`, limiters.transfers, transferRouter);
app.use(`${prefix}/partners`, require('./routes/partners'));
app.use(`${prefix}/admin`, adminRouter);

// Extended routes
app.use(`${prefix}/documents`, documentRouter);
app.use(`${prefix}/notifications`, notificationRouter);

// Admin configuration: providers, brokerages, wallets, custom instruments, clearing
app.use(`${prefix}/admin/config`, require('./routes/adminConfig'));

// Admin platform settings
app.use(`${prefix}/admin/settings`, require('./routes/adminSettings'));

// Admin database backups
app.use(`${prefix}/admin/backups`, require('./routes/adminBackups'));

// Admin security dashboard
app.use(`${prefix}/admin/security`, require('./routes/adminSecurity'));

// Client crypto wallet routes
const CryptoWalletService = require('./services/cryptoWallet');
app.get(`${prefix}/crypto/accounts`, authenticate, asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const accounts = await CryptoWalletService.getClientCryptoAccounts(client.id);
  res.json({ data: accounts });
}));
app.post(`${prefix}/crypto/accounts`, authenticate, asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const account = await CryptoWalletService.getOrCreateAccount(client.id, req.body.blockchain);
  res.json(account);
}));
app.post(`${prefix}/crypto/withdraw`, authenticate, asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const tx = await CryptoWalletService.requestWithdrawal({ clientId: client.id, ...req.body });
  res.json(tx);
}));
app.get(`${prefix}/crypto/transactions`, authenticate, asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const txs = await CryptoWalletService.getTransactions(client.id, req.query);
  res.json({ data: txs });
}));
app.get(`${prefix}/crypto/tokens`, authenticate, asyncHandler(async (req, res) => {
  const tokens = await CryptoWalletService.getSupportedTokens(req.query.blockchain);
  res.json({ data: tokens });
}));

// Feature routes: wallet, watchlist, alerts, portfolio, push tokens
app.use(`${prefix}`, require('./routes/mobile'));

// Margin endpoints
const MarginEngine = require('./services/margin');
app.get(`${prefix}/margin/status`, authenticate, asyncHandler(async (req, res) => {
  const db = require('./config/database');
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(await MarginEngine.calculateMargin(client.id));
}));
app.get(`${prefix}/margin/check`, authenticate, asyncHandler(async (req, res) => {
  const db = require('./config/database');
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { instrumentId, side, quantity, price } = req.query;
  res.json(await MarginEngine.preTradeCheck(client.id, instrumentId, side, parseFloat(quantity), price ? parseFloat(price) : undefined));
}));
app.post(`${prefix}/admin/margin/sweep`, authenticate, authorize('super_admin', 'admin'), asyncHandler(async (req, res) => {
  res.json(await MarginEngine.runMarginSweep());
}));

// Webhooks (HMAC-verified)
const OrderService = require('./services/orders');
app.post(`${prefix}/webhooks/drivewealth`, WebhookVerifier.driveWealthMiddleware(), express.json(), asyncHandler(async (req, res) => {
  const { type, data } = req.body;
  if (type === 'ORDER_FILL') {
    await OrderService.processFill({
      brokerOrderId: data.orderId, broker: 'drivewealth',
      fillQuantity: parseFloat(data.fillQty), fillPrice: parseFloat(data.fillPrice), executionVenue: data.venue,
    });
  }
  res.json({ received: true });
}));
app.post(`${prefix}/webhooks/saxo`, WebhookVerifier.saxoMiddleware(), express.json(), asyncHandler(async (req, res) => {
  const { type, data } = req.body;
  if (type === 'OrderFilled' || type === 'OrderPartiallyFilled') {
    await OrderService.processFill({
      brokerOrderId: data.OrderId, broker: 'saxo',
      fillQuantity: parseFloat(data.FilledAmount), fillPrice: parseFloat(data.AveragePrice), executionVenue: data.Exchange,
    });
  }
  res.json({ received: true });
}));

// Live market quote endpoint (rate-limited, no auth required for public quotes)
app.get(`${prefix}/market/quote/:symbol`, limiters.api, (req, res) => {
  // Validate symbol format — prevent injection via params
  const symbol = req.params.symbol?.replace(/[^a-zA-Z0-9\/\-_.]/g, '').substring(0, 20);
  if (!symbol) return res.status(400).json({ error: 'Invalid symbol' });
  const quote = global.marketFeed?.getQuote(symbol);
  if (!quote) return res.status(404).json({ error: 'Symbol not found' });
  res.json(quote);
});
app.get(`${prefix}/market/movers`, limiters.api, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50); // cap at 50
  const movers = global.marketFeed?.getTopMovers(limit) || [];
  res.json({ data: movers });
});
app.get(`${prefix}/market/active`, limiters.api, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
  const active = global.marketFeed?.getMostActive(limit) || [];
  res.json({ data: active });
});

// Landing page (public homepage)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/landing.html'));
});

// SPA catch-all — trading app for /app and unmatched non-API paths
app.get('*', (req, res, next) => {
  if (req.path.startsWith(prefix)) return next();
  // Direct .html files are served by static middleware above
  // Everything else falls through to the trading SPA
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// Error handling (must be last)
app.use(notFoundHandler);
app.use(multerErrorHandler);
app.use(getErrorMasking()); // Production: mask internal errors, hide stack traces
app.use(errorHandler);

// ================================================================
// START
// ================================================================
async function start() {
  // ── Security: validate all secrets before any service starts ──
  auditSecrets();

  try { await redis.connect(); } catch (err) {
    logger.warn('Redis unavailable — running degraded', { error: err.message });
  }
  try {
    const db = require('./config/database');
    await db.raw('SELECT 1');
    logger.info('✅ Database connected');

    // ── SECURITY BOOTSTRAP: Wire DB armor, IDS, honeypots ──
    await securityBootstrap(app, { db });

    // Load dynamic settings from platform_settings table
    await config.loadFromDB();
    config.startDynamicRefresh(60000); // Refresh every 60s
    logger.info('✅ Dynamic config loaded from platform_settings');
  } catch (err) {
    logger.error('❌ Database connection failed', { error: err.message });
    process.exit(1);
  }

  server.listen(config.port, () => {
    logger.info(`T1 Broker started | env=${config.env} port=${config.port}`);
    global.wsServer = new WSServer(server);

    // ── Harden WebSocket connections ──
    securityPostListen(global.wsServer);

    // Start live market data feed
    const MarketDataFeed = require('./services/marketFeed');
    global.marketFeed = new MarketDataFeed(global.wsServer);
    global.marketFeed.start();

    if (redis.client) {
      redis.subscribe('ws:admin', (data) => global.wsServer?.broadcastAdmin(data)).catch(() => {});
    }
    if (config.env !== 'test') jobScheduler.start();

    // Push notification background jobs
    const { PushNotificationService } = require('./services/push');
    // Check push receipts every 5 minutes
    setInterval(() => PushNotificationService.checkReceipts().catch(() => {}), 300000);
    // Process retry queue every 2 minutes
    setInterval(() => PushNotificationService.processRetryQueue().catch(() => {}), 120000);

    logger.info('✅ All systems operational');
  });
}

start().catch(err => { logger.error('Startup failed', { error: err.message }); process.exit(1); });

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} — shutting down`);
  server.close(async () => {
    jobScheduler.stop();
    if (global.marketFeed) global.marketFeed.stop();
    try { await redis.disconnect(); } catch (e) {}
    try { await require('./config/database').destroy(); } catch (e) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  // Log full details server-side only
  logger.error('Uncaught exception', { error: err.message, stack: config.env !== 'production' ? err.stack : undefined });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  // Sanitize — never expose full stack in case logging goes to external service
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error('Unhandled rejection', { reason: msg });
});

module.exports = { app, server };
