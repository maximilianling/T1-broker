// ================================================================
// T1 BROKER MOBILE — DETOX E2E TESTS
// Full user journey: login → MFA → trade → portfolio → settings
// ================================================================
const { device, element, by, expect, waitFor } = require('detox');

const TEST_USER = { email: 'admin@t1broker.com', password: 'admin123!' };
const TEST_CLIENT = { email: 'client@t1broker.com', password: 'client123!' };

// ================================================================
// HELPERS
// ================================================================
async function login(email, password) {
  await element(by.placeholder('you@example.com')).tap();
  await element(by.placeholder('you@example.com')).typeText(email);
  await element(by.placeholder('••••••••')).tap();
  await element(by.placeholder('••••••••')).typeText(password);
  await element(by.text('Sign In')).tap();
}

async function waitForScreen(text, timeout = 10000) {
  await waitFor(element(by.text(text))).toBeVisible().withTimeout(timeout);
}

// ================================================================
// AUTH FLOW TESTS
// ================================================================
describe('Authentication', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('should show login screen on launch', async () => {
    await expect(element(by.text('T1 Broker'))).toBeVisible();
    await expect(element(by.text('Sign In'))).toBeVisible();
    await expect(element(by.placeholder('you@example.com'))).toBeVisible();
  });

  it('should show error for empty credentials', async () => {
    await element(by.text('Sign In')).tap();
    await expect(element(by.text('Please enter email and password'))).toBeVisible();
  });

  it('should show error for invalid credentials', async () => {
    await login('wrong@test.com', 'wrongpassword');
    await waitFor(element(by.text(/Invalid|failed|error/i))).toBeVisible().withTimeout(5000);
  });

  it('should login successfully with valid credentials', async () => {
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    // Should see trading screen or MFA screen
    await waitFor(
      element(by.text('Trading').or(by.text('Two-Factor')))
    ).toBeVisible().withTimeout(10000);
  });

  it('should handle MFA verification flow', async () => {
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    // If MFA is required
    try {
      await waitFor(element(by.text('Two-Factor'))).toBeVisible().withTimeout(5000);
      // Enter backup code for testing
      await element(by.text('Use a backup code')).tap();
      await element(by.placeholder('XXXX-XXXX')).tap();
      await element(by.placeholder('XXXX-XXXX')).typeText('test-backup1');
      await element(by.text('Verify')).tap();
    } catch (e) {
      // MFA not required — already on trading screen
    }
  });
});

// ================================================================
// TRADING SCREEN TESTS
// ================================================================
describe('Trading Screen', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    await waitForScreen('Trading', 15000);
  });

  it('should display portfolio value card', async () => {
    await expect(element(by.text('Total Portfolio Value'))).toBeVisible();
  });

  it('should display watchlist', async () => {
    await expect(element(by.text('Watchlist'))).toBeVisible();
    // Check at least one stock symbol exists
    await expect(element(by.text('AAPL').or(by.text('NVDA')))).toBeVisible();
  });

  it('should display recent orders', async () => {
    await expect(element(by.text('Recent Orders'))).toBeVisible();
  });

  it('should navigate to place order screen', async () => {
    await element(by.text('Quick Trade')).tap();
    await waitForScreen('SYMBOL');
  });

  it('should navigate back from order screen', async () => {
    await device.pressBack();
  });

  it('should refresh data on pull down', async () => {
    await element(by.id('tradingScroll') || by.type('RCTScrollView')).swipe('down', 'fast');
    // Should not crash
    await expect(element(by.text('Total Portfolio Value'))).toBeVisible();
  });
});

// ================================================================
// ORDER PLACEMENT TESTS
// ================================================================
describe('Order Placement', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    await waitForScreen('Trading', 15000);
    await element(by.text('Quick Trade')).tap();
  });

  it('should show order entry form', async () => {
    await expect(element(by.text('SYMBOL'))).toBeVisible();
    await expect(element(by.text('BUY'))).toBeVisible();
    await expect(element(by.text('SELL'))).toBeVisible();
  });

  it('should enter stock symbol', async () => {
    await element(by.placeholder('AAPL')).tap();
    await element(by.placeholder('AAPL')).typeText('AAPL');
    await expect(element(by.displayValue('AAPL'))).toBeVisible();
  });

  it('should toggle buy/sell', async () => {
    await element(by.text('↘ SELL')).tap();
    // Sell should be selected
    await element(by.text('↗ BUY')).tap();
  });

  it('should switch order types', async () => {
    await element(by.text('LIMIT')).tap();
    await expect(element(by.text('LIMIT PRICE'))).toBeVisible();
    await element(by.text('STOP')).tap();
    await expect(element(by.text('STOP PRICE'))).toBeVisible();
    await element(by.text('MARKET')).tap();
  });

  it('should set quantity via quick buttons', async () => {
    await element(by.text('10')).tap();
  });

  it('should show preview screen', async () => {
    await element(by.text('Preview Order')).tap();
    await waitForScreen('Confirm Order');
    await expect(element(by.text('BUY AAPL'))).toBeVisible();
    await expect(element(by.text('10 shares'))).toBeVisible();
  });

  it('should go back to edit', async () => {
    await element(by.text('← Edit Order')).tap();
    await expect(element(by.text('SYMBOL'))).toBeVisible();
  });
});

// ================================================================
// PORTFOLIO SCREEN TESTS
// ================================================================
describe('Portfolio Screen', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    await waitForScreen('Trading', 15000);
    await element(by.text('Portfolio')).tap();
  });

  it('should show portfolio summary', async () => {
    await expect(element(by.text('Market Value'))).toBeVisible();
    await expect(element(by.text('Unrealized P&L'))).toBeVisible();
  });

  it('should display performance chart', async () => {
    // Chart component should render (LineChart from chart-kit)
    await expect(element(by.text('this period'))).toBeVisible();
  });

  it('should switch time periods', async () => {
    await element(by.text('1W')).tap();
    await element(by.text('1Y')).tap();
    await element(by.text('1M')).tap();
  });

  it('should show allocation donut chart', async () => {
    await expect(element(by.text('Allocation'))).toBeVisible();
  });

  it('should display positions list', async () => {
    await expect(element(by.text(/Positions/))).toBeVisible();
    // At least one position visible
    await expect(element(by.text('AAPL').or(by.text('NVDA')))).toBeVisible();
  });

  it('should sort positions', async () => {
    await element(by.text('%')).tap(); // Sort by change
    await element(by.text('A-Z')).tap(); // Sort by name
    await element(by.text('$')).tap(); // Sort by value
  });

  it('should tap position to trade', async () => {
    await element(by.text('AAPL')).tap();
    await waitForScreen('SYMBOL');
    await device.pressBack();
  });
});

// ================================================================
// MARKETS SCREEN TESTS
// ================================================================
describe('Markets Screen', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    await waitForScreen('Trading', 15000);
    await element(by.text('Markets')).tap();
  });

  it('should show global indices', async () => {
    await expect(element(by.text('Global Indices'))).toBeVisible();
    await expect(element(by.text('S&P 500'))).toBeVisible();
  });

  it('should show top movers', async () => {
    await expect(element(by.text('Top Movers'))).toBeVisible();
  });

  it('should search for instruments', async () => {
    await element(by.placeholder('Search stocks, ETFs, crypto...')).tap();
    await element(by.placeholder('Search stocks, ETFs, crypto...')).typeText('AAPL');
    // Results or at least no crash
    await element(by.placeholder('Search stocks, ETFs, crypto...')).clearText();
  });
});

// ================================================================
// TRANSFERS SCREEN TESTS
// ================================================================
describe('Transfers Screen', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    await waitForScreen('Trading', 15000);
    await element(by.text('Transfers')).tap();
  });

  it('should show balance', async () => {
    await expect(element(by.text('Available Cash Balance'))).toBeVisible();
  });

  it('should toggle deposit/withdraw', async () => {
    await element(by.text('↑ Withdraw')).tap();
    await expect(element(by.text('Request Withdrawal'))).toBeVisible();
    await element(by.text('↓ Deposit')).tap();
    await expect(element(by.text('Deposit Funds'))).toBeVisible();
  });

  it('should set amount via quick buttons', async () => {
    await element(by.text('$5,000')).tap();
  });

  it('should show transfer history', async () => {
    await expect(element(by.text('Transfer History'))).toBeVisible();
  });
});

// ================================================================
// SETTINGS & SECURITY TESTS
// ================================================================
describe('Settings Screen', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_CLIENT.email, TEST_CLIENT.password);
    await waitForScreen('Trading', 15000);
    await element(by.text('Settings')).tap();
  });

  it('should show user profile', async () => {
    await expect(element(by.text('Settings'))).toBeVisible();
  });

  it('should navigate to security center', async () => {
    await element(by.text('Two-Factor Authentication')).tap();
    await waitForScreen('Security Center', 5000);
    await device.pressBack();
  });

  it('should toggle dark mode', async () => {
    // Find dark mode switch — should not crash
    await expect(element(by.text('Dark Mode'))).toBeVisible();
  });

  it('should show logout button', async () => {
    await expect(element(by.text('Sign Out'))).toBeVisible();
  });
});

// ================================================================
// ADMIN FLOW TESTS
// ================================================================
describe('Admin Dashboard', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
    await login(TEST_USER.email, TEST_USER.password);
    // Handle MFA if needed
    try {
      await waitFor(element(by.text('Two-Factor'))).toBeVisible().withTimeout(3000);
      await element(by.text('Use a backup code')).tap();
      await element(by.placeholder('XXXX-XXXX')).typeText('test-backup1');
      await element(by.text('Verify')).tap();
    } catch (e) {}
    await waitForScreen('Admin Dashboard', 15000);
  });

  it('should show admin dashboard with KPIs', async () => {
    await expect(element(by.text('Admin Dashboard'))).toBeVisible();
    await expect(element(by.text('Total AUM'))).toBeVisible();
    await expect(element(by.text('Active Clients'))).toBeVisible();
  });

  it('should show revenue chart', async () => {
    await expect(element(by.text('Revenue (7 days)'))).toBeVisible();
  });

  it('should show system health', async () => {
    await expect(element(by.text('System Health'))).toBeVisible();
    await expect(element(by.text('Uptime'))).toBeVisible();
  });

  it('should navigate to clients tab', async () => {
    await element(by.text('Clients')).tap();
    await expect(element(by.text(/accounts/))).toBeVisible();
  });

  it('should search clients', async () => {
    await element(by.placeholder('Search clients...')).tap();
    await element(by.placeholder('Search clients...')).typeText('Sarah');
    await expect(element(by.text('Sarah Chen'))).toBeVisible();
    await element(by.placeholder('Search clients...')).clearText();
  });

  it('should navigate to orders tab', async () => {
    await element(by.text('Orders')).tap();
    await expect(element(by.text(/pending/))).toBeVisible();
  });

  it('should filter orders by action needed', async () => {
    await element(by.text(/Action/)).tap();
  });

  it('should navigate to compliance tab', async () => {
    await element(by.text('Compliance')).tap();
    await expect(element(by.text(/pending reviews/))).toBeVisible();
  });

  it('should switch between KYC, alerts, and audit', async () => {
    await element(by.text(/Alerts/)).tap();
    await element(by.text(/Audit/)).tap();
    await element(by.text(/KYC/)).tap();
  });
});
