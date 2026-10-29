import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

// Load environment variables if available or assume it's passed directly to the script
const apiKey = process.env.GEMINI_API_KEY || '';
if (!apiKey) {
    console.warn('GEMINI_API_KEY is not set. Execution will fail if API is called.');
}

const genAI = new GoogleGenerativeAI(apiKey);

export async function downloadPdf(url: string): Promise<{ success: boolean, data?: ArrayBuffer, error?: string, skip?: boolean, notPdf?: boolean }> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return { success: false, error: `HTTP Error: ${response.status}` };
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            return { success: false, notPdf: true, error: 'URL did not return a valid PDF binary' };
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 15 * 1024 * 1024) {
            return { success: false, skip: true, error: 'File too large (> 15MB)' };
        }

        const data = await response.arrayBuffer();

        // Check magic bytes
        if (data.byteLength >= 4) {
            const bytes = new Uint8Array(data, 0, 4);
            if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
                return { success: false, notPdf: true, error: 'URL did not return a valid PDF binary' };
            }
        } else {
            return { success: false, notPdf: true, error: 'URL did not return a valid PDF binary' };
        }

        // Double check size after download just in case content-length was missing/wrong
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

const sharedGenerationConfig = {
    responseMimeType: "application/json" as const,
    responseSchema: {
        type: "object" as const,
        properties: {
            edital_id: { type: "string" as const },
            resumo_objetivo: { type: "string" as const, description: "1-2 sentences in pt-BR summarizing the grant's core goal" },
            temas_principais: { type: "array" as const, items: { type: "string" as const }, description: "array of strings in pt-BR (e.g., 'mulheres', 'agricultura familiar', 'cultura', 'saúde')" },
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
                    valor_maximo_reais: { type: "number" as const, nullable: true },
                    exige_contrapartida: { type: "boolean" as const }
                },
                required: ["valor_maximo_reais", "exige_contrapartida"]
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
        required: ["edital_id", "resumo_objetivo", "temas_principais", "criterios_eliminatorios", "financeiro", "burocracia_e_documentos"]
    }
};

async function extractMetadataFromPdf(pdfData: ArrayBuffer): Promise<any> {
    const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash-lite",
        generationConfig: sharedGenerationConfig
    });

    const prompt = "Extract the strict bureaucratic criteria from this document according to the required JSON schema in Brazilian Portuguese.";

    const result = await model.generateContent([
        {
            inlineData: {
                data: Buffer.from(pdfData).toString("base64"),
                mimeType: "application/pdf"
            }
        },
        prompt
    ]);

    const text = result.response.text();
    return JSON.parse(text);
}



async function uploadPdfToDrive(pdfData: ArrayBuffer, fileName: string): Promise<string | null> {
    const credsEnv = process.env.GCP_DRIVE_CREDENTIALS;
    if (!credsEnv) {
        console.warn('GCP_DRIVE_CREDENTIALS is not set. Skipping Drive upload.');
        return null;
    }

    try {
        const credentials = JSON.parse(credsEnv);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });

        const drive = google.drive({ version: 'v3', auth });

        // Convert ArrayBuffer to Buffer, then to a Readable stream for Google APIs
        const { Readable } = require('stream');
        const buffer = Buffer.from(pdfData);
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);

        const fileMetadata = {
            name: fileName,
            parents: ['1FIbNfAzFS7uMSF0iMIgy64tRWIIWhYOZ']
        };

        const media = {
            mimeType: 'application/pdf',
            body: stream
        };

        const response = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, webViewLink'
        });

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

    const result = await model.generateContent([
        prompt
    ]);

    const text = result.response.text();
    return JSON.parse(text);
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

        if (edital.pipeline_status !== 'PENDING_EXTRACTION') {
            continue;
        }

        if (processedCount >= maxExtract) {
            console.log(`Reached MAX_EXTRACT limit of ${maxExtract}. Stopping.`);
            break;
        }

        const pdfLink = edital.pdf_link || edital.external_link;
        let useTextFallback = false;
        let downloadResult: { success: boolean, data?: ArrayBuffer, error?: string, skip?: boolean, notPdf?: boolean } = { success: false, notPdf: true };

        if (!pdfLink) {
            console.log(`No PDF link provided for edital ${edital.id || i}. Will attempt text fallback.`);
            useTextFallback = true;
        } else {
            console.log(`Processing edital ${edital.id || i} - ${pdfLink}`);
            downloadResult = await downloadPdf(pdfLink);

            if (!downloadResult.success) {
                console.error(`Failed to download PDF for edital ${edital.id || i}: ${downloadResult.error}`);
                if (downloadResult.skip) {
                    edital.pdf_skipped = true;
                    modified = true;
                }
                if (downloadResult.notPdf) {
                    console.log(`URL for edital ${edital.id || i} was not a valid PDF. Will attempt text fallback.`);
                    useTextFallback = true;
                }
            }
        }

        if (useTextFallback) {
            if (edital.full_text && edital.full_text.length > 300) {
                console.log(`Attempting text fallback extraction for edital ${edital.id || i}`);
                try {
                    const metadata = await extractMetadataFromText(edital.full_text);
                    metadata.edital_id = edital.id ? edital.id.toString() : String(i);
                    metadata.fonte_dados = "texto_pagina";

                    edital.deep_metadata = metadata;
                    edital.pipeline_status = 'COMPLETED';
                    if (edital.full_text) {
                        edital.full_text = edital.full_text.substring(0, 2500); // Data Slimming
                    }
                    modified = true;
                    console.log(`Successfully extracted metadata for edital ${edital.id || i} via text fallback`);
                } catch (err: any) {
                    console.error(`Failed to extract metadata via text fallback for edital ${edital.id || i}: ${err.message}`);
                    edital.retry_count = (edital.retry_count || 0) + 1;
                    edital.last_error = err.message;
                    if (edital.retry_count >= 3) {
                         edital.pipeline_status = 'FAILED_PERMANENTLY';
                    }
                    modified = true;
                }
                processedCount++;
            } else {
                console.log(`Text fallback not possible for edital ${edital.id || i} (full_text missing or too short).`);
                edital.pipeline_status = 'FAILED_PERMANENTLY';
                edital.last_error = downloadResult.error || "No valid PDF or full_text available";
                modified = true;
                // We still count this as an attempt
                processedCount++;
            }
        } else if (downloadResult.success && downloadResult.data) {
            try {
                const editalId = edital.id ? edital.id.toString() : String(i);

                // Upload to Google Drive
                const fileName = `${editalId}_edital.pdf`;
                const driveLink = await uploadPdfToDrive(downloadResult.data, fileName);

                if (process.env.GCP_DRIVE_CREDENTIALS && !driveLink) {
                    throw new Error("Failed to upload to Google Drive");
                }

                const metadata = await extractMetadataFromPdf(downloadResult.data);
                metadata.edital_id = editalId;
                metadata.fonte_dados = "pdf";

                if (driveLink) {
                    metadata.drive_pdf_link = driveLink;
                }

                edital.deep_metadata = metadata;
                edital.pipeline_status = 'COMPLETED';
                if (edital.full_text) {
                    edital.full_text = edital.full_text.substring(0, 2500); // Data Slimming
                }
                modified = true;
                console.log(`Successfully extracted metadata for edital ${edital.id || i}`);
            } catch (err: any) {
                console.error(`Failed to extract metadata (or Drive upload failed) for edital ${edital.id || i}: ${err.message}`);
                edital.retry_count = (edital.retry_count || 0) + 1;
                edital.last_error = err.message;
                if (edital.retry_count >= 3) {
                     edital.pipeline_status = 'FAILED_PERMANENTLY';
                }
                modified = true;
            }
            processedCount++;
        } else if (!downloadResult.success && !downloadResult.notPdf && !downloadResult.skip) {
            // General download failure (e.g. timeout, 404)
            edital.retry_count = (edital.retry_count || 0) + 1;
            edital.last_error = downloadResult.error || "Unknown download error";
            if (edital.retry_count >= 3) {
                 edital.pipeline_status = 'FAILED_PERMANENTLY';
            }
            modified = true;
            processedCount++;
        } else if (downloadResult.skip) {
             // Handle skipped files (like too large) - fallback to text or fail
             if (edital.full_text && edital.full_text.length > 300) {
                 try {
                     const metadata = await extractMetadataFromText(edital.full_text);
                     metadata.edital_id = edital.id ? edital.id.toString() : String(i);
                     metadata.fonte_dados = "texto_pagina";

                     edital.deep_metadata = metadata;
                     edital.pipeline_status = 'COMPLETED';
                     if (edital.full_text) {
                         edital.full_text = edital.full_text.substring(0, 2500);
                     }
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

        // Save progress after each item (or you could do it at the end)
        if (modified) {
             await fs.writeFile(DATA_FILE, JSON.stringify(editais, null, 2), 'utf-8');
             modified = false;
        }

        // Rate limit: pause for 65 seconds after every 10 PDFs processed
        if (processedCount % 10 === 0 && processedCount > 0 && processedCount < maxExtract) {
            console.log(`Processed ${processedCount} items. Sleeping for 65 seconds to avoid rate limits...`);
            await sleep(65000);
        }
    }

    console.log(`Finished processing. Total new items processed: ${processedCount}`);
}

// Run the script if executed directly
if (import.meta.url.startsWith('file:') && import.meta.url === `file://${process.argv[1]}`) {
    processEditais().catch(console.error);
}
