// ================================================================
// T1 BROKER — POSITIONS ROUTES
// ================================================================
const positionsRouter = require('express').Router();
const db = require('../config/database');
const { authenticate, authorize, partnerScope } = require('../middleware/auth');

positionsRouter.use(authenticate);

positionsRouter.get('/', partnerScope, async (req, res) => {
  try {
    let query = db('positions as p')
      .join('instruments as i', 'i.id', 'p.instrument_id')
      .join('clients as c', 'c.id', 'p.client_id')
      .whereNull('p.closed_at')
      .select(
        'p.*', 'i.symbol', 'i.name as instrument_name', 'i.last_price',
        'i.asset_class', 'i.exchange',
        'c.first_name', 'c.last_name', 'c.account_number'
      )
      .orderBy('p.updated_at', 'desc');

    if (req.user.role === 'client') {
      const client = await db('clients').where('user_id', req.user.id).first();
      query = query.where('p.client_id', client.id);
    } else if (req.partnerScope) {
      query = query.where('p.partner_id', req.partnerId);
    }

    const positions = await query;

    // Calculate unrealized P&L
    const enriched = positions.map(p => {
      const marketValue = parseFloat(p.quantity) * parseFloat(p.last_price || p.avg_cost);
      const costBasis = parseFloat(p.quantity) * parseFloat(p.avg_cost);
      const unrealizedPnl = p.side === 'long'
        ? marketValue - costBasis
        : costBasis - marketValue;
      const pnlPercent = costBasis ? (unrealizedPnl / costBasis) * 100 : 0;

      return {
        ...p,
        marketValue: Math.round(marketValue * 100) / 100,
        costBasis: Math.round(costBasis * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
      };
    });

    res.json({ data: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// Snapshot endpoint for EOD reporting
positionsRouter.post('/snapshot',
  authorize('super_admin', 'admin', 'operations'),
  async (req, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const positions = await db('positions as p')
        .join('instruments as i', 'i.id', 'p.instrument_id')
        .whereNull('p.closed_at')
        .select('p.*', 'i.last_price');

      const snapshots = positions.map(p => ({
        client_id: p.client_id,
        instrument_id: p.instrument_id,
        snapshot_date: today,
        side: p.side,
        quantity: p.quantity,
        avg_cost: p.avg_cost,
        market_price: p.last_price || p.avg_cost,
        market_value: parseFloat(p.quantity) * parseFloat(p.last_price || p.avg_cost),
        unrealized_pnl: p.side === 'long'
          ? (parseFloat(p.last_price || p.avg_cost) - parseFloat(p.avg_cost)) * parseFloat(p.quantity)
          : (parseFloat(p.avg_cost) - parseFloat(p.last_price || p.avg_cost)) * parseFloat(p.quantity),
      }));

      await db('position_snapshots').insert(snapshots).onConflict(['client_id', 'instrument_id', 'snapshot_date']).merge();

      res.json({ message: 'Snapshot created', count: snapshots.length, date: today });
    } catch (err) {
      res.status(500).json({ error: 'Snapshot failed: ' + err.message });
    }
  }
);

module.exports = { positionsRouter };
