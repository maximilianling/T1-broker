// ================================================================
// T1 BROKER — ORDER MANAGEMENT SERVICE
// Routes orders to appropriate sub-broker, manages lifecycle
// ================================================================
const db = require('../config/database');
const saxo = require('./saxo');
const drivewealth = require('./drivewealth');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const { breakers, retry, withTimeout } = require('../utils/resilience');

class OrderService {
  /**
   * Place a new order — validates, determines routing, sends to broker
   */
  static async placeOrder({ clientId, userId, instrumentId, side, orderType, quantity, price, stopPrice, trailAmount, timeInForce, expireAt, ipAddress }) {
    const trx = await db.transaction();

    try {
      // 1. Get instrument details to determine routing
      const instrument = await trx('instruments').where('id', instrumentId).first();
      if (!instrument) throw new Error('Instrument not found');
      if (!instrument.is_tradable) throw new Error('Instrument is not tradable');

      // 2. Get client account
      const client = await trx('clients').where('id', clientId).first();
      if (!client || client.status !== 'active') throw new Error('Client account not active');

      // 3. Determine broker routing
      const broker = this._routeToBroker(instrument);

      // 3.5. Ensure client has an account for this broker
      const existingAccount = await trx('accounts')
        .where({ client_id: clientId, broker, currency: instrument.currency || 'USD' }).first();
      if (!existingAccount) {
        await trx('accounts').insert({
          client_id: clientId, broker, currency: instrument.currency || 'USD',
          cash_balance: 0, reserved_balance: 0, margin_used: 0, buying_power: 0,
        });
      }

      // 4. Pre-trade validation
      await this._preTradeCheck(trx, clientId, instrument, side, quantity, price || instrument.last_price);

      // 5. Create order record
      const [order] = await trx('orders')
        .insert({
          client_id: clientId,
          instrument_id: instrumentId,
          partner_id: client.partner_id,
          side,
          order_type: orderType,
          quantity,
          price,
          stop_price: stopPrice,
          trail_amount: trailAmount,
          time_in_force: timeInForce,
          expire_at: expireAt,
          status: 'pending',
          broker,
          created_by: userId,
          ip_address: ipAddress,
        })
        .returning('*');

      // 6. Reserve buying power
      if (side === 'buy') {
        const reserveAmount = quantity * (price || instrument.last_price);
        await trx('accounts')
          .where('client_id', clientId)
          .where('broker', broker)
          .decrement('buying_power', reserveAmount)
          .increment('reserved_balance', reserveAmount);
      }

      // 7. Submit to broker (with circuit breaker + retry)
      let brokerResult;
      try {
        if (broker === 'drivewealth') {
          const account = await trx('accounts').where('client_id', clientId).where('broker', 'drivewealth').first();
          brokerResult = await breakers.drivewealth.execute(
            () => retry(
              () => withTimeout(
                drivewealth.placeOrder(account.broker_account_id, {
                  instrumentId: instrument.dw_instrument_id, side, orderType, quantity, price,
                }),
                10000, 'DriveWealth order timeout'
              ),
              { maxRetries: 2, baseDelay: 500, retryOn: (err) => err.message?.includes('timeout') }
            ),
            () => { throw new Error('DriveWealth circuit breaker OPEN — broker unavailable'); }
          );
        } else if (broker === 'saxo') {
          const account = await trx('accounts').where('client_id', clientId).where('broker', 'saxo').first();
          brokerResult = await breakers.saxo.execute(
            () => retry(
              () => withTimeout(
                saxo.placeOrder(account.broker_account_id, {
                  uic: instrument.saxo_uic,
                  assetType: this._saxoAssetType(instrument.asset_class),
                  side, orderType, quantity, price,
                }),
                10000, 'Saxo order timeout'
              ),
              { maxRetries: 2, baseDelay: 500, retryOn: (err) => err.message?.includes('timeout') }
            ),
            () => { throw new Error('Saxo Bank circuit breaker OPEN — broker unavailable'); }
          );
        } else if (broker === 'internal') {
          // Internal clearing — skip external broker call
          order.status = 'working';
          brokerResult = { brokerOrderId: `INT-${order.id.slice(0, 8)}` };
        }

        // 8. Update order with broker reference
        await trx('orders').where('id', order.id).update({
          broker_order_id: brokerResult?.brokerOrderId,
          status: order.status === 'working' ? 'working' : 'submitted',
          submitted_at: new Date(),
        });

        order.status = order.status === 'working' ? 'working' : 'submitted';
        order.broker_order_id = brokerResult?.brokerOrderId;
      } catch (brokerErr) {
        // Broker rejection — update order status
        await trx('orders').where('id', order.id).update({
          status: 'rejected',
        });

        // Release reserved funds
        if (side === 'buy') {
          const reserveAmount = quantity * (price || instrument.last_price);
          await trx('accounts')
            .where('client_id', clientId)
            .where('broker', broker)
            .increment('buying_power', reserveAmount)
            .decrement('reserved_balance', reserveAmount);
        }

        throw new Error(`Broker rejected order: ${brokerErr.message}`);
      }

      await trx.commit();

      // Audit log
      AuditService.log({
        userId,
        action: `Order placed — ${instrument.symbol} ${side.toUpperCase()} ${orderType} ${quantity} @ ${price || 'Market'}`,
        resourceType: 'order',
        resourceId: order.order_ref,
        level: 'info',
        ipAddress,
        newValues: { orderId: order.id, broker, brokerOrderId: brokerResult?.brokerOrderId },
      });

      // For internal clearing, submit to matching engine after commit
      if (broker === 'internal') {
        try {
          const { MatchingEngine } = require('./clearingEngine');
          await MatchingEngine.submitOrder(order.id);
        } catch (matchErr) {
          logger.error('Matching engine submission failed', { orderId: order.id, error: matchErr.message });
        }
      }

      return order;
    } catch (err) {
      await trx.rollback();
      logger.error('Order placement failed', { clientId, instrumentId, error: err.message });
      throw err;
    }
  }

  /**
   * Cancel an existing order
   */
  static async cancelOrder({ orderId, userId, ipAddress, reason }) {
    const order = await db('orders').where('id', orderId).first();
    if (!order) throw new Error('Order not found');
    if (!['pending', 'submitted', 'working', 'partially_filled'].includes(order.status)) {
      throw new Error(`Cannot cancel order in status: ${order.status}`);
    }

    // Cancel at broker
    try {
      if (order.broker === 'drivewealth') {
        await drivewealth.cancelOrder(order.broker_order_id);
      } else if (order.broker === 'saxo') {
        const account = await db('accounts').where('client_id', order.client_id).where('broker', 'saxo').first();
        await saxo.cancelOrder(account.broker_account_id, order.broker_order_id);
      }
    } catch (err) {
      logger.warn('Broker cancel may have failed', { orderId, error: err.message });
    }

    // Update local status
    await db('orders').where('id', orderId).update({
      status: 'cancelled',
      cancelled_at: new Date(),
    });

    // Release reserved funds
    if (order.side === 'buy') {
      const remaining = parseFloat(order.quantity) - parseFloat(order.filled_quantity);
      // For market orders, price is null — use avg_fill_price or look up instrument price
      let estimatedPrice = parseFloat(order.price) || parseFloat(order.avg_fill_price) || 0;
      if (!estimatedPrice && remaining > 0) {
        const instrument = await db('instruments').where('id', order.instrument_id).first();
        estimatedPrice = parseFloat(instrument?.last_price) || 0;
      }
      const releaseAmount = remaining * estimatedPrice;
      if (releaseAmount > 0) {
        await db('accounts')
          .where('client_id', order.client_id)
          .where('broker', order.broker)
          .increment('buying_power', releaseAmount)
          .decrement('reserved_balance', Math.max(0, releaseAmount));
      }
    }

    AuditService.log({
      userId,
      action: `Order cancelled — ${order.order_ref}`,
      resourceType: 'order',
      resourceId: order.order_ref,
      level: 'info',
      ipAddress,
      metadata: { reason },
    });

    return { orderId, status: 'cancelled' };
  }

  /**
   * Process a fill event from broker webhook/stream
   */
  static async processFill({ brokerOrderId, broker, fillQuantity, fillPrice, executionVenue }) {
    const order = await db('orders')
      .where('broker_order_id', brokerOrderId)
      .where('broker', broker)
      .first();

    if (!order) {
      logger.error('Fill received for unknown order', { brokerOrderId, broker });
      return;
    }

    const trx = await db.transaction();
    try {
      // Record fill
      await trx('order_fills').insert({
        order_id: order.id,
        fill_quantity: fillQuantity,
        fill_price: fillPrice,
        execution_venue: executionVenue,
      });

      // Update order
      const newFilledQty = parseFloat(order.filled_quantity) + fillQuantity;
      const totalCost = parseFloat(order.avg_fill_price || 0) * parseFloat(order.filled_quantity) + fillPrice * fillQuantity;
      const newAvgPrice = totalCost / newFilledQty;
      const newStatus = newFilledQty >= parseFloat(order.quantity) ? 'filled' : 'partially_filled';

      await trx('orders').where('id', order.id).update({
        filled_quantity: newFilledQty,
        avg_fill_price: newAvgPrice,
        status: newStatus,
        filled_at: newStatus === 'filled' ? new Date() : null,
      });

      // Update/create position
      await this._updatePosition(trx, order, fillQuantity, fillPrice, broker);

      // Update account balances
      await this._updateAccountBalance(trx, order, fillQuantity, fillPrice, broker);

      await trx.commit();

      // Send real-time notifications
      try {
        const { PushNotificationService } = require('./push');
        const account = await db('accounts').where('id', order.account_id).first();
        const client = account ? await db('clients').where('id', account.client_id).first() : null;
        const userId = client?.user_id;

        if (userId) {
          const total = (fillQuantity * fillPrice).toFixed(2);
          // Push notification
          PushNotificationService.sendToUser(userId, 'orderFilled', {
            symbol: order.symbol, side: order.side, quantity: fillQuantity,
            price: fillPrice.toFixed(2), total, orderId: order.order_ref,
          }).catch(() => {});

          // WebSocket notification
          if (global.wsServer) {
            global.wsServer.sendOrderUpdate(userId, {
              orderId: order.order_ref, symbol: order.symbol,
              side: order.side, status: newStatus,
              fillQuantity, fillPrice: newAvgPrice,
              filledQuantity: newFilledQty, totalQuantity: order.quantity,
            });
          }
        }
      } catch (notifErr) {
        logger.warn('Fill notification failed (non-critical)', { error: notifErr.message });
      }

      AuditService.log({
        action: `Order fill — ${order.order_ref}: ${fillQuantity} @ ${fillPrice}`,
        resourceType: 'order',
        resourceId: order.order_ref,
        level: 'success',
        newValues: { fillQuantity, fillPrice, newStatus },
      });
    } catch (err) {
      await trx.rollback();
      logger.error('Fill processing failed', { brokerOrderId, error: err.message });
      throw err;
    }
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------
  static _routeToBroker(instrument) {
    // Custom instruments with internal clearing go to matching engine
    if (instrument.clearing_method === 'internal' || instrument.clearing_method === 'self_clearing') {
      return 'internal';
    }
    // Routing logic: US equities → DriveWealth, everything else → Saxo
    if (['equity', 'etf'].includes(instrument.asset_class) &&
        ['NASDAQ', 'NYSE', 'AMEX'].includes(instrument.exchange)) {
      return 'drivewealth';
    }
    return 'saxo';
  }

  static _saxoAssetType(assetClass) {
    const map = {
      equity: 'Stock', etf: 'Stock', forex: 'FxSpot',
      option: 'StockOption', bond: 'Bond', future: 'CfdOnFutures',
      crypto: 'FxSpot',
    };
    return map[assetClass] || 'Stock';
  }

  static async _preTradeCheck(trx, clientId, instrument, side, quantity, estimatedPrice) {
    const orderValue = quantity * estimatedPrice;

    // Check order value limits from platform settings
    const maxOrderValue = config.trading?.maxOrderValue || 1000000;
    const minOrderValue = config.trading?.minOrderValue || 1;
    if (orderValue > maxOrderValue) {
      throw new Error(`Order value $${orderValue.toFixed(2)} exceeds maximum allowed $${maxOrderValue.toLocaleString()}`);
    }
    if (orderValue < minOrderValue) {
      throw new Error(`Order value $${orderValue.toFixed(2)} below minimum $${minOrderValue}`);
    }

    if (side === 'buy') {
      const broker = this._routeToBroker(instrument);
      const account = await trx('accounts')
        .where('client_id', clientId)
        .where('broker', broker)
        .first();

      if (!account) throw new Error(`No ${broker} trading account found`);

      const requiredAmount = quantity * estimatedPrice;
      if (parseFloat(account.buying_power) < requiredAmount) {
        throw new Error(`Insufficient buying power. Required: $${requiredAmount.toFixed(2)}, Available: $${parseFloat(account.buying_power).toFixed(2)}`);
      }
    }

    // Check quantity meets minimum
    if (quantity < parseFloat(instrument.min_quantity || 0)) {
      throw new Error(`Minimum quantity for ${instrument.symbol} is ${instrument.min_quantity}`);
    }
  }

  static async _updatePosition(trx, order, fillQuantity, fillPrice, broker) {
    const openingSide = order.side === 'buy' ? 'long' : 'short';
    const closingSide = order.side === 'buy' ? 'short' : 'long';

    // 1. Check if this fill closes an existing opposite-side position
    const closingPosition = await trx('positions')
      .where('client_id', order.client_id)
      .where('instrument_id', order.instrument_id)
      .where('side', closingSide)
      .where('broker', broker)
      .whereNull('closed_at')
      .first();

    let remainingFillQty = fillQuantity;

    if (closingPosition) {
      const posQty = parseFloat(closingPosition.quantity);

      if (remainingFillQty >= posQty) {
        // Fully close the opposite position
        const realizedPnl = closingSide === 'long'
          ? (fillPrice - parseFloat(closingPosition.avg_cost)) * posQty
          : (parseFloat(closingPosition.avg_cost) - fillPrice) * posQty;

        await trx('positions').where('id', closingPosition.id).update({
          quantity: 0,
          realized_pnl: parseFloat(closingPosition.realized_pnl) + realizedPnl,
          closed_at: new Date(),
        });
        remainingFillQty -= posQty;
      } else {
        // Partially close the opposite position
        const realizedPnl = closingSide === 'long'
          ? (fillPrice - parseFloat(closingPosition.avg_cost)) * remainingFillQty
          : (parseFloat(closingPosition.avg_cost) - fillPrice) * remainingFillQty;

        await trx('positions').where('id', closingPosition.id).update({
          quantity: posQty - remainingFillQty,
          realized_pnl: parseFloat(closingPosition.realized_pnl) + realizedPnl,
        });
        remainingFillQty = 0;
      }
    }

    // 2. If there's remaining fill quantity, open/add to same-side position
    if (remainingFillQty > 0) {
      const openingPosition = await trx('positions')
        .where('client_id', order.client_id)
        .where('instrument_id', order.instrument_id)
        .where('side', openingSide)
        .where('broker', broker)
        .whereNull('closed_at')
        .first();

      if (openingPosition) {
        const existingQty = parseFloat(openingPosition.quantity);
        const newQty = existingQty + remainingFillQty;
        const newAvg = (parseFloat(openingPosition.avg_cost) * existingQty + fillPrice * remainingFillQty) / newQty;

        await trx('positions').where('id', openingPosition.id).update({
          quantity: newQty,
          avg_cost: newAvg,
        });
      } else {
        await trx('positions').insert({
          client_id: order.client_id,
          instrument_id: order.instrument_id,
          partner_id: order.partner_id,
          side: openingSide,
          quantity: remainingFillQty,
          avg_cost: fillPrice,
          broker,
        });
      }
    }
  }

  static async _updateAccountBalance(trx, order, fillQuantity, fillPrice, broker) {
    const totalCost = fillQuantity * fillPrice;

    if (order.side === 'buy') {
      await trx('accounts')
        .where('client_id', order.client_id)
        .where('broker', broker)
        .decrement('cash_balance', totalCost)
        .decrement('reserved_balance', totalCost);
    } else {
      await trx('accounts')
        .where('client_id', order.client_id)
        .where('broker', broker)
        .increment('cash_balance', totalCost);
    }
  }
}

module.exports = OrderService;
