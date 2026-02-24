// ================================================================
// T1 BROKER — SERVER CONFIGURATION
// ================================================================
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000'),
  apiPrefix: process.env.API_PREFIX || '/api/v1',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    name: process.env.DB_NAME || 't1broker',
    user: process.env.DB_USER || 't1admin',
    password: process.env.DB_PASSWORD || 'password',
    ssl: process.env.DB_SSL === 'true',
    poolMin: parseInt(process.env.DB_POOL_MIN || '2'),
    poolMax: parseInt(process.env.DB_POOL_MAX || '20'),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-replace-in-production-immediately',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-replace',
    expiry: process.env.JWT_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef',
    ivLength: parseInt(process.env.ENCRYPTION_IV_LENGTH || '16'),
  },

  saxo: {
    baseUrl: process.env.SAXO_BASE_URL || 'https://gateway.saxobank.com/openapi',
    appKey: process.env.SAXO_APP_KEY || '',
    appSecret: process.env.SAXO_APP_SECRET || '',
    tokenEndpoint: process.env.SAXO_TOKEN_ENDPOINT || 'https://live.logonvalidation.net/token',
    redirectUri: process.env.SAXO_REDIRECT_URI || '',
    webhookSecret: process.env.SAXO_WEBHOOK_SECRET || '',
  },

  drivewealth: {
    baseUrl: process.env.DW_BASE_URL || 'https://bo-api.drivewealth.io/back-office',
    apiKey: process.env.DW_API_KEY || '',
    apiSecret: process.env.DW_API_SECRET || '',
    wsUrl: process.env.DW_WS_URL || 'wss://stream.drivewealth.io',
    webhookSecret: process.env.DW_WEBHOOK_SECRET || '',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },

  mfa: {
    issuer: process.env.MFA_ISSUER || 'T1Broker',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/app.log',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0'),
  },

  email: {
    provider: process.env.EMAIL_PROVIDER || 'console', // 'ses', 'sendgrid', 'console'
    from: process.env.EMAIL_FROM || 'noreply@t1broker.com',
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
  },

  // Cloud storage: supports both AWS S3 and DigitalOcean Spaces (S3-compatible)
  // For DO Spaces: set DO_SPACES_ENDPOINT=nyc3.digitaloceanspaces.com
  aws: {
    region: process.env.AWS_REGION || process.env.DO_SPACES_REGION || 'us-east-1',
    s3Bucket: process.env.S3_BUCKET || process.env.DO_SPACES_BUCKET || 't1-broker-documents',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.DO_SPACES_KEY || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.DO_SPACES_SECRET || '',
    endpoint: process.env.S3_ENDPOINT || process.env.DO_SPACES_ENDPOINT || '',
  },

  // Backup encryption (AES-256-GCM for backup files at rest)
  backupEncryptionKey: process.env.BACKUP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '',

  uploads: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB
    allowedMimes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    storagePath: process.env.UPLOAD_PATH || 'uploads/',
  },

  margin: {
    maintenanceRatio: parseFloat(process.env.MARGIN_MAINTENANCE_RATIO || '0.25'),
    initialRatio: parseFloat(process.env.MARGIN_INITIAL_RATIO || '0.50'),
    callDeadlineHours: parseInt(process.env.MARGIN_CALL_DEADLINE_HOURS || '24'),
    autoLiquidate: process.env.MARGIN_AUTO_LIQUIDATE === 'true',
  },
};

// ================================================================
// DYNAMIC CONFIG — Overrides from platform_settings table
// Loaded at startup and refreshed every 60s so admin changes
// take effect without a restart for most settings.
// ================================================================
let _dynamicRefreshTimer = null;

config.loadFromDB = async function loadFromDB() {
  try {
    const db = require('./database');
    const rows = await db('platform_settings').select('key', 'value', 'value_type');
    const s = {};
    for (const r of rows) {
      switch (r.value_type) {
        case 'number':  s[r.key] = parseFloat(r.value); break;
        case 'boolean': s[r.key] = r.value === 'true';  break;
        case 'json':    try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; } break;
        default:        s[r.key] = r.value;
      }
    }

    // Map DB settings → config properties (services read these)
    // Margin
    if (s['margin.initial_ratio'] !== undefined)       config.margin.initialRatio = s['margin.initial_ratio'];
    if (s['margin.maintenance_ratio'] !== undefined)    config.margin.maintenanceRatio = s['margin.maintenance_ratio'];
    if (s['margin.liquidation_threshold'] !== undefined) config.margin.liquidationThreshold = s['margin.liquidation_threshold'];
    if (s['margin.call_deadline_hours'] !== undefined)  config.margin.callDeadlineHours = s['margin.call_deadline_hours'];
    if (s['margin.auto_liquidate'] !== undefined)       config.margin.autoLiquidate = s['margin.auto_liquidate'];

    // Trading
    config.trading = {
      defaultCommissionRate: s['trading.default_commission_rate'] || 0.001,
      clearingFeeRate:       s['trading.clearing_fee_rate'] || 0.0001,
      defaultSettlement:     s['trading.default_settlement'] || 'T+2',
      slippageLimit:         s['trading.market_order_slippage_limit'] || 0.02,
      maxOrderValue:         s['trading.max_order_value'] || 1000000,
      minOrderValue:         s['trading.min_order_value'] || 1,
      allowFractional:       s['trading.allow_fractional'] !== undefined ? s['trading.allow_fractional'] : true,
      allowShortSelling:     s['trading.allow_short_selling'] !== undefined ? s['trading.allow_short_selling'] : true,
      autoCancelEOD:         s['trading.auto_cancel_eod'] !== undefined ? s['trading.auto_cancel_eod'] : true,
      marketHoursStart:      s['trading.market_hours_start'] || '09:30',
      marketHoursEnd:        s['trading.market_hours_end'] || '16:00',
      allowPremarket:        s['trading.allow_premarket'] || false,
      allowAfterHours:       s['trading.allow_afterhours'] || false,
    };

    // Limits
    config.limits = {
      maxDailyTrades:           s['limits.max_daily_trades'] || 500,
      maxOpenOrders:            s['limits.max_open_orders'] || 100,
      maxPositions:             s['limits.max_positions'] || 200,
      dualAuthThreshold:        s['limits.dual_auth_threshold'] || 10000,
      fiatDepositDailyLimit:    s['limits.fiat_deposit_daily_limit'] || 100000,
      fiatWithdrawalDailyLimit: s['limits.fiat_withdrawal_daily_limit'] || 50000,
      cryptoWithdrawalDailyUSD: s['limits.crypto_withdrawal_daily_usd'] || 25000,
      maxLeverage:              s['limits.max_leverage'] || 4,
      newBankCoolingOffHours:   s['limits.new_bank_cooling_off_hours'] || 72,
    };

    // Fees
    config.fees = {
      equityCommission:      s['fees.equity_commission'] || 0.001,
      forexCommission:       s['fees.forex_commission'] || 0.0005,
      cryptoCommission:      s['fees.crypto_commission'] || 0.002,
      minCommission:         s['fees.min_commission'] || 1.0,
      withdrawalFeeFiat:     s['fees.withdrawal_fee_fiat'] || 0,
      inactivityFeeMonthly:  s['fees.inactivity_fee_monthly'] || 0,
      custodyFeeAnnualBps:   s['fees.custody_fee_annual_bps'] || 0,
    };

    // Security (non-restart settings)
    config.security = {
      maxLoginAttempts:     s['security.max_login_attempts'] || 5,
      lockoutDurationMin:   s['security.lockout_duration_minutes'] || 30,
      requireMFAAdmin:      s['security.require_mfa_admin'] !== undefined ? s['security.require_mfa_admin'] : true,
      requireMFAWithdrawals: s['security.require_mfa_withdrawals'] !== undefined ? s['security.require_mfa_withdrawals'] : true,
      sessionTimeoutMin:    s['security.session_timeout_minutes'] || 30,
      trustedDeviceDays:    s['security.trusted_device_days'] || 30,
      passwordMinLength:    s['security.password_min_length'] || 8,
      ipWhitelistEnabled:   s['security.ip_whitelist_enabled'] || false,
      ipWhitelist:          s['security.ip_whitelist'] || [],
    };

    // KYC
    config.kyc = {
      requireForTrading:     s['kyc.require_for_trading'] !== undefined ? s['kyc.require_for_trading'] : true,
      requireForDeposits:    s['kyc.require_for_deposits'] || false,
      requireForWithdrawals: s['kyc.require_for_withdrawals'] !== undefined ? s['kyc.require_for_withdrawals'] : true,
      autoApproveThreshold:  s['kyc.auto_approve_threshold_usd'] || 0,
      rekycIntervalMonths:   s['kyc.rekyc_interval_months'] || 12,
      maxDocumentSizeMB:     s['kyc.max_document_size_mb'] || 10,
      allowedDocumentTypes:  s['kyc.allowed_document_types'] || ['passport','national_id','drivers_license','proof_of_address','selfie','tax_document'],
    };

    // Notifications
    config.notifications = {
      emailEnabled:        s['notifications.email_enabled'] !== undefined ? s['notifications.email_enabled'] : true,
      pushEnabled:         s['notifications.push_enabled'] !== undefined ? s['notifications.push_enabled'] : true,
      smsEnabled:          s['notifications.sms_enabled'] || false,
      dailySummaryEnabled: s['notifications.daily_summary_enabled'] !== undefined ? s['notifications.daily_summary_enabled'] : true,
      dailySummaryTime:    s['notifications.daily_summary_time'] || '18:00',
      marginCallChannels:  s['notifications.margin_call_channels'] || ['email','push','sms'],
      supportEmail:        s['notifications.support_email'] || 'support@t1broker.com',
    };

    // Branding
    config.branding = {
      platformName:  s['branding.platform_name'] || 'T1 Broker',
      companyName:   s['branding.company_name'] || 'T1 Financial Ltd',
      supportUrl:    s['branding.support_url'] || 'https://support.t1broker.com',
      termsUrl:      s['branding.terms_url'] || 'https://t1broker.com/terms',
      privacyUrl:    s['branding.privacy_url'] || 'https://t1broker.com/privacy',
      primaryColor:  s['branding.primary_color'] || '#3b82f6',
      logoUrl:       s['branding.logo_url'] || '',
    };

    // System
    config.system = {
      maintenanceMode:     s['system.maintenance_mode'] || false,
      maintenanceMessage:  s['system.maintenance_message'] || '',
      registrationEnabled: s['system.registration_enabled'] !== undefined ? s['system.registration_enabled'] : true,
      demoMode:            s['system.demo_mode'] || false,
      logLevel:            s['system.log_level'] || 'info',
      maxUploadSizeMB:     s['system.max_upload_size_mb'] || 25,
      backupEnabled:       s['system.backup_enabled'] !== undefined ? s['system.backup_enabled'] : true,
      backupFrequencyHrs:  s['system.backup_frequency_hours'] || 6,
      eodSnapshotTime:     s['system.eod_snapshot_time'] || '16:30',
      settlementAutoRun:   s['system.settlement_auto_run'] !== undefined ? s['system.settlement_auto_run'] : true,
      settlementTime:      s['system.settlement_time'] || '17:00',
    };

    const logger = require('../utils/logger');
    logger.debug(`Dynamic config loaded: ${rows.length} settings from platform_settings`);
  } catch (err) {
    // DB might not be ready yet (migrations pending) — use defaults
    const logger = require('../utils/logger');
    logger.warn('Could not load dynamic config from DB, using defaults', { error: err.message });
  }
};

config.startDynamicRefresh = function (intervalMs = 60000) {
  if (_dynamicRefreshTimer) clearInterval(_dynamicRefreshTimer);
  _dynamicRefreshTimer = setInterval(() => config.loadFromDB(), intervalMs);
};

config.stopDynamicRefresh = function () {
  if (_dynamicRefreshTimer) { clearInterval(_dynamicRefreshTimer); _dynamicRefreshTimer = null; }
};

module.exports = config;
