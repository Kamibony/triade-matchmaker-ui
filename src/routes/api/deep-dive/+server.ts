import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google } from 'googleapis';

import editaisData from '../../../data/editais_prosas.json';

async function fetchAndParseDrivePDF(driveUrl: string): Promise<string | null> {
  const credsEnv = process.env.GCP_DRIVE_CREDENTIALS;
  if (!credsEnv) {
    console.warn('GCP_DRIVE_CREDENTIALS is not set. Skipping Drive PDF fetch.');
    return null;
  }

  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match || !match[1]) {
    console.warn(`Could not extract Drive file ID from URL: ${driveUrl}`);
    return null;
  }
  const fileId = match[1];

  try {
    const credentials = JSON.parse(credsEnv);
    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials({ refresh_token: credentials.refreshToken });

    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(response.data as ArrayBuffer);
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    console.error('Error fetching/parsing PDF from Drive:', error);
    return null;
  }
}

async function fetchAndParsePDF(pdfUrl: string): Promise<string | null> {
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      console.warn(`Failed to fetch PDF from ${pdfUrl}: ${response.statusText}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    console.error('Error fetching/parsing direct PDF:', error);
    return null;
  }
}

export async function POST({ request }: any) {
  const { edital_id, oscProfile, dossier_text } = await request.json();

  if (!process.env.GEMINI_API_KEY) {
    return json({ error: 'Missing GEMINI_API_KEY' }, { status: 500 });
  }

  const edital = (editaisData as any[]).find(e => String(e.id) === String(edital_id));

  if (!edital) {
    return json({ error: 'Edital not found' }, { status: 404 });
  }

  let fullGrantText = '';
  let fetchedText: string | null = null;
  let useFallback = false;

  if (edital.deep_metadata?.drive_pdf_link) {
    fetchedText = await fetchAndParseDrivePDF(edital.deep_metadata.drive_pdf_link);
    if (!fetchedText || fetchedText.trim().length === 0) {
      fetchedText = null;
    }
  }

  if (!fetchedText && edital.pdf_link) {
    fetchedText = await fetchAndParsePDF(edital.pdf_link);
    if (!fetchedText || fetchedText.trim().length === 0) {
      fetchedText = null;
      useFallback = true;
    }
  } else if (!fetchedText) {
    useFallback = true;
  }

  if (fetchedText) {
    fullGrantText = fetchedText;
  } else if (useFallback) {
    if (edital.full_text) {
      fullGrantText = edital.full_text;
    } else {
      return json({ error: 'All 3 tiers failed to extract grant text' }, { status: 500 });
    }
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json'
    }
  });

  const prompt = `
You are a Senior Grant Consultant specializing in the Brazilian Third Sector (ONGs/OSCs).
Your task is to analyze the full text of a grant (Edital) and cross-reference it with the complete profile of a specific NGO to create a detailed action plan in Brazilian Portuguese (pt-BR).

Here is the complete profile of the NGO (OSC):
${JSON.stringify(oscProfile, null, 2)}

Here is the extended Web Dossier of the NGO (if available):
${dossier_text || 'Not provided'}
If provided, use these rich contextual details (recent projects, specific focus areas, partnerships) to make the 'project_ideas' highly tailored and specific to their actual real-world operations.

Here is the text of the grant (Edital):
--- START OF GRANT TEXT ---
${fullGrantText.slice(0, 60000)}
--- END OF GRANT TEXT ---

Based strictly on the grant text provided above and the NGO's profile, generate a consulting report in valid JSON format (in Brazilian Portuguese):
{
  "executive_summary": "A 2-3 sentence overview in pt-BR explaining what the edital is about, its value/deadline, and why it fits this NGO.",
  "missing_documents": [
    "Specific compliance documents the OSC needs to prepare or check (in pt-BR)."
  ],
  "statute_requirements": [
    "Specific clauses, changes, or focus areas that must be present in their 'Estatuto' (Bylaws) according to the rules of this edital (in pt-BR)."
  ],
  "project_ideas": [
    {
      "title": "Short title of the project (in pt-BR)",
      "description": "A brief description of how the project connects the OSC's real activities/CNAE/Dossier with the edital's objectives (in pt-BR)."
    }
  ]
}`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const report = JSON.parse(cleanedResponse);

    return json(report);
  } catch (error) {
    console.error('Error generating report with Gemini:', error);
    return json({ error: 'Error generating report' }, { status: 500 });
  }
}
