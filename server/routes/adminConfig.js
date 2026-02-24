// ================================================================
// T1 BROKER — ADMIN CONFIGURATION ROUTES
// Market Data Providers, Brokerage Connectors, Crypto Wallets,
// Custom Instruments, Internal Clearing
// ================================================================
const router = require('express').Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation');
const { MarketDataProviderManager, encrypt, decrypt } = require('../services/providerManager');
const CryptoWalletService = require('../services/cryptoWallet');
const { CustomInstrumentService, MatchingEngine } = require('../services/clearingEngine');
const AuditService = require('../utils/audit');
const logger = require('../utils/logger');

router.use(authenticate);
router.use(authorize('super_admin', 'admin', 'operations'));

// ================================================================
// 1. MARKET DATA PROVIDERS
// ================================================================

// GET /admin/config/providers — List all market data providers
router.get('/providers', async (req, res) => {
  try {
    const providers = await MarketDataProviderManager.listProviders();
    res.json({ data: providers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load providers' });
  }
});

// GET /admin/config/providers/:id — Get single provider details
router.get('/providers/:id', async (req, res) => {
  try {
    const provider = await db('market_data_providers').where('id', req.params.id).first();
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    // Mask API key
    res.json({
      ...provider,
      api_key_encrypted: provider.api_key_encrypted ? '••••••••' + decrypt(provider.api_key_encrypted)?.slice(-4) : null,
      api_secret_encrypted: provider.api_secret_encrypted ? '••••••••' : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load provider' });
  }
});

// POST /admin/config/providers/:id/apikey — Set API key for a provider
router.post('/providers/:id/apikey',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const { apiKey, apiSecret } = req.body;
      if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });

      await MarketDataProviderManager.setApiKey(req.params.id, apiKey, apiSecret);

      // Auto-activate if key is set
      await db('market_data_providers').where('id', req.params.id).update({ status: 'active' });

      AuditService.log({
        userId: req.user.id, action: `Market data provider API key configured`,
        resourceType: 'provider', resourceId: req.params.id, level: 'info', ipAddress: req.ip,
      });

      res.json({ success: true, message: 'API key saved and provider activated' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to set API key' });
    }
  }
);

// DELETE /admin/config/providers/:id/apikey — Remove API key
router.delete('/providers/:id/apikey',
  authorize('super_admin'),
  async (req, res) => {
    try {
      await MarketDataProviderManager.removeApiKey(req.params.id);
      AuditService.log({
        userId: req.user.id, action: 'Provider API key removed',
        resourceType: 'provider', resourceId: req.params.id, level: 'warning', ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to remove API key' });
    }
  }
);

// PATCH /admin/config/providers/:id — Update provider settings (priority, status, etc.)
router.patch('/providers/:id', async (req, res) => {
  try {
    await MarketDataProviderManager.updateProvider(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

// POST /admin/config/providers/health-check — Test all provider connections
router.post('/providers/health-check', async (req, res) => {
  try {
    const results = await MarketDataProviderManager.healthCheckAll();
    res.json({ data: results });
  } catch (err) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

// POST /admin/config/providers/:id/test — Test single provider with a symbol
router.post('/providers/:id/test', async (req, res) => {
  try {
    const { symbol = 'AAPL' } = req.body;
    const provider = await db('market_data_providers').where('id', req.params.id).first();
    if (!provider || !provider.api_key_encrypted) {
      return res.status(400).json({ error: 'Provider not configured' });
    }

    const start = Date.now();
    const quote = await MarketDataProviderManager.getQuote(symbol);
    const latency = Date.now() - start;

    res.json({ success: !!quote, quote, latencyMs: latency });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 2. BROKERAGE CONNECTORS
// ================================================================

// GET /admin/config/brokerages — List all brokerage connectors
router.get('/brokerages', async (req, res) => {
  try {
    const connectors = await db('brokerage_connectors').orderBy('connector_code').select(
      'id', 'connector_code', 'display_name', 'broker_type', 'base_url', 'ws_url',
      'sandbox_url', 'auth_type', 'environment', 'status', 'is_enabled',
      'supports_equities', 'supports_options', 'supports_futures', 'supports_forex',
      'supports_crypto', 'supports_fractional',
      'omnibus_account_id', 'omnibus_account_name',
      'webhook_url', 'last_heartbeat', 'error_message', 'latency_ms',
      'docs_url', 'support_email', 'notes',
      db.raw("CASE WHEN api_key_encrypted IS NOT NULL THEN true ELSE false END as has_credentials"),
      db.raw("CASE WHEN client_id IS NOT NULL THEN true ELSE false END as has_oauth"),
      'created_at', 'updated_at'
    );
    res.json({ data: connectors });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load brokerages' });
  }
});

// POST /admin/config/brokerages/:id/credentials — Set brokerage API credentials
router.post('/brokerages/:id/credentials',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const { apiKey, apiSecret, clientId, accessToken, refreshToken, environment, omnibusAccountId, omnibusAccountName, webhookUrl, webhookSecret } = req.body;

      const updates = { updated_at: new Date() };
      if (apiKey) updates.api_key_encrypted = encrypt(apiKey);
      if (apiSecret) updates.api_secret_encrypted = encrypt(apiSecret);
      if (clientId) updates.client_id = clientId;
      if (accessToken) updates.access_token_encrypted = encrypt(accessToken);
      if (refreshToken) updates.refresh_token_encrypted = encrypt(refreshToken);
      if (environment) updates.environment = environment;
      if (omnibusAccountId) updates.omnibus_account_id = omnibusAccountId;
      if (omnibusAccountName) updates.omnibus_account_name = omnibusAccountName;
      if (webhookUrl) updates.webhook_url = webhookUrl;
      if (webhookSecret) updates.webhook_secret = encrypt(webhookSecret);

      updates.configured_by = req.user.id;

      await db('brokerage_connectors').where('id', req.params.id).update(updates);

      AuditService.log({
        userId: req.user.id, action: 'Brokerage connector credentials updated',
        resourceType: 'brokerage', resourceId: req.params.id, level: 'info', ipAddress: req.ip,
      });

      res.json({ success: true, message: 'Credentials saved' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save credentials' });
    }
  }
);

// PATCH /admin/config/brokerages/:id — Toggle enable/disable, switch environment
router.patch('/brokerages/:id', async (req, res) => {
  try {
    const allowed = ['is_enabled', 'environment', 'status', 'notes', 'support_email'];
    const updates = {};
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    updates.updated_at = new Date();
    await db('brokerage_connectors').where('id', req.params.id).update(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update connector' });
  }
});

// POST /admin/config/brokerages/:id/test — Test brokerage connectivity
router.post('/brokerages/:id/test', async (req, res) => {
  try {
    const connector = await db('brokerage_connectors').where('id', req.params.id).first();
    if (!connector) return res.status(404).json({ error: 'Connector not found' });

    const start = Date.now();
    // Test connectivity based on broker type
    let result = { status: 'unknown' };
    if (connector.connector_code === 'internal') {
      result = { status: 'connected', message: 'Internal clearing engine ready' };
    } else {
      // Try to hit a health or auth endpoint
      try {
        const apiUrl = connector.environment === 'production' ? connector.base_url : (connector.sandbox_url || connector.base_url);
        const resp = await fetch(apiUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        result = { status: resp.ok ? 'connected' : 'error', httpStatus: resp.status };
      } catch (e) {
        result = { status: 'error', message: e.message };
      }
    }

    const latency = Date.now() - start;
    await db('brokerage_connectors').where('id', req.params.id).update({
      status: result.status, latency_ms: latency, last_heartbeat: new Date(),
      error_message: result.status === 'error' ? result.message : null,
    });

    res.json({ ...result, latencyMs: latency });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/config/brokerages — Add new brokerage connector
router.post('/brokerages',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const { connectorCode, displayName, brokerType, baseUrl, wsUrl, sandboxUrl, authType,
        supportsEquities, supportsOptions, supportsFutures, supportsForex, supportsCrypto,
        supportsFractional, docsUrl } = req.body;

      const [connector] = await db('brokerage_connectors').insert({
        connector_code: connectorCode, display_name: displayName, broker_type: brokerType || 'internal',
        base_url: baseUrl, ws_url: wsUrl, sandbox_url: sandboxUrl, auth_type: authType || 'api_key',
        supports_equities: supportsEquities, supports_options: supportsOptions,
        supports_futures: supportsFutures, supports_forex: supportsForex,
        supports_crypto: supportsCrypto, supports_fractional: supportsFractional,
        docs_url: docsUrl, configured_by: req.user.id,
      }).returning('*');

      res.status(201).json(connector);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create connector' });
    }
  }
);

// ================================================================
// 3. CRYPTO OMNIBUS WALLETS
// ================================================================

// GET /admin/config/wallets — List omnibus wallets
router.get('/wallets', async (req, res) => {
  try {
    const wallets = await CryptoWalletService.listOmnibusWallets(req.query.blockchain);
    res.json({ data: wallets });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load wallets' });
  }
});

// POST /admin/config/wallets — Create new omnibus wallet
router.post('/wallets',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const wallet = await CryptoWalletService.createOmnibusWallet({
        ...req.body, createdBy: req.user.id,
      });
      AuditService.log({
        userId: req.user.id, action: `Omnibus wallet created: ${req.body.walletName} (${req.body.blockchain})`,
        resourceType: 'wallet', resourceId: wallet.id, level: 'info', ipAddress: req.ip,
      });
      res.status(201).json(wallet);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create wallet' });
    }
  }
);

// POST /admin/config/wallets/:id/key — Store encrypted private key
router.post('/wallets/:id/key',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const { privateKey, mnemonic } = req.body;
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      await CryptoWalletService.storeEncryptedKey(req.params.id, privateKey, mnemonic);
      AuditService.log({
        userId: req.user.id, action: 'Wallet private key stored',
        resourceType: 'wallet', resourceId: req.params.id, level: 'warning', ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to store key' });
    }
  }
);

// GET /admin/config/wallets/tokens — List supported tokens
router.get('/wallets/tokens', async (req, res) => {
  try {
    const tokens = await CryptoWalletService.getSupportedTokens(req.query.blockchain);
    res.json({ data: tokens });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tokens' });
  }
});

// POST /admin/config/wallets/tokens — Add supported token
router.post('/wallets/tokens',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const [token] = await CryptoWalletService.addToken(req.body);
      res.status(201).json(token);
    } catch (err) {
      res.status(500).json({ error: 'Failed to add token' });
    }
  }
);

// GET /admin/config/wallets/chains — Get supported blockchains config
router.get('/wallets/chains', async (req, res) => {
  res.json({ data: await CryptoWalletService.getChainConfig() });
});

// POST /admin/config/wallets/:id/sweep — Trigger hot→cold sweep
router.post('/wallets/:id/sweep',
  authorize('super_admin'),
  async (req, res) => {
    try {
      await CryptoWalletService.checkAndSweep();
      res.json({ success: true, message: 'Sweep check completed' });
    } catch (err) {
      res.status(500).json({ error: 'Sweep failed' });
    }
  }
);

// GET /admin/config/wallets/transactions — All crypto transactions
router.get('/wallets/transactions', async (req, res) => {
  try {
    let query = db('crypto_transactions as ct')
      .leftJoin('clients as c', 'c.id', 'ct.client_id')
      .orderBy('ct.created_at', 'desc');

    if (req.query.blockchain) query = query.where('ct.blockchain', req.query.blockchain);
    if (req.query.status) query = query.where('ct.status', req.query.status);
    if (req.query.type) query = query.where('ct.tx_type', req.query.type);

    const txs = await query.limit(parseInt(req.query.limit || 50)).select(
      'ct.*', db.raw("c.first_name || ' ' || c.last_name as client_name")
    );
    res.json({ data: txs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// POST /admin/config/wallets/transactions/:id/approve — Approve withdrawal
router.post('/wallets/transactions/:id/approve',
  authorize('super_admin', 'admin', 'operations'),
  async (req, res) => {
    try {
      const tx = await CryptoWalletService.approveWithdrawal(req.params.id, req.user.id);
      AuditService.log({
        userId: req.user.id, action: `Withdrawal approved: ${tx.amount} ${tx.blockchain}`,
        resourceType: 'crypto_tx', resourceId: req.params.id, level: 'info', ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ================================================================
// 4. CUSTOM INSTRUMENTS
// ================================================================

// GET /admin/config/instruments — List custom instruments
router.get('/instruments', async (req, res) => {
  try {
    const instruments = await CustomInstrumentService.listCustom(req.query);
    res.json({ data: instruments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load instruments' });
  }
});

// POST /admin/config/instruments — Create custom instrument
router.post('/instruments',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const instrument = await CustomInstrumentService.create({ ...req.body, createdBy: req.user.id });
      AuditService.log({
        userId: req.user.id, action: `Custom instrument created: ${instrument.symbol}`,
        resourceType: 'instrument', resourceId: instrument.id, level: 'info', ipAddress: req.ip,
      });
      res.status(201).json(instrument);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to create instrument' });
    }
  }
);

// PATCH /admin/config/instruments/:id — Update custom instrument
router.patch('/instruments/:id', async (req, res) => {
  try {
    const instrument = await CustomInstrumentService.update(req.params.id, req.body, req.user.id);
    res.json(instrument);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update instrument' });
  }
});

// POST /admin/config/instruments/:id/price — Set reference price
router.post('/instruments/:id/price', async (req, res) => {
  try {
    const { price } = req.body;
    if (!price) return res.status(400).json({ error: 'price required' });
    await CustomInstrumentService.setPrice(req.params.id, price);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set price' });
  }
});

// ================================================================
// 5. INTERNAL CLEARING
// ================================================================

// GET /admin/config/clearing/orderbook/:instrumentId — View internal order book
router.get('/clearing/orderbook/:instrumentId', async (req, res) => {
  try {
    const book = await MatchingEngine.getOrderBook(req.params.instrumentId, parseInt(req.query.depth || 20));
    res.json(book);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load order book' });
  }
});

// GET /admin/config/clearing/trades/:instrumentId — Recent internal trades
router.get('/clearing/trades/:instrumentId', async (req, res) => {
  try {
    const trades = await MatchingEngine.getRecentTrades(req.params.instrumentId, parseInt(req.query.limit || 50));
    res.json({ data: trades });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trades' });
  }
});

// POST /admin/config/clearing/settlement — Run settlement
router.post('/clearing/settlement',
  authorize('super_admin', 'admin', 'operations'),
  async (req, res) => {
    try {
      const result = await MatchingEngine.runSettlement(req.body.date, req.user.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Settlement failed' });
    }
  }
);

// GET /admin/config/clearing/settlements — Settlement history
router.get('/clearing/settlements', async (req, res) => {
  try {
    const runs = await db('settlement_runs').orderBy('settlement_date', 'desc').limit(50);
    res.json({ data: runs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settlements' });
  }
});

module.exports = router;
