// ================================================================
// T1 BROKER — AUTHENTICATION & AUTHORIZATION MIDDLEWARE
// JWT + RBAC + MFA enforcement + IP whitelist
// ================================================================
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../config/database');
const logger = require('../utils/logger');
const { hashToken } = require('../utils/encryption');
const AuditService = require('../utils/audit');

// ----------------------------------------------------------------
// JWT Token Verification
// ----------------------------------------------------------------
async function authenticate(req, res, next) {
  try {
    // ── CHECK API KEY FIRST ──
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const APIKeyService = require('../services/apiKeys');
      const result = await APIKeyService.validateKey(apiKey, req.ip);

      if (!result.valid) {
        return res.status(401).json({
          error: result.error,
          code: 'INVALID_API_KEY',
        });
      }

      // API key authenticated — attach user + API key metadata
      req.user = result.user;
      req.isAPIKey = true;
      req.apiKeyId = result.keyId;
      req.apiKeyPermissions = result.permissions;
      req.sessionId = null; // No session for API key auth
      return next();
    }

    // ── JWT TOKEN AUTH ──
    // Extract token from Authorization header or cookie
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    }

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }

    // Verify session is still active (not revoked)
    const tokenHash = hashToken(token);
    const session = await db('user_sessions')
      .where('token_hash', tokenHash)
      .whereNull('revoked_at')
      .where('expires_at', '>', new Date())
      .first();

    if (!session) {
      return res.status(401).json({ error: 'Session expired or revoked', code: 'SESSION_INVALID' });
    }

    // Get user
    const user = await db('users')
      .where('id', decoded.userId)
      .where('is_active', true)
      .first();

    if (!user) {
      return res.status(401).json({ error: 'User not found or deactivated', code: 'USER_INACTIVE' });
    }

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED' });
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      mfaEnabled: user.mfa_enabled,
    };
    req.sessionId = session.id;
    req.tokenIssuedAt = decoded.iat ? decoded.iat * 1000 : Date.now();
    req.sessionFingerprint = session.fingerprint || null;

    next();
  } catch (err) {
    logger.error('Authentication middleware error', { error: err.message });
    return res.status(500).json({ error: 'Authentication error', code: 'AUTH_ERROR' });
  }
}

// ----------------------------------------------------------------
// Role-Based Access Control
// ----------------------------------------------------------------
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      AuditService.log({
        userId: req.user.id,
        userEmail: req.user.email,
        userRole: req.user.role,
        action: `Unauthorized access attempt to ${req.method} ${req.path}`,
        resourceType: 'system',
        level: 'warning',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
      });
    }

    next();
  };
}

// ----------------------------------------------------------------
// MFA Enforcement for sensitive operations
// ----------------------------------------------------------------
function requireMFA(req, res, next) {
  if (!req.user.mfaVerified) {
    return res.status(403).json({
      error: 'MFA verification required for this action',
      code: 'MFA_REQUIRED',
    });
  }
  next();
}

// ----------------------------------------------------------------
// IP Whitelist check for admin routes
// ----------------------------------------------------------------
async function checkIPWhitelist(req, res, next) {
  if (config.env === 'development') return next(); // Skip in dev

  const allowedIPs = await db('ip_whitelist')
    .where('is_active', true)
    .where(function () {
      this.where('user_id', req.user.id).orWhereNull('user_id');
    })
    .pluck('ip_address');

  if (allowedIPs.length > 0 && !allowedIPs.includes(req.ip)) {
    AuditService.log({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: `Admin access from non-whitelisted IP: ${req.ip}`,
      resourceType: 'security',
      level: 'critical',
      ipAddress: req.ip,
    });

    return res.status(403).json({
      error: 'Access denied from this IP address',
      code: 'IP_NOT_WHITELISTED',
    });
  }

  next();
}

// ----------------------------------------------------------------
// Request logging middleware
// ----------------------------------------------------------------
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userId: req.user?.id,
    };

    if (res.statusCode >= 400) {
      logger.warn('Request failed', logData);
    } else if (duration > 1000) {
      logger.warn('Slow request', logData);
    }
  });
  next();
}

// ----------------------------------------------------------------
// Partner scope middleware (restricts partner users to their data)
// ----------------------------------------------------------------
async function partnerScope(req, res, next) {
  try {
    if (req.user.role === 'partner_admin') {
      const partner = await db('partners').where('user_id', req.user.id).first();
      if (!partner) {
        return res.status(403).json({ error: 'Partner account not found', code: 'PARTNER_NOT_FOUND' });
      }
      req.partnerId = partner.id;
      req.partnerScope = true;
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ----------------------------------------------------------------
// API Key Permission Check
// Ensures the API key has the required permission for the endpoint.
// ----------------------------------------------------------------
function requireAPIPermission(permission) {
  return (req, res, next) => {
    // JWT users (not API key) bypass permission checks — they have full access
    if (!req.isAPIKey) return next();

    if (!req.apiKeyPermissions || !req.apiKeyPermissions.includes(permission)) {
      AuditService.log({
        userId: req.user.id,
        action: `API key missing '${permission}' permission for ${req.method} ${req.path}`,
        resourceType: 'api_key',
        resourceId: req.apiKeyId,
        level: 'warning',
        ipAddress: req.ip,
      });
      return res.status(403).json({
        error: `API key lacks '${permission}' permission`,
        code: 'INSUFFICIENT_API_PERMISSIONS',
        requiredPermission: permission,
      });
    }
    next();
  };
}

module.exports = {
  authenticate,
  authorize,
  requireMFA,
  requireAPIPermission,
  checkIPWhitelist,
  requestLogger,
  partnerScope,
};
