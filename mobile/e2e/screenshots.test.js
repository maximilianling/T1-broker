// ================================================================
// T1 BROKER — AUTOMATED SCREENSHOT GENERATOR
// Uses Detox to capture App Store / Play Store screenshots
// Run: npx detox test -c ios.sim.release e2e/screenshots.test.js
// ================================================================
const { device, element, by, expect } = require('detox');

const SCREENSHOT_DIR = 'store-assets/screenshots';

// Screenshot helper with device-specific naming
async function screenshot(name) {
  await new Promise(r => setTimeout(r, 500)); // Wait for animations
  await device.takeScreenshot(`${name}`);
}

beforeAll(async () => {
  await device.launchApp({ newInstance: true });
});

describe('App Store Screenshots', () => {

  // ── 1. Login Screen ──
  it('Screenshot: Login', async () => {
    await expect(element(by.text('T1 Broker'))).toBeVisible();
    await screenshot('01-login');
  });

  // ── 2. Trading Dashboard ──
  it('Screenshot: Trading Dashboard', async () => {
    // Login
    await element(by.id('email-input')).typeText('demo@t1broker.com');
    await element(by.id('password-input')).typeText('demo123');
    await element(by.id('login-button')).tap();
    await new Promise(r => setTimeout(r, 2000));

    // Capture trading dashboard
    await expect(element(by.text('Portfolio Value'))).toBeVisible();
    await screenshot('02-trading-dashboard');
  });

  // ── 3. Portfolio Analytics ──
  it('Screenshot: Portfolio', async () => {
    await element(by.text('Portfolio')).tap();
    await new Promise(r => setTimeout(r, 1000));
    await expect(element(by.text('Market Value'))).toBeVisible();
    await screenshot('03-portfolio-analytics');
  });

  // ── 4. Portfolio Chart (1M view) ──
  it('Screenshot: Portfolio Chart', async () => {
    await element(by.text('1M')).tap();
    await new Promise(r => setTimeout(r, 500));
    await screenshot('04-portfolio-chart');
  });

  // ── 5. Markets Screen ──
  it('Screenshot: Markets', async () => {
    await element(by.text('Markets')).tap();
    await new Promise(r => setTimeout(r, 1000));
    await expect(element(by.text('S&P 500'))).toBeVisible();
    await screenshot('05-markets');
  });

  // ── 6. Order Placement ──
  it('Screenshot: Order Entry', async () => {
    await element(by.text('Trading')).tap();
    await new Promise(r => setTimeout(r, 500));
    await element(by.id('quick-trade-button')).tap();
    await new Promise(r => setTimeout(r, 500));

    // Fill in order details
    await element(by.id('symbol-input')).typeText('AAPL');
    await element(by.text('BUY')).tap();
    await element(by.text('10')).tap(); // Quantity
    await screenshot('06-order-entry');
  });

  // ── 7. Order Preview ──
  it('Screenshot: Order Preview', async () => {
    await element(by.text('Preview Order')).tap();
    await new Promise(r => setTimeout(r, 500));
    await screenshot('07-order-preview');
    // Go back
    await element(by.text('Edit')).tap();
    await device.pressBack();
  });

  // ── 8. Transfers Screen ──
  it('Screenshot: Transfers', async () => {
    await element(by.text('Transfers')).tap();
    await new Promise(r => setTimeout(r, 1000));
    await screenshot('08-transfers');
  });

  // ── 9. Settings Screen ──
  it('Screenshot: Settings', async () => {
    await element(by.text('Settings')).tap();
    await new Promise(r => setTimeout(r, 500));
    await screenshot('09-settings');
  });

  // ── 10. Security Center ──
  it('Screenshot: Security', async () => {
    await element(by.text('2FA / Multi-Factor')).tap();
    await new Promise(r => setTimeout(r, 500));
    await screenshot('10-security-center');
    await device.pressBack();
  });

  // ── Dark Mode Variants ──
  it('Screenshot: Dark Mode Toggle', async () => {
    // Already in dark mode by default
    await element(by.text('Settings')).tap();
    await new Promise(r => setTimeout(r, 500));
    await screenshot('11-settings-dark');
  });
});

describe('Feature Highlights', () => {
  it('Screenshot: Biometric Prompt (simulated)', async () => {
    // Navigate to settings -> biometric
    await element(by.text('Settings')).tap();
    await new Promise(r => setTimeout(r, 500));
    // Take screenshot showing biometric toggle area
    await screenshot('12-biometric-setting');
  });

  it('Screenshot: Price Alert Setup', async () => {
    await element(by.text('Trading')).tap();
    await new Promise(r => setTimeout(r, 500));
    // If there's a watchlist item, long-press could open alert dialog
    await screenshot('13-watchlist-with-prices');
  });
});

// ================================================================
// POST-PROCESSING NOTES
// ================================================================
// After capturing raw screenshots:
//
// 1. Add device frames using:
//    - https://screenshots.pro
//    - https://mockuphone.com
//    - Figma device mockup templates
//
// 2. Add marketing text overlays:
//    - Screenshot 1: "Professional Trading Made Simple"
//    - Screenshot 2: "Track Your Portfolio"
//    - Screenshot 3: "Real-Time Market Data"
//    - Screenshot 4: "Trade with Confidence"
//    - Screenshot 5: "Bank-Grade Security"
//    - Screenshot 6: "Global Markets"
//
// 3. Export at required resolutions:
//    iOS:  1290×2796 (6.7"), 1179×2556 (6.1"), 2048×2732 (iPad)
//    Android: 1080×1920 (phone), 1200×1920 (7"), 1600×2560 (10")
//
// 4. Upload to respective stores:
//    - App Store Connect > Screenshots & Media
//    - Google Play Console > Store listing > Graphics
