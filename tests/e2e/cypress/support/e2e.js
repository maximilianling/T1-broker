// ================================================================
// T1 BROKER — CYPRESS SUPPORT FILE
// Custom commands, auth helpers, test utilities
// ================================================================

// ── Custom Commands ──

// Login and store token
Cypress.Commands.add('login', (email, password) => {
  cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, { email, password })
    .then((res) => {
      const token = res.body.accessToken || res.body.token || res.body.data?.token;
      if (token) {
        Cypress.env('AUTH_TOKEN', token);
        window.localStorage?.setItem('t1_access', token);
      }
      if (res.body.refreshToken) {
        window.localStorage?.setItem('t1_refresh', res.body.refreshToken);
      }
      return token;
    });
});

// Authenticated API request
Cypress.Commands.add('apiGet', (path) => {
  cy.request({
    url: `${Cypress.env('API_URL')}${path}`,
    headers: { Authorization: `Bearer ${Cypress.env('AUTH_TOKEN')}` },
    failOnStatusCode: false,
  });
});

Cypress.Commands.add('apiPost', (path, body) => {
  cy.request({
    method: 'POST',
    url: `${Cypress.env('API_URL')}${path}`,
    headers: { Authorization: `Bearer ${Cypress.env('AUTH_TOKEN')}` },
    body,
    failOnStatusCode: false,
  });
});

// Login as admin via UI
Cypress.Commands.add('loginAdmin', () => {
  cy.visit('/');
  cy.get('[data-cy=email-input], input[type="email"], input[placeholder*="email"]')
    .first().clear().type(Cypress.env('TEST_USER_EMAIL'));
  cy.get('[data-cy=password-input], input[type="password"]')
    .first().clear().type(Cypress.env('TEST_USER_PASSWORD'));
  cy.get('[data-cy=login-button], button[type="submit"]').first().click();
  cy.wait(2000);
});

// Login as client via UI
Cypress.Commands.add('loginClient', () => {
  cy.visit('/');
  cy.get('[data-cy=email-input], input[type="email"], input[placeholder*="email"]')
    .first().clear().type(Cypress.env('TEST_CLIENT_EMAIL'));
  cy.get('[data-cy=password-input], input[type="password"]')
    .first().clear().type(Cypress.env('TEST_CLIENT_PASSWORD'));
  cy.get('[data-cy=login-button], button[type="submit"]').first().click();
  cy.wait(2000);
});

// ── Global Hooks ──
beforeEach(() => {
  // Suppress uncaught exceptions from app
  cy.on('uncaught:exception', (err) => {
    if (err.message.includes('WebSocket') || err.message.includes('ResizeObserver')) {
      return false;
    }
  });
});

// ── Viewport Helpers ──
Cypress.Commands.add('setMobile', () => cy.viewport(375, 812));
Cypress.Commands.add('setTablet', () => cy.viewport(768, 1024));
Cypress.Commands.add('setDesktop', () => cy.viewport(1280, 800));
