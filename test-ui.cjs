const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(2000);

    // Directly execute search function to bypass API if possible or check error UI
    await page.fill('input#cnpj', '00000000000000');
    await page.click('button[type="submit"]');

    await page.waitForTimeout(5000); // Give it more time to possibly hit BrasilAPI

    await page.screenshot({ path: 'frontend_screenshot.png' });
    console.log('Screenshot saved to frontend_screenshot.png');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
