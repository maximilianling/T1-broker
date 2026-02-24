// ================================================================
// T1 BROKER — CYPRESS CUSTOM COMMANDS
// ================================================================

// Login via UI
Cypress.Commands.add('login', (email, password) => {
  cy.visit('/');
  cy.get('input[placeholder*="email" i], input[type="email"]').clear().type(email);
  cy.get('input[type="password"]').clear().type(password);
  cy.contains('button', /sign in|login/i).click();
});

// Login via API (faster for non-auth tests)
Cypress.Commands.add('loginAPI', (email, password) => {
  cy.request('POST', `${Cypress.env('API_URL')}/auth/login`, { email, password }).then((res) => {
    if (res.body.accessToken) {
      window.localStorage.setItem('t1_token', res.body.accessToken);
      window.localStorage.setItem('t1_refresh', res.body.refreshToken);
      window.localStorage.setItem('t1_user', JSON.stringify(res.body.user));
    }
  });
});

// Wait for page to load
Cypress.Commands.add('waitForApp', () => {
  cy.get('#appShell', { timeout: 15000 }).should('have.class', 'show');
});

// Navigate to a page via sidebar
Cypress.Commands.add('navigateTo', (pageName) => {
  cy.contains('.sitem', pageName).click();
  cy.wait(500);
});

// Toast message assertion
Cypress.Commands.add('expectToast', (message) => {
  cy.contains('.toast', message, { timeout: 5000 }).should('be.visible');
});

// API request with auth token
Cypress.Commands.add('apiRequest', (method, url, body) => {
  const token = window.localStorage.getItem('t1_token');
  return cy.request({
    method,
    url: `${Cypress.env('API_URL')}${url}`,
    body,
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
});

// Prevent uncaught exceptions from failing tests
Cypress.on('uncaught:exception', (err) => {
  // Return false to prevent test failure on expected errors
  if (err.message.includes('WebSocket') || err.message.includes('Network')) return false;
  return true;
});
