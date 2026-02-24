// ================================================================
// T1 BROKER — DOCUMENT ROUTES (KYC file upload/review)
// ================================================================
const documentRouter = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const { limiters } = require('../middleware/rateLimiter');
const { upload, DocumentService } = require('../services/documents');
const db = require('../config/database');

documentRouter.use(authenticate);

// POST /documents/upload — Client uploads KYC document
documentRouter.post('/upload',
  limiters.uploads,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const client = await db('clients').where('user_id', req.user.id).first();
    if (!client) return res.status(404).json({ error: 'Client profile not found' });

    const doc = await DocumentService.uploadDocument({
      clientId: client.id,
      documentType: req.body.documentType || 'other',
      file: req.file,
      uploadedBy: req.user.id,
      ipAddress: req.ip,
    });

    if (doc.duplicate) {
      return res.status(409).json({ error: 'This document was already uploaded', existingId: doc.existingId });
    }

    res.status(201).json(doc);
  })
);

// POST /documents/upload/:clientId — Admin uploads on behalf of client
documentRouter.post('/upload/:clientId',
  authorize('super_admin', 'admin', 'compliance', 'operations'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const doc = await DocumentService.uploadDocument({
      clientId: req.params.clientId,
      documentType: req.body.documentType || 'other',
      file: req.file,
      uploadedBy: req.user.id,
      ipAddress: req.ip,
    });

    res.status(201).json(doc);
  })
);

// GET /documents — List client's own documents
documentRouter.get('/', asyncHandler(async (req, res) => {
  const client = await db('clients').where('user_id', req.user.id).first();
  if (!client) return res.status(404).json({ error: 'Client profile not found' });
  const docs = await DocumentService.getClientDocuments(client.id);
  res.json({ data: docs });
}));

// GET /documents/client/:clientId — Admin views client documents
documentRouter.get('/client/:clientId',
  authorize('super_admin', 'admin', 'compliance', 'operations'),
  asyncHandler(async (req, res) => {
    const docs = await DocumentService.getClientDocuments(req.params.clientId);
    res.json({ data: docs });
  })
);

// POST /documents/:id/review — Approve or reject document
documentRouter.post('/:id/review',
  authorize('super_admin', 'admin', 'compliance'),
  asyncHandler(async (req, res) => {
    const { status, reviewNotes } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
    }

    const updated = await DocumentService.reviewDocument({
      documentId: req.params.id,
      status,
      reviewNotes,
      reviewedBy: req.user.id,
      ipAddress: req.ip,
    });

    res.json(updated);
  })
);

// GET /documents/:id/download — Download document
documentRouter.get('/:id/download',
  asyncHandler(async (req, res) => {
    const result = await DocumentService.getDownloadUrl(req.params.id);

    if (result.url) {
      res.json({ downloadUrl: result.url, expiresIn: result.expiresIn });
    } else if (result.local) {
      const fs = require('fs');
      if (!fs.existsSync(result.path)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }
      res.download(result.path);
    }
  })
);

// ================================================================
// T1 BROKER — PASSWORD RESET ROUTES
// ================================================================
const passwordRouter = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { validate, schemas } = require('../middleware/validation');
const { emailService } = require('../services/notifications');
const AuditService = require('../utils/audit');
const { hashToken } = require('../utils/encryption');
const logger = require('../utils/logger');

// POST /password/forgot — Request password reset
passwordRouter.post('/forgot', limiters.passwordReset, asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Always return success (don't leak if email exists)
  const user = await db('users').where('email', email.toLowerCase()).first();

  if (user && user.is_active) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetHash = hashToken(resetToken);
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    // Store reset token
    await db('user_sessions').insert({
      user_id: user.id,
      token_hash: resetHash,
      expires_at: expiresAt,
      ip_address: req.ip,
      user_agent: 'password-reset',
    });

    const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${resetToken}`;

    await emailService.send({
      to: user.email,
      subject: emailService.getSubject('passwordReset', {}),
      template: 'passwordReset',
      data: { resetUrl },
      priority: 'high',
    });

    AuditService.log({
      userId: user.id,
      userEmail: user.email,
      action: 'Password reset requested',
      resourceType: 'auth',
      level: 'info',
      ipAddress: req.ip,
    });
  }

  res.json({ message: 'If that email exists, a reset link has been sent.' });
}));

// POST /password/reset — Complete password reset
passwordRouter.post('/reset', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });

  // Validate password strength
  const { error } = schemas.changePassword.validate({
    currentPassword: 'placeholder',
    newPassword,
  });
  if (error) return res.status(400).json({ error: error.details[0].message });

  const resetHash = hashToken(token);
  const session = await db('user_sessions')
    .where('token_hash', resetHash)
    .where('user_agent', 'password-reset')
    .where('expires_at', '>', new Date())
    .whereNull('revoked_at')
    .first();

  if (!session) {
    return res.status(400).json({ error: 'Invalid or expired reset token', code: 'INVALID_RESET_TOKEN' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  // Update password and invalidate all sessions
  await db('users').where('id', session.user_id).update({
    password_hash: passwordHash,
    password_changed_at: new Date(),
    failed_login_attempts: 0,
    locked_until: null,
  });

  await db('user_sessions')
    .where('user_id', session.user_id)
    .whereNull('revoked_at')
    .update({ revoked_at: new Date() });

  AuditService.log({
    userId: session.user_id,
    action: 'Password reset completed — all sessions revoked',
    resourceType: 'auth',
    level: 'warning',
    ipAddress: req.ip,
  });

  // Send security alert email
  const user = await db('users').where('id', session.user_id).first();
  await emailService.send({
    to: user.email,
    subject: emailService.getSubject('securityAlert', { eventType: 'Password Changed' }),
    template: 'securityAlert',
    data: {
      eventType: 'Password Changed',
      ipAddress: req.ip,
      timestamp: new Date().toLocaleString(),
    },
    priority: 'high',
  });

  res.json({ message: 'Password reset successful. Please log in with your new password.' });
}));

// POST /password/change — Authenticated password change
passwordRouter.post('/change', authenticate, validate(schemas.changePassword), asyncHandler(async (req, res) => {
  const user = await db('users').where('id', req.user.id).first();

  const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  await db('users').where('id', req.user.id).update({
    password_hash: passwordHash,
    password_changed_at: new Date(),
  });

  AuditService.log({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'Password changed',
    resourceType: 'auth',
    level: 'success',
    ipAddress: req.ip,
  });

  res.json({ message: 'Password changed successfully' });
}));

// ================================================================
// T1 BROKER — NOTIFICATION ROUTES
// ================================================================
const notificationRouter = require('express').Router();
const { NotificationService } = require('../services/notifications');

notificationRouter.use(authenticate);

notificationRouter.get('/', asyncHandler(async (req, res) => {
  const notifications = await NotificationService.getUnread(req.user.id, parseInt(req.query.limit || 20));
  const count = await NotificationService.getCount(req.user.id);
  res.json({ data: notifications, unreadCount: count });
}));

notificationRouter.post('/:id/read', asyncHandler(async (req, res) => {
  await NotificationService.markRead(req.user.id, req.params.id);
  res.json({ message: 'Marked as read' });
}));

notificationRouter.post('/read-all', asyncHandler(async (req, res) => {
  await NotificationService.markAllRead(req.user.id);
  res.json({ message: 'All notifications marked as read' });
}));

// ================================================================
// T1 BROKER — MONITORING / HEALTH ENDPOINTS
// ================================================================
const monitorRouter = require('express').Router();
const redis = require('../utils/redis');
const { breakers } = require('../utils/resilience');

// Public health check
monitorRouter.get('/health', async (req, res) => {
  const checks = {};

  // Database
  try {
    await db.raw('SELECT 1');
    checks.database = { status: 'healthy', latency: null };
    const start = Date.now();
    await db.raw('SELECT 1');
    checks.database.latency = Date.now() - start;
  } catch (e) {
    checks.database = { status: 'unhealthy', error: e.message };
  }

  // Redis
  try {
    const start = Date.now();
    await redis.client?.ping();
    checks.redis = { status: 'healthy', latency: Date.now() - start };
  } catch (e) {
    checks.redis = { status: 'degraded', error: 'Redis unavailable' };
  }

  // Circuit breakers
  checks.brokers = {
    saxo: breakers.saxo.getStatus(),
    drivewealth: breakers.drivewealth.getStatus(),
  };

  const allHealthy = checks.database.status === 'healthy';
  const overallStatus = allHealthy ? 'healthy' : 'unhealthy';

  res.status(allHealthy ? 200 : 503).json({
    status: overallStatus,
    version: require('../../package.json').version,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: require('../config').env,
    checks,
  });
});

// Detailed metrics (authenticated, admin only)
monitorRouter.get('/metrics',
  authenticate,
  authorize('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const cached = await redis.get('metrics:latest');
    const mem = process.memoryUsage();

    const [
      { count: totalUsers },
      { count: activeClients },
      { count: todayOrders },
      { count: openOrders },
    ] = await Promise.all([
      db('users').count().first(),
      db('clients').where('status', 'active').count().first(),
      db('orders').where('created_at', '>=', new Date().toISOString().slice(0, 10)).count().first(),
      db('orders').whereIn('status', ['pending', 'submitted', 'working']).count().first(),
    ]);

    const jobScheduler = require('../jobs/scheduler');

    res.json({
      system: {
        uptime: Math.round(process.uptime()),
        memory: {
          rss: Math.round(mem.rss / 1048576),
          heapUsed: Math.round(mem.heapUsed / 1048576),
          heapTotal: Math.round(mem.heapTotal / 1048576),
          external: Math.round(mem.external / 1048576),
        },
        pid: process.pid,
        nodeVersion: process.version,
      },
      database: {
        totalUsers: parseInt(totalUsers),
        activeClients: parseInt(activeClients),
        todayOrders: parseInt(todayOrders),
        openOrders: parseInt(openOrders),
      },
      brokers: {
        saxo: breakers.saxo.getStatus(),
        drivewealth: breakers.drivewealth.getStatus(),
      },
      websocket: global.wsServer?.getStats() || {},
      jobs: jobScheduler.getStatus(),
      cached,
    });
  })
);

// Readiness probe (for Kubernetes)
monitorRouter.get('/ready', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});

// Liveness probe
monitorRouter.get('/live', (req, res) => {
  res.json({ alive: true, uptime: process.uptime() });
});

// Prometheus metrics endpoint
monitorRouter.get('/metrics/prometheus',
  authenticate,
  authorize('super_admin', 'admin'),
  async (req, res) => {
    const { register } = require('../utils/metrics');
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end('Error collecting metrics');
    }
  }
);

// JSON metrics endpoint
monitorRouter.get('/metrics/json',
  authenticate,
  authorize('super_admin', 'admin'),
  async (req, res) => {
    const { register } = require('../utils/metrics');
    try {
      const metricsJson = await register.getMetricsAsJSON();
      res.json({
        metrics: metricsJson,
        process: {
          uptime: Math.round(process.uptime()),
          memory: {
            rss: Math.round(process.memoryUsage().rss / 1048576),
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1048576),
          },
          pid: process.pid,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Error collecting metrics' });
    }
  }
);

module.exports = { documentRouter, passwordRouter, notificationRouter, monitorRouter };
