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
}

interface MatchResult {
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
}

// --- Configuration ---
const CACHE_PATH = path.join(process.cwd(), 'src', 'data', 'cnpj_cache.json');
const OUTPUT_FILE = path.join(process.cwd(), 'src', 'data', 'daily_outbound_leads.json');
const EDITAIS_PATH = path.join(process.cwd(), 'src', 'data', 'editais_prosas.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');
const model = genAI.getGenerativeModel({
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
        const data = await fs.readFile(CACHE_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return {}; // empty if doesn't exist
    }
}

async function saveCache(cache: Record<string, CacheEntry>) {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

async function getTopEditais() {
    const editaisData = await fs.readFile(EDITAIS_PATH, 'utf-8');
    const editais = JSON.parse(editaisData);

    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(now.getDate() + 30);

    const validEditais = editais.filter((edital: any) => {
        if (!edital.deep_metadata) return false;

        const criterios = edital.deep_metadata.criterios_eliminatorios;
        if (!criterios || typeof criterios !== 'object' || Object.keys(criterios).length === 0) return false;

        const valor = edital.deep_metadata.financeiro?.valor_maximo_ou_global_reais || 0;
        if (valor <= 100000) return false;

        const prazo = edital.deep_metadata.prazo_de_inscricao;
        if (!prazo || prazo === 'Não informado') return true; // Continuous flow

        const prazoDate = new Date(prazo);
        return prazoDate > thirtyDaysFromNow;
    });

    validEditais.sort((a: any, b: any) => {
        const valA = a.deep_metadata.financeiro?.valor_maximo_ou_global_reais || 0;
        const valB = b.deep_metadata.financeiro?.valor_maximo_ou_global_reais || 0;
        return valB - valA; // Descending
    });

    return validEditais.slice(0, 5);
}

async function getIpeaIdsForRegion(criterios: any) {
    let rawCnpjs: string[] = [];

    if (criterios.municipios_permitidos && criterios.municipios_permitidos.length > 0) {
        // Find cities IDs
        for (const cityString of criterios.municipios_permitidos) {
            // "Rolim de Moura - RO" -> "Rolim de Moura"
            const cityPart = cityString.split('-')[0].trim();
            try {
                const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/${encodeURIComponent(cityPart)}`);
                if (muniData && muniData.length > 0) {
                    const id = muniData[0].edmu_cd_municipio;
                    const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${id}`);
                    const sampleSize = Math.min(100, oscs.length);
                    for (let i = 0; i < sampleSize; i++) {
                        const headerData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${oscs[i].id_osc}`);
                        if (headerData && headerData.cd_identificador_osc) {
                             rawCnpjs.push(String(headerData.cd_identificador_osc).padStart(14, '0'));
                        }
                    }
                }
            } catch (e) {
                console.warn(`Failed to fetch OSCs for municipality ${cityPart}`);
            }
            if (rawCnpjs.length >= 100) break; // limit to 100 total
        }
    } else if (criterios.estados_permitidos && criterios.estados_permitidos.length > 0) {
         // Find state IDs
         for (const state of criterios.estados_permitidos) {
             try {
                const stateData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/estado/${encodeURIComponent(state)}`);
                if (stateData && stateData.length > 0) {
                    const id = stateData[0].eduf_cd_uf;
                    const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/estado/${id}`);
                    const sampleSize = Math.min(100, oscs.length);
                    for (let i = 0; i < sampleSize; i++) {
                        const headerData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${oscs[i].id_osc}`);
                        if (headerData && headerData.cd_identificador_osc) {
                             rawCnpjs.push(String(headerData.cd_identificador_osc).padStart(14, '0'));
                        }
                    }
                }
             } catch (e) {
                console.warn(`Failed to fetch OSCs for state ${state}`);
             }
             if (rawCnpjs.length >= 100) break;
         }
    } else if (criterios.abrangencia_nacional) {
         // Use Joao Pessoa
         try {
            const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/João Pessoa`);
            if (muniData && muniData.length > 0) {
                const id = muniData[0].edmu_cd_municipio;
                const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${id}`);
                const sampleSize = Math.min(100, oscs.length);
                for (let i = 0; i < sampleSize; i++) {
                    const headerData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${oscs[i].id_osc}`);
                    if (headerData && headerData.cd_identificador_osc) {
                         rawCnpjs.push(String(headerData.cd_identificador_osc).padStart(14, '0'));
                    }
                }
            }
         } catch (e) {
            console.warn(`Failed to fetch OSCs for Joao Pessoa`);
         }
    } else {
         // Fallback to Joao Pessoa if no geographic data is present
         try {
            const muniData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/busca/municipio/João Pessoa`);
            if (muniData && muniData.length > 0) {
                const id = muniData[0].edmu_cd_municipio;
                const oscs = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/geo/oscs/municipio/${id}`);
                const sampleSize = Math.min(100, oscs.length);
                for (let i = 0; i < sampleSize; i++) {
                    const headerData = await fetchFromIpea(`https://mapaosc.ipea.gov.br/api/api/osc/cabecalho/${oscs[i].id_osc}`);
                    if (headerData && headerData.cd_identificador_osc) {
                         rawCnpjs.push(String(headerData.cd_identificador_osc).padStart(14, '0'));
                    }
                }
            }
         } catch (e) {
            console.warn(`Failed to fetch OSCs for Joao Pessoa`);
         }
    }

    return [...new Set(rawCnpjs)].slice(0, 100);
}

async function runPipeline() {
  console.log(`Starting Outbound Matchmaking Pipeline`);

  const topEditais = await getTopEditais();
  console.log(`Found ${topEditais.length} top editais.`);

  const cache = await loadCache();
  const allFinalMatches: MatchResult[] = [];

  for (const edital of topEditais) {
      console.log(`\n================================`);
      console.log(`Processing Edital: ${edital.attributes.nome}`);
      const criterios = edital.deep_metadata.criterios_eliminatorios || {};

      console.log(`Fetching IPEA IDs for region...`);
      let rawCnpjs = await getIpeaIdsForRegion(criterios);
      console.log(`Retrieved ${rawCnpjs.length} CNPJs for this edital from IPEA.`);

      if (rawCnpjs.length === 0) {
          console.log(`IPEA returned 0 CNPJs. Using cache as last resort fallback.`);
          const cachedCnpjs = Object.keys(cache).filter(cnpj => {
              const osc = cache[cnpj].osc;
              return osc && osc.situacao_cadastral === 'ATIVA';
          });

          // Randomly select up to 150 from the cache
          const shuffled = cachedCnpjs.sort(() => 0.5 - Math.random());
          rawCnpjs = shuffled.slice(0, 150);
          console.log(`Selected ${rawCnpjs.length} active CNPJs from cache fallback.`);
      }

      const enrichedOscs: OSC[] = [];
      let apiCalls = 0;

      for (const cnpj of rawCnpjs) {
          const cached = cache[cnpj];
          const now = new Date().toISOString();

          let oscData: OSC | null = null;

          if (cached) {
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
                      last_checked_date: now
                  };
              }
          }

          if (oscData && oscData.situacao_cadastral === 'ATIVA') {
              const age = currentYear - oscData.ano_fundacao;
              const excludedNatures = criterios.natureza_juridica_excluida || [];

              const globalBlacklist = ['igreja', 'religiosa', 'templo', 'arquidiocese', 'diocese', 'paróquia', 'loja maçônica', 'arls', 'sindicato', 'partido político', 'condomínio', 'escola municipal', 'escola estadual', 'colégio municipal', 'colégio estadual', 'conselho estadual', 'conselho municipal', 'conselho escolar', 'prefeitura', 'secretaria', 'advogados', 'escritório', 'contábil', 'comércio', 'esporte clube', 'futebol clube', 'servidores', 'câmara', 'ministério público', 'tribunal', 'polícia', 'bombeiros', 'crea', 'oab'];
              const isGloballyBlacklisted = globalBlacklist.some(kw =>
                  oscData!.natureza_juridica.toLowerCase().includes(kw) ||
                  oscData!.nome.toLowerCase().includes(kw)
              );

              const isNaturezaProibida = excludedNatures.some((n: string) => oscData!.natureza_juridica.toLowerCase().includes(n.toLowerCase()));

              const minAge = criterios.idade_minima_cnpj_anos || 0;
              if (age >= minAge && !isNaturezaProibida && !isGloballyBlacklisted) {
                  enrichedOscs.push(oscData);
              }
          }
      }
      console.log(`Made ${apiCalls} calls to BrasilAPI.`);
      console.log(`Eligible OSCs after K.O. filters: ${enrichedOscs.length}`);

      if (enrichedOscs.length === 0) continue;

      const temas = edital.deep_metadata.temas_principais || [];
      const resumoObjetivo = edital.deep_metadata.resumo_objetivo || '';
      const resumoWords = resumoObjetivo.toLowerCase().split(/[\s,.;]+/).filter((w: string) => w.length > 4);
      const allTargetKeywords = [...new Set([...temas.map((t: string) => t.toLowerCase()), ...resumoWords])];

      const scoredOscs = enrichedOscs.map(osc => {
          let keywordScore = 0;
          const combinedText = `${osc.cnae_primario_descricao} ${osc.cnae_secundario_descricao}`.toLowerCase();

          allTargetKeywords.forEach((kw: string) => {
              if (combinedText.includes(kw)) {
                  keywordScore += 50;
              }
          });

          const age = currentYear - osc.ano_fundacao;
          const heuristicScore = keywordScore + Math.min(age, 20);
          return { osc, heuristicScore };
      }).filter((item): item is { osc: OSC, heuristicScore: number } => item !== null);

      scoredOscs.sort((a, b) => b.heuristicScore - a.heuristicScore);
      const top50 = scoredOscs.slice(0, 50).map(item => item.osc);
      console.log(`Pre-ranked down to ${top50.length} Top Candidates.`);

      // AI Match
      for (let i = 0; i < top50.length; i++) {
          const osc = top50[i];
          console.log(`[${i + 1}/${top50.length}] AI Evaluating: ${osc.nome}`);

          let dossieText = '';
          const dossiePrompt = `Você é um investigador especializado no Terceiro Setor brasileiro e atua descobrindo a presença digital real de ONGs.
Sua missão é investigar a OSC "${osc.nome} ${osc.municipio} ${osc.uf}" (CNPJ: ${osc.cnpj}).

IMPORTANTE: Você deve realizar pesquisas profundas e específicas usando a ferramenta do Google Search.
Realize buscas separadas combinando o nome da organização com as seguintes palavras-chave para encontrar informações valiosas:
1. Buscar: "${osc.nome} Instagram" ou "${osc.nome} Facebook" (Encontre as redes sociais ativas, especialmente o Instagram).
2. Buscar: "${osc.nome} projetos sociais" ou "${osc.nome} impacto" (Descubra o que eles realmente fazem na prática).
3. Buscar: "${osc.nome} notícias" ou "${osc.nome} parceria" (Busque menções na mídia local, parcerias com empresas ou editais recentes).

Com base nas suas buscas, elabore um "Dossiê Web Avançado" em formato Markdown limpo e bem estruturado.
O dossiê DEVE conter as seguintes seções:

### 🌐 Presença Digital
- **Site Oficial:** (Se existir)
- **Redes Sociais:** (Coloque os links, dando prioridade absoluta ao Instagram e Facebook)
- **Status Digital:** (Avalie brevemente se a organização é ativa digitalmente)

### 🎯 Impacto Real e Atuação (Muito Importante)
- Descreva detalhadamente o que a organização faz na prática (além da descrição burocrática do CNAE). Quais são suas atividades principais? Que público eles atendem?

### 🚀 Projetos Recentes e Parcerias
- Liste projetos recentes, campanhas de arrecadação, menções na mídia ou parcerias governamentais/privadas. Inclua nomes de projetos específicos se encontrar.

Seja direto, profissional e focado em fornecer informações úteis para um consultor de captação de recursos que usará esses dados para sugerir projetos em editais.`;

          if (GEMINI_API_KEY && GEMINI_API_KEY !== 'dummy') {
              try {
                  const dossieResult = await model.generateContent({
                      contents: [{ role: 'user', parts: [{ text: dossiePrompt }] }],
                      tools: [{ googleSearch: {} } as any]
                  });
                  dossieText = dossieResult.response.text().trim();
              } catch (e: any) {
                  console.error(`Dossier generation failed: ${e.message}`);
                  dossieText = "Dossiê indisponível devido a falha na busca.";
              }
          } else {
              dossieText = "Dossiê mock para teste.";
          }

          await sleep(4000);

          const matchPrompt = `
You are a senior grant consultant. Your task is to evaluate a specific NGO against a specific grant and determine if they are a strong match.

**The Grant (Edital) Context:**
Title: ${edital.attributes.nome}
Objective: ${edital.deep_metadata.resumo_objetivo || ''}
Themes: ${temas.join(', ')}

**The NGO (OSC) Profile:**
Name: ${osc.nome}
Location: ${osc.municipio}, ${osc.uf}
Nature: ${osc.natureza_juridica}
Founded: ${osc.ano_fundacao}
Primary Activity (CNAE): ${osc.cnae_primario_descricao}
Secondary Activity (CNAE): ${osc.cnae_secundario_descricao}

**NGO Web Dossier (Research Context):**
${dossieText}

Based on the profile and the provided dossier, provide an evaluation.

Return ONLY a valid JSON object containing:
- "score": A number between 0 and 100 representing how well the NGO matches the grant's objective and themes.
- "motivo_match": A brief 1-2 sentence justification for the score, citing specific evidence from their activities or the dossier.
- "whatsapp_message": "Mensagem curta, humana e atrativa de WhatsApp (em pt-BR) escrita por 'Angela, consultora de captação de recursos' para a ONG. Elogie brevemente o trabalho da ONG usando algo do dossiê. Diga que você mapeou uma oportunidade de edital/financiamento no valor de até [INSERIR VALOR MÁXIMO DO EDITAL AQUI, se houver] voltado para [TEMA GERAL DA ONG/EDITAL]. REGRA CRÍTICA E ABSOLUTA: NUNCA, em hipótese alguma, escreva ou mencione o título, nome real ou a instituição do edital. Mantenha o nome do edital em total segredo. Termine perguntando se eles têm disponibilidade para uma breve conversa para apresentar os detalhes."
- "contatos_encontrados": An object extracting any discovered contact info from the Dossiê text, with optional keys "whatsapp", "email", and "instagram" (urls or handles).

Do not include markdown formatting. Just return the raw JSON object.`;

          let aiResult: any = { score: 0, motivo_match: "Failed", whatsapp_message: "", contatos_encontrados: {} };
          if (GEMINI_API_KEY && GEMINI_API_KEY !== 'dummy') {
               try {
                   const result = await model.generateContent({
                      contents: [{ role: 'user', parts: [{ text: matchPrompt }] }]
                   });
                   const responseText = result.response.text().trim();
                   const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
                   aiResult = JSON.parse(cleanedResponse);
               } catch (e: any) {
                   console.error(`Match generation failed: ${e.message}`);
               }
          } else {
               aiResult = { score: Math.floor(Math.random() * 100), motivo_match: "Mock reasoning.", whatsapp_message: "Mock message." };
          }

          allFinalMatches.push({
              edital_id: edital.id,
              edital_titulo: edital.attributes.nome,
              osc,
              score: aiResult.score || 0,
              motivo_match: aiResult.motivo_match || 'Evaluation failed.',
              whatsapp_message: aiResult.whatsapp_message || 'Outreach message failed.',
              contatos_encontrados: aiResult.contatos_encontrados || {},
              dossieText: dossieText
          });

          await sleep(4000);
      }
  }

  // Save Cache and Matches
  await saveCache(cache);

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(allFinalMatches, null, 2), 'utf-8');
  console.log(`Pipeline complete. Saved ${allFinalMatches.length} leads to ${OUTPUT_FILE}`);
}

runPipeline().catch(console.error);
