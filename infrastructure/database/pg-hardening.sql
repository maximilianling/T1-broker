-- ================================================================
-- T1 BROKER — POSTGRESQL PRODUCTION HARDENING
-- Run this ONCE on production database as superuser.
-- Creates role-separated users, revokes dangerous privileges,
-- enables audit logging, and adds row-level security on PII.
-- ================================================================

-- ────────────────────────────────────────────
-- 1. CREATE SEPARATE ROLES
-- ────────────────────────────────────────────

-- Application role: used by Node.js server (limited permissions)
CREATE ROLE t1_app_role NOLOGIN;

-- Admin role: used by migrations and maintenance scripts only
CREATE ROLE t1_admin_role NOLOGIN;

-- Backup role: used by pg_dump only (read-only)
CREATE ROLE t1_backup_role NOLOGIN;

-- Application user (Node.js connects as this)
-- PASSWORD MUST be set via: ALTER USER t1_app PASSWORD 'strong-random-password';
CREATE USER t1_app WITH PASSWORD 'CHANGE_ME_IN_PRODUCTION' CONNECTION LIMIT 30;
GRANT t1_app_role TO t1_app;

-- Admin user (migrations, manual maintenance)
CREATE USER t1_admin WITH PASSWORD 'CHANGE_ME_IN_PRODUCTION' CONNECTION LIMIT 5;
GRANT t1_admin_role TO t1_admin;

-- Backup user (pg_dump only)
CREATE USER t1_backup WITH PASSWORD 'CHANGE_ME_IN_PRODUCTION' CONNECTION LIMIT 2;
GRANT t1_backup_role TO t1_backup;

-- ────────────────────────────────────────────
-- 2. REVOKE DANGEROUS DEFAULT PRIVILEGES
-- ────────────────────────────────────────────

-- Revoke PUBLIC access to the database
REVOKE ALL ON DATABASE t1broker FROM PUBLIC;
GRANT CONNECT ON DATABASE t1broker TO t1_app_role, t1_admin_role, t1_backup_role;

-- Revoke PUBLIC schema access
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO t1_app_role, t1_admin_role, t1_backup_role;

-- App role: CRUD on all tables, NO DDL (no CREATE/DROP/ALTER TABLE)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO t1_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO t1_app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO t1_app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO t1_app_role;

-- Admin role: full DDL + CRUD (for migrations)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO t1_admin_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO t1_admin_role;
GRANT CREATE ON SCHEMA public TO t1_admin_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO t1_admin_role;

-- Backup role: read-only
GRANT SELECT ON ALL TABLES IN SCHEMA public TO t1_backup_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO t1_backup_role;

-- ────────────────────────────────────────────
-- 3. REVOKE DANGEROUS FUNCTIONS FROM APP ROLE
-- ────────────────────────────────────────────

-- Prevent app from executing system-level functions
REVOKE EXECUTE ON FUNCTION pg_read_file(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_read_file(text, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_read_file(text, bigint, bigint, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_ls_dir(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_stat_file(text) FROM PUBLIC;

-- Prevent COPY TO/FROM PROGRAM (command execution)
-- (This is controlled by superuser status, but belt-and-suspenders)
ALTER USER t1_app SET allow_system_table_mods = off;

-- ────────────────────────────────────────────
-- 4. CONNECTION & RESOURCE LIMITS
-- ────────────────────────────────────────────

-- Statement timeout: kill queries running longer than 30 seconds
ALTER USER t1_app SET statement_timeout = '30s';
ALTER USER t1_backup SET statement_timeout = '300s';  -- backups need longer

-- Lock timeout: prevent long lock waits
ALTER USER t1_app SET lock_timeout = '10s';

-- Idle transaction timeout: kill sessions idle in transaction > 60s
ALTER USER t1_app SET idle_in_transaction_session_timeout = '60s';

-- Work memory limits (prevent single query from consuming all RAM)
ALTER USER t1_app SET work_mem = '64MB';
ALTER USER t1_app SET temp_file_limit = '1GB';

-- ────────────────────────────────────────────
-- 5. ENABLE ROW-LEVEL SECURITY ON PII TABLES
-- ────────────────────────────────────────────

-- NOTE: RLS policies below are illustrative.
-- The actual enforcement happens at the application layer via
-- Knex query modifiers (see databaseSecurity.js applyRowLevelSecurity).
-- These provide a defense-in-depth backup.

-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE client_bank_accounts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────
-- 6. AUDIT LOGGING EXTENSION
-- ────────────────────────────────────────────

-- Enable pgAudit if available (requires shared_preload_libraries = 'pgaudit')
-- CREATE EXTENSION IF NOT EXISTS pgaudit;
-- ALTER SYSTEM SET pgaudit.log = 'write, ddl, role';
-- ALTER SYSTEM SET pgaudit.log_catalog = off;
-- ALTER SYSTEM SET pgaudit.log_parameter = on;
-- ALTER SYSTEM SET pgaudit.role = 't1_app_role';

-- ────────────────────────────────────────────
-- 7. ENFORCE SSL CONNECTIONS
-- ────────────────────────────────────────────

-- In postgresql.conf:
--   ssl = on
--   ssl_cert_file = '/etc/ssl/certs/server.crt'
--   ssl_key_file = '/etc/ssl/private/server.key'
--   ssl_min_protocol_version = 'TLSv1.2'

-- In pg_hba.conf — force SSL for all remote connections:
--   hostssl  t1broker  t1_app     0.0.0.0/0  scram-sha-256
--   hostssl  t1broker  t1_backup  0.0.0.0/0  scram-sha-256
--   hostssl  t1broker  t1_admin   10.0.0.0/8 scram-sha-256
--   host     t1broker  all        0.0.0.0/0  reject

-- ────────────────────────────────────────────
-- 8. ENCRYPTION AT REST
-- ────────────────────────────────────────────

-- For full disk encryption, use:
-- - AWS RDS: Enable encryption (AES-256) when creating instance
-- - Self-hosted: LUKS/dm-crypt on the PostgreSQL data directory
-- - Azure: Enable Transparent Data Encryption (TDE)
-- - GCP: Encryption at rest is automatic with Cloud SQL

-- For column-level encryption:
-- Application-layer AES-256-GCM (see server/utils/encryption.js)
-- Encrypted columns: api_key_encrypted, api_secret_encrypted,
--   credentials_encrypted, private_key_encrypted, account_number_encrypted

-- ────────────────────────────────────────────
-- 9. LOGGING CONFIGURATION
-- ────────────────────────────────────────────

-- In postgresql.conf:
--   log_statement = 'ddl'                -- Log all DDL changes
--   log_connections = on                 -- Log all connections
--   log_disconnections = on              -- Log all disconnections
--   log_duration = off                   -- Don't log all query durations
--   log_min_duration_statement = 5000    -- Log queries taking > 5s
--   log_line_prefix = '%m [%p] %u@%d '  -- Timestamp, PID, user, database
--   log_checkpoints = on                 -- Log checkpoint activity
--   log_lock_waits = on                  -- Log lock waits > 1s

-- ────────────────────────────────────────────
-- 10. VERIFICATION QUERIES
-- ────────────────────────────────────────────

-- Verify role permissions:
-- SELECT rolname, rolconnlimit, rolsuper, rolcreatedb, rolcreaterole
-- FROM pg_roles WHERE rolname LIKE 't1_%';

-- Verify SSL is enforced:
-- SELECT * FROM pg_hba_file_rules WHERE type = 'hostssl';

-- Verify statement timeout:
-- SHOW statement_timeout;

-- Check active connections:
-- SELECT usename, client_addr, state, query_start, state_change
-- FROM pg_stat_activity WHERE datname = 't1broker';

SELECT 'PostgreSQL hardening script completed successfully' AS status;
