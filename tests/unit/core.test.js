// ================================================================
// T1 BROKER — UNIT TESTS
// ================================================================

// ---- Encryption ----
describe('Encryption Utils', () => {
  const { encrypt, decrypt, hashSHA512, hashToken, generateSecureToken } = require('../../server/utils/encryption');

  test('encrypt and decrypt round-trip', () => {
    const plaintext = 'SSN: 123-45-6789';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('encrypt returns null for null input', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt(undefined)).toBeNull();
  });

  test('decrypt returns null for invalid input', () => {
    expect(decrypt(null)).toBeNull();
    expect(decrypt('invalid')).toBeNull();
  });

  test('same plaintext encrypts differently each time (random IV)', () => {
    const a = encrypt('test');
    const b = encrypt('test');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  test('hashSHA512 produces consistent hashes', () => {
    const hash1 = hashSHA512('test');
    const hash2 = hashSHA512('test');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(128);
  });

  test('hashToken produces consistent sha256', () => {
    const hash = hashToken('my-token');
    expect(hash).toHaveLength(64);
    expect(hashToken('my-token')).toBe(hash);
  });

  test('generateSecureToken returns hex string', () => {
    const token = generateSecureToken(32);
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });
});

// ---- Validation Schemas ----
describe('Validation Schemas', () => {
  const { schemas } = require('../../server/middleware/validation');

  describe('login schema', () => {
    test('accepts valid login', () => {
      const { error } = schemas.login.validate({ email: 'test@email.com', password: 'password123' });
      expect(error).toBeUndefined();
    });

    test('rejects missing email', () => {
      const { error } = schemas.login.validate({ password: 'password123' });
      expect(error).toBeDefined();
    });

    test('rejects invalid email', () => {
      const { error } = schemas.login.validate({ email: 'not-an-email', password: 'password123' });
      expect(error).toBeDefined();
    });

    test('rejects short password', () => {
      const { error } = schemas.login.validate({ email: 'test@email.com', password: '123' });
      expect(error).toBeDefined();
    });
  });

  describe('register schema', () => {
    const validReg = {
      email: 'new@user.com',
      password: 'T1Broker@2025!',
      firstName: 'John',
      lastName: 'Doe',
      countryOfResidence: 'US',
    };

    test('accepts valid registration', () => {
      const { error } = schemas.register.validate(validReg);
      expect(error).toBeUndefined();
    });

    test('rejects weak password', () => {
      const { error } = schemas.register.validate({ ...validReg, password: 'weakpassword' });
      expect(error).toBeDefined();
    });

    test('rejects missing country', () => {
      const { error } = schemas.register.validate({ ...validReg, countryOfResidence: undefined });
      expect(error).toBeDefined();
    });
  });

  describe('createOrder schema', () => {
    test('accepts valid market order', () => {
      const { error } = schemas.createOrder.validate({
        instrumentId: '550e8400-e29b-41d4-a716-446655440000',
        side: 'buy',
        orderType: 'market',
        quantity: 100,
      });
      expect(error).toBeUndefined();
    });

    test('requires price for limit order', () => {
      const { error } = schemas.createOrder.validate({
        instrumentId: '550e8400-e29b-41d4-a716-446655440000',
        side: 'buy',
        orderType: 'limit',
        quantity: 100,
      });
      expect(error).toBeDefined();
    });

    test('accepts limit order with price', () => {
      const { error } = schemas.createOrder.validate({
        instrumentId: '550e8400-e29b-41d4-a716-446655440000',
        side: 'sell',
        orderType: 'limit',
        quantity: 50,
        price: 185.00,
      });
      expect(error).toBeUndefined();
    });

    test('rejects zero quantity', () => {
      const { error } = schemas.createOrder.validate({
        instrumentId: '550e8400-e29b-41d4-a716-446655440000',
        side: 'buy',
        orderType: 'market',
        quantity: 0,
      });
      expect(error).toBeDefined();
    });
  });

  describe('createTransfer schema', () => {
    test('accepts valid deposit', () => {
      const { error } = schemas.createTransfer.validate({
        type: 'deposit',
        amount: 5000,
        bankAccountId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(error).toBeUndefined();
    });

    test('rejects negative amount', () => {
      const { error } = schemas.createTransfer.validate({
        type: 'withdrawal',
        amount: -100,
        bankAccountId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(error).toBeDefined();
    });
  });
});

// ---- Circuit Breaker ----
describe('Circuit Breaker', () => {
  const { CircuitBreaker } = require('../../server/utils/resilience');

  test('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3, timeout: 100 });
    expect(cb.getStatus().state).toBe('CLOSED');
  });

  test('opens after threshold failures', async () => {
    const cb = new CircuitBreaker('test-open', { failureThreshold: 2, timeout: 100 });
    const fail = () => { throw new Error('fail'); };

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    await expect(cb.execute(fail)).rejects.toThrow('fail');

    expect(cb.getStatus().state).toBe('OPEN');
  });

  test('calls fallback when OPEN', async () => {
    const cb = new CircuitBreaker('test-fallback', { failureThreshold: 1, timeout: 100 });
    const fail = () => { throw new Error('fail'); };
    const fallback = () => 'fallback-value';

    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getStatus().state).toBe('OPEN');

    const result = await cb.execute(fail, fallback);
    expect(result).toBe('fallback-value');
  });

  test('transitions to HALF_OPEN after timeout', async () => {
    const cb = new CircuitBreaker('test-halfopen', { failureThreshold: 1, timeout: 50 });
    const fail = () => { throw new Error('fail'); };

    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getStatus().state).toBe('OPEN');

    await new Promise(r => setTimeout(r, 100));

    const success = async () => 'ok';
    const result = await cb.execute(success);
    expect(result).toBe('ok');
  });

  test('reset() restores CLOSED state', () => {
    const cb = new CircuitBreaker('test-reset', { failureThreshold: 1 });
    cb.state = 'OPEN';
    cb.failureCount = 10;
    cb.reset();
    expect(cb.getStatus().state).toBe('CLOSED');
    expect(cb.getStatus().failureCount).toBe(0);
  });
});

// ---- Retry ----
describe('Retry', () => {
  const { retry } = require('../../server/utils/resilience');

  test('succeeds on first try', async () => {
    let calls = 0;
    const result = await retry(async () => { calls++; return 'ok'; }, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries on failure then succeeds', async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    }, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('throws after max retries', async () => {
    const fn = async () => { throw new Error('always fail'); };
    await expect(retry(fn, { maxRetries: 2, baseDelay: 10 })).rejects.toThrow('always fail');
  });

  test('does not retry 4xx errors', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      const err = new Error('bad request');
      err.response = { status: 400 };
      throw err;
    };
    await expect(retry(fn, { maxRetries: 3, baseDelay: 10 })).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });
});

// ---- Error Classes ----
describe('Error Classes', () => {
  const {
    AppError, ValidationError, AuthenticationError, ForbiddenError,
    NotFoundError, ConflictError, RateLimitError, BrokerError,
  } = require('../../server/middleware/errors');

  test('AppError has correct properties', () => {
    const err = new AppError('test', 422, 'CUSTOM_CODE');
    expect(err.message).toBe('test');
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.isOperational).toBe(true);
  });

  test('ValidationError is 400', () => {
    const err = new ValidationError([{ field: 'email', message: 'required' }]);
    expect(err.statusCode).toBe(400);
    expect(err.details).toHaveLength(1);
  });

  test('AuthenticationError is 401', () => {
    expect(new AuthenticationError().statusCode).toBe(401);
  });

  test('ForbiddenError is 403', () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });

  test('NotFoundError is 404', () => {
    const err = new NotFoundError('Client');
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('Client');
  });

  test('BrokerError is 502', () => {
    const err = new BrokerError('DriveWealth', 'connection refused');
    expect(err.statusCode).toBe(502);
    expect(err.broker).toBe('DriveWealth');
  });
});
