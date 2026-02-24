// ================================================================
// T1 BROKER — AUTH ROUTES
// POST /auth/login, /auth/register, /auth/refresh, /auth/mfa/*
// ================================================================
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const db = require('../config/database');
const config = require('../config');
const { hashToken, encrypt, generateSecureToken } = require('../utils/encryption');
const { validate, schemas } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const AuditService = require('../utils/audit');
const MFAService = require('../services/mfa');
const logger = require('../utils/logger');

// Max failed login attempts before lockout
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

// ----------------------------------------------------------------
// POST /auth/login
// ----------------------------------------------------------------
router.post('/login', validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await db('users').where('email', email.toLowerCase()).first();

    if (!user) {
      await bcrypt.hash(password, 12);
      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    // Account lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      MFAService.recordLogin(user.id, req, 'locked').catch(() => {});
      return res.status(423).json({
        error: `Account locked. Try again in ${minutes} minutes.`,
        code: 'ACCOUNT_LOCKED',
        lockedUntil: user.locked_until,
      });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = user.failed_login_attempts + 1;
      const update = { failed_login_attempts: attempts };
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        update.locked_until = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60000);
      }
      await db('users').where('id', user.id).update(update);

      MFAService.recordLogin(user.id, req, 'failed').catch(() => {});

      AuditService.log({
        userId: user.id, userEmail: user.email,
        action: `Failed login attempt (${attempts}/${MAX_FAILED_ATTEMPTS})`,
        resourceType: 'auth',
        level: attempts >= 3 ? 'warning' : 'info',
        ipAddress: req.ip,
      });

      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account deactivated', code: 'ACCOUNT_INACTIVE' });
    }

    // Assess login risk
    const risk = await MFAService.assessLoginRisk(user.id, req);

    // Check if MFA is required
    if (user.mfa_enabled) {
      // Check trusted device — skip MFA if recognized
      const trusted = await MFAService.isTrustedDevice(user.id, req);
      if (trusted && risk.riskScore < 50) {
        // Trusted device, low risk — issue tokens directly
        const tokens = await issueTokens(user, req, true);
        await db('users').where('id', user.id).update({
          failed_login_attempts: 0, locked_until: null,
          last_login_at: new Date(), last_login_ip: req.ip,
        });
        MFAService.recordLogin(user.id, req, 'success', 'trusted_device').catch(() => {});
        const trustedProfile = await getFullUserProfile(user.id);
        return res.json({ user: trustedProfile, ...tokens });
      }

      // MFA required — return temporary token
      const mfaToken = jwt.sign(
        { userId: user.id, purpose: 'mfa' },
        config.jwt.secret,
        { expiresIn: '5m' }
      );

      // If email MFA, auto-send code
      let emailSent = null;
      if (user.mfa_method === 'email') {
        const sendResult = await MFAService.sendEmailCode(user.id, 'mfa');
        emailSent = sendResult.sent ? sendResult.maskedEmail : null;
      }

      MFAService.recordLogin(user.id, req, 'mfa_required').catch(() => {});

      return res.json({
        requiresMFA: true,
        mfaToken,
        mfaMethod: user.mfa_method,
        emailSent, // null for TOTP, masked email for email method
        riskScore: risk.riskScore,
      });
    }

    // No MFA — issue tokens directly
    const tokens = await issueTokens(user, req);
    await db('users').where('id', user.id).update({
      failed_login_attempts: 0, locked_until: null,
      last_login_at: new Date(), last_login_ip: req.ip,
    });

    MFAService.recordLogin(user.id, req, 'success', null).catch(() => {});

    AuditService.log({
      userId: user.id, userEmail: user.email, userRole: user.role,
      action: 'User logged in',
      resourceType: 'auth', level: 'success',
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    const profile = await getFullUserProfile(user.id);
    res.json({ user: profile, ...tokens });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed', code: 'LOGIN_ERROR' });
  }
});

// ----------------------------------------------------------------
// POST /auth/mfa/verify — Verify MFA code (TOTP, email, or backup)
// ----------------------------------------------------------------
router.post('/mfa/verify', validate(schemas.mfaVerify), async (req, res) => {
  const { token: mfaCode, method, trustDevice } = req.body;
  const mfaToken = req.headers['x-mfa-token'];

  if (!mfaToken) {
    return res.status(400).json({ error: 'MFA token required', code: 'MFA_TOKEN_MISSING' });
  }

  try {
    const decoded = jwt.verify(mfaToken, config.jwt.secret);
    if (decoded.purpose !== 'mfa') {
      return res.status(400).json({ error: 'Invalid MFA token', code: 'INVALID_MFA_TOKEN' });
    }

    const user = await db('users').where('id', decoded.userId).first();
    if (!user) return res.status(404).json({ error: 'User not found' });

    let verified = false;
    let usedMethod = method || user.mfa_method || 'totp';

    // Try verification based on method
    if (usedMethod === 'backup') {
      // Backup / recovery code
      const result = await MFAService.verifyBackupCode(user.id, mfaCode);
      verified = result.valid;
      if (result.valid && result.remaining <= 2) {
        // Warn user they're running low
        logger.warn('User running low on backup codes', { userId: user.id, remaining: result.remaining });
      }
    } else if (usedMethod === 'email') {
      // Email verification code
      const result = await MFAService.verifyEmailCode(user.id, mfaCode, 'mfa');
      verified = result.valid;
      if (!result.valid) {
        return res.status(401).json({
          error: result.error || 'Invalid email code',
          code: 'INVALID_MFA_CODE',
          attemptsRemaining: result.attemptsRemaining,
        });
      }
    } else {
      // TOTP (Google Authenticator)
      verified = await MFAService.verifyTOTP(user.id, mfaCode);
    }

    if (!verified) {
      AuditService.log({
        userId: user.id, userEmail: user.email,
        action: `Failed MFA verification (${usedMethod})`,
        resourceType: 'auth', level: 'warning', ipAddress: req.ip,
      });
      return res.status(401).json({ error: 'Invalid MFA code', code: 'INVALID_MFA_CODE' });
    }

    // MFA verified — issue full tokens
    const tokens = await issueTokens(user, req, true);

    await db('users').where('id', user.id).update({
      failed_login_attempts: 0, locked_until: null,
      last_login_at: new Date(), last_login_ip: req.ip,
    });

    // Trust this device if requested
    if (trustDevice) {
      await MFAService.trustDevice(user.id, req, 30);
    }

    MFAService.recordLogin(user.id, req, 'success', usedMethod).catch(() => {});

    AuditService.log({
      userId: user.id, userEmail: user.email, userRole: user.role,
      action: `User logged in (MFA: ${usedMethod})`,
      resourceType: 'auth', level: 'success', ipAddress: req.ip,
    });

    const profile = await getFullUserProfile(user.id);
    res.json({ user: profile, ...tokens });
  } catch (err) {
    logger.error('MFA verify error', { error: err.message });
    res.status(401).json({ error: 'MFA verification failed', code: 'MFA_FAILED' });
  }
});

// POST /auth/mfa/email/resend — Resend email code during login (uses mfaToken)
router.post('/mfa/email/resend', async (req, res) => {
  const mfaToken = req.headers['x-mfa-token'];
  if (!mfaToken) return res.status(400).json({ error: 'MFA token required' });

  try {
    const decoded = jwt.verify(mfaToken, config.jwt.secret);
    if (decoded.purpose !== 'mfa') return res.status(400).json({ error: 'Invalid MFA token' });

    const result = await MFAService.sendEmailCode(decoded.userId, 'mfa');
    if (!result.sent) {
      return res.status(429).json({ error: result.error, retryAfter: result.retryAfter });
    }
    res.json({ message: 'Code resent', maskedEmail: result.maskedEmail, expiresIn: result.expiresIn });
  } catch (err) {
    res.status(401).json({ error: 'Token expired — please log in again' });
  }
});

// NOTE: MFA setup/confirm/disable/devices/backup endpoints are in routes/mfa.js
// mounted at /api/v1/mfa in index.js

// ----------------------------------------------------------------
// POST /auth/register
// ----------------------------------------------------------------
router.post('/register', validate(schemas.register), async (req, res) => {
  const { email, password, firstName, lastName, countryOfResidence, clientType } = req.body;

  // Check if registration is enabled
  if (config.system && config.system.registrationEnabled === false) {
    return res.status(403).json({ error: 'New registrations are currently disabled', code: 'REGISTRATION_CLOSED' });
  }

  try {
    // Check duplicate email
    const existing = await db('users').where('email', email.toLowerCase()).first();
    if (existing) {
      return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_EXISTS' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const trx = await db.transaction();
    try {
      // Create user
      const [user] = await trx('users').insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        role: 'client',
      }).returning('*');

      // Create client record
      const [client] = await trx('clients').insert({
        user_id: user.id,
        first_name: firstName,
        last_name: lastName,
        country_of_residence: countryOfResidence.toUpperCase(),
        client_type: clientType,
        status: 'pending',
        kyc_status: 'not_started',
      }).returning('*');

      // Create default trading account
      await trx('accounts').insert({
        client_id: client.id,
        currency: 'USD',
        broker: 'drivewealth',
        cash_balance: 0,
        buying_power: 0,
      });

      await trx.commit();

      // ── AUTO-ENABLE EMAIL MFA ──
      // All new registrations get email MFA enabled by default.
      // User can later switch to TOTP (Google Authenticator) in settings.
      try {
        await db('users').where('id', user.id).update({
          mfa_enabled: true,
          mfa_method: 'email',
          mfa_email_enabled: true,
        });
        const backupCodes = await MFAService.generateBackupCodes(user.id);
        logger.info('Auto-enabled email MFA for new user', { userId: user.id });
      } catch (mfaErr) {
        logger.error('Failed to auto-enable MFA', { userId: user.id, error: mfaErr.message });
        // Non-fatal — user can still set up MFA later
      }

      AuditService.log({
        userId: user.id,
        userEmail: user.email,
        action: 'New client registered (email MFA auto-enabled)',
        resourceType: 'client',
        resourceId: client.id,
        level: 'info',
        ipAddress: req.ip,
      });

      // Don't auto-login — require email MFA verification on first login
      res.status(201).json({
        success: true,
        message: 'Account created. Please sign in to continue.',
        user: sanitizeUser({ ...user, mfa_enabled: true }),
        kycRequired: true,
      });
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  } catch (err) {
    logger.error('Registration error', { error: err.message });
    res.status(500).json({ error: 'Registration failed', code: 'REGISTER_ERROR' });
  }
});

// ----------------------------------------------------------------
// POST /auth/refresh
// ----------------------------------------------------------------
router.post('/refresh', async (req, res) => {
  const refreshToken = req.body.refreshToken || req.cookies?.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required', code: 'REFRESH_REQUIRED' });
  }

  try {
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    const tokenHash = hashToken(refreshToken);

    const session = await db('user_sessions')
      .where('refresh_token_hash', tokenHash)
      .whereNull('revoked_at')
      .first();

    if (!session) {
      return res.status(401).json({ error: 'Invalid refresh token', code: 'INVALID_REFRESH' });
    }

    const user = await db('users').where('id', decoded.userId).where('is_active', true).first();
    if (!user) {
      return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    // Revoke old session
    await db('user_sessions').where('id', session.id).update({ revoked_at: new Date() });

    // Issue new tokens
    const tokens = await issueTokens(user, req);
    res.json(tokens);
  } catch (err) {
    res.status(401).json({ error: 'Token refresh failed', code: 'REFRESH_FAILED' });
  }
});

// ----------------------------------------------------------------
// POST /auth/logout
// ----------------------------------------------------------------
router.post('/logout', authenticate, async (req, res) => {
  await db('user_sessions').where('id', req.sessionId).update({ revoked_at: new Date() });

  AuditService.log({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'User logged out',
    resourceType: 'auth',
    level: 'info',
    ipAddress: req.ip,
  });

  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ message: 'Logged out successfully' });
});

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
async function issueTokens(user, req, mfaVerified = false) {
  const payload = { userId: user.id, role: user.role, mfaVerified };

  const accessToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiry });
  const refreshToken = jwt.sign({ userId: user.id }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiry });

  // Store session
  await db('user_sessions').insert({
    user_id: user.id,
    token_hash: hashToken(accessToken),
    refresh_token_hash: hashToken(refreshToken),
    ip_address: req.ip,
    user_agent: req.get('User-Agent'),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.expiry,
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    mfaEnabled: user.mfa_enabled,
    mfaMethod: user.mfa_method || null,
    lastLoginAt: user.last_login_at,
  };
}

// Extended user info including KYC — used after login
async function getFullUserProfile(userId) {
  const user = await db('users').where('id', userId).first();
  const client = await db('clients').where('user_id', userId).first();
  return {
    ...sanitizeUser(user),
    kycStatus: client ? client.kyc_status : 'no_profile',
    kycWaived: client ? !!client.kyc_waived : false,
    clientStatus: client ? client.status : null,
    tradingEnabled: client ? (client.kyc_status === 'approved' || !!client.kyc_waived) && client.status === 'active' : false,
    firstName: client?.first_name,
    lastName: client?.last_name,
  };
}

module.exports = router;
