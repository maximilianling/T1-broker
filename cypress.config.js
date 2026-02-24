const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000',
    supportFile: 'tests/e2e/cypress/support/commands.js',
    specPattern: 'tests/e2e/cypress/**/*.cy.js',
    fixturesFolder: 'tests/e2e/cypress/fixtures',
    viewportWidth: 1440,
    viewportHeight: 900,
    defaultCommandTimeout: 10000,
    requestTimeout: 15000,
    responseTimeout: 15000,
    video: true,
    screenshotOnRunFailure: true,
    retries: { runMode: 2, openMode: 0 },
    env: {
      API_URL: 'http://localhost:3000/api/v1',
      ADMIN_EMAIL: 'admin@t1broker.com',
      ADMIN_PASSWORD: 'admin123!',
      CLIENT_EMAIL: 'client@t1broker.com',
      CLIENT_PASSWORD: 'client123!',
    },
    setupNodeEvents(on, config) {
      // Node event listeners
      on('task', {
        log(message) { console.log(message); return null; },
      });
    },
  },
});
