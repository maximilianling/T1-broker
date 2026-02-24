// ================================================================
// T1 BROKER — PII SHIELD
// Field-level encryption, response data masking, and sensitive
// data classification. Protects client PII in transit and at rest.
// ================================================================
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config');

// ────────────────────────────────────────────
// 1. DATA CLASSIFICATION MAP
// Which fields in which contexts are sensitive
// ────────────────────────────────────────────
const CLASSIFICATION = {
  // CRITICAL: Full encryption at rest, masked in logs, never cached
  critical: new Set([
    'ssn', 'social_security', 'tax_id', 'national_id',
    'passport_number', 'drivers_license',
    'bank_account_number', 'routing_number', 'iban', 'swift_code',
    'credit_card', 'card_number', 'cvv', 'card_expiry',
    'private_key', 'seed_phrase', 'mnemonic', 'secret_key',
    'password', 'password_hash', 'totp_secret', 'backup_codes',
  ]),
  // SENSITIVE: Encrypted at rest, partially masked in responses
  sensitive: new Set([
    'email', 'phone', 'phone_number', 'mobile',
    'date_of_birth', 'dob', 'birth_date',
    'address', 'street_address', 'address_line1', 'address_line2',
    'city', 'postal_code', 'zip_code',
    'full_name', 'first_name', 'last_name',
    'ip_address', 'device_fingerprint',
  ]),
  // INTERNAL: Never exposed in API responses
  internal: new Set([
    'password_hash', 'totp_secret', 'backup_codes', 'refresh_token_hash',
    'internal_notes', 'admin_notes', 'risk_score_raw',
    'encryption_iv', 'encryption_tag', 'key_version',
  ]),
};

// ────────────────────────────────────────────
// 2. MASKING FUNCTIONS
// Different masking strategies per data type
// ────────────────────────────────────────────
const MASKS = {
  email: (v) => {
    if (!v || typeof v !== 'string') return '***';
    const [local, domain] = v.split('@');
    if (!domain) return '***@***';
    return `${local[0]}${'*'.repeat(Math.max(local.length - 2, 1))}${local.length > 1 ? local[local.length - 1] : ''}@${domain}`;
  },
  phone: (v) => {
    if (!v || typeof v !== 'string') return '***';
    const digits = v.replace(/\D/g, '');
    if (digits.length < 4) return '***';
    return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
  },
  name: (v) => {
    if (!v || typeof v !== 'string') return '***';
    return `${v[0]}${'*'.repeat(Math.max(v.length - 1, 1))}`;
  },
  address: (v) => {
    if (!v || typeof v !== 'string') return '*** [redacted]';
    const words = v.split(' ');
    return words.length > 2 ? `${words[0]} *** ${words[words.length - 1]}` : '*** [redacted]';
  },
  id: (v) => {
    if (!v || typeof v !== 'string') return '***';
    if (v.length <= 4) return '***';
    return `${'*'.repeat(v.length - 4)}${v.slice(-4)}`;
  },
  date: (v) => {
    if (!v) return '***';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '***';
    return `****-**-${String(d.getDate()).padStart(2, '0')}`;
  },
  full: () => '[REDACTED]',
};

// Map field names to mask functions
const FIELD_MASKS = {
  email: MASKS.email,
  phone: MASKS.phone, phone_number: MASKS.phone, mobile: MASKS.phone,
  full_name: MASKS.name, first_name: MASKS.name, last_name: MASKS.name, name: MASKS.name,
  address: MASKS.address, street_address: MASKS.address, address_line1: MASKS.address, address_line2: MASKS.address,
  date_of_birth: MASKS.date, dob: MASKS.date, birth_date: MASKS.date,
  ssn: MASKS.id, social_security: MASKS.id, tax_id: MASKS.id, national_id: MASKS.id,
  passport_number: MASKS.id, drivers_license: MASKS.id,
  bank_account_number: MASKS.id, iban: MASKS.id,
  ip_address: MASKS.id, device_fingerprint: MASKS.id,
};

function maskField(key, value) {
  const fn = FIELD_MASKS[key] || MASKS.full;
  return fn(value);
}

// ────────────────────────────────────────────
// 3. RESPONSE MASKING MIDDLEWARE
// Automatically masks PII in API responses
// based on the caller's role
// ────────────────────────────────────────────
function responseDataMasking(options = {}) {
  // Roles that can see unmasked PII
  const privilegedRoles = new Set(options.privilegedRoles || [
    'super_admin', 'admin', 'compliance',
  ]);
  // Endpoints exempt from masking (e.g., user viewing own profile)
  const exemptPaths = options.exemptPaths || [
    /\/api\/v1\/auth\/me$/,
    /\/api\/v1\/profile$/,
  ];

  return (req, res, next) => {
    // Skip for privileged roles
    if (req.user && privilegedRoles.has(req.user.role)) return next();
    // Skip for exempt paths
    if (exemptPaths.some(p => p.test(req.path))) return next();

    // Intercept res.json
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      try {
        const masked = maskObject(data);
        return originalJson(masked);
      } catch (err) {
        logger.error('PII masking error', { error: err.message, path: req.path });
        return originalJson(data);
      }
    };
    next();
  };
}

function maskObject(obj, depth = 0) {
  if (depth > 15) return obj; // Prevent infinite recursion
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => maskObject(item, depth + 1));
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();

    // INTERNAL fields: strip entirely
    if (CLASSIFICATION.internal.has(keyLower)) {
      continue; // Don't include in response
    }
    // CRITICAL fields: fully redact
    if (CLASSIFICATION.critical.has(keyLower)) {
      result[key] = '[REDACTED]';
      continue;
    }
    // SENSITIVE fields: apply appropriate mask
    if (CLASSIFICATION.sensitive.has(keyLower)) {
      result[key] = typeof value === 'string' ? maskField(keyLower, value) : '[REDACTED]';
      continue;
    }
    // Recurse into nested objects
    if (typeof value === 'object' && value !== null) {
      result[key] = maskObject(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ────────────────────────────────────────────
// 4. LOG SANITIZER
// Prevents PII from appearing in log output
// ────────────────────────────────────────────
function sanitizeForLog(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(i => sanitizeForLog(i, depth + 1));

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    if (CLASSIFICATION.critical.has(keyLower) || CLASSIFICATION.internal.has(keyLower)) {
      clean[key] = '[***]';
    } else if (CLASSIFICATION.sensitive.has(keyLower)) {
      clean[key] = typeof value === 'string' ? `${value.substring(0, 2)}***` : '[***]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitizeForLog(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

// ────────────────────────────────────────────
// 5. REQUEST BODY PII DETECTION
// Warns if PII is being sent in query strings
// (should only be in POST body or encrypted)
// ────────────────────────────────────────────
function piiQueryGuard() {
  return (req, res, next) => {
    if (!req.query || Object.keys(req.query).length === 0) return next();
    const allSensitive = new Set([...CLASSIFICATION.critical, ...CLASSIFICATION.sensitive]);
    for (const key of Object.keys(req.query)) {
      if (allSensitive.has(key.toLowerCase())) {
        logger.warn('PII detected in query string', {
          field: key, path: req.path, ip: req.ip, userId: req.user?.id,
        });
        // Don't block — just log (some systems legitimately use email in query)
        // But for critical fields, block outright
        if (CLASSIFICATION.critical.has(key.toLowerCase())) {
          return res.status(400).json({
            error: 'Sensitive data must not be sent in URL parameters',
            code: 'PII_IN_URL',
          });
        }
      }
    }
    next();
  };
}

// ────────────────────────────────────────────
// 6. FIELD-LEVEL ENCRYPTION HELPERS
// For encrypting PII columns at the service layer
// ────────────────────────────────────────────
const ALGO = 'aes-256-gcm';
const KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : crypto.scryptSync(config.jwt?.secret || 'fallback-key', 'pii-salt', 32);

function encryptField(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc:${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptField(ciphertext) {
  if (!ciphertext || !ciphertext.startsWith('enc:')) return ciphertext;
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4) return ciphertext;
    const [, ivHex, tagHex, data] = parts;
    const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error('Field decryption failed', { error: err.message });
    return '[DECRYPTION_ERROR]';
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:');
}

module.exports = {
  CLASSIFICATION,
  MASKS,
  maskField,
  maskObject,
  responseDataMasking,
  sanitizeForLog,
  piiQueryGuard,
  encryptField,
  decryptField,
  isEncrypted,
};
