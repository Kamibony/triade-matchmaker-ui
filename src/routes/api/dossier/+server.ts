import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';

export async function POST({ request }: any) {
  const { cnpj, nome } = await request.json();

  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'dummy') {
    return json({ text: '### Dossiê Gerado (Mock)\n\n**Site Oficial:** https://example.com\n**Redes Sociais:** [Instagram](https://instagram.com)\n\n**Resumo de Projetos:**\n- Projeto mockado 1\n- Projeto mockado 2\n\n*(Nota: Este é um resultado de simulação pois a chave de API Gemini não está configurada)*' });
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash-lite',
    tools: [
      {
        // @ts-ignore - The type definitions in @google/generative-ai might be outdated, but googleSearch is correct for this API version
        googleSearch: {}
      }
    ]
  });

  const prompt = `Você é um pesquisador do terceiro setor. Faça uma busca na web pela OSC '${nome}' (CNPJ: ${cnpj}). Forneça: 1. Site oficial (se houver), 2. Links para Redes Sociais (Instagram, Facebook, LinkedIn), 3. Um breve resumo estruturado dos projetos mais recentes ou impacto social mencionados na mídia. Retorne a resposta em Markdown limpo.`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    return json({ text: responseText });
  } catch (error: any) {
    console.error('Error generating dossier with Gemini:', error);

    const isRateLimit = error.status === 429 ||
                        error.message?.includes('429') ||
                        error.message?.toLowerCase().includes('quota') ||
                        error.message?.toLowerCase().includes('rate');

    if (isRateLimit) {
      console.log('Falling back to ungrounded model due to quota limit...');
      try {
        const fallbackModel = genAI.getGenerativeModel({
          model: 'gemini-3.5-flash-lite'
        });
        const fallbackResult = await fallbackModel.generateContent(prompt);
        const fallbackText = fallbackResult.response.text().trim();
        return json({ text: fallbackText });
      } catch (fallbackError: any) {
        console.error('Error generating dossier with ungrounded model:', fallbackError);
        return json({ error: fallbackError.message || 'Error generating dossier' }, { status: 500 });
      }
    }

    return json({ error: error.message || 'Error generating dossier' }, { status: 500 });
  }
}
