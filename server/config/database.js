// ================================================================
// T1 BROKER — DATABASE CONNECTION
// ================================================================
const knex = require('knex');
const config = require('../config');

const db = knex({
  client: 'pg',
  connection: {
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    // Enforce SSL in production with certificate verification
    ssl: config.env === 'production'
      ? { rejectUnauthorized: true, minVersion: 'TLSv1.2' }
      : (config.db.ssl ? { rejectUnauthorized: false } : false),
    // Connection-level timeouts
    connectionTimeoutMillis: 10000,  // 10s to establish connection
    statement_timeout: 30000,         // 30s max query execution
    idle_in_transaction_session_timeout: 60000, // 60s max idle in transaction
  },
  pool: {
    min: config.db.poolMin,
    max: config.db.poolMax,
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    // Set session parameters on each new connection
    afterCreate: (conn, done) => {
      const statements = [
        // Prevent unauthorized schema changes from application
        "SET search_path TO public",
        // Statement timeout as safety net (30 seconds)
        "SET statement_timeout = '30s'",
        // Lock timeout to prevent long lock waits
        "SET lock_timeout = '10s'",
        // Prevent application from changing transaction isolation
        "SET default_transaction_isolation TO 'read committed'",
      ];
      conn.query(statements.join('; '), (err) => {
        if (err) {
          console.error('Failed to set DB session params:', err.message);
        }
        done(err, conn);
      });
    },
  },
});

const { installQueryInterceptor, startPoolMonitor } = require('../middleware/databaseSecurity');

// Install security interceptor (query monitoring, dangerous op blocking)
installQueryInterceptor(db);

// Test connection
db.raw('SELECT 1')
  .then(() => {
    console.log('✅ Database connected');
    // Start pool health monitor (every 30 seconds)
    startPoolMonitor(db, 30000);
  })
  .catch((err) => console.error('❌ Database connection failed:', err.message));

module.exports = db;
