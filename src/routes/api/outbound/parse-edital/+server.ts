import { SchemaType } from '@google/generative-ai';
import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { env } from '$env/dynamic/private';

const sharedGenerationConfig = {
    responseMimeType: "application/json" as const,
    responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
            edital_id: { type: SchemaType.STRING },
            resumo_objetivo: { type: SchemaType.STRING, description: "1-2 sentences in pt-BR summarizing the grant's core goal" },
            temas_principais: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "array of strings in pt-BR (e.g., 'mulheres', 'agricultura familiar', 'cultura', 'saúde')" },
            prazo_de_inscricao: { type: SchemaType.STRING, nullable: true, description: "Strictly in YYYY-MM-DD format, or null if not found. Busque atentamente em todo o documento, frequentemente listado sob Cronograma ou Etapas." },
            criterios_eliminatorios: {
                type: SchemaType.OBJECT,
                properties: {
                    idade_minima_cnpj_anos: { type: SchemaType.NUMBER, nullable: true },
                    abrangencia_nacional: { type: SchemaType.BOOLEAN },
                    estados_permitidos: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "array of 2-letter UF strings (e.g., 'PB', 'SC') - empty if national without state restrictions" },
                    municipios_permitidos: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "array of strings (Format: 'Município - UF'). CRITICAL: Fill this if the PDF or its Annexes restrict participation to a specific list of municipalities. Leave empty if the entire state/country is eligible." },
                    natureza_juridica_excluida: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "array of strings (e.g., 'igreja', 'sindicato', 'fins lucrativos')" }
                },
                required: ["idade_minima_cnpj_anos", "abrangencia_nacional", "estados_permitidos", "municipios_permitidos", "natureza_juridica_excluida"]
            },
            financeiro: {
                type: SchemaType.OBJECT,
                properties: {
                    valor_maximo_ou_global_reais: { type: SchemaType.NUMBER, nullable: true, description: "Valor máximo por projeto. Se não houver, extraia o valor global/total do edital." },
                    exige_contrapartida: { type: SchemaType.BOOLEAN }
                },
                required: ["valor_maximo_ou_global_reais", "exige_contrapartida"]
            },
            burocracia_e_documentos: {
                type: SchemaType.OBJECT,
                properties: {
                    exige_cnd: { type: SchemaType.BOOLEAN },
                    exige_balanco_patrimonial: { type: SchemaType.BOOLEAN },
                    exige_cebas: { type: SchemaType.BOOLEAN },
                    exigencias_especificas_adicionais: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "array of strings for strict K.O. rules, e.g., 'Exige projeto aprovado no DOU via PRONON/PRONAS', 'Benefício exclusivo para moradores de SC'" }
                },
                required: ["exige_cnd", "exige_balanco_patrimonial", "exige_cebas", "exigencias_especificas_adicionais"]
            }
        },
        required: ["edital_id", "resumo_objetivo", "temas_principais", "prazo_de_inscricao", "criterios_eliminatorios", "financeiro", "burocracia_e_documentos"]
    }
};

export async function POST({ request }) {
  try {
    const { pdfUrl } = await request.json();
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing in Vercel environment');
    }
    const genAI = new GoogleGenerativeAI(apiKey);

    // Automatically convert Google Drive view links into direct download links
    let resolvedUrl = pdfUrl;
    const driveMatch = (pdfUrl || '').match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch && driveMatch[1]) {
      resolvedUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
    }

    let pdfData;
    try {
      const response = await fetch(resolvedUrl, {
        headers: {
          'User-Agent': 'TriadeMatchmaker/1.0'
        }
      });
      if (!response.ok) {
        throw new Error(`Falha ao baixar o PDF. HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer, 0, 4);
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
        throw new Error('A URL não retornou um arquivo PDF válido');
      }
      pdfData = Buffer.from(arrayBuffer);
    } catch (e: any) {
      throw new Error(`Falha no download do PDF: ${e.message}`);
    }

    let extractedText = '';
    try {
      const parsedPdf = await pdfParse(pdfData);
      extractedText = parsedPdf.text;
    } catch (err: any) {
      console.warn('pdf-parse failed to extract text: ' + err.message);
      throw new Error(`Falha ao extrair texto do PDF: ${err.message}`);
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash-lite',
      generationConfig: { ...sharedGenerationConfig, temperature: 0 }
    });

    const prompt = 'Extract the strict bureaucratic criteria from this document according to the required JSON schema in Brazilian Portuguese.\n\n' + extractedText.substring(0, 100000);

    const result = await model.generateContent(prompt);

    let parsedMetadata;
    try {
      parsedMetadata = JSON.parse(result.response.text());
    } catch {
      throw new Error('Falha ao analisar a resposta JSON do Gemini para o edital.');
    }

    const syntheticEdital = {
      id: `byoe_${Date.now()}`,
      titulo: `Edital Importado - ${parsedMetadata.temas_principais?.[0] || 'Novo'}`,
      external_link: pdfUrl,
      pdf_link: pdfUrl,
      resumo_objetivo: parsedMetadata.resumo_objetivo,
      temas_principais: parsedMetadata.temas_principais,
      prazo_de_inscricao: parsedMetadata.prazo_de_inscricao,
      valor_maximo_ou_global_reais: parsedMetadata.financeiro?.valor_maximo_ou_global_reais || null,
      deep_metadata: parsedMetadata
    };

    return json(syntheticEdital);

  } catch (error: any) {
    console.error(error);
    return json({ error: error.message }, { status: 500 });
  }
}
