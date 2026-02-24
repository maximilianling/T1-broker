// ================================================================
// T1 BROKER — WEBSOCKET SERVER
// Real-time: market data, order updates, notifications
// ================================================================
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');
const marketDataEngine = require('./marketData');

class WSServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ server, path: '/ws' });
    this.clients = new Map(); // userId -> Set<ws>
    this.subscriptions = new Map(); // ws -> Set<channel>

    this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));

    // Start heartbeat
    setInterval(() => this._heartbeat(), 30000);

    // Wire market data engine — stream ticks to WS subscribers
    marketDataEngine.on('tick', (tick) => {
      const channel = `market:${tick.symbol}`;
      const payload = JSON.stringify({ type: 'market_data', symbol: tick.symbol, data: tick, ts: Date.now() });
      this.subscriptions.forEach((channels, ws) => {
        if ((channels.has(channel) || channels.has('market:*')) && ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      });
    });

    // Stream snapshots every 5s to wildcard subscribers
    marketDataEngine.on('snapshot', (prices) => {
      const payload = JSON.stringify({ type: 'market_snapshot', data: prices, ts: Date.now() });
      this.subscriptions.forEach((channels, ws) => {
        if (channels.has('market:*') && ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      });
    });

    // Start market data engine
    marketDataEngine.start();

    logger.info('WebSocket server initialized with live market data');
  }

  _handleConnection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => this._handleDisconnect(ws));
    ws.on('error', (err) => logger.error('WS error', { error: err.message }));

    ws.send(JSON.stringify({ type: 'connected', message: 'Authenticate with { type: "auth", token: "..." }' }));
  }

  _handleMessage(ws, msg) {
    switch (msg.type) {
      case 'auth':
        this._authenticate(ws, msg.token);
        break;
      case 'subscribe':
        this._subscribe(ws, msg.channels);
        break;
      case 'unsubscribe':
        this._unsubscribe(ws, msg.channels);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
    }
  }

  _authenticate(ws, token) {
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      ws.userId = decoded.userId;
      ws.role = decoded.role;
      ws.authenticated = true;

      if (!this.clients.has(decoded.userId)) {
        this.clients.set(decoded.userId, new Set());
      }
      this.clients.get(decoded.userId).add(ws);

      ws.send(JSON.stringify({ type: 'authenticated', userId: decoded.userId }));
      logger.debug('WS client authenticated', { userId: decoded.userId });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
    }
  }

  _subscribe(ws, channels) {
    if (!ws.authenticated) {
      return ws.send(JSON.stringify({ error: 'Not authenticated' }));
    }

    if (!this.subscriptions.has(ws)) {
      this.subscriptions.set(ws, new Set());
    }

    const subs = this.subscriptions.get(ws);
    (channels || []).forEach(ch => subs.add(ch));

    ws.send(JSON.stringify({
      type: 'subscribed',
      channels: Array.from(subs),
    }));
  }

  _unsubscribe(ws, channels) {
    const subs = this.subscriptions.get(ws);
    if (subs) {
      (channels || []).forEach(ch => subs.delete(ch));
    }
  }

  _handleDisconnect(ws) {
    if (ws.userId && this.clients.has(ws.userId)) {
      this.clients.get(ws.userId).delete(ws);
      if (this.clients.get(ws.userId).size === 0) {
        this.clients.delete(ws.userId);
      }
    }
    this.subscriptions.delete(ws);
  }

  _heartbeat() {
    this.wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }

  // ----------------------------------------------------------------
  // Public broadcast methods
  // ----------------------------------------------------------------

  /**
   * Send market data update to all subscribers
   */
  broadcastMarketData(symbol, data) {
    const channel = `market:${symbol}`;
    const payload = JSON.stringify({
      type: 'market_data',
      symbol,
      data,
      ts: Date.now(),
    });

    this.subscriptions.forEach((channels, ws) => {
      if (channels.has(channel) || channels.has('market:*')) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    });
  }

  /**
   * Send order update to specific user
   */
  sendOrderUpdate(userId, order) {
    const connections = this.clients.get(userId);
    if (!connections) return;

    const payload = JSON.stringify({
      type: 'order_update',
      data: order,
      ts: Date.now(),
    });

    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  }

  /**
   * Send notification to specific user
   */
  sendNotification(userId, notification) {
    const connections = this.clients.get(userId);
    if (!connections) return;

    const payload = JSON.stringify({
      type: 'notification',
      data: notification,
      ts: Date.now(),
    });

    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  }

  /**
   * Broadcast to all admin users (alerts, system events)
   */
  broadcastAdmin(event) {
    const payload = JSON.stringify({
      type: 'admin_event',
      data: event,
      ts: Date.now(),
    });

    this.subscriptions.forEach((channels, ws) => {
      if (channels.has('admin') && ws.authenticated &&
          ['super_admin', 'admin', 'compliance', 'operations'].includes(ws.role)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    });
  }

  /**
   * Get connection stats
   */
  getStats() {
    return {
      totalConnections: this.wss.clients.size,
      authenticatedUsers: this.clients.size,
      totalSubscriptions: Array.from(this.subscriptions.values())
        .reduce((sum, s) => sum + s.size, 0),
    };
  }
}

module.exports = WSServer;
