// ================================================================
// T1 BROKER — DATABASE MIGRATION RUNNER
// Run: node database/migrate.js
// ================================================================
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function migrate() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 't1broker',
    user: process.env.DB_USER || 't1admin',
    password: process.env.DB_PASSWORD || 'password',
  });

  try {
    console.log('🔄 Running database migration...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

    // Split on semicolons but keep them, execute each statement
    // (handle the triggers/functions that contain semicolons inside $$ blocks)
    await pool.query(schema);

    console.log('✅ Migration completed successfully');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('⚠️  Some objects already exist — this is fine for re-runs');
    } else {
      console.error('❌ Migration failed:', err.message);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
