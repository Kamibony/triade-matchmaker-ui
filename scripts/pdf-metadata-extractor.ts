import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const apiKey = process.env.GEMINI_API_KEY || '';
if (!apiKey) {
    console.warn('GEMINI_API_KEY is not set. Execution will fail if API is called.');
}

const genAI = new GoogleGenerativeAI(apiKey);

export function extractProsasHeaderInfo(fullText: string | undefined): {
    data_inicio?: string;
    data_fim?: string;
    valor_total?: number;
} {
    if (!fullText) return {};
    const info: { data_inicio?: string; data_fim?: string; valor_total?: number } = {};

    // Pattern 1: produtos.prosas.com.br ("21/09/26 até 29/10/26")
    const match2Digit = fullText.match(/(\d{2})\/(\d{2})\/(\d{2})\s+at[ée]\s+(\d{2})\/(\d{2})\/(\d{2})/i);
    if (match2Digit) {
        info.data_inicio = `20${match2Digit[3]}-${match2Digit[2]}-${match2Digit[1]}`;
        info.data_fim = `20${match2Digit[6]}-${match2Digit[5]}-${match2Digit[4]}`;
    } else {
        // Pattern 2: prosas.com.br ("Inscrições a partir de: 23/02/2026 12:00 01/12/2026 22:00")
        const match4Digit = fullText.match(/Inscri[çc][õo]es a partir de:\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{2}:\d{2})?\s+(\d{2})\/(\d{2})\/(\d{4})/i);
        if (match4Digit) {
            info.data_inicio = `${match4Digit[3]}-${match4Digit[2]}-${match4Digit[1]}`;
            info.data_fim = `${match4Digit[6]}-${match4Digit[5]}-${match4Digit[4]}`;
        }
    }

    const valMatch = fullText.match(/Total Dispon[íi]vel\s+R\$\s*([\d\.]+,\d{2})/i);
    if (valMatch) {
        const parsedVal = parseFloat(valMatch[1].replace(/\./g, '').replace(',', '.'));
        if (!isNaN(parsedVal) && parsedVal > 0) {
            info.valor_total = parsedVal;
        }
    }

    return info;
}

export async function downloadPdf(url: string): Promise<{ success: boolean, data?: ArrayBuffer, error?: string, skip?: boolean, notPdf?: boolean, expiredPresigned?: boolean, fallbackToText?: boolean }> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            if (response.status === 403 || response.status === 401 || response.status === 404) {
                if (url.includes('amazonaws.com') && response.status !== 404) {
                    return { success: false, expiredPresigned: true, error: `HTTP Error: ${response.status} (Presigned URL expired)` };
                } else {
                    return { success: false, fallbackToText: true, error: `HTTP Error: ${response.status} (Access denied/Not Found, falling back to text)` };
                }
            }
            return { success: false, error: `HTTP Error: ${response.status}` };
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || (!contentType.includes('application/pdf') && !contentType.includes('application/octet-stream'))) {
            return { success: false, notPdf: true, error: 'URL did not return a valid PDF binary' };
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 15 * 1024 * 1024) {
            return { success: false, skip: true, error: 'File too large (> 15MB)' };
        }

        const data = await response.arrayBuffer();

        if (data.byteLength >= 4) {
            const bytes = new Uint8Array(data, 0, 4);
            if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
                return { success: false, notPdf: true, error: 'URL did not return a valid PDF binary' };
            }
        } else {
            return { success: false, notPdf: true, error: 'URL did not return a valid PDF binary' };
        }

        if (data.byteLength > 15 * 1024 * 1024) {
            return { success: false, skip: true, error: 'File too large (> 15MB) upon download' };
        }

        return { success: true, data };
    } catch (error: any) {
        if (error.name === 'AbortError') {
            return { success: false, error: 'Request timed out' };
        }
        return { success: false, error: error.message };
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const DATA_FILE = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');
const ARCHIVE_FILE = path.join(process.cwd(), 'src', 'data', 'editais_historico.json');

const sharedGenerationConfig = {
    responseMimeType: "application/json" as const,
    responseSchema: {
        type: "object" as const,
        properties: {
            edital_id: { type: "string" as const },
            resumo_objetivo: { type: "string" as const, description: "1-2 sentences in pt-BR summarizing the grant's core goal" },
            temas_principais: { type: "array" as const, items: { type: "string" as const }, description: "array of strings in pt-BR (e.g., 'mulheres', 'agricultura familiar', 'cultura', 'saúde')" },
            prazo_de_inscricao: { type: "string" as const, nullable: true, description: "Strictly in YYYY-MM-DD format, or null if not found. Busque atentamente a data final de encerramento das inscrições/envio de propostas." },
            criterios_eliminatorios: {
                type: "object" as const,
                properties: {
                    idade_minima_cnpj_anos: { type: "number" as const, nullable: true },
                    abrangencia_nacional: { type: "boolean" as const },
                    estados_permitidos: { type: "array" as const, items: { type: "string" as const }, description: "array of 2-letter UF strings (e.g., 'PB', 'SC') - empty if national without state restrictions" },
                    municipios_permitidos: { type: "array" as const, items: { type: "string" as const }, description: "array of strings (Format: 'Município - UF'). CRITICAL: Fill this if the PDF or its Annexes restrict participation to a specific list of municipalities. Leave empty if the entire state/country is eligible." },
                    natureza_juridica_excluida: { type: "array" as const, items: { type: "string" as const }, description: "array of strings (e.g., 'igreja', 'sindicato', 'fins lucrativos')" }
                },
                required: ["idade_minima_cnpj_anos", "abrangencia_nacional", "estados_permitidos", "municipios_permitidos", "natureza_juridica_excluida"]
            },
            financeiro: {
                type: "object" as const,
                properties: {
                    valor_maximo_ou_global_reais: { type: "number" as const, nullable: true, description: "Valor máximo por projeto. Se não houver, extraia o valor global/total do edital." },
                    exige_contrapartida: { type: "boolean" as const }
                },
                required: ["valor_maximo_ou_global_reais", "exige_contrapartida"]
            },
            burocracia_e_documentos: {
                type: "object" as const,
                properties: {
                    exige_cnd: { type: "boolean" as const },
                    exige_balanco_patrimonial: { type: "boolean" as const },
                    exige_cebas: { type: "boolean" as const },
                    exigencias_especificas_adicionais: { type: "array" as const, items: { type: "string" as const }, description: "array of strings for strict K.O. rules, e.g., 'Exige projeto aprovado no DOU via PRONON/PRONAS', 'Benefício exclusivo para moradores de SC'" }
                },
                required: ["exige_cnd", "exige_balanco_patrimonial", "exige_cebas", "exigencias_especificas_adicionais"]
            }
        },
        required: ["edital_id", "resumo_objetivo", "temas_principais", "prazo_de_inscricao", "criterios_eliminatorios", "financeiro", "burocracia_e_documentos"]
    }
};

async function generateContentWithRetry(model: any, promptData: any, maxRetries = 4) {
    let delay = 5000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await model.generateContent(promptData);
        } catch (error: any) {
            const isRateLimitOrUnavailable = error.status === 429 || error.status === 503 || error.message?.includes('503') || error.message?.includes('429') || error.message?.includes('high demand');
            if (isRateLimitOrUnavailable && attempt < maxRetries) {
                console.warn(`[Gemini API] Error ${error.status || error.message}. Retrying in ${delay}ms (Attempt ${attempt} of ${maxRetries})...`);
                await sleep(delay);
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
}

async function extractMetadataFromPdf(pdfData: ArrayBuffer, prosasSummaryText?: string): Promise<any> {
    const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash-lite",
        generationConfig: sharedGenerationConfig
    });

    const pdfBuffer = Buffer.from(pdfData);
    let extractedText = "";
    try {
        const parsedPdf = await pdfParse(pdfBuffer);
        extractedText = parsedPdf.text;
    } catch (err: any) {
        console.warn("pdf-parse failed to extract text, proceeding with Prosas summary text: " + err.message);
    }

    const combinedContext = prosasSummaryText
        ? `--- RESUMO DA PÁGINA PROSAS (FONTE OFICIAL ATUALIZADA DE PRAZOS E VALORES) ---\n${prosasSummaryText.substring(0, 2000)}\n\n--- TEXTO DO EDITAL (PDF) ---\n${extractedText}`
        : extractedText;

    const prompt = "Extract the strict bureaucratic criteria from this document according to the required JSON schema in Brazilian Portuguese.\n\n" + combinedContext;

    const result = await generateContentWithRetry(model, [prompt]);
    const text = result.response.text();
    return JSON.parse(text);
}

const DEFAULT_DRIVE_FOLDER_ID = process.env.GCP_DRIVE_FOLDER_ID || '1FIbNfAzFS7uMSF0iMIgy64tRWIIWhYOZ';
const FALLBACK_FOLDER_NAME = 'Triade_Editais_PDF';

let cachedDriveClient: ReturnType<typeof google.drive> | null = null;
let resolvedFolderId: string | null = null;
let existingDriveFilesMap: Map<string, string> | null = null;

function getDriveClient(): ReturnType<typeof google.drive> | null {
    if (cachedDriveClient) return cachedDriveClient;

    const credsEnv = process.env.GCP_DRIVE_CREDENTIALS;
    if (!credsEnv) {
        console.warn('GCP_DRIVE_CREDENTIALS is not set. Skipping Drive upload.');
        return null;
    }

    const credentials = JSON.parse(credsEnv);

    // 1. OAuth 2.0 Refresh Token (Personal Drive / "In Production" mode)
    const clientId = credentials.clientId || credentials.client_id;
    const clientSecret = credentials.clientSecret || credentials.client_secret;
    const refreshToken = credentials.refreshToken || credentials.refresh_token;

    if (clientId && clientSecret && refreshToken) {
        const auth = new google.auth.OAuth2(clientId, clientSecret);
        auth.setCredentials({ refresh_token: refreshToken });
        cachedDriveClient = google.drive({ version: 'v3', auth });
        return cachedDriveClient;
    }

    // 2. Service Account (Requires Google Workspace Shared Drive due to 0-byte consumer quota)
    if (credentials.client_email && credentials.private_key) {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive']
        });
        cachedDriveClient = google.drive({ version: 'v3', auth });
        return cachedDriveClient;
    }

    throw new Error('Invalid GCP_DRIVE_CREDENTIALS format: missing OAuth2 refreshToken or Service Account private_key.');
}

async function getOrCreateTargetFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
    if (resolvedFolderId) return resolvedFolderId;

    try {
        await drive.files.get({
            fileId: DEFAULT_DRIVE_FOLDER_ID,
            fields: 'id, name',
            supportsAllDrives: true
        });
        resolvedFolderId = DEFAULT_DRIVE_FOLDER_ID;
        return resolvedFolderId;
    } catch {
        // Folder not accessible (e.g. using non-sensitive drive.file scope).
        // Search for or create an app-owned folder.
        const searchRes = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${FALLBACK_FOLDER_NAME}' and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });

        if (searchRes.data.files && searchRes.data.files.length > 0 && searchRes.data.files[0].id) {
            resolvedFolderId = searchRes.data.files[0].id;
            return resolvedFolderId;
        }

        const createRes = await drive.files.create({
            requestBody: {
                name: FALLBACK_FOLDER_NAME,
                mimeType: 'application/vnd.google-apps.folder'
            },
            fields: 'id',
            supportsAllDrives: true
        });

        resolvedFolderId = createRes.data.id!;
        return resolvedFolderId;
    }
}

async function getExistingDriveFilesMap(drive: ReturnType<typeof google.drive>, folderId: string): Promise<Map<string, string>> {
    if (existingDriveFilesMap) return existingDriveFilesMap;
    existingDriveFilesMap = new Map<string, string>();
    try {
        let pageToken: string | undefined = undefined;
        do {
            const res: any = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'nextPageToken, files(id, name, webViewLink)',
                pageSize: 1000,
                pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true
            });
            for (const f of res.data.files || []) {
                if (f.name && f.webViewLink && !existingDriveFilesMap.has(f.name)) {
                    existingDriveFilesMap.set(f.name, f.webViewLink);
                }
            }
            pageToken = res.data.nextPageToken || undefined;
        } while (pageToken);
        console.log(`[Drive Index] Indexed ${existingDriveFilesMap.size} unique PDFs in Google Drive folder.`);
    } catch (err: any) {
        console.warn(`[Drive Index] Could not index existing Drive files: ${err.message}`);
    }
    return existingDriveFilesMap;
}

async function uploadPdfToDrive(pdfData: ArrayBuffer, fileName: string): Promise<string | null> {
    try {
        const drive = getDriveClient();
        if (!drive) return null;

        const folderId = await getOrCreateTargetFolder(drive);
        const filesMap = await getExistingDriveFilesMap(drive, folderId);

        // Deduplicate: if this PDF already exists in the Drive folder, reuse its link instead of creating a duplicate
        if (filesMap.has(fileName)) {
            const existingLink = filesMap.get(fileName)!;
            console.log(`Reusing existing Drive PDF for ${fileName}: ${existingLink}`);
            return existingLink;
        }

        const buffer = Buffer.from(pdfData);
        const stream = Readable.from(buffer);

        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId]
            },
            media: {
                mimeType: 'application/pdf',
                body: stream
            },
            fields: 'id, webViewLink',
            supportsAllDrives: true
        });

        if (response.data.webViewLink) {
            filesMap.set(fileName, response.data.webViewLink);
        }

        console.log(`Successfully uploaded ${fileName} to Drive. Link: ${response.data.webViewLink}`);
        return response.data.webViewLink || null;
    } catch (e: any) {
        console.error(`Failed to upload ${fileName} to Drive: ${e.message}`);
        return null;
    }
}

async function extractMetadataFromText(textContent: string): Promise<any> {
    const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash-lite",
        generationConfig: sharedGenerationConfig
    });

    const prompt = "Extract the strict bureaucratic criteria from this document according to the required JSON schema in Brazilian Portuguese.\n\n" + textContent;

    const result = await generateContentWithRetry(model, [prompt]);
    const text = result.response.text();
    return JSON.parse(text);
}

function applyAuthoritativeProsasMetadata(edital: any, metadata: any): boolean {
    let changed = false;
    const headerInfo = extractProsasHeaderInfo(edital.full_text);
    if (headerInfo.data_fim) {
        if (metadata.prazo_de_inscricao !== headerInfo.data_fim) {
            metadata.prazo_de_inscricao = headerInfo.data_fim;
            changed = true;
        }
        edital.attributes = edital.attributes || {};
        if (edital.attributes.data_inicio !== headerInfo.data_inicio || edital.attributes.data_fim !== headerInfo.data_fim) {
            edital.attributes.data_inicio = headerInfo.data_inicio;
            edital.attributes.data_fim = headerInfo.data_fim;
            changed = true;
        }
    }
    if (headerInfo.valor_total) {
        edital.attributes = edital.attributes || {};
        if (edital.attributes.valor_total !== headerInfo.valor_total) {
            edital.attributes.valor_total = headerInfo.valor_total;
            changed = true;
        }
        metadata.financeiro = metadata.financeiro || {};
        if (metadata.financeiro.valor_total_edital !== headerInfo.valor_total) {
            metadata.financeiro.valor_total_edital = headerInfo.valor_total;
            changed = true;
        }
        if (!metadata.financeiro.valor_maximo_ou_global_reais || metadata.financeiro.valor_maximo_ou_global_reais < 100) {
            metadata.financeiro.valor_maximo_ou_global_reais = headerInfo.valor_total;
            changed = true;
        }
    }
    return changed;
}

export async function processEditais() {
    let rawData: string;
    try {
        rawData = await fs.readFile(DATA_FILE, 'utf-8');
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            console.log('No editais file found.');
            return;
        }
        throw err;
    }

    let editais: any[];
    try {
        editais = JSON.parse(rawData);
    } catch (e) {
        console.error('Invalid JSON in data file.');
        return;
    }

    let processedCount = 0;
    let modified = false;
    const maxExtract = parseInt(process.env.MAX_EXTRACT || '15', 10);

    for (let i = 0; i < editais.length; i++) {
        const edital = editais[i];

        if (edital.pipeline_status === 'NEW_FROM_API' || edital.pipeline_status !== 'PENDING_EXTRACTION') {
            continue;
        }

        if (!edital.pdf_link && (!edital.full_text || edital.full_text.length <= 300)) {
            console.log(`Skipping edital ${edital.id || i} because it is not fully deep-scraped (no valid pdf_link or full_text)`);
            continue;
        }

        if (processedCount >= maxExtract) {
            console.log(`Reached MAX_EXTRACT limit of ${maxExtract}. Stopping.`);
            break;
        }

        let pdfLink = edital.pdf_link || edital.external_link;
        if (pdfLink && pdfLink.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)) {
            const driveMatch = pdfLink.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
            if (driveMatch) {
                pdfLink = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
            }
        }
        let useTextFallback = false;
        let downloadResult: { success: boolean, data?: ArrayBuffer, error?: string, skip?: boolean, notPdf?: boolean, expiredPresigned?: boolean, fallbackToText?: boolean } = { success: false, notPdf: true };

        if (!pdfLink) {
            console.log(`No PDF link provided for edital ${edital.id || i}. Will attempt text fallback.`);
            useTextFallback = true;
        } else {
            console.log(`Processing edital ${edital.id || i} - ${pdfLink}`);
            downloadResult = await downloadPdf(pdfLink);

            if (!downloadResult.success) {
                console.error(`Failed to download PDF for edital ${edital.id || i}: ${downloadResult.error}`);
                if (downloadResult.expiredPresigned) {
                    edital.retry_count = (edital.retry_count || 0) + 1;
                    if (edital.retry_count >= 3) {
                        edital.pipeline_status = 'FAILED_PERMANENTLY';
                        edital.last_error = downloadResult.error || "Max retries reached for expired presigned URL";
                        modified = true;
                        await fs.writeFile(DATA_FILE, JSON.stringify(editais, null, 2), 'utf-8');
                        continue;
                    }
                    edital.pipeline_status = 'NEW_FROM_API';
                    delete edital.pdf_link;
                    modified = true;
                    await fs.writeFile(DATA_FILE, JSON.stringify(editais, null, 2), 'utf-8');
                    continue;
                }
                if (downloadResult.skip) {
                    edital.pdf_skipped = true;
                    modified = true;
                }
                if (downloadResult.notPdf || downloadResult.fallbackToText) {
                    useTextFallback = true;
                }
            }
        }

        if (useTextFallback) {
            if (edital.full_text && edital.full_text.length > 300) {
                try {
                    const metadata = await extractMetadataFromText(edital.full_text);
                    metadata.edital_id = edital.id ? edital.id.toString() : String(i);
                    metadata.fonte_dados = "texto_pagina";
                    applyAuthoritativeProsasMetadata(edital, metadata);

                    edital.deep_metadata = metadata;
                    edital.pipeline_status = 'COMPLETED';
                    edital.last_error = undefined;
                    modified = true;
                    console.log(`Successfully extracted metadata for edital ${edital.id || i} via text fallback`);
                } catch (err: any) {
                    edital.retry_count = (edital.retry_count || 0) + 1;
                    edital.last_error = err.message;
                    if (edital.retry_count >= 3) {
                         edital.pipeline_status = 'FAILED_PERMANENTLY';
                    }
                    modified = true;
                }
                processedCount++;
            } else {
                edital.pipeline_status = 'FAILED_PERMANENTLY';
                edital.last_error = downloadResult.error || "No valid PDF or full_text available";
                modified = true;
                processedCount++;
            }
        } else if (downloadResult.success && downloadResult.data) {
            try {
                const editalId = edital.id ? edital.id.toString() : String(i);

                const fileName = `${editalId}_edital.pdf`;
                const driveLink = await uploadPdfToDrive(downloadResult.data, fileName);

                const metadata = await extractMetadataFromPdf(downloadResult.data, edital.full_text);
                metadata.edital_id = editalId;
                metadata.fonte_dados = "pdf";

                if (driveLink) {
                    metadata.drive_pdf_link = driveLink;
                }

                applyAuthoritativeProsasMetadata(edital, metadata);

                edital.deep_metadata = metadata;
                edital.pipeline_status = 'COMPLETED';
                edital.last_error = undefined;
                if (edital.full_text) {
                    edital.full_text = edital.full_text.substring(0, 2500);
                }
                modified = true;
                console.log(`Successfully extracted metadata for edital ${edital.id || i}`);
            } catch (err: any) {
                edital.retry_count = (edital.retry_count || 0) + 1;
                edital.last_error = err.message;
                if (edital.retry_count >= 3) {
                     edital.pipeline_status = 'FAILED_PERMANENTLY';
                }
                modified = true;
            }
            processedCount++;
        } else if (!downloadResult.success && !downloadResult.notPdf && !downloadResult.skip && !downloadResult.fallbackToText) {
            edital.retry_count = (edital.retry_count || 0) + 1;
            edital.last_error = downloadResult.error || "Unknown download error";
            if (edital.retry_count >= 3) {
                 edital.pipeline_status = 'FAILED_PERMANENTLY';
            }
            modified = true;
            processedCount++;
        } else if (downloadResult.skip) {
             if (edital.full_text && edital.full_text.length > 300) {
                 try {
                     const metadata = await extractMetadataFromText(edital.full_text);
                     metadata.edital_id = edital.id ? edital.id.toString() : String(i);
                     metadata.fonte_dados = "texto_pagina";
                     applyAuthoritativeProsasMetadata(edital, metadata);

                     edital.deep_metadata = metadata;
                     edital.pipeline_status = 'COMPLETED';
                     edital.last_error = undefined;
                     modified = true;
                 } catch (err: any) {
                     edital.retry_count = (edital.retry_count || 0) + 1;
                     edital.last_error = err.message;
                     if (edital.retry_count >= 3) {
                          edital.pipeline_status = 'FAILED_PERMANENTLY';
                     }
                     modified = true;
                 }
             } else {
                 edital.pipeline_status = 'FAILED_PERMANENTLY';
                 edital.last_error = downloadResult.error || "Skipped, and no text fallback available";
                 modified = true;
             }
             processedCount++;
        }

        if (modified) {
             await fs.writeFile(DATA_FILE, JSON.stringify(editais, null, 2), 'utf-8');
             modified = false;
        }

        if (processedCount % 10 === 0 && processedCount > 0 && processedCount < maxExtract) {
            console.log(`Processed ${processedCount} items. Sleeping for 65 seconds to avoid rate limits...`);
            await sleep(65000);
        }
    }

    // Retroactively enrich already-COMPLETED editais from Prosas header text before archiving expired ones
    for (const e of editais) {
        if (e.deep_metadata && e.full_text) {
            if (applyAuthoritativeProsasMetadata(e, e.deep_metadata)) {
                modified = true;
            }
        }
    }

    // Archive expired editais into editais_historico.json instead of deleting them
    const todayIso = new Date().toISOString().split('T')[0];
    const activeEditais: any[] = [];
    const newlyExpired: any[] = [];

    for (const e of editais) {
        const prazo = e.deep_metadata?.prazo_de_inscricao || e.attributes?.data_fim;
        if (prazo && prazo !== 'Não informado' && prazo < todayIso) {
            newlyExpired.push(e);
        } else {
            activeEditais.push(e);
        }
    }

    if (newlyExpired.length > 0) {
        let historico: any[] = [];
        try {
            const rawHist = await fs.readFile(ARCHIVE_FILE, 'utf-8');
            historico = JSON.parse(rawHist);
        } catch {
            historico = [];
        }

        const histMap = new Map<string, any>();
        for (const h of historico) {
            if (h && h.id) histMap.set(String(h.id), h);
        }

        for (const exp of newlyExpired) {
            const slimmed = {
                ...exp,
                full_text: exp.full_text ? exp.full_text.substring(0, 600) : undefined,
                archived_at: todayIso
            };
            histMap.set(String(exp.id), slimmed);
        }

        const updatedHistorico = Array.from(histMap.values());
        await fs.writeFile(ARCHIVE_FILE, JSON.stringify(updatedHistorico, null, 2), 'utf-8');
        console.log(`[Archive] Moved ${newlyExpired.length} expired editais to editais_historico.json (Total archived intelligence: ${updatedHistorico.length}).`);
        editais = activeEditais;
        modified = true;
    }

    // Re-link existing Drive PDFs and backfill missing ones for already-COMPLETED active editais (Zero Gemini API calls)
    if (process.env.GCP_DRIVE_CREDENTIALS) {
        const drive = getDriveClient();
        if (drive) {
            const folderId = await getOrCreateTargetFolder(drive);
            const filesMap = await getExistingDriveFilesMap(drive, folderId);

            // Step A: Instant re-link for editais whose PDF is already in the Drive folder
            let relinkedCount = 0;
            for (const e of editais) {
                if (e.deep_metadata && !e.deep_metadata.drive_pdf_link) {
                    const expectedName = `${e.id}_edital.pdf`;
                    if (filesMap.has(expectedName)) {
                        e.deep_metadata.drive_pdf_link = filesMap.get(expectedName);
                        relinkedCount++;
                        modified = true;
                    }
                }
            }
            if (relinkedCount > 0) {
                console.log(`[Drive Index] Instantly re-linked ${relinkedCount} existing PDFs from Google Drive to editais_prosas.json.`);
            }

            // Step B: Download & upload genuinely missing PDFs (up to 35 per run)
            let driveBackfillCount = 0;
            const maxBackfill = 35;
            for (const e of editais) {
                if (driveBackfillCount >= maxBackfill) break;
                if (
                    e.pipeline_status === 'COMPLETED' &&
                    e.deep_metadata &&
                    !e.deep_metadata.drive_pdf_link &&
                    e.pdf_link &&
                    !e.pdf_link.includes('amazonaws.com') &&
                    !e.drive_backfill_attempted
                ) {
                    let pdfUrl = e.pdf_link;
                    const driveMatch = pdfUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
                    if (driveMatch) {
                        pdfUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
                    }
                    console.log(`[Drive Backfill] Downloading & uploading missing PDF for completed edital ${e.id}...`);
                    const dl = await downloadPdf(pdfUrl);
                    e.drive_backfill_attempted = true;
                    modified = true;
                    if (dl.success && dl.data) {
                        const driveLink = await uploadPdfToDrive(dl.data, `${e.id}_edital.pdf`);
                        if (driveLink) {
                            e.deep_metadata.drive_pdf_link = driveLink;
                            driveBackfillCount++;
                        }
                    }
                }
            }
            if (driveBackfillCount > 0) {
                console.log(`[Drive Backfill] Uploaded ${driveBackfillCount} missing PDFs to Google Drive without calling Gemini.`);
            }
        }
    }

    if (modified) {
         await fs.writeFile(DATA_FILE, JSON.stringify(editais, null, 2), 'utf-8');
         modified = false;
    }

    console.log(`Finished processing. Total new items processed: ${processedCount}. Active editais in DB: ${editais.length}`);
}

if (import.meta.url.startsWith('file:') && import.meta.url === `file://${process.argv[1]}`) {
    processEditais().catch(console.error);
}
