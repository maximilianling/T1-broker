// ================================================================
// T1 BROKER — WHITE-LABEL THEMING SERVICE
// Resolves partner branding from custom domain or partner context.
// Injects CSS custom properties and branding into frontend responses.
// ================================================================
const db = require('../config/database');
const logger = require('../utils/logger');

const DEFAULT_THEME = {
  primaryColor: '#3b82f6',
  primaryHover: '#2563eb',
  accentColor: '#22c55e',
  bgPrimary: '#0a0f1c',
  bgSecondary: '#111827',
  bgCard: '#151d2e',
  borderColor: '#1e293b',
  textPrimary: '#f0f4ff',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
};

const DEFAULT_BRANDING = {
  brandName: 'T1 Broker',
  brandLogoUrl: null,
  brandFaviconUrl: null,
  brandSupportEmail: 'support@t1broker.com',
  brandSupportUrl: null,
  customFooterText: null,
  customTermsUrl: '/terms.html',
  customPrivacyUrl: '/privacy.html',
};

// Cache: domain -> partner branding (TTL 60s)
const cache = new Map();
const CACHE_TTL = 60_000;

class WhiteLabelService {
  // ── Resolve partner from request (domain or partner_id) ──────
  static async resolvePartner(req) {
    // 1. Check custom domain header (set by nginx proxy)
    const domain = req.headers['x-forwarded-host'] || req.hostname;

    // 2. Check if this is a partner custom domain
    const cached = cache.get(domain);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data;
    }

    try {
      const partner = await db('partners')
        .where('brand_domain', domain)
        .where('status', 'active')
        .first();

      if (partner) {
        const branding = WhiteLabelService.buildBranding(partner);
        cache.set(domain, { data: branding, ts: Date.now() });
        return branding;
      }
    } catch (err) {
      logger.error('White-label resolution failed', { domain, error: err.message });
    }

    return null; // Not a white-label domain — use T1 defaults
  }

  // ── Resolve by partner ID (for API responses) ────────────────
  static async getByPartnerId(partnerId) {
    try {
      const partner = await db('partners').where('id', partnerId).first();
      if (!partner) return null;
      return WhiteLabelService.buildBranding(partner);
    } catch (err) {
      logger.error('Partner branding lookup failed', { partnerId, error: err.message });
      return null;
    }
  }

  // ── Build branding response from partner record ──────────────
  static buildBranding(partner) {
    const theme = { ...DEFAULT_THEME, ...(partner.theme || {}) };
    return {
      partnerId: partner.id,
      partnerName: partner.name,
      brandName: partner.brand_name || partner.name,
      brandLogoUrl: partner.brand_logo_url || null,
      brandFaviconUrl: partner.brand_favicon_url || null,
      brandDomain: partner.brand_domain || null,
      brandSupportEmail: partner.brand_support_email || DEFAULT_BRANDING.brandSupportEmail,
      brandSupportUrl: partner.brand_support_url || null,
      customFooterText: partner.custom_footer_text || null,
      customTermsUrl: partner.custom_terms_url || DEFAULT_BRANDING.customTermsUrl,
      customPrivacyUrl: partner.custom_privacy_url || DEFAULT_BRANDING.customPrivacyUrl,
      theme,
      features: partner.features || {},
      cssVariables: WhiteLabelService.themeToCssVars(theme),
    };
  }

  // ── Convert theme object to CSS custom properties string ─────
  static themeToCssVars(theme) {
    return `:root {
  --blue: ${theme.primaryColor};
  --blue2: ${theme.primaryHover};
  --green: ${theme.accentColor};
  --bg: ${theme.bgPrimary};
  --bg2: ${theme.bgSecondary};
  --card: ${theme.bgCard};
  --border: ${theme.borderColor};
  --text: ${theme.textPrimary};
  --text2: ${theme.textSecondary};
  --text3: ${theme.textMuted};
  font-family: ${theme.fontFamily};
}`;
  }

  // ── Update partner branding ──────────────────────────────────
  static async updateBranding(partnerId, branding) {
    const updates = {};
    if (branding.brandName !== undefined) updates.brand_name = branding.brandName;
    if (branding.brandLogoUrl !== undefined) updates.brand_logo_url = branding.brandLogoUrl;
    if (branding.brandFaviconUrl !== undefined) updates.brand_favicon_url = branding.brandFaviconUrl;
    if (branding.brandDomain !== undefined) updates.brand_domain = branding.brandDomain;
    if (branding.brandSupportEmail !== undefined) updates.brand_support_email = branding.brandSupportEmail;
    if (branding.brandSupportUrl !== undefined) updates.brand_support_url = branding.brandSupportUrl;
    if (branding.customFooterText !== undefined) updates.custom_footer_text = branding.customFooterText;
    if (branding.customTermsUrl !== undefined) updates.custom_terms_url = branding.customTermsUrl;
    if (branding.customPrivacyUrl !== undefined) updates.custom_privacy_url = branding.customPrivacyUrl;
    if (branding.theme !== undefined) updates.theme = JSON.stringify(branding.theme);
    if (branding.features !== undefined) updates.features = JSON.stringify(branding.features);
    if (branding.commissionOverrides !== undefined) updates.commission_overrides = JSON.stringify(branding.commissionOverrides);

    updates.updated_at = new Date();

    await db('partners').where('id', partnerId).update(updates);

    // Invalidate cache
    cache.clear();

    return WhiteLabelService.getByPartnerId(partnerId);
  }

  // ── Middleware: inject partner branding into req ──────────────
  static middleware() {
    return async (req, res, next) => {
      try {
        const branding = await WhiteLabelService.resolvePartner(req);
        if (branding) {
          req.whiteLabel = branding;
          req.partnerId = branding.partnerId;
        }
      } catch (err) {
        // Non-fatal — continue with T1 defaults
      }
      next();
    };
  }
}

module.exports = WhiteLabelService;
