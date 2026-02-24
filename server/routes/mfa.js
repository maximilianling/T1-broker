// ================================================================
// T1 BROKER — MFA ROUTES
// TOTP setup/verify, email 2FA, backup codes, trusted devices
// ================================================================
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const { validate, schemas } = require('../middleware/validation');
const MFAService = require('../services/mfa');
const AuditService = require('../utils/audit');

router.use(authenticate);

// ================================================================
// STATUS
// ================================================================
// GET /mfa/status — Get current MFA configuration
router.get('/status', asyncHandler(async (req, res) => {
  const status = await MFAService.getStatus(req.user.id);
  res.json(status);
}));

// ================================================================
// TOTP (Google Authenticator)
// ================================================================
// POST /mfa/totp/setup — Begin TOTP setup (returns QR code)
router.post('/totp/setup', asyncHandler(async (req, res) => {
  const result = await MFAService.setupTOTP(req.user.id, req.user.email);
  res.json({
    qrCode: result.qrCode,
    secret: result.secret, // Display as manual entry fallback
    message: 'Scan QR code with Google Authenticator or Authy, then confirm with POST /mfa/totp/confirm',
  });
}));

// POST /mfa/totp/confirm — Confirm TOTP setup with first code
router.post('/totp/confirm', validate(schemas.mfaConfirmTOTP), asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: 'Please enter the 6-digit code from your authenticator app' });
  }

  const result = await MFAService.confirmTOTPSetup(req.user.id, code);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    message: 'TOTP MFA enabled successfully',
    backupCodes: result.backupCodes,
    warning: 'Save these backup codes in a secure place. Each code can only be used once.',
  });
}));

// ================================================================
// EMAIL 2FA
// ================================================================
// POST /mfa/email/setup — Begin email 2FA setup (sends code to email)
router.post('/email/setup', asyncHandler(async (req, res) => {
  const result = await MFAService.enableEmailMFA(req.user.id);
  if (result.error) {
    return res.status(429).json({ error: result.error, retryAfter: result.retryAfter });
  }
  res.json({
    message: `Verification code sent to ${result.maskedEmail}`,
    maskedEmail: result.maskedEmail,
  });
}));

// POST /mfa/email/confirm — Confirm email 2FA with code
router.post('/email/confirm', validate(schemas.mfaConfirmEmail), asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: 'Please enter the 6-digit code from your email' });
  }

  const result = await MFAService.confirmEmailMFA(req.user.id, code);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    message: 'Email MFA enabled successfully',
    backupCodes: result.backupCodes,
    warning: 'Save these backup codes in a secure place.',
  });
}));

// POST /mfa/email/send — Request new email code (during login flow)
router.post('/email/send', asyncHandler(async (req, res) => {
  const result = await MFAService.sendEmailCode(req.user.id, 'mfa');
  if (!result.sent) {
    return res.status(429).json({ error: result.error, retryAfter: result.retryAfter });
  }
  res.json({ message: 'Code sent', maskedEmail: result.maskedEmail, expiresIn: result.expiresIn });
}));

// ================================================================
// BACKUP CODES
// ================================================================
// POST /mfa/backup/regenerate — Generate new set of backup codes
router.post('/backup/regenerate', asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required to regenerate backup codes' });

  const bcrypt = require('bcryptjs');
  const db = require('../config/database');
  const user = await db('users').where('id', req.user.id).first();
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });

  if (!user.mfa_enabled) {
    return res.status(400).json({ error: 'MFA must be enabled to generate backup codes' });
  }

  const codes = await MFAService.generateBackupCodes(req.user.id);

  AuditService.log({
    userId: req.user.id,
    action: 'Backup codes regenerated',
    resourceType: 'auth',
    level: 'warning',
    ipAddress: req.ip,
  });

  res.json({
    backupCodes: codes,
    warning: 'Previous backup codes have been invalidated. Save these new codes securely.',
  });
}));

// GET /mfa/backup/count — How many unused backup codes remain
router.get('/backup/count', asyncHandler(async (req, res) => {
  const count = await MFAService.getBackupCodeCount(req.user.id);
  res.json({ remaining: count });
}));

// ================================================================
// TRUSTED DEVICES
// ================================================================
// GET /mfa/devices — List trusted devices
router.get('/devices', asyncHandler(async (req, res) => {
  const devices = await MFAService.getTrustedDevices(req.user.id);
  res.json({
    data: devices.map(d => ({
      id: d.id,
      name: d.device_name,
      ip: d.ip_address,
      lastUsed: d.last_used_at,
      expiresAt: d.expires_at,
    })),
  });
}));

// DELETE /mfa/devices/:id — Revoke a trusted device
router.delete('/devices/:id', asyncHandler(async (req, res) => {
  await MFAService.revokeTrustedDevice(req.user.id, req.params.id);
  res.json({ message: 'Device removed' });
}));

// DELETE /mfa/devices — Revoke all trusted devices
router.delete('/devices', asyncHandler(async (req, res) => {
  await MFAService.revokeAllTrustedDevices(req.user.id);

  AuditService.log({
    userId: req.user.id,
    action: 'All trusted devices revoked',
    resourceType: 'auth',
    level: 'warning',
    ipAddress: req.ip,
  });

  res.json({ message: 'All trusted devices removed' });
}));

// ================================================================
// DISABLE MFA
// ================================================================
// POST /mfa/disable — Disable MFA (requires password confirmation)
router.post('/disable', validate(schemas.mfaDisable), asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required to disable MFA' });

  const result = await MFAService.disableMFA(req.user.id, password);
  if (!result.success) {
    return res.status(401).json({ error: result.error });
  }

  res.json({ message: 'MFA has been disabled. We recommend re-enabling it for account security.' });
}));

// ================================================================
// LOGIN HISTORY
// ================================================================
// GET /mfa/login-history — Recent login attempts
router.get('/login-history', asyncHandler(async (req, res) => {
  const db = require('../config/database');
  const history = await db('login_history')
    .where('user_id', req.user.id)
    .orderBy('created_at', 'desc')
    .limit(20);

  res.json({
    data: history.map(h => ({
      id: h.id,
      ip: h.ip_address,
      device: MFAService.parseDeviceName(h.user_agent),
      result: h.login_result,
      mfaMethod: h.mfa_method,
      riskScore: h.risk_score,
      timestamp: h.created_at,
    })),
  });
}));

module.exports = router;
