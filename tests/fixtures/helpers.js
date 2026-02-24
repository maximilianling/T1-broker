// ================================================================
// T1 BROKER — TEST CONFIGURATION & HELPERS
// ================================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const TEST_PASSWORD = 'T1TestPass@2025!';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

// Mock user data
const testUsers = {
  admin: {
    id: uuid(),
    email: 'test-admin@t1broker.com',
    password_hash: TEST_PASSWORD_HASH,
    role: 'super_admin',
    is_active: true,
    mfa_enabled: false,
  },
  client: {
    id: uuid(),
    email: 'test-client@email.com',
    password_hash: TEST_PASSWORD_HASH,
    role: 'client',
    is_active: true,
    mfa_enabled: false,
  },
  partner: {
    id: uuid(),
    email: 'test-partner@partner.com',
    password_hash: TEST_PASSWORD_HASH,
    role: 'partner_admin',
    is_active: true,
    mfa_enabled: false,
  },
};

function generateToken(user, secret = 'dev-secret-replace-in-production-immediately') {
  return jwt.sign(
    { userId: user.id, role: user.role, mfaVerified: false },
    secret,
    { expiresIn: '15m' }
  );
}

// Mock database helper
function createMockDb() {
  const tables = {};
  return {
    __tables: tables,
    __addTable(name, rows = []) {
      tables[name] = [...rows];
    },
    raw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(0),
    count: jest.fn().mockReturnThis(),
    sum: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    join: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    pluck: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(async () => {
      const trx = createMockDb();
      trx.commit = jest.fn();
      trx.rollback = jest.fn();
      return trx;
    }),
    destroy: jest.fn(),
  };
}

module.exports = {
  TEST_PASSWORD,
  TEST_PASSWORD_HASH,
  testUsers,
  generateToken,
  createMockDb,
};
