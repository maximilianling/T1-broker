// ================================================================
// T1 BROKER — MARGIN ENGINE
// Real-time margin calculation, margin calls, auto-liquidation
// ================================================================
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const { emailService, NotificationService } = require('./notifications');
const settings = require('./platformSettings');

class MarginEngine {
  /**
   * Load margin settings from DB (cached), with static config fallback
   */
  static async _marginSettings() {
    return {
      maintenanceRatio: await settings.getNumber('margin.maintenance_ratio', config.margin.maintenanceRatio),
      initialRatio: await settings.getNumber('margin.initial_ratio', config.margin.initialRatio),
      callDeadlineHours: await settings.getNumber('margin.call_deadline_hours', config.margin.callDeadlineHours),
      autoLiquidate: await settings.getBool('margin.auto_liquidate', config.margin.autoLiquidate),
      liquidationThreshold: await settings.getNumber('margin.liquidation_threshold', 0.75),
    };
  }

  /**
   * Calculate margin requirements for a client
   */
  static async calculateMargin(clientId) {
    const positions = await db('positions as p')
      .join('instruments as i', 'i.id', 'p.instrument_id')
      .where('p.client_id', clientId)
      .whereNull('p.closed_at')
      .select('p.*', 'i.last_price', 'i.symbol', 'i.asset_class');

    const accounts = await db('accounts')
      .where('client_id', clientId);

    const totalCash = accounts.reduce((sum, a) => sum + parseFloat(a.cash_balance), 0);

    let totalPositionValue = 0;
    let totalMarginRequired = 0;
    const positionDetails = [];

    for (const pos of positions) {
      const marketPrice = parseFloat(pos.last_price || pos.avg_cost);
      const qty = parseFloat(pos.quantity);
      const marketValue = qty * marketPrice;
      const marginRate = await this._getMarginRate(pos.asset_class, pos.side);
      const marginRequired = marketValue * marginRate;

      totalPositionValue += marketValue;
      totalMarginRequired += marginRequired;

      positionDetails.push({
        symbol: pos.symbol,
        side: pos.side,
        quantity: qty,
        marketValue: Math.round(marketValue * 100) / 100,
        marginRate,
        marginRequired: Math.round(marginRequired * 100) / 100,
      });
    }

    const equity = totalCash + totalPositionValue;
    const ms = await this._marginSettings();
    const maintenanceMargin = totalPositionValue * ms.maintenanceRatio;
    const excessMargin = equity - totalMarginRequired;
    const marginUtilization = totalMarginRequired > 0 ? (totalMarginRequired / equity) * 100 : 0;
    const marginLevel = totalMarginRequired > 0 ? (equity / totalMarginRequired) * 100 : Infinity;

    return {
      clientId,
      equity: Math.round(equity * 100) / 100,
      cashBalance: Math.round(totalCash * 100) / 100,
      positionsValue: Math.round(totalPositionValue * 100) / 100,
      totalMarginRequired: Math.round(totalMarginRequired * 100) / 100,
      maintenanceMargin: Math.round(maintenanceMargin * 100) / 100,
      excessMargin: Math.round(excessMargin * 100) / 100,
      marginUtilization: Math.round(marginUtilization * 100) / 100,
      marginLevel: Math.round(marginLevel * 100) / 100,
      positions: positionDetails,
      inMarginCall: equity < maintenanceMargin,
      belowLiquidation: equity < maintenanceMargin * ms.liquidationThreshold,
    };
  }

  /**
   * Pre-trade margin check — can the client afford this order?
   */
  static async preTradeCheck(clientId, instrumentId, side, quantity, estimatedPrice) {
    const instrument = await db('instruments').where('id', instrumentId).first();
    if (!instrument) throw new Error('Instrument not found');

    const client = await db('clients').where('id', clientId).first();
    const marginEnabled = client.margin_enabled;

    const price = estimatedPrice || parseFloat(instrument.last_price);
    const orderValue = quantity * price;
    const marginRate = marginEnabled
      ? await this._getMarginRate(instrument.asset_class, side === 'buy' ? 'long' : 'short')
      : 1.0; // No margin = 100% required

    const requiredMargin = orderValue * marginRate;

    // Get current buying power
    const accounts = await db('accounts').where('client_id', clientId);
    const totalBuyingPower = accounts.reduce((sum, a) => sum + parseFloat(a.buying_power), 0);

    // Get current margin usage
    const currentMargin = await this.calculateMargin(clientId);

    const available = totalBuyingPower - currentMargin.totalMarginRequired;

    return {
      approved: available >= requiredMargin,
      orderValue: Math.round(orderValue * 100) / 100,
      requiredMargin: Math.round(requiredMargin * 100) / 100,
      availableMargin: Math.round(available * 100) / 100,
      marginRate,
      marginEnabled,
      reason: available < requiredMargin
        ? `Insufficient margin. Required: $${requiredMargin.toFixed(2)}, Available: $${available.toFixed(2)}`
        : null,
    };
  }

  /**
   * Run margin check across all clients — called periodically
   */
  static async runMarginSweep() {
    logger.info('Starting margin sweep');
    const ms = await this._marginSettings();

    const marginClients = await db('clients')
      .where('margin_enabled', true)
      .where('status', 'active');

    let callsIssued = 0;
    let liquidations = 0;

    for (const client of marginClients) {
      try {
        const margin = await this.calculateMargin(client.id);

        if (margin.belowLiquidation && ms.autoLiquidate) {
          await this._autoLiquidate(client, margin);
          liquidations++;
        } else if (margin.inMarginCall) {
          await this._issueMarginCall(client, margin);
          callsIssued++;
        }
      } catch (err) {
        logger.error('Margin check failed for client', {
          clientId: client.id,
          error: err.message,
        });
      }
    }

    logger.info('Margin sweep complete', {
      clientsChecked: marginClients.length,
      callsIssued,
      liquidations,
    });

    return { checked: marginClients.length, callsIssued, liquidations };
  }

  /**
   * Issue a margin call notification
   */
  static async _issueMarginCall(client, margin) {
    const user = await db('users').where('id', client.user_id).first();
    const ms = await this._marginSettings();
    const deadline = new Date(Date.now() + ms.callDeadlineHours * 3600000);

    // Check if we already sent a call today
    const existingCall = await db('notifications')
      .where('user_id', client.user_id)
      .where('title', 'ilike', '%margin call%')
      .where('created_at', '>=', new Date(Date.now() - 24 * 3600000))
      .first();

    if (existingCall) return; // Don't spam

    await NotificationService.create({
      userId: client.user_id,
      title: '⚠️ Margin Call',
      message: `Your equity ($${margin.equity.toLocaleString()}) is below maintenance margin ($${margin.maintenanceMargin.toLocaleString()}). Deposit funds or close positions by ${deadline.toLocaleString()}.`,
      type: 'error',
      link: '/portfolio',
    });

    await emailService.send({
      to: user.email,
      subject: emailService.getSubject('marginCall', {}),
      template: 'marginCall',
      data: {
        name: client.first_name,
        requiredMargin: margin.maintenanceMargin.toLocaleString(),
        currentEquity: margin.equity.toLocaleString(),
        deadline: deadline.toLocaleString(),
      },
      priority: 'high',
    });

    AuditService.log({
      userId: client.user_id,
      action: `Margin call issued: equity $${margin.equity} < maintenance $${margin.maintenanceMargin}`,
      resourceType: 'margin',
      resourceId: client.id,
      level: 'critical',
      metadata: { margin },
    });
  }

  /**
   * Auto-liquidate positions to restore margin
   */
  static async _autoLiquidate(client, margin) {
    logger.warn('Auto-liquidation triggered', {
      clientId: client.id,
      equity: margin.equity,
      maintenanceMargin: margin.maintenanceMargin,
    });

    // Sort positions by unrealized loss (liquidate worst first)
    const positions = await db('positions as p')
      .join('instruments as i', 'i.id', 'p.instrument_id')
      .where('p.client_id', client.id)
      .whereNull('p.closed_at')
      .select('p.*', 'i.last_price', 'i.symbol', 'i.dw_instrument_id', 'i.saxo_uic', 'i.asset_class')
      .orderByRaw(`(CASE WHEN p.side = 'long' THEN i.last_price - p.avg_cost ELSE p.avg_cost - i.last_price END) ASC`);

    const OrderService = require('./orders');
    let liquidated = 0;

    for (const pos of positions) {
      // Close position with market order
      try {
        await OrderService.placeOrder({
          clientId: client.id,
          userId: client.user_id,
          instrumentId: pos.instrument_id,
          side: pos.side === 'long' ? 'sell' : 'buy',
          orderType: 'market',
          quantity: parseFloat(pos.quantity),
          ipAddress: '0.0.0.0',
        });
        liquidated++;
      } catch (err) {
        logger.error('Auto-liquidation order failed', {
          clientId: client.id,
          symbol: pos.symbol,
          error: err.message,
        });
      }

      // Recalculate margin after each liquidation
      const updated = await this.calculateMargin(client.id);
      if (!updated.belowLiquidation) break; // Restored
    }

    AuditService.log({
      action: `Auto-liquidation: ${liquidated} positions closed for client ${client.id}`,
      resourceType: 'margin',
      resourceId: client.id,
      level: 'critical',
      metadata: { positionsLiquidated: liquidated, preMargin: margin },
    });

    // Notify client
    const user = await db('users').where('id', client.user_id).first();
    await emailService.send({
      to: user.email,
      subject: '⚠️ Positions Liquidated — Margin Call',
      template: 'marginCall',
      data: {
        requiredMargin: margin.maintenanceMargin.toLocaleString(),
        currentEquity: margin.equity.toLocaleString(),
        deadline: 'Positions have been liquidated to restore margin.',
      },
      priority: 'high',
    });
  }

  // ----------------------------------------------------------------
  // Margin rates by asset class and side
  // ----------------------------------------------------------------
  static async _getMarginRate(assetClass, side) {
    const rates = {
      equity:  { long: 0.50, short: 0.50 },
      etf:     { long: 0.50, short: 0.50 },
      forex:   { long: 0.02, short: 0.02 },  // 50:1 leverage
      crypto:  { long: 0.50, short: 0.50 },
      option:  { long: 1.00, short: 0.50 },
      bond:    { long: 0.10, short: 0.10 },
      future:  { long: 0.10, short: 0.10 },
    };
    const ms = await this._marginSettings();
    return rates[assetClass]?.[side] || ms.initialRatio;
  }
}

module.exports = MarginEngine;
