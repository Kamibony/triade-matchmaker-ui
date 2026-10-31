import 'dotenv/config';
import fs from 'fs/promises';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const mockOSC = {
  nome: 'ASSOCIACAO QUILOMBOLA NEGROS FELICIANOS DO ALTO',
  idade_anos: 20,
  uf: 'RN',
  municipio: 'Portalegre',
  natureza_juridica: 'Associação Privada',
  foco_atividades: 'Atividades de associações de defesa de direitos sociais, assistência social, e organizações associativas ligadas à cultura e à arte.',
};

const TARGET_EDITAL_ID = '19545'; // Based on an item with a valid PDF link

async function fetchAndParsePDF(pdfUrl: string): Promise<string | null> {
  try {
    console.log(`Downloading PDF from ${pdfUrl}...`);
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log('Parsing PDF...');
    const pdfData = await pdfParse(buffer);
    return pdfData.text;
  } catch (error) {
    console.error('Error fetching/parsing PDF:', error);
    return null;
  }
}

async function main() {
  console.log(`--- Deep Dive & Action Plan for Edital ${TARGET_EDITAL_ID} ---`);

  if (!process.env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable.');
    process.exit(1);
  }

  // 1. Load the specific Edital
  const editaisData = JSON.parse(await fs.readFile('./src/data/editais_prosas.json', 'utf-8'));
  const edital = editaisData.find((e: any) => e.id === TARGET_EDITAL_ID);

  if (!edital) {
    console.error(`Edital with ID ${TARGET_EDITAL_ID} not found in database.`);
    process.exit(1);
  }

  // 2. Fetch PDF or Fallback to text
  let fullGrantText = '';
  let usedFallback = false;

  if (edital.pdf_link) {
    const pdfText = await fetchAndParsePDF(edital.pdf_link);
    if (pdfText && pdfText.trim().length > 0) {
      fullGrantText = pdfText;
    } else {
      console.log('PDF extraction failed or empty, falling back to JSON full_text.');
      usedFallback = true;
    }
  } else {
    console.log('No PDF link available, falling back to JSON full_text.');
    usedFallback = true;
  }

  if (usedFallback) {
    if (edital.full_text) {
      fullGrantText = edital.full_text;
    } else {
       console.error('Both PDF extraction and JSON full_text fallback failed. Cannot proceed.');
       process.exit(1);
    }
  }

  console.log(`\nSuccessfully loaded grant text (${fullGrantText.length} characters).`);

  // 3. Prepare the LLM Call
  console.log('\nAnalyzing with Gemini (Phase 3: Deep Dive)...');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });

  const prompt = `
You are a Senior Grant Consultant specializing in the Brazilian Third Sector (ONGs/OSCs).
Your task is to analyze the full text of a grant (Edital) and cross-reference it with the profile of a specific NGO to create a detailed action plan.

Here is the profile of the NGO (OSC):
${JSON.stringify(mockOSC, null, 2)}

Here is the ENTIRE text of the grant (Edital):
--- START OF GRANT TEXT ---
${fullGrantText}
--- END OF GRANT TEXT ---

Based strictly on the grant text provided above and the NGO's profile, generate a consulting report in valid JSON format.
The JSON must have the following exact structure:
{
  "missing_documents": [
    // Array of strings detailing specific compliance documents the OSC needs to prepare or check.
  ],
  "statute_requirements": [
    // Array of strings detailing specific clauses, changes, or focus areas that must be present in their 'Estatuto' (Bylaws) according to the rules of this edital.
  ],
  "project_ideas": [
    // Array of EXACTLY 3 objects containing project ideas highly tailored to the OSC's focus that have a strong chance of winning this specific edital.
    {
      "title": "Short title of the project",
      "description": "A brief description of how the project connects the OSC's profile with the edital's objectives."
    }
  ]
}

Return ONLY the raw JSON string. Do not include markdown blocks like \`\`\`json or any other text.
`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Clean up potential markdown formatting
    const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const report = JSON.parse(cleanedResponse);

    // 4. Output the results beautifully
    console.log('\n==================================================');
    console.log('         DEEP DIVE CONSULTING REPORT');
    console.log('==================================================\n');

    console.log('📄 MISSING / REQUIRED DOCUMENTS:');
    report.missing_documents.forEach((doc: string, index: number) => {
      console.log(`   ${index + 1}. ${doc}`);
    });

    console.log('\n⚖️  STATUTE (ESTATUTO) REQUIREMENTS:');
    report.statute_requirements.forEach((req: string, index: number) => {
      console.log(`   ${index + 1}. ${req}`);
    });

    console.log('\n💡 TAILORED PROJECT IDEAS:');
    report.project_ideas.forEach((idea: any, index: number) => {
      console.log(`   Project ${index + 1}: ${idea.title}`);
      console.log(`   Description: ${idea.description}\n`);
    });

    console.log('==================================================');

  } catch (error) {
    console.error('Error generating report with Gemini:', error);
  }
}

main().catch(console.error);
