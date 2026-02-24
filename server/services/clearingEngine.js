// ================================================================
// T1 BROKER — INTERNAL CLEARING & MATCHING ENGINE
// Custom instruments, internal order book, price-time priority
// matching, settlement, trade lifecycle
// ================================================================
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const settings = require('./platformSettings');
const crypto = require('crypto');

// ================================================================
// CUSTOM INSTRUMENT SERVICE
// Admin creates private assets, custom pairs
// ================================================================
class CustomInstrumentService {
  /**
   * Create a custom instrument (private asset, custom pair, etc.)
   */
  static async create({
    symbol, name, assetClass, exchange, currency,
    baseCurrency, quoteCurrency,
    lotSize, minQuantity, tickSize, isFractional,
    settlementType, clearingMethod, marginRequirement, commissionRate,
    lastPrice, metadata, visibleTo, createdBy,
  }) {
    const [instrument] = await db('instruments').insert({
      symbol: symbol.toUpperCase(),
      name,
      asset_class: assetClass || 'equity',
      exchange: exchange || 'T1X',  // T1 Internal Exchange
      currency: currency || 'USD',
      base_currency: baseCurrency,
      quote_currency: quoteCurrency,
      lot_size: lotSize || 1,
      min_quantity: minQuantity || 1,
      tick_size: tickSize || 0.01,
      is_fractional: isFractional || false,
      is_tradable: true,
      is_custom: true,
      is_private: visibleTo !== 'all' && visibleTo !== undefined,
      settlement_type: settlementType || 'T+2',
      clearing_method: clearingMethod || 'internal',
      margin_requirement: marginRequirement || 0.25,
      commission_rate: commissionRate || 0.001,
      last_price: lastPrice || null,
      metadata: JSON.stringify(metadata || {}),
      visible_to: JSON.stringify(visibleTo || ['all']),
      created_by: createdBy,
    }).returning('*');

    logger.info('Custom instrument created', { id: instrument.id, symbol: instrument.symbol });
    return instrument;
  }

  static async update(instrumentId, updates, updatedBy) {
    const allowed = ['name', 'lot_size', 'min_quantity', 'tick_size', 'is_fractional',
      'is_tradable', 'settlement_type', 'clearing_method', 'margin_requirement',
      'commission_rate', 'last_price', 'metadata', 'visible_to'];
    const clean = {};
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        clean[k] = ['metadata', 'visible_to'].includes(k) ? JSON.stringify(updates[k]) : updates[k];
      }
    }
    clean.updated_at = new Date();
    await db('instruments').where('id', instrumentId).update(clean);
    return db('instruments').where('id', instrumentId).first();
  }

  static async listCustom({ assetClass, search, limit = 50 } = {}) {
    let query = db('instruments').where('is_custom', true);
    if (assetClass) query = query.where('asset_class', assetClass);
    if (search) query = query.where(function () {
      this.where('symbol', 'ilike', `%${search}%`).orWhere('name', 'ilike', `%${search}%`);
    });
    return query.orderBy('symbol').limit(limit);
  }

  static async setPrice(instrumentId, price) {
    await db('instruments').where('id', instrumentId).update({
      last_price: price, updated_at: new Date(),
    });
  }
}

// ================================================================
// INTERNAL MATCHING ENGINE (Price-Time Priority)
// ================================================================
let sequenceCounter = 0;

class MatchingEngine {
  /**
   * Submit an order to the internal order book
   */
  static async submitOrder(orderId) {
    const order = await db('orders').where('id', orderId).first();
    if (!order) throw new Error('Order not found');

    const instrument = await db('instruments').where('id', order.instrument_id).first();
    if (!instrument || !['internal', 'self_clearing'].includes(instrument.clearing_method)) {
      throw new Error('Instrument not configured for internal clearing');
    }

    sequenceCounter++;

    // Insert into internal order book
    const [entry] = await db('internal_order_book').insert({
      order_id: orderId,
      client_id: order.client_id,
      instrument_id: order.instrument_id,
      side: order.side,
      order_type: order.order_type,
      price: order.price,
      quantity: order.quantity,
      filled_quantity: 0,
      remaining_qty: order.quantity,
      time_in_force: order.time_in_force || 'day',
      expire_at: order.expire_at,
      status: 'open',
      priority: sequenceCounter,
    }).returning('*');

    // Update order status
    await db('orders').where('id', orderId).update({ status: 'working', broker: 'internal' });

    // Try to match immediately
    await this.matchOrders(order.instrument_id);

    return entry;
  }

  /**
   * Core matching algorithm — price-time priority
   */
  static async matchOrders(instrumentId) {
    const trx = await db.transaction();
    try {
      // Get best bid (highest price, earliest time)
      const bestBid = await trx('internal_order_book')
        .where({ instrument_id: instrumentId, side: 'buy', status: 'open' })
        .orderBy('price', 'desc').orderBy('priority', 'asc')
        .first();

      // Get best ask (lowest price, earliest time)
      const bestAsk = await trx('internal_order_book')
        .where({ instrument_id: instrumentId, side: 'sell', status: 'open' })
        .orderBy('price', 'asc').orderBy('priority', 'asc')
        .first();

      if (!bestBid || !bestAsk) {
        await trx.commit();
        return []; // No match possible
      }

      // Prevent self-trades (same client on both sides)
      if (bestBid.client_id === bestAsk.client_id) {
        await trx.commit();
        return [];
      }

      // Check if orders can match
      // Market orders match at any price; limit orders must cross
      const bidPrice = bestBid.order_type === 'market' ? Infinity : parseFloat(bestBid.price);
      const askPrice = bestAsk.order_type === 'market' ? 0 : parseFloat(bestAsk.price);

      if (bidPrice < askPrice) {
        await trx.commit();
        return []; // No crossing
      }

      // Determine execution price (price of the resting order = earlier priority)
      // If both are market orders, use last traded price from instrument
      let execPrice;
      if (bestBid.order_type === 'market' && bestAsk.order_type === 'market') {
        const inst = await trx('instruments').where('id', instrumentId).first();
        execPrice = parseFloat(inst?.last_price);
        if (!execPrice || isNaN(execPrice)) {
          await trx.commit();
          return []; // Cannot match two market orders without a reference price
        }
      } else {
        execPrice = bestBid.priority < bestAsk.priority
          ? (bestBid.order_type === 'market' ? parseFloat(bestAsk.price) : parseFloat(bestBid.price))
          : (bestAsk.order_type === 'market' ? parseFloat(bestBid.price) : parseFloat(bestAsk.price));
      }

      // Determine fill quantity
      const fillQty = Math.min(parseFloat(bestBid.remaining_qty), parseFloat(bestAsk.remaining_qty));

      if (fillQty <= 0) {
        await trx.commit();
        return [];
      }

      // Get instrument for commission; fall back to platform settings
      const instrument = await trx('instruments').where('id', instrumentId).first();
      const defaultCommRate = await settings.getNumber('trading.default_commission_rate', 0.001);
      const clearingFeeRate = await settings.getNumber('trading.clearing_fee_rate', 0.0001);
      const commRate = parseFloat(instrument?.commission_rate || defaultCommRate);
      const totalValue = execPrice * fillQty;
      const commission = +(totalValue * commRate).toFixed(4);

      // Generate trade reference
      const tradeRef = 'TRD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();

      // Calculate settlement date
      const defaultSettlement = await settings.get('trading.default_settlement', 'T+2');
      const settlementType = instrument?.settlement_type || defaultSettlement;
      const settlementDays = settlementType === 'instant' ? 0 : (parseInt(settlementType.replace('T+', '')) || 2);
      const settlementDate = new Date();
      for (let d = 0; d < settlementDays; ) {
        settlementDate.setDate(settlementDate.getDate() + 1);
        if (settlementDate.getDay() !== 0 && settlementDate.getDay() !== 6) d++;
      }

      // Create trade record
      const [trade] = await trx('internal_trades').insert({
        trade_ref: tradeRef,
        instrument_id: instrumentId,
        buy_order_id: bestBid.id,
        buy_client_id: bestBid.client_id,
        sell_order_id: bestAsk.id,
        sell_client_id: bestAsk.client_id,
        price: execPrice,
        quantity: fillQty,
        total_value: totalValue,
        buy_commission: commission,
        sell_commission: commission,
        clearing_fee: +(totalValue * clearingFeeRate).toFixed(4),
        settlement_type: settlementType,
        settlement_date: settlementDate.toISOString().slice(0, 10),
      }).returning('*');

      // Update buy order book entry
      const newBidFilled = parseFloat(bestBid.filled_quantity) + fillQty;
      const newBidRemaining = parseFloat(bestBid.quantity) - newBidFilled;
      await trx('internal_order_book').where('id', bestBid.id).update({
        filled_quantity: newBidFilled,
        remaining_qty: newBidRemaining,
        status: newBidRemaining <= 0 ? 'filled' : 'partial',
        updated_at: new Date(),
      });

      // Update sell order book entry
      const newAskFilled = parseFloat(bestAsk.filled_quantity) + fillQty;
      const newAskRemaining = parseFloat(bestAsk.quantity) - newAskFilled;
      await trx('internal_order_book').where('id', bestAsk.id).update({
        filled_quantity: newAskFilled,
        remaining_qty: newAskRemaining,
        status: newAskRemaining <= 0 ? 'filled' : 'partial',
        updated_at: new Date(),
      });

      // Update parent orders
      await this._updateParentOrder(trx, bestBid.order_id, fillQty, execPrice);
      await this._updateParentOrder(trx, bestAsk.order_id, fillQty, execPrice);

      // Update positions
      await this._updatePosition(trx, bestBid.client_id, instrumentId, 'buy', fillQty, execPrice);
      await this._updatePosition(trx, bestAsk.client_id, instrumentId, 'sell', fillQty, execPrice);

      // Update instrument last price
      await trx('instruments').where('id', instrumentId).update({
        last_price: execPrice, updated_at: new Date(),
      });

      await trx.commit();

      logger.info('Internal trade matched', { tradeRef, symbol: instrument?.symbol, price: execPrice, qty: fillQty });

      // Recursively try to match more (there may be more crossing orders)
      const moreTrades = await this.matchOrders(instrumentId);
      return [trade, ...moreTrades];

    } catch (err) {
      await trx.rollback();
      logger.error('Matching engine error', { instrumentId, error: err.message });
      throw err;
    }
  }

  static async _updateParentOrder(trx, orderId, fillQty, fillPrice) {
    const order = await trx('orders').where('id', orderId).first();
    if (!order) return;

    const prevFilled = parseFloat(order.filled_quantity || 0);
    const newFilled = prevFilled + fillQty;
    const totalCost = (parseFloat(order.avg_fill_price || 0) * prevFilled) + (fillPrice * fillQty);
    const newAvg = totalCost / newFilled;
    const isFull = newFilled >= parseFloat(order.quantity);

    await trx('orders').where('id', orderId).update({
      filled_quantity: newFilled,
      avg_fill_price: +newAvg.toFixed(8),
      status: isFull ? 'filled' : 'partially_filled',
      filled_at: isFull ? new Date() : null,
      updated_at: new Date(),
    });
  }

  static async _updatePosition(trx, clientId, instrumentId, side, qty, price) {
    const openingSide = side === 'buy' ? 'long' : 'short';
    const closingSide = side === 'buy' ? 'short' : 'long';

    // First: check if there's an opposite position to close/reduce
    const opposite = await trx('positions')
      .where({ client_id: clientId, instrument_id: instrumentId, side: closingSide, broker: 'internal' })
      .whereNull('closed_at')
      .first();

    let remainingQty = qty;

    if (opposite) {
      const oppQty = parseFloat(opposite.quantity);
      if (remainingQty >= oppQty) {
        // Close the entire opposite position
        const realizedPnl = side === 'buy'
          ? (parseFloat(opposite.avg_cost) - price) * oppQty   // closing short at lower price = profit
          : (price - parseFloat(opposite.avg_cost)) * oppQty;  // closing long at higher price = profit

        await trx('positions').where('id', opposite.id).update({
          quantity: 0, closed_at: new Date(), updated_at: new Date(),
          realized_pnl: db.raw('realized_pnl + ?', [+realizedPnl.toFixed(4)]),
        });
        remainingQty -= oppQty;
      } else {
        // Partially reduce the opposite position
        const realizedPnl = side === 'buy'
          ? (parseFloat(opposite.avg_cost) - price) * remainingQty
          : (price - parseFloat(opposite.avg_cost)) * remainingQty;

        await trx('positions').where('id', opposite.id).update({
          quantity: oppQty - remainingQty, updated_at: new Date(),
          realized_pnl: db.raw('realized_pnl + ?', [+realizedPnl.toFixed(4)]),
        });
        remainingQty = 0;
      }
    }

    // Second: if there's remaining quantity, add to/create same-side position
    if (remainingQty > 0) {
      const existing = await trx('positions')
        .where({ client_id: clientId, instrument_id: instrumentId, side: openingSide, broker: 'internal' })
        .whereNull('closed_at')
        .first();

      if (existing) {
        const oldQty = parseFloat(existing.quantity);
        const oldAvg = parseFloat(existing.avg_cost);
        const newQty = oldQty + remainingQty;
        const newAvg = (oldAvg * oldQty + price * remainingQty) / newQty;

        await trx('positions').where('id', existing.id).update({
          quantity: newQty, avg_cost: +newAvg.toFixed(8), updated_at: new Date(),
        });
      } else {
        await trx('positions').insert({
          client_id: clientId, instrument_id: instrumentId,
          side: openingSide, quantity: remainingQty, avg_cost: price,
          broker: 'internal',
        });
      }
    }
  }

  // ================================================================
  // ORDER BOOK QUERIES
  // ================================================================

  static async getOrderBook(instrumentId, depth = 20) {
    const [bids, asks] = await Promise.all([
      db('internal_order_book')
        .where({ instrument_id: instrumentId, side: 'buy', status: 'open' })
        .whereNotNull('price')
        .select('price', db.raw('SUM(remaining_qty) as quantity'), db.raw('COUNT(*) as orders'))
        .groupBy('price').orderBy('price', 'desc').limit(depth),
      db('internal_order_book')
        .where({ instrument_id: instrumentId, side: 'sell', status: 'open' })
        .whereNotNull('price')
        .select('price', db.raw('SUM(remaining_qty) as quantity'), db.raw('COUNT(*) as orders'))
        .groupBy('price').orderBy('price', 'asc').limit(depth),
    ]);

    return {
      bids: bids.map(b => ({ price: parseFloat(b.price), quantity: parseFloat(b.quantity), orders: parseInt(b.orders) })),
      asks: asks.map(a => ({ price: parseFloat(a.price), quantity: parseFloat(a.quantity), orders: parseInt(a.orders) })),
      spread: bids[0] && asks[0] ? +(parseFloat(asks[0].price) - parseFloat(bids[0].price)).toFixed(8) : null,
    };
  }

  static async getRecentTrades(instrumentId, limit = 50) {
    return db('internal_trades')
      .where('instrument_id', instrumentId)
      .orderBy('matched_at', 'desc')
      .limit(limit)
      .select('trade_ref', 'price', 'quantity', 'total_value', 'matched_at');
  }

  // ================================================================
  // CANCELLATION
  // ================================================================

  static async cancelOrder(orderBookId, cancelledBy) {
    const entry = await db('internal_order_book').where('id', orderBookId).first();
    if (!entry || entry.status === 'filled' || entry.status === 'cancelled') {
      throw new Error('Order cannot be cancelled');
    }

    await db('internal_order_book').where('id', orderBookId).update({ status: 'cancelled', updated_at: new Date() });
    await db('orders').where('id', entry.order_id).update({ status: 'cancelled', updated_at: new Date() });

    logger.info('Internal order cancelled', { orderBookId, orderId: entry.order_id });
  }

  // ================================================================
  // SETTLEMENT
  // ================================================================

  static async runSettlement(settlementDate, runBy) {
    const trx = await db.transaction();
    try {
      const today = settlementDate || new Date().toISOString().slice(0, 10);

      const unsettled = await trx('internal_trades')
        .where({ settlement_date: today, is_settled: false })
        .select('*');

      if (!unsettled.length) {
        await trx.commit();
        return { trades: 0, message: 'No trades to settle' };
      }

      // Create settlement run
      const [run] = await trx('settlement_runs').insert({
        settlement_date: today,
        trades_count: unsettled.length,
        total_volume: unsettled.reduce((s, t) => s + parseFloat(t.total_value), 0),
        total_fees: unsettled.reduce((s, t) => s + parseFloat(t.buy_commission) + parseFloat(t.sell_commission) + parseFloat(t.clearing_fee), 0),
        status: 'processing',
        started_at: new Date(),
        run_by: runBy,
      }).returning('*');

      // Process each trade
      for (const trade of unsettled) {
        // Debit buyer's cash
        await trx('accounts')
          .where({ client_id: trade.buy_client_id, broker: 'internal' })
          .update({
            cash_balance: db.raw('cash_balance - ? - ?', [trade.total_value, trade.buy_commission]),
            updated_at: new Date(),
          });

        // Credit seller's cash
        await trx('accounts')
          .where({ client_id: trade.sell_client_id, broker: 'internal' })
          .update({
            cash_balance: db.raw('cash_balance + ? - ?', [trade.total_value, trade.sell_commission]),
            updated_at: new Date(),
          });

        // Mark settled
        await trx('internal_trades').where('id', trade.id).update({
          is_settled: true, settled_at: new Date(),
        });
      }

      await trx('settlement_runs').where('id', run.id).update({
        status: 'completed', completed_at: new Date(),
      });

      await trx.commit();

      AuditService.log({
        userId: runBy, action: `Settlement run completed: ${unsettled.length} trades, $${run.total_volume}`,
        resourceType: 'settlement', resourceId: run.id, level: 'info',
      });

      logger.info('Settlement complete', { date: today, trades: unsettled.length, volume: run.total_volume });
      return { trades: unsettled.length, volume: run.total_volume, fees: run.total_fees, runId: run.id };

    } catch (err) {
      await trx.rollback();
      logger.error('Settlement failed', { error: err.message });
      throw err;
    }
  }
}

module.exports = { CustomInstrumentService, MatchingEngine };
