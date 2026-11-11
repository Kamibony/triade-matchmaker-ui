import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';

export async function POST({ request }) {
  try {
    const { edital, osc } = await request.json();
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing in Vercel environment');
    }
    const genAI = new GoogleGenerativeAI(apiKey);

    // AI Model configs
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: 'v1beta' });
    const tools = [{ googleSearch: {} }];

    const fallbackModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      generationConfig: { temperature: 0, responseMimeType: "application/json" }
    });

    // --- Phase 3A: AI Web Dossiê ---
    let dossieText = "";
    try {
      const searchPrompt = `Gere um dossiê sobre a organização ${osc.nome} (CNPJ: ${osc.cnpj}) em ${osc.municipio}, ${osc.uf}. Pesquise no Google para descobrir seus projetos recentes, público-alvo, histórico de atuação e qualquer problema ou polêmica.`;
      const searchResult = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: searchPrompt }] }], tools: tools as any });
      dossieText = searchResult.response.text();
    } catch (e) {
      console.warn("A pesquisa no Google falhou, usando dossiê básico.");
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
        "whatsapp_message": "Mensagem curta, humana e atrativa de WhatsApp (em pt-BR) escrita por 'Maria Angela Bonifacio, Triade ACR' para a ONG. Elogie brevemente o trabalho da ONG usando algo do dossiê. Diga que você mapeou uma oportunidade de edital/financiamento no valor de até [INSERIR VALOR MÁXIMO DO EDITAL AQUI, se houver] voltado para [TEMA GERAL DA ONG/EDITAL]. REGRA CRÍTICA E ABSOLUTA: NUNCA, em hipótese alguma, escreva ou mencione o título, nome real ou a instituição do edital. Mantenha o nome do edital em total segredo. Termine perguntando se eles têm disponibilidade para uma breve conversa para apresentar os detalhes.",
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

    const resolvedContacts = {
      ...parsedMatch.contatos_encontrados,
      whatsapp: parsedMatch.contatos_encontrados?.whatsapp || osc.official_contacts?.ddd_telefone_1 || osc.official_contacts?.ddd_telefone_2 || null,
      email: parsedMatch.contatos_encontrados?.email || osc.official_contacts?.email || null
    };

    return json({
      edital_id: edital.id,
      edital_titulo: edital.titulo,
      edital_url: edital.public_url || edital.url,
      osc: osc,
      score: parsedMatch.score,
      motivo_match: parsedMatch.motivo_match,
      whatsapp_message: parsedMatch.whatsapp_message,
      contatos_encontrados: resolvedContacts,
      dossieText: dossieText
    });

  } catch (error: any) {
    console.error(error);
    return json({ error: error.message }, { status: 500 });
  }
}
