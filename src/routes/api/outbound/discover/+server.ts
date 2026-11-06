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
    const { editalId, customKeywords } = await request.json();

    // 1. Get Edital
    const editaisData = JSON.parse(await fs.readFile(EDITAIS_PATH, 'utf-8'));
    const edital = editaisData.find((e: any) => e.id === editalId || e.id?.toString() === editalId?.toString());

    if (!edital) {
      return json({ error: 'Edital not found' }, { status: 404 });
    }

    // 2. Geocoding Simulation (Simplified for on-demand search)
    // In production we'd do the full state/municipality mapping, here we default or use one generic fetch for PB to avoid timeouts
    let ibgeCode = '2507507'; // João Pessoa default as per requirements
    let type: 'estado' | 'municipio' = 'municipio';

    const ipeaResults = await fetchIpeaOscs(ibgeCode, type);
    console.log(`IPEA returned ${ipeaResults.length} OSCs`);

    // Take a small sample to avoid timing out on the serverless edge
    const sample = ipeaResults.slice(0, 100);

    // 3. Cache and Brasil API
    const cache = await loadCache();
    const enrichedOscs = [];

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

    // 4. Heuristic Pre-Ranking
    const editalKeywordsText = (edital.temas_principais?.join(' ') || '') + " " + (edital.resumo_objetivo || '');
    // Crucial step: Inject customKeywords heavily
    const searchContext = (editalKeywordsText + " " + customKeywords + " " + customKeywords).toLowerCase();

    const scoredOscs = enrichedOscs.map(osc => {
      const oscText = (osc.cnae_primario_descricao + " " + osc.cnae_secundario_descricao + " " + osc.natureza_juridica).toLowerCase();
      let keywordScore = 0;

      const searchTokens = searchContext.split(/[\s,]+/);
      for (const token of searchTokens) {
        if (token.length > 3 && oscText.includes(token)) {
          keywordScore += 50;
        }
      }

      // Zero-Tolerance rule
      if (keywordScore === 0) return null;

      const currentYear = new Date().getFullYear();
      const age = currentYear - osc.ano_fundacao;
      const heuristicScore = keywordScore + Math.min(age, 20);

      return { osc, heuristicScore };
    }).filter(item => item !== null) as { osc: any, heuristicScore: number }[];

    scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);

    // Top 10 for manual search
    const top10 = scoredOscs.slice(0, 10).map(item => item.osc);

    return json({ topOscs: top10, edital });

  } catch (error: any) {
    console.error(error);
    return json({ error: error.message }, { status: 500 });
  }
}
