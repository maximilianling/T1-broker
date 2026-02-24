// ================================================================
// T1 BROKER — DATABASE SEED
// Run: node database/seed.js
// Creates test users, clients, instruments, positions, orders
// ================================================================
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 't1broker',
  user: process.env.DB_USER || 't1admin',
  password: process.env.DB_PASSWORD || 'password',
});

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding database...');
    await client.query('BEGIN');

    const pw = await bcrypt.hash('T1Broker@2025!', 12);

    // ============================================================
    // USERS
    // ============================================================
    const users = [
      { id: uuid(), email: 'sarah@t1broker.com', role: 'super_admin', pw },
      { id: uuid(), email: 'mike@t1broker.com', role: 'admin', pw },
      { id: uuid(), email: 'lisa@t1broker.com', role: 'compliance', pw },
      { id: uuid(), email: 'ahmed@dubaibrokerage.ae', role: 'partner_admin', pw },
      { id: uuid(), email: 'john@email.com', role: 'client', pw },
      { id: uuid(), email: 'alice@corp.com', role: 'client', pw },
      { id: uuid(), email: 'bob@email.com', role: 'client', pw },
      { id: uuid(), email: 'maria@corp.ae', role: 'client', pw },
      { id: uuid(), email: 'david@email.kr', role: 'client', pw },
      { id: uuid(), email: 'sarah.w@hedge.com', role: 'client', pw },
      { id: uuid(), email: 'james@email.uk', role: 'client', pw },
      { id: uuid(), email: 'fatima@dubai.ae', role: 'client', pw },
    ];

    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, role, is_active, email_verified, mfa_enabled)
         VALUES ($1, $2, $3, $4, true, true, $5)
         ON CONFLICT (email) DO NOTHING`,
        [u.id, u.email, u.pw, u.role, ['super_admin', 'admin', 'compliance'].includes(u.role)]
      );
    }
    console.log(`  ✓ ${users.length} users created`);

    // ============================================================
    // PARTNERS
    // ============================================================
    const partners = [
      { id: uuid(), userId: users[3].id, name: 'Dubai International Brokerage', legal: 'DIB LLC', region: 'UAE/MENA', country: 'AE', status: 'active', rev: 60 },
      { id: uuid(), userId: null, name: 'Singapore Capital Markets', legal: 'SCM Pte Ltd', region: 'APAC', country: 'SG', status: 'active', rev: 55 },
      { id: uuid(), userId: null, name: 'London Securities Ltd', legal: 'London Securities Ltd', region: 'UK/Europe', country: 'GB', status: 'onboarding', rev: 65 },
    ];

    for (const p of partners) {
      await client.query(
        `INSERT INTO partners (id, user_id, name, legal_name, region, country, status, revenue_share_pct, contact_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [p.id, p.userId, p.name, p.legal, p.region, p.country, p.status, p.rev, `contact@${p.country.toLowerCase()}.com`]
      );
    }
    console.log(`  ✓ ${partners.length} partners created`);

    // ============================================================
    // CLIENTS
    // ============================================================
    const clients = [
      { userId: users[4].id, first: 'John', last: 'Doe', country: 'US', type: 'retail', risk: 'medium', status: 'active', kyc: 'approved', partner: null },
      { userId: users[5].id, first: 'Alice', last: 'Smith', country: 'GB', type: 'professional', risk: 'high', status: 'active', kyc: 'approved', partner: null },
      { userId: users[6].id, first: 'Bob', last: 'Johnson', country: 'US', type: 'retail', risk: 'low', status: 'active', kyc: 'approved', partner: null },
      { userId: users[7].id, first: 'Maria', last: 'Garcia', country: 'AE', type: 'professional', risk: 'medium', status: 'active', kyc: 'pending_review', partner: partners[0].id },
      { userId: users[8].id, first: 'David', last: 'Kim', country: 'KR', type: 'retail', risk: 'low', status: 'dormant', kyc: 'approved', partner: partners[1].id },
      { userId: users[9].id, first: 'Sarah', last: 'Williams', country: 'US', type: 'institutional', risk: 'high', status: 'active', kyc: 'approved', partner: null },
      { userId: users[10].id, first: 'James', last: 'Brown', country: 'GB', type: 'retail', risk: 'medium', status: 'active', kyc: 'rekyc_required', partner: partners[2].id },
      { userId: users[11].id, first: 'Fatima', last: 'Al-Sayed', country: 'AE', type: 'professional', risk: 'medium', status: 'active', kyc: 'approved', partner: partners[0].id },
    ];

    const clientIds = [];
    for (const c of clients) {
      const res = await client.query(
        `INSERT INTO clients (user_id, partner_id, first_name, last_name, country_of_residence,
         client_type, risk_level, status, kyc_status, base_currency, margin_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', $10)
         ON CONFLICT (user_id) DO UPDATE SET first_name = $3
         RETURNING id`,
        [c.userId, c.partner, c.first, c.last, c.country, c.type, c.risk, c.status, c.kyc, c.type !== 'retail']
      );
      clientIds.push(res.rows[0].id);
    }
    console.log(`  ✓ ${clients.length} clients created`);

    // ============================================================
    // INSTRUMENTS
    // ============================================================
    const instruments = [
      { sym: 'AAPL', name: 'Apple Inc.', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 189.84, dw: 'dw-aapl-001' },
      { sym: 'MSFT', name: 'Microsoft Corporation', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 417.52, dw: 'dw-msft-001' },
      { sym: 'NVDA', name: 'NVIDIA Corporation', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 875.28, dw: 'dw-nvda-001' },
      { sym: 'TSLA', name: 'Tesla Inc.', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 248.91, dw: 'dw-tsla-001' },
      { sym: 'AMZN', name: 'Amazon.com Inc.', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 178.32, dw: 'dw-amzn-001' },
      { sym: 'GOOGL', name: 'Alphabet Inc.', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 141.56, dw: 'dw-googl-001' },
      { sym: 'META', name: 'Meta Platforms Inc.', class: 'equity', ex: 'NASDAQ', cur: 'USD', price: 485.22, dw: 'dw-meta-001' },
      { sym: 'JPM', name: 'JPMorgan Chase & Co.', class: 'equity', ex: 'NYSE', cur: 'USD', price: 198.45, dw: 'dw-jpm-001' },
      { sym: 'SPY', name: 'SPDR S&P 500 ETF', class: 'etf', ex: 'NYSE', cur: 'USD', price: 502.34, dw: 'dw-spy-001' },
      { sym: 'QQQ', name: 'Invesco QQQ Trust', class: 'etf', ex: 'NASDAQ', cur: 'USD', price: 437.89, dw: 'dw-qqq-001' },
      { sym: 'BTC/USD', name: 'Bitcoin', class: 'crypto', ex: 'CRYPTO', cur: 'USD', price: 97842.50, saxo: 21 },
      { sym: 'ETH/USD', name: 'Ethereum', class: 'crypto', ex: 'CRYPTO', cur: 'USD', price: 3456.12, saxo: 22 },
      { sym: 'EUR/USD', name: 'Euro/US Dollar', class: 'forex', ex: 'FX', cur: 'USD', price: 1.0842, saxo: 31 },
      { sym: 'GBP/USD', name: 'British Pound/US Dollar', class: 'forex', ex: 'FX', cur: 'USD', price: 1.2634, saxo: 32 },
      { sym: 'USD/JPY', name: 'US Dollar/Japanese Yen', class: 'forex', ex: 'FX', cur: 'JPY', price: 150.24, saxo: 33 },
      { sym: 'XAU/USD', name: 'Gold Spot', class: 'forex', ex: 'COMMODITY', cur: 'USD', price: 2024.50, saxo: 41 },
      { sym: 'US10Y', name: 'US 10Y Treasury Bond', class: 'bond', ex: 'BOND', cur: 'USD', price: 97.85, saxo: 51 },
    ];

    const instrIds = [];
    for (const i of instruments) {
      const res = await client.query(
        `INSERT INTO instruments (symbol, name, asset_class, exchange, currency, last_price,
         prev_close, day_high, day_low, dw_instrument_id, saxo_uic, is_fractional, is_tradable, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13)
         ON CONFLICT (symbol, exchange) DO UPDATE SET last_price = $6
         RETURNING id`,
        [i.sym, i.name, i.class, i.ex, i.cur, i.price,
         i.price * (1 - Math.random() * 0.02), i.price * 1.015, i.price * 0.985,
         i.dw || null, i.saxo || null,
         ['equity', 'etf'].includes(i.class),
         Math.floor(Math.random() * 50000000) + 1000000]
      );
      instrIds.push(res.rows[0].id);
    }
    console.log(`  ✓ ${instruments.length} instruments created`);

    // ============================================================
    // ACCOUNTS (one per client per broker)
    // ============================================================
    const cashBalances = [62480.50, 245000.00, 32100.75, 98500.00, 8200.00, 1250000.00, 45600.00, 178000.00];

    for (let i = 0; i < clientIds.length; i++) {
      const cash = cashBalances[i];
      // DriveWealth account (US equities)
      await client.query(
        `INSERT INTO accounts (client_id, currency, cash_balance, buying_power, broker, broker_account_id)
         VALUES ($1, 'USD', $2, $3, 'drivewealth', $4)
         ON CONFLICT (client_id, currency, broker) DO UPDATE SET cash_balance = $2`,
        [clientIds[i], cash * 0.6, cash * 1.2, `dw-acct-${1000 + i}`]
      );
      // Saxo account (intl/FX)
      await client.query(
        `INSERT INTO accounts (client_id, currency, cash_balance, buying_power, broker, broker_account_id)
         VALUES ($1, 'USD', $2, $3, 'saxo', $4)
         ON CONFLICT (client_id, currency, broker) DO UPDATE SET cash_balance = $2`,
        [clientIds[i], cash * 0.4, cash * 0.8, `saxo-acct-${2000 + i}`]
      );
    }
    console.log(`  ✓ ${clientIds.length * 2} trading accounts created`);

    // ============================================================
    // POSITIONS for first client (John Doe) — matches demo data
    // ============================================================
    const johnPositions = [
      { instr: 0, side: 'long', qty: 200, avg: 182.50, broker: 'drivewealth' },   // AAPL
      { instr: 2, side: 'long', qty: 50, avg: 845.00, broker: 'drivewealth' },    // NVDA
      { instr: 3, side: 'short', qty: 30, avg: 255.20, broker: 'drivewealth' },   // TSLA
      { instr: 6, side: 'long', qty: 75, avg: 462.10, broker: 'drivewealth' },    // META
      { instr: 10, side: 'long', qty: 0.5, avg: 92000, broker: 'saxo' },          // BTC/USD
      { instr: 12, side: 'long', qty: 10000, avg: 1.0810, broker: 'saxo' },       // EUR/USD
    ];

    for (const p of johnPositions) {
      await client.query(
        `INSERT INTO positions (client_id, instrument_id, side, quantity, avg_cost, broker)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (client_id, instrument_id, side, broker) DO UPDATE SET quantity = $4`,
        [clientIds[0], instrIds[p.instr], p.side, p.qty, p.avg, p.broker]
      );
    }

    // Positions for other clients
    const otherPositions = [
      { client: 1, instr: 0, side: 'long', qty: 500, avg: 178.20, broker: 'drivewealth' },
      { client: 1, instr: 2, side: 'long', qty: 100, avg: 820.00, broker: 'drivewealth' },
      { client: 1, instr: 8, side: 'long', qty: 1000, avg: 495.00, broker: 'drivewealth' },
      { client: 2, instr: 9, side: 'long', qty: 200, avg: 430.00, broker: 'drivewealth' },
      { client: 3, instr: 12, side: 'long', qty: 50000, avg: 1.0790, broker: 'saxo' },
      { client: 3, instr: 13, side: 'short', qty: 25000, avg: 1.2680, broker: 'saxo' },
      { client: 5, instr: 0, side: 'long', qty: 2000, avg: 175.50, broker: 'drivewealth' },
      { client: 5, instr: 2, side: 'long', qty: 500, avg: 810.00, broker: 'drivewealth' },
      { client: 5, instr: 10, side: 'long', qty: 5, avg: 88000, broker: 'saxo' },
      { client: 5, instr: 16, side: 'long', qty: 10000, avg: 96.50, broker: 'saxo' },
      { client: 7, instr: 15, side: 'long', qty: 100, avg: 1980.00, broker: 'saxo' },
      { client: 7, instr: 12, side: 'long', qty: 100000, avg: 1.0825, broker: 'saxo' },
    ];

    for (const p of otherPositions) {
      await client.query(
        `INSERT INTO positions (client_id, instrument_id, partner_id, side, quantity, avg_cost, broker)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (client_id, instrument_id, side, broker) DO UPDATE SET quantity = $5`,
        [clientIds[p.client], instrIds[p.instr], clients[p.client].partner, p.side, p.qty, p.avg, p.broker]
      );
    }
    console.log(`  ✓ ${johnPositions.length + otherPositions.length} positions created`);

    // ============================================================
    // SAMPLE ORDERS
    // ============================================================
    const now = new Date();
    const orders = [
      { client: 0, instr: 0, side: 'buy', type: 'limit', qty: 50, price: 185.00, status: 'working', broker: 'drivewealth' },
      { client: 0, instr: 5, side: 'buy', type: 'stop', qty: 100, price: 138.00, status: 'working', broker: 'drivewealth' },
      { client: 0, instr: 1, side: 'sell', type: 'limit', qty: 25, price: 425.00, status: 'working', broker: 'drivewealth' },
      { client: 0, instr: 2, side: 'buy', type: 'market', qty: 10, price: null, status: 'filled', broker: 'drivewealth', fill: 874.52 },
      { client: 0, instr: 6, side: 'buy', type: 'limit', qty: 75, price: 462.10, status: 'filled', broker: 'drivewealth', fill: 462.10 },
      { client: 1, instr: 8, side: 'buy', type: 'market', qty: 500, price: null, status: 'filled', broker: 'drivewealth', fill: 501.87 },
      { client: 5, instr: 10, side: 'buy', type: 'limit', qty: 2, price: 96500, status: 'working', broker: 'saxo' },
      { client: 3, instr: 12, side: 'buy', type: 'limit', qty: 25000, price: 1.0800, status: 'working', broker: 'saxo' },
    ];

    for (const o of orders) {
      await client.query(
        `INSERT INTO orders (client_id, instrument_id, partner_id, side, order_type, quantity, price,
         status, broker, created_by, time_in_force, avg_fill_price, filled_quantity,
         submitted_at, filled_at, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'day', $11, $12, NOW(), $13, '10.0.1.100')`,
        [
          clientIds[o.client], instrIds[o.instr], clients[o.client].partner,
          o.side, o.type, o.qty, o.price, o.status, o.broker,
          users[o.client + 4].id,
          o.fill || null, o.status === 'filled' ? o.qty : 0,
          o.status === 'filled' ? now : null,
        ]
      );
    }
    console.log(`  ✓ ${orders.length} orders created`);

    // ============================================================
    // CASH TRANSACTIONS
    // ============================================================
    const txns = [
      { client: 0, type: 'deposit', amount: 25000, status: 'completed' },
      { client: 0, type: 'withdrawal', amount: -5000, status: 'completed' },
      { client: 0, type: 'deposit', amount: 100000, status: 'completed' },
      { client: 1, type: 'deposit', amount: 500000, status: 'completed' },
      { client: 5, type: 'deposit', amount: 2000000, status: 'completed' },
      { client: 5, type: 'withdrawal', amount: -50000, status: 'pending_approval' },
    ];

    for (const t of txns) {
      const acctRes = await client.query(
        `SELECT id FROM accounts WHERE client_id = $1 LIMIT 1`,
        [clientIds[t.client]]
      );
      if (acctRes.rows[0]) {
        await client.query(
          `INSERT INTO cash_transactions (account_id, client_id, type, amount, currency, status,
           requires_approval, created_by)
           VALUES ($1, $2, $3, $4, 'USD', $5, $6, $7)`,
          [acctRes.rows[0].id, clientIds[t.client], t.type, t.amount, t.status,
           t.status === 'pending_approval', users[t.client + 4].id]
        );
      }
    }
    console.log(`  ✓ ${txns.length} cash transactions created`);

    // ============================================================
    // AUDIT LOG ENTRIES
    // ============================================================
    const auditEntries = [
      { user: 0, action: 'Client account approved', resource: 'client', rid: clientIds[7], level: 'success' },
      { user: null, action: 'Order placed — AAPL Buy Limit 50 @ $185.00', resource: 'order', rid: 'ORD-5000', level: 'info' },
      { user: 0, action: 'Withdrawal flagged for review — $50,000', resource: 'transfer', rid: 'TXN-001006', level: 'warning' },
      { user: null, action: 'Reconciliation completed — DriveWealth: All matched', resource: 'reconciliation', rid: 'REC-001', level: 'success' },
      { user: null, action: 'Reconciliation completed — Saxo Bank: All matched', resource: 'reconciliation', rid: 'REC-002', level: 'success' },
      { user: 0, action: 'Client KYC document uploaded', resource: 'client', rid: clientIds[3], level: 'info' },
      { user: null, action: 'Failed login attempt (3/5) from 185.234.12.99', resource: 'auth', rid: 'USR-unknown', level: 'critical' },
      { user: 0, action: 'MFA enabled for admin account', resource: 'auth', rid: users[0].id, level: 'success' },
      { user: 3, action: 'Partner API key rotated', resource: 'partner', rid: partners[0].id, level: 'warning' },
      { user: null, action: 'Daily position snapshot completed — 18 positions captured', resource: 'system', rid: 'SNAP-001', level: 'success' },
    ];

    for (const a of auditEntries) {
      await client.query(
        `INSERT INTO audit_log (user_id, user_email, action, resource_type, resource_id, level, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          a.user !== null ? users[a.user].id : null,
          a.user !== null ? users[a.user].email : 'system',
          a.action, a.resource, a.rid, a.level,
          a.user !== null ? '10.0.1.45' : null,
        ]
      );
    }
    console.log(`  ✓ ${auditEntries.length} audit log entries created`);

    // ============================================================
    // NOTIFICATIONS
    // ============================================================
    const notifs = [
      { user: 4, title: 'Order Filled', msg: 'Your buy order for 10 NVDA shares filled at $874.52', type: 'success' },
      { user: 4, title: 'Limit Order Active', msg: 'Your limit order for 50 AAPL @ $185.00 is working', type: 'info' },
      { user: 4, title: 'Deposit Confirmed', msg: '$25,000 deposit has been credited to your account', type: 'success' },
      { user: 0, title: 'KYC Review Pending', msg: 'Client Maria Garcia has documents pending review', type: 'warning' },
      { user: 0, title: 'Withdrawal Flag', msg: '$50,000 withdrawal requires dual authorization', type: 'warning' },
    ];

    for (const n of notifs) {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, $4)`,
        [users[n.user].id, n.title, n.msg, n.type]
      );
    }
    console.log(`  ✓ ${notifs.length} notifications created`);

    await client.query('COMMIT');

    console.log('\n✅ Database seeded successfully!');
    console.log('\n📋 Test Credentials (all passwords: T1Broker@2025!)');
    console.log('   Admin:   sarah@t1broker.com');
    console.log('   Client:  john@email.com');
    console.log('   Partner: ahmed@dubaibrokerage.ae\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  seed();
}

module.exports = seed;
