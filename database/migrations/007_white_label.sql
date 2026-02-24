-- ================================================================
-- MIGRATION 007: White-Label Partner Branding & Features
-- Adds branding, theming, feature toggles, and commission overrides
-- to the partners table for full white-label support.
-- ================================================================

-- Branding columns
ALTER TABLE partners ADD COLUMN IF NOT EXISTS brand_name        VARCHAR(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS brand_logo_url    TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS brand_favicon_url TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS brand_domain      VARCHAR(255) UNIQUE;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS brand_support_email VARCHAR(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS brand_support_url TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS custom_footer_text TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS custom_terms_url  TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS custom_privacy_url TEXT;

-- Theme (CSS custom properties override)
ALTER TABLE partners ADD COLUMN IF NOT EXISTS theme             JSONB DEFAULT '{}';

-- Feature toggles per partner (which asset classes / features are enabled)
ALTER TABLE partners ADD COLUMN IF NOT EXISTS features          JSONB DEFAULT '{
  "equities": true,
  "crypto": true,
  "forex": false,
  "options": false,
  "privateMarkets": false,
  "marginTrading": false,
  "apiTrading": true,
  "mobileApp": false
}';

-- Commission overrides per partner (overrides platform defaults)
ALTER TABLE partners ADD COLUMN IF NOT EXISTS commission_overrides JSONB DEFAULT '{}';

-- Last API call timestamp (for monitoring)
ALTER TABLE partners ADD COLUMN IF NOT EXISTS last_api_call     TIMESTAMPTZ;

-- Index on domain for fast white-label resolution
CREATE INDEX IF NOT EXISTS idx_partners_domain ON partners(brand_domain) WHERE brand_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);

-- ================================================================
-- Update the partner summary view to include branding info
-- ================================================================
CREATE OR REPLACE VIEW v_partner_summary AS
SELECT 
    p.id AS partner_id,
    p.name AS partner_name,
    p.brand_name,
    p.brand_domain,
    p.status,
    p.revenue_share_pct,
    p.onboarded_at,
    p.last_api_call,
    COUNT(DISTINCT c.id) AS total_clients,
    COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active') AS active_clients,
    COUNT(DISTINCT c.id) FILTER (WHERE c.kyc_status = 'pending_review') AS pending_kyc,
    COALESCE(SUM(a.cash_balance), 0) AS total_cash,
    COALESCE(SUM(a.cash_balance), 0) + 
        COALESCE(SUM(pos.quantity * i.last_price), 0) AS total_aum,
    COUNT(DISTINCT o.id) FILTER (WHERE o.created_at >= NOW() - INTERVAL '30 days') AS orders_30d,
    COUNT(DISTINCT o.id) FILTER (WHERE o.created_at >= CURRENT_DATE) AS orders_today
FROM partners p
LEFT JOIN clients c ON c.partner_id = p.id
LEFT JOIN accounts a ON a.client_id = c.id
LEFT JOIN orders o ON o.partner_id = p.id
LEFT JOIN positions pos ON pos.client_id = c.id AND pos.closed_at IS NULL
LEFT JOIN instruments i ON i.id = pos.instrument_id
GROUP BY p.id, p.name, p.brand_name, p.brand_domain, p.status, 
         p.revenue_share_pct, p.onboarded_at, p.last_api_call;
