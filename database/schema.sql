-- ================================================================
-- T1 BROKER PLATFORM — POSTGRESQL DATABASE SCHEMA
-- Version: 1.0.0
-- Description: Complete schema with row-level security, audit triggers,
--              and full referential integrity
-- ================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ================================================================
-- ENUMS
-- ================================================================
CREATE TYPE user_role AS ENUM ('super_admin', 'admin', 'compliance', 'operations', 'relationship_manager', 'finance', 'partner_admin', 'auditor', 'client');
CREATE TYPE account_status AS ENUM ('pending', 'active', 'dormant', 'suspended', 'closed');
CREATE TYPE kyc_status AS ENUM ('not_started', 'in_progress', 'pending_review', 'approved', 'rejected', 'rekyc_required');
CREATE TYPE client_type AS ENUM ('retail', 'professional', 'institutional');
CREATE TYPE risk_level AS ENUM ('low', 'medium', 'high', 'very_high');
CREATE TYPE order_side AS ENUM ('buy', 'sell');
CREATE TYPE order_type AS ENUM ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop');
CREATE TYPE order_status AS ENUM ('pending', 'submitted', 'working', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired');
CREATE TYPE order_tif AS ENUM ('day', 'gtc', 'ioc', 'fok', 'gtd');
CREATE TYPE position_side AS ENUM ('long', 'short');
CREATE TYPE asset_class AS ENUM ('equity', 'etf', 'option', 'future', 'forex', 'crypto', 'bond', 'private_debt', 'private_equity');
CREATE TYPE transfer_type AS ENUM ('deposit', 'withdrawal', 'internal', 'fee', 'commission', 'interest', 'dividend');
CREATE TYPE transfer_status AS ENUM ('pending', 'pending_approval', 'approved', 'processing', 'completed', 'failed', 'cancelled');
CREATE TYPE broker_type AS ENUM ('saxo', 'drivewealth', 'internal');
CREATE TYPE partner_status AS ENUM ('onboarding', 'active', 'suspended', 'terminated');
CREATE TYPE audit_level AS ENUM ('info', 'warning', 'critical', 'success');
CREATE TYPE mfa_method AS ENUM ('totp', 'sms', 'email', 'fido2');

-- ================================================================
-- CORE TABLES
-- ================================================================

-- Users (both internal staff and clients authenticate here)
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            user_role NOT NULL DEFAULT 'client',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    email_verified  BOOLEAN NOT NULL DEFAULT false,
    mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
    mfa_secret      TEXT,  -- encrypted TOTP secret
    mfa_method      mfa_method DEFAULT 'totp',
    failed_login_attempts INT NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ,
    last_login_ip   INET,
    password_changed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User sessions for tracking active sessions
CREATE TABLE user_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,
    refresh_token_hash VARCHAR(255),
    ip_address      INET,
    user_agent      TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

-- IP Whitelist for admin access
CREATE TABLE ip_whitelist (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    ip_address      INET NOT NULL,
    description     VARCHAR(255),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- CLIENT MANAGEMENT
-- ================================================================

CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    partner_id      UUID REFERENCES partners(id),  -- NULL = direct T1 client
    
    -- Personal info (encrypted at application level)
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    date_of_birth   DATE,
    nationality     CHAR(2),          -- ISO 3166-1 alpha-2
    country_of_residence CHAR(2) NOT NULL,
    phone           VARCHAR(50),       -- encrypted
    address_line1   TEXT,              -- encrypted
    address_line2   TEXT,
    city            VARCHAR(100),
    state           VARCHAR(100),
    postal_code     VARCHAR(20),
    tax_id          VARCHAR(100),      -- encrypted
    
    -- Account info
    account_number  VARCHAR(20) UNIQUE NOT NULL,
    client_type     client_type NOT NULL DEFAULT 'retail',
    risk_level      risk_level NOT NULL DEFAULT 'medium',
    status          account_status NOT NULL DEFAULT 'pending',
    kyc_status      kyc_status NOT NULL DEFAULT 'not_started',
    kyc_approved_at TIMESTAMPTZ,
    kyc_approved_by UUID REFERENCES users(id),
    kyc_expiry_date DATE,
    
    -- Financial
    base_currency   CHAR(3) NOT NULL DEFAULT 'USD',
    margin_enabled  BOOLEAN NOT NULL DEFAULT false,
    margin_ratio    DECIMAL(5,2) DEFAULT 1.00,
    
    -- Metadata
    source          VARCHAR(50),       -- how they signed up
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Client documents (KYC)
CREATE TABLE client_documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    document_type   VARCHAR(50) NOT NULL,  -- passport, proof_of_address, source_of_funds, etc.
    file_name       VARCHAR(255) NOT NULL,
    file_path       TEXT NOT NULL,          -- S3 path, encrypted
    file_hash       VARCHAR(128) NOT NULL,  -- SHA-512 hash for integrity
    mime_type       VARCHAR(100),
    file_size       BIGINT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    review_notes    TEXT,
    expires_at      DATE,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Client bank accounts (for deposits/withdrawals)
CREATE TABLE client_bank_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    bank_name       VARCHAR(255) NOT NULL,
    account_number_encrypted TEXT NOT NULL,  -- AES-256 encrypted
    routing_number_encrypted TEXT,
    iban_encrypted  TEXT,
    swift_code      VARCHAR(11),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    is_verified     BOOLEAN NOT NULL DEFAULT false,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cooling_off_until TIMESTAMPTZ,  -- 48h cooling period for new accounts
    verified_at     TIMESTAMPTZ
);

-- ================================================================
-- PARTNER BROKERS
-- ================================================================

CREATE TABLE partners (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID UNIQUE REFERENCES users(id),
    name            VARCHAR(255) NOT NULL,
    legal_name      VARCHAR(255) NOT NULL,
    region          VARCHAR(100),
    country         CHAR(2) NOT NULL,
    status          partner_status NOT NULL DEFAULT 'onboarding',
    
    -- API access
    api_key_hash    VARCHAR(255),
    api_secret_hash VARCHAR(255),
    api_key_prefix  VARCHAR(8),       -- first 8 chars for identification
    api_rate_limit  INT DEFAULT 1000, -- requests per minute
    webhook_url     TEXT,
    allowed_ips     INET[],
    
    -- Commercial terms
    revenue_share_pct DECIMAL(5,2),   -- e.g., 60.00 means 60%
    fee_structure   JSONB,
    
    -- Omnibus account
    omnibus_account_id VARCHAR(50),
    
    -- Metadata
    contact_name    VARCHAR(255),
    contact_email   VARCHAR(255),
    contact_phone   VARCHAR(50),
    onboarded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- INSTRUMENTS
-- ================================================================

CREATE TABLE instruments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol          VARCHAR(20) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    asset_class     asset_class NOT NULL,
    exchange        VARCHAR(20),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    
    -- Broker mapping
    saxo_uic        INT,              -- Saxo instrument identifier
    dw_instrument_id VARCHAR(50),     -- DriveWealth instrument ID
    
    -- Trading rules
    lot_size        DECIMAL(18,8) DEFAULT 1,
    min_quantity    DECIMAL(18,8) DEFAULT 1,
    tick_size       DECIMAL(18,8) DEFAULT 0.01,
    is_fractional   BOOLEAN DEFAULT false,
    is_tradable     BOOLEAN DEFAULT true,
    
    -- Market data
    last_price      DECIMAL(18,8),
    bid_price       DECIMAL(18,8),
    ask_price       DECIMAL(18,8),
    day_high        DECIMAL(18,8),
    day_low         DECIMAL(18,8),
    prev_close      DECIMAL(18,8),
    volume          BIGINT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(symbol, exchange)
);

-- ================================================================
-- ORDERS
-- ================================================================

CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    partner_id      UUID REFERENCES partners(id),
    
    -- Order details
    order_ref       VARCHAR(20) UNIQUE NOT NULL,  -- human-readable ORD-XXXXX
    side            order_side NOT NULL,
    order_type      order_type NOT NULL,
    quantity        DECIMAL(18,8) NOT NULL,
    price           DECIMAL(18,8),          -- limit price
    stop_price      DECIMAL(18,8),          -- stop trigger price
    trail_amount    DECIMAL(18,8),          -- trailing stop offset
    time_in_force   order_tif NOT NULL DEFAULT 'day',
    expire_at       TIMESTAMPTZ,
    
    -- Execution
    status          order_status NOT NULL DEFAULT 'pending',
    filled_quantity DECIMAL(18,8) NOT NULL DEFAULT 0,
    avg_fill_price  DECIMAL(18,8),
    commission      DECIMAL(18,4) DEFAULT 0,
    fees            DECIMAL(18,4) DEFAULT 0,
    
    -- Routing
    broker          broker_type NOT NULL,
    broker_order_id VARCHAR(100),      -- external broker order ID
    execution_venue VARCHAR(50),
    
    -- Timestamps
    submitted_at    TIMESTAMPTZ,
    filled_at       TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Audit
    created_by      UUID NOT NULL REFERENCES users(id),
    ip_address      INET
);

-- Order fills (partial fills tracked individually)
CREATE TABLE order_fills (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    fill_quantity   DECIMAL(18,8) NOT NULL,
    fill_price      DECIMAL(18,8) NOT NULL,
    commission      DECIMAL(18,4) DEFAULT 0,
    broker_fill_id  VARCHAR(100),
    execution_venue VARCHAR(50),
    filled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- POSITIONS
-- ================================================================

CREATE TABLE positions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    partner_id      UUID REFERENCES partners(id),
    
    side            position_side NOT NULL,
    quantity        DECIMAL(18,8) NOT NULL,
    avg_cost        DECIMAL(18,8) NOT NULL,
    realized_pnl    DECIMAL(18,4) NOT NULL DEFAULT 0,
    
    -- Sub-broker tracking
    broker          broker_type NOT NULL,
    broker_position_id VARCHAR(100),
    
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    
    UNIQUE(client_id, instrument_id, side, broker)
);

-- Position history (snapshots for EOD reporting)
CREATE TABLE position_snapshots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    snapshot_date   DATE NOT NULL,
    side            position_side NOT NULL,
    quantity        DECIMAL(18,8) NOT NULL,
    avg_cost        DECIMAL(18,8) NOT NULL,
    market_price    DECIMAL(18,8) NOT NULL,
    market_value    DECIMAL(18,4) NOT NULL,
    unrealized_pnl  DECIMAL(18,4) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(client_id, instrument_id, snapshot_date)
);

-- ================================================================
-- ACCOUNTS & CASH
-- ================================================================

CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    cash_balance    DECIMAL(18,4) NOT NULL DEFAULT 0,
    reserved_balance DECIMAL(18,4) NOT NULL DEFAULT 0,  -- locked for pending orders
    margin_used     DECIMAL(18,4) NOT NULL DEFAULT 0,
    buying_power    DECIMAL(18,4) NOT NULL DEFAULT 0,
    
    -- Omnibus tracking
    broker          broker_type NOT NULL,
    broker_account_id VARCHAR(100),
    
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(client_id, currency, broker)
);

CREATE TABLE cash_transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    client_id       UUID NOT NULL REFERENCES clients(id),
    
    transaction_ref VARCHAR(20) UNIQUE NOT NULL,
    type            transfer_type NOT NULL,
    amount          DECIMAL(18,4) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    status          transfer_status NOT NULL DEFAULT 'pending',
    
    -- For deposits/withdrawals
    bank_account_id UUID REFERENCES client_bank_accounts(id),
    
    -- Approval workflow
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    approved_by     UUID REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    second_approver UUID REFERENCES users(id),  -- dual authorization
    second_approved_at TIMESTAMPTZ,
    
    description     TEXT,
    metadata        JSONB,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id)
);

-- ================================================================
-- RECONCILIATION
-- ================================================================

CREATE TABLE reconciliation_runs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    broker          broker_type NOT NULL,
    run_date        DATE NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'running', -- running, matched, discrepancy, failed
    
    positions_matched   INT DEFAULT 0,
    positions_unmatched INT DEFAULT 0,
    cash_matched        BOOLEAN,
    cash_difference     DECIMAL(18,4),
    
    details         JSONB,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    
    UNIQUE(broker, run_date)
);

CREATE TABLE reconciliation_breaks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id          UUID NOT NULL REFERENCES reconciliation_runs(id),
    client_id       UUID REFERENCES clients(id),
    instrument_id   UUID REFERENCES instruments(id),
    
    break_type      VARCHAR(50) NOT NULL, -- position_mismatch, cash_mismatch, missing_position
    internal_value  DECIMAL(18,8),
    broker_value    DECIMAL(18,8),
    difference      DECIMAL(18,8),
    
    resolved        BOOLEAN NOT NULL DEFAULT false,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    resolution_notes TEXT,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- AUDIT LOG (Append-only, immutable)
-- ================================================================

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    event_id        UUID NOT NULL DEFAULT uuid_generate_v4(),
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    user_id         UUID REFERENCES users(id),
    user_email      VARCHAR(255),
    user_role       user_role,
    
    action          VARCHAR(255) NOT NULL,
    resource_type   VARCHAR(100),      -- client, order, position, etc.
    resource_id     VARCHAR(100),
    
    level           audit_level NOT NULL DEFAULT 'info',
    
    ip_address      INET,
    user_agent      TEXT,
    
    -- Change tracking
    old_values      JSONB,
    new_values      JSONB,
    
    -- Integrity
    event_hash      VARCHAR(128),      -- SHA-512 of event data
    prev_hash       VARCHAR(128),      -- hash of previous event (chain)
    
    metadata        JSONB
);

-- Audit log is append-only: revoke UPDATE and DELETE
-- ALTER TABLE audit_log OWNER TO t1_audit_writer;
-- REVOKE UPDATE, DELETE ON audit_log FROM t1_audit_writer;

-- ================================================================
-- NOTIFICATIONS & ALERTS
-- ================================================================

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    message         TEXT NOT NULL,
    type            VARCHAR(50) NOT NULL DEFAULT 'info',
    is_read         BOOLEAN NOT NULL DEFAULT false,
    link            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE price_alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    condition       VARCHAR(10) NOT NULL, -- 'above', 'below'
    target_price    DECIMAL(18,8) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    triggered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- INDEXES
-- ================================================================

-- Users
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Sessions
CREATE INDEX idx_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_sessions_token ON user_sessions(token_hash);
CREATE INDEX idx_sessions_expires ON user_sessions(expires_at);

-- Clients
CREATE INDEX idx_clients_user ON clients(user_id);
CREATE INDEX idx_clients_partner ON clients(partner_id);
CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_account_number ON clients(account_number);
CREATE INDEX idx_clients_country ON clients(country_of_residence);

-- Orders
CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_instrument ON orders(instrument_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_ref ON orders(order_ref);
CREATE INDEX idx_orders_broker ON orders(broker, broker_order_id);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_partner ON orders(partner_id);
CREATE INDEX idx_orders_active ON orders(client_id, status) WHERE status IN ('pending', 'submitted', 'working', 'partially_filled');

-- Positions
CREATE INDEX idx_positions_client ON positions(client_id);
CREATE INDEX idx_positions_instrument ON positions(instrument_id);
CREATE INDEX idx_positions_active ON positions(client_id) WHERE closed_at IS NULL;
CREATE INDEX idx_positions_broker ON positions(broker);

-- Accounts
CREATE INDEX idx_accounts_client ON accounts(client_id);

-- Cash transactions
CREATE INDEX idx_cash_tx_client ON cash_transactions(client_id);
CREATE INDEX idx_cash_tx_status ON cash_transactions(status);
CREATE INDEX idx_cash_tx_created ON cash_transactions(created_at DESC);

-- Audit log
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_level ON audit_log(level);
CREATE INDEX idx_audit_event_id ON audit_log(event_id);

-- Instruments
CREATE INDEX idx_instruments_symbol ON instruments(symbol);
CREATE INDEX idx_instruments_class ON instruments(asset_class);

-- Notifications
CREATE INDEX idx_notif_user ON notifications(user_id, is_read);

-- ================================================================
-- TRIGGERS
-- ================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clients_updated BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_positions_updated BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_partners_updated BEFORE UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Audit log hash chain trigger
CREATE OR REPLACE FUNCTION compute_audit_hash()
RETURNS TRIGGER AS $$
DECLARE
    prev_hash_val VARCHAR(128);
    event_data TEXT;
BEGIN
    -- Get previous event hash
    SELECT event_hash INTO prev_hash_val FROM audit_log ORDER BY id DESC LIMIT 1;
    NEW.prev_hash = COALESCE(prev_hash_val, 'GENESIS');
    
    -- Compute hash of this event
    event_data = CONCAT(
        NEW.event_id, '|', NEW.timestamp, '|', NEW.user_id, '|',
        NEW.action, '|', NEW.resource_type, '|', NEW.resource_id, '|',
        NEW.prev_hash
    );
    NEW.event_hash = encode(digest(event_data, 'sha512'), 'hex');
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_hash BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION compute_audit_hash();

-- Order sequence generator
CREATE SEQUENCE order_ref_seq START WITH 5000;

CREATE OR REPLACE FUNCTION generate_order_ref()
RETURNS TRIGGER AS $$
BEGIN
    NEW.order_ref = 'ORD-' || LPAD(nextval('order_ref_seq')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_ref BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION generate_order_ref();

-- Cash transaction ref generator
CREATE SEQUENCE cash_tx_ref_seq START WITH 1000;

CREATE OR REPLACE FUNCTION generate_cash_tx_ref()
RETURNS TRIGGER AS $$
BEGIN
    NEW.transaction_ref = 'TXN-' || LPAD(nextval('cash_tx_ref_seq')::TEXT, 6, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cash_tx_ref BEFORE INSERT ON cash_transactions FOR EACH ROW EXECUTE FUNCTION generate_cash_tx_ref();

-- Account number generator
CREATE SEQUENCE account_number_seq START WITH 100001;

CREATE OR REPLACE FUNCTION generate_account_number()
RETURNS TRIGGER AS $$
BEGIN
    NEW.account_number = 'T1-' || LPAD(nextval('account_number_seq')::TEXT, 6, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_number BEFORE INSERT ON clients FOR EACH ROW EXECUTE FUNCTION generate_account_number();

-- ================================================================
-- ROW LEVEL SECURITY
-- ================================================================

-- Enable RLS on sensitive tables
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;

-- Policy: clients can only see their own data
CREATE POLICY client_own_data ON clients
    FOR ALL TO t1_app_user
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- Policy: partner admins see only their partner's clients
CREATE POLICY partner_client_data ON clients
    FOR SELECT TO t1_partner_user
    USING (partner_id = current_setting('app.current_partner_id')::UUID);

-- Policy: admins see everything
CREATE POLICY admin_all_data ON clients
    FOR ALL TO t1_admin_user
    USING (true);

-- Similar policies for orders
CREATE POLICY client_own_orders ON orders
    FOR ALL TO t1_app_user
    USING (client_id IN (SELECT id FROM clients WHERE user_id = current_setting('app.current_user_id')::UUID));

CREATE POLICY admin_all_orders ON orders
    FOR ALL TO t1_admin_user
    USING (true);

-- ================================================================
-- VIEWS
-- ================================================================

-- Aggregated client portfolio view
CREATE OR REPLACE VIEW v_client_portfolio AS
SELECT 
    c.id AS client_id,
    c.first_name || ' ' || c.last_name AS client_name,
    c.account_number,
    c.status,
    a.cash_balance,
    a.buying_power,
    a.margin_used,
    COALESCE(SUM(p.quantity * i.last_price), 0) AS positions_value,
    a.cash_balance + COALESCE(SUM(p.quantity * i.last_price), 0) AS total_value,
    COALESCE(SUM((i.last_price - p.avg_cost) * p.quantity * 
        CASE WHEN p.side = 'long' THEN 1 ELSE -1 END), 0) AS unrealized_pnl,
    COUNT(p.id) AS open_positions
FROM clients c
LEFT JOIN accounts a ON a.client_id = c.id
LEFT JOIN positions p ON p.client_id = c.id AND p.closed_at IS NULL
LEFT JOIN instruments i ON i.id = p.instrument_id
GROUP BY c.id, c.first_name, c.last_name, c.account_number, c.status, 
         a.cash_balance, a.buying_power, a.margin_used;

-- Daily trade summary view
CREATE OR REPLACE VIEW v_daily_trades AS
SELECT 
    DATE(o.created_at) AS trade_date,
    o.client_id,
    c.first_name || ' ' || c.last_name AS client_name,
    i.symbol,
    o.side,
    o.order_type,
    o.quantity,
    o.avg_fill_price,
    o.commission + o.fees AS total_cost,
    o.broker,
    o.status
FROM orders o
JOIN clients c ON c.id = o.client_id
JOIN instruments i ON i.id = o.instrument_id
WHERE o.status IN ('filled', 'partially_filled')
ORDER BY o.created_at DESC;

-- Partner summary view
CREATE OR REPLACE VIEW v_partner_summary AS
SELECT 
    p.id AS partner_id,
    p.name AS partner_name,
    p.status,
    COUNT(DISTINCT c.id) AS total_clients,
    COALESCE(SUM(a.cash_balance), 0) + 
        COALESCE(SUM(pos.quantity * i.last_price), 0) AS total_aum,
    COUNT(DISTINCT o.id) FILTER (WHERE o.created_at >= NOW() - INTERVAL '30 days') AS orders_30d
FROM partners p
LEFT JOIN clients c ON c.partner_id = p.id
LEFT JOIN accounts a ON a.client_id = c.id
LEFT JOIN positions pos ON pos.client_id = c.id AND pos.closed_at IS NULL
LEFT JOIN instruments i ON i.id = pos.instrument_id
LEFT JOIN orders o ON o.client_id = c.id
GROUP BY p.id, p.name, p.status;
