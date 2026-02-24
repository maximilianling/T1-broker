// ================================================================
// T1 BROKER — ADMIN SETTINGS API ROUTES
// CRUD for platform_settings, bulk update, audit log
// ================================================================
const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation');
const settings = require('../services/platformSettings');

router.use(authenticate);
router.use(authorize('super_admin', 'admin', 'operations'));

// GET /admin/settings — All settings (grouped by category)
router.get('/', async (req, res) => {
  try {
    const all = await settings.listAll();

    // Group by category
    const grouped = {};
    for (const s of all) {
      if (!grouped[s.category]) grouped[s.category] = [];
      grouped[s.category].push(s);
    }

    res.json({ data: all, grouped });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// GET /admin/settings/values — Flat key-value map (for services)
router.get('/values', async (req, res) => {
  try {
    res.json(await settings.getAll());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// GET /admin/settings/category/:category — Settings for one category
router.get('/category/:category', async (req, res) => {
  try {
    const all = await settings.listAll();
    const filtered = all.filter(s => s.category === req.params.category);
    res.json({ data: filtered });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /admin/settings/:key — Update single setting
router.put('/:key',
  authorize('super_admin', 'admin'),
  validate(schemas.updateSetting),
  async (req, res) => {
    try {
      const { value, reason } = req.body;
      if (value === undefined) return res.status(400).json({ error: 'value is required' });

      const result = await settings.set(req.params.key, value, {
        userId: req.user.id,
        ipAddress: req.ip,
        reason,
      });

      res.json({
        success: true,
        ...result,
        message: result.requiresRestart
          ? 'Setting updated. Server restart required for this change to take effect.'
          : 'Setting updated successfully.',
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// PUT /admin/settings — Bulk update
router.put('/',
  authorize('super_admin', 'admin'),
  validate(schemas.bulkUpdateSettings),
  async (req, res) => {
    try {
      const { updates, reason } = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'updates object required' });
      }

      const results = await settings.setMany(updates, {
        userId: req.user.id,
        ipAddress: req.ip,
        reason,
      });

      const errors = results.filter(r => r.error);
      res.json({
        success: errors.length === 0,
        updated: results.filter(r => !r.error).length,
        errors,
        requiresRestart: results.some(r => r.requiresRestart),
      });
    } catch (err) {
      res.status(500).json({ error: 'Bulk update failed' });
    }
  }
);

// POST /admin/settings/:key/reset — Reset to default
router.post('/:key/reset',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const result = await settings.reset(req.params.key, {
        userId: req.user.id,
        ipAddress: req.ip,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// GET /admin/settings/audit — Change history
router.get('/audit', async (req, res) => {
  try {
    const { key, limit = 100 } = req.query;
    const log = await settings.getAuditLog(key || null, parseInt(limit));
    res.json({ data: log });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = router;
