// ================================================================
// T1 BROKER — REQUEST VALIDATION MIDDLEWARE
// Joi-based schemas for all API inputs
// ================================================================
const Joi = require('joi');

// ----------------------------------------------------------------
// Validation wrapper
// ----------------------------------------------------------------
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    req[property] = value;
    next();
  };
}

// ----------------------------------------------------------------
// Auth schemas
// ----------------------------------------------------------------
const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(128).required(),
});

const mfaVerifySchema = Joi.object({
  token: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(12).max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/)
    .required()
    .messages({
      'string.pattern.base': 'Password must contain uppercase, lowercase, number, and special character',
    }),
  firstName: Joi.string().min(1).max(100).required(),
  lastName: Joi.string().min(1).max(100).required(),
  countryOfResidence: Joi.string().length(2).uppercase().required(),
  clientType: Joi.string().valid('retail', 'professional', 'institutional').default('retail'),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(12).max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/)
    .required(),
});

// ----------------------------------------------------------------
// Order schemas
// ----------------------------------------------------------------
const createOrderSchema = Joi.object({
  instrumentId: Joi.string().uuid().required(),
  side: Joi.string().valid('buy', 'sell').required(),
  orderType: Joi.string().valid('market', 'limit', 'stop', 'stop_limit', 'trailing_stop').required(),
  quantity: Joi.number().positive().required(),
  price: Joi.number().positive().when('orderType', {
    is: Joi.valid('limit', 'stop_limit'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  stopPrice: Joi.number().positive().when('orderType', {
    is: Joi.valid('stop', 'stop_limit'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  trailAmount: Joi.number().positive().when('orderType', {
    is: 'trailing_stop',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  timeInForce: Joi.string().valid('day', 'gtc', 'ioc', 'fok', 'gtd').default('day'),
  expireAt: Joi.date().iso().when('timeInForce', {
    is: 'gtd',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
});

const cancelOrderSchema = Joi.object({
  reason: Joi.string().max(255).optional(),
});

// ----------------------------------------------------------------
// Client schemas
// ----------------------------------------------------------------
const createClientSchema = Joi.object({
  email: Joi.string().email().required(),
  firstName: Joi.string().min(1).max(100).required(),
  lastName: Joi.string().min(1).max(100).required(),
  dateOfBirth: Joi.date().iso().optional(),
  nationality: Joi.string().length(2).uppercase().optional(),
  countryOfResidence: Joi.string().length(2).uppercase().required(),
  phone: Joi.string().max(50).optional(),
  clientType: Joi.string().valid('retail', 'professional', 'institutional').default('retail'),
  riskLevel: Joi.string().valid('low', 'medium', 'high', 'very_high').default('medium'),
  baseCurrency: Joi.string().length(3).uppercase().default('USD'),
  partnerId: Joi.string().uuid().optional(),
});

const updateClientSchema = Joi.object({
  firstName: Joi.string().min(1).max(100).optional(),
  lastName: Joi.string().min(1).max(100).optional(),
  phone: Joi.string().max(50).optional(),
  riskLevel: Joi.string().valid('low', 'medium', 'high', 'very_high').optional(),
  status: Joi.string().valid('pending', 'active', 'dormant', 'suspended', 'closed').optional(),
  kycStatus: Joi.string().valid(
    'not_started', 'in_progress', 'pending_review', 'approved', 'rejected', 'rekyc_required'
  ).optional(),
  notes: Joi.string().max(2000).optional(),
}).min(1);

// ----------------------------------------------------------------
// Transfer schemas
// ----------------------------------------------------------------
const createTransferSchema = Joi.object({
  type: Joi.string().valid('deposit', 'withdrawal').required(),
  amount: Joi.number().positive().precision(2).required(),
  currency: Joi.string().length(3).uppercase().default('USD'),
  bankAccountId: Joi.string().uuid().required(),
  description: Joi.string().max(255).optional(),
});

// ----------------------------------------------------------------
// Query parameter schemas
// ----------------------------------------------------------------
const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
});

const auditQuerySchema = Joi.object({
  userId: Joi.string().uuid().optional(),
  action: Joi.string().max(255).optional(),
  resourceType: Joi.string().max(100).optional(),
  level: Joi.string().valid('info', 'warning', 'critical', 'success').optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
});

// ----------------------------------------------------------------
// Admin backup schemas
// ----------------------------------------------------------------
const createBackupSchema = Joi.object({
  trigger: Joi.string().valid('manual', 'pre_deploy').default('manual'),
  notes: Joi.string().max(500).optional(),
});

const backupQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(50),
  status: Joi.string().valid('completed', 'failed', 'in_progress', 'uploaded', 'deleted').optional(),
  trigger: Joi.string().valid('scheduled', 'manual', 'pre_deploy').optional(),
});

const backupIdSchema = Joi.object({
  id: Joi.string().uuid().required(),
});

const retentionSchema = Joi.object({
  daysToKeep: Joi.number().integer().min(1).max(365).optional(),
});

// ----------------------------------------------------------------
// Admin config schemas
// ----------------------------------------------------------------
const providerApiKeySchema = Joi.object({
  apiKey: Joi.string().min(8).max(512).required(),
  secret: Joi.string().max(512).optional(),
});

const brokerageCredentialsSchema = Joi.object({
  appKey: Joi.string().min(1).max(512).optional(),
  appSecret: Joi.string().max(512).optional(),
  accessToken: Joi.string().max(2048).optional(),
  accountId: Joi.string().max(128).optional(),
});

const addBrokerageSchema = Joi.object({
  id: Joi.string().alphanum().min(2).max(50).required(),
  name: Joi.string().min(2).max(100).required(),
  type: Joi.string().valid('rest', 'fix', 'websocket').default('rest'),
  environment: Joi.string().valid('sandbox', 'production').default('sandbox'),
});

const createInstrumentSchema = Joi.object({
  symbol: Joi.string().min(1).max(20).pattern(/^[A-Za-z0-9\/\-_.]+$/).required(),
  name: Joi.string().min(1).max(200).required(),
  assetClass: Joi.string().valid('equity', 'crypto', 'forex', 'commodity', 'index', 'etf', 'bond', 'option', 'future', 'custom').required(),
  exchange: Joi.string().max(50).optional(),
  baseCurrency: Joi.string().length(3).uppercase().optional(),
  quoteCurrency: Joi.string().length(3).uppercase().default('USD'),
  lotSize: Joi.number().positive().optional(),
  tickSize: Joi.number().positive().optional(),
  marginRate: Joi.number().min(0).max(1).optional(),
});

const setPriceSchema = Joi.object({
  bid: Joi.number().positive().required(),
  ask: Joi.number().positive().required(),
});

const createWalletSchema = Joi.object({
  blockchain: Joi.string().valid(
    'bitcoin', 'ethereum', 'solana', 'polygon', 'arbitrum',
    'optimism', 'avalanche', 'bsc', 'base', 'tron', 'litecoin', 'dogecoin', 'ripple'
  ).required(),
  label: Joi.string().max(100).optional(),
});

const storeKeySchema = Joi.object({
  encryptedKey: Joi.string().min(32).max(4096).required(),
});

// ----------------------------------------------------------------
// Admin settings schemas
// ----------------------------------------------------------------
const updateSettingSchema = Joi.object({
  value: Joi.alternatives().try(
    Joi.string().max(2048),
    Joi.number(),
    Joi.boolean()
  ).required(),
  reason: Joi.string().max(500).optional(),
});

const bulkUpdateSettingsSchema = Joi.object({
  updates: Joi.object().pattern(
    Joi.string().max(100),
    Joi.alternatives().try(Joi.string().max(2048), Joi.number(), Joi.boolean())
  ).required(),
  reason: Joi.string().max(500).optional(),
});

const settingKeySchema = Joi.object({
  key: Joi.string().pattern(/^[a-z0-9._]+$/).max(100).required(),
});

const settingCategorySchema = Joi.object({
  category: Joi.string().pattern(/^[a-z0-9_]+$/).max(50).required(),
});

// ----------------------------------------------------------------
// MFA schemas (extended)
// ----------------------------------------------------------------
const mfaSetupTOTPSchema = Joi.object({
  password: Joi.string().min(8).max(128).required(),
});

const mfaConfirmTOTPSchema = Joi.object({
  token: Joi.string().length(6).pattern(/^\d+$/).required(),
  tempSecret: Joi.string().min(16).max(128).required(),
});

const mfaConfirmEmailSchema = Joi.object({
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const mfaDisableSchema = Joi.object({
  password: Joi.string().min(8).max(128).required(),
});

const mfaBackupRegenSchema = Joi.object({
  password: Joi.string().min(8).max(128).required(),
});

const mfaVerifyExtendedSchema = Joi.object({
  code: Joi.string().min(6).max(10).required(),
  mfaToken: Joi.string().uuid().optional(),
  method: Joi.string().valid('totp', 'email', 'backup').optional(),
  trustDevice: Joi.boolean().default(false),
});

// ----------------------------------------------------------------
// Positions query schema
// ----------------------------------------------------------------
const positionsQuerySchema = Joi.object({
  clientId: Joi.string().uuid().optional(),
  instrumentId: Joi.string().uuid().optional(),
  side: Joi.string().valid('long', 'short').optional(),
  status: Joi.string().valid('open', 'closed').optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
});

// ----------------------------------------------------------------
// Crypto withdrawal schema
// ----------------------------------------------------------------
const cryptoWithdrawSchema = Joi.object({
  blockchain: Joi.string().required(),
  toAddress: Joi.string().min(20).max(128).pattern(/^[a-zA-Z0-9]+$/).required(),
  amount: Joi.number().positive().required(),
  tokenSymbol: Joi.string().max(20).optional(),
});

module.exports = {
  validate,
  schemas: {
    login: loginSchema,
    mfaVerify: mfaVerifySchema,
    register: registerSchema,
    changePassword: changePasswordSchema,
    createOrder: createOrderSchema,
    cancelOrder: cancelOrderSchema,
    createClient: createClientSchema,
    updateClient: updateClientSchema,
    createTransfer: createTransferSchema,
    pagination: paginationSchema,
    auditQuery: auditQuerySchema,
    // Admin backup schemas
    createBackup: createBackupSchema,
    backupQuery: backupQuerySchema,
    backupId: backupIdSchema,
    retention: retentionSchema,
    // Admin config schemas
    providerApiKey: providerApiKeySchema,
    brokerageCredentials: brokerageCredentialsSchema,
    addBrokerage: addBrokerageSchema,
    createInstrument: createInstrumentSchema,
    setPrice: setPriceSchema,
    createWallet: createWalletSchema,
    storeKey: storeKeySchema,
    // Admin settings schemas
    updateSetting: updateSettingSchema,
    bulkUpdateSettings: bulkUpdateSettingsSchema,
    settingKey: settingKeySchema,
    settingCategory: settingCategorySchema,
    // MFA schemas
    mfaSetupTOTP: mfaSetupTOTPSchema,
    mfaConfirmTOTP: mfaConfirmTOTPSchema,
    mfaConfirmEmail: mfaConfirmEmailSchema,
    mfaDisable: mfaDisableSchema,
    mfaBackupRegen: mfaBackupRegenSchema,
    mfaVerifyExtended: mfaVerifyExtendedSchema,
    // Position schemas
    positionsQuery: positionsQuerySchema,
    // Crypto schemas
    cryptoWithdraw: cryptoWithdrawSchema,
  },
};
