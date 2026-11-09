import { json } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';

const CACHE_PATH = path.join(process.cwd(), 'src', 'data', 'cnpj_cache.json');
const EDITAIS_PATH = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');

// Using same logic from scripts/outbound-match.ts
async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

async function fetchIpeaOscs(ibgeCode: string, type: 'estado' | 'municipio') {
  const url = `https://mapaosc.ipea.gov.br/api/geo/oscs/${type}/${ibgeCode}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    return await response.json();
  } catch (e) {
    console.error(`Error fetching IPEA for ${type} ${ibgeCode}`, e);
    return [];
  }
}

async function fetchBrasilApiCnpj(cnpj: string) {
  try {
    const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

export async function POST({ request }) {
  try {
    const { editalId, edital: providedEdital, customKeywords } = await request.json();

    // 1. Get Edital
    let edital = providedEdital;

    if (!edital && editalId) {
      const editaisData = JSON.parse(await fs.readFile(EDITAIS_PATH, 'utf-8'));
      const rawEdital = editaisData.find((e: any) => e.id === editalId || e.id?.toString() === editalId?.toString());
      if (rawEdital) {
        edital = {
          id: rawEdital.id,
          titulo: rawEdital.titulo || rawEdital.attributes?.nome || 'Edital Sem Título',
          pdf_link: rawEdital.pdf_link || rawEdital.deep_metadata?.drive_pdf_link || rawEdital.public_url,
          resumo_objetivo: rawEdital.resumo_objetivo || rawEdital.deep_metadata?.resumo_objetivo || rawEdital.attributes?.resumo || '',
          temas_principais: rawEdital.temas_principais || rawEdital.deep_metadata?.temas_principais || [],
          prazo_de_inscricao: rawEdital.prazo_de_inscricao || rawEdital.deep_metadata?.prazo_de_inscricao || null,
          valor_maximo_ou_global_reais: rawEdital.valor_maximo_ou_global_reais || rawEdital.deep_metadata?.financeiro?.valor_maximo_ou_global_reais || null,
          deep_metadata: rawEdital.deep_metadata
        };
      }
    }

    if (!edital) {
      return json({ error: 'Edital não encontrado' }, { status: 404 });
    }

    // Ensure edital has normalized fields if BYOE passed without top-level themes/resumo
    if (!edital.temas_principais && edital.deep_metadata?.temas_principais) {
      edital.temas_principais = edital.deep_metadata.temas_principais;
    }
    if (!edital.resumo_objetivo && edital.deep_metadata?.resumo_objetivo) {
      edital.resumo_objetivo = edital.deep_metadata.resumo_objetivo;
    }

    // 2. Geocoding Simulation & OSC Discovery
    let ibgeCode = '2507507'; // João Pessoa default as per requirements
    let type: 'estado' | 'municipio' = 'municipio';

    let ipeaResults: any[] = [];
    try {
      ipeaResults = await fetchIpeaOscs(ibgeCode, type);
    } catch (e) {
      console.warn('IPEA fetch error:', e);
    }
    console.log(`IPEA returned ${ipeaResults.length} OSCs`);

    // Take a small sample to avoid timing out on the serverless edge
    const sample = ipeaResults.slice(0, 100);

    // 3. Cache and Brasil API
    const cache = await loadCache();
    const enrichedOscs: any[] = [];

    // Global Blacklist
    const blacklist = ['igreja', 'religiosa', 'loja maçônica', 'sindicato', 'partido político', 'condomínio'];

    for (const osc of sample) {
      const cnpjId = osc.cd_identificador_osc;

      // IPEA Header to get real CNPJ
      let realCnpj = "";
      try {
        const headerRes = await fetch(`https://mapaosc.ipea.gov.br/api/osc/cabecalho/${cnpjId}`);
        if (headerRes.ok) {
           const header = await headerRes.json();
           realCnpj = header.cd_identificador_osc?.toString().padStart(14, '0');
        }
      } catch (e) {}

      if (!realCnpj) continue;

      let brasilApiData = cache[realCnpj]?.osc;

      if (!brasilApiData) {
        // Fetch JIT
        const res = await fetchBrasilApiCnpj(realCnpj);
        if (res) {
          brasilApiData = {
            cnpj: realCnpj,
            nome: res.razao_social,
            uf: res.uf,
            municipio: res.municipio,
            natureza_juridica: res.natureza_juridica,
            ano_fundacao: res.data_inicio_atividade ? parseInt(res.data_inicio_atividade.split('-')[0]) : new Date().getFullYear(),
            cnae_primario_descricao: res.cnae_fiscal_descricao,
            cnae_secundario_descricao: res.cnaes_secundarios?.map((c: any) => c.descricao).join(', ') || '',
            situacao_cadastral: res.descricao_situacao_cadastral,
            official_contacts: {
              ddd_telefone_1: res.ddd_telefone_1,
              ddd_telefone_2: res.ddd_telefone_2,
              email: res.email
            }
          };
        }
      }

      if (brasilApiData && brasilApiData.situacao_cadastral === 'ATIVA') {
        const nameAndNatureza = (brasilApiData.nome + " " + brasilApiData.natureza_juridica).toLowerCase();
        const isBlacklisted = blacklist.some(b => nameAndNatureza.includes(b));
        if (!isBlacklisted) {
           enrichedOscs.push(brasilApiData);
        }
      }
    }

    // Fallback: If live IPEA yielded no active OSCs (e.g. rate limit, blocked IP, or downstream API change),
    // load verified active OSCs from local cache to guarantee high quality discovery
    if (enrichedOscs.length === 0 && Object.keys(cache).length > 0) {
      console.log('IPEA returned 0 OSCs. Using cached OSCs fallback.');
      for (const entry of Object.values(cache) as any[]) {
        const osc = entry.osc;
        if (osc && (osc.situacao_cadastral === 'ATIVA' || !osc.situacao_cadastral)) {
          const nameAndNatureza = ((osc.nome || '') + " " + (osc.natureza_juridica || '')).toLowerCase();
          const isBlacklisted = blacklist.some(b => nameAndNatureza.includes(b));
          if (!isBlacklisted) {
            enrichedOscs.push(osc);
          }
        }
      }
    }

    // 4. Heuristic Pre-Ranking
    const editalKeywordsText = (edital.temas_principais?.join(' ') || '') + " " + (edital.resumo_objetivo || '') + " " + (edital.titulo || '');
    // Crucial step: Inject customKeywords heavily if provided
    const safeCustomKeywords = customKeywords ? `${customKeywords} ${customKeywords}` : '';
    const searchContext = `${editalKeywordsText} ${safeCustomKeywords}`.toLowerCase();

    const currentYear = new Date().getFullYear();

    const scoredOscs = enrichedOscs.map(osc => {
      const oscText = ((osc.cnae_primario_descricao || '') + " " + (osc.cnae_secundario_descricao || '') + " " + (osc.natureza_juridica || '') + " " + (osc.nome || '')).toLowerCase();
      let keywordScore = 0;

      const searchTokens = searchContext.split(/[\s,.;:-]+/).filter(Boolean);
      for (const token of searchTokens) {
        if (token.length > 3 && oscText.includes(token)) {
          keywordScore += 50;
        }
      }

      // Zero-Tolerance rule: OSC must have at least one keyword overlap with the edital/themes
      if (keywordScore === 0) return null;

      const age = currentYear - (osc.ano_fundacao || currentYear);
      const heuristicScore = keywordScore + Math.min(age, 20);

      return { osc, heuristicScore };
    }).filter(item => item !== null) as { osc: any, heuristicScore: number }[];

    scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);

    // If zero tolerance filtered everything because the edital had very unique phrasing,
    // fallback to top enriched OSCs with active status
    let top10 = scoredOscs.slice(0, 10).map(item => item.osc);
    if (top10.length === 0 && enrichedOscs.length > 0) {
      top10 = enrichedOscs.slice(0, 5);
    }

    return json({ topOscs: top10, edital });

  } catch (error: any) {
    console.error(error);
    return json({ error: error.message }, { status: 500 });
  }
}
