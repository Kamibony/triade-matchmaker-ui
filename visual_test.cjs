const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  await page.goto('http://localhost:5173/outbound');

  // Wait for the UI to load
  await page.waitForSelector('h1:has-text("Radar de Captação")');

  // Wait for Svelte hydration
  await page.waitForTimeout(1000);

  // Verify manual search tab exists
  await page.click('button:has-text("Nova Busca Manual")');

  // Wait for the custom keyword input to appear
  await page.waitForSelector('input[placeholder="Digite as palavras-chave..."]');

  // Take screenshot
  await page.screenshot({ path: 'outbound-manual-search.png' });

  console.log('Visual verification complete. Screenshot saved.');
  await browser.close();
})();
