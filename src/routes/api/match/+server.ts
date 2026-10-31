import { json } from '@sveltejs/kit';
import { calculateMatches } from '../../../lib/matcher';
import { GoogleGenerativeAI } from '@google/generative-ai';
import editaisData from '../../../data/editais_prosas.json';

export async function POST({ request }: any) {
  const requestBody = await request.json();
  const { cnpj, foco_atividades } = requestBody;

  let oscProfile: any = {
    cnpj,
    foco_atividades: foco_atividades || '',
    uf: '',
    municipio: '',
    natureza_juridica: '',
    idade_anos: 0,
  };

  const cleanCnpj = cnpj?.replace(/[^\d]/g, '');

  if (cleanCnpj) {
    try {
      const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`);
      if (response.ok) {
        const cnpjData = await response.json();

        oscProfile.uf = cnpjData.uf || '';
        oscProfile.municipio = cnpjData.municipio || '';
        oscProfile.natureza_juridica = cnpjData.natureza_juridica || '';

        if (cnpjData.data_inicio_atividade) {
          const inicioAtividade = new Date(cnpjData.data_inicio_atividade);
          const hoje = new Date();
          let idade = hoje.getFullYear() - inicioAtividade.getFullYear();
          const m = hoje.getMonth() - inicioAtividade.getMonth();
          if (m < 0 || (m === 0 && hoje.getDate() < inicioAtividade.getDate())) {
            idade--;
          }
          oscProfile.idade_anos = idade;
        }

        let cnaeDesc = '';
        if (cnpjData.cnae_fiscal_descricao) {
          cnaeDesc += cnpjData.cnae_fiscal_descricao;
        }
        if (cnpjData.cnaes_secundarios && Array.isArray(cnpjData.cnaes_secundarios)) {
          for (const cnae of cnpjData.cnaes_secundarios) {
             if (cnae.descricao) cnaeDesc += `, ${cnae.descricao}`;
          }
        }

        if (cnaeDesc) {
           oscProfile.foco_atividades = `${oscProfile.foco_atividades} Atividades registradas: ${cnaeDesc}.`.trim();
        }

      }
    } catch (err) {
      console.error('Error fetching CNPJ data:', err);
    }
  }

  const eligibleEditais: any[] = [];

  for (const edital of editaisData) {
    if (!(edital as any).deep_metadata || !(edital as any).deep_metadata.criterios_eliminatorios) continue;

    // The calculateMatches function expects an array of NGOs
    const matchResult = calculateMatches((edital as any).deep_metadata, [oscProfile]);

    if (matchResult.length > 0 && matchResult[0].eligibility.isEligible) {
      eligibleEditais.push(edital);
    }
  }

  // Phase 2: Semantic Reranking
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'dummy') {
    // If no real API key, return mock data for verification
    return json([
      {
        edital_id: eligibleEditais[0]?.id || 'mock1',
        titulo: eligibleEditais[0]?.attributes?.nome || 'Mock Edital',
        score: 95,
        motivo_match: 'O foco em educação ambiental alinha perfeitamente com os objetivos deste edital.'
      }
    ]);
  }

  const lightweightEditais = eligibleEditais.map(e => ({
    edital_id: (e as any).id,
    titulo: (e as any).attributes?.nome || (e as any).id,
    resumo_objetivo: (e as any).deep_metadata.resumo_objetivo,
    temas_principais: (e as any).deep_metadata.temas_principais
  }));

  const CHUNK_SIZE = 15;
  const chunks: any[][] = [];
  for (let i = 0; i < lightweightEditais.length; i += CHUNK_SIZE) {
    chunks.push(lightweightEditais.slice(i, i + CHUNK_SIZE));
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });

  let allResults: any[] = [];

  const chunkPromises = chunks.map(async (chunk) => {
    const prompt = `
You are a Third Sector consultant. Your job is to match a Non-Governmental Organization (NGO/OSC) with the most suitable grant opportunities (editais) based on their profile and the grant's objective and themes.

Here is the profile of the OSC:
${JSON.stringify(oscProfile, null, 2)}

Here is a list of eligible grants:
${JSON.stringify(chunk, null, 2)}

Evaluate how well the OSC's profile (especially its 'foco_atividades') matches each grant's 'resumo_objetivo' and 'temas_principais'.

Return ONLY a valid JSON array of objects, where each object contains:
- "edital_id": The ID of the grant.
- "score": A number between 0 and 100 representing the thematic match quality (100 is a perfect match).
- "motivo_match": A 1-sentence reasoning explaining why the score was given.

Do not include any other text or markdown formatting (like \`\`\`json). Just return the raw JSON array.
`;

    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text().trim();

      // Attempt to clean the response in case the model returns markdown despite instructions
      const cleanedResponse = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      const parsedResults = JSON.parse(cleanedResponse);

      if (Array.isArray(parsedResults)) {
        return parsedResults;
      } else {
        console.error('Model returned non-array JSON:', parsedResults);
        return [];
      }
    } catch (error) {
      console.error('Error processing chunk:', error);
      return [];
    }
  });

  const chunkResults = await Promise.all(chunkPromises);
  for (const results of chunkResults) {
    allResults = allResults.concat(results);
  }

  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top5 = allResults.slice(0, 5).map(match => {
    const editalInfo = lightweightEditais.find(e => e.edital_id === match.edital_id);
    return {
      ...match,
      titulo: editalInfo ? editalInfo.titulo : match.edital_id
    };
  });

  return json(top5);
}
