import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'node:fs/promises';
import path from 'node:path';

// Load environment variables if available or assume it's passed directly to the script
const apiKey = process.env.GEMINI_API_KEY || '';
if (!apiKey) {
    console.warn('GEMINI_API_KEY is not set. Execution will fail if API is called.');
}

const genAI = new GoogleGenerativeAI(apiKey);

export async function downloadPdf(url: string): Promise<{ success: boolean, data?: ArrayBuffer, error?: string, skip?: boolean }> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return { success: false, error: `HTTP Error: ${response.status}` };
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 15 * 1024 * 1024) {
            return { success: false, skip: true, error: 'File too large (> 15MB)' };
        }

        const data = await response.arrayBuffer();

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

async function extractMetadataFromPdf(pdfData: ArrayBuffer): Promise<any> {
    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "object",
                properties: {
                    edital_id: { type: "string" },
                    criterios_eliminatorios: {
                        type: "object",
                        properties: {
                            idade_minima_cnpj_anos: { type: "number", nullable: true },
                            estados_permitidos: { type: "array", items: { type: "string" } },
                            natureza_juridica_excluida: { type: "array", items: { type: "string" } }
                        },
                        required: ["idade_minima_cnpj_anos", "estados_permitidos", "natureza_juridica_excluida"]
                    },
                    financeiro: {
                        type: "object",
                        properties: {
                            valor_maximo_reais: { type: "number", nullable: true },
                            exige_contrapartida: { type: "boolean" }
                        },
                        required: ["valor_maximo_reais", "exige_contrapartida"]
                    },
                    burocracia_e_documentos: {
                        type: "object",
                        properties: {
                            exige_cnd: { type: "boolean" },
                            exige_balanco_patrimonial: { type: "boolean" },
                            exige_cebas: { type: "boolean" },
                            exigencias_especificas_adicionais: { type: "array", items: { type: "string" } }
                        },
                        required: ["exige_cnd", "exige_balanco_patrimonial", "exige_cebas", "exigencias_especificas_adicionais"]
                    }
                },
                required: ["edital_id", "criterios_eliminatorios", "financeiro", "burocracia_e_documentos"]
            }
        }
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

    for (let i = 0; i < editais.length; i++) {
        const edital = editais[i];

        if (edital.deep_metadata || edital.pdf_error) {
            continue;
        }

        const pdfLink = edital.pdf_link || edital.external_link;
        if (!pdfLink) {
            console.log(`Skipping edital ${edital.id || i}: No link provided.`);
            continue;
        }

        console.log(`Processing edital ${edital.id || i} - ${pdfLink}`);
        const downloadResult = await downloadPdf(pdfLink);

        if (!downloadResult.success) {
            console.error(`Failed to download PDF for edital ${edital.id || i}: ${downloadResult.error}`);
            edital.pdf_error = true;
            if (downloadResult.skip) {
                edital.pdf_skipped = true;
            }
            modified = true;
        } else if (downloadResult.data) {
            try {
                const metadata = await extractMetadataFromPdf(downloadResult.data);

                // Override the id just in case AI hallucinated it
                metadata.edital_id = edital.id ? edital.id.toString() : String(i);

                edital.deep_metadata = metadata;
                modified = true;
                console.log(`Successfully extracted metadata for edital ${edital.id || i}`);
            } catch (err: any) {
                console.error(`Failed to extract metadata for edital ${edital.id || i}: ${err.message}`);
                edital.pdf_error = true; // Mark as error so we don't retry endlessly
                modified = true;
            }
        }

        processedCount++;

        // Save progress after each item (or you could do it at the end)
        if (modified) {
             await fs.writeFile(DATA_FILE, JSON.stringify(editais, null, 2), 'utf-8');
             modified = false;
        }

        // Rate limit: pause for 65 seconds after every 10 PDFs processed
        if (processedCount % 10 === 0) {
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
