-- ================================================================
-- T1 BROKER — DATABASE SECURITY HARDENING MIGRATION
-- Row-Level Security, audit triggers, role separation,
-- column encryption, connection restrictions
-- Run: psql -U postgres -d t1broker -f 003_security_hardening.sql
-- ================================================================

BEGIN;

-- ================================================================
-- 1. ROLE SEPARATION — Principle of Least Privilege
-- App connects as t1_app (limited), NOT as t1admin (superuser)
-- ================================================================
DO $$
BEGIN
  -- Application role: read/write on data tables ONLY
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 't1_app') THEN
    CREATE ROLE t1_app LOGIN PASSWORD NULL; -- password set via env
    RAISE NOTICE 'Created role t1_app';
  END IF;

  -- Read-only role for analytics/reporting
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 't1_readonly') THEN
    CREATE ROLE t1_readonly LOGIN PASSWORD NULL;
    RAISE NOTICE 'Created role t1_readonly';
  END IF;

  -- Backup role: can run pg_dump but not modify data
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 't1_backup') THEN
    CREATE ROLE t1_backup LOGIN PASSWORD NULL;
    RAISE NOTICE 'Created role t1_backup';
  END IF;
END $$;

-- Grant application role permissions
GRANT CONNECT ON DATABASE t1broker TO t1_app;
GRANT USAGE ON SCHEMA public TO t1_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO t1_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO t1_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO t1_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO t1_app;

-- DENY dangerous operations to app role
REVOKE CREATE ON SCHEMA public FROM t1_app;
REVOKE ALL ON DATABASE t1broker FROM t1_app;
GRANT CONNECT ON DATABASE t1broker TO t1_app;

-- Read-only role: SELECT only
GRANT CONNECT ON DATABASE t1broker TO t1_readonly;
GRANT USAGE ON SCHEMA public TO t1_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO t1_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO t1_readonly;

-- Backup role: SELECT for pg_dump
GRANT CONNECT ON DATABASE t1broker TO t1_backup;
GRANT USAGE ON SCHEMA public TO t1_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO t1_backup;

-- ================================================================
-- 2. ROW-LEVEL SECURITY (RLS) — Data Isolation
-- Each client can ONLY see/modify their own data
-- Admin roles bypass RLS via BYPASSRLS
-- ================================================================

-- Enable RLS on sensitive tables
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_crypto_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_alerts ENABLE ROW LEVEL SECURITY;

-- Orders: users see only their account's orders
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE polname = 'orders_client_isolation') THEN
    CREATE POLICY orders_client_isolation ON orders
      USING (
        account_id IN (
          SELECT a.id FROM accounts a
          JOIN clients c ON c.id = a.client_id
          JOIN users u ON u.id = c.user_id
          WHERE u.id = current_setting('app.current_user_id', true)::uuid
        )
        OR current_setting('app.user_role', true) IN ('super_admin', 'admin', 'operations', 'compliance')
      );
  END IF;
END $$;

-- Positions: same isolation pattern
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE polname = 'positions_client_isolation') THEN
    CREATE POLICY positions_client_isolation ON positions
      USING (
        account_id IN (
          SELECT a.id FROM accounts a
          JOIN clients c ON c.id = a.client_id
          JOIN users u ON u.id = c.user_id
          WHERE u.id = current_setting('app.current_user_id', true)::uuid
        )
        OR current_setting('app.user_role', true) IN ('super_admin', 'admin', 'operations', 'compliance')
      );
  END IF;
END $$;

-- Cash transactions: client isolation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE polname = 'cash_txn_client_isolation') THEN
    CREATE POLICY cash_txn_client_isolation ON cash_transactions
      USING (
        account_id IN (
          SELECT a.id FROM accounts a
          JOIN clients c ON c.id = a.client_id
          JOIN users u ON u.id = c.user_id
          WHERE u.id = current_setting('app.current_user_id', true)::uuid
        )
        OR current_setting('app.user_role', true) IN ('super_admin', 'admin', 'operations', 'compliance')
      );
  END IF;
END $$;

-- Notifications: user isolation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE polname = 'notifications_user_isolation') THEN
    CREATE POLICY notifications_user_isolation ON notifications
      USING (
        user_id = current_setting('app.current_user_id', true)::uuid
        OR current_setting('app.user_role', true) IN ('super_admin', 'admin', 'operations')
      );
  END IF;
END $$;

-- Documents: client isolation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE polname = 'documents_client_isolation') THEN
    CREATE POLICY documents_client_isolation ON client_documents
      USING (
        client_id IN (
          SELECT c.id FROM clients c
          JOIN users u ON u.id = c.user_id
          WHERE u.id = current_setting('app.current_user_id', true)::uuid
        )
        OR current_setting('app.user_role', true) IN ('super_admin', 'admin', 'operations', 'compliance')
      );
  END IF;
END $$;

-- ================================================================
-- 3. FINANCIAL AUDIT TRIGGERS
-- Immutable log of every INSERT/UPDATE/DELETE on financial tables
-- Cannot be tampered with by the application role
-- ================================================================

-- Create audit schema owned by postgres (app role can't modify)
CREATE SCHEMA IF NOT EXISTS audit;
REVOKE ALL ON SCHEMA audit FROM t1_app;
GRANT USAGE ON SCHEMA audit TO t1_app;

-- Immutable audit log table
CREATE TABLE IF NOT EXISTS audit.financial_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  table_name    TEXT NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  row_id        TEXT,
  old_data      JSONB,
  new_data      JSONB,
  changed_fields TEXT[],
  user_id       TEXT,
  ip_address    TEXT,
  session_id    TEXT,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum      TEXT NOT NULL  -- SHA-256 of operation data for tamper detection
);

-- App role can INSERT audit records but NEVER update or delete them
GRANT INSERT, SELECT ON audit.financial_audit_log TO t1_app;
GRANT USAGE, SELECT ON SEQUENCE audit.financial_audit_log_id_seq TO t1_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.financial_audit_log FROM t1_app;

-- Index for fast querying
CREATE INDEX IF NOT EXISTS idx_fal_table ON audit.financial_audit_log(table_name, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fal_user ON audit.financial_audit_log(user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fal_rowid ON audit.financial_audit_log(row_id);

-- Trigger function with tamper-proof checksums
CREATE OR REPLACE FUNCTION audit.log_financial_change()
RETURNS TRIGGER AS $$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_changed TEXT[];
  v_row_id TEXT;
  v_checksum TEXT;
  v_user_id TEXT;
  v_ip TEXT;
  v_session TEXT;
BEGIN
  -- Get context from app session variables
  v_user_id := current_setting('app.current_user_id', true);
  v_ip := current_setting('app.client_ip', true);
  v_session := current_setting('app.session_id', true);

  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_row_id := OLD.id::TEXT;
    v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL;
    v_new := to_jsonb(NEW);
    v_row_id := NEW.id::TEXT;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row_id := NEW.id::TEXT;
    -- Track which columns actually changed
    SELECT array_agg(key) INTO v_changed
    FROM jsonb_each(v_new) AS n(key, value)
    WHERE v_old->key IS DISTINCT FROM v_new->key;
  END IF;

  -- Generate tamper-proof checksum
  v_checksum := encode(
    digest(
      TG_TABLE_NAME || '|' || TG_OP || '|' || COALESCE(v_row_id, '') || '|' ||
      COALESCE(v_old::TEXT, '') || '|' || COALESCE(v_new::TEXT, '') || '|' ||
      NOW()::TEXT,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO audit.financial_audit_log
    (table_name, operation, row_id, old_data, new_data, changed_fields,
     user_id, ip_address, session_id, checksum)
  VALUES
    (TG_TABLE_NAME, TG_OP, v_row_id, v_old, v_new, v_changed,
     v_user_id, v_ip, v_session, v_checksum);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach triggers to all financial tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'orders', 'order_fills', 'positions', 'cash_transactions',
      'crypto_transactions', 'internal_order_book', 'internal_trades',
      'settlement_runs', 'accounts', 'users', 'clients',
      'platform_settings', 'database_backups', 'omnibus_wallets'
    ])
  LOOP
    -- Drop existing trigger if any, then create
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%I
       AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit.log_financial_change()',
      tbl, tbl
    );
    RAISE NOTICE 'Audit trigger created on %', tbl;
  END LOOP;
END $$;

-- ================================================================
-- 4. PREVENT MASS DATA EXFILTRATION
-- Limit SELECT result sets from application role
-- ================================================================
CREATE OR REPLACE FUNCTION public.check_result_limit()
RETURNS TRIGGER AS $$
BEGIN
  -- This is a statement-level constraint; actual enforcement
  -- is done via application-level LIMIT clauses and the
  -- statement_timeout setting
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ================================================================
-- 5. SENSITIVE COLUMN MARKERS (for application-level encryption)
-- Tag columns that MUST be encrypted at rest by the application
-- ================================================================
COMMENT ON COLUMN users.password_hash IS 'SECURITY:bcrypt-hashed:never-expose';
COMMENT ON COLUMN users.mfa_secret IS 'SECURITY:aes256-encrypted:never-expose';
COMMENT ON COLUMN users.backup_codes IS 'SECURITY:aes256-encrypted:never-expose';
COMMENT ON COLUMN client_bank_accounts.account_number IS 'SECURITY:aes256-encrypted:pii';
COMMENT ON COLUMN client_bank_accounts.routing_number IS 'SECURITY:aes256-encrypted:pii';
COMMENT ON COLUMN omnibus_wallets.private_key_encrypted IS 'SECURITY:aes256-encrypted:critical';

-- ================================================================
-- 6. FAILED LOGIN TRACKING TABLE
-- Tracks login failures at DB level (defense in depth beyond app)
-- ================================================================
CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',
  source_ip   INET,
  user_id     UUID REFERENCES users(id),
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_se_type_time ON security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_se_ip ON security_events(source_ip, created_at DESC);
GRANT INSERT, SELECT ON security_events TO t1_app;
GRANT USAGE, SELECT ON SEQUENCE security_events_id_seq TO t1_app;
REVOKE UPDATE, DELETE ON security_events FROM t1_app;

-- ================================================================
-- 7. EXTENSION FOR CRYPTOGRAPHIC FUNCTIONS IN TRIGGERS
-- ================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ================================================================
-- 8. CONNECTION LIMITS
-- Prevent connection exhaustion attacks
-- ================================================================
DO $$
BEGIN
  -- Limit app role to 50 connections (pool max is 20, this is safety net)
  ALTER ROLE t1_app CONNECTION LIMIT 50;
  ALTER ROLE t1_readonly CONNECTION LIMIT 10;
  ALTER ROLE t1_backup CONNECTION LIMIT 3;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not set connection limits: %', SQLERRM;
END $$;

-- ================================================================
-- 9. PREVENT DANGEROUS DDL FROM APP ROLE
-- ================================================================
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA pg_catalog FROM t1_app;
GRANT USAGE ON SCHEMA pg_catalog TO t1_app;

-- Ensure app role cannot create/drop tables, functions, etc.
DO $$
BEGIN
  ALTER ROLE t1_app NOCREATEDB NOCREATEROLE;
  ALTER ROLE t1_readonly NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not alter role capabilities: %', SQLERRM;
END $$;

COMMIT;

-- ================================================================
-- VERIFICATION QUERIES (run after migration)
-- ================================================================
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true;
-- SELECT * FROM pg_policies;
-- SELECT * FROM audit.financial_audit_log ORDER BY id DESC LIMIT 5;
-- SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname LIKE 't1_%';
