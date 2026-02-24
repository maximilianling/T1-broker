// ================================================================
// T1 BROKER — KYC GATE MIDDLEWARE
// Blocks trading functionality unless KYC is approved or waived.
// Admin can waive KYC per-client via PATCH /clients/:id
// ================================================================
const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * requireKYC — Middleware that enforces KYC approval before trading.
 * Checks the client record for kyc_status = 'approved' or kyc_waived = true.
 * Returns 403 with clear error codes for the frontend to display appropriate UI.
 */
function requireKYC(req, res, next) {
  // Admins, super_admins, and operations bypass KYC checks
  if (req.user && ['super_admin', 'admin', 'operations'].includes(req.user.role)) {
    return next();
  }

  (async () => {
    try {
      const client = await db('clients').where('user_id', req.user.id).first();

      if (!client) {
        return res.status(403).json({
          error: 'No client profile found. Please complete registration.',
          code: 'NO_CLIENT_PROFILE',
        });
      }

      // Check if KYC is waived by admin
      if (client.kyc_waived) {
        return next();
      }

      // Check KYC status
      switch (client.kyc_status) {
        case 'approved':
          // Check if client account is active
          if (client.status !== 'active') {
            return res.status(403).json({
              error: 'Account is not active. Please contact support.',
              code: 'ACCOUNT_INACTIVE',
              accountStatus: client.status,
            });
          }
          return next();

        case 'not_started':
          return res.status(403).json({
            error: 'KYC verification required. Please submit your identity documents to begin trading.',
            code: 'KYC_NOT_STARTED',
            kycStatus: 'not_started',
          });

        case 'in_progress':
          return res.status(403).json({
            error: 'KYC documents submitted. Verification is in progress — trading will be enabled once approved.',
            code: 'KYC_IN_PROGRESS',
            kycStatus: 'in_progress',
          });

        case 'pending_review':
          return res.status(403).json({
            error: 'KYC submitted and pending admin review. Trading will be enabled once approved.',
            code: 'KYC_PENDING_REVIEW',
            kycStatus: 'pending_review',
          });

        case 'rejected':
          return res.status(403).json({
            error: 'KYC verification was rejected. Please resubmit documents or contact support.',
            code: 'KYC_REJECTED',
            kycStatus: 'rejected',
          });

        case 'expired':
        case 'rekyc_required':
          return res.status(403).json({
            error: 'KYC verification has expired. Please resubmit your documents.',
            code: 'KYC_EXPIRED',
            kycStatus: client.kyc_status,
          });

        default:
          return res.status(403).json({
            error: 'KYC verification required before trading.',
            code: 'KYC_REQUIRED',
            kycStatus: client.kyc_status,
          });
      }
    } catch (err) {
      logger.error('KYC gate error', { userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Unable to verify KYC status' });
    }
  })();
}

/**
 * kycStatus — Lightweight middleware that attaches KYC status to req
 * without blocking. Useful for endpoints that want to show status but not gate.
 */
function attachKYCStatus(req, res, next) {
  (async () => {
    try {
      const client = await db('clients').where('user_id', req.user.id).first();
      req.kycStatus = client ? client.kyc_status : 'no_profile';
      req.kycWaived = client ? !!client.kyc_waived : false;
      req.clientStatus = client ? client.status : null;
      req.clientId = client ? client.id : null;
    } catch {
      req.kycStatus = 'unknown';
    }
    next();
  })();
}

module.exports = { requireKYC, attachKYCStatus };
