-- ================================================================
-- T1 BROKER — MIGRATION 003
-- Market Data Providers, Brokerage Connector Config,
-- Crypto Omnibus Wallets, Custom Instruments, Internal Clearing
-- ================================================================

-- ================================================================
-- 1. MARKET DATA PROVIDER REGISTRY
-- Admin selects which APIs to use for real-time data
-- ================================================================

CREATE TYPE provider_status AS ENUM ('active', 'inactive', 'error', 'rate_limited');

CREATE TABLE market_data_providers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_code   VARCHAR(30) NOT NULL UNIQUE,     -- 'polygon', 'finnhub', 'alpha_vantage', etc.
    display_name    VARCHAR(100) NOT NULL,
    provider_type   VARCHAR(20) NOT NULL DEFAULT 'market_data',  -- 'market_data', 'crypto', 'forex', 'news'
    
    -- Capabilities
    supports_stocks     BOOLEAN DEFAULT false,
    supports_crypto     BOOLEAN DEFAULT false,
    supports_forex      BOOLEAN DEFAULT false,
    supports_options    BOOLEAN DEFAULT false,
    supports_websocket  BOOLEAN DEFAULT false,
    supports_historical BOOLEAN DEFAULT false,
    
    -- Connection config
    base_url        TEXT NOT NULL,
    ws_url          TEXT,
    auth_type       VARCHAR(20) DEFAULT 'api_key',  -- 'api_key', 'bearer', 'oauth2', 'hmac'
    auth_header     VARCHAR(50) DEFAULT 'X-API-Key', -- or 'Authorization', 'apikey' param, etc.
    auth_location   VARCHAR(20) DEFAULT 'header',   -- 'header', 'query', 'body'
    auth_param_name VARCHAR(50) DEFAULT 'apikey',   -- query param name if auth_location='query'
    
    -- Encrypted credentials (AES-256)
    api_key_encrypted       TEXT,
    api_secret_encrypted    TEXT,
    
    -- Rate limits
    rate_limit_per_minute   INT DEFAULT 60,
    rate_limit_per_day      INT DEFAULT 50000,
    requests_today          INT DEFAULT 0,
    last_request_at         TIMESTAMPTZ,
    
    -- Status
    status          provider_status DEFAULT 'inactive',
    priority        INT DEFAULT 10,               -- lower = higher priority (fallback ordering)
    error_message   TEXT,
    last_health_check TIMESTAMPTZ,
    
    -- Config
    is_primary_stocks  BOOLEAN DEFAULT false,      -- primary provider for this asset class
    is_primary_crypto  BOOLEAN DEFAULT false,
    is_primary_forex   BOOLEAN DEFAULT false,
    
    -- Metadata
    free_tier       BOOLEAN DEFAULT false,
    docs_url        TEXT,
    notes           TEXT,
    
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default providers
INSERT INTO market_data_providers (provider_code, display_name, provider_type, base_url, ws_url, auth_type, auth_location, auth_param_name, supports_stocks, supports_crypto, supports_forex, supports_options, supports_websocket, supports_historical, free_tier, rate_limit_per_minute, rate_limit_per_day, docs_url, priority) VALUES
('polygon',       'Polygon.io',       'market_data', 'https://api.polygon.io',             'wss://socket.polygon.io',         'api_key', 'query',  'apiKey',     true,  true,  true,  true,  true,  true,  true,  5,    500,     'https://polygon.io/docs',         1),
('finnhub',       'Finnhub',          'market_data', 'https://finnhub.io/api/v1',           'wss://ws.finnhub.io',             'api_key', 'query',  'token',      true,  true,  true,  false, true,  true,  true,  60,   30000,   'https://finnhub.io/docs/api',     2),
('alpha_vantage', 'Alpha Vantage',    'market_data', 'https://www.alphavantage.co/query',   NULL,                              'api_key', 'query',  'apikey',     true,  true,  true,  false, false, true,  true,  5,    500,     'https://www.alphavantage.co/documentation/', 3),
('twelve_data',   'Twelve Data',      'market_data', 'https://api.twelvedata.com',          'wss://ws.twelvedata.com',         'api_key', 'query',  'apikey',     true,  true,  true,  false, true,  true,  true,  8,    800,     'https://twelvedata.com/docs',     4),
('coingecko',     'CoinGecko',        'crypto',      'https://api.coingecko.com/api/v3',    NULL,                              'api_key', 'header', 'x-cg-demo-api-key', false, true, false, false, false, true, true, 30,  10000, 'https://www.coingecko.com/en/api/documentation', 5),
('binance',       'Binance',          'crypto',      'https://api.binance.com/api/v3',      'wss://stream.binance.com/ws',     'api_key', 'header', 'X-MBX-APIKEY', false, true, false, false, true, true,  true,  1200, 864000, 'https://binance-docs.github.io/apidocs/', 6),
('coinmarketcap', 'CoinMarketCap',    'crypto',      'https://pro-api.coinmarketcap.com/v1', NULL,                             'api_key', 'header', 'X-CMC_PRO_API_KEY', false, true, false, false, false, true, true, 30, 10000, 'https://coinmarketcap.com/api/documentation/', 7),
('yahoo_finance', 'Yahoo Finance',    'market_data', 'https://query1.finance.yahoo.com/v8', NULL,                              'api_key', 'header', 'X-API-KEY',   true,  false, true,  true,  false, true,  true,  60,   50000,  'https://www.yahoofinanceapi.com/', 8),
('iex_cloud',     'IEX Cloud',        'market_data', 'https://cloud.iexapis.com/stable',    'wss://cloud-sse.iexapis.com',     'api_key', 'query',  'token',       true,  true,  false, false, true,  true,  true,  100,  50000,  'https://iexcloud.io/docs/api/',   9),
('fixer',         'Fixer.io',         'forex',       'https://data.fixer.io/api',           NULL,                              'api_key', 'query',  'access_key',  false, false, true,  false, false, true,  true,  60,   1000,   'https://fixer.io/documentation',  10);


-- ================================================================
-- 2. BROKERAGE CONNECTOR CONFIGURATION
-- Admin manages API keys for Saxo, DriveWealth, custom brokers
-- ================================================================

CREATE TYPE connector_status AS ENUM ('connected', 'disconnected', 'error', 'configuring', 'disabled');

CREATE TABLE brokerage_connectors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    connector_code  VARCHAR(30) NOT NULL UNIQUE,   -- 'saxo', 'drivewealth', 'interactive_brokers', etc.
    display_name    VARCHAR(100) NOT NULL,
    broker_type     VARCHAR(30) NOT NULL DEFAULT 'internal', -- flexible; not constrained to broker_type enum
    
    -- Connection configuration
    base_url        TEXT NOT NULL,
    ws_url          TEXT,
    sandbox_url     TEXT,
    auth_type       VARCHAR(20) DEFAULT 'api_key',  -- 'api_key', 'oauth2', 'fix'
    
    -- Encrypted credentials
    api_key_encrypted       TEXT,
    api_secret_encrypted    TEXT,
    access_token_encrypted  TEXT,
    refresh_token_encrypted TEXT,
    client_id               VARCHAR(255),
    
    -- OAuth2 specific
    token_endpoint          TEXT,
    auth_endpoint           TEXT,
    redirect_uri            TEXT,
    token_expires_at        TIMESTAMPTZ,
    
    -- Operational settings
    environment     VARCHAR(20) DEFAULT 'sandbox',   -- 'sandbox', 'production'
    status          connector_status DEFAULT 'configuring',
    is_enabled      BOOLEAN DEFAULT false,
    
    -- Capabilities
    supports_equities    BOOLEAN DEFAULT false,
    supports_options     BOOLEAN DEFAULT false,
    supports_futures     BOOLEAN DEFAULT false,
    supports_forex       BOOLEAN DEFAULT false,
    supports_crypto      BOOLEAN DEFAULT false,
    supports_fractional  BOOLEAN DEFAULT false,
    
    -- Omnibus account details
    omnibus_account_id   VARCHAR(100),
    omnibus_account_name VARCHAR(255),
    
    -- Webhook configuration
    webhook_url          TEXT,
    webhook_secret       TEXT,
    
    -- Health / monitoring
    last_heartbeat       TIMESTAMPTZ,
    error_message        TEXT,
    latency_ms           INT,
    
    -- Metadata
    docs_url             TEXT,
    support_email        VARCHAR(255),
    notes                TEXT,
    
    configured_by        UUID REFERENCES users(id),
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default brokerage connectors
INSERT INTO brokerage_connectors (connector_code, display_name, broker_type, base_url, ws_url, sandbox_url, auth_type, environment, supports_equities, supports_options, supports_futures, supports_forex, supports_crypto, supports_fractional, docs_url) VALUES
('saxo',              'Saxo Bank',            'saxo',        'https://gateway.saxobank.com/openapi',     'wss://streaming.saxobank.com', 'https://gateway.saxobank.com/sim/openapi', 'oauth2', 'sandbox', true, true, true, true, false, false, 'https://www.developer.saxo/'),
('drivewealth',       'DriveWealth',          'drivewealth', 'https://bo-api.drivewealth.io/back-office', 'wss://stream.drivewealth.io', 'https://bo-api.drivewealth.io/back-office', 'api_key', 'sandbox', true, false, false, false, true, true, 'https://developer.drivewealth.com/'),
('interactive_brokers','Interactive Brokers',  'internal',    'https://localhost:5000/v1/api',             NULL, NULL, 'api_key', 'sandbox', true, true, true, true, true, true, 'https://ibkrcampus.com/ibkr-api-page/cpapi-v1/'),
('alpaca',            'Alpaca Markets',        'internal',    'https://api.alpaca.markets/v2',             'wss://stream.data.alpaca.markets/v2', 'https://paper-api.alpaca.markets/v2', 'api_key', 'sandbox', true, false, false, false, true, true, 'https://alpaca.markets/docs/'),
('internal',          'T1 Internal (Self-Clearing)', 'internal', 'internal://clearing-engine', NULL, NULL, 'none', 'production', true, false, false, true, true, true, NULL);


-- ================================================================
-- 3. CRYPTO OMNIBUS WALLET SYSTEM
-- Platform-level wallets per blockchain, client sub-accounts
-- ================================================================

CREATE TYPE wallet_type AS ENUM ('hot', 'cold', 'warm');
CREATE TYPE wallet_status AS ENUM ('active', 'locked', 'archived', 'pending_setup');
CREATE TYPE blockchain_network AS ENUM ('bitcoin', 'ethereum', 'solana', 'polygon_chain', 'bsc', 'avalanche', 'arbitrum', 'optimism', 'tron', 'litecoin', 'ripple', 'cardano', 'polkadot');
CREATE TYPE crypto_tx_status AS ENUM ('pending', 'confirming', 'confirmed', 'failed', 'cancelled');
CREATE TYPE crypto_tx_type AS ENUM ('deposit', 'withdrawal', 'internal_transfer', 'sweep', 'consolidation', 'fee');

-- Platform-level omnibus wallets (one per blockchain per type)
CREATE TABLE omnibus_wallets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_name         VARCHAR(100) NOT NULL,
    blockchain          blockchain_network NOT NULL,
    wallet_type         wallet_type NOT NULL DEFAULT 'hot',
    
    -- Wallet addresses
    address             VARCHAR(255) NOT NULL,
    address_tag         VARCHAR(100),            -- memo/tag for XRP, XLM, etc.
    
    -- Encrypted private key (HSM-backed in production)
    private_key_encrypted TEXT,                  -- AES-256 encrypted, HSM ref in production
    mnemonic_encrypted    TEXT,                  -- backup seed phrase encrypted
    derivation_path       VARCHAR(50),           -- e.g., "m/44'/60'/0'/0"
    
    -- Balances (updated by blockchain scanner)
    balance             DECIMAL(28,18) NOT NULL DEFAULT 0,
    balance_usd         DECIMAL(18,4) DEFAULT 0,
    pending_in          DECIMAL(28,18) DEFAULT 0,
    pending_out         DECIMAL(28,18) DEFAULT 0,
    
    -- Limits & thresholds
    max_balance         DECIMAL(28,18),          -- auto-sweep to cold when exceeded
    min_balance         DECIMAL(28,18),          -- alert when below threshold
    daily_withdrawal_limit DECIMAL(28,18),
    daily_withdrawn     DECIMAL(28,18) DEFAULT 0,
    
    -- Status
    status              wallet_status DEFAULT 'active',
    requires_multisig   BOOLEAN DEFAULT false,
    multisig_threshold  INT DEFAULT 2,           -- n-of-m signatures required
    
    -- Node connection
    rpc_endpoint        TEXT,
    explorer_url        TEXT,
    
    last_scanned_block  BIGINT DEFAULT 0,
    last_scan_at        TIMESTAMPTZ,
    
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(blockchain, wallet_type, address)
);

-- Client sub-wallets (derived addresses within omnibus)
CREATE TABLE client_crypto_accounts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id),
    blockchain          blockchain_network NOT NULL,
    omnibus_wallet_id   UUID NOT NULL REFERENCES omnibus_wallets(id),
    
    -- Client's deposit address (deterministic derivation)
    deposit_address     VARCHAR(255) NOT NULL,
    deposit_address_tag VARCHAR(100),
    derivation_index    INT NOT NULL,            -- HD wallet index
    
    -- Balances (book balances, tracked by platform)
    balance             DECIMAL(28,18) NOT NULL DEFAULT 0,
    available_balance   DECIMAL(28,18) NOT NULL DEFAULT 0,
    locked_balance      DECIMAL(28,18) DEFAULT 0,  -- in open orders / pending withdrawal
    
    -- Cumulative stats
    total_deposited     DECIMAL(28,18) DEFAULT 0,
    total_withdrawn     DECIMAL(28,18) DEFAULT 0,
    total_fees_paid     DECIMAL(28,18) DEFAULT 0,
    
    status              wallet_status DEFAULT 'active',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(client_id, blockchain),
    UNIQUE(deposit_address, blockchain)
);

-- Crypto transactions
CREATE TABLE crypto_transactions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID REFERENCES clients(id),
    client_crypto_account_id UUID REFERENCES client_crypto_accounts(id),
    omnibus_wallet_id   UUID REFERENCES omnibus_wallets(id),
    
    tx_type             crypto_tx_type NOT NULL,
    blockchain          blockchain_network NOT NULL,
    
    -- On-chain details
    tx_hash             VARCHAR(255),
    from_address        VARCHAR(255),
    to_address          VARCHAR(255),
    amount              DECIMAL(28,18) NOT NULL,
    fee                 DECIMAL(28,18) DEFAULT 0,
    token_symbol        VARCHAR(20),             -- NULL for native, e.g., 'USDT' for ERC-20
    token_contract      VARCHAR(255),            -- contract address for tokens
    
    -- Confirmations
    confirmations       INT DEFAULT 0,
    required_confirmations INT DEFAULT 6,
    block_number        BIGINT,
    block_hash          VARCHAR(255),
    
    -- USD value at time of transaction
    usd_value           DECIMAL(18,4),
    exchange_rate       DECIMAL(18,8),
    
    -- Status
    status              crypto_tx_status DEFAULT 'pending',
    error_message       TEXT,
    
    -- Approval (for withdrawals)
    approved_by         UUID REFERENCES users(id),
    approved_at         TIMESTAMPTZ,
    
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_crypto_tx_client ON crypto_transactions(client_id);
CREATE INDEX idx_crypto_tx_hash ON crypto_transactions(tx_hash);
CREATE INDEX idx_crypto_tx_status ON crypto_transactions(status);
CREATE INDEX idx_client_crypto_address ON client_crypto_accounts(deposit_address);

-- Supported tokens per blockchain (ERC-20, SPL, BEP-20, etc.)
CREATE TABLE supported_tokens (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    blockchain          blockchain_network NOT NULL,
    token_symbol        VARCHAR(20) NOT NULL,
    token_name          VARCHAR(100) NOT NULL,
    contract_address    VARCHAR(255) NOT NULL,
    decimals            INT NOT NULL DEFAULT 18,
    is_stablecoin       BOOLEAN DEFAULT false,
    is_enabled          BOOLEAN DEFAULT true,
    min_deposit         DECIMAL(28,18) DEFAULT 0,
    min_withdrawal      DECIMAL(28,18) DEFAULT 0,
    withdrawal_fee      DECIMAL(28,18) DEFAULT 0,
    icon_url            TEXT,
    coingecko_id        VARCHAR(100),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(blockchain, contract_address)
);

-- Seed common tokens
INSERT INTO supported_tokens (blockchain, token_symbol, token_name, contract_address, decimals, is_stablecoin, withdrawal_fee) VALUES
('ethereum', 'USDT', 'Tether USD',      '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6,  true, 0.001),
('ethereum', 'USDC', 'USD Coin',         '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6,  true, 0.001),
('ethereum', 'DAI',  'Dai Stablecoin',   '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, true, 0.001),
('ethereum', 'WETH', 'Wrapped Ether',    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, false, 0.0005),
('ethereum', 'WBTC', 'Wrapped Bitcoin',  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8,  false, 0.0001),
('ethereum', 'LINK', 'Chainlink',        '0x514910771AF9Ca656af840dff83E8264EcF986CA', 18, false, 0.01),
('ethereum', 'UNI',  'Uniswap',          '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 18, false, 0.05),
('solana',   'USDC', 'USD Coin (SOL)',   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, true, 0.01),
('bsc',      'USDT', 'Tether USD (BSC)', '0x55d398326f99059fF775485246999027B3197955', 18, true, 0.0005),
('bsc',      'BUSD', 'Binance USD',      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', 18, true, 0.0005),
('polygon_chain', 'USDC', 'USD Coin (Polygon)', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, true, 0.001),
('arbitrum', 'USDC', 'USD Coin (Arb)',   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, true, 0.0005);


-- ================================================================
-- 4. CUSTOM INSTRUMENTS & INTERNAL CLEARING
-- Admin creates private assets, custom pairs, internal matching
-- ================================================================

-- Extended instrument fields for custom/private assets
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT false;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false;  -- only visible to specific clients
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS base_currency VARCHAR(10);         -- for pairs: AAPL/USD
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS quote_currency VARCHAR(10);
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS settlement_type VARCHAR(20) DEFAULT 'T+2';  -- T+0, T+1, T+2, instant
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS clearing_method VARCHAR(20) DEFAULT 'external'; -- 'external', 'internal', 'self_clearing'
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS margin_requirement DECIMAL(5,4) DEFAULT 0.25; -- 25% margin
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(8,6) DEFAULT 0.001;   -- 0.1%
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';  -- flexible extra fields
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS visible_to JSONB DEFAULT '["all"]';  -- ["all"] or ["client_id_1", "partner_id_2"]

-- Internal clearing / matching engine
CREATE TYPE match_status AS ENUM ('open', 'partial', 'filled', 'cancelled', 'expired');

CREATE TABLE internal_order_book (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    client_id       UUID NOT NULL REFERENCES clients(id),
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    
    side            order_side NOT NULL,
    order_type      order_type NOT NULL,
    price           DECIMAL(18,8),               -- NULL for market orders
    quantity        DECIMAL(18,8) NOT NULL,
    filled_quantity DECIMAL(18,8) DEFAULT 0,
    remaining_qty   DECIMAL(18,8) NOT NULL,
    
    time_in_force   order_tif DEFAULT 'day',
    expire_at       TIMESTAMPTZ,
    
    status          match_status DEFAULT 'open',
    priority        BIGINT,                      -- time-based priority (sequence number)
    
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_iob_instrument_side ON internal_order_book(instrument_id, side, status);
CREATE INDEX idx_iob_price ON internal_order_book(instrument_id, side, price, priority);

-- Trade / fill records from internal matching
CREATE TABLE internal_trades (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_ref       VARCHAR(30) NOT NULL UNIQUE,
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    
    -- Buyer
    buy_order_id    UUID NOT NULL REFERENCES internal_order_book(id),
    buy_client_id   UUID NOT NULL REFERENCES clients(id),
    
    -- Seller
    sell_order_id   UUID NOT NULL REFERENCES internal_order_book(id),
    sell_client_id  UUID NOT NULL REFERENCES clients(id),
    
    -- Trade details
    price           DECIMAL(18,8) NOT NULL,
    quantity        DECIMAL(18,8) NOT NULL,
    total_value     DECIMAL(18,4) NOT NULL,
    
    -- Fees
    buy_commission   DECIMAL(18,4) DEFAULT 0,
    sell_commission   DECIMAL(18,4) DEFAULT 0,
    clearing_fee      DECIMAL(18,4) DEFAULT 0,
    
    -- Settlement
    settlement_type   VARCHAR(20) DEFAULT 'T+2',
    settlement_date   DATE NOT NULL,
    is_settled        BOOLEAN DEFAULT false,
    settled_at        TIMESTAMPTZ,
    
    -- Audit
    matched_at       TIMESTAMPTZ DEFAULT NOW(),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_internal_trades_instrument ON internal_trades(instrument_id);
CREATE INDEX idx_internal_trades_settlement ON internal_trades(settlement_date, is_settled);

-- Settlement batch runs
CREATE TABLE settlement_runs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    settlement_date DATE NOT NULL,
    trades_count    INT DEFAULT 0,
    total_volume    DECIMAL(18,4) DEFAULT 0,
    total_fees      DECIMAL(18,4) DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'pending',  -- pending, processing, completed, failed
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    run_by          UUID REFERENCES users(id),
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
