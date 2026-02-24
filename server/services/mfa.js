// ================================================================
// T1 BROKER — MFA SERVICE
// TOTP (Google Authenticator), Email codes, Backup codes,
// Trusted devices, Login anomaly detection
// ================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const { encrypt, decrypt, hashToken } = require('../utils/encryption');
const { emailService } = require('./notifications');
const AuditService = require('../utils/audit');

class MFAService {
  // ================================================================
  // TOTP (Google Authenticator / Authy)
  // ================================================================
  static async setupTOTP(userId, email) {
    const secret = speakeasy.generateSecret({
      name: `${config.mfa.issuer}:${email}`,
      issuer: config.mfa.issuer,
      length: 20,
    });

    // Store encrypted secret (not yet enabled until confirmed)
    await db('users').where('id', userId).update({
      mfa_secret: encrypt(secret.base32),
    });

    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    return {
      secret: secret.base32,
      qrCode,
      otpauthUrl: secret.otpauth_url,
    };
  }

  static async verifyTOTP(userId, code) {
    const user = await db('users').where('id', userId).first();
    if (!user?.mfa_secret) return false;

    const secret = decrypt(user.mfa_secret);
    if (!secret) return false;

    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1, // Allow ±30s drift
    });
  }

  static async confirmTOTPSetup(userId, code) {
    const verified = await this.verifyTOTP(userId, code);
    if (!verified) return { success: false, error: 'Invalid code' };

    // Generate backup codes
    const backupCodes = await this.generateBackupCodes(userId);

    await db('users').where('id', userId).update({
      mfa_enabled: true,
      mfa_method: 'totp',
      security_stamp: crypto.randomBytes(32).toString('hex'),
    });

    AuditService.log({
      userId, action: 'TOTP MFA enabled',
      resourceType: 'auth', level: 'success',
    });

    return { success: true, backupCodes };
  }

  // ================================================================
  // EMAIL-BASED 2FA
  // ================================================================
  static async sendEmailCode(userId, purpose = 'mfa') {
    const user = await db('users').where('id', userId).first();
    if (!user) throw new Error('User not found');

    // Rate limit: max 1 code per 60 seconds
    const recent = await db('email_codes')
      .where('user_id', userId)
      .where('purpose', purpose)
      .where('created_at', '>', new Date(Date.now() - 60000))
      .first();

    if (recent) {
      return { sent: false, retryAfter: 60, error: 'Please wait before requesting a new code' };
    }

    // Generate 6-digit code
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 10);

    // Invalidate previous unused codes
    await db('email_codes')
      .where('user_id', userId)
      .where('purpose', purpose)
      .whereNull('used_at')
      .update({ used_at: new Date() });

    // Store new code
    await db('email_codes').insert({
      user_id: userId,
      code_hash: codeHash,
      purpose,
      expires_at: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });

    // Mask email for display
    const maskedEmail = user.email.replace(
      /^(.{2})(.*)(@.*)$/,
      (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c
    );

    // Send email
    await emailService.send({
      to: user.email,
      subject: `${code} is your T1 Broker verification code`,
      template: 'mfaEmailCode',
      data: { code, expiresMinutes: 10, purpose },
      priority: 'high',
    });

    logger.info('Email MFA code sent', { userId, purpose });
    return { sent: true, maskedEmail, expiresIn: 600 };
  }

  static async verifyEmailCode(userId, code, purpose = 'mfa') {
    const emailCode = await db('email_codes')
      .where('user_id', userId)
      .where('purpose', purpose)
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first();

    if (!emailCode) return { valid: false, error: 'Code expired or not found' };

    // Check max attempts
    if (emailCode.attempts >= emailCode.max_attempts) {
      await db('email_codes').where('id', emailCode.id).update({ used_at: new Date() });
      return { valid: false, error: 'Too many attempts. Request a new code.' };
    }

    // Increment attempt count
    await db('email_codes').where('id', emailCode.id).increment('attempts', 1);

    const valid = await bcrypt.compare(code, emailCode.code_hash);
    if (!valid) {
      return { valid: false, error: 'Invalid code', attemptsRemaining: emailCode.max_attempts - emailCode.attempts - 1 };
    }

    // Mark as used
    await db('email_codes').where('id', emailCode.id).update({ used_at: new Date() });
    return { valid: true };
  }

  static async enableEmailMFA(userId) {
    // Send a verification code first
    const result = await this.sendEmailCode(userId, 'mfa');
    if (!result.sent) return result;

    return { pending: true, maskedEmail: result.maskedEmail };
  }

  static async confirmEmailMFA(userId, code) {
    const result = await this.verifyEmailCode(userId, code, 'mfa');
    if (!result.valid) return { success: false, error: result.error };

    const backupCodes = await this.generateBackupCodes(userId);

    await db('users').where('id', userId).update({
      mfa_enabled: true,
      mfa_method: 'email',
      mfa_email_enabled: true,
      security_stamp: crypto.randomBytes(32).toString('hex'),
    });

    AuditService.log({
      userId, action: 'Email MFA enabled',
      resourceType: 'auth', level: 'success',
    });

    return { success: true, backupCodes };
  }

  // ================================================================
  // BACKUP / RECOVERY CODES
  // ================================================================
  static async generateBackupCodes(userId, count = 10) {
    // Delete old codes
    await db('mfa_backup_codes').where('user_id', userId).del();

    const codes = [];
    const inserts = [];

    for (let i = 0; i < count; i++) {
      // Format: XXXX-XXXX (8 alphanumeric chars)
      const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
      const code = raw.slice(0, 4) + '-' + raw.slice(4, 8);
      const codeHash = await bcrypt.hash(code, 10);

      codes.push(code);
      inserts.push({ user_id: userId, code_hash: codeHash });
    }

    await db('mfa_backup_codes').insert(inserts);
    await db('users').where('id', userId).update({
      mfa_backup_generated_at: new Date(),
    });

    logger.info('Backup codes generated', { userId, count });
    return codes;
  }

  static async verifyBackupCode(userId, code) {
    // Normalize: remove dashes, uppercase
    const normalized = code.replace(/-/g, '').toUpperCase();
    const formatted = normalized.slice(0, 4) + '-' + normalized.slice(4, 8);

    const unusedCodes = await db('mfa_backup_codes')
      .where('user_id', userId)
      .whereNull('used_at');

    for (const stored of unusedCodes) {
      const match = await bcrypt.compare(formatted, stored.code_hash);
      if (match) {
        await db('mfa_backup_codes')
          .where('id', stored.id)
          .update({ used_at: new Date() });

        const remaining = unusedCodes.length - 1;
        logger.warn('Backup code used', { userId, remaining });

        AuditService.log({
          userId,
          action: `Backup code used (${remaining} remaining)`,
          resourceType: 'auth',
          level: 'warning',
        });

        return { valid: true, remaining };
      }
    }

    return { valid: false };
  }

  static async getBackupCodeCount(userId) {
    const [{ count }] = await db('mfa_backup_codes')
      .where('user_id', userId)
      .whereNull('used_at')
      .count();
    return parseInt(count);
  }

  // ================================================================
  // TRUSTED DEVICES
  // ================================================================
  static generateDeviceFingerprint(req) {
    const ua = req.get('User-Agent') || '';
    const ip = req.ip;
    const accept = req.get('Accept-Language') || '';
    return hashToken(`${ua}:${ip}:${accept}`);
  }

  static parseDeviceName(userAgent) {
    if (!userAgent) return 'Unknown device';
    const ua = userAgent.toLowerCase();
    let browser = 'Browser';
    let os = 'Unknown';

    if (ua.includes('chrome') && !ua.includes('edg')) browser = 'Chrome';
    else if (ua.includes('firefox')) browser = 'Firefox';
    else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
    else if (ua.includes('edg')) browser = 'Edge';

    if (ua.includes('windows')) os = 'Windows';
    else if (ua.includes('mac os')) os = 'macOS';
    else if (ua.includes('linux')) os = 'Linux';
    else if (ua.includes('iphone')) os = 'iPhone';
    else if (ua.includes('android')) os = 'Android';
    else if (ua.includes('ipad')) os = 'iPad';

    return `${browser} on ${os}`;
  }

  static async isTrustedDevice(userId, req) {
    const fingerprint = this.generateDeviceFingerprint(req);

    const device = await db('trusted_devices')
      .where('user_id', userId)
      .where('device_hash', fingerprint)
      .where('expires_at', '>', new Date())
      .first();

    if (device) {
      // Update last used
      await db('trusted_devices').where('id', device.id).update({
        last_used_at: new Date(),
        ip_address: req.ip,
      });
      return true;
    }
    return false;
  }

  static async trustDevice(userId, req, durationDays = 30) {
    const fingerprint = this.generateDeviceFingerprint(req);
    const deviceName = this.parseDeviceName(req.get('User-Agent'));

    // Upsert
    await db('trusted_devices')
      .where('user_id', userId)
      .where('device_hash', fingerprint)
      .del();

    await db('trusted_devices').insert({
      user_id: userId,
      device_hash: fingerprint,
      device_name: deviceName,
      ip_address: req.ip,
      expires_at: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000),
    });

    logger.info('Device trusted', { userId, deviceName });
  }

  static async getTrustedDevices(userId) {
    return db('trusted_devices')
      .where('user_id', userId)
      .where('expires_at', '>', new Date())
      .orderBy('last_used_at', 'desc');
  }

  static async revokeTrustedDevice(userId, deviceId) {
    await db('trusted_devices')
      .where('id', deviceId)
      .where('user_id', userId)
      .del();
  }

  static async revokeAllTrustedDevices(userId) {
    await db('trusted_devices').where('user_id', userId).del();
  }

  // ================================================================
  // DISABLE MFA
  // ================================================================
  static async disableMFA(userId, password) {
    const user = await db('users').where('id', userId).first();
    if (!user) throw new Error('User not found');

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return { success: false, error: 'Invalid password' };

    await db('users').where('id', userId).update({
      mfa_enabled: false,
      mfa_secret: null,
      mfa_method: 'totp',
      mfa_email_enabled: false,
      mfa_backup_generated_at: null,
      security_stamp: crypto.randomBytes(32).toString('hex'),
    });

    // Delete backup codes and trusted devices
    await db('mfa_backup_codes').where('user_id', userId).del();
    await db('trusted_devices').where('user_id', userId).del();

    AuditService.log({
      userId, action: 'MFA disabled',
      resourceType: 'auth', level: 'warning',
    });

    // Send security alert
    await emailService.send({
      to: user.email,
      subject: 'Security Alert: MFA Disabled',
      template: 'securityAlert',
      data: {
        eventType: 'MFA Disabled',
        ipAddress: 'N/A',
        timestamp: new Date().toLocaleString(),
      },
      priority: 'high',
    });

    return { success: true };
  }

  // ================================================================
  // LOGIN RISK SCORING
  // ================================================================
  static async assessLoginRisk(userId, req) {
    let riskScore = 0;
    const reasons = [];
    const ip = req.ip;
    const userAgent = req.get('User-Agent') || '';

    // 1. New IP address (never seen before)
    const knownIP = await db('login_history')
      .where('user_id', userId)
      .where('ip_address', ip)
      .where('login_result', 'success')
      .first();

    if (!knownIP) {
      riskScore += 25;
      reasons.push('new_ip');
    }

    // 2. New device fingerprint
    const fingerprint = this.generateDeviceFingerprint(req);
    const knownDevice = await db('login_history')
      .where('user_id', userId)
      .where('device_hash', fingerprint)
      .where('login_result', 'success')
      .first();

    if (!knownDevice) {
      riskScore += 20;
      reasons.push('new_device');
    }

    // 3. Multiple failed attempts in last hour
    const [{ count: recentFails }] = await db('login_history')
      .where('user_id', userId)
      .where('login_result', 'failed')
      .where('created_at', '>', new Date(Date.now() - 3600000))
      .count();

    if (parseInt(recentFails) >= 3) {
      riskScore += 30;
      reasons.push('recent_failures');
    }

    // 4. Unusual hour (login at 2-5 AM local — simplified, use IP geolocation in production)
    const hour = new Date().getUTCHours();
    if (hour >= 2 && hour <= 5) {
      riskScore += 10;
      reasons.push('unusual_hour');
    }

    // 5. Different country from last login (simplified — check IP range change)
    const lastLogin = await db('login_history')
      .where('user_id', userId)
      .where('login_result', 'success')
      .orderBy('created_at', 'desc')
      .first();

    if (lastLogin && lastLogin.ip_address !== ip) {
      // Major IP block change suggests different location
      const lastOctets = String(lastLogin.ip_address).split('.').slice(0, 2).join('.');
      const currentOctets = ip.split('.').slice(0, 2).join('.');
      if (lastOctets !== currentOctets) {
        riskScore += 15;
        reasons.push('location_change');
      }
    }

    return { riskScore: Math.min(riskScore, 100), reasons };
  }

  static async recordLogin(userId, req, result, mfaMethod = null) {
    const fingerprint = this.generateDeviceFingerprint(req);
    const { riskScore } = result === 'success'
      ? await this.assessLoginRisk(userId, req)
      : { riskScore: 0 };

    await db('login_history').insert({
      user_id: userId,
      ip_address: req.ip,
      user_agent: req.get('User-Agent'),
      device_hash: fingerprint,
      login_result: result,
      mfa_method: mfaMethod,
      risk_score: riskScore,
    });

    // Alert on high risk successful logins
    if (result === 'success' && riskScore >= 50) {
      const user = await db('users').where('id', userId).first();
      await emailService.send({
        to: user.email,
        subject: 'Security Alert: New login detected',
        template: 'securityAlert',
        data: {
          eventType: 'New Login from Unrecognized Device/Location',
          ipAddress: req.ip,
          timestamp: new Date().toLocaleString(),
        },
        priority: 'high',
      });
    }
  }

  // ================================================================
  // MFA STATUS
  // ================================================================
  static async getStatus(userId) {
    const user = await db('users')
      .where('id', userId)
      .select('mfa_enabled', 'mfa_method', 'mfa_email_enabled', 'mfa_backup_generated_at')
      .first();

    const backupCount = user.mfa_enabled
      ? await this.getBackupCodeCount(userId)
      : 0;

    const devices = user.mfa_enabled
      ? await this.getTrustedDevices(userId)
      : [];

    return {
      enabled: user.mfa_enabled,
      method: user.mfa_method,
      emailEnabled: user.mfa_email_enabled,
      backupCodesRemaining: backupCount,
      backupCodesGeneratedAt: user.mfa_backup_generated_at,
      trustedDevices: devices.map(d => ({
        id: d.id,
        name: d.device_name,
        lastUsed: d.last_used_at,
        expiresAt: d.expires_at,
      })),
    };
  }
}

module.exports = MFAService;
