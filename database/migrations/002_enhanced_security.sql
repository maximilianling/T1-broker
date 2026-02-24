-- ================================================================
-- T1 BROKER — SECURITY ENHANCEMENT MIGRATION
-- Run after initial schema: psql -f database/migrations/002_enhanced_security.sql
-- ================================================================

-- Backup/recovery codes for MFA
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash       VARCHAR(128) NOT NULL,  -- bcrypt hash of the 8-char code
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON mfa_backup_codes(user_id, used_at);

-- Trusted devices (skip MFA for recognized devices)
CREATE TABLE IF NOT EXISTS trusted_devices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash     VARCHAR(128) NOT NULL,  -- SHA-256 of fingerprint
    device_name     VARCHAR(255),           -- "Chrome on macOS", "Safari on iPhone"
    ip_address      INET,
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,   -- 30 days from creation
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trusted_device_user ON trusted_devices(user_id, device_hash);
CREATE INDEX IF NOT EXISTS idx_trusted_device_expiry ON trusted_devices(expires_at);

-- Login history for anomaly detection
CREATE TABLE IF NOT EXISTS login_history (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address      INET NOT NULL,
    user_agent      TEXT,
    device_hash     VARCHAR(128),
    country         VARCHAR(3),
    city            VARCHAR(100),
    login_result    VARCHAR(20) NOT NULL,   -- 'success', 'failed', 'mfa_required', 'locked', 'blocked'
    mfa_method      VARCHAR(20),            -- 'totp', 'email', 'backup_code', 'trusted_device', null
    risk_score      SMALLINT DEFAULT 0,     -- 0-100
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_ip ON login_history(ip_address, created_at DESC);

-- Email verification codes (for email-based 2FA and email verification)
CREATE TABLE IF NOT EXISTS email_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash       VARCHAR(128) NOT NULL,
    purpose         VARCHAR(20) NOT NULL,   -- 'mfa', 'verify_email', 'confirm_action'
    attempts        SMALLINT NOT NULL DEFAULT 0,
    max_attempts    SMALLINT NOT NULL DEFAULT 3,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id, purpose, used_at);

-- Add columns to users if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='mfa_backup_generated_at') THEN
        ALTER TABLE users ADD COLUMN mfa_backup_generated_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='mfa_email_enabled') THEN
        ALTER TABLE users ADD COLUMN mfa_email_enabled BOOLEAN NOT NULL DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='security_stamp') THEN
        ALTER TABLE users ADD COLUMN security_stamp VARCHAR(64);
    END IF;
END $$;

-- Add session fingerprint column
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_sessions' AND column_name='device_fingerprint') THEN
        ALTER TABLE user_sessions ADD COLUMN device_fingerprint VARCHAR(128);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_sessions' AND column_name='country') THEN
        ALTER TABLE user_sessions ADD COLUMN country VARCHAR(3);
    END IF;
END $$;

-- Clean up expired email codes and trusted devices (run via cron)
-- DELETE FROM email_codes WHERE expires_at < NOW();
-- DELETE FROM trusted_devices WHERE expires_at < NOW();

-- Push notification tokens for mobile devices
CREATE TABLE IF NOT EXISTS push_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           TEXT NOT NULL,
    platform        VARCHAR(20) NOT NULL DEFAULT 'unknown', -- 'ios', 'android', 'web'
    device_name     VARCHAR(255),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
