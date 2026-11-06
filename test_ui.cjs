const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  await page.goto('http://localhost:5173/outbound');

  // Wait for loading to finish and buttons to be attached
  await page.waitForLoadState('networkidle');

  const manualButton = page.locator('button', { hasText: 'Nova Busca Manual' }).first();
  await manualButton.waitFor({ state: 'visible' });
  await manualButton.click();

  // Wait for animation
  await page.waitForTimeout(1000);

  // Select "Inserir Link"
  const radioLabel = page.locator('label').filter({ hasText: 'Inserir Link de Novo Edital' });
  await radioLabel.waitFor({ state: 'visible' });
  await radioLabel.click();

  // Wait
  await page.waitForTimeout(500);

  // Fill in the URL and Keywords
  await page.fill('input[type="url"]', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf');
  await page.fill('input[placeholder="Digite as palavras-chave..."]', 'teste');

  // Take screenshot
  await page.screenshot({ path: 'outbound_byoe.png' });

  // Click fetch
  await page.click('button:has-text("Buscar OSCs")');

  // Wait a bit to verify loading text
  await page.waitForTimeout(2000);

  // Take screenshot of loading phase
  await page.screenshot({ path: 'outbound_byoe_loading.png' });

  await browser.close();
  console.log('UI test script completed.');
})();
