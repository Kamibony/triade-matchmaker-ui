import { json } from '@sveltejs/kit';
import { calculateMatches } from '../../../lib/matcher';
import { GoogleGenerativeAI } from '@google/generative-ai';
import editaisData from '../../../data/editais_prosas.json';

function extractHeaderInfoFromFullText(fullText: string | undefined): { data_fim?: string; valor_total?: number } {
  if (!fullText) return {};
  const info: { data_fim?: string; valor_total?: number } = {};
  const match2Digit = fullText.match(/(\d{2})\/(\d{2})\/(\d{2})\s+at[ée]\s+(\d{2})\/(\d{2})\/(\d{2})/i);
  if (match2Digit) {
    info.data_fim = `20${match2Digit[6]}-${match2Digit[5]}-${match2Digit[4]}`;
  } else {
    const match4Digit = fullText.match(/Inscri[çc][õo]es a partir de:\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{2}:\d{2})?\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (match4Digit) {
      info.data_fim = `${match4Digit[6]}-${match4Digit[5]}-${match4Digit[4]}`;
    }
  }
  const valMatch = fullText.match(/Total Dispon[íi]vel\s+R\$\s*([\d\.]+,\d{2})/i);
  if (valMatch) {
    const parsedVal = parseFloat(valMatch[1].replace(/\./g, '').replace(',', '.'));
    if (!isNaN(parsedVal) && parsedVal > 0) {
      info.valor_total = parsedVal;
    }
  }
  return info;
}

const PORTUGUESE_STOPWORDS = new Set([
  'associacao', 'associacoes', 'direitos', 'sociais', 'social', 'atividades',
  'organizacoes', 'organizacao', 'defesa', 'desenvolvimento', 'projeto', 'projetos',
  'apoio', 'brasil', 'nacional', 'estadual', 'municipal', 'publico', 'publica',
  'selecao', 'chamamento', 'edital', 'fomento', 'recursos', 'execucao', 'acoes',
  'atraves', 'meio', 'forma', 'valor', 'instituicoes', 'entidades', 'civil',
  'sociedade', 'servicos', 'outros', 'outtras', 'especificados', 'anteriormente',
  'ligadas', 'privada', 'fundacao', 'instituto', 'comunitario', 'comunitaria'
]);

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isEditalSuitableForNgos(edital: any): boolean {
  const nomeNorm = normalizeText(edital.attributes?.nome || '');
  const resumoNorm = normalizeText(edital.deep_metadata?.resumo_objetivo || '');

  const nonNgoPatterns = [
    'bolsa ', 'bolsas ', 'pos-graduacao', 'iniciacao cientifica', 'pibex',
    'produtividade em pesquisa', 'catedra', 'subvencao economica',
    'inovacao para a industria', 'eficiencia energetica', 'pee/aneel',
    'cpp 001/', 'cpp 002/'
  ];
  if (nonNgoPatterns.some(p => nomeNorm.includes(p))) {
    return false;
  }

  if (resumoNorm.includes('exclusivamente para pessoas fisicas') || resumoNorm.includes('empresas juniores')) {
    return false;
  }

  return true;
}

export async function POST({ request }: any) {
  const requestBody = await request.json();
  const { cnpj, nome, foco_atividades, cnae_data, uf, municipio, natureza_juridica, idade_anos, dossier_text } = requestBody;

  const oscProfile: any = {
    cnpj,
    nome: nome || '',
    foco_atividades: `Descrição do usuário: ${foco_atividades || 'Não informada'}. Atividades oficiais registradas (CNAE): ${cnae_data || 'Não encontradas'}`,
    uf: uf || '',
    municipio: municipio || '',
    natureza_juridica: natureza_juridica || '',
    idade_anos: idade_anos || 0,
    dossier_web_context: dossier_text || ''
  };

  const eligibleEditais: any[] = [];

  const now = new Date();
  now.setDate(now.getDate() + 10);
  const options: Intl.DateTimeFormatOptions = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('pt-BR', options).formatToParts(now);
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  const thresholdString = `${year}-${month}-${day}`;

  for (const edital of editaisData) {
    if (!(edital as any).deep_metadata || !(edital as any).deep_metadata.criterios_eliminatorios) continue;

    if (!isEditalSuitableForNgos(edital)) continue;

    const headerInfo = extractHeaderInfoFromFullText((edital as any).full_text);
    const prazo = headerInfo.data_fim || (edital as any).deep_metadata.prazo_de_inscricao || (edital as any).attributes?.data_fim;
    const rawValor = (edital as any).deep_metadata.financeiro?.valor_maximo_ou_global_reais;
    const valor_maximo = (rawValor && rawValor >= 100 ? rawValor : null) ?? headerInfo.valor_total ?? (edital as any).attributes?.valor_total;

    if (valor_maximo === undefined || valor_maximo === null) {
      continue;
    }

    if (prazo && prazo.toLowerCase() !== 'não informado') {
      if (prazo < thresholdString) {
        continue;
      }
    }

    const matchResult = calculateMatches((edital as any).deep_metadata, [oscProfile]);

    if (matchResult.length > 0 && matchResult[0].eligibility.isEligible) {
      eligibleEditais.push({
        ...edital,
        _resolved_prazo: prazo,
        _resolved_valor: valor_maximo
      });
    }
  }

  // Phase 2: Local Heuristic Pre-Filter to select Top 30 candidates (prevents 15x parallel rate-limit spikes)
  const oscContextTokens = [
    ...new Set(
      normalizeText(`${nome || ''} ${foco_atividades || ''} ${cnae_data || ''} ${dossier_text || ''}`)
        .split(/[\s,.;:()/-]+/)
        .filter(w => w.length > 3 && !PORTUGUESE_STOPWORDS.has(w))
    )
  ];

  const preRankedEditais = eligibleEditais.map((e: any) => {
    const temasNorm = normalizeText((e.deep_metadata?.temas_principais || []).join(' '));
    const resumoNorm = normalizeText(`${e.attributes?.nome || ''} ${e.deep_metadata?.resumo_objetivo || ''}`);
    let localScore = 0;

    // Regional specificity bonus (state/municipal grants have less competition than national ones)
    if (!e.deep_metadata?.criterios_eliminatorios?.abrangencia_nacional) {
      localScore += 25;
    }

    for (const token of oscContextTokens) {
      if (temasNorm.includes(token)) {
        localScore += 40;
      } else if (resumoNorm.includes(token)) {
        localScore += 15;
      }
    }

    return { edital: e, localScore };
  });

  preRankedEditais.sort((a, b) => {
    if (b.localScore !== a.localScore) return b.localScore - a.localScore;
    const valA = a.edital._resolved_valor || a.edital.deep_metadata?.financeiro?.valor_maximo_ou_global_reais || 0;
    const valB = b.edital._resolved_valor || b.edital.deep_metadata?.financeiro?.valor_maximo_ou_global_reais || 0;
    return valB - valA;
  });

  const topCandidateEditais = preRankedEditais.slice(0, 30).map(item => item.edital);

  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'dummy') {
    return json([
      {
        edital_id: topCandidateEditais[0]?.id || 'mock1',
        titulo: topCandidateEditais[0]?.attributes?.nome || 'Mock Edital',
        score: 95,
        motivo_match: 'O foco em educação ambiental alinha perfeitamente com os objetivos deste edital.',
        pdf_url: (topCandidateEditais[0] as any)?.pdf_link || 'https://example.com/mock-pdf.pdf',
        deep_metadata: {
          drive_link: (topCandidateEditais[0] as any)?.deep_metadata?.drive_pdf_link
        },
        valor_maximo_reais: (topCandidateEditais[0] as any)?._resolved_valor || 100000,
        prazo_de_inscricao: (topCandidateEditais[0] as any)?._resolved_prazo || '2026-12-31'
      }
    ]);
  }

  const lightweightEditais = topCandidateEditais.map((e: any) => ({
    edital_id: e.id,
    titulo: e.attributes?.nome || e.id,
    resumo_objetivo: e.deep_metadata.resumo_objetivo,
    temas_principais: e.deep_metadata.temas_principais,
    pdf_url: e.pdf_link || null,
    deep_metadata: {
      drive_link: e.deep_metadata?.drive_pdf_link
    },
    valor_maximo_reais: e._resolved_valor ?? e.deep_metadata?.financeiro?.valor_maximo_ou_global_reais,
    prazo_de_inscricao: e._resolved_prazo ?? e.deep_metadata?.prazo_de_inscricao
  }));

  const CHUNK_SIZE = 15;
  const chunks: any[][] = [];
  for (let i = 0; i < lightweightEditais.length; i += CHUNK_SIZE) {
    chunks.push(lightweightEditais.slice(i, i + CHUNK_SIZE));
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json'
    }
  });

  let allResults: any[] = [];

  for (const chunk of chunks) {
    const prompt = `You are a Senior Third Sector Grant Consultant in Brazil.
Your job is to match a Non-Governmental Organization (NGO/OSC) with the most suitable grant opportunities (editais) based on their profile, activities, and Web Dossier.

Here is the profile of the OSC:
${JSON.stringify(oscProfile, null, 2)}

Here is a list of eligible grants:
${JSON.stringify(chunk.map(c => ({ edital_id: c.edital_id, titulo: c.titulo, resumo_objetivo: c.resumo_objetivo, temas_principais: c.temas_principais })), null, 2)}

Evaluate how well the OSC's profile (name, 'foco_atividades', CNAE, and 'dossier_web_context') matches each grant's 'resumo_objetivo' and 'temas_principais'.

Return ONLY a valid JSON array of objects, where each object contains:
- "edital_id": The ID of the grant.
- "score": A number between 0 and 100 representing the thematic match quality (100 is a perfect match).
- "motivo_match": A 1-2 sentence reasoning in Brazilian Portuguese (pt-BR) explaining why the score was given, citing specific evidence from the NGO's profile/dossier and the grant.`;

    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text().trim();
      const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      const parsedResults = JSON.parse(cleanedResponse);

      if (Array.isArray(parsedResults)) {
        allResults = allResults.concat(parsedResults);
      }
    } catch (error) {
      console.error('Error processing chunk:', error);
    }
  }

  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  const topMatches = allResults.slice(0, 8).map(match => {
    const editalInfo = lightweightEditais.find(e => String(e.edital_id) === String(match.edital_id));
    return {
      ...match,
      titulo: editalInfo ? editalInfo.titulo : match.edital_id,
      pdf_url: editalInfo ? editalInfo.pdf_url : null,
      deep_metadata: editalInfo ? editalInfo.deep_metadata : undefined,
      valor_maximo_reais: editalInfo ? editalInfo.valor_maximo_reais : null,
      prazo_de_inscricao: editalInfo ? editalInfo.prazo_de_inscricao : null
    };
  });

  return json(topMatches);
}
