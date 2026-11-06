import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';

export async function POST({ request }) {
  try {
    const { edital, osc } = await request.json();
    const apiKey = env.GEMINI_API_KEY || 'dummy';
    const genAI = new GoogleGenerativeAI(apiKey);

    // AI Model configs
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: 'v1beta' });
    const tools = [{ googleSearch: {} }];

    const fallbackModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      generationConfig: { temperature: 0, responseMimeType: "application/json" }
    });

    if (apiKey === 'dummy') {
       return json({
          edital_id: edital.id,
          edital_titulo: edital.titulo,
          osc: osc,
          score: 85,
          motivo_match: "MOCK: Match simulado por falta de API key.",
          whatsapp_message: "Olá, temos um edital interessante.",
          dossieText: "MOCK: Dossiê não gerado."
       });
    }

    // --- Phase 3A: AI Web Dossiê ---
    let dossieText = "";
    try {
      const searchPrompt = `Gere um dossiê sobre a organização ${osc.nome} (CNPJ: ${osc.cnpj}) em ${osc.municipio}, ${osc.uf}. Pesquise no Google para descobrir seus projetos recentes, público-alvo, histórico de atuação e qualquer problema ou polêmica.`;
      const searchResult = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: searchPrompt }] }], tools: tools as any });
      dossieText = searchResult.response.text();
    } catch (e) {
      console.warn("Google Search failed, fallback to basic dossier.");
      dossieText = `Dossiê básico: Organização focada em ${osc.cnae_primario_descricao}, localizada em ${osc.municipio}.`;
    }

    // --- Phase 3B: AI Match Evaluation ---
    const evalPrompt = `
      Você é um especialista em captação de recursos. Avalie se a OSC tem fit com este Edital.

      EDITAL:
      Título: ${edital.titulo}
      Temas: ${edital.temas_principais?.join(', ')}
      Resumo: ${edital.resumo_objetivo}
      Valor Máximo: ${edital.valor_maximo_ou_global_reais}

      OSC:
      Nome: ${osc.nome}
      CNAE: ${osc.cnae_primario_descricao}
      Natureza: ${osc.natureza_juridica}
      Dossiê Web: ${dossieText}

      Responda ESTRITAMENTE em JSON:
      {
        "score": (0 a 100),
        "motivo_match": "Explique o porquê do match usando evidências do dossiê e do edital",
        "whatsapp_message": "Mensagem curta para enviar no WhatsApp da ONG se apresentando e falando do edital",
        "contatos_encontrados": { "whatsapp": "número se achou no dossiê", "email": "email", "instagram": "url" }
      }
    `;

    const evalResult = await fallbackModel.generateContent(evalPrompt);
    let parsedMatch;
    try {
        parsedMatch = JSON.parse(evalResult.response.text());
    } catch (e) {
        throw new Error('Falha ao analisar a resposta JSON do Gemini.');
    }

    return json({
      edital_id: edital.id,
      edital_titulo: edital.titulo,
      osc: osc,
      score: parsedMatch.score,
      motivo_match: parsedMatch.motivo_match,
      whatsapp_message: parsedMatch.whatsapp_message,
      contatos_encontrados: parsedMatch.contatos_encontrados,
      dossieText: dossieText
    });

  } catch (error: any) {
    console.error(error);
    return json({ error: error.message }, { status: 500 });
  }
}
