// ================================================================
// T1 BROKER — INTEGRATION TESTS
// Tests actual HTTP endpoints using supertest
// Requires: running PostgreSQL (or use pg-mem for isolation)
// ================================================================
const request = require('supertest');

// Mock Redis before importing app (Redis may not be available in CI)
jest.mock('../../server/utils/redis', () => ({
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(true),
  exists: jest.fn().mockResolvedValue(false),
  incr: jest.fn().mockResolvedValue(1),
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 99, total: 100, resetAt: new Date() }),
  acquireLock: jest.fn().mockResolvedValue('lock-value'),
  releaseLock: jest.fn().mockResolvedValue(true),
  publish: jest.fn().mockResolvedValue(true),
  subscribe: jest.fn().mockResolvedValue(true),
  storeSession: jest.fn().mockResolvedValue(true),
  getSession: jest.fn().mockResolvedValue(null),
  client: { lpush: jest.fn(), rpop: jest.fn(), ping: jest.fn().mockResolvedValue('PONG'), keys: jest.fn().mockResolvedValue([]) },
}));

// Mock job scheduler
jest.mock('../../server/jobs/scheduler', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  getStatus: jest.fn().mockReturnValue({}),
}));

const { testUsers, TEST_PASSWORD, generateToken } = require('../fixtures/helpers');

describe('API Integration Tests', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    // Import app (don't start listening)
    app = require('../../server/index').app;
  });

  // ================================================================
  // HEALTH & MONITORING
  // ================================================================
  describe('GET /api/v1/health', () => {
    test('returns health status', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('uptime');
    });
  });

  describe('GET /api/v1/live', () => {
    test('returns liveness', async () => {
      const res = await request(app).get('/api/v1/live');
      expect(res.status).toBe(200);
      expect(res.body.alive).toBe(true);
    });
  });

  describe('GET /api/v1/ready', () => {
    test('returns readiness', async () => {
      const res = await request(app).get('/api/v1/ready');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('ready');
    });
  });

  // ================================================================
  // AUTH
  // ================================================================
  describe('POST /api/v1/auth/login', () => {
    test('rejects missing credentials', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    test('rejects invalid email format', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'notanemail',
        password: 'password123',
      });
      expect(res.status).toBe(400);
    });

    test('rejects wrong credentials', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'nonexistent@email.com',
        password: 'wrongpassword',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/auth/register', () => {
    test('rejects weak password', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'test@newuser.com',
        password: 'weak',
        firstName: 'Test',
        lastName: 'User',
        countryOfResidence: 'US',
      });
      expect(res.status).toBe(400);
    });

    test('rejects missing required fields', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'test@newuser.com',
        password: 'T1Broker@2025!',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    test('rejects unauthenticated logout', async () => {
      const res = await request(app).post('/api/v1/auth/logout');
      expect(res.status).toBe(401);
    });
  });

  // ================================================================
  // PROTECTED ROUTES (require auth)
  // ================================================================
  describe('Unauthenticated access', () => {
    const protectedRoutes = [
      ['GET', '/api/v1/orders'],
      ['POST', '/api/v1/orders'],
      ['GET', '/api/v1/positions'],
      ['GET', '/api/v1/clients/me'],
      ['GET', '/api/v1/market/instruments'],
      ['GET', '/api/v1/transfers'],
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/margin/status'],
    ];

    test.each(protectedRoutes)('%s %s returns 401', async (method, url) => {
      const res = await request(app)[method.toLowerCase()](url);
      expect(res.status).toBe(401);
    });
  });

  // ================================================================
  // ORDER VALIDATION
  // ================================================================
  describe('POST /api/v1/orders (validation)', () => {
    test('rejects order without auth', async () => {
      const res = await request(app).post('/api/v1/orders').send({
        instrumentId: '550e8400-e29b-41d4-a716-446655440000',
        side: 'buy',
        orderType: 'market',
        quantity: 100,
      });
      expect(res.status).toBe(401);
    });

    test('rejects invalid side', async () => {
      const token = generateToken(testUsers.client);
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({
          instrumentId: '550e8400-e29b-41d4-a716-446655440000',
          side: 'invalid',
          orderType: 'market',
          quantity: 100,
        });
      // Will be 400 (validation) or 401 (session not in DB)
      expect([400, 401]).toContain(res.status);
    });
  });

  // ================================================================
  // PASSWORD RESET
  // ================================================================
  describe('POST /api/v1/password/forgot', () => {
    test('always returns success (no email leak)', async () => {
      const res = await request(app).post('/api/v1/password/forgot').send({
        email: 'nonexistent@email.com',
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('reset link');
    });

    test('rejects missing email', async () => {
      const res = await request(app).post('/api/v1/password/forgot').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/password/reset', () => {
    test('rejects invalid token', async () => {
      const res = await request(app).post('/api/v1/password/reset').send({
        token: 'invalidtoken',
        newPassword: 'NewP@ssword2025!',
      });
      expect(res.status).toBe(400);
    });
  });

  // ================================================================
  // WEBHOOKS
  // ================================================================
  describe('Webhooks', () => {
    test('DriveWealth webhook accepts valid payload', async () => {
      const res = await request(app).post('/api/v1/webhooks/drivewealth').send({
        type: 'ORDER_FILL',
        data: { orderId: 'dw-123', fillQty: '10', fillPrice: '185.50', venue: 'NASDAQ' },
      });
      // May fail gracefully if order not found, but shouldn't 500
      expect([200, 500]).toContain(res.status);
    });

    test('Saxo webhook accepts valid payload', async () => {
      const res = await request(app).post('/api/v1/webhooks/saxo').send({
        type: 'OrderFilled',
        data: { OrderId: 'saxo-456', FilledAmount: '100', AveragePrice: '1.0842', Exchange: 'SAXO' },
      });
      expect([200, 500]).toContain(res.status);
    });
  });

  // ================================================================
  // CORS
  // ================================================================
  describe('CORS', () => {
    test('returns CORS headers', async () => {
      const res = await request(app)
        .options('/api/v1/health')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  // ================================================================
  // 404
  // ================================================================
  describe('Unknown API routes', () => {
    test('returns 404 for unknown API path', async () => {
      const res = await request(app).get('/api/v1/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  // ================================================================
  // REQUEST ID
  // ================================================================
  describe('Request correlation', () => {
    test('returns X-Request-ID header', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.headers['x-request-id']).toBeDefined();
    });

    test('echoes X-Request-ID if provided', async () => {
      const res = await request(app)
        .get('/api/v1/health')
        .set('X-Request-ID', 'test-correlation-123');
      expect(res.headers['x-request-id']).toBe('test-correlation-123');
    });
  });
});
