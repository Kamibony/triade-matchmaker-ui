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

  const prompt = `Você é um investigador especializado no Terceiro Setor brasileiro e atua descobrindo a presença digital real de ONGs.
Sua missão é investigar a OSC "${nome}" (CNPJ: ${cnpj}).

IMPORTANTE: Você deve realizar pesquisas profundas e específicas usando a ferramenta do Google Search.
Realize buscas separadas combinando o nome da organização com as seguintes palavras-chave para encontrar informações valiosas:
1. Buscar: "${nome} Instagram" ou "${nome} Facebook" (Encontre as redes sociais ativas, especialmente o Instagram).
2. Buscar: "${nome} projetos sociais" ou "${nome} impacto" (Descubra o que eles realmente fazem na prática).
3. Buscar: "${nome} notícias" ou "${nome} parceria" (Busque menções na mídia local, parcerias com empresas ou editais recentes).

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

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    return json({ text: responseText });
  } catch (error: any) {
    console.error('Error generating dossier with Gemini:', error);
    return json({ error: error.message || 'Error generating dossier' }, { status: 500 });
  }
}
