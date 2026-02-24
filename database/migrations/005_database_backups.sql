-- ================================================================
-- T1 BROKER — MIGRATION 005
-- Database Backup & Archive Tracking
-- ================================================================

CREATE TABLE database_backups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Backup identification
    filename        VARCHAR(255) NOT NULL,
    filepath        TEXT NOT NULL,
    
    -- Metadata
    backup_type     VARCHAR(20) NOT NULL DEFAULT 'full',     -- full, incremental, schema_only
    trigger_type    VARCHAR(20) NOT NULL DEFAULT 'scheduled', -- scheduled, manual, pre_deploy
    file_size_bytes BIGINT,
    file_size_human VARCHAR(20),
    
    -- Content scope
    tables_included INT,                -- number of tables backed up
    total_rows      BIGINT,             -- approximate row count at backup time
    
    -- Status
    status          VARCHAR(20) NOT NULL DEFAULT 'in_progress', -- in_progress, completed, failed, deleted, uploaded
    error_message   TEXT,
    
    -- S3 / remote storage
    s3_bucket       VARCHAR(255),
    s3_key          VARCHAR(500),
    s3_uploaded_at  TIMESTAMPTZ,
    
    -- Checksums for integrity
    checksum_sha256 VARCHAR(64),
    
    -- Timing
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INT,
    
    -- Who triggered
    triggered_by    UUID REFERENCES users(id),   -- NULL = system/scheduler
    ip_address      INET,
    notes           TEXT,
    
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_backups_status ON database_backups(status);
CREATE INDEX idx_backups_trigger ON database_backups(trigger_type);
CREATE INDEX idx_backups_date ON database_backups(started_at DESC);

-- ================================================================
-- REPLACE GENERIC BACKUP SETTINGS WITH TWICE-DAILY SCHEDULE
-- ================================================================
DELETE FROM platform_settings WHERE key IN (
    'system.backup_frequency_hours'
);

INSERT INTO platform_settings (key, value, value_type, category, label, description, default_value, sort_order, requires_restart) VALUES
('system.backup_time_1',             '06:00',   'string',  'system', 'Backup Schedule — Time 1 (UTC)',   'First daily backup time in UTC (HH:MM)',              '06:00', 17, false),
('system.backup_time_2',             '18:00',   'string',  'system', 'Backup Schedule — Time 2 (UTC)',   'Second daily backup time in UTC (HH:MM)',             '18:00', 18, false),
('system.backup_retention_days',     '30',      'number',  'system', 'Backup Retention (days)',           'Auto-delete backups older than this many days',       '30', 19, false),
('system.backup_s3_enabled',         'false',   'boolean', 'system', 'Upload Backups to S3',             'Automatically upload backups to AWS S3',               'false', 20, false),
('system.backup_s3_bucket',          '',        'string',  'system', 'S3 Bucket Name',                   'AWS S3 bucket for remote backup storage',             '', 21, false),
('system.backup_max_concurrent',     '1',       'number',  'system', 'Max Concurrent Backups',           'Maximum simultaneous backup operations',               '1', 22, false)
ON CONFLICT (key) DO NOTHING;
