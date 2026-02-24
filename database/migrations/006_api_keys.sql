-- ================================================================
-- T1 BROKER — API KEYS TABLE
-- Migration 006: Programmatic trading access via API keys
-- ================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash        VARCHAR(128) NOT NULL UNIQUE,
  key_preview     VARCHAR(32) NOT NULL,
  label           VARCHAR(100) NOT NULL DEFAULT 'API Key',
  permissions     JSONB NOT NULL DEFAULT '["read","trade"]',
  ip_whitelist    JSONB DEFAULT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  expires_at      TIMESTAMPTZ DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ DEFAULT NULL,
  last_used_at    TIMESTAMPTZ DEFAULT NULL,
  last_used_ip    VARCHAR(45) DEFAULT NULL,
  usage_count     INTEGER NOT NULL DEFAULT 0
);

-- Indexes
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_active ON api_keys(user_id, is_active) WHERE is_active = true;

-- Comment
COMMENT ON TABLE api_keys IS 'Client API keys for programmatic trading access. Raw keys are SHA-256 hashed before storage.';
