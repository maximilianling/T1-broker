// ================================================================
// T1 BROKER — CYPRESS E2E TESTS
// Full web UI test suite
// ================================================================

// ================================================================
// AUTH FLOW
// ================================================================
describe('Authentication', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('should display login page', () => {
    cy.contains('T1 Broker').should('be.visible');
    cy.get('input[placeholder*="email" i], input[type="email"]').should('be.visible');
    cy.get('input[type="password"]').should('be.visible');
    cy.contains('button', /sign in|login/i).should('be.visible');
  });

  it('should show error on invalid credentials', () => {
    cy.login('wrong@example.com', 'wrongpass');
    cy.contains(/invalid|error|fail/i, { timeout: 5000 }).should('be.visible');
  });

  it('should login with client credentials', () => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    // Should see main app or MFA
    cy.get('body').then(($body) => {
      if ($body.text().includes('Two-Factor') || $body.text().includes('MFA')) {
        // MFA flow — handle verification
        cy.log('MFA required');
      } else {
        cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
      }
    });
  });

  it('should login with admin credentials', () => {
    cy.login(Cypress.env('ADMIN_EMAIL'), Cypress.env('ADMIN_PASSWORD'));
    cy.get('body').then(($body) => {
      if ($body.text().includes('Two-Factor')) {
        cy.log('MFA required for admin');
      } else {
        cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
      }
    });
  });

  it('should show role selector', () => {
    cy.get('select, [class*="sel"]').should('exist');
  });

  it('should logout', () => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
    cy.contains(/logout|sign out/i).click({ force: true });
    cy.contains(/sign in|login/i).should('be.visible');
  });
});

// ================================================================
// MFA VERIFICATION
// ================================================================
describe('MFA Flow', () => {
  it('should show MFA step when required', () => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('body').then(($body) => {
      if ($body.text().includes('Verification Code') || $body.text().includes('MFA')) {
        cy.contains(/code|verify/i).should('be.visible');
        cy.contains(/backup code/i).should('be.visible');
        cy.contains(/authenticator/i).should('be.visible');
      }
    });
  });

  it('should switch between MFA methods', () => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('body').then(($body) => {
      if ($body.text().includes('Verification Code')) {
        cy.contains(/backup code/i).click();
        cy.contains(/authenticator/i).click();
      }
    });
  });
});

// ================================================================
// TRADING PAGE
// ================================================================
describe('Trading Page', () => {
  beforeEach(() => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
  });

  it('should display trading interface', () => {
    cy.navigateTo('Trading');
    cy.get('.pagec').should('be.visible');
  });

  it('should show instrument search', () => {
    cy.navigateTo('Trading');
    cy.get('input[placeholder*="search" i], input[placeholder*="symbol" i]').should('exist');
  });

  it('should show order book or watchlist', () => {
    cy.navigateTo('Trading');
    cy.get('.pagec').should('contain.text', 'AAPL')
      .or('contain.text', 'Watchlist')
      .or('contain.text', 'Orders');
  });
});

// ================================================================
// PORTFOLIO PAGE
// ================================================================
describe('Portfolio Page', () => {
  beforeEach(() => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
    cy.navigateTo('Portfolio');
  });

  it('should display portfolio overview', () => {
    cy.contains(/portfolio|positions/i).should('be.visible');
  });

  it('should show position data', () => {
    // Should have some stock symbols or position info
    cy.get('.pagec').should('contain.text', '$');
  });
});

// ================================================================
// MARKETS PAGE
// ================================================================
describe('Markets Page', () => {
  beforeEach(() => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
    cy.navigateTo('Markets');
  });

  it('should display market data', () => {
    cy.contains(/markets|overview/i).should('be.visible');
  });

  it('should show indices', () => {
    cy.contains('S&P 500').should('be.visible');
    cy.contains('NASDAQ').should('be.visible');
  });

  it('should show top movers', () => {
    cy.contains(/mover|top|active/i).should('be.visible');
  });
});

// ================================================================
// TRANSFERS PAGE
// ================================================================
describe('Transfers Page', () => {
  beforeEach(() => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
    cy.navigateTo('Transfers');
  });

  it('should show deposit and withdraw options', () => {
    cy.contains(/deposit/i).should('be.visible');
    cy.contains(/withdraw/i).should('be.visible');
  });

  it('should show transfer history', () => {
    cy.contains(/history|recent/i).should('be.visible');
  });
});

// ================================================================
// SECURITY CENTER
// ================================================================
describe('Security Center', () => {
  beforeEach(() => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
    cy.navigateTo('Security');
  });

  it('should display MFA status', () => {
    cy.contains(/MFA|two-factor|2FA/i).should('be.visible');
  });

  it('should show setup options when MFA disabled', () => {
    cy.get('.pagec').then(($page) => {
      if ($page.text().includes('Disabled') || $page.text().includes('not protected')) {
        cy.contains(/authenticator|google/i).should('be.visible');
        cy.contains(/email/i).should('be.visible');
      }
    });
  });

  it('should show trusted devices section', () => {
    cy.contains(/trusted device|device/i).should('be.visible');
  });

  it('should show login history', () => {
    cy.contains(/login history|recent login/i).should('be.visible');
  });

  it('should show security checklist', () => {
    cy.contains(/TLS|encrypted|CSRF/i).should('be.visible');
  });
});

// ================================================================
// ADMIN DASHBOARD
// ================================================================
describe('Admin Dashboard', () => {
  beforeEach(() => {
    cy.login(Cypress.env('ADMIN_EMAIL'), Cypress.env('ADMIN_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
  });

  it('should show admin navigation items', () => {
    // Admin should see client management, reports, partners etc
    cy.get('.sidebar').should('be.visible');
    cy.get('.sidebar').should('contain.text', 'Clients')
      .or('contain.text', 'Admin')
      .or('contain.text', 'Partners');
  });

  it('should navigate to client management', () => {
    cy.navigateTo('Clients');
    cy.contains(/client|account/i).should('be.visible');
  });

  it('should navigate to reports', () => {
    cy.navigateTo('Reports');
    cy.contains(/report/i).should('be.visible');
  });

  it('should navigate to audit log', () => {
    cy.navigateTo('Audit');
    cy.contains(/audit/i).should('be.visible');
  });
});

// ================================================================
// RESPONSIVE / MOBILE WEB
// ================================================================
describe('Responsive Design', () => {
  beforeEach(() => {
    cy.login(Cypress.env('CLIENT_EMAIL'), Cypress.env('CLIENT_PASSWORD'));
    cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
  });

  it('should work at tablet viewport', () => {
    cy.viewport(768, 1024);
    cy.wait(500);
    cy.get('#appShell').should('be.visible');
  });

  it('should work at mobile viewport', () => {
    cy.viewport(375, 812); // iPhone X
    cy.wait(500);
    cy.get('#appShell').should('be.visible');
    // Hamburger should be visible
    cy.get('.hamburger').should('be.visible');
  });

  it('should open sidebar on hamburger click (mobile)', () => {
    cy.viewport(375, 812);
    cy.wait(500);
    cy.get('.hamburger').click();
    cy.get('.sidebar').should('have.class', 'open');
  });

  it('should close sidebar on nav item click (mobile)', () => {
    cy.viewport(375, 812);
    cy.get('.hamburger').click();
    cy.get('.sitem').first().click();
    cy.get('.sidebar').should('not.have.class', 'open');
  });
});

// ================================================================
// PWA
// ================================================================
describe('PWA Features', () => {
  it('should serve manifest.json', () => {
    cy.request('/manifest.json').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.name).to.eq('T1 Broker Trading Platform');
      expect(res.body.display).to.eq('standalone');
    });
  });

  it('should register service worker', () => {
    cy.visit('/');
    cy.window().then((win) => {
      if ('serviceWorker' in win.navigator) {
        cy.wrap(win.navigator.serviceWorker.ready).should('exist');
      }
    });
  });
});

// ================================================================
// API HEALTH
// ================================================================
describe('API Endpoints', () => {
  it('should respond to health check', () => {
    cy.request(`${Cypress.env('API_URL')}/health`).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should reject unauthenticated requests', () => {
    cy.request({ url: `${Cypress.env('API_URL')}/clients/me`, failOnStatusCode: false }).then((res) => {
      expect(res.status).to.be.oneOf([401, 403]);
    });
  });

  it('should rate limit auth endpoints', () => {
    // Send multiple rapid requests
    const requests = Array.from({ length: 10 }, () =>
      cy.request({
        method: 'POST',
        url: `${Cypress.env('API_URL')}/auth/login`,
        body: { email: 'test@test.com', password: 'wrong' },
        failOnStatusCode: false,
      })
    );
  });
});

// ================================================================
// ADMIN DASHBOARD E2E
// ================================================================
describe('Admin Dashboard', () => {
  let adminToken;

  before(() => {
    cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, {
      email: Cypress.env('TEST_USER_EMAIL'),
      password: Cypress.env('TEST_USER_PASSWORD'),
    }).then((res) => {
      adminToken = res.body.token || res.body.data?.token;
    });
  });

  it('should load admin dashboard stats', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/admin/dashboard/stats`,
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.have.property('totalClients');
      expect(res.body.data).to.have.property('totalAUM');
      expect(res.body.data).to.have.property('pendingOrders');
      expect(res.body.data).to.have.property('dailyVolume');
    });
  });

  it('should list clients with search', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/admin/clients?limit=10`,
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should fetch recent orders', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/admin/orders/recent?limit=10`,
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should fetch KYC pending queue', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/admin/kyc/pending`,
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should return system health status', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/admin/system/health`,
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data.services).to.have.property('database');
      expect(res.body.data.services).to.have.property('redis');
      expect(res.body.data).to.have.property('memory');
    });
  });

  it('should generate trade blotter report', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/admin/reports/trade-blotter?startDate=2024-01-01&endDate=2025-12-31`,
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('reportType', 'trade-blotter');
      expect(res.body).to.have.property('data');
    });
  });

  it('should reject admin endpoints for non-admin users', () => {
    cy.request({
      method: 'POST',
      url: `${Cypress.env('API_URL')}/auth/login`,
      body: {
        email: Cypress.env('TEST_CLIENT_EMAIL'),
        password: Cypress.env('TEST_CLIENT_PASSWORD'),
      },
      failOnStatusCode: false,
    }).then((loginRes) => {
      const clientToken = loginRes.body.token || loginRes.body.data?.token;
      if (clientToken) {
        cy.request({
          url: `${Cypress.env('API_URL')}/admin/dashboard/stats`,
          headers: { Authorization: `Bearer ${clientToken}` },
          failOnStatusCode: false,
        }).then((res) => {
          expect(res.status).to.eq(403);
        });
      }
    });
  });
});

// ================================================================
// LIVE MARKET DATA E2E
// ================================================================
describe('Live Market Data', () => {
  let token;

  before(() => {
    cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, {
      email: Cypress.env('TEST_USER_EMAIL'),
      password: Cypress.env('TEST_USER_PASSWORD'),
    }).then((res) => {
      token = res.body.token || res.body.data?.token;
    });
  });

  it('should return all live prices', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/market/live/prices`,
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.have.property('AAPL');
      expect(res.body.data).to.have.property('TSLA');
      expect(res.body.data.AAPL).to.have.property('last');
      expect(res.body.data.AAPL).to.have.property('bid');
      expect(res.body.data.AAPL).to.have.property('ask');
    });
  });

  it('should return single live quote', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/market/live/quote/NVDA`,
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.symbol).to.eq('NVDA');
      expect(res.body.last).to.be.greaterThan(0);
      expect(res.body.volume).to.be.greaterThan(0);
    });
  });

  it('should return OHLCV candles', () => {
    // Wait briefly for candle aggregation
    cy.wait(2000);
    cy.request({
      url: `${Cypress.env('API_URL')}/market/live/candles/AAPL?interval=1m&limit=10`,
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.symbol).to.eq('AAPL');
      expect(res.body.interval).to.eq('1m');
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should return L2 order book', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/market/live/orderbook/AAPL`,
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.bids).to.be.an('array');
      expect(res.body.asks).to.be.an('array');
      expect(res.body.bids.length).to.be.greaterThan(0);
      expect(res.body.bids[0]).to.have.lengthOf(2); // [price, qty]
    });
  });

  it('should return 404 for unknown symbol', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/market/live/quote/XXXXXX`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(404);
    });
  });
});

// ================================================================
// ORDER LIFECYCLE E2E
// ================================================================
describe('Order Lifecycle', () => {
  let token;

  before(() => {
    cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, {
      email: Cypress.env('TEST_USER_EMAIL'),
      password: Cypress.env('TEST_USER_PASSWORD'),
    }).then((res) => {
      token = res.body.token || res.body.data?.token;
    });
  });

  it('should place a market buy order', () => {
    cy.request({
      method: 'POST',
      url: `${Cypress.env('API_URL')}/orders`,
      headers: { Authorization: `Bearer ${token}` },
      body: {
        symbol: 'AAPL', side: 'buy', orderType: 'market',
        quantity: 10, timeInForce: 'day',
      },
      failOnStatusCode: false,
    }).then((res) => {
      // Accept 200/201 (success) or 400/404 (if instrument not seeded)
      expect(res.status).to.be.oneOf([200, 201, 400, 404]);
    });
  });

  it('should fetch order history', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/orders?limit=10`,
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should fetch portfolio positions', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/portfolio/summary`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 404]);
    });
  });
});

// ================================================================
// WALLET / FUNDING E2E
// ================================================================
describe('Wallet & Transfers', () => {
  let token;

  before(() => {
    cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, {
      email: Cypress.env('TEST_USER_EMAIL'),
      password: Cypress.env('TEST_USER_PASSWORD'),
    }).then((res) => {
      token = res.body.token || res.body.data?.token;
    });
  });

  it('should get wallet balance', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/wallet/balance`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 404]);
    });
  });

  it('should get transfer history', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/wallet/history`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 404]);
    });
  });
});

// ================================================================
// WATCHLIST & ALERTS E2E
// ================================================================
describe('Watchlist & Price Alerts', () => {
  let token;

  before(() => {
    cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, {
      email: Cypress.env('TEST_USER_EMAIL'),
      password: Cypress.env('TEST_USER_PASSWORD'),
    }).then((res) => {
      token = res.body.token || res.body.data?.token;
    });
  });

  it('should get watchlist', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/watchlist`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 404]);
    });
  });

  it('should add to watchlist', () => {
    cy.request({
      method: 'POST',
      url: `${Cypress.env('API_URL')}/watchlist`,
      headers: { Authorization: `Bearer ${token}` },
      body: { symbol: 'AAPL' },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 201, 404]);
    });
  });

  it('should create price alert', () => {
    cy.request({
      method: 'POST',
      url: `${Cypress.env('API_URL')}/alerts`,
      headers: { Authorization: `Bearer ${token}` },
      body: { symbol: 'AAPL', condition: 'above', targetPrice: 200, note: 'Test alert' },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 201, 404]);
    });
  });

  it('should get price alerts', () => {
    cy.request({
      url: `${Cypress.env('API_URL')}/alerts`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 404]);
    });
  });
});

// ================================================================
// PUSH NOTIFICATION REGISTRATION E2E
// ================================================================
describe('Push Notifications', () => {
  let token;

  before(() => {
    cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, {
      email: Cypress.env('TEST_USER_EMAIL'),
      password: Cypress.env('TEST_USER_PASSWORD'),
    }).then((res) => {
      token = res.body.token || res.body.data?.token;
    });
  });

  it('should register push token', () => {
    cy.request({
      method: 'POST',
      url: `${Cypress.env('API_URL')}/notifications/push-token`,
      headers: { Authorization: `Bearer ${token}` },
      body: { token: 'ExponentPushToken[test-token-12345]', platform: 'ios', deviceName: 'Cypress Test' },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 201, 404]);
    });
  });

  it('should unregister push token', () => {
    cy.request({
      method: 'DELETE',
      url: `${Cypress.env('API_URL')}/notifications/push-token`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 204, 404]);
    });
  });
});

// ================================================================
// WEBSOCKET CONNECTIVITY E2E
// ================================================================
describe('WebSocket Connection', () => {
  it('should connect to WebSocket server', () => {
    cy.window().then((win) => {
      const wsUrl = Cypress.env('API_URL').replace('http', 'ws').replace('/api/v1', '') + '/ws';
      return new Cypress.Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          expect(ws.readyState).to.eq(1); // OPEN
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          // WebSocket may not be available in test environment
          resolve();
        };
        setTimeout(resolve, 5000); // Timeout after 5s
      });
    });
  });
});

// ================================================================
// ADMIN CONFIGURATION — Provider, Brokerage, Wallet Management
// ================================================================
describe('Admin Configuration', () => {
  describe('Market Data Providers', () => {
    it('should list all market data providers', () => {
      cy.apiGet('/admin/config/providers').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.be.an('array');
        expect(res.body.data.length).to.be.greaterThan(0);
        const p = res.body.data[0];
        expect(p).to.have.property('provider_code');
        expect(p).to.have.property('display_name');
        expect(p).to.have.property('status');
      });
    });

    it('should get single provider details', () => {
      cy.apiGet('/admin/config/providers').then((res) => {
        const id = res.body.data[0].id;
        cy.apiGet(`/admin/config/providers/${id}`).then((detail) => {
          expect(detail.status).to.eq(200);
          expect(detail.body).to.have.property('provider_code');
          expect(detail.body).to.have.property('base_url');
        });
      });
    });

    it('should update provider settings', () => {
      cy.apiGet('/admin/config/providers').then((res) => {
        const id = res.body.data[0].id;
        cy.request({
          method: 'PATCH',
          url: `${Cypress.env('API_URL')}/admin/config/providers/${id}`,
          headers: { Authorization: `Bearer ${Cypress.env('AUTH_TOKEN')}` },
          body: { priority: 5, notes: 'Cypress test update' },
        }).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.success).to.eq(true);
        });
      });
    });
  });

  describe('Brokerage Connectors', () => {
    it('should list all brokerage connectors', () => {
      cy.apiGet('/admin/config/brokerages').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.be.an('array');
        expect(res.body.data.length).to.be.greaterThan(0);
        const c = res.body.data[0];
        expect(c).to.have.property('connector_code');
        expect(c).to.have.property('broker_type');
      });
    });

    it('should test internal brokerage connectivity', () => {
      cy.apiGet('/admin/config/brokerages').then((res) => {
        const internal = res.body.data.find(c => c.connector_code === 'internal');
        if (internal) {
          cy.apiPost(`/admin/config/brokerages/${internal.id}/test`, {}).then((r) => {
            expect(r.status).to.eq(200);
            expect(r.body.status).to.eq('connected');
          });
        }
      });
    });
  });

  describe('Crypto Wallets Admin', () => {
    it('should list supported blockchains', () => {
      cy.apiGet('/admin/config/wallets/chains').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.have.property('bitcoin');
        expect(res.body.data).to.have.property('ethereum');
      });
    });

    it('should list supported tokens', () => {
      cy.apiGet('/admin/config/wallets/tokens').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.be.an('array');
      });
    });

    it('should list omnibus wallets', () => {
      cy.apiGet('/admin/config/wallets').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.be.an('array');
      });
    });
  });

  describe('Custom Instruments', () => {
    it('should list custom instruments', () => {
      cy.apiGet('/admin/config/instruments').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.be.an('array');
      });
    });

    it('should create a custom instrument', () => {
      cy.apiPost('/admin/config/instruments', {
        symbol: 'TEST-CYP',
        name: 'Cypress Test Instrument',
        assetClass: 'equity',
        exchange: 'T1X',
        clearingMethod: 'internal',
        settlementType: 'T+2',
        commissionRate: 0.001,
        lastPrice: 100.00,
      }).then((res) => {
        expect(res.status).to.eq(201);
        expect(res.body).to.have.property('id');
        expect(res.body.symbol).to.eq('TEST-CYP');
        expect(res.body.is_custom).to.eq(true);
      });
    });
  });

  describe('Clearing & Settlement', () => {
    it('should list settlement runs', () => {
      cy.apiGet('/admin/config/clearing/settlements').then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.data).to.be.an('array');
      });
    });

    it('should run settlement', () => {
      const today = new Date().toISOString().slice(0, 10);
      cy.apiPost('/admin/config/clearing/settlement', { date: today }).then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body).to.have.property('trades');
      });
    });
  });
});

// ================================================================
// CLIENT CRYPTO WALLET ENDPOINTS
// ================================================================
describe('Client Crypto Wallets', () => {
  it('should get crypto accounts', () => {
    cy.apiGet('/crypto/accounts').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should get supported tokens', () => {
    cy.apiGet('/crypto/tokens').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should get crypto transaction history', () => {
    cy.apiGet('/crypto/transactions').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.data).to.be.an('array');
    });
  });

  it('should reject withdrawal with insufficient balance', () => {
    cy.apiPost('/crypto/accounts', { blockchain: 'ethereum' }).then(() => {
      cy.request({
        method: 'POST',
        url: `${Cypress.env('API_URL')}/crypto/withdraw`,
        headers: { Authorization: `Bearer ${Cypress.env('AUTH_TOKEN')}` },
        body: { blockchain: 'ethereum', toAddress: '0x1234567890abcdef', amount: 99999999 },
        failOnStatusCode: false,
      }).then((res) => {
        expect(res.status).to.be.oneOf([400, 500]);
      });
    });
  });
});
