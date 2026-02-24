// ================================================================
// T1 BROKER — WALLET, WATCHLIST, ALERTS, PORTFOLIO, PUSH ROUTES
// These fill the gaps identified in the platform audit
// ================================================================
const router = require('express').Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const AuditService = require('../utils/audit');
const logger = require('../utils/logger');

router.use(authenticate);

// ================================================================
// WALLET / FUNDING
// ================================================================

// GET /wallet/balance — Account balance summary
router.get('/wallet/balance', asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client profile not found' });

  const account = await db('accounts').where('client_id', client.id).first();
  if (!account) return res.status(404).json({ error: 'No account found' });

  // Get position values
  const positions = await db('positions')
    .where('account_id', account.id)
    .where('quantity', '>', 0);

  const positionValue = positions.reduce((sum, p) =>
    sum + (p.quantity * (p.current_price || p.average_cost)), 0);

  res.json({
    accountId: account.id,
    currency: account.currency || 'USD',
    cashBalance: parseFloat(account.cash_balance || 0),
    positionValue,
    totalValue: parseFloat(account.cash_balance || 0) + positionValue,
    buyingPower: parseFloat(account.buying_power || account.cash_balance || 0),
    marginUsed: parseFloat(account.margin_used || 0),
    dayChange: 0, // Would come from position price changes
    dayChangePct: 0,
    pendingDeposits: 0,
    pendingWithdrawals: 0,
  });
}));

// POST /wallet/deposit — Initiate deposit
router.post('/wallet/deposit', asyncHandler(async (req, res) => {
  const { amount, method = 'bank' } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (amount > 1000000) return res.status(400).json({ error: 'Amount exceeds maximum' });

  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client profile not found' });

  const account = await db('accounts').where('client_id', client.id).first();
  if (!account) return res.status(404).json({ error: 'No account found' });

  const [txn] = await db('cash_transactions').insert({
    account_id: account.id,
    type: 'deposit',
    amount: amount,
    currency: 'USD',
    status: 'pending',
    payment_method: method,
    reference: `DEP-${Date.now()}`,
    description: `${method} deposit`,
  }).returning('*');

  AuditService.log({
    userId: req.user.id,
    action: `Deposit initiated: $${amount} via ${method}`,
    resourceType: 'transfer', resourceId: txn.id,
    level: 'info', ipAddress: req.ip,
  });

  res.json({ transaction: txn, message: 'Deposit submitted for processing' });
}));

// POST /wallet/withdraw — Initiate withdrawal
router.post('/wallet/withdraw', asyncHandler(async (req, res) => {
  const { amount, bankAccountId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const client = await db('clients').where('user_id', req.user.id).first();
  const account = await db('accounts').where('client_id', client?.id).first();
  if (!account) return res.status(404).json({ error: 'No account found' });

  if (amount > parseFloat(account.cash_balance || 0)) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }

  const [txn] = await db('cash_transactions').insert({
    account_id: account.id,
    type: 'withdrawal',
    amount: -amount,
    currency: 'USD',
    status: 'pending_approval', // Dual authorization required
    payment_method: 'bank',
    reference: `WDR-${Date.now()}`,
    description: 'Bank withdrawal (requires approval)',
  }).returning('*');

  AuditService.log({
    userId: req.user.id,
    action: `Withdrawal requested: $${amount}`,
    resourceType: 'transfer', resourceId: txn.id,
    level: 'warning', ipAddress: req.ip,
  });

  res.json({ transaction: txn, message: 'Withdrawal submitted — requires dual authorization (24-48h)' });
}));

// GET /wallet/history — Transfer history
router.get('/wallet/history', asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  const account = await db('accounts').where('client_id', client?.id).first();

  const history = await db('cash_transactions')
    .where('account_id', account?.id)
    .orderBy('created_at', 'desc')
    .limit(50);

  res.json({ data: history });
}));

// ================================================================
// WATCHLIST
// ================================================================

// GET /watchlist — User's watchlist
router.get('/watchlist', asyncHandler(async (req, res) => {
  // Using price_alerts table with type='watchlist' or a simple in-memory approach
  // For production, add a watchlist table. Here we use a lightweight approach:
  const items = await db('price_alerts')
    .where('user_id', req.user.id)
    .where('alert_type', 'watchlist')
    .orderBy('created_at', 'desc');

  // Enrich with instrument data
  const symbols = items.map(i => i.symbol);
  const instruments = symbols.length > 0
    ? await db('instruments').whereIn('symbol', symbols)
    : [];

  const enriched = items.map(item => {
    const inst = instruments.find(i => i.symbol === item.symbol) || {};
    return {
      symbol: item.symbol,
      name: inst.name || item.symbol,
      exchange: inst.exchange,
      assetClass: inst.asset_class,
      price: parseFloat(inst.last_price || 0),
      change: 0, // Would come from market data feed
      addedAt: item.created_at,
    };
  });

  res.json({ data: enriched });
}));

// POST /watchlist — Add to watchlist
router.post('/watchlist', asyncHandler(async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  const exists = await db('price_alerts')
    .where('user_id', req.user.id)
    .where('symbol', symbol.toUpperCase())
    .where('alert_type', 'watchlist')
    .first();

  if (exists) return res.status(409).json({ error: 'Already in watchlist' });

  await db('price_alerts').insert({
    user_id: req.user.id,
    symbol: symbol.toUpperCase(),
    alert_type: 'watchlist',
    condition: 'watch',
    target_price: 0,
  });

  res.json({ message: `${symbol.toUpperCase()} added to watchlist` });
}));

// DELETE /watchlist/:symbol — Remove from watchlist
router.delete('/watchlist/:symbol', asyncHandler(async (req, res) => {
  await db('price_alerts')
    .where('user_id', req.user.id)
    .where('symbol', req.params.symbol.toUpperCase())
    .where('alert_type', 'watchlist')
    .del();

  res.json({ message: 'Removed from watchlist' });
}));

// ================================================================
// PRICE ALERTS
// ================================================================

// GET /alerts — User's price alerts
router.get('/alerts', asyncHandler(async (req, res) => {
  const alerts = await db('price_alerts')
    .where('user_id', req.user.id)
    .whereNot('alert_type', 'watchlist')
    .orderBy('created_at', 'desc');

  res.json({ data: alerts });
}));

// POST /alerts — Create price alert
router.post('/alerts', asyncHandler(async (req, res) => {
  const { symbol, condition, targetPrice, note } = req.body;
  if (!symbol || !condition || !targetPrice) {
    return res.status(400).json({ error: 'symbol, condition, and targetPrice are required' });
  }

  if (!['above', 'below', 'crosses'].includes(condition)) {
    return res.status(400).json({ error: 'condition must be: above, below, or crosses' });
  }

  const [alert] = await db('price_alerts').insert({
    user_id: req.user.id,
    symbol: symbol.toUpperCase(),
    alert_type: 'price',
    condition,
    target_price: targetPrice,
    note,
  }).returning('*');

  res.json(alert);
}));

// DELETE /alerts/:id — Delete a price alert
router.delete('/alerts/:id', asyncHandler(async (req, res) => {
  await db('price_alerts')
    .where('id', req.params.id)
    .where('user_id', req.user.id)
    .del();

  res.json({ message: 'Alert deleted' });
}));

// ================================================================
// PORTFOLIO ANALYTICS
// ================================================================

// GET /portfolio/summary — Aggregate portfolio metrics
router.get('/portfolio/summary', asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  const account = await db('accounts').where('client_id', client?.id).first();
  if (!account) return res.json({ totalValue: 0, positions: 0 });

  const positions = await db('positions')
    .where('account_id', account.id)
    .where('quantity', '>', 0);

  const totalCost = positions.reduce((s, p) => s + (p.quantity * p.average_cost), 0);
  const totalValue = positions.reduce((s, p) => s + (p.quantity * (p.current_price || p.average_cost)), 0);
  const unrealizedPL = totalValue - totalCost;

  // Allocation by asset class
  const allocation = {};
  for (const pos of positions) {
    const inst = await db('instruments').where('symbol', pos.symbol).first();
    const cls = inst?.asset_class || 'Other';
    allocation[cls] = (allocation[cls] || 0) + (pos.quantity * (pos.current_price || pos.average_cost));
  }

  res.json({
    cashBalance: parseFloat(account.cash_balance || 0),
    positionValue: totalValue,
    totalValue: parseFloat(account.cash_balance || 0) + totalValue,
    totalCost,
    unrealizedPL,
    unrealizedPLPct: totalCost > 0 ? (unrealizedPL / totalCost) * 100 : 0,
    positionCount: positions.length,
    allocation: Object.entries(allocation).map(([cls, value]) => ({
      assetClass: cls,
      value,
      percentage: totalValue > 0 ? (value / totalValue) * 100 : 0,
    })),
  });
}));

// GET /portfolio/history — Portfolio value over time
router.get('/portfolio/history', asyncHandler(async (req, res) => {
  const { period = '1M' } = req.query;
  const client = await db('clients').where('user_id', req.user.id).first();
  const account = await db('accounts').where('client_id', client?.id).first();

  const periodDays = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, 'ALL': 3650 };
  const days = periodDays[period] || 30;
  const since = new Date(Date.now() - days * 86400000);

  const snapshots = await db('position_snapshots')
    .where('account_id', account?.id)
    .where('snapshot_date', '>=', since)
    .orderBy('snapshot_date', 'asc');

  res.json({
    data: snapshots.map(s => ({
      date: s.snapshot_date,
      totalValue: parseFloat(s.total_value || 0),
      cashBalance: parseFloat(s.cash_balance || 0),
      positionValue: parseFloat(s.position_value || 0),
    })),
    period,
  });
}));

// ================================================================
// PUSH NOTIFICATION TOKEN REGISTRATION
// ================================================================

// POST /notifications/push-token — Register device for push
router.post('/notifications/push-token', asyncHandler(async (req, res) => {
  const { token, platform, deviceName } = req.body;
  if (!token) return res.status(400).json({ error: 'Push token required' });

  // Upsert — one token per user per platform
  await db.raw(`
    INSERT INTO push_tokens (user_id, token, platform, device_name, updated_at)
    VALUES (?, ?, ?, ?, NOW())
    ON CONFLICT (user_id, platform) DO UPDATE SET
      token = EXCLUDED.token,
      device_name = EXCLUDED.device_name,
      updated_at = NOW()
  `, [req.user.id, token, platform || 'unknown', deviceName || 'Mobile']);

  logger.info('Push token registered', { userId: req.user.id, platform });
  res.json({ message: 'Push token registered' });
}));

// DELETE /notifications/push-token — Unregister push
router.delete('/notifications/push-token', asyncHandler(async (req, res) => {
  await db('push_tokens').where('user_id', req.user.id).del();
  res.json({ message: 'Push tokens removed' });
}));

module.exports = router;
