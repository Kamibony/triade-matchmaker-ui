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
  official_contacts?: {
    ddd_telefone_1?: string;
    ddd_telefone_2?: string;
    email?: string;
  };
}

interface CacheEntry {
  osc: OSC;
  last_checked_date: string;
  dossieText?: string;
  dossie_updated_at?: string;
  evaluated_editais?: string[];
}

interface MatchResult {
  edital_url?: string;
  edital_id: string;
  edital_titulo: string;
  osc: OSC;
  score: number;
  motivo_match: string;
  whatsapp_message: string;
  contatos_encontrados?: {
    whatsapp?: string;
    email?: string;
    instagram?: string;
  };
  dossieText: string;
  created_at?: string;
}

// --- Configuration ---
const CACHE_PATH = path.join(process.cwd(), 'src', 'data', 'cnpj_cache.json');
const OUTPUT_FILE = path.join(process.cwd(), 'src', 'data', 'daily_outbound_leads.json');
const EDITAIS_PATH = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');

// Model WITHOUT Google Search Grounding (near-zero cost: ~$0.075 / 1M tokens)
const modelWithoutSearch = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash-lite',
  generationConfig: {
    temperature: 0,
    responseMimeType: 'application/json'
  }
});

// Model WITH Google Search Grounding (used strictly for uncached Top Finalists)
const modelWithSearch = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash-lite',
  generationConfig: { temperature: 0 },
  tools: [
    {
      // @ts-ignore
      googleSearch: {}
    }
  ]
});

const currentYear = new Date().getFullYear();

// Bureaucratic & generic Portuguese stopwords that appear in almost every CNAE or grant summary
const PORTUGUESE_STOPWORDS = new Set([
  'associação', 'associacao', 'associações', 'associacoes', 'direitos', 'sociais', 'social',
  'atividades', 'organizações', 'organizacoes', 'organização', 'organizacao', 'defesa',
  'desenvolvimento', 'projeto', 'projetos', 'apoio', 'brasil', 'nacional', 'estadual',
  'municipal', 'público', 'publico', 'pública', 'publica', 'seleção', 'selecao',
  'chamamento', 'edital', 'fomento', 'recursos', 'execução', 'execucao', 'ações', 'acoes',
  'através', 'atraves', 'meio', 'forma', 'valor', 'instituições', 'instituicoes',
  'entidades', 'civil', 'sociedade', 'serviços', 'servicos', 'outros', 'outras',
  'especificados', 'anteriormente', 'ligadas', 'privada', 'fundação', 'fundacao',
  'instituto', 'comunitário', 'comunitario', 'comunitária', 'comunitaria', 'interesse',
  'geral', 'públicas', 'publicas', 'políticas', 'politicas', 'fortalecimento',
  'promoção', 'promocao', 'programas', 'programa', 'iniciativas', 'estado', 'município',
  'municipio', 'região', 'regiao', 'objetivo', 'visando', 'celebrar', 'termo'
]);

const NATIONAL_ROTATION_CITIES = [
  'São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Recife',
  'Salvador', 'Porto Alegre', 'Curitiba', 'Fortaleza',
  'Belém', 'Goiânia', 'Manaus', 'Florianópolis', 'João Pessoa'
];

// Helper: Sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function hasValidPhone(osc: OSC): boolean {
  const raw = osc.official_contacts?.ddd_telefone_1 || osc.official_contacts?.ddd_telefone_2 || '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10;
}

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
      if (response.status === 404) return null;
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
    const data = await fs.readFile(CACHE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, CacheEntry>) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

async function loadExistingLeads(): Promise<MatchResult[]> {
  try {
    const data = await fs.readFile(OUTPUT_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isEditalSuitableForNgos(edital: any): boolean {
  const nomeNorm = normalizeText(edital.attributes?.nome || '');
  const resumoNorm = normalizeText(edital.deep_metadata?.resumo_objetivo || '');

  // Exclude individual scholarships (Bolsas), academic productivity grants, corporate subsidies, and utility engineering calls
  const nonNgoTitlePatterns = [
    'bolsa ', 'bolsas ', 'pos-graduacao', 'iniciacao cientifica', 'pibex',
    'produtividade em pesquisa', 'catedra', 'subvencao economica',
    'inovacao para a industria', 'eficiencia energetica', 'pee/aneel',
    'cpp 001/', 'cpp 002/', 'premio de fotografia', 'longa-metragem'
  ];
  if (nonNgoTitlePatterns.some(pattern => nomeNorm.includes(pattern))) {
    return false;
  }

  // Exclude if the grant explicitly forbids non-profits (OSCs / Associações sem fins lucrativos)
  const exclList: string[] = edital.deep_metadata?.criterios_eliminatorios?.natureza_juridica_excluida || [];
  const forbidsNonProfits = exclList.some(item => {
    const norm = normalizeText(item);
    return (
      norm.includes('sem fins lucrativos') ||
      norm.includes('exclusivo para pessoa fisica') ||
      norm.includes('pessoa juridica nao prevista') ||
      norm === 'pessoa juridica'
    );
  });

  if (forbidsNonProfits) return false;

  // Exclude if summary explicitly states it is only for individuals or for-profit companies
  if (resumoNorm.includes('exclusivamente para pessoas fisicas') || resumoNorm.includes('empresas juniores')) {
    return false;
  }

  return true;
}

async function getTopEditais(existingLeads: MatchResult[]) {
  const editaisData = await fs.readFile(EDITAIS_PATH, 'utf-8');
  const editais = JSON.parse(editaisData);

  const now = new Date();
  const twentyDaysFromNow = new Date();
  twentyDaysFromNow.setDate(now.getDate() + 20);

  const validEditais = editais.filter((edital: any) => {
    if (!edital.deep_metadata) return false;

    const criterios = edital.deep_metadata.criterios_eliminatorios;
    if (!criterios || typeof criterios !== 'object' || Object.keys(criterios).length === 0) return false;

    const valor = edital.deep_metadata.financeiro?.valor_maximo_ou_global_reais || 0;
    if (valor < 300000) return false;

    if (!isEditalSuitableForNgos(edital)) return false;

    const prazo = edital.deep_metadata.prazo_de_inscricao;
    if (!prazo || prazo === 'Não informado') return true;

    const prazoDate = new Date(prazo);
    return prazoDate > twentyDaysFromNow;
  });

  // Sort by value descending
  validEditais.sort((a: any, b: any) => {
    const valA = a.deep_metadata.financeiro?.valor_maximo_ou_global_reais || 0;
    const valB = b.deep_metadata.financeiro?.financeiro?.valor_maximo_ou_global_reais || b.deep_metadata.financeiro?.valor_maximo_ou_global_reais || 0;
    return valB - valA;
  });

  // Smart Rotation: Prioritize editais that do not yet have leads in daily_outbound_leads.json
  const existingEditalCounts = new Map<string, number>();
  for (const lead of existingLeads) {
    const id = String(lead.edital_id);
    existingEditalCounts.set(id, (existingEditalCounts.get(id) || 0) + 1);
  }

  const freshEditais = validEditais.filter((e: any) => !existingEditalCounts.has(String(e.id)));
  const previouslyCoveredEditais = validEditais.filter((e: any) => existingEditalCounts.has(String(e.id)));

  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const rotatedPrevious = [
    ...previouslyCoveredEditais.slice((dayOfYear * 3) % Math.max(1, previouslyCoveredEditais.length)),
    ...previouslyCoveredEditais.slice(0, (dayOfYear * 3) % Math.max(1, previouslyCoveredEditais.length))
  ];

  const combinedQueue = [...freshEditais, ...rotatedPrevious];
  return combinedQueue.slice(0, 5);
}

async function getIpeaIdsForRegion(criterios: any, editalId: string, cache: Record<string, CacheEntry>) {
  let rawCnpjs: string[] = [];
  const seed = parseInt(String(editalId).replace(/\D/g, '') || '1', 10) + new Date().getDate();

  const collectFromOscList = async (oscs: any[], maxToCollect: number) => {
    if (!Array.isArray(oscs) || oscs.length === 0) return;
    // Use a deterministic rotating offset so we don't fetch the exact same first 100 OSCs every day
    const startOffset = oscs.length > maxToCollect ? (seed * 37) % (oscs.length - maxToCollect) : 0;
    const slice = oscs.slice(startOffset, startOffset + maxToCollect);

    for (const item of slice) {
      try {
        const headerData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${item.id_osc}`);
        if (headerData && headerData.cd_identificador_osc) {
          const cnpj = String(headerData.cd_identificador_osc).padStart(14, '0');
          // Skip if already evaluated for this exact edital
          if (cache[cnpj]?.evaluated_editais?.includes(String(editalId))) {
            continue;
          }
          rawCnpjs.push(cnpj);
        }
      } catch {
        // Ignore individual header errors
      }
      if (rawCnpjs.length >= 100) break;
    }
  };

  if (criterios.municipios_permitidos && criterios.municipios_permitidos.length > 0) {
    for (const cityString of criterios.municipios_permitidos) {
      const cityPart = cityString.split('-')[0].trim();
      try {
        const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/${encodeURIComponent(cityPart)}`);
        if (muniData && muniData.length > 0) {
          const id = muniData[0].edmu_cd_municipio;
          const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${id}`);
          await collectFromOscList(oscs, 80);
        }
      } catch {
        console.warn(`Failed to fetch OSCs for municipality ${cityPart}`);
      }
      if (rawCnpjs.length >= 100) break;
    }
  } else if (criterios.estados_permitidos && criterios.estados_permitidos.length > 0) {
    for (const state of criterios.estados_permitidos) {
      try {
        const stateData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/estado/${encodeURIComponent(state)}`);
        if (stateData && stateData.length > 0) {
          const id = stateData[0].eduf_cd_uf;
          const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/estado/${id}`);
          await collectFromOscList(oscs, 80);
        }
      } catch {
        console.warn(`Failed to fetch OSCs for state ${state}`);
      }
      if (rawCnpjs.length >= 100) break;
    }
  } else {
    // National coverage: rotate across major Brazilian cities instead of hardcoding only João Pessoa
    const citiesToQuery = [
      NATIONAL_ROTATION_CITIES[seed % NATIONAL_ROTATION_CITIES.length],
      NATIONAL_ROTATION_CITIES[(seed + 4) % NATIONAL_ROTATION_CITIES.length]
    ];
    for (const city of citiesToQuery) {
      try {
        const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/${encodeURIComponent(city)}`);
        if (muniData && muniData.length > 0) {
          const id = muniData[0].edmu_cd_municipio;
          const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${id}`);
          await collectFromOscList(oscs, 50);
        }
      } catch {
        console.warn(`Failed to fetch OSCs for national sample city ${city}`);
      }
      if (rawCnpjs.length >= 100) break;
    }
  }

  return [...new Set(rawCnpjs)].slice(0, 100);
}

async function batchAiPreScreen(edital: any, candidates: OSC[]): Promise<OSC[]> {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'dummy' || candidates.length <= 6) {
    return candidates.slice(0, 6);
  }

  const compactCandidates = candidates.map(c => ({
    cnpj: c.cnpj,
    nome: c.nome,
    local: `${c.municipio}/${c.uf}`,
    ano_fundacao: c.ano_fundacao,
    cnae: `${c.cnae_primario_descricao} | ${c.cnae_secundario_descricao}`.slice(0, 220),
    tem_telefone: hasValidPhone(c)
  }));

  const prompt = `Você é um consultor sênior de captação de recursos para ONGs (OSCs).
Analise o Edital abaixo e a lista de ${compactCandidates.length} ONGs pré-selecionadas.
Selecione APENAS as 6 ONGs com MAIOR aderência temática real ao objetivo e temas do edital (priorizando aquelas cujo nome e atividades demostrem atuação real na área do edital e que possuam telefone).
Descarte ONGs genéricas ou sem relação clara com o tema do edital.

EDITAL:
Título: ${edital.attributes?.nome}
Objetivo: ${edital.deep_metadata?.resumo_objetivo || ''}
Temas Principais: ${(edital.deep_metadata?.temas_principais || []).join(', ')}

CANDIDATAS:
${JSON.stringify(compactCandidates)}

Retorne APENAS um objeto JSON válido no formato:
{
  "selected_cnpjs": ["cnpj1", "cnpj2", ...]
}`;

  try {
    const result = await modelWithoutSearch.generateContent(prompt);
    const parsed = JSON.parse(result.response.text().trim());
    if (Array.isArray(parsed?.selected_cnpjs) && parsed.selected_cnpjs.length > 0) {
      const selectedSet = new Set(parsed.selected_cnpjs.map((id: string) => String(id)));
      const filtered = candidates.filter(c => selectedSet.has(c.cnpj));
      if (filtered.length > 0) {
        return filtered.slice(0, 6);
      }
    }
  } catch (e: any) {
    console.warn(`Batch AI pre-screening failed, falling back to top heuristic candidates: ${e.message}`);
  }

  return candidates.slice(0, 6);
}

async function runPipeline() {
  console.log(`Starting Optimized Outbound Matchmaking Pipeline`);

  const existingLeads = await loadExistingLeads();
  const topEditais = await getTopEditais(existingLeads);
  console.log(`Selected ${topEditais.length} NGO-suitable editais for today's run.`);

  const cache = await loadCache();
  const newMatches: MatchResult[] = [];
  let totalSearchCalls = 0;
  const MAX_SEARCH_CALLS_PER_RUN = 25; // Hard circuit breaker to guarantee low billing

  for (const edital of topEditais) {
    console.log(`\n================================`);
    console.log(`Processing Edital [${edital.id}]: ${edital.attributes.nome}`);
    const criterios = edital.deep_metadata.criterios_eliminatorios || {};

    console.log(`Fetching IPEA IDs for region...`);
    let rawCnpjs = await getIpeaIdsForRegion(criterios, String(edital.id), cache);
    console.log(`Retrieved ${rawCnpjs.length} fresh CNPJs for this edital from IPEA.`);

    // Supplement with eligible cached OSCs from the right state/municipality if IPEA returned few results
    if (rawCnpjs.length < 30) {
      const allowedStates: string[] = (criterios.estados_permitidos || []).map((s: string) => s.toUpperCase());
      const cachedCnpjs = Object.keys(cache).filter(cnpj => {
        const entry = cache[cnpj];
        const osc = entry?.osc;
        if (!osc || osc.situacao_cadastral !== 'ATIVA') return false;
        if (entry.evaluated_editais?.includes(String(edital.id))) return false;
        if (!criterios.abrangencia_nacional && allowedStates.length > 0 && !allowedStates.includes((osc.uf || '').toUpperCase())) {
          return false;
        }
        return true;
      });

      const shuffled = cachedCnpjs.sort(() => 0.5 - Math.random());
      rawCnpjs = [...new Set([...rawCnpjs, ...shuffled])].slice(0, 150);
      console.log(`Total candidate pool after cache supplement: ${rawCnpjs.length} CNPJs.`);
    }

    const enrichedOscs: OSC[] = [];
    let apiCalls = 0;

    const globalBlacklist = [
      'igreja', 'religiosa', 'templo', 'arquidiocese', 'diocese', 'paróquia', 'paroquia',
      'loja maçônica', 'maconica', 'arls', 'sindicato', 'partido político', 'partido politico',
      'condomínio', 'condominio', 'escola municipal', 'escola estadual', 'caixa escolar',
      'colégio municipal', 'colégio estadual', 'conselho estadual', 'conselho municipal',
      'conselho escolar', 'prefeitura', 'secretaria', 'advogados', 'escritório', 'contábil',
      'comércio', 'esporte clube', 'futebol clube', 'servidores', 'câmara', 'ministério público',
      'tribunal', 'polícia', 'bombeiros', 'crea', 'oab', 'cartório', 'hospital municipal'
    ];

    for (const cnpj of rawCnpjs) {
      const cached = cache[cnpj];
      const now = new Date().toISOString();

      let oscData: OSC | null = null;

      if (cached && cached.osc) {
        oscData = cached.osc;
      } else {
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
            situacao_cadastral: bApiData.descricao_situacao_cadastral,
            official_contacts: {
              ddd_telefone_1: bApiData.ddd_telefone_1 || undefined,
              ddd_telefone_2: bApiData.ddd_telefone_2 || undefined,
              email: bApiData.email || undefined
            }
          };

          cache[cnpj] = {
            osc: oscData,
            last_checked_date: now,
            evaluated_editais: []
          };
        }
      }

      if (oscData && oscData.situacao_cadastral === 'ATIVA') {
        const age = currentYear - oscData.ano_fundacao;
        const excludedNatures = criterios.natureza_juridica_excluida || [];

        const nomeLower = (oscData.nome || '').toLowerCase();
        const natLower = (oscData.natureza_juridica || '').toLowerCase();

        const isGloballyBlacklisted = globalBlacklist.some(kw =>
          natLower.includes(kw) || nomeLower.includes(kw)
        );

        const isNaturezaProibida = excludedNatures.some((n: string) => {
          const nLower = n.toLowerCase();
          if (nLower.includes('fins lucrativos') && !nLower.includes('sem fins lucrativos')) return false;
          return natLower.includes(nLower);
        });

        const minAge = criterios.idade_minima_cnpj_anos || 0;
        if (age >= minAge && !isNaturezaProibida && !isGloballyBlacklisted) {
          enrichedOscs.push(oscData);
        }
      }
    }

    console.log(`Made ${apiCalls} calls to BrasilAPI. Eligible OSCs after K.O. filters: ${enrichedOscs.length}`);
    if (enrichedOscs.length === 0) continue;

    // --- Stage 1A: Strict Local Heuristic Scoring ---
    const temas: string[] = edital.deep_metadata.temas_principais || [];
    const normalizedThemes = temas
      .map((t: string) => normalizeText(t))
      .filter((t: string) => t.length > 2 && !PORTUGUESE_STOPWORDS.has(t));

    // Also extract individual significant words from multi-word themes (e.g. "agricultura familiar" -> "agricultura")
    const themeTokens = [...new Set(
      normalizedThemes.flatMap(t => t.split(/[\s,.;/-]+/)).filter(w => w.length > 3 && !PORTUGUESE_STOPWORDS.has(w))
    )];

    const resumoObjetivo = edital.deep_metadata.resumo_objetivo || '';
    const resumoWords = [...new Set(
      normalizeText(resumoObjetivo)
        .split(/[\s,.;:()/-]+/)
        .filter((w: string) => w.length > 4 && !PORTUGUESE_STOPWORDS.has(w))
    )];

    const scoredOscs = enrichedOscs.map(osc => {
      let keywordScore = 0;
      const nomeNorm = normalizeText(osc.nome);
      const cnaeNorm = normalizeText(`${osc.cnae_primario_descricao} ${osc.cnae_secundario_descricao}`);
      const combinedText = `${nomeNorm} ${cnaeNorm}`;

      // 1. Primary Theme phrase match (+100 pts, +40 bonus if in the NGO's actual name)
      for (const theme of normalizedThemes) {
        if (combinedText.includes(theme)) {
          keywordScore += 100;
          if (nomeNorm.includes(theme)) keywordScore += 40;
        }
      }

      // 2. Theme token match (+50 pts)
      for (const token of themeTokens) {
        if (combinedText.includes(token)) {
          keywordScore += 50;
          if (nomeNorm.includes(token)) keywordScore += 25;
        }
      }

      // 3. Objective specific keyword match (+25 pts)
      for (const kw of resumoWords) {
        if (combinedText.includes(kw)) {
          keywordScore += 25;
        }
      }

      // STRICT FILTER: If keywordScore is 0, heuristicScore MUST be 0 (no age bonus for irrelevant NGOs!)
      if (keywordScore === 0) {
        return { osc, heuristicScore: 0 };
      }

      const age = Math.max(0, currentYear - (osc.ano_fundacao || currentYear));
      const ageBonus = Math.min(age, 20);
      const phoneBonus = hasValidPhone(osc) ? 30 : 0;
      const emailBonus = osc.official_contacts?.email ? 10 : 0;

      const heuristicScore = keywordScore + ageBonus + phoneBonus + emailBonus;
      return { osc, heuristicScore };
    }).filter(item => item.heuristicScore > 0);

    scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);
    const top20Heuristic = scoredOscs.slice(0, 20).map(item => item.osc);
    console.log(`Strict Pre-Ranking: ${scoredOscs.length} relevant OSCs found (filtered from ${enrichedOscs.length}). Sending top ${top20Heuristic.length} to Batch AI Pre-Screen.`);

    if (top20Heuristic.length === 0) continue;

    // --- Stage 1B: Batch AI Pre-Screening WITHOUT Google Search ---
    const topFinalists = await batchAiPreScreen(edital, top20Heuristic);
    console.log(`Batch AI selected ${topFinalists.length} high-probability finalists for Edital ${edital.id}.`);

    // --- Stage 2: Dossier (Cached or Single-Query Search) + Final Evaluation ---
    for (let i = 0; i < topFinalists.length; i++) {
      const osc = topFinalists[i];
      console.log(`[${i + 1}/${topFinalists.length}] Evaluating Finalist: ${osc.nome} (${osc.municipio}/${osc.uf})`);

      const cacheEntry = cache[osc.cnpj] || { osc, last_checked_date: new Date().toISOString(), evaluated_editais: [] };
      cacheEntry.evaluated_editais = Array.from(new Set([...(cacheEntry.evaluated_editais || []), String(edital.id)]));
      cache[osc.cnpj] = cacheEntry;

      let dossieText = cacheEntry.dossieText || '';

      if (dossieText && dossieText.length > 80 && !dossieText.includes('indisponível')) {
        console.log(`  -> Using cached Dossiê for CNPJ ${osc.cnpj} ($0 search cost)`);
      } else if (GEMINI_API_KEY && GEMINI_API_KEY !== 'dummy' && totalSearchCalls < MAX_SEARCH_CALLS_PER_RUN) {
        const dossiePrompt = `Você é um analista do Terceiro Setor brasileiro.
Faça UMA ÚNICA busca objetiva no Google sobre a ONG "${osc.nome}" de ${osc.municipio} - ${osc.uf} (CNPJ: ${osc.cnpj}).
Resuma de forma enxuta e factual em Markdown:
### 🌐 Presença Digital e Contatos
- Site oficial, Instagram/Facebook e contatos públicos (telefone/WhatsApp/e-mail) se encontrados.
### 🎯 Atuação Prática e Projetos
- O que a organização faz na prática, público atendido e projetos ou parcerias conhecidos (se não houver presença digital clara, informe brevemente com base no nome e município).`;

        try {
          totalSearchCalls++;
          const dossieResult = await modelWithSearch.generateContent({
            contents: [{ role: 'user', parts: [{ text: dossiePrompt }] }]
          });
          dossieText = dossieResult.response.text().trim();
          cacheEntry.dossieText = dossieText;
          cacheEntry.dossie_updated_at = new Date().toISOString();
        } catch (e: any) {
          console.error(`  -> Dossier generation failed: ${e.message}`);
          dossieText = `Organização ativa registrada em ${osc.municipio}/${osc.uf} sob CNAE: ${osc.cnae_primario_descricao}.`;
        }
        await sleep(2500);
      } else {
        dossieText = `Organização ativa registrada em ${osc.municipio}/${osc.uf}. Atividade principal: ${osc.cnae_primario_descricao}.`;
      }

      const valorEdital = edital.deep_metadata?.financeiro?.valor_maximo_ou_global_reais
        ? `R$ ${Number(edital.deep_metadata.financeiro.valor_maximo_ou_global_reais).toLocaleString('pt-BR')}`
        : 'valor atrativo';

      const matchPrompt = `You are a senior grant consultant. Evaluate this NGO against the grant below.

**Grant (Edital):**
Title: ${edital.attributes.nome}
Max/Global Value: ${valorEdital}
Objective: ${edital.deep_metadata.resumo_objetivo || ''}
Themes: ${temas.join(', ')}

**NGO (OSC) Profile:**
Name: ${osc.nome}
Location: ${osc.municipio}, ${osc.uf}
Nature: ${osc.natureza_juridica}
Founded: ${osc.ano_fundacao}
Primary Activity (CNAE): ${osc.cnae_primario_descricao}
Secondary Activity (CNAE): ${osc.cnae_secundario_descricao}
Official Phone: ${osc.official_contacts?.ddd_telefone_1 || 'N/A'}
Official Email: ${osc.official_contacts?.email || 'N/A'}

**NGO Web Dossier:**
${dossieText}

Return ONLY a valid JSON object containing:
- "score": A number between 0 and 100 representing how well the NGO matches the grant's objective and themes.
- "motivo_match": A brief 1-2 sentence justification in pt-BR citing specific evidence from their activities or dossier.
- "whatsapp_message": "Mensagem curta, humana e atrativa de WhatsApp (em pt-BR) escrita por 'Maria Angela Bonifacio, Triade ACR' para a ONG. Elogie brevemente o trabalho da ONG. Diga que você mapeou uma oportunidade de edital/financiamento no valor de até ${valorEdital} voltado para a área de atuação deles. REGRA CRÍTICA E ABSOLUTA: NUNCA mencione o título, nome real ou a instituição do edital. Termine perguntando se eles têm disponibilidade para uma breve conversa."
- "contatos_encontrados": An object with optional keys "whatsapp", "email", and "instagram" extracted from the dossier.`;

      let aiResult: any = { score: 0, motivo_match: 'Failed', whatsapp_message: '', contatos_encontrados: {} };
      if (GEMINI_API_KEY && GEMINI_API_KEY !== 'dummy') {
        try {
          const result = await modelWithoutSearch.generateContent(matchPrompt);
          const responseText = result.response.text().trim();
          const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
          aiResult = JSON.parse(cleanedResponse);
        } catch (e: any) {
          console.error(`  -> Match evaluation failed: ${e.message}`);
        }
      } else {
        aiResult = { score: 75, motivo_match: 'Mock reasoning.', whatsapp_message: 'Mock message.' };
      }

      const finalScore = Number(aiResult.score) || 0;
      if (finalScore >= 55) {
        const resolvedContacts = {
          ...(aiResult.contatos_encontrados || {}),
          whatsapp: aiResult.contatos_encontrados?.whatsapp || osc.official_contacts?.ddd_telefone_1 || osc.official_contacts?.ddd_telefone_2 || undefined,
          email: aiResult.contatos_encontrados?.email || osc.official_contacts?.email || undefined
        };

        newMatches.push({
          edital_id: String(edital.id),
          edital_titulo: edital.attributes.nome,
          edital_url: edital.deep_metadata?.drive_pdf_link || edital.deep_metadata?.link_google_drive || edital.pdf_link || edital.public_url || null,
          osc,
          score: finalScore,
          motivo_match: aiResult.motivo_match || 'Compatibilidade temática identificada.',
          whatsapp_message: aiResult.whatsapp_message || '',
          contatos_encontrados: resolvedContacts,
          dossieText,
          created_at: new Date().toISOString()
        });
      } else {
        console.log(`  -> Discarded low-score match (${finalScore} < 55) for ${osc.nome}`);
      }

      await sleep(2000);
    }
  }

  // Merge new matches with rolling history (deduplicate by edital_id + cnpj, keep top 120 leads)
  const mergedMap = new Map<string, MatchResult>();
  for (const m of [...newMatches, ...existingLeads]) {
    if (!m?.osc?.cnpj || !m?.edital_id) continue;
    // Also filter out any legacy non-NGO editais (like Bolsas de Produtividade) from existing leads
    const titleNorm = normalizeText(m.edital_titulo || '');
    if (titleNorm.includes('bolsas de produtividade') || titleNorm.includes('eficiencia energetica')) {
      continue;
    }
    const key = `${m.edital_id}_${m.osc.cnpj}`;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, m);
    }
  }

  const finalLeads = Array.from(mergedMap.values()).slice(0, 120);

  await saveCache(cache);
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(finalLeads, null, 2), 'utf-8');
  console.log(`\nPipeline complete! Google Search calls used: ${totalSearchCalls}/${MAX_SEARCH_CALLS_PER_RUN}.`);
  console.log(`Added ${newMatches.length} new quality leads (Total active leads saved: ${finalLeads.length}).`);
}

runPipeline().catch(console.error);
