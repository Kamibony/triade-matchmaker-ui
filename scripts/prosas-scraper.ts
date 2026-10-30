import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

function formatGoogleDriveUrl(url: string) {
    if (!url || typeof url !== 'string') return url;
    const driveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) {
        return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
    }
    return url;
}

async function loginOnProdutosIfNeeded(workerPage: any, username: string, password: string) {
    return await workerPage.evaluate(async ({ u, p }: { u: string, p: string }) => {
        let emailInput: HTMLInputElement | null = null;
        let passInput: HTMLInputElement | null = null;
        let submitBtn: HTMLButtonElement | HTMLInputElement | null = null;

        const queue: (Document | ShadowRoot | Element)[] = [document];
        const visited: any[] = [];

        while (queue.length > 0) {
            const root = queue.shift();
            if (!root) continue;

            const children = root.querySelectorAll('*');
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.shadowRoot && !visited.includes(child.shadowRoot)) {
                    visited.push(child.shadowRoot);
                    queue.push(child.shadowRoot);
                }

                if (child.tagName === 'INPUT') {
                    const type = child.getAttribute('type');
                    const name = child.getAttribute('name');
                    const placeholder = child.getAttribute('placeholder');

                    if (!emailInput && (type === 'email' || (name && name.toLowerCase().includes('email')) || (placeholder && placeholder.toLowerCase().includes('mail')) || type === 'text')) {
                        emailInput = child as HTMLInputElement;
                    } else if (!passInput && type === 'password') {
                        passInput = child as HTMLInputElement;
                    } else if (!submitBtn && type === 'submit') {
                        submitBtn = child as HTMLInputElement;
                    }
                } else if (!submitBtn && child.tagName === 'BUTTON') {
                    if (child.getAttribute('type') === 'submit') {
                        submitBtn = child as HTMLButtonElement;
                    }
                }
            }
        }

        if (emailInput && passInput && submitBtn) {
            emailInput.value = u;
            passInput.value = p;
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
            passInput.dispatchEvent(new Event('input', { bubbles: true }));
            passInput.dispatchEvent(new Event('change', { bubbles: true }));
            submitBtn.click();
            return true;
        }
        return false;
    }, { u: username, p: password });
}

async function capturePdfFromButton(page: any, context: any): Promise<string | null> {
    let newPage: any = null;
    let targetPage: any = page;
    let interceptedUrl: string | null = null;
    let resolvedUrl: string = '';
    let abortNavigation = false;

    // Set up request interception on the main page to catch same-tab navigation
    await page.route('**/*', (route: any, request: any) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            interceptedUrl = request.url();
            abortNavigation = true;
            route.abort(); // Prevent the main page from navigating away
        } else {
            route.continue();
        }
    });

    try {
        // Wait slightly longer so SPA/Web Components finish rendering
        await page.waitForTimeout(3500);

        // Find the "Acessar" or "Inscreva-se" button via DOM and Shadow DOM
        const buttonInfo = await page.evaluate(() => {
            const queue: (Document | ShadowRoot | Element)[] = [document];
            const visited: any[] = [];

            while (queue.length > 0) {
                const root = queue.shift();
                if (!root) continue;

                const els = root.querySelectorAll('*');
                for (let i = 0; i < els.length; i++) {
                    const el = els[i];
                    if (el.shadowRoot && !visited.includes(el.shadowRoot)) {
                        visited.push(el.shadowRoot);
                        queue.push(el.shadowRoot);
                    }
                    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
                        const txt = (el.textContent || '').toLowerCase().trim();
                        if (['acessar', 'inscreva-se', 'acessar edital', 'baixar edital', 'ver edital', 'abrir edital'].includes(txt)) {
                            if (el.tagName === 'A') {
                                const a = el as HTMLAnchorElement;
                                const href = a.href || a.getAttribute('href');
                                if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                                     return { found: true, isAnchor: true, href: href, html: el.outerHTML };
                                }
                            }
                            return { found: true, isAnchor: false, href: null, html: el.outerHTML };
                        }
                    }
                }
            }
            return null;
        });

        const btnSelector = await page.evaluateHandle(() => {
            const queue: (Document | ShadowRoot | Element)[] = [document];
            const visited: any[] = [];

            while (queue.length > 0) {
                const root = queue.shift();
                if (!root) continue;

                const els = root.querySelectorAll('*');
                for (let i = 0; i < els.length; i++) {
                    const el = els[i];
                    if (el.shadowRoot && !visited.includes(el.shadowRoot)) {
                        visited.push(el.shadowRoot);
                        queue.push(el.shadowRoot);
                    }
                    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
                        const txt = (el.textContent || '').toLowerCase().trim();
                        if (['acessar', 'inscreva-se', 'acessar edital', 'baixar edital', 'ver edital', 'abrir edital'].includes(txt)) {
                            return el;
                        }
                    }
                }
            }
            return null;
        });

        const isBtnFound = await page.evaluate(btn => btn !== null, btnSelector);
        if (buttonInfo?.isAnchor && buttonInfo.href) {
             const formatGoogleDriveUrl = (url: string) => {
                if (!url || typeof url !== 'string') return url;
                const driveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
                if (driveMatch) {
                    return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
                }
                return url;
            };
            let directHref = formatGoogleDriveUrl(buttonInfo.href);
            if (directHref.toLowerCase().endsWith('.pdf') || directHref.toLowerCase().includes('.pdf?') || directHref.includes('drive.google.com/uc?export=download')) {
                 return directHref;
            } else {
                 try {
                     newPage = await context.newPage();
                     await newPage.goto(directHref, { waitUntil: 'networkidle', timeout: 15000 });
                     targetPage = newPage;
                     resolvedUrl = targetPage.url();
                     interceptedUrl = resolvedUrl;
                 } catch (e) {}
            }
        } else if (isBtnFound) {
            // Click using evaluate since we have the handle via DOM traversal
            const pagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
            const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);

            try {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 5000 }).catch(() => {}),
                    btnSelector.evaluate((btn: any) => btn.click())
                ]);
            } catch (e) {}

            await page.waitForTimeout(2000);

            newPage = await pagePromise;

            const download = await downloadPromise;
            if (download) {
                return download.url();
            }

            resolvedUrl = targetPage.url();
        } else {
            // fallback to locator
            const button = page.locator('text="Acessar"').or(page.locator('text="Inscreva-se"')).first();
            const count = await button.count();
            if (count === 0) return null;

            const pagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
            const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
            await button.click({ timeout: 5000 }).catch(() => null);
            await page.waitForTimeout(2000);

            newPage = await pagePromise;

            const download = await downloadPromise;
            if (download) {
                return download.url();
            }
        }

        if (!resolvedUrl) {
            resolvedUrl = interceptedUrl || page.url(); // Fallback to current URL if no navigation happened
        }

        if (newPage) {
            targetPage = newPage;
            await targetPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            resolvedUrl = targetPage.url();
        } else if (interceptedUrl) {
            // We caught a same-tab navigation. Check if it's a PDF.
            interceptedUrl = formatGoogleDriveUrl(interceptedUrl);
            if (interceptedUrl.toLowerCase().endsWith('.pdf') || interceptedUrl.toLowerCase().includes('.pdf?') || interceptedUrl.includes('drive.google.com/uc?export=download')) {
                 return interceptedUrl;
            } else {
                 // It's an HTML page but we aborted it on the main page.
                 // We need to fetch it to evaluate it without navigating the main page.
                 try {
                     newPage = await context.newPage();
                     await newPage.goto(interceptedUrl, { waitUntil: 'networkidle', timeout: 15000 });
                     targetPage = newPage;
                     resolvedUrl = targetPage.url();
                 } catch (e) {
                     return null; // Failed to load external page
                 }
            }
        } else {
           return null; // No navigation happened
        }

        // Scenario A: Direct PDF
        resolvedUrl = formatGoogleDriveUrl(resolvedUrl);
        if (resolvedUrl.toLowerCase().endsWith('.pdf') || resolvedUrl.toLowerCase().includes('.pdf?') || resolvedUrl.includes('drive.google.com/uc?export=download')) {
            return resolvedUrl;
        }

        // Scenario B: HTML Landing Page -> Deep Hunter
        const rawLinks = await targetPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const extractedLinks: { href: string, text: string }[] = [];
            for (let i = 0; i < links.length; i++) {
                const link = links[i];
                extractedLinks.push({
                    href: link.href || link.getAttribute('href') || '',
                    text: (link.textContent || '').toLowerCase()
                });
            }
            return extractedLinks;
        });

        let fallbackPdf = null;
        for (let i = 0; i < rawLinks.length; i++) {
            let href = rawLinks[i].href;
            href = formatGoogleDriveUrl(href);
            if (href.toLowerCase().endsWith('.pdf') || href.toLowerCase().includes('.pdf?') || href.includes('drive.google.com/uc?export=download')) {
                const text = rawLinks[i].text;
                if (text.includes('edital') || text.includes('regulamento') || text.includes('chamada') || text.includes('retificação')) {
                    return href;
                }
                if (!fallbackPdf) fallbackPdf = href;
            }
        }

        return fallbackPdf;

    } catch (e: any) {
        console.warn("[capturePdfFromButton] Error capturing PDF:", e.message);
        return null;
    } finally {
        // Clean up interception route
        try { await page.unroute('**/*'); } catch(e) {}
        if (newPage) {
            try { await newPage.close(); } catch (e) {}
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

        // Navigate to produtos.prosas.com.br to ensure SSO/cookie domain propagation
        await page.goto('https://produtos.prosas.com.br/editais', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);

        await loginOnProdutosIfNeeded(page, username, password);
        await page.waitForTimeout(3000);

        // Save authenticated session state
        const storageState = await context.storageState();


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
                        const matchingButtons = [];
                        for (let i = 0; i < buttons.length; i++) {
                            const btn = buttons[i];
                            if (btn.querySelector('svg') &&
                                btn.innerHTML.includes('M.29.71a.996.996 0 0 0 0 1.41L4.17 6 .29 9.88') &&
                                !btn.disabled) {
                                matchingButtons.push(btn);
                            }
                        }

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


        // Implement Upsert Pattern: Start with existing data, upsert new API data
        const masterMap = new Map<string, any>(existingDataMap);

        allItems.forEach(item => {
            const existing = masterMap.get(String(item.id));

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

            const forceRescrape = process.env.FORCE_RESCRAPE === 'true';

            if (existing) {
                // Update existing record but strictly protect state and metadata fields
                const merged = {
                    ...item,
                    attributes: cleanAttributes,
                    deep_metadata: forceRescrape ? undefined : existing.deep_metadata,
                    pdf_link: forceRescrape ? undefined : existing.pdf_link,
                    full_text: forceRescrape ? undefined : existing.full_text,
                    retry_count: forceRescrape ? undefined : existing.retry_count,
                    last_error: forceRescrape ? undefined : existing.last_error,
                    public_url: existing.public_url || item.public_url,
                    pipeline_status: forceRescrape ? 'NEW_FROM_API' : existing.pipeline_status || 'NEW_FROM_API'
                };

                // Prevent bloat
                masterMap.set(String(item.id), {
                    id: merged.id,
                    attributes: merged.attributes,
                    public_url: merged.public_url,
                    pdf_link: merged.pdf_link,
                    full_text: merged.full_text,
                    deep_metadata: merged.deep_metadata,
                    retry_count: merged.retry_count,
                    last_error: merged.last_error,
                    pipeline_status: merged.pipeline_status
                });
            } else {
                // Insert new record
                masterMap.set(String(item.id), {
                    id: item.id,
                    attributes: cleanAttributes,
                    public_url: item.public_url,
                    pdf_link: item.pdf_link,
                    full_text: item.full_text,
                    deep_metadata: item.deep_metadata,
                    retry_count: item.retry_count,
                    last_error: item.last_error,
                    pipeline_status: 'NEW_FROM_API'
                });
            }
        });

        let deduplicatedItems = Array.from(masterMap.values());

        const maxDeepScrape = process.env.MAX_DEEP_SCRAPE ? parseInt(process.env.MAX_DEEP_SCRAPE, 10) : 450;
        const forceRescrape = process.env.FORCE_RESCRAPE === 'true';
        const eligibleItems = deduplicatedItems.filter(item =>
            forceRescrape || (item.pipeline_status !== 'COMPLETED' && item.pipeline_status !== 'FAILED_PERMANENTLY' && item.pipeline_status !== 'PENDING_EXTRACTION')
        );
        const itemsToDeepScrape = eligibleItems.slice(0, maxDeepScrape);

        const concurrency = 2;
        let processedCount = 0;

        const chunkSize = 50;
        for (let i = 0; i < itemsToDeepScrape.length; i += chunkSize) {
            const chunk = itemsToDeepScrape.slice(i, i + chunkSize);

            try {
                const queue = [...chunk];

                await Promise.all(
                    Array.from({ length: concurrency }).map(async () => {
                        while (queue.length > 0) {
                            const item = queue.shift();

                            if (!item) break;

                            const isCentral = item.attributes && item.attributes['e_central?'] === true;
                            const detailUrl = isCentral
                                ? `https://produtos.prosas.com.br/editais/edital?edital_id=${item.id}`
                                : `https://prosas.com.br/editais/${item.id}`;

                            let workerPage: any = null;
                            try {
                                workerPage = await context.newPage();
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

                                // Login Wall Guard
                                if (pageText.includes("Você precisa se logar") || pageText.includes("You need to sign in or sign up")) {
                                    console.warn(`[StandaloneProsasScraper] Hit login wall on ${detailUrl}. Attempting to login.`);
                                    const username = process.env.PROSAS_USERNAME;
                                    const password = process.env.PROSAS_PASSWORD;

                                    if (username && password) {
                                        const loginSuccess = await loginOnProdutosIfNeeded(workerPage, username, password);

                                        if (loginSuccess) {
                                            await workerPage.waitForTimeout(5000).catch(() => {});
                                            pageText = await workerPage.evaluate(() => {
                                                let text = document.body.innerText || '';
                                                const allElements = document.querySelectorAll('*');
                                                for (let i = 0; i < allElements.length; i++) {
                                                    if (allElements[i].shadowRoot) {
                                                        text += '\n' + (allElements[i].shadowRoot.textContent || '');
                                                    }
                                                }
                                                return text.replace(/\n\s*\n/g, '\n').trim();
                                            });
                                        }
                                    }

                                    if (pageText.includes("Você precisa se logar") || pageText.includes("You need to sign in or sign up")) {
                                        console.warn(`[StandaloneProsasScraper] Hit login wall on ${detailUrl}. Bailing out.`);
                                        throw new Error("Hit login wall - skipping to prevent poisoning data.");
                                    }
                                }

                                // Smart Capture Strategy
                                let smartPdf = await capturePdfFromButton(workerPage, context);

                                const rawWorkerLinks = await workerPage.evaluate(() => {
                                    const allElements = document.querySelectorAll('*');
                                    const allLinks: { href: string, text: string }[] = [];

                                    for (let i = 0; i < allElements.length; i++) {
                                        if (allElements[i].tagName === 'A') {
                                            const a = allElements[i] as HTMLAnchorElement;
                                            allLinks.push({
                                                href: a.href || a.getAttribute('href') || '',
                                                text: (a.textContent || '').toLowerCase().trim()
                                            });
                                        }
                                        if (allElements[i].shadowRoot) {
                                            const shadowLinks = allElements[i].shadowRoot!.querySelectorAll('a');
                                            for(let j=0; j<shadowLinks.length; j++) {
                                                const a = shadowLinks[j] as HTMLAnchorElement;
                                                allLinks.push({
                                                    href: a.href || a.getAttribute('href') || '',
                                                    text: (a.textContent || '').toLowerCase().trim()
                                                });
                                            }
                                        }
                                    }
                                    return allLinks;
                                });

                                let foundPdf = '';
                                let annexPdf = '';
                                for (let i = 0; i < rawWorkerLinks.length; i++) {
                                    const link = rawWorkerLinks[i];
                                    const btnText = link.text;
                                    let href = link.href;
                                    href = formatGoogleDriveUrl(href);

                                    if (href && (href.toLowerCase().endsWith('.pdf') || href.toLowerCase().includes('.pdf?') || href.includes('drive.google.com/uc?export=download'))) {
                                        const isAnnex = btnText.includes('anexo') || btnText.includes('modelo') || btnText.includes('planilha') || btnText.includes('formulario') || href.toLowerCase().includes('anexo') || href.toLowerCase().includes('modelo') || href.toLowerCase().includes('planilha') || href.toLowerCase().includes('formulario');

                                        if (isAnnex) {
                                            if (!annexPdf) annexPdf = href;
                                            continue;
                                        }

                                        if (btnText.includes('regulamento') || btnText.includes('edital') || btnText.includes('complementares') || btnText.includes('chamamento') || btnText.includes('documento') || btnText.includes('regras')) {
                                            foundPdf = href;
                                            break;
                                        }
                                        if (!foundPdf) foundPdf = href;
                                    }
                                }

                                let pdfLink = foundPdf || annexPdf;

                                const finalPdfLink = smartPdf || pdfLink;
                                if (finalPdfLink && (finalPdfLink.toLowerCase().endsWith('.pdf') || finalPdfLink.toLowerCase().includes('.pdf?') || finalPdfLink.includes('drive.google.com/uc?export=download'))) {
                                    item.pdf_link = finalPdfLink;
                                } else {
                                    item.pdf_link = undefined; // Strict constraint: No Garbage URLs
                                }

                                if (pageText.length > 15000) pageText = pageText.substring(0, 15000);
                                item.full_text = pageText;
                                item.public_url = detailUrl;

                                if (!item.pdf_link && (!item.full_text || item.full_text.length < 300)) {
                                     item.pipeline_status = 'FAILED_PERMANENTLY';
                                     item.last_error = "No PDF found and insufficient text";
                                } else {
                                     item.pipeline_status = 'PENDING_EXTRACTION';
                                }

                            } catch (err: any) {
                                console.error(`[StandaloneProsasScraper] Failed to deep scrape ${detailUrl}: ${err.message}`);
                                item.last_error = err.message;
                            } finally {
                                if (workerPage) {
                                    try { await workerPage.close(); } catch (e) {}
                                }
                            }

                            processedCount++;
                            console.log(`[Scraper] (${processedCount}/${itemsToDeepScrape.length}) ${detailUrl} -> Status: ${item.pipeline_status} | PDF: ${item.pdf_link || 'None'}`);
                            if (processedCount % 20 === 0) {
                                fs.writeFileSync(outPath, JSON.stringify(deduplicatedItems, null, 2));
                            }
                        }
                    })
                );
            } catch (err: any) {
                console.error(`[StandaloneProsasScraper] Error processing chunk: ${err.message}`);
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
