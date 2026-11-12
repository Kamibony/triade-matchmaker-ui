import { json } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';

const CACHE_PATH = path.join(process.cwd(), 'src', 'data', 'cnpj_cache.json');
const EDITAIS_PATH = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');

const PORTUGUESE_STOPWORDS = new Set([
  'associação', 'associacao', 'associações', 'associacoes', 'direitos', 'sociais', 'social',
  'atividades', 'organizações', 'organizacoes', 'organização', 'organizacao', 'defesa',
  'desenvolvimento', 'projeto', 'projetos', 'apoio', 'brasil', 'nacional', 'estadual',
  'municipal', 'público', 'publico', 'pública', 'publica', 'seleção', 'selecao',
  'chamamento', 'edital', 'fomento', 'recursos', 'execução', 'execucao', 'ações', 'acoes',
  'através', 'atraves', 'meio', 'forma', 'valor', 'instituições', 'instituicoes',
  'entidades', 'civil', 'sociedade', 'serviços', 'servicos', 'outros', 'outras',
  'especificados', 'anteriormente', 'ligadas', 'privada', 'fundação', 'fundacao'
]);

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function fetchFromIpea(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchBrasilApiCnpj(cnpj: string) {
  try {
    const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function POST({ request }) {
  try {
    const { editalId, edital: providedEdital, customKeywords, targetUf, targetMunicipio } = await request.json();

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

    if (!edital.temas_principais && edital.deep_metadata?.temas_principais) {
      edital.temas_principais = edital.deep_metadata.temas_principais;
    }
    if (!edital.resumo_objetivo && edital.deep_metadata?.resumo_objetivo) {
      edital.resumo_objetivo = edital.deep_metadata.resumo_objetivo;
    }

    const criterios = edital.deep_metadata?.criterios_eliminatorios || {};
    let ipeaResults: any[] = [];

    const effectiveMunicipio = targetMunicipio || (criterios.municipios_permitidos?.length > 0 ? criterios.municipios_permitidos[0].split('-')[0].trim() : '');
    const effectiveUf = targetUf || (criterios.estados_permitidos?.length > 0 ? criterios.estados_permitidos[0] : '');

    if (effectiveMunicipio) {
      const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/${encodeURIComponent(effectiveMunicipio)}`);
      if (muniData?.length > 0) {
        ipeaResults = (await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${muniData[0].edmu_cd_municipio}`)) || [];
      }
    } else if (effectiveUf) {
      const stateData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/estado/${encodeURIComponent(effectiveUf)}`);
      if (stateData?.length > 0) {
        ipeaResults = (await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/estado/${stateData[0].eduf_cd_uf}`)) || [];
      }
    } else {
      ipeaResults = (await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/3550308`)) || [];
    }

    const sample = Array.isArray(ipeaResults) ? ipeaResults.slice(0, 60) : [];
    const cache = await loadCache();
    const enrichedOscs: any[] = [];

    const blacklist = ['igreja', 'religiosa', 'templo', 'arquidiocese', 'diocese', 'paróquia', 'loja maçônica', 'arls', 'sindicato', 'partido político', 'condomínio', 'escola municipal', 'escola estadual', 'colégio municipal', 'colégio estadual', 'conselho estadual', 'conselho municipal', 'conselho escolar', 'prefeitura', 'secretaria', 'advogados', 'escritório', 'contábil', 'comércio', 'esporte clube', 'futebol clube', 'servidores', 'câmara', 'ministério público', 'tribunal', 'polícia', 'bombeiros', 'crea', 'oab'];

    for (const osc of sample) {
      const oscId = osc.id_osc || osc.cd_identificador_osc;
      let realCnpj = '';
      const header = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${oscId}`);
      if (header?.cd_identificador_osc) {
        realCnpj = header.cd_identificador_osc.toString().padStart(14, '0');
      }
      if (!realCnpj) continue;

      let brasilApiData = cache[realCnpj]?.osc;
      if (!brasilApiData) {
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
        const nameAndNatureza = (brasilApiData.nome + ' ' + brasilApiData.natureza_juridica).toLowerCase();
        const isBlacklisted = blacklist.some(b => nameAndNatureza.includes(b));
        if (!isBlacklisted) {
          enrichedOscs.push(brasilApiData);
        }
      }
    }

    if (enrichedOscs.length < 20 && Object.keys(cache).length > 0) {
      const allowedStates = targetUf
        ? [targetUf.toUpperCase()]
        : (criterios.estados_permitidos || []).map((s: string) => s.toUpperCase());
      const cachedOscs: any[] = [];
      for (const entry of Object.values(cache) as any[]) {
        const osc = entry.osc;
        if (osc && (osc.situacao_cadastral === 'ATIVA' || !osc.situacao_cadastral)) {
          if (allowedStates.length > 0 && !allowedStates.includes((osc.uf || '').toUpperCase())) {
            continue;
          }
          if (targetMunicipio && !normalizeText(osc.municipio || '').includes(normalizeText(targetMunicipio))) {
            continue;
          }
          const nameAndNatureza = ((osc.nome || '') + ' ' + (osc.natureza_juridica || '')).toLowerCase();
          if (!blacklist.some(b => nameAndNatureza.includes(b))) {
            cachedOscs.push(osc);
          }
        }
      }
      cachedOscs.sort(() => 0.5 - Math.random());
      enrichedOscs.push(...cachedOscs.slice(0, 120));
    }

    const editalKeywordsText = (edital.temas_principais?.join(' ') || '') + ' ' + (edital.resumo_objetivo || '') + ' ' + (edital.titulo || '');
    const safeCustomKeywords = customKeywords ? `${customKeywords} ${customKeywords}` : '';
    const searchTokens = normalizeText(`${editalKeywordsText} ${safeCustomKeywords}`)
      .split(/[\s,.;:-]+/)
      .filter(t => t.length > 3 && !PORTUGUESE_STOPWORDS.has(t));

    const currentYear = new Date().getFullYear();

    const scoredOscs = enrichedOscs.map(osc => {
      const oscText = normalizeText(`${osc.nome || ''} ${osc.cnae_primario_descricao || ''} ${osc.cnae_secundario_descricao || ''}`);
      let keywordScore = 0;

      for (const token of searchTokens) {
        if (oscText.includes(token)) {
          keywordScore += 50;
        }
      }

      if (keywordScore === 0) {
        return { osc, heuristicScore: 0 };
      }

      const age = Math.max(0, currentYear - (osc.ano_fundacao || currentYear));
      const hasPhone = !!(osc.official_contacts?.ddd_telefone_1 || osc.official_contacts?.ddd_telefone_2);
      const heuristicScore = keywordScore + Math.min(age, 20) + (hasPhone ? 25 : 0);

      return { osc, heuristicScore };
    }).filter(item => item.heuristicScore > 0);

    scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);

    const seenCnpjs = new Set<string>();
    const topOscs: any[] = [];
    for (const item of scoredOscs) {
      if (!seenCnpjs.has(item.osc.cnpj)) {
        seenCnpjs.add(item.osc.cnpj);
        topOscs.push(item.osc);
      }
      if (topOscs.length >= 8) break;
    }

    return json({ topOscs, edital });

  } catch (error: any) {
    console.error(error);
    return json({ error: error.message }, { status: 500 });
  }
}
