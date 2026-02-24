-- ================================================================
-- T1 BROKER — MIGRATION 004
-- Platform Settings: Admin-tunable system variables
-- ================================================================

CREATE TABLE platform_settings (
    key             VARCHAR(100) PRIMARY KEY,
    value           TEXT NOT NULL,
    value_type      VARCHAR(20) NOT NULL DEFAULT 'string',  -- string, number, boolean, json, secret
    category        VARCHAR(50) NOT NULL,
    label           VARCHAR(200) NOT NULL,
    description     TEXT,
    default_value   TEXT,
    
    -- Constraints
    min_value       DECIMAL(18,8),           -- for numeric: min allowed
    max_value       DECIMAL(18,8),           -- for numeric: max allowed
    allowed_values  JSONB,                   -- for enum: ["opt1","opt2"]
    
    -- Metadata
    is_sensitive    BOOLEAN DEFAULT false,   -- mask in UI / audit
    requires_restart BOOLEAN DEFAULT false,  -- needs server restart
    sort_order      INT DEFAULT 100,
    
    -- Audit
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE platform_settings_audit (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    setting_key     VARCHAR(100) NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    changed_by      UUID REFERENCES users(id),
    ip_address      INET,
    reason          TEXT,
    changed_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_settings_category ON platform_settings(category);
CREATE INDEX idx_settings_audit_key ON platform_settings_audit(setting_key);

-- ================================================================
-- SEED ALL CONFIGURABLE SETTINGS
-- ================================================================

-- ── TRADING ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, min_value, max_value, sort_order) VALUES
('trading.default_commission_rate',     '0.001',   'number',  'trading', 'Default Commission Rate',        'Default commission per trade (0.001 = 0.1%)',           '0.001', 0, 0.1, 10),
('trading.clearing_fee_rate',           '0.0001',  'number',  'trading', 'Clearing Fee Rate',              'Internal clearing fee per trade (0.0001 = 0.01%)',      '0.0001', 0, 0.01, 11),
('trading.default_settlement',          'T+2',     'string',  'trading', 'Default Settlement Cycle',       'Default settlement for new instruments',                'T+2', NULL, NULL, 12),
('trading.market_order_slippage_limit', '0.02',    'number',  'trading', 'Market Order Slippage Limit',    'Max slippage allowed on market orders (0.02 = 2%)',     '0.02', 0, 0.1, 13),
('trading.max_order_value',             '1000000', 'number',  'trading', 'Max Single Order Value ($)',      'Maximum value for a single order',                      '1000000', 1000, 100000000, 14),
('trading.min_order_value',             '1',       'number',  'trading', 'Min Single Order Value ($)',      'Minimum value for a single order',                      '1', 0, 1000, 15),
('trading.allow_fractional',            'true',    'boolean', 'trading', 'Allow Fractional Shares',        'Enable fractional share trading globally',              'true', NULL, NULL, 16),
('trading.allow_short_selling',         'true',    'boolean', 'trading', 'Allow Short Selling',            'Enable short selling globally',                         'true', NULL, NULL, 17),
('trading.auto_cancel_eod',            'true',    'boolean', 'trading', 'Auto-Cancel Day Orders at EOD',  'Cancel unfilled day orders at market close',            'true', NULL, NULL, 18),
('trading.market_hours_start',          '09:30',   'string',  'trading', 'Market Open (ET)',               'Standard market opening time (Eastern)',                 '09:30', NULL, NULL, 19),
('trading.market_hours_end',            '16:00',   'string',  'trading', 'Market Close (ET)',              'Standard market closing time (Eastern)',                 '16:00', NULL, NULL, 20),
('trading.allow_premarket',             'false',   'boolean', 'trading', 'Allow Pre-Market Trading',       'Enable pre-market session (4:00–9:30 ET)',             'false', NULL, NULL, 21),
('trading.allow_afterhours',            'false',   'boolean', 'trading', 'Allow After-Hours Trading',      'Enable after-hours session (16:00–20:00 ET)',          'false', NULL, NULL, 22);

-- ── MARGIN ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, min_value, max_value, sort_order) VALUES
('margin.initial_ratio',                '0.50',    'number',  'margin', 'Initial Margin Ratio',            'Required margin to open position (0.50 = 50%)',        '0.50', 0.1, 1.0, 10),
('margin.maintenance_ratio',            '0.25',    'number',  'margin', 'Maintenance Margin Ratio',        'Minimum margin before margin call (0.25 = 25%)',       '0.25', 0.1, 1.0, 11),
('margin.liquidation_threshold',        '0.75',    'number',  'margin', 'Liquidation Threshold',           'Fraction of maintenance below which auto-liquidation triggers', '0.75', 0.5, 1.0, 12),
('margin.call_deadline_hours',          '24',      'number',  'margin', 'Margin Call Deadline (hours)',     'Hours before forced liquidation after margin call',    '24', 1, 168, 13),
('margin.auto_liquidate',               'false',   'boolean', 'margin', 'Auto-Liquidate on Breach',        'Automatically close positions below liquidation threshold', 'false', NULL, NULL, 14),
('margin.equity_margin_rate',           '0.25',    'number',  'margin', 'Equity Margin Rate (Long)',       'Required margin for long equity positions',             '0.25', 0.1, 1.0, 15),
('margin.equity_short_margin_rate',     '0.30',    'number',  'margin', 'Equity Margin Rate (Short)',      'Required margin for short equity positions',            '0.30', 0.1, 1.0, 16),
('margin.crypto_margin_rate',           '0.50',    'number',  'margin', 'Crypto Margin Rate',              'Required margin for crypto positions',                  '0.50', 0.2, 1.0, 17),
('margin.forex_margin_rate',            '0.02',    'number',  'margin', 'Forex Margin Rate',               'Required margin for forex positions (e.g., 50:1 leverage)', '0.02', 0.005, 0.5, 18);

-- ── FEES ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, min_value, max_value, sort_order) VALUES
('fees.equity_commission',              '0.001',   'number',  'fees', 'Equity Commission Rate',             'Commission on equity trades (0.001 = 0.1%)',           '0.001', 0, 0.05, 10),
('fees.crypto_commission',              '0.002',   'number',  'fees', 'Crypto Commission Rate',             'Commission on crypto trades',                          '0.002', 0, 0.05, 11),
('fees.forex_commission',               '0.0005',  'number',  'fees', 'Forex Commission Rate',              'Commission on forex trades',                           '0.0005', 0, 0.05, 12),
('fees.min_commission',                 '1.00',    'number',  'fees', 'Minimum Commission ($)',              'Minimum commission per trade',                         '1.00', 0, 50, 13),
('fees.withdrawal_fee_fiat',            '25.00',   'number',  'fees', 'Fiat Withdrawal Fee ($)',             'Fee for wire/ACH withdrawals',                        '25.00', 0, 100, 14),
('fees.inactivity_fee_monthly',         '0',       'number',  'fees', 'Monthly Inactivity Fee ($)',          'Fee charged to dormant accounts (0 = disabled)',      '0', 0, 100, 15),
('fees.custody_fee_annual_bps',         '0',       'number',  'fees', 'Annual Custody Fee (bps)',            'Annual custody fee in basis points (0 = disabled)',   '0', 0, 100, 16);

-- ── LIMITS ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, min_value, max_value, sort_order) VALUES
('limits.max_daily_trades',             '500',     'number',  'limits', 'Max Daily Trades (per client)',     'Maximum number of trades per day per client',         '500', 1, 10000, 10),
('limits.max_open_orders',              '100',     'number',  'limits', 'Max Open Orders (per client)',      'Maximum simultaneous open orders',                    '100', 1, 5000, 11),
('limits.max_positions',                '200',     'number',  'limits', 'Max Positions (per client)',        'Maximum simultaneous open positions',                  '200', 1, 5000, 12),
('limits.fiat_deposit_daily_limit',     '100000',  'number',  'limits', 'Fiat Daily Deposit Limit ($)',      'Maximum daily fiat deposits per client',              '100000', 100, 10000000, 13),
('limits.fiat_withdrawal_daily_limit',  '50000',   'number',  'limits', 'Fiat Daily Withdrawal Limit ($)',   'Maximum daily fiat withdrawals per client',           '50000', 100, 10000000, 14),
('limits.crypto_withdrawal_daily_usd',  '25000',   'number',  'limits', 'Crypto Daily Withdrawal Limit ($)', 'Maximum daily crypto withdrawals in USD equivalent', '25000', 100, 10000000, 15),
('limits.max_leverage',                 '4',       'number',  'limits', 'Max Leverage',                      'Maximum leverage allowed (4 = 4:1)',                 '4', 1, 100, 16),
('limits.dual_auth_threshold',          '10000',   'number',  'limits', 'Dual-Auth Withdrawal Threshold ($)', 'Withdrawals above this require admin approval',     '10000', 0, 10000000, 17),
('limits.new_bank_cooling_off_hours',   '24',      'number',  'limits', 'New Bank Cooling-Off (hours)',       'Wait period before withdrawals to new bank accounts', '24', 0, 168, 18);

-- ── KYC ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, sort_order) VALUES
('kyc.require_for_trading',             'true',    'boolean', 'kyc', 'Require KYC for Trading',              'Block trading until KYC approved',                    'true', 10),
('kyc.require_for_deposits',            'false',   'boolean', 'kyc', 'Require KYC for Deposits',             'Block deposits until KYC approved',                   'false', 11),
('kyc.require_for_withdrawals',         'true',    'boolean', 'kyc', 'Require KYC for Withdrawals',          'Block withdrawals until KYC approved',                'true', 12),
('kyc.auto_approve_threshold_usd',      '0',       'number',  'kyc', 'Auto-Approve Threshold ($)',           'Auto-approve KYC below this AUM (0 = manual only)',   '0', 13),
('kyc.rekyc_interval_months',           '12',      'number',  'kyc', 'Re-KYC Interval (months)',             'Months before re-verification required',              '12', 14),
('kyc.max_document_size_mb',            '10',      'number',  'kyc', 'Max Document Upload Size (MB)',        'Maximum KYC document file size',                      '10', 15),
('kyc.allowed_document_types',          '["passport","national_id","drivers_license","proof_of_address","selfie","tax_document"]', 'json', 'kyc', 'Allowed Document Types', 'Document types accepted for KYC', '["passport","national_id","drivers_license","proof_of_address","selfie","tax_document"]', 16);

-- ── SECURITY ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, sort_order, is_sensitive) VALUES
('security.jwt_access_expiry',          '15m',     'string',  'security', 'Access Token Expiry',             'JWT access token lifetime',                           '15m', 10, false),
('security.jwt_refresh_expiry',         '7d',      'string',  'security', 'Refresh Token Expiry',            'JWT refresh token lifetime',                          '7d', 11, false),
('security.max_login_attempts',         '5',       'number',  'security', 'Max Login Attempts',              'Failed logins before lockout',                        '5', 12, false),
('security.lockout_duration_minutes',   '30',      'number',  'security', 'Lockout Duration (minutes)',      'Account lockout duration after max attempts',         '30', 13, false),
('security.require_mfa_admin',          'true',    'boolean', 'security', 'Require MFA for Admins',          'Force MFA for admin/operations roles',                'true', 14, false),
('security.require_mfa_withdrawals',    'true',    'boolean', 'security', 'Require MFA for Withdrawals',     'Require MFA verification for withdrawal requests',   'true', 15, false),
('security.session_timeout_minutes',    '30',      'number',  'security', 'Session Timeout (minutes)',        'Auto-logout after inactivity',                       '30', 16, false),
('security.trusted_device_days',        '30',      'number',  'security', 'Trusted Device Duration (days)',   'How long a device stays trusted',                    '30', 17, false),
('security.password_min_length',        '8',       'number',  'security', 'Min Password Length',              'Minimum password characters',                        '8', 18, false),
('security.ip_whitelist_enabled',       'false',   'boolean', 'security', 'IP Whitelist Enabled',             'Only allow access from whitelisted IPs',             'false', 19, false),
('security.ip_whitelist',               '[]',      'json',    'security', 'IP Whitelist',                     'Allowed IP addresses (JSON array)',                   '[]', 20, false);

-- ── RATE LIMITS ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, min_value, max_value, sort_order) VALUES
('ratelimit.api_requests_per_minute',   '60',      'number',  'ratelimit', 'API Requests/Minute',            'Default rate limit per IP per minute',                '60', 10, 10000, 10),
('ratelimit.auth_attempts_per_minute',  '10',      'number',  'ratelimit', 'Auth Attempts/Minute',           'Login/auth rate limit per IP',                        '10', 1, 100, 11),
('ratelimit.orders_per_minute',         '30',      'number',  'ratelimit', 'Orders/Minute',                  'Order submission rate limit per client',               '30', 1, 1000, 12),
('ratelimit.transfers_per_hour',        '10',      'number',  'ratelimit', 'Transfers/Hour',                 'Transfer request rate limit per client',               '10', 1, 100, 13),
('ratelimit.websocket_messages_per_sec','50',      'number',  'ratelimit', 'WebSocket Msgs/Second',          'Max WebSocket messages per connection',                '50', 5, 1000, 14);

-- ── NOTIFICATIONS ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, sort_order) VALUES
('notifications.email_enabled',         'true',    'boolean', 'notifications', 'Email Notifications',         'Send email notifications',                           'true', 10),
('notifications.push_enabled',          'true',    'boolean', 'notifications', 'Push Notifications',          'Send mobile push notifications',                     'true', 11),
('notifications.sms_enabled',           'false',   'boolean', 'notifications', 'SMS Notifications',           'Send SMS notifications',                             'false', 12),
('notifications.daily_summary_enabled', 'true',    'boolean', 'notifications', 'Daily Portfolio Summary',     'Send daily portfolio summary at EOD',                 'true', 13),
('notifications.daily_summary_time',    '18:00',   'string',  'notifications', 'Daily Summary Time (ET)',     'Time to send daily summary',                         '18:00', 14),
('notifications.margin_call_channels',  '["email","push","sms"]', 'json', 'notifications', 'Margin Call Channels', 'Channels for margin call alerts',               '["email","push","sms"]', 15),
('notifications.support_email',         'support@t1broker.com', 'string', 'notifications', 'Support Email', 'Support contact email shown to clients',              'support@t1broker.com', 16);

-- ── BRANDING ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, sort_order) VALUES
('branding.platform_name',             'T1 Broker',           'string', 'branding', 'Platform Name',             'Public-facing platform name',                        'T1 Broker', 10),
('branding.company_name',              'T1 Financial Ltd',    'string', 'branding', 'Company Legal Name',        'Legal entity name for documents',                    'T1 Financial Ltd', 11),
('branding.support_url',               'https://support.t1broker.com', 'string', 'branding', 'Support URL',    'Customer support URL',                               'https://support.t1broker.com', 12),
('branding.terms_url',                 'https://t1broker.com/terms',   'string', 'branding', 'Terms of Service URL', 'Terms of service URL',                         'https://t1broker.com/terms', 13),
('branding.privacy_url',               'https://t1broker.com/privacy', 'string', 'branding', 'Privacy Policy URL',   'Privacy policy URL',                           'https://t1broker.com/privacy', 14),
('branding.primary_color',             '#3b82f6',             'string', 'branding', 'Primary Color',             'Brand primary color (hex)',                          '#3b82f6', 15),
('branding.logo_url',                  '',                    'string', 'branding', 'Logo URL',                  'Platform logo URL',                                 '', 16);

-- ── SYSTEM ──
INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, sort_order, requires_restart) VALUES
('system.maintenance_mode',             'false',   'boolean', 'system', 'Maintenance Mode',               'Block all client activity (admin access only)',        'false', 10, false),
('system.maintenance_message',          '',        'string',  'system', 'Maintenance Message',            'Message shown during maintenance mode',                '', 11, false),
('system.registration_enabled',         'true',    'boolean', 'system', 'Client Registration Open',       'Allow new client signups',                            'true', 12, false),
('system.demo_mode',                    'false',   'boolean', 'system', 'Demo Mode',                      'Use simulated data (no real broker connections)',      'false', 13, true),
('system.log_level',                    'info',    'string',  'system', 'Log Level',                      'Server logging level',                                'info', 14, true),
('system.max_upload_size_mb',           '25',      'number',  'system', 'Max Upload Size (MB)',           'Maximum file upload size',                            '25', 15, true),
('system.backup_enabled',              'true',    'boolean', 'system', 'Auto Backups',                   'Enable automated database backups',                   'true', 16, false),
('system.backup_frequency_hours',       '6',       'number',  'system', 'Backup Frequency (hours)',       'Hours between automated backups',                     '6', 17, false),
('system.eod_snapshot_time',            '16:30',   'string',  'system', 'EOD Snapshot Time (ET)',         'Time to take end-of-day position snapshots',          '16:30', 18, false),
('system.settlement_auto_run',          'true',    'boolean', 'system', 'Auto-Run Settlement',            'Automatically run daily settlement batch',             'true', 19, false),
('system.settlement_time',              '17:00',   'string',  'system', 'Settlement Run Time (ET)',       'Time to run daily settlement',                        '17:00', 20, false);
