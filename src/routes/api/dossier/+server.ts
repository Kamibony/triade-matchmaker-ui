import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';

const CACHE_PATH = path.join(process.cwd(), 'src', 'data', 'cnpj_cache.json');

export async function POST({ request }: any) {
  const { cnpj, nome, municipio, uf } = await request.json();
  const cleanCnpj = (cnpj || '').replace(/\D/g, '');

  // 1. Check local CNPJ cache first ($0 cost if already generated)
  if (cleanCnpj) {
    try {
      const rawCache = await fs.readFile(CACHE_PATH, 'utf-8');
      const cache = JSON.parse(rawCache);
      const cachedDossier = cache[cleanCnpj]?.dossieText;
      if (cachedDossier && cachedDossier.length > 80 && !cachedDossier.includes('indisponível')) {
        return json({ text: cachedDossier, cached: true });
      }
    } catch {
      // Cache read is optional on serverless
    }
  }

  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'dummy') {
    return json({
      text: '### Dossiê Gerado (Mock)\n\n**Site Oficial:** https://example.com\n**Redes Sociais:** [Instagram](https://instagram.com)\n\n**Resumo de Projetos:**\n- Projeto mockado 1\n- Projeto mockado 2\n\n*(Nota: Este é um resultado de simulação pois a chave de API Gemini não está configurada)*'
    });
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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

  const locationContext = municipio && uf ? `localizada em ${municipio} - ${uf}` : (uf ? `no estado ${uf}` : '');

  // Single concise search query to prevent multi-query billing spikes and avoid homonym NGO confusion
  const prompt = `Você é um analista especializado no Terceiro Setor brasileiro.
Sua missão é investigar a OSC "${nome}" ${locationContext} (CNPJ: ${cnpj}).

IMPORTANTE: Faça UMA ÚNICA busca objetiva no Google combinando o nome da organização "${nome}" e a cidade "${municipio || ''}" para não confundir com organizações homônimas de outros estados.

Com base nos resultados encontrados, elabore um "Dossiê Web" em formato Markdown limpo e estruturado contendo:

### 🌐 Presença Digital e Contatos
- **Site Oficial / Redes Sociais:** (Informe links de site, Instagram ou Facebook se encontrados)
- **Status Digital:** (Avalie brevemente se a organização possui presença digital ativa)

### 🎯 Impacto Real e Atuação Prática
- Descreva o que a organização faz na prática, suas atividades principais e o público atendido.

### 🚀 Projetos Recentes e Parcerias
- Liste projetos conhecidos, ações comunitárias, menções na mídia ou parcerias públicas/privadas.

Seja direto, factual e focado em fornecer insumos úteis para um consultor de captação de recursos.`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    return json({ text: responseText, cached: false });
  } catch (error: any) {
    console.error('Error generating dossier with Gemini:', error);
    return json({ error: error.message || 'Error generating dossier' }, { status: 500 });
  }
}
