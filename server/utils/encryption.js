// ================================================================
// T1 BROKER — ENCRYPTION UTILITIES
// AES-256-GCM (authenticated encryption) for field-level PII
// Backward-compatible: reads old CBC data, writes new GCM data
// ================================================================
const crypto = require('crypto');
const config = require('../config');

// ── Key derivation — ensure 32-byte key regardless of input format ──
const ENCRYPTION_KEY = (() => {
  const raw = config.encryption.key;
  if (!raw) throw new Error('ENCRYPTION_KEY is required');
  // If it's exactly 64 hex chars (32 bytes), use directly
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  // Otherwise derive via scrypt with a fixed application salt
  return crypto.scryptSync(raw, 'T1BrokerEncKeyDerivation2025', 32);
})();

const GCM_ALGORITHM = 'aes-256-gcm';
const CBC_ALGORITHM = 'aes-256-cbc'; // legacy read-only
const GCM_IV_LENGTH = 12;  // 96 bits — recommended for GCM
const GCM_TAG_LENGTH = 16; // 128-bit auth tag
const VERSION_PREFIX = 'v2:'; // distinguishes GCM from legacy CBC

/**
 * Encrypt with AES-256-GCM (authenticated encryption).
 * Output format: "v2:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, ENCRYPTION_KEY, iv, { authTagLength: GCM_TAG_LENGTH });
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${VERSION_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt — auto-detects GCM (v2:) or legacy CBC format.
 * Returns null on any failure (tampered, corrupted, wrong key).
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    if (encryptedText.startsWith(VERSION_PREFIX)) {
      // ── GCM decryption ──
      const payload = encryptedText.substring(VERSION_PREFIX.length);
      const [ivHex, authTagHex, cipherHex] = payload.split(':');
      if (!ivHex || !authTagHex || !cipherHex) return null;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const decipher = crypto.createDecipheriv(GCM_ALGORITHM, ENCRYPTION_KEY, iv, { authTagLength: GCM_TAG_LENGTH });
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } else {
      // ── Legacy CBC decryption (backward compatibility) ──
      const [ivHex, encrypted] = encryptedText.split(':');
      if (!ivHex || !encrypted) return null;
      const iv = Buffer.from(ivHex, 'hex');
      const legacyKey = Buffer.from(config.encryption.key, 'hex').length === 32
        ? Buffer.from(config.encryption.key, 'hex')
        : crypto.scryptSync(config.encryption.key, 'salt', 32);
      const decipher = crypto.createDecipheriv(CBC_ALGORITHM, legacyKey, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }
  } catch (err) {
    // Corrupted, tampered, or wrong key — return null instead of crashing
    return null;
  }
}

/**
 * Re-encrypt a value from legacy CBC to GCM.
 * Returns new ciphertext or null if decryption fails.
 */
function reEncrypt(legacyCiphertext) {
  const plain = decrypt(legacyCiphertext);
  if (!plain) return null;
  return encrypt(plain);
}

/**
 * Check if a value uses the latest encryption format.
 */
function isCurrentFormat(ciphertext) {
  return ciphertext && ciphertext.startsWith(VERSION_PREFIX);
}

function hashSHA512(data) {
  return crypto.createHash('sha512').update(String(data)).digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSecureToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * HMAC-SHA256 for data integrity verification.
 */
function hmacSign(data) {
  return crypto.createHmac('sha256', ENCRYPTION_KEY).update(String(data)).digest('hex');
}

function hmacVerify(data, signature) {
  const expected = hmacSign(data);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Timing-safe string comparison (prevents timing attacks on token comparisons).
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
  encrypt, decrypt, reEncrypt, isCurrentFormat,
  hashSHA512, hashToken, generateSecureToken,
  hmacSign, hmacVerify, safeCompare,
};
