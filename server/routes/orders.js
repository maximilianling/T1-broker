// ================================================================
// T1 BROKER — ORDER ROUTES
// ================================================================
const router = require('express').Router();
const db = require('../config/database');
const OrderService = require('../services/orders');
const { authenticate, authorize, partnerScope, requireAPIPermission } = require('../middleware/auth');
const { requireKYC } = require('../middleware/kycGate');
const { validate, schemas } = require('../middleware/validation');
const logger = require('../utils/logger');

// All routes require authentication (JWT or API key)
router.use(authenticate);

// ----------------------------------------------------------------
// POST /orders — Place new order
// ----------------------------------------------------------------
router.post('/', requireKYC, requireAPIPermission('trade'), validate(schemas.createOrder), async (req, res) => {
  try {
    const client = await db('clients').where('user_id', req.user.id).first();
    if (!client) return res.status(404).json({ error: 'Client account not found' });

    const order = await OrderService.placeOrder({
      clientId: client.id,
      userId: req.user.id,
      instrumentId: req.body.instrumentId,
      side: req.body.side,
      orderType: req.body.orderType,
      quantity: req.body.quantity,
      price: req.body.price,
      stopPrice: req.body.stopPrice,
      trailAmount: req.body.trailAmount,
      timeInForce: req.body.timeInForce,
      expireAt: req.body.expireAt,
      ipAddress: req.ip,
    });

    res.status(201).json(order);
  } catch (err) {
    logger.error('Order placement failed', { error: err.message, userId: req.user.id });
    const status = err.message.includes('Insufficient') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// POST /orders/batch — Place multiple orders simultaneously
// Max 20 orders per batch. Returns results for each order.
// ----------------------------------------------------------------
router.post('/batch', requireKYC, requireAPIPermission('trade'), async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'orders must be a non-empty array' });
    }
    if (orders.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 orders per batch' });
    }

    const client = await db('clients').where('user_id', req.user.id).first();
    if (!client) return res.status(404).json({ error: 'Client account not found' });

    const results = [];
    for (const o of orders) {
      try {
        const order = await OrderService.placeOrder({
          clientId: client.id,
          userId: req.user.id,
          instrumentId: o.instrumentId,
          side: o.side,
          orderType: o.orderType,
          quantity: o.quantity,
          price: o.price,
          stopPrice: o.stopPrice,
          trailAmount: o.trailAmount,
          timeInForce: o.timeInForce,
          expireAt: o.expireAt,
          ipAddress: req.ip,
        });
        results.push({ success: true, ...order });
      } catch (err) {
        results.push({
          success: false,
          error: err.message,
          instrument: o.instrumentId,
          side: o.side,
          quantity: o.quantity,
        });
      }
    }

    const placed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    res.status(201).json({ placed, failed, total: orders.length, results });
  } catch (err) {
    logger.error('Batch order failed', { error: err.message, userId: req.user.id });
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /orders — List orders (client sees own, admin sees all)
// ----------------------------------------------------------------
router.get('/', partnerScope, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, side, symbol } = req.query;
    const offset = (page - 1) * limit;

    let query = db('orders as o')
      .join('instruments as i', 'i.id', 'o.instrument_id')
      .join('clients as c', 'c.id', 'o.client_id')
      .select(
        'o.*',
        'i.symbol', 'i.name as instrument_name', 'i.asset_class',
        'c.first_name', 'c.last_name', 'c.account_number'
      )
      .orderBy('o.created_at', 'desc');

    // Scope by role
    if (req.user.role === 'client') {
      const client = await db('clients').where('user_id', req.user.id).first();
      query = query.where('o.client_id', client.id);
    } else if (req.partnerScope) {
      query = query.where('o.partner_id', req.partnerId);
    }

    if (status) query = query.where('o.status', status);
    if (side) query = query.where('o.side', side);
    if (symbol) query = query.where('i.symbol', 'ilike', `%${symbol}%`);

    const [{ count }] = await query.clone().count();
    const orders = await query.limit(limit).offset(offset);

    res.json({ data: orders, total: parseInt(count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    logger.error('Get orders failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ----------------------------------------------------------------
// GET /orders/:id
// ----------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const order = await db('orders as o')
      .join('instruments as i', 'i.id', 'o.instrument_id')
      .where('o.id', req.params.id)
      .select('o.*', 'i.symbol', 'i.name as instrument_name')
      .first();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Client can only see own orders
    if (req.user.role === 'client') {
      const client = await db('clients').where('user_id', req.user.id).first();
      if (order.client_id !== client.id) return res.status(403).json({ error: 'Forbidden' });
    }

    // Get fills
    const fills = await db('order_fills').where('order_id', order.id).orderBy('filled_at', 'desc');
    order.fills = fills;

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ----------------------------------------------------------------
// DELETE /orders/:id — Cancel order
// ----------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const order = await db('orders').where('id', req.params.id).first();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Client can only cancel own orders
    if (req.user.role === 'client') {
      const client = await db('clients').where('user_id', req.user.id).first();
      if (order.client_id !== client.id) return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await OrderService.cancelOrder({
      orderId: req.params.id,
      userId: req.user.id,
      ipAddress: req.ip,
      reason: req.body.reason,
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
