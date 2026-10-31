import 'dotenv/config';
import fs from 'fs/promises';
import { calculateMatches } from '../src/lib/matcher.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const mockOSC = {
  nome: 'ASSOCIACAO QUILOMBOLA NEGROS FELICIANOS DO ALTO',
  idade_anos: 20,
  uf: 'RN',
  municipio: 'Portalegre',
  natureza_juridica: 'Associação Privada',
  foco_atividades: 'Atividades de associações de defesa de direitos sociais, assistência social, e organizações associativas ligadas à cultura e à arte.',
};

async function main() {
  console.log('Mock OSC:', mockOSC);

  // Phase 1: K.O. Filter
  console.log('\n--- Phase 1: K.O. Filter ---');
  const editaisData = JSON.parse(await fs.readFile('./src/data/editais_prosas.json', 'utf-8'));

  const eligibleEditais: any[] = [];
  let totalEligible = 0;

  for (const edital of editaisData) {
    if (!edital.deep_metadata || !edital.deep_metadata.criterios_eliminatorios) continue;

    // The calculateMatches function expects an array of NGOs
    const matchResult = calculateMatches(edital.deep_metadata, [mockOSC]);

    if (matchResult.length > 0 && matchResult[0].eligibility.isEligible) {
      eligibleEditais.push(edital);
      totalEligible++;
    }
  }

  console.log(`Found ${totalEligible} eligible editais after Phase 1.`);

  // Phase 2: Semantic Reranking with Chunking
  console.log('\n--- Phase 2: Semantic Reranking ---');

  if (!process.env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable.');
    process.exit(1);
  }

  const lightweightEditais = eligibleEditais.map(e => ({
    edital_id: e.id,
    titulo: e.attributes?.nome || e.id,
    resumo_objetivo: e.deep_metadata.resumo_objetivo,
    temas_principais: e.deep_metadata.temas_principais
  }));

  const CHUNK_SIZE = 15;
  const chunks: any[][] = [];
  for (let i = 0; i < lightweightEditais.length; i += CHUNK_SIZE) {
    chunks.push(lightweightEditais.slice(i, i + CHUNK_SIZE));
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });

  let allResults: any[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1} of ${chunks.length}...`);
    const chunk = chunks[i];

    const prompt = `
You are a Third Sector consultant. Your job is to match a Non-Governmental Organization (NGO/OSC) with the most suitable grant opportunities (editais) based on their profile and the grant's objective and themes.

Here is the profile of the OSC:
${JSON.stringify(mockOSC, null, 2)}

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
        allResults = allResults.concat(parsedResults);
      } else {
        console.error('Model returned non-array JSON:', parsedResults);
      }
    } catch (error) {
      console.error(`Error processing chunk ${i + 1}:`, error);
    }

    // Simple sleep to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // Display Results
  console.log('\n--- Final Top 5 Matches ---');
  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top5 = allResults.slice(0, 5);

  for (let i = 0; i < top5.length; i++) {
    const match = top5[i];
    const editalInfo = lightweightEditais.find(e => e.edital_id === match.edital_id);
    console.log(`\n#${i + 1} - Score: ${match.score}`);
    console.log(`Title: ${editalInfo ? editalInfo.titulo : match.edital_id}`);
    console.log(`Reason: ${match.motivo_match}`);
  }
}

main().catch(console.error);
