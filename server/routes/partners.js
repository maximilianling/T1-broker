// ================================================================
// T1 BROKER — PARTNER MANAGEMENT ROUTES
// Full partner lifecycle: onboard, manage, branding, portal
// ================================================================
const router = require('express').Router();
const db = require('../config/database');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticate, authorize, partnerScope } = require('../middleware/auth');
const WhiteLabelService = require('../services/whiteLabel');
const AuditService = require('../utils/audit');
const logger = require('../utils/logger');

router.use(authenticate);

// ================================================================
// ADMIN ROUTES (super_admin, admin only)
// ================================================================

// GET /partners — List all partners with stats
router.get('/',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const partners = await db('partners').orderBy('name');

      const enriched = await Promise.all(partners.map(async (p) => {
        const [{ count: clientCount }] = await db('clients').where('partner_id', p.id).count();
        const [{ sum: totalCash }] = await db('accounts')
          .join('clients', 'clients.id', 'accounts.client_id')
          .where('clients.partner_id', p.id)
          .sum('accounts.cash_balance as sum');

        const [{ count: orderCount }] = await db('orders')
          .where('partner_id', p.id)
          .where('created_at', '>=', db.raw("NOW() - INTERVAL '30 days'"))
          .count();

        return {
          ...p,
          clientCount: parseInt(clientCount),
          totalAum: parseFloat(totalCash || 0),
          orders30d: parseInt(orderCount),
          apiKeyPrefix: p.api_key_prefix || '—',
          branding: {
            brandName: p.brand_name || p.name,
            brandDomain: p.brand_domain,
            brandLogoUrl: p.brand_logo_url,
            theme: p.theme,
          },
        };
      }));

      res.json({ data: enriched });
    } catch (err) {
      logger.error('List partners failed', { error: err.message });
      res.status(500).json({ error: 'Failed to fetch partners' });
    }
  }
);

// POST /partners — Onboard new partner (full wizard)
router.post('/',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const apiKey = 'T1P_' + crypto.randomBytes(24).toString('hex');
      const apiSecret = crypto.randomBytes(32).toString('hex');

      const [partner] = await db('partners').insert({
        name: req.body.name,
        legal_name: req.body.legalName || req.body.name,
        region: req.body.region || null,
        country: req.body.country || 'US',
        api_key_hash: await bcrypt.hash(apiKey, 10),
        api_secret_hash: await bcrypt.hash(apiSecret, 10),
        api_key_prefix: apiKey.substring(0, 8),
        revenue_share_pct: req.body.revenueSharePct || 60,
        fee_structure: JSON.stringify(req.body.feeStructure || {}),
        contact_name: req.body.contactName,
        contact_email: req.body.contactEmail,
        contact_phone: req.body.contactPhone || null,
        webhook_url: req.body.webhookUrl || null,
        allowed_ips: req.body.allowedIps || null,
        api_rate_limit: req.body.apiRateLimit || 1000,
        brand_name: req.body.brandName || req.body.name,
        brand_logo_url: req.body.brandLogoUrl || null,
        brand_domain: req.body.brandDomain || null,
        brand_support_email: req.body.brandSupportEmail || req.body.contactEmail,
        theme: JSON.stringify(req.body.theme || {}),
        features: JSON.stringify(req.body.features || {
          equities: true, crypto: true, forex: false,
          options: false, privateMarkets: false,
          marginTrading: false, apiTrading: true, mobileApp: false,
        }),
        commission_overrides: JSON.stringify(req.body.commissionOverrides || {}),
        status: 'onboarding',
      }).returning('*');

      AuditService.log({
        userId: req.user.id,
        action: `Partner onboarded: ${req.body.name}`,
        resourceType: 'partner',
        resourceId: partner.id,
        level: 'info',
        ipAddress: req.ip,
      });

      res.status(201).json({
        partner,
        credentials: {
          apiKey,
          apiSecret,
          warning: 'Store these credentials securely. They cannot be retrieved again.',
        },
      });
    } catch (err) {
      logger.error('Partner onboard failed', { error: err.message });
      res.status(500).json({ error: 'Failed to onboard partner' });
    }
  }
);

// GET /partners/:id — Single partner details
router.get('/:id',
  authorize('super_admin', 'admin', 'partner_admin'),
  async (req, res) => {
    try {
      const partner = await db('partners').where('id', req.params.id).first();
      if (!partner) return res.status(404).json({ error: 'Partner not found' });

      // Partner admins can only view their own
      if (req.user.role === 'partner_admin') {
        const own = await db('partners').where('user_id', req.user.id).first();
        if (!own || own.id !== partner.id) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      const [{ count: clientCount }] = await db('clients').where('partner_id', partner.id).count();
      const [{ sum: totalCash }] = await db('accounts')
        .join('clients', 'clients.id', 'accounts.client_id')
        .where('clients.partner_id', partner.id)
        .sum('accounts.cash_balance as sum');

      const branding = await WhiteLabelService.getByPartnerId(partner.id);

      res.json({
        ...partner,
        clientCount: parseInt(clientCount),
        totalAum: parseFloat(totalCash || 0),
        branding,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch partner' });
    }
  }
);

// PATCH /partners/:id — Update partner details
router.patch('/:id',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const fields = {};
      const allowed = ['name', 'legal_name', 'region', 'country', 'status',
        'revenue_share_pct', 'contact_name', 'contact_email', 'contact_phone',
        'webhook_url', 'api_rate_limit'];
      for (const key of allowed) {
        const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        if (req.body[camel] !== undefined) fields[key] = req.body[camel];
        if (req.body[key] !== undefined) fields[key] = req.body[key];
      }
      if (req.body.allowedIps) fields.allowed_ips = req.body.allowedIps;
      if (req.body.feeStructure) fields.fee_structure = JSON.stringify(req.body.feeStructure);
      fields.updated_at = new Date();

      const [updated] = await db('partners').where('id', req.params.id).update(fields).returning('*');
      if (!updated) return res.status(404).json({ error: 'Partner not found' });

      AuditService.log({
        userId: req.user.id,
        action: `Partner updated: ${updated.name}`,
        resourceType: 'partner',
        resourceId: updated.id,
        level: 'info',
        ipAddress: req.ip,
      });

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update partner' });
    }
  }
);

// PATCH /partners/:id/activate — Activate partner (move from onboarding)
router.patch('/:id/activate',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const [partner] = await db('partners').where('id', req.params.id)
        .update({ status: 'active', onboarded_at: new Date(), updated_at: new Date() })
        .returning('*');
      if (!partner) return res.status(404).json({ error: 'Partner not found' });
      res.json(partner);
    } catch (err) {
      res.status(500).json({ error: 'Failed to activate partner' });
    }
  }
);

// PATCH /partners/:id/suspend — Suspend partner
router.patch('/:id/suspend',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const [partner] = await db('partners').where('id', req.params.id)
        .update({ status: 'suspended', updated_at: new Date() }).returning('*');
      res.json(partner);
    } catch (err) {
      res.status(500).json({ error: 'Failed to suspend partner' });
    }
  }
);

// POST /partners/:id/regenerate-keys — Generate new API credentials
router.post('/:id/regenerate-keys',
  authorize('super_admin'),
  async (req, res) => {
    try {
      const apiKey = 'T1P_' + crypto.randomBytes(24).toString('hex');
      const apiSecret = crypto.randomBytes(32).toString('hex');

      await db('partners').where('id', req.params.id).update({
        api_key_hash: await bcrypt.hash(apiKey, 10),
        api_secret_hash: await bcrypt.hash(apiSecret, 10),
        api_key_prefix: apiKey.substring(0, 8),
        updated_at: new Date(),
      });

      AuditService.log({
        userId: req.user.id,
        action: `Partner API keys regenerated: ${req.params.id}`,
        resourceType: 'partner',
        resourceId: req.params.id,
        level: 'warning',
        ipAddress: req.ip,
      });

      res.json({ apiKey, apiSecret, warning: 'Store securely. Shown once only.' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to regenerate keys' });
    }
  }
);

// ================================================================
// BRANDING / WHITE-LABEL ROUTES
// ================================================================

// GET /partners/:id/branding — Get partner branding config
router.get('/:id/branding',
  authorize('super_admin', 'admin', 'partner_admin'),
  async (req, res) => {
    try {
      const branding = await WhiteLabelService.getByPartnerId(req.params.id);
      if (!branding) return res.status(404).json({ error: 'Partner not found' });
      res.json(branding);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch branding' });
    }
  }
);

// PATCH /partners/:id/branding — Update branding & theming
router.patch('/:id/branding',
  authorize('super_admin', 'admin'),
  async (req, res) => {
    try {
      const branding = await WhiteLabelService.updateBranding(req.params.id, req.body);
      res.json(branding);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update branding' });
    }
  }
);

// GET /partners/resolve/domain — Resolve branding from custom domain (public)
router.get('/resolve/domain', async (req, res) => {
  try {
    const domain = req.query.domain || req.hostname;
    const partner = await db('partners')
      .where('brand_domain', domain)
      .where('status', 'active')
      .first();

    if (!partner) return res.json({ whiteLabel: false, branding: null });

    const branding = WhiteLabelService.buildBranding(partner);
    res.json({ whiteLabel: true, branding });
  } catch (err) {
    res.json({ whiteLabel: false, branding: null });
  }
});

// ================================================================
// PARTNER PORTAL ROUTES (for partner_admin users)
// ================================================================

// GET /partners/portal/dashboard — Partner's own dashboard
router.get('/portal/dashboard',
  authorize('super_admin', 'admin', 'partner_admin'),
  async (req, res) => {
    try {
      let partnerId = req.query.partnerId;
      if (req.user.role === 'partner_admin') {
        const p = await db('partners').where('user_id', req.user.id).first();
        if (!p) return res.status(403).json({ error: 'No partner linked' });
        partnerId = p.id;
      }
      if (!partnerId) return res.status(400).json({ error: 'partnerId required' });

      const partner = await db('partners').where('id', partnerId).first();
      if (!partner) return res.status(404).json({ error: 'Partner not found' });

      // Stats
      const [
        { count: totalClients },
        { count: activeClients },
        { count: pendingKyc },
      ] = await Promise.all([
        db('clients').where('partner_id', partnerId).count().first(),
        db('clients').where('partner_id', partnerId).where('status', 'active').count().first(),
        db('clients').where('partner_id', partnerId).where('kyc_status', 'pending_review').count().first(),
      ]);

      const [{ sum: totalCash }] = await db('accounts')
        .join('clients', 'clients.id', 'accounts.client_id')
        .where('clients.partner_id', partnerId)
        .sum('accounts.cash_balance as sum');

      const [{ count: orders30d }] = await db('orders')
        .where('partner_id', partnerId)
        .where('created_at', '>=', db.raw("NOW() - INTERVAL '30 days'"))
        .count();

      const [{ count: ordersToday }] = await db('orders')
        .where('partner_id', partnerId)
        .where('created_at', '>=', new Date().toISOString().slice(0, 10))
        .count();

      // Recent orders
      const recentOrders = await db('orders as o')
        .join('instruments as i', 'i.id', 'o.instrument_id')
        .join('clients as c', 'c.id', 'o.client_id')
        .where('o.partner_id', partnerId)
        .select('o.*', 'i.symbol', 'c.first_name', 'c.last_name', 'c.account_number')
        .orderBy('o.created_at', 'desc')
        .limit(20);

      // Clients list
      const clients = await db('clients')
        .where('partner_id', partnerId)
        .select('id', 'first_name', 'last_name', 'email', 'account_number', 'status', 'kyc_status', 'created_at')
        .orderBy('created_at', 'desc')
        .limit(50);

      res.json({
        partner: {
          id: partner.id,
          name: partner.name,
          status: partner.status,
          revenueSharePct: partner.revenue_share_pct,
          onboardedAt: partner.onboarded_at,
          apiRateLimit: partner.api_rate_limit,
        },
        stats: {
          totalClients: parseInt(totalClients),
          activeClients: parseInt(activeClients),
          pendingKyc: parseInt(pendingKyc),
          totalAum: parseFloat(totalCash || 0),
          orders30d: parseInt(orders30d),
          ordersToday: parseInt(ordersToday),
        },
        recentOrders,
        clients,
      });
    } catch (err) {
      logger.error('Partner dashboard failed', { error: err.message });
      res.status(500).json({ error: 'Failed to load dashboard' });
    }
  }
);

// ================================================================
// PARTNER "ME" ROUTES (partner_admin self-service portal)
// ================================================================

// GET /partners/me — Partner's own profile + stats
router.get('/me',
  authorize('super_admin', 'admin', 'partner_admin'),
  async (req, res) => {
    try {
      let partner;
      if (req.user.role === 'partner_admin') {
        partner = await db('partners').where('user_id', req.user.id).first();
      } else if (req.query.partnerId) {
        partner = await db('partners').where('id', req.query.partnerId).first();
      }
      if (!partner) return res.status(404).json({ error: 'Partner not found' });

      const [{ count: totalClients }] = await db('clients').where('partner_id', partner.id).count();
      const [{ count: activeClients }] = await db('clients').where('partner_id', partner.id).where('status', 'active').count();
      const [{ count: pendingKyc }] = await db('clients').where('partner_id', partner.id).where('kyc_status', 'pending_review').count();
      const [{ sum: totalCash }] = await db('accounts')
        .join('clients', 'clients.id', 'accounts.client_id')
        .where('clients.partner_id', partner.id)
        .sum('accounts.cash_balance as sum');
      const [{ count: orders30d }] = await db('orders')
        .where('partner_id', partner.id)
        .where('created_at', '>=', db.raw("NOW() - INTERVAL '30 days'"))
        .count();
      const [{ count: ordersToday }] = await db('orders')
        .where('partner_id', partner.id)
        .where('created_at', '>=', new Date().toISOString().slice(0, 10))
        .count();

      const branding = await WhiteLabelService.getByPartnerId(partner.id);

      res.json({
        data: {
          ...partner,
          api_key_hash: undefined, api_secret_hash: undefined, // strip secrets
          stats: {
            totalClients: parseInt(totalClients),
            activeClients: parseInt(activeClients),
            pendingKyc: parseInt(pendingKyc),
            totalAum: parseFloat(totalCash || 0),
            orders30d: parseInt(orders30d),
            ordersToday: parseInt(ordersToday),
          },
          branding,
        }
      });
    } catch (err) {
      logger.error('Partner me failed', { error: err.message });
      res.status(500).json({ error: 'Failed to load partner profile' });
    }
  }
);

// GET /partners/me/clients — Partner's clients list
router.get('/me/clients',
  authorize('super_admin', 'admin', 'partner_admin'),
  async (req, res) => {
    try {
      let partnerId;
      if (req.user.role === 'partner_admin') {
        const p = await db('partners').where('user_id', req.user.id).first();
        if (!p) return res.status(403).json({ error: 'No partner linked' });
        partnerId = p.id;
      } else {
        partnerId = req.query.partnerId;
        if (!partnerId) return res.status(400).json({ error: 'partnerId required' });
      }

      const clients = await db('clients as c')
        .leftJoin('accounts as a', 'a.client_id', 'c.id')
        .where('c.partner_id', partnerId)
        .select(
          'c.id', 'c.first_name', 'c.last_name', 'c.email', 'c.account_number',
          'c.status', 'c.kyc_status', 'c.created_at',
          db.raw('COALESCE(a.cash_balance, 0) as cash_balance')
        )
        .orderBy('c.created_at', 'desc')
        .limit(parseInt(req.query.limit) || 100);

      res.json({ data: clients });
    } catch (err) {
      logger.error('Partner clients failed', { error: err.message });
      res.status(500).json({ error: 'Failed to load clients' });
    }
  }
);

// GET /partners/me/orders — Partner's orders list
router.get('/me/orders',
  authorize('super_admin', 'admin', 'partner_admin'),
  async (req, res) => {
    try {
      let partnerId;
      if (req.user.role === 'partner_admin') {
        const p = await db('partners').where('user_id', req.user.id).first();
        if (!p) return res.status(403).json({ error: 'No partner linked' });
        partnerId = p.id;
      } else {
        partnerId = req.query.partnerId;
        if (!partnerId) return res.status(400).json({ error: 'partnerId required' });
      }

      const orders = await db('orders as o')
        .join('instruments as i', 'i.id', 'o.instrument_id')
        .join('clients as c', 'c.id', 'o.client_id')
        .where('o.partner_id', partnerId)
        .select(
          'o.*', 'i.symbol', 'i.name as instrument_name', 'i.asset_class',
          'c.first_name', 'c.last_name', 'c.account_number'
        )
        .orderBy('o.created_at', 'desc')
        .limit(parseInt(req.query.limit) || 50);

      res.json({ data: orders });
    } catch (err) {
      logger.error('Partner orders failed', { error: err.message });
      res.status(500).json({ error: 'Failed to load orders' });
    }
  }
);

module.exports = router;
