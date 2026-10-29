import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

async function captureExternalUrl(page: any) {
  let finalUrl: string | null = null;
  let navigationIntercepted = false;

  const routeHandler = async (route: any, request: any) => {
    try {
      if (request.isNavigationRequest()) {
        const url = request.url();
        if (!url.includes('prosas.com.br') && !url.includes('linkedin.com') && !url.includes('wa.me') && url !== 'about:blank') {
          finalUrl = url;
          navigationIntercepted = true;
          await route.abort('aborted').catch(() => {});
          return;
        }
      }
      await route.continue().catch(() => {});
    } catch (e) {}
  };

  let capturedPopup: any = null;
  const pageListener = (newPage: any) => {
    capturedPopup = newPage;
  };

  try {
    await page.waitForSelector('prosas-listagem-editais', { state: 'attached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});

    const targetButton = page.getByText(/(acessar|inscreva-se)/i)
      .filter({ hasNotText: /acessar perfil/i })
      .first();

    if (!(await targetButton.isVisible({ timeout: 8000 }).catch(() => false))) {
      return null;
    }

    page.on('popup', pageListener);
    await page.route('**/*', routeHandler);

    await targetButton.click({ force: true, timeout: 3000 }).catch(() => {});

    for (let i = 0; i < 10; i++) {
      if (navigationIntercepted) break;
      if (capturedPopup) {
        try {
          let u = capturedPopup.url();
          if (u === 'about:blank') {
            await capturedPopup.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
            u = capturedPopup.url();
          }
          if (u && !u.includes('prosas.com.br') && !u.includes('linkedin.com') && !u.includes('wa.me')) {
            finalUrl = u;
          }
        } catch (e) {}
        break;
      }
      await page.waitForTimeout(300).catch(() => {});
    }

    return finalUrl;
  } catch (error: any) {
    console.warn(`[captureExternalUrl] Failed: ${error.message}`);
    return null;
  } finally {
    try { page.off('popup', pageListener); } catch (e) {}
    try { await page.unroute('**/*', routeHandler); } catch (e) {}
    if (capturedPopup) {
      try { await capturedPopup.close(); } catch (e) {}
    }
  }
}

async function runStandaloneScraper() {
    const username = process.env.PROSAS_USERNAME;
    const password = process.env.PROSAS_PASSWORD;

    if (!username || !password) {
        throw new Error("[StandaloneProsasScraper] PROSAS_USERNAME or PROSAS_PASSWORD environment variables are not set.");
    }

    chromium.use(stealth());
    let browser: any;
    let context: any;

    try {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext();
        const page = await context.newPage();

        await page.goto('https://prosas.com.br/users/sign_in', { waitUntil: 'networkidle', timeout: 60000 });
        await page.locator('#user_email').last().waitFor({ state: 'visible', timeout: 30000 });
        await page.locator('#user_email').last().fill(username);
        await page.locator('#user_password').last().fill(password);
        await page.locator('input[type="submit"][name="commit"]').last().click();

        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(5000);

        if (page.url().includes('/users/sign_in')) {
            throw new Error("[StandaloneProsasScraper] Failed to navigate past login page.");
        }


        const allItems: any[] = [];
        const existingDataMap = new Map<string, any>();
        const outPath = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');

        try {
            if (fs.existsSync(outPath)) {
                const existingData = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
                if (Array.isArray(existingData)) {
                    existingData.forEach(item => existingDataMap.set(String(item.id), item));
                }
            }
        } catch (e) {
            console.warn("[StandaloneProsasScraper] Failed to load existing data, starting fresh.");
        }

        let currentPage = 1;
        const maxPages = 50;
        let hasMore = true;
        const seenUrls = new Set<string>();

        const waitNextApiResponse = () => page.waitForResponse(
            (response: any) => {
                const url = response.url();
                return url.includes('selecao/api/v2/third_party/oportunidades/inscricoes_abertas') &&
                       response.request().method() === 'GET' &&
                       !seenUrls.has(url);
            },
            { timeout: 30000 }
        ).then(async (res: any) => {
            if (!res.ok()) {
                if (res.status() === 403) throw new Error("403_FORBIDDEN");
                throw new Error(`API returned HTTP ${res.status()}`);
            }
            seenUrls.add(res.url());
            return res.json();
        });

        let apiPromise = waitNextApiResponse();
        await page.goto('https://prosas.com.br/editais', { waitUntil: 'networkidle', timeout: 60000 });

        while (currentPage <= maxPages && hasMore) {
            try {
                const data = await apiPromise;
                const items = data.data || [];
                if (items.length === 0) {
                    hasMore = false;
                    break;
                }

                if (allItems.length > 0 && JSON.stringify(allItems.slice(-items.length)) === JSON.stringify(items)) {
                    hasMore = false;
                    break;
                }

                allItems.push(...items);
                await page.waitForTimeout(1000);
                const nextApiPromise = waitNextApiResponse();

                const nextClicked = await page.evaluate(() => {
                    const component = document.querySelector('prosas-listagem-editais');
                    if (component && component.shadowRoot) {
                        const buttons = component.shadowRoot.querySelectorAll('button');
                        const matchingButtons = Array.from(buttons).filter((btn: any) => {
                            return btn.querySelector('svg') &&
                                   btn.innerHTML.includes('M.29.71a.996.996 0 0 0 0 1.41L4.17 6 .29 9.88') &&
                                   !btn.disabled;
                        });

                        if (matchingButtons.length > 0) {
                            const nextBtn = matchingButtons[matchingButtons.length - 1] as HTMLElement;
                            nextBtn.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (nextClicked) {
                    apiPromise = nextApiPromise;
                    currentPage++;
                    await page.waitForTimeout(1000);
                } else {
                    nextApiPromise.catch(() => {});
                    hasMore = false;
                }
            } catch (e: any) {
                hasMore = false;
                break;
            }
        }


        const uniqueMap = new Map<string, any>();
        allItems.forEach(item => uniqueMap.set(String(item.id), item));

        let deduplicatedItems = Array.from(uniqueMap.values());

        // Merge with existing data
        deduplicatedItems = deduplicatedItems.map(item => {
            const existing = existingDataMap.get(String(item.id));

            // Clean attributes
            const attrs = item.attributes || {};
            const cleanAttributes = {
                nome: attrs.nome,
                data_fim: attrs.data_fim,
                data_inicio: attrs.data_inicio,
                valor_total: attrs.valor_total,
                patrocinador: attrs.patrocinador,
                locais: attrs.locais,
                areas_interesse: attrs.areas_interesse,
                'e_central?': attrs['e_central?']
            };

            const merged = existing ? {
                ...item,
                attributes: cleanAttributes,
                deep_metadata: existing.deep_metadata,
                pdf_error: existing.pdf_error,
                pdf_skipped: existing.pdf_skipped,
                pdf_link: existing.pdf_link || item.pdf_link,
                external_link: existing.external_link || item.external_link,
                full_text: existing.full_text || item.full_text,
                retry_count: existing.retry_count,
                last_error: existing.last_error
            } : {
                ...item,
                attributes: cleanAttributes
            };

            // Return only the specified fields to prevent bloat
            return {
                id: merged.id,
                attributes: merged.attributes,
                public_url: merged.public_url,
                pdf_link: merged.pdf_link,
                external_link: merged.external_link,
                full_text: merged.full_text,
                deep_metadata: merged.deep_metadata,
                retry_count: merged.retry_count,
                last_error: merged.last_error,
                pdf_error: merged.pdf_error,
                pdf_skipped: merged.pdf_skipped
            };
        });

        const maxDeepScrape = process.env.MAX_DEEP_SCRAPE ? parseInt(process.env.MAX_DEEP_SCRAPE, 10) : 450;
        const itemsToDeepScrape = deduplicatedItems.slice(0, maxDeepScrape);
        const concurrency = 2;
        let processedCount = 0;

        const chunkSize = 50;
        for (let i = 0; i < itemsToDeepScrape.length; i += chunkSize) {
            const chunk = itemsToDeepScrape.slice(i, i + chunkSize);
            let chunkContext: any = null;

            try {
                chunkContext = await browser.newContext();
                const queue = [...chunk];

                await Promise.all(
                    Array.from({ length: concurrency }).map(async () => {
                        while (queue.length > 0) {
                            const item = queue.shift();

                            if (!item) break;

                            const hasDeepMetadata = !!item.deep_metadata;
                            const forceRescrape = process.env.FORCE_RESCRAPE === 'true';
                            const retryCount = item.retry_count || 0;

                            if ((hasDeepMetadata || retryCount >= 3) && !forceRescrape) {
                                // Skip deep scrape for this item
                                continue;
                            }

                            const isCentral = item.attributes && item.attributes['e_central?'] === true;
                            const detailUrl = isCentral
                                ? `https://produtos.prosas.com.br/editais/edital?edital_id=${item.id}`
                                : `https://prosas.com.br/editais/${item.id}`;

                            let workerPage: any = null;
                            try {
                                workerPage = await chunkContext.newPage();
                                workerPage.on('dialog', async (dialog: any) => { await dialog.dismiss().catch(() => {}); });
                                await workerPage.goto(detailUrl, { waitUntil: 'networkidle', timeout: 60000 });
                                await workerPage.waitForTimeout(2000).catch(() => {});

                                let pageText = await workerPage.evaluate(() => {
                                    let text = document.body.innerText || '';
                                    const allElements = document.querySelectorAll('*');
                                    for (let i = 0; i < allElements.length; i++) {
                                        if (allElements[i].shadowRoot) {
                                            text += '\n' + (allElements[i].shadowRoot.textContent || '');
                                        }
                                    }
                                    return text.replace(/\n\s*\n/g, '\n').trim();
                                });

                                // IMPLEMENT NEW PDF DETECTION LOGIC HERE BEFORE CAPTURE EXTERNAL URL
                                let pdfLink = await workerPage.evaluate(() => {
                                    let foundPdf = '';
                                    let annexPdf = '';
                                    const allElements = document.querySelectorAll('*');
                                    const allLinks: HTMLAnchorElement[] = [];

                                    for (let i = 0; i < allElements.length; i++) {
                                        if (allElements[i].tagName === 'A') allLinks.push(allElements[i] as HTMLAnchorElement);
                                        if (allElements[i].shadowRoot) {
                                            const shadowLinks = allElements[i].shadowRoot!.querySelectorAll('a');
                                            for(let j=0; j<shadowLinks.length; j++) allLinks.push(shadowLinks[j]);
                                        }
                                    }

                                    // Priorities for finding PDF links
                                    // 1. Direct PDF links with matching text (regulamento, edital, complementares, chamamento, documento, regras)
                                    // 2. Deprioritize links with anexo, modelo, planilha, formulario
                                    for (let i = 0; i < allLinks.length; i++) {
                                        const a = allLinks[i];
                                        const btnText = (a.textContent || '').toLowerCase().trim();
                                        const href = a.href || a.getAttribute('href') || '';

                                        if (href && (href.toLowerCase().endsWith('.pdf') || href.toLowerCase().includes('.pdf?'))) {
                                            const isAnnex = btnText.includes('anexo') || btnText.includes('modelo') || btnText.includes('planilha') || btnText.includes('formulario') || href.toLowerCase().includes('anexo') || href.toLowerCase().includes('modelo') || href.toLowerCase().includes('planilha') || href.toLowerCase().includes('formulario');

                                            if (isAnnex) {
                                                if (!annexPdf) annexPdf = href;
                                                continue;
                                            }

                                            if (btnText.includes('regulamento') || btnText.includes('edital') || btnText.includes('complementares') || btnText.includes('chamamento') || btnText.includes('documento') || btnText.includes('regras')) {
                                                return href;
                                            }
                                            if (!foundPdf) foundPdf = href;
                                        }
                                    }
                                    return foundPdf || annexPdf;
                                });

                                if (pdfLink) {
                                    item.pdf_link = pdfLink;
                                } else {
                                    let externalLink = await captureExternalUrl(workerPage);

                                    if (!externalLink) {
                                        externalLink = await workerPage.evaluate(() => {
                                            let fallback = '';
                                            const allElements = document.querySelectorAll('*');
                                            const allLinks: HTMLAnchorElement[] = [];

                                            for (let i = 0; i < allElements.length; i++) {
                                                if (allElements[i].tagName === 'A') allLinks.push(allElements[i] as HTMLAnchorElement);
                                                if (allElements[i].shadowRoot) {
                                                    const shadowLinks = allElements[i].shadowRoot!.querySelectorAll('a');
                                                    for(let j=0; j<shadowLinks.length; j++) allLinks.push(shadowLinks[j]);
                                                }
                                            }

                                            for (let i = 0; i < allLinks.length; i++) {
                                                const a = allLinks[i];
                                                const btnText = (a.textContent || '').toLowerCase().trim();
                                                const href = a.href || a.getAttribute('href') || '';

                                                if (!btnText) continue;

                                                if (href && href.startsWith('http') && !href.includes('prosas.com.br') && !href.includes('wa.me') && !href.includes('linkedin.com') && !href.includes('facebook.com') && !href.includes('instagram.com') && !href.includes('twitter.com') && !href.includes('youtube.com')) {
                                                    if (btnText.includes('acessar') || btnText.includes('inscreva-se') || btnText.includes('edital')) {
                                                        fallback = href;
                                                        break;
                                                    }
                                                    if (!fallback) fallback = href;
                                                }
                                            }
                                            return fallback;
                                        });
                                    }

                                    if (externalLink) {
                                        item.external_link = externalLink;
                                        pageText += `\n\nEXTERNAL_EDITAL_LINK: ${externalLink}`;
                                    }
                                }

                                if (pageText.length > 15000) pageText = pageText.substring(0, 15000);
                                item.full_text = pageText;
                                item.public_url = detailUrl;

                            } catch (err: any) {
                                console.error(`[StandaloneProsasScraper] Failed to deep scrape ${detailUrl}: ${err.message}`);
                            } finally {
                                if (workerPage) {
                                    try { await workerPage.close(); } catch (e) {}
                                }
                            }

                            processedCount++;
                            console.log(`[Scraper] (${processedCount}/${itemsToDeepScrape.length}) ${detailUrl} -> PDF: ${item.pdf_link || 'None'} | Ext: ${item.external_link || 'None'}`);
                            if (processedCount % 20 === 0) {
                                fs.writeFileSync(outPath, JSON.stringify(deduplicatedItems, null, 2));
                            }
                        }
                    })
                );
            } finally {
                if (chunkContext) {
                    try { await chunkContext.close(); } catch (e) {}
                }
            }
        }

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(deduplicatedItems, null, 2));

    } finally {
        if (context) {
            try { await context.close(); } catch (e) {}
        }
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }
}

runStandaloneScraper().catch((err) => {
    console.error("[StandaloneProsasScraper] Fatal error:", err);
    process.exit(1);
});
