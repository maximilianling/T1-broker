// ================================================================
// T1 BROKER — ADMIN BACKUP API ROUTES
// Manual triggers, listing, verification, download, deletion
// ================================================================
const router = require('express').Router();
const { validate, schemas } = require('../middleware/validation');
const path = require('path');
const fs = require('fs');
const { authenticate, authorize } = require('../middleware/auth');
const DatabaseBackupService = require('../services/databaseBackup');

router.use(authenticate);
router.use(authorize('super_admin', 'admin'));

// GET /admin/backups — List all backups
router.get('/', async (req, res) => {
  try {
    const { limit = 50, status, trigger_type } = req.query;
    const backups = await DatabaseBackupService.listBackups({
      limit: parseInt(limit),
      status: status || null,
      triggerType: trigger_type || null,
    });
    res.json({ data: backups });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// GET /admin/backups/stats — Backup statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await DatabaseBackupService.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get backup stats' });
  }
});

// POST /admin/backups — Create manual backup
router.post('/',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const { notes } = req.body;
      const result = await DatabaseBackupService.createBackup({
        triggerType: 'manual',
        triggeredBy: req.user.id,
        ipAddress: req.ip,
        notes: notes || `Manual backup by ${req.user.email}`,
      });
      res.json({ success: true, backup: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /admin/backups/:id/verify — Verify backup integrity
router.post('/:id/verify', async (req, res) => {
  try {
    const result = await DatabaseBackupService.verifyBackup(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /admin/backups/:id/download — Download backup file
router.get('/:id/download',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const backup = await DatabaseBackupService.getBackup(req.params.id);
      if (!backup) return res.status(404).json({ error: 'Backup not found' });
      if (!fs.existsSync(backup.filepath)) {
        return res.status(404).json({ error: 'Backup file not found on disk' });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${backup.filename}"`);
      res.setHeader('Content-Type', 'application/gzip');
      fs.createReadStream(backup.filepath).pipe(res);
    } catch (err) {
      res.status(500).json({ error: 'Download failed' });
    }
  }
);

// DELETE /admin/backups/:id — Delete a backup
router.delete('/:id',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const result = await DatabaseBackupService.deleteBackup(req.params.id, {
        userId: req.user.id,
        ipAddress: req.ip,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// POST /admin/backups/cleanup — Run retention cleanup manually
router.post('/cleanup',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const result = await DatabaseBackupService.cleanupOldBackups();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: 'Cleanup failed' });
    }
  }
);

module.exports = router;
