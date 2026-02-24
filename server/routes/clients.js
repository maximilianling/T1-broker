// ================================================================
// T1 BROKER — CLIENT MANAGEMENT ROUTES
// ================================================================
const router = require('express').Router();
const db = require('../config/database');
const { authenticate, authorize, partnerScope } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation');
const { encrypt, decrypt } = require('../utils/encryption');
const AuditService = require('../utils/audit');
const logger = require('../utils/logger');

router.use(authenticate);

// ----------------------------------------------------------------
// GET /clients — List clients (admin/partner only)
// ----------------------------------------------------------------
router.get('/',
  authorize('super_admin', 'admin', 'compliance', 'operations', 'relationship_manager', 'partner_admin'),
  partnerScope,
  async (req, res) => {
    try {
      const { page = 1, limit = 50, status, kycStatus, riskLevel, clientType, search, country } = req.query;
      const offset = (page - 1) * limit;

      let query = db('clients as c')
        .join('users as u', 'u.id', 'c.user_id')
        .leftJoin('partners as p', 'p.id', 'c.partner_id')
        .select(
          'c.*', 'u.email', 'u.last_login_at', 'u.mfa_enabled',
          'p.name as partner_name'
        );

      if (req.partnerScope) {
        query = query.where('c.partner_id', req.partnerId);
      }
      if (status) query = query.where('c.status', status);
      if (kycStatus) query = query.where('c.kyc_status', kycStatus);
      if (riskLevel) query = query.where('c.risk_level', riskLevel);
      if (clientType) query = query.where('c.client_type', clientType);
      if (country) query = query.where('c.country_of_residence', country.toUpperCase());
      if (search) {
        query = query.where(function () {
          this.where('c.first_name', 'ilike', `%${search}%`)
            .orWhere('c.last_name', 'ilike', `%${search}%`)
            .orWhere('u.email', 'ilike', `%${search}%`)
            .orWhere('c.account_number', 'ilike', `%${search}%`);
        });
      }

      const [{ count }] = await query.clone().count();

      // Enrich with AUM calculation
      const clients = await query
        .orderBy('c.created_at', 'desc')
        .limit(limit)
        .offset(offset);

      // Batch-fetch account balances
      const clientIds = clients.map(c => c.id);
      const balances = await db('accounts')
        .whereIn('client_id', clientIds)
        .select('client_id')
        .sum('cash_balance as total_cash')
        .groupBy('client_id');

      const balanceMap = Object.fromEntries(balances.map(b => [b.client_id, parseFloat(b.total_cash)]));

      const enriched = clients.map(c => ({
        ...c,
        cashBalance: balanceMap[c.id] || 0,
        phone: c.phone ? (() => { const d = decrypt(c.phone); return d ? '••••' + d.slice(-4) : null; })() : null, // Mask PII
      }));

      res.json({ data: enriched, total: parseInt(count), page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
      logger.error('Get clients failed', { error: err.message });
      res.status(500).json({ error: 'Failed to fetch clients' });
    }
  }
);

// ----------------------------------------------------------------
// GET /clients/me — Client gets own profile
// ----------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const client = await db('clients as c')
      .join('users as u', 'u.id', 'c.user_id')
      .where('c.user_id', req.user.id)
      .select('c.*', 'u.email', 'u.mfa_enabled')
      .first();

    if (!client) return res.status(404).json({ error: 'Client profile not found' });

    // Decrypt PII for own profile
    if (client.phone) client.phone = decrypt(client.phone);
    if (client.address_line1) client.address_line1 = decrypt(client.address_line1);
    if (client.tax_id) client.tax_id = decrypt(client.tax_id);

    // Get accounts
    const accounts = await db('accounts').where('client_id', client.id);
    client.accounts = accounts;

    res.json(client);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ----------------------------------------------------------------
// GET /clients/:id — Get single client (admin)
// ----------------------------------------------------------------
router.get('/:id',
  authorize('super_admin', 'admin', 'compliance', 'operations', 'relationship_manager', 'partner_admin'),
  async (req, res) => {
    try {
      const client = await db('clients as c')
        .join('users as u', 'u.id', 'c.user_id')
        .where('c.id', req.params.id)
        .select('c.*', 'u.email', 'u.last_login_at', 'u.mfa_enabled')
        .first();

      if (!client) return res.status(404).json({ error: 'Client not found' });

      // Get related data
      const [accounts, documents, positions, recentOrders] = await Promise.all([
        db('accounts').where('client_id', client.id),
        db('client_documents').where('client_id', client.id).orderBy('uploaded_at', 'desc'),
        db('positions as p')
          .join('instruments as i', 'i.id', 'p.instrument_id')
          .where('p.client_id', client.id)
          .whereNull('p.closed_at')
          .select('p.*', 'i.symbol', 'i.name as instrument_name', 'i.last_price'),
        db('orders as o')
          .join('instruments as i', 'i.id', 'o.instrument_id')
          .where('o.client_id', client.id)
          .orderBy('o.created_at', 'desc')
          .limit(10)
          .select('o.*', 'i.symbol'),
      ]);

      client.accounts = accounts;
      client.documents = documents;
      client.positions = positions;
      client.recentOrders = recentOrders;

      // Decrypt PII for admin view
      if (client.phone) client.phone = decrypt(client.phone);

      res.json(client);
    } catch (err) {
      logger.error('Get client detail failed', { error: err.message });
      res.status(500).json({ error: 'Failed to fetch client' });
    }
  }
);

// ----------------------------------------------------------------
// POST /clients — Create client (admin)
// ----------------------------------------------------------------
router.post('/',
  authorize('super_admin', 'admin', 'operations', 'partner_admin'),
  validate(schemas.createClient),
  async (req, res) => {
    const trx = await db.transaction();
    try {
      const bcrypt = require('bcryptjs');
      const tempPassword = require('crypto').randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const [user] = await trx('users').insert({
        email: req.body.email.toLowerCase(),
        password_hash: passwordHash,
        role: 'client',
      }).returning('*');

      const [client] = await trx('clients').insert({
        user_id: user.id,
        first_name: req.body.firstName,
        last_name: req.body.lastName,
        date_of_birth: req.body.dateOfBirth,
        nationality: req.body.nationality,
        country_of_residence: req.body.countryOfResidence,
        phone: req.body.phone ? encrypt(req.body.phone) : null,
        client_type: req.body.clientType,
        risk_level: req.body.riskLevel,
        partner_id: req.body.partnerId || (req.partnerScope ? req.partnerId : null),
        status: 'pending',
        kyc_status: 'not_started',
        base_currency: req.body.baseCurrency,
      }).returning('*');

      // Create default accounts (one per sub-broker)
      await trx('accounts').insert([
        { client_id: client.id, currency: req.body.baseCurrency || 'USD', broker: 'drivewealth' },
        { client_id: client.id, currency: req.body.baseCurrency || 'USD', broker: 'saxo' },
      ]);

      await trx.commit();

      AuditService.log({
        userId: req.user.id,
        action: `Client created: ${req.body.firstName} ${req.body.lastName}`,
        resourceType: 'client',
        resourceId: client.id,
        level: 'info',
        ipAddress: req.ip,
        newValues: { clientId: client.id, email: req.body.email, type: req.body.clientType },
      });

      res.status(201).json({ client, user: { id: user.id, email: user.email } });
    } catch (err) {
      await trx.rollback();
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Email already registered' });
      }
      logger.error('Create client failed', { error: err.message });
      res.status(500).json({ error: 'Failed to create client' });
    }
  }
);

// ----------------------------------------------------------------
// PATCH /clients/:id — Update client
// ----------------------------------------------------------------
router.patch('/:id',
  authorize('super_admin', 'admin', 'compliance', 'operations', 'relationship_manager'),
  validate(schemas.updateClient),
  async (req, res) => {
    try {
      const old = await db('clients').where('id', req.params.id).first();
      if (!old) return res.status(404).json({ error: 'Client not found' });

      const updates = {};
      if (req.body.firstName) updates.first_name = req.body.firstName;
      if (req.body.lastName) updates.last_name = req.body.lastName;
      if (req.body.phone) updates.phone = encrypt(req.body.phone);
      if (req.body.riskLevel) updates.risk_level = req.body.riskLevel;
      if (req.body.status) updates.status = req.body.status;
      if (req.body.notes) updates.notes = req.body.notes;

      if (req.body.kycStatus) {
        updates.kyc_status = req.body.kycStatus;
        if (req.body.kycStatus === 'approved') {
          updates.kyc_approved_at = new Date();
          updates.kyc_approved_by = req.user.id;
          updates.kyc_expiry_date = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
          // Activate account if KYC approved
          if (old.status === 'pending') updates.status = 'active';
        }
      }

      const [updated] = await db('clients').where('id', req.params.id).update(updates).returning('*');

      AuditService.log({
        userId: req.user.id,
        action: `Client updated: ${old.first_name} ${old.last_name}`,
        resourceType: 'client',
        resourceId: req.params.id,
        level: 'info',
        ipAddress: req.ip,
        oldValues: { status: old.status, kycStatus: old.kyc_status, riskLevel: old.risk_level },
        newValues: updates,
      });

      res.json(updated);
    } catch (err) {
      logger.error('Update client failed', { error: err.message });
      res.status(500).json({ error: 'Failed to update client' });
    }
  }
);

// ----------------------------------------------------------------
// POST /clients/:id/waive-kyc — Admin waives KYC for a client
// ----------------------------------------------------------------
router.post('/:id/waive-kyc',
  authorize('super_admin', 'admin', 'compliance'),
  async (req, res) => {
    try {
      const client = await db('clients').where('id', req.params.id).first();
      if (!client) return res.status(404).json({ error: 'Client not found' });

      await db('clients').where('id', req.params.id).update({
        kyc_waived: true,
        kyc_waived_by: req.user.id,
        kyc_waived_at: new Date(),
        status: 'active', // Activate account when KYC waived
      });

      AuditService.log({
        userId: req.user.id,
        action: `KYC waived for client ${client.first_name} ${client.last_name}`,
        resourceType: 'client', resourceId: req.params.id,
        level: 'warning', ipAddress: req.ip,
      });

      res.json({ success: true, message: 'KYC waived — trading enabled' });
    } catch (err) {
      logger.error('KYC waive failed', { error: err.message });
      res.status(500).json({ error: 'Failed to waive KYC' });
    }
  }
);

// ----------------------------------------------------------------
// POST /clients/:id/revoke-kyc-waiver — Remove KYC waiver
// ----------------------------------------------------------------
router.post('/:id/revoke-kyc-waiver',
  authorize('super_admin', 'admin', 'compliance'),
  async (req, res) => {
    try {
      await db('clients').where('id', req.params.id).update({
        kyc_waived: false,
        kyc_waived_by: null,
        kyc_waived_at: null,
      });

      AuditService.log({
        userId: req.user.id,
        action: `KYC waiver revoked for client ${req.params.id}`,
        resourceType: 'client', resourceId: req.params.id,
        level: 'warning', ipAddress: req.ip,
      });

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to revoke KYC waiver' });
    }
  }
);

// ----------------------------------------------------------------
// POST /clients/:id/disable-mfa — Admin disables MFA for a user
// ----------------------------------------------------------------
router.post('/:id/disable-mfa',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const client = await db('clients').where('id', req.params.id).first();
      if (!client) return res.status(404).json({ error: 'Client not found' });

      await db('users').where('id', client.user_id).update({
        mfa_enabled: false,
        mfa_method: null,
        totp_secret: null,
        mfa_email_enabled: false,
      });

      // Clear backup codes
      await db('mfa_backup_codes').where('user_id', client.user_id).del();

      AuditService.log({
        userId: req.user.id,
        action: `MFA disabled by admin for client ${client.first_name} ${client.last_name}`,
        resourceType: 'auth', resourceId: client.user_id,
        level: 'warning', ipAddress: req.ip,
      });

      res.json({ success: true, message: 'MFA disabled for user' });
    } catch (err) {
      logger.error('MFA disable failed', { error: err.message });
      res.status(500).json({ error: 'Failed to disable MFA' });
    }
  }
);

// ----------------------------------------------------------------
// POST /clients/:id/enable-mfa — Admin re-enables email MFA
// ----------------------------------------------------------------
router.post('/:id/enable-mfa',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const client = await db('clients').where('id', req.params.id).first();
      if (!client) return res.status(404).json({ error: 'Client not found' });

      await db('users').where('id', client.user_id).update({
        mfa_enabled: true,
        mfa_method: 'email',
        mfa_email_enabled: true,
      });

      // Generate new backup codes
      const MFAService = require('../services/mfa');
      await MFAService.generateBackupCodes(client.user_id);

      AuditService.log({
        userId: req.user.id,
        action: `MFA re-enabled by admin for client ${client.first_name} ${client.last_name}`,
        resourceType: 'auth', resourceId: client.user_id,
        level: 'info', ipAddress: req.ip,
      });

      res.json({ success: true, message: 'Email MFA enabled for user' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to enable MFA' });
    }
  }
);

module.exports = router;
