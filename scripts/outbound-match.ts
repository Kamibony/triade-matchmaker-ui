import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- Types ---
interface OSC {
  cnpj: string;
  nome: string;
  uf: string;
  municipio: string;
  natureza_juridica: string;
  ano_fundacao: number;
  cnae_primario_descricao: string;
  cnae_secundario_descricao: string;
  situacao_cadastral: string;
}

interface CacheEntry {
  osc: OSC;
  last_checked_date: string;
}

interface MatchResult {
  osc: OSC;
  score: number;
  motivo_match: string;
  whatsapp_message: string;
}

// --- Configuration ---
const CACHE_PATH = path.join(process.cwd(), 'src', 'data', 'cnpj_cache.json');
const OUTPUT_FILE = path.join(process.cwd(), 'outbound_leads_edital_test.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// if (!GEMINI_API_KEY || GEMINI_API_KEY === 'dummy') {
//   console.error("Error: A valid GEMINI_API_KEY is required in the environment.");
//   process.exit(1);
// }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');
const model = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash-lite',
  generationConfig: { temperature: 0 },
});

// --- Target Configuration (Hardcoded for POC) ---
const TARGET_UF = 'BA'; // Test with Bahia
const TARGET_MUNICIPALITY_NAME = 'Salvador';

const EDITAL_CRITERIA = {
  id: 'edital_example_1',
  titulo: 'Edital de Fomento à Cultura e Educação',
  resumo_objetivo: 'Apoiar projetos que promovam a cultura e educação em comunidades vulneráveis, com foco em jovens e mulheres.',
  temas_principais: ['Cultura', 'Educação', 'Juventude', 'Mulheres'],
  ko_criteria: {
    naturezas_juridicas_proibidas: ['Órgão Público', 'Empresa Privada'],
    idade_minima_anos: 2
  }
};

const currentYear = new Date().getFullYear();

// Helper: Sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchFromIpea(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`IPEA API error: ${response.status} - ${url}`);
    }
    return await response.json();
}

async function fetchBrasilAPIWithBackoff(cnpj: string): Promise<any> {
    const url = `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`;
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'TriadeMatchmaker/1.0'
                }
            });
            if (response.status === 404) return null; // Not found
            if (!response.ok) throw new Error(`BrasilAPI error: ${response.status}`);
            return await response.json();
        } catch (error: any) {
            attempt++;
            console.warn(`BrasilAPI fetch failed for CNPJ ${cnpj} (Attempt ${attempt}): ${error.message}`);
            if (attempt >= maxAttempts) return null;
            await sleep(Math.pow(2, attempt) * 1000);
        }
    }
    return null;
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
    try {
        await fs.access(CACHE_PATH);
        const data = await fs.readFile(CACHE_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {}; // Return empty if doesn't exist
    }
}

async function saveCache(cache: Record<string, CacheEntry>) {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

async function runPipeline() {
  console.log(`Starting JIT Outbound Matchmaking Pipeline for Edital: ${EDITAL_CRITERIA.titulo}`);

  // 1. Fetch Municipality ID from IPEA
  console.log(`\n--- Fetching IPEA Municipality ID for ${TARGET_MUNICIPALITY_NAME} ---`);
  let edmu_cd_municipio;
  try {
      const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/${TARGET_MUNICIPALITY_NAME}`);
      if (!muniData || muniData.length === 0) {
          throw new Error("Municipality not found in IPEA API");
      }
      edmu_cd_municipio = muniData[0].edmu_cd_municipio;
      console.log(`Found Municipality ID: ${edmu_cd_municipio}`);
  } catch(e: any) {
      console.error(e.message);
      process.exit(1);
  }

  // 2. Fetch OSCs by Municipality
  console.log(`\n--- Fetching OSCs for Municipality ID ${edmu_cd_municipio} ---`);
  let ipeaOscs = [];
  try {
      ipeaOscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${edmu_cd_municipio}`);
      console.log(`Found ${ipeaOscs.length} total OSCs in region.`);
  } catch(e: any) {
      console.error(e.message);
      process.exit(1);
  }

  // We don't want to process all of them for a POC, so we'll take a subset.
  // Actually, we need their CNPJs first to use the cache. Getting the CNPJ requires one call per OSC.
  // Let's cap the IPEA CNPJ fetches to 100 to save time.
  const sampleSize = Math.min(100, ipeaOscs.length);
  console.log(`\n--- Fetching CNPJs for up to ${sampleSize} OSCs ---`);

  const rawCnpjs = [];
  for(let i = 0; i < sampleSize; i++) {
      const osc = ipeaOscs[i];
      try {
          const headerData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${osc.id_osc}`);
          if (headerData && headerData.cd_identificador_osc) {
               // Ensure 14 digits padding if necessary, but it should be 14
               let cnpj = String(headerData.cd_identificador_osc).padStart(14, '0');
               rawCnpjs.push(cnpj);
          }
      } catch (e) {
          // just ignore errors for single items
      }
  }
  console.log(`Successfully retrieved ${rawCnpjs.length} CNPJs.`);

  // 3. Load Cache
  const cache = await loadCache();
  const enrichedOscs: OSC[] = [];
  let apiCalls = 0;

  console.log(`\n--- Phase 1: JIT Enrichment & Filtering ---`);
  for (const cnpj of rawCnpjs) {
      const cached = cache[cnpj];
      const now = new Date().toISOString();

      let oscData: OSC | null = null;

      if (cached) {
          // Use cached data
          oscData = cached.osc;
      } else {
          // Fetch from BrasilAPI
          apiCalls++;
          const bApiData = await fetchBrasilAPIWithBackoff(cnpj);
          if (bApiData && bApiData.descricao_situacao_cadastral === 'ATIVA') {
              const ano_fundacao = parseInt(bApiData.data_inicio_atividade.split('-')[0], 10);

              oscData = {
                  cnpj,
                  nome: bApiData.razao_social,
                  uf: bApiData.uf,
                  municipio: bApiData.municipio,
                  natureza_juridica: bApiData.natureza_juridica,
                  ano_fundacao,
                  cnae_primario_descricao: bApiData.cnae_fiscal_descricao || '',
                  cnae_secundario_descricao: (bApiData.cnaes_secundarios || []).map((c: any) => c.descricao).join(' | '),
                  situacao_cadastral: bApiData.descricao_situacao_cadastral
              };

              cache[cnpj] = {
                  osc: oscData,
                  last_checked_date: now
              };
          }
      }

      if (oscData && oscData.situacao_cadastral === 'ATIVA') {
          // K.O. Checks
          const age = currentYear - oscData.ano_fundacao;
          const isNaturezaProibida = EDITAL_CRITERIA.ko_criteria.naturezas_juridicas_proibidas.some(n => oscData!.natureza_juridica.includes(n));

          if (age >= EDITAL_CRITERIA.ko_criteria.idade_minima_anos && !isNaturezaProibida) {
              enrichedOscs.push(oscData);
          }
      }
  }

  console.log(`Made ${apiCalls} calls to BrasilAPI.`);
  console.log(`After JIT and KO Filters: ${enrichedOscs.length} OSCs eligible.`);

  // Save Cache
  await saveCache(cache);

  if (enrichedOscs.length === 0) {
      console.log("No valid OSCs found after filtering.");
      process.exit(0);
  }

  // Phase 2: Zero-Cost Heuristic Pre-Ranking
  console.log('\n--- Phase 2: Zero-Cost Heuristic Pre-Ranking ---');
  const targetKeywords = ['cultura', 'educação', 'ensino', 'arte', 'mulher', 'jovem', 'juventude', 'social', 'desenvolvimento'];

  const scoredOscs = enrichedOscs.map(osc => {
    let heuristicScore = 0;
    const combinedText = `${osc.cnae_primario_descricao} ${osc.cnae_secundario_descricao}`.toLowerCase();

    targetKeywords.forEach(kw => {
      if (combinedText.includes(kw)) {
        heuristicScore += 10;
      }
    });

    const age = currentYear - osc.ano_fundacao;
    heuristicScore += Math.min(age, 20);

    return { osc, heuristicScore };
  });

  scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const top50 = scoredOscs.slice(0, 50).map(item => item.osc);
  console.log(`Pre-ranked down to ${top50.length} Top Candidates.`);

  // Phase 3: Paid AI Processing (Dossier & Match)
  console.log('\n--- Phase 3: Paid AI Processing (AI Match) ---');
  const finalMatches: MatchResult[] = [];

  for (let i = 0; i < top50.length; i++) {
    const osc = top50[i];
    console.log(`[${i + 1}/${top50.length}] AI Evaluating: ${osc.nome} (${osc.municipio}-${osc.uf})`);

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

    let attempt = 0;
    const maxAttempts = 3;
    let success = false;

    while (attempt < maxAttempts && !success) {
      try {
        let aiResult: any;
        if (GEMINI_API_KEY && GEMINI_API_KEY !== 'dummy') {
            const result = await model.generateContent({
               contents: [{ role: 'user', parts: [{ text: prompt }] }],
               tools: [{ googleSearch: {} }]
            });

            const responseText = result.response.text().trim();
            const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
            aiResult = JSON.parse(cleanedResponse);
        } else {
            // Mock mode for testing
            aiResult = {
                score: Math.floor(Math.random() * 100),
                motivo_match: "Mock reasoning for testing.",
                whatsapp_message: "Olá! Este é um teste mock."
            };
        }

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

    if (i < top50.length - 1) {
      console.log(`   -> Sleeping 4000ms to respect rate limits...`);
      await sleep(4000);
    }
  }

  // Phase 4: Delivery
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
