import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- Types ---
interface OSC {
  id: number;
  cnpj: string;
  nome: string;
  uf: string;
  municipio: string;
  natureza_juridica: string;
  ano_fundacao: number;
  cnae_primario_descricao: string;
  cnae_secundario_descricao: string;
  [key: string]: any;
}

interface MatchResult {
  osc: OSC;
  score: number;
  motivo_match: string;
  whatsapp_message: string;
}

// --- Configuration ---
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'local_oscs.db');
const OUTPUT_FILE = path.join(process.cwd(), 'outbound_leads_edital_X.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is not set in the environment.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash-lite',
  generationConfig: { temperature: 0 },
});

// --- Constants & Setup ---
// In a real scenario, this edital criteria would be dynamic or loaded from a config
const EDITAL_CRITERIA = {
  id: 'edital_example_1',
  titulo: 'Edital de Fomento à Cultura e Educação',
  resumo_objetivo: 'Apoiar projetos que promovam a cultura e educação em comunidades vulneráveis, com foco em jovens e mulheres.',
  temas_principais: ['Cultura', 'Educação', 'Juventude', 'Mulheres'],
  ko_criteria: {
    uf_permitidas: ['SP', 'RJ', 'MG', 'BA'],
    naturezas_juridicas_proibidas: ['Órgão Público', 'Empresa Privada'],
    idade_minima_anos: 2
  }
};

const currentYear = new Date().getFullYear();

async function runPipeline() {
  console.log(`Starting Outbound Matchmaking Pipeline for Edital: ${EDITAL_CRITERIA.titulo}`);

  // Phase 1: Zero-Cost Broad Filter (DB Query)
  console.log('\n--- Phase 1: Zero-Cost Broad Filter ---');
  let db: Database.Database;
  try {
    db = new Database(DB_PATH, { fileMustExist: true });
    console.log(`Connected to SQLite database at ${DB_PATH}`);
  } catch (err) {
    console.error(`Failed to connect to database at ${DB_PATH}. Ensure the database file exists.`);
    console.error(err);
    process.exit(1);
  }

  // Construct query based on KO Criteria (using parameterized queries)
  const ufPlaceholders = EDITAL_CRITERIA.ko_criteria.uf_permitidas.map(() => '?').join(',');
  const naturezasProibidasPlaceholders = EDITAL_CRITERIA.ko_criteria.naturezas_juridicas_proibidas.map(() => '?').join(',');

  const query = `
    SELECT * FROM oscs
    WHERE uf IN (${ufPlaceholders})
    AND (cast(${currentYear} as integer) - ano_fundacao) >= ?
    AND natureza_juridica NOT IN (${naturezasProibidasPlaceholders})
    LIMIT 1000
  `;

  console.log(`Executing broad filter query...`);
  const stmt = db.prepare(query);
  const broadFilterResults = stmt.all(
    ...EDITAL_CRITERIA.ko_criteria.uf_permitidas,
    EDITAL_CRITERIA.ko_criteria.idade_minima_anos,
    ...EDITAL_CRITERIA.ko_criteria.naturezas_juridicas_proibidas
  ) as OSC[];
  console.log(`Phase 1 complete. Found ${broadFilterResults.length} initial matches.`);

  if (broadFilterResults.length === 0) {
    console.log("No OSCs found matching the broad criteria. Exiting.");
    process.exit(0);
  }

  // Phase 2: Zero-Cost Heuristic Pre-Ranking
  console.log('\n--- Phase 2: Zero-Cost Heuristic Pre-Ranking ---');
  const targetKeywords = ['cultura', 'educação', 'ensino', 'arte', 'mulher', 'jovem', 'juventude', 'social', 'desenvolvimento'];

  // Score OSCs based on keyword hits in CNAE descriptions
  const scoredOscs = broadFilterResults.map(osc => {
    let heuristicScore = 0;
    const combinedText = `${osc.cnae_primario_descricao} ${osc.cnae_secundario_descricao}`.toLowerCase();

    targetKeywords.forEach(kw => {
      if (combinedText.includes(kw)) {
        heuristicScore += 10;
      }
    });

    // Slight bonus for older, potentially more established NGOs
    const age = currentYear - osc.ano_fundacao;
    heuristicScore += Math.min(age, 20); // Cap age bonus

    return { osc, heuristicScore };
  });

  // Sort by heuristic score descending and take Top 50
  scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const top50 = scoredOscs.slice(0, 50).map(item => item.osc);
  console.log(`Phase 2 complete. Pre-ranked down to ${top50.length} OSCs.`);

  // Phase 3: Paid AI Processing (Dossier & Match)
  console.log('\n--- Phase 3: Paid AI Processing (AI Match) ---');
  const finalMatches: MatchResult[] = [];

  // Function to add sleep delay
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (let i = 0; i < top50.length; i++) {
    const osc = top50[i];
    console.log(`[${i + 1}/${top50.length}] Evaluating OSC: ${osc.nome} (${osc.municipio}-${osc.uf})`);

    // Construct search query forcefully appending municipio and UF to avoid generic name hallucination
    const searchQuery = `${osc.nome} ${osc.municipio} ${osc.uf}`;

    const prompt = `
You are a senior grant consultant ('captador de recursos'). Your task is to evaluate a specific Non-Governmental Organization (NGO/OSC) against a specific grant (Edital) and determine if they are a strong match.

**The Grant (Edital) Context:**
Title: ${EDITAL_CRITERIA.titulo}
Objective: ${EDITAL_CRITERIA.resumo_objetivo}
Themes: ${EDITAL_CRITERIA.temas_principais.join(', ')}

**The NGO (OSC) Profile:**
Name: ${osc.nome}
Location: ${osc.municipio}, ${osc.uf}
Nature: ${osc.natureza_juridica}
Founded: ${osc.ano_fundacao}
Primary Activity (CNAE): ${osc.cnae_primario_descricao}
Secondary Activity (CNAE): ${osc.cnae_secundario_descricao}

Use the Google Search Grounding tool to search for: "${searchQuery}". This will help you find recent projects, social media presence, or website information to build a stronger context about what this NGO actually does.
*Note: Make absolutely sure the search results you use belong to the NGO in ${osc.municipio}, ${osc.uf} and not a different NGO with a similar name.*

Based on the profile and the grounded search information, provide an evaluation.

Return ONLY a valid JSON object containing:
- "score": A number between 0 and 100 representing how well the NGO matches the grant's objective and themes.
- "motivo_match": A brief 1-2 sentence justification for the score, citing specific evidence from their activities or grounded search.
- "whatsapp_message": A short, professional, and personalized outreach message (in Portuguese) from 'Angela' (the captador) to the NGO, suggesting they might be a great fit for the "${EDITAL_CRITERIA.titulo}" grant and asking if they are open to a conversation. Keep it friendly and concise.

Do not include markdown formatting (like \`\`\`json). Just return the raw JSON object.
`;

    // Exponential backoff retry loop for Gemini API calls
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;

    while (attempt < maxAttempts && !success) {
      try {
        // Prepare the request with search grounding
        const result = await model.generateContent({
           contents: [{ role: 'user', parts: [{ text: prompt }] }],
           tools: [{ googleSearch: {} }] // Add Google Search Grounding
        });

        const responseText = result.response.text().trim();
        const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
        const aiResult = JSON.parse(cleanedResponse);

        finalMatches.push({
          osc,
          score: aiResult.score || 0,
          motivo_match: aiResult.motivo_match || 'Evaluation failed.',
          whatsapp_message: aiResult.whatsapp_message || 'Outreach message failed.'
        });

        console.log(`   -> AI Score: ${aiResult.score}`);
        success = true;
      } catch (error: any) {
        attempt++;
        console.error(`   -> Attempt ${attempt} failed:`, error.message);
        if (attempt >= maxAttempts) {
           console.error(`   -> Max attempts reached for ${osc.nome}. Skipping.`);
        } else {
           const backoffDelay = Math.pow(2, attempt) * 1000;
           console.log(`   -> Retrying in ${backoffDelay}ms...`);
           await sleep(backoffDelay);
        }
      }
    }

    // Crucial: 4000ms delay between OSCs to respect the 15 RPM Free Tier limit
    if (i < top50.length - 1) {
      console.log(`   -> Sleeping 4000ms to respect rate limits...`);
      await sleep(4000);
    }
  }

  // Phase 4: Delivery (Sort, Filter Top 10, and Save)
  console.log('\n--- Phase 4: Delivery ---');
  finalMatches.sort((a, b) => b.score - a.score);
  const top10 = finalMatches.slice(0, 10);

  try {
      await fs.writeFile(OUTPUT_FILE, JSON.stringify(top10, null, 2), 'utf-8');
      console.log(`Pipeline complete. Top ${top10.length} matches saved to ${OUTPUT_FILE}`);
  } catch (error) {
      console.error(`Failed to write output file:`, error);
  }
}

runPipeline().catch(console.error);
