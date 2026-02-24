// ================================================================
// T1 BROKER — DATABASE BACKUP SERVICE
// Full pg_dump-based backup with tracking, retention,
// integrity verification, and optional S3 upload
// ================================================================
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const settings = require('./platformSettings');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');

class DatabaseBackupService {

  // ================================================================
  // CREATE BACKUP
  // ================================================================
  static async createBackup({ triggerType = 'scheduled', triggeredBy = null, ipAddress = null, notes = null } = {}) {
    // Check if backups are enabled
    const enabled = await settings.getBool('system.backup_enabled', true);
    if (!enabled && triggerType === 'scheduled') {
      logger.debug('Scheduled backup skipped — backups disabled');
      return null;
    }

    // Check max concurrent
    const maxConcurrent = await settings.getNumber('system.backup_max_concurrent', 1);
    const inProgress = await db('database_backups').where('status', 'in_progress').count().first();
    if (parseInt(inProgress.count) >= maxConcurrent) {
      logger.warn('Backup skipped — max concurrent backups reached');
      throw new Error('Another backup is already in progress');
    }

    // Ensure backup directory exists
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `t1broker_${timestamp}.sql.gz`;
    const filepath = path.join(BACKUP_DIR, filename);
    const startTime = Date.now();

    // Create tracking record
    const [backup] = await db('database_backups').insert({
      filename,
      filepath,
      backup_type: 'full',
      trigger_type: triggerType,
      status: 'in_progress',
      started_at: new Date(),
      triggered_by: triggeredBy,
      ip_address: ipAddress,
      notes,
    }).returning('*');

    logger.info('Backup started', { id: backup.id, filename, triggerType });

    try {
      // Get table/row counts before backup
      const tableStats = await this._getTableStats();

      // Run pg_dump
      await this._runPgDump(filepath);

      // Verify file exists and get size
      const stat = fs.statSync(filepath);
      const fileSizeBytes = stat.size;
      const fileSizeHuman = this._humanSize(fileSizeBytes);

      // Calculate SHA-256 checksum
      const checksum = await this._calculateChecksum(filepath);

      const durationMs = Date.now() - startTime;

      // Update tracking record
      await db('database_backups').where('id', backup.id).update({
        status: 'completed',
        completed_at: new Date(),
        duration_ms: durationMs,
        file_size_bytes: fileSizeBytes,
        file_size_human: fileSizeHuman,
        checksum_sha256: checksum,
        tables_included: tableStats.tableCount,
        total_rows: tableStats.totalRows,
      });

      logger.info('Backup completed', {
        id: backup.id, filename, size: fileSizeHuman,
        duration: `${(durationMs / 1000).toFixed(1)}s`,
        tables: tableStats.tableCount, rows: tableStats.totalRows,
      });

      AuditService.log({
        userId: triggeredBy,
        action: `Database backup completed: ${filename} (${fileSizeHuman}, ${tableStats.totalRows} rows, ${(durationMs / 1000).toFixed(1)}s)`,
        resourceType: 'backup',
        resourceId: backup.id,
        level: 'info',
        ipAddress,
      });

      // Attempt S3 upload if enabled
      const s3Enabled = await settings.getBool('system.backup_s3_enabled', false);
      if (s3Enabled) {
        await this._uploadToS3(backup.id, filepath, filename).catch(err => {
          logger.error('S3 upload failed', { backupId: backup.id, error: err.message });
        });
      }

      // Run retention cleanup
      await this.cleanupOldBackups().catch(err => {
        logger.warn('Backup retention cleanup failed', { error: err.message });
      });

      return {
        id: backup.id,
        filename,
        size: fileSizeHuman,
        sizeBytes: fileSizeBytes,
        duration: durationMs,
        tables: tableStats.tableCount,
        rows: tableStats.totalRows,
        checksum,
      };

    } catch (err) {
      const durationMs = Date.now() - startTime;

      await db('database_backups').where('id', backup.id).update({
        status: 'failed',
        error_message: err.message,
        completed_at: new Date(),
        duration_ms: durationMs,
      });

      logger.error('Backup failed', { id: backup.id, error: err.message, duration: durationMs });

      AuditService.log({
        userId: triggeredBy,
        action: `Database backup FAILED: ${err.message}`,
        resourceType: 'backup',
        resourceId: backup.id,
        level: 'error',
        ipAddress,
      });

      throw err;
    }
  }

  // ================================================================
  // PG_DUMP EXECUTION
  // ================================================================
  static _runPgDump(outputPath) {
    return new Promise((resolve, reject) => {
      const dbConfig = {
        host: config.database?.host || process.env.DB_HOST || 'localhost',
        port: config.database?.port || process.env.DB_PORT || '5432',
        user: config.database?.user || process.env.DB_USER || 't1admin',
        database: config.database?.name || process.env.DB_NAME || 't1broker',
        password: config.database?.password || process.env.DB_PASSWORD || '',
      };

      const cmd = [
        `PGPASSWORD="${dbConfig.password}"`,
        'pg_dump',
        `-h "${dbConfig.host}"`,
        `-p "${dbConfig.port}"`,
        `-U "${dbConfig.user}"`,
        `-d "${dbConfig.database}"`,
        '--no-owner',
        '--no-privileges',
        '--format=custom',
        '--compress=6',
        '--verbose',
        `| gzip > "${outputPath}"`,
      ].join(' ');

      exec(cmd, { shell: '/bin/bash', timeout: 600000 }, (error, stdout, stderr) => {
        if (error) {
          // Check if it's just warnings
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            logger.warn('pg_dump had warnings but produced output', { stderr: stderr?.slice(0, 500) });
            resolve();
          } else {
            reject(new Error(`pg_dump failed: ${error.message}\n${stderr || ''}`));
          }
        } else {
          resolve();
        }
      });
    });
  }

  // ================================================================
  // CHECKSUM / INTEGRITY
  // ================================================================
  static _calculateChecksum(filepath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filepath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  static async verifyBackup(backupId) {
    const backup = await db('database_backups').where('id', backupId).first();
    if (!backup) throw new Error('Backup not found');
    if (!fs.existsSync(backup.filepath)) {
      return { valid: false, error: 'Backup file not found on disk' };
    }

    const currentChecksum = await this._calculateChecksum(backup.filepath);
    const isValid = currentChecksum === backup.checksum_sha256;

    return {
      valid: isValid,
      storedChecksum: backup.checksum_sha256,
      currentChecksum,
      fileExists: true,
      fileSize: fs.statSync(backup.filepath).size,
    };
  }

  // ================================================================
  // TABLE STATS
  // ================================================================
  static async _getTableStats() {
    try {
      const tables = await db.raw(`
        SELECT schemaname, relname as table_name, n_live_tup as row_count
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
        ORDER BY n_live_tup DESC
      `);

      const rows = tables.rows || [];
      return {
        tableCount: rows.length,
        totalRows: rows.reduce((sum, t) => sum + parseInt(t.row_count || 0), 0),
        tables: rows.map(t => ({ name: t.table_name, rows: parseInt(t.row_count || 0) })),
      };
    } catch {
      return { tableCount: 0, totalRows: 0, tables: [] };
    }
  }

  // ================================================================
  // S3 / DIGITALOCEAN SPACES UPLOAD (with encryption at rest)
  // DO Spaces uses S3-compatible API. Set DO_SPACES_ENDPOINT in env.
  // Backup files are encrypted with AES-256-GCM before upload.
  // ================================================================
  static async _uploadToS3(backupId, filepath, filename) {
    const bucket = await settings.get('system.backup_s3_bucket', '');
    if (!bucket) {
      logger.warn('Cloud upload skipped — no bucket configured');
      return;
    }

    // Encrypt backup file before upload (AES-256-GCM)
    const encryptedPath = filepath + '.enc';
    const encryptionEnabled = await settings.getBool('system.backup_encryption_enabled', true);

    let uploadPath = filepath;
    let uploadFilename = filename;

    if (encryptionEnabled) {
      try {
        await this._encryptFile(filepath, encryptedPath);
        uploadPath = encryptedPath;
        uploadFilename = filename + '.enc';
        logger.info('Backup encrypted for cloud upload', { backupId });
      } catch (encErr) {
        logger.error('Backup encryption failed — uploading unencrypted', {
          backupId, error: encErr.message,
        });
        // Fall through to upload unencrypted
      }
    }

    const s3Key = `backups/${uploadFilename}`;

    // Detect DO Spaces vs AWS S3 based on environment
    const endpoint = process.env.DO_SPACES_ENDPOINT || process.env.S3_ENDPOINT || '';
    const isSpaces = endpoint.includes('digitaloceanspaces.com');

    return new Promise((resolve, reject) => {
      let cmd;
      if (isSpaces) {
        // DigitalOcean Spaces — uses s3cmd or aws cli with --endpoint-url
        cmd = [
          'aws s3 cp',
          `"${uploadPath}"`,
          `"s3://${bucket}/${s3Key}"`,
          `--endpoint-url "https://${endpoint}"`,
          '--acl private',
          '--storage-class STANDARD',
        ].join(' ');
      } else {
        // Standard AWS S3
        cmd = `aws s3 cp "${uploadPath}" "s3://${bucket}/${s3Key}" --storage-class STANDARD_IA --sse aws:kms`;
      }

      exec(cmd, { timeout: 600000 }, async (error) => {
        // Clean up encrypted temp file
        if (encryptionEnabled && fs.existsSync(encryptedPath)) {
          try { fs.unlinkSync(encryptedPath); } catch (e) {}
        }

        if (error) {
          reject(new Error(`Cloud upload failed: ${error.message}`));
        } else {
          await db('database_backups').where('id', backupId).update({
            status: 'uploaded',
            s3_bucket: bucket,
            s3_key: s3Key,
            s3_uploaded_at: new Date(),
            encrypted: encryptionEnabled,
            cloud_provider: isSpaces ? 'digitalocean' : 'aws',
          });
          logger.info('Backup uploaded to cloud storage', {
            backupId, bucket, key: s3Key,
            provider: isSpaces ? 'DigitalOcean Spaces' : 'AWS S3',
            encrypted: encryptionEnabled,
          });
          resolve();
        }
      });
    });
  }

  // ================================================================
  // FILE ENCRYPTION (AES-256-GCM — same as field encryption)
  // Encrypts entire backup file with streaming cipher.
  // Header format: [4-byte magic][12-byte IV][16-byte auth tag][ciphertext]
  // ================================================================
  static _encryptFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const encKey = process.env.BACKUP_ENCRYPTION_KEY || config.encryption?.key || '';
      if (!encKey || encKey.length < 32) {
        return reject(new Error('BACKUP_ENCRYPTION_KEY must be at least 32 characters'));
      }

      const key = crypto.createHash('sha256').update(encKey).digest(); // Derive 32-byte key
      const iv = crypto.randomBytes(12); // 96-bit IV for GCM
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

      const input = fs.createReadStream(inputPath);
      const output = fs.createWriteStream(outputPath);

      // Write header: magic bytes + IV (auth tag appended after ciphertext)
      const magic = Buffer.from('T1BK'); // 4-byte magic identifier
      output.write(magic);
      output.write(iv);

      input.pipe(cipher).pipe(output);

      output.on('finish', () => {
        // Append auth tag at the end
        const authTag = cipher.getAuthTag();
        fs.appendFileSync(outputPath, authTag);
        resolve();
      });
      input.on('error', reject);
      cipher.on('error', reject);
      output.on('error', reject);
    });
  }

  // ================================================================
  // FILE DECRYPTION (for restore operations)
  // ================================================================
  static _decryptFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const encKey = process.env.BACKUP_ENCRYPTION_KEY || config.encryption?.key || '';
      const key = crypto.createHash('sha256').update(encKey).digest();

      const fileData = fs.readFileSync(inputPath);

      // Parse header: [4-byte magic][12-byte IV][...ciphertext...][16-byte auth tag]
      const magic = fileData.slice(0, 4).toString();
      if (magic !== 'T1BK') return reject(new Error('Invalid encrypted backup format'));

      const iv = fileData.slice(4, 16);
      const authTag = fileData.slice(-16);
      const ciphertext = fileData.slice(16, -16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      fs.writeFileSync(outputPath, decrypted);
      resolve();
    });
  }

  // ================================================================
  // RETENTION CLEANUP
  // ================================================================
  static async cleanupOldBackups() {
    const retentionDays = await settings.getNumber('system.backup_retention_days', 30);
    const cutoff = new Date(Date.now() - retentionDays * 86400000);

    const oldBackups = await db('database_backups')
      .where('started_at', '<', cutoff)
      .whereIn('status', ['completed', 'uploaded', 'failed']);

    let deleted = 0;
    for (const backup of oldBackups) {
      try {
        // Delete file from disk
        if (fs.existsSync(backup.filepath)) {
          fs.unlinkSync(backup.filepath);
        }

        // Mark as deleted in DB (keep record for audit)
        await db('database_backups').where('id', backup.id).update({
          status: 'deleted',
          notes: (backup.notes || '') + ` | Auto-deleted after ${retentionDays} days`,
        });

        deleted++;
      } catch (err) {
        logger.warn('Failed to delete old backup', { id: backup.id, error: err.message });
      }
    }

    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} old backups (retention: ${retentionDays} days)`);
    }

    return { deleted, retentionDays };
  }

  // ================================================================
  // DELETE SINGLE BACKUP
  // ================================================================
  static async deleteBackup(backupId, { userId, ipAddress } = {}) {
    const backup = await db('database_backups').where('id', backupId).first();
    if (!backup) throw new Error('Backup not found');

    // Delete file
    if (fs.existsSync(backup.filepath)) {
      fs.unlinkSync(backup.filepath);
    }

    await db('database_backups').where('id', backupId).update({
      status: 'deleted',
      notes: (backup.notes || '') + ' | Manually deleted',
    });

    AuditService.log({
      userId,
      action: `Backup deleted: ${backup.filename}`,
      resourceType: 'backup',
      resourceId: backupId,
      level: 'warning',
      ipAddress,
    });

    return { deleted: true, filename: backup.filename };
  }

  // ================================================================
  // LIST / QUERY
  // ================================================================
  static async listBackups({ limit = 50, status = null, triggerType = null } = {}) {
    let query = db('database_backups')
      .orderBy('started_at', 'desc')
      .limit(limit);

    if (status) query = query.where('status', status);
    if (triggerType) query = query.where('trigger_type', triggerType);

    // Exclude deleted unless specifically asked
    if (!status) query = query.whereNot('status', 'deleted');

    const backups = await query.select(
      'id', 'filename', 'backup_type', 'trigger_type',
      'file_size_bytes', 'file_size_human', 'tables_included', 'total_rows',
      'status', 'error_message', 'checksum_sha256',
      's3_bucket', 's3_key', 's3_uploaded_at',
      'started_at', 'completed_at', 'duration_ms',
      'triggered_by', 'notes'
    );

    // Check disk availability for each
    return backups.map(b => ({
      ...b,
      on_disk: b.status !== 'deleted' && fs.existsSync(path.join(BACKUP_DIR, b.filename)),
    }));
  }

  static async getBackup(id) {
    return db('database_backups').where('id', id).first();
  }

  static async getStats() {
    const [total, completed, failed, totalSize] = await Promise.all([
      db('database_backups').whereNot('status', 'deleted').count().first(),
      db('database_backups').where('status', 'completed').orWhere('status', 'uploaded').count().first(),
      db('database_backups').where('status', 'failed').count().first(),
      db('database_backups').whereIn('status', ['completed', 'uploaded']).sum('file_size_bytes as total').first(),
    ]);

    const latest = await db('database_backups')
      .whereIn('status', ['completed', 'uploaded'])
      .orderBy('started_at', 'desc')
      .first();

    const nextScheduled = await this.getNextScheduledTimes();

    return {
      totalBackups: parseInt(total.count),
      successfulBackups: parseInt(completed.count),
      failedBackups: parseInt(failed.count),
      totalStorageBytes: parseInt(totalSize.total || 0),
      totalStorageHuman: this._humanSize(parseInt(totalSize.total || 0)),
      latestBackup: latest ? {
        id: latest.id,
        filename: latest.filename,
        completedAt: latest.completed_at,
        size: latest.file_size_human,
      } : null,
      nextScheduled,
      backupDir: BACKUP_DIR,
    };
  }

  // ================================================================
  // SCHEDULE HELPERS
  // ================================================================
  static async getScheduledTimes() {
    const time1 = await settings.get('system.backup_time_1', '06:00');
    const time2 = await settings.get('system.backup_time_2', '18:00');
    return [time1, time2];
  }

  static async getNextScheduledTimes() {
    const [time1, time2] = await this.getScheduledTimes();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const scheduled = [time1, time2].map(t => {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(`${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
      if (d <= now) d.setDate(d.getDate() + 1); // Next occurrence
      return d;
    });

    scheduled.sort((a, b) => a - b);
    return scheduled.map(d => d.toISOString());
  }

  static async shouldRunScheduledBackup() {
    const enabled = await settings.getBool('system.backup_enabled', true);
    if (!enabled) return false;

    const [time1, time2] = await this.getScheduledTimes();
    const now = new Date();
    const currentTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    // Check if current minute matches either scheduled time
    if (currentTime !== time1 && currentTime !== time2) return false;

    // Check we haven't already run in this minute
    const recentBackup = await db('database_backups')
      .where('trigger_type', 'scheduled')
      .where('started_at', '>=', new Date(Date.now() - 120000)) // Last 2 min
      .first();

    return !recentBackup;
  }

  // ================================================================
  // UTILITY
  // ================================================================
  static _humanSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }
}

module.exports = DatabaseBackupService;
