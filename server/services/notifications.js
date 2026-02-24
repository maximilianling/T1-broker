// ================================================================
// T1 BROKER — EMAIL & NOTIFICATION SERVICE
// Transactional email via SES/SendGrid + in-app notifications
// ================================================================
const config = require('../config');
const db = require('../config/database');
const logger = require('../utils/logger');
const redis = require('../utils/redis');

class EmailService {
  constructor() {
    this.provider = config.email?.provider || 'console'; // 'ses', 'sendgrid', 'console'
    this.from = config.email?.from || 'noreply@t1broker.com';
    this.templates = this._loadTemplates();
  }

  // ----------------------------------------------------------------
  // Send email (queued via Redis for reliability)
  // ----------------------------------------------------------------
  async send({ to, subject, template, data, priority = 'normal' }) {
    // Check if email notifications are enabled in platform settings
    if (config.notifications && config.notifications.emailEnabled === false) {
      logger.debug('Email skipped — disabled in platform settings', { to, subject });
      return { queued: false, reason: 'email_disabled' };
    }
    const email = {
      id: require('uuid').v4(),
      to,
      from: this.from,
      subject,
      html: this._render(template, data),
      priority,
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    // Queue for async processing
    await redis.client.lpush('email:queue', JSON.stringify(email));

    logger.info('Email queued', { id: email.id, to, subject, template });
    return email.id;
  }

  // ----------------------------------------------------------------
  // Process email queue (called by worker)
  // ----------------------------------------------------------------
  async processQueue() {
    const raw = await redis.client.rpop('email:queue');
    if (!raw) return null;

    const email = JSON.parse(raw);
    email.attempts++;

    try {
      await this._deliver(email);
      logger.info('Email delivered', { id: email.id, to: email.to });
      return { delivered: true, id: email.id };
    } catch (err) {
      logger.error('Email delivery failed', { id: email.id, error: err.message, attempts: email.attempts });

      if (email.attempts < 3) {
        // Re-queue with backoff
        await redis.client.lpush('email:retry', JSON.stringify(email));
      } else {
        // Dead letter
        await redis.client.lpush('email:dead', JSON.stringify({ ...email, error: err.message }));
        logger.error('Email moved to dead letter queue', { id: email.id, to: email.to });
      }
      return { delivered: false, id: email.id, error: err.message };
    }
  }

  // ----------------------------------------------------------------
  // Actual delivery based on provider
  // ----------------------------------------------------------------
  async _deliver(email) {
    switch (this.provider) {
      case 'ses': {
        const AWS = require('aws-sdk');
        const ses = new AWS.SES({ region: config.aws?.region || 'us-east-1' });
        await ses.sendEmail({
          Source: email.from,
          Destination: { ToAddresses: [email.to] },
          Message: {
            Subject: { Data: email.subject },
            Body: { Html: { Data: email.html } },
          },
        }).promise();
        break;
      }

      case 'sendgrid': {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(config.email.sendgridApiKey);
        await sgMail.send({
          to: email.to,
          from: email.from,
          subject: email.subject,
          html: email.html,
        });
        break;
      }

      case 'console':
      default:
        logger.info(`📧 EMAIL [${email.to}] ${email.subject}`);
        if (config.env === 'development') {
          logger.debug('Email body preview', { html: email.html.substring(0, 200) });
        }
        break;
    }
  }

  // ----------------------------------------------------------------
  // Email templates
  // ----------------------------------------------------------------
  _loadTemplates() {
    return {
      welcome: {
        subject: 'Welcome to T1 Broker',
        body: `<h2>Welcome, {{name}}!</h2>
          <p>Your trading account has been created. Account number: <strong>{{accountNumber}}</strong></p>
          <p>Next steps:</p>
          <ol><li>Complete KYC verification</li><li>Fund your account</li><li>Start trading</li></ol>
          <p>If you have questions, contact support@t1broker.com</p>`,
      },

      orderFilled: {
        subject: 'Order Filled — {{symbol}} {{side}} {{quantity}}',
        body: `<h2>Order Executed</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Order</strong></td><td style="padding:8px;border:1px solid #ddd">{{orderRef}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Symbol</strong></td><td style="padding:8px;border:1px solid #ddd">{{symbol}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Side</strong></td><td style="padding:8px;border:1px solid #ddd">{{side}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Quantity</strong></td><td style="padding:8px;border:1px solid #ddd">{{quantity}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Fill Price</strong></td><td style="padding:8px;border:1px solid #ddd">\${{fillPrice}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Commission</strong></td><td style="padding:8px;border:1px solid #ddd">\${{commission}}</td></tr>
          </table>`,
      },

      orderRejected: {
        subject: 'Order Rejected — {{symbol}}',
        body: `<h2>Order Rejected</h2><p>Your {{side}} order for {{quantity}} {{symbol}} was rejected.</p>
          <p><strong>Reason:</strong> {{reason}}</p>
          <p>If you believe this is an error, please contact support.</p>`,
      },

      depositConfirmed: {
        subject: 'Deposit Confirmed — ${{amount}}',
        body: `<h2>Deposit Received</h2><p>Your deposit of <strong>\${{amount}}</strong> has been credited.</p>
          <p>New balance: <strong>\${{newBalance}}</strong></p>`,
      },

      withdrawalPending: {
        subject: 'Withdrawal Request — ${{amount}}',
        body: `<h2>Withdrawal Pending</h2><p>Your withdrawal of <strong>\${{amount}}</strong> is awaiting approval.</p>
          <p>Expected processing time: 1-2 business days after approval.</p>`,
      },

      withdrawalApproved: {
        subject: 'Withdrawal Approved — ${{amount}}',
        body: `<h2>Withdrawal Approved</h2><p>Your withdrawal of <strong>\${{amount}}</strong> has been approved and is being processed.</p>`,
      },

      kycApproved: {
        subject: 'KYC Verification Approved',
        body: `<h2>You're Verified!</h2><p>Your identity verification is complete. Your account is now fully active.</p>
          <p>You can now deposit funds and start trading.</p>`,
      },

      kycRejected: {
        subject: 'KYC Verification — Additional Documents Needed',
        body: `<h2>Document Review</h2><p>We need additional information to complete verification.</p>
          <p><strong>Reason:</strong> {{reason}}</p><p>Please log in and upload the requested documents.</p>`,
      },

      marginCall: {
        subject: '⚠️ Margin Call — Action Required',
        body: `<h2 style="color:#ef4444">Margin Call Notice</h2>
          <p>Your account has fallen below the required margin level.</p>
          <p><strong>Required margin:</strong> \${{requiredMargin}}</p>
          <p><strong>Current equity:</strong> \${{currentEquity}}</p>
          <p><strong>Deadline:</strong> {{deadline}}</p>
          <p>Please deposit funds or close positions before the deadline to avoid liquidation.</p>`,
      },

      passwordReset: {
        subject: 'Password Reset Request',
        body: `<h2>Reset Your Password</h2><p>Click the link below to reset your password. This link expires in 1 hour.</p>
          <p><a href="{{resetUrl}}" style="background:#3b82f6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reset Password</a></p>
          <p>If you didn't request this, ignore this email.</p>`,
      },

      securityAlert: {
        subject: '🔒 Security Alert — {{eventType}}',
        body: `<h2>Security Alert</h2><p>We detected unusual activity on your account:</p>
          <p><strong>Event:</strong> {{eventType}}</p>
          <p><strong>IP Address:</strong> {{ipAddress}}</p>
          <p><strong>Time:</strong> {{timestamp}}</p>
          <p>If this wasn't you, please change your password immediately and contact support.</p>`,
      },

      rekycReminder: {
        subject: 'KYC Renewal Required',
        body: `<h2>Time to Renew</h2><p>Your KYC verification expires on <strong>{{expiryDate}}</strong>.</p>
          <p>Please log in and update your documents to avoid account restrictions.</p>`,
      },

      mfaEmailCode: {
        subject: '{{code}} — Your T1 Broker Verification Code',
        body: `<h2 style="text-align:center;margin-bottom:8px">Verification Code</h2>
          <div style="text-align:center;padding:24px;margin:20px 0;background:#f0f4ff;border-radius:12px">
            <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a2e;font-family:monospace">{{code}}</div>
          </div>
          <p style="text-align:center;color:#666">This code expires in <strong>{{expiresMinutes}} minutes</strong>.</p>
          <p style="text-align:center;color:#666">If you didn't request this code, please ignore this email and consider changing your password.</p>`,
      },

      newDeviceLogin: {
        subject: 'New Login from {{deviceName}}',
        body: `<h2>New Device Login Detected</h2>
          <p>Your T1 Broker account was just accessed from a new device:</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Device</strong></td><td style="padding:8px;border:1px solid #ddd">{{deviceName}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>IP Address</strong></td><td style="padding:8px;border:1px solid #ddd">{{ipAddress}}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Time</strong></td><td style="padding:8px;border:1px solid #ddd">{{timestamp}}</td></tr>
          </table>
          <p>If this was you, you can ignore this email. If not, please change your password immediately.</p>`,
      },
    };
  }

  _render(templateName, data = {}) {
    const tmpl = this.templates[templateName];
    if (!tmpl) {
      logger.warn(`Email template not found: ${templateName}`);
      return `<p>${JSON.stringify(data)}</p>`;
    }

    let html = tmpl.body;
    for (const [key, value] of Object.entries(data)) {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }

    // Wrap in base template
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
      <body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a2e">
        <div style="border-bottom:3px solid #3b82f6;padding-bottom:16px;margin-bottom:24px">
          <strong style="font-size:20px;color:#3b82f6">T1 Broker</strong>
        </div>
        ${html}
        <div style="border-top:1px solid #e5e7eb;margin-top:32px;padding-top:16px;font-size:12px;color:#6b7280">
          <p>This is an automated message from T1 Broker. Do not reply to this email.</p>
          <p>© ${new Date().getFullYear()} T1 Broker. All rights reserved.</p>
        </div>
      </body></html>`;
  }

  getSubject(templateName, data = {}) {
    const tmpl = this.templates[templateName];
    if (!tmpl) return 'T1 Broker Notification';
    let subject = tmpl.subject;
    for (const [key, value] of Object.entries(data)) {
      subject = subject.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }
    return subject;
  }
}

// ================================================================
// IN-APP NOTIFICATION SERVICE
// ================================================================
class NotificationService {
  static async create({ userId, title, message, type = 'info', link = null }) {
    const [notif] = await db('notifications').insert({
      user_id: userId,
      title,
      message,
      type,
      link,
    }).returning('*');

    // Push via WebSocket if available
    try {
      await redis.publish(`ws:notification:${userId}`, {
        type: 'notification',
        data: notif,
      });
    } catch (e) { /* Redis may not be connected */ }

    return notif;
  }

  static async getUnread(userId, limit = 20) {
    return db('notifications')
      .where('user_id', userId)
      .where('is_read', false)
      .orderBy('created_at', 'desc')
      .limit(limit);
  }

  static async markRead(userId, notificationId) {
    await db('notifications')
      .where('id', notificationId)
      .where('user_id', userId)
      .update({ is_read: true });
  }

  static async markAllRead(userId) {
    await db('notifications')
      .where('user_id', userId)
      .where('is_read', false)
      .update({ is_read: true });
  }

  static async getCount(userId) {
    const [{ count }] = await db('notifications')
      .where('user_id', userId)
      .where('is_read', false)
      .count();
    return parseInt(count);
  }
}

const emailService = new EmailService();
module.exports = { emailService, NotificationService };
