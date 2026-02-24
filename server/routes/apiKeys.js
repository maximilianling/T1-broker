// ================================================================
// T1 BROKER — API KEY ROUTES
// Clients manage their API keys for programmatic trading access.
// Mounted at /api/v1/api-keys
// ================================================================
const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { requireKYC } = require('../middleware/kycGate');
const APIKeyService = require('../services/apiKeys');
const AuditService = require('../utils/audit');
const logger = require('../utils/logger');

// All routes require authentication (JWT login — not API key)
router.use(authenticate);

// ----------------------------------------------------------------
// POST /api-keys — Create a new API key
// Requires KYC approval (same as trading)
// ----------------------------------------------------------------
router.post('/', requireKYC, async (req, res) => {
  try {
    const { label, permissions, ipWhitelist, expiresInDays } = req.body;

    // Validate permissions
    const validPerms = ['read', 'trade', 'transfer', 'withdraw'];
    if (permissions && !permissions.every(p => validPerms.includes(p))) {
      return res.status(400).json({
        error: 'Invalid permissions. Allowed: read, trade, transfer, withdraw',
        code: 'INVALID_PERMISSIONS',
      });
    }

    // Validate IP whitelist format
    if (ipWhitelist && !Array.isArray(ipWhitelist)) {
      return res.status(400).json({ error: 'ipWhitelist must be an array of IP addresses' });
    }

    const result = await APIKeyService.createKey(req.user.id, {
      label: label || 'API Key',
      permissions: permissions || ['read', 'trade'],
      ipWhitelist: ipWhitelist || [],
      expiresInDays: expiresInDays || 365,
    });

    res.status(201).json({
      message: 'API key created. Save this key — it will not be shown again.',
      ...result,
    });
  } catch (err) {
    logger.error('Create API key failed', { error: err.message, userId: req.user.id });
    const status = err.message.includes('Maximum') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api-keys — List all API keys for the authenticated user
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const keys = await APIKeyService.listKeys(req.user.id);
    res.json({ data: keys, count: keys.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// ----------------------------------------------------------------
// PATCH /api-keys/:id — Update API key settings
// ----------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const { label, permissions, ipWhitelist } = req.body;
    await APIKeyService.updateKey(req.user.id, req.params.id, {
      label, permissions, ipWhitelist,
    });
    res.json({ success: true, message: 'API key updated' });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// DELETE /api-keys/:id — Revoke an API key
// ----------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    await APIKeyService.revokeKey(req.user.id, req.params.id);
    res.json({ success: true, message: 'API key revoked' });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// Admin: DELETE /api-keys/admin/user/:userId — Revoke all keys for a user
// ----------------------------------------------------------------
router.delete('/admin/user/:userId',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const result = await APIKeyService.revokeAllKeys(req.params.userId, req.user.id);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: 'Failed to revoke API keys' });
    }
  }
);

module.exports = router;
