import 'dotenv/config';
import fs from 'fs/promises';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google } from 'googleapis';
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

async function fetchAndParseDrivePDF(driveUrl: string): Promise<string | null> {
  const credsEnv = process.env.GCP_DRIVE_CREDENTIALS;
  if (!credsEnv) {
    console.warn('GCP_DRIVE_CREDENTIALS is not set. Skipping Drive PDF fetch.');
    return null;
  }

  // Extract File ID from webViewLink
  // usually looks like: https://drive.google.com/file/d/1ABC-DEF/view?usp=drivesdk
  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match || !match[1]) {
    console.warn(`Could not extract Drive file ID from URL: ${driveUrl}`);
    return null;
  }
  const fileId = match[1];

  try {
    console.log(`Downloading PDF from Google Drive (ID: ${fileId})...`);
    const credentials = JSON.parse(credsEnv);
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });

    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(response.data as ArrayBuffer);

    console.log('Parsing PDF from Drive...');
    const pdfData = await pdfParse(buffer);
    return pdfData.text;
  } catch (error) {
    console.error('Error fetching/parsing PDF from Drive:', error);
    return null;
  }
}

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
  let fetchedText: string | null = null;
  let useFallback = false;

  // Tier 1: Try Drive PDF first
  if (edital.deep_metadata?.drive_pdf_link) {
    console.log('Found Google Drive PDF link in deep_metadata. Attempting Tier 1 fetch...');
    fetchedText = await fetchAndParseDrivePDF(edital.deep_metadata.drive_pdf_link);
    if (!fetchedText || fetchedText.trim().length === 0) {
      console.log('Tier 1 (Drive PDF) failed or empty. Falling back to Tier 2...');
      fetchedText = null;
    }
  } else {
    console.log('No Google Drive PDF link found. Skipping Tier 1.');
  }

  // Tier 2: Try Original PDF Link
  if (!fetchedText && edital.pdf_link) {
    console.log('Attempting Tier 2 fetch (Original PDF link)...');
    fetchedText = await fetchAndParsePDF(edital.pdf_link);
    if (!fetchedText || fetchedText.trim().length === 0) {
      console.log('Tier 2 (Original PDF) failed or empty. Falling back to Tier 3 (full_text)...');
      fetchedText = null;
      useFallback = true;
    }
  } else if (!fetchedText) {
    console.log('No original PDF link found. Falling back to Tier 3 (full_text)...');
    useFallback = true;
  }

  // Set the resolved text
  if (fetchedText) {
    fullGrantText = fetchedText;
  } else if (useFallback) {
    if (edital.full_text) {
      fullGrantText = edital.full_text;
      console.log('Using Tier 3 (JSON full_text).');
    } else {
      console.error('All 3 tiers failed (Drive PDF, Original PDF, and full_text). Cannot proceed.');
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
