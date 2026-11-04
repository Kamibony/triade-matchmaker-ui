const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // mock match to return null for prazo_de_inscricao to test the UI for Fluxo Contínuo
  await context.route('**/api/match', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (Array.isArray(json) && json.length > 0) {
      json[0].prazo_de_inscricao = null;
    }
    await route.fulfill({ response, json });
  });

  const page = await context.newPage();

  console.log('Navigating to http://localhost:5173/');
  await page.goto('http://localhost:5173/');

  // Need to wait for hydration!
  await page.waitForTimeout(3000);

  // Fill the form
  await page.fill('#cnpj', '33.683.111/0002-80');
  await page.fill('#foco', 'Test foco');
  await page.click('button[type="submit"]');

  // Wait for the profile and the "Gerar Dossiê" button
  await page.waitForSelector('text="Perfil da Organização"', { timeout: 30000 });
  await page.waitForSelector('text="Gerar Dossiê de IA & Buscar Editais"');

  console.log('Generating dossier');
  await page.click('text="Gerar Dossiê de IA & Buscar Editais"');

  // Wait for the button text to change to "Atualizar Resultados"
  await page.waitForSelector('text="Atualizar Resultados"', { timeout: 30000 });
  console.log('Button changed to "Atualizar Resultados" successfully');

  // wait a bit for matches to render fully
  await page.waitForTimeout(1000);

  await page.screenshot({ path: '/home/jules/verification/screenshot2.png', fullPage: true });

  await browser.close();
})();
