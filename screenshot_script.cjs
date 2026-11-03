const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(2000); // wait for initial load

    // Enter CNPJ and click search to get OSC Details loaded
    await page.fill('input[type="text"]', '97537330000109'); // example valid CNPJ or dummy
    await page.click('button[type="submit"]');

    // Wait for the OSC profile section to appear which will contain the new button
    await page.waitForSelector('text=Perfil da Organização', { timeout: 10000 }).catch(() => console.log('OSC Profile timeout'));
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'frontend_screenshot.png' });
    console.log('Screenshot saved to frontend_screenshot.png');
  } catch (error) {
    console.error('Error during Playwright script:', error);
  } finally {
    await browser.close();
  }
})();
