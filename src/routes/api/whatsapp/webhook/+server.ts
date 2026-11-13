import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { normalizeBrazilPhone, sendWhatsAppText } from '$lib/server/whatsapp-gateway';
import dailyLeadsData from '../../../../data/daily_outbound_leads.json';
import editaisData from '../../../../data/editais_prosas.json';

function extractIncomingPayload(body: any): {
  senderPhone: string | null;
  incomingText: string | null;
  fromMe: boolean;
  senderName?: string;
} {
  // 1. Direct / UI Simulator payload
  if (body?.simulator || body?.incomingText) {
    return {
      senderPhone: body.phone || body.lead?.contatos_encontrados?.whatsapp || body.lead?.osc?.official_contacts?.ddd_telefone_1 || '5511999999999',
      incomingText: body.incomingText,
      fromMe: false,
      senderName: body.lead?.osc?.nome || body.senderName
    };
  }

  // 2. Whapi.cloud webhook format (messages array)
  if (Array.isArray(body?.messages) && body.messages[0]) {
    const msg = body.messages[0];
    return {
      senderPhone: (msg.chat_id || msg.from || '').split('@')[0],
      incomingText: msg.text?.body || msg.voice?.caption || '[Áudio/Mídia recebido no WhatsApp]',
      fromMe: !!msg.from_me,
      senderName: msg.from_name
    };
  }

  // 3. Evolution API v1/v2 webhook format (messages.upsert)
  if (body?.data?.key?.remoteJid) {
    const jid: string = body.data.key.remoteJid;
    const fromMe = !!body.data.key.fromMe;
    const senderPhone = jid.split('@')[0];
    const msgObj = body.data.message || {};
    const text =
      msgObj.conversation ||
      msgObj.extendedTextMessage?.text ||
      msgObj.audioMessage?.caption ||
      body.data?.body ||
      null;
    return {
      senderPhone,
      incomingText: text,
      fromMe,
      senderName: body.data.pushName
    };
  }

  // 4. Z-API webhook format
  if (body?.phone && (body?.text?.message || body?.audio?.audioUrl)) {
    return {
      senderPhone: body.phone,
      incomingText: body.text?.message || '[Áudio recebido no WhatsApp]',
      fromMe: !!body.fromMe,
      senderName: body.senderName
    };
  }

  // 5. Green-API webhook format
  if (body?.senderData?.chatId && body?.messageData) {
    return {
      senderPhone: body.senderData.chatId.split('@')[0],
      incomingText:
        body.messageData.textMessageData?.textMessage ||
        body.messageData.extendedTextMessageData?.text ||
        null,
      fromMe: body.typeWebhook === 'outgoingMessageReceived' || body.typeWebhook === 'outgoingAPIMessageReceived',
      senderName: body.senderData.senderName
    };
  }

  // 6. Meta Official WhatsApp Cloud API format
  const metaChange = body?.entry?.[0]?.changes?.[0]?.value;
  if (metaChange?.messages?.[0]) {
    const msg = metaChange.messages[0];
    return {
      senderPhone: msg.from,
      incomingText: msg.text?.body || '[Mídia/Áudio recebido]',
      fromMe: false,
      senderName: metaChange.contacts?.[0]?.profile?.name
    };
  }

  return { senderPhone: null, incomingText: null, fromMe: false };
}

function findMatchingLeadByPhone(rawPhone: string | null, explicitLead?: any) {
  if (explicitLead) return explicitLead;
  if (!rawPhone) return null;
  const normalizedTarget = normalizeBrazilPhone(rawPhone);
  if (!normalizedTarget) return null;
  const last8 = normalizedTarget.slice(-8);

  const leadsArray = Array.isArray(dailyLeadsData) ? dailyLeadsData : [];
  for (const lead of leadsArray) {
    const candidateRaw =
      (lead as any).contatos_encontrados?.whatsapp ||
      (lead as any).osc?.official_contacts?.ddd_telefone_1 ||
      (lead as any).osc?.official_contacts?.ddd_telefone_2;
    const normCandidate = normalizeBrazilPhone(candidateRaw);
    if (normCandidate && normCandidate.slice(-8) === last8) {
      return lead;
    }
  }
  return null;
}

export async function GET({ url }) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && challenge) {
    const expectedToken = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'triade_verify_token';
    if (token === expectedToken) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  return json({
    status: 'active',
    webhook: '/api/whatsapp/webhook',
    supportedProviders: ['whapi', 'zapi', 'evolution', 'greenapi', 'meta', 'simulator']
  });
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const { senderPhone, incomingText, fromMe, senderName } = extractIncomingPayload(body);

    if (fromMe) {
      return json({ ok: true, ignored: true, reason: 'Mensagem enviada pelo próprio número (fromMe).' });
    }

    if (!incomingText) {
      return json({ ok: true, ignored: true, reason: 'Nenhum texto de mensagem identificado no evento.' });
    }

    const matchedLead = findMatchingLeadByPhone(senderPhone, body.lead);
    const editaisArray = Array.isArray(editaisData) ? editaisData : [];
    const matchedEdital = matchedLead
      ? editaisArray.find((e: any) => String(e.id) === String(matchedLead.edital_id))
      : null;

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY não configurada no ambiente.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const sdrModel = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash-lite',
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    });

    const orgNome = matchedLead?.osc?.nome || senderName || 'Organização';
    const orgCidade = matchedLead?.osc?.municipio ? `${matchedLead.osc.municipio}/${matchedLead.osc.uf}` : 'Brasil';
    const editalValor = matchedLead?.edital_valor || matchedEdital?.deep_metadata?.valor_maximo_ou_global_reais || 'valor expressivo';
    const editalPrazo = matchedLead?.edital_prazo || matchedEdital?.deep_metadata?.prazo_de_inscricao || 'inscrições abertas';
    const editalResumo = matchedEdital?.deep_metadata?.resumo_objetivo || matchedLead?.motivo_match || 'Edital voltado para projetos de impacto social.';
    const conversationHistory = Array.isArray(body.history)
      ? body.history.map((h: any) => `${h.role === 'ong' ? 'ONG' : 'Triade'}: ${h.text}`).join('\n')
      : '';

    const sdrPrompt = `
Você é o Assistente de Triagem e Captação da consultora sênior **Maria Angela Bonifacio**, da **Triade ACR (Assessoria em Captação de Recursos)** no WhatsApp.

CONTEXTO DO LEAD (ONG QUE ESTÁ RESPONDENDO):
- Nome da ONG: ${orgNome} (${orgCidade})
- Score do Match: ${matchedLead?.score || 'N/A'}%
- Motivo do Match com a ONG: ${matchedLead?.motivo_match || 'Atuação compatível com o edital'}
- Dossiê da ONG: ${matchedLead?.dossieText || 'N/A'}

DADOS DO EDITAL MAPEADO (CONFIDENCIAL):
- Título Interno (SEGREDO ABSOLUTO): ${matchedLead?.edital_titulo || matchedEdital?.titulo || 'Edital de Fomento'}
- Valor do Edital: R$ ${editalValor}
- Prazo de Inscrição: ${editalPrazo}
- Resumo e Requisitos: ${editalResumo}

HISTÓRICO ANTERIOR DA CONVERSA:
${conversationHistory || '(Primeiro retorno da ONG após nossa mensagem inicial)'}

MENSAGEM QUE A ONG ACABOU DE ENVIAR NO WHATSAPP:
"${incomingText}"

REGRAS DE OURO DA TRIADE ACR (OBRIGATÓRIAS):
1. SEGREDO DO EDITAL: NUNCA, em hipótese alguma, revele o nome oficial do edital ou o nome da fundação/empresa patrocinadora pelo WhatsApp. Se a ONG perguntar "Qual é o edital?" ou "Quem está financiando?", explique com muita simpatia que, por política da consultoria, a Maria Angela apresenta o edital completo e valida gratuitamente a elegibilidade documental/estatutária da ONG em uma conversa rápida de 10 minutos (por telefone ou vídeo).
2. Se a ONG perguntar se pode receber o resumo (ex: respondeu "Pode sim!", "Manda aí", "Como funciona?"), envie os detalhes atrativos (valor até R$ ${editalValor}, prazo em ${editalPrazo}, foco do projeto compatível com a atuação deles em ${orgCidade}, e explique que a Triade ACR cuida de toda a elaboração técnica do projeto) e convide para um bate-papo rápido de 10 min com a Maria Angela hoje ou amanhã.
3. Se a ONG demonstrar falta de interesse clara ("Não temos interesse", "Pare de mandar mensagem"), agradeça educadamente, deseje sucesso aos projetos da instituição e encerre.
4. O tom deve ser humano, caloroso, profissional, curto (formato WhatsApp, máximo 3 parágrafos curtos) e em português brasileiro.

Responda ESTRITAMENTE em JSON com esta estrutura:
{
  "intent": "interested" | "question" | "asking_grant_name" | "not_interested" | "human_handoff",
  "intent_label": "Rótulo curto em português (ex: '🔥 Interesse Confirmado', '❓ Dúvida sobre Prazo/Como funciona', '🔒 Pediu Nome do Edital', '🛑 Sem Interesse')",
  "confidence": (número de 0 a 100),
  "analysis": "Explicação curta de 1 frase para a Maria Angela sobre o que a ONG quis dizer e qual o próximo passo",
  "crm_status": "negotiating" | "contacted" | "archived",
  "should_auto_reply": true | false,
  "should_notify_angela": true | false,
  "reply_message": "Texto exato da resposta para enviar à ONG no WhatsApp (respeitando 100% o segredo do nome do edital)",
  "angela_alert": "Resumo curto para notificar o WhatsApp pessoal da Maria Angela (ex: '🔥 Angela! A ONG X respondeu com interesse no edital de R$ Y! Mensagem deles: ...')"
}
`;

    const aiRes = await sdrModel.generateContent(sdrPrompt);
    const parsed = JSON.parse(aiRes.response.text());

    let autoReplyDispatch = null;
    let angelaAlertDispatch = null;

    const allowAutoSend = body.autoSendReply !== false;
    if (allowAutoSend && parsed.should_auto_reply && parsed.reply_message && senderPhone && !body.simulator) {
      autoReplyDispatch = await sendWhatsAppText(senderPhone, parsed.reply_message, {
        simulateTypingMs: 4000,
        overrideConfig: body.overrideConfig
      });
    }

    const angelaPhone = env.ANGELA_NOTIFY_PHONE;
    if (angelaPhone && parsed.should_notify_angela && parsed.angela_alert && !body.simulator) {
      angelaAlertDispatch = await sendWhatsAppText(angelaPhone, parsed.angela_alert, {
        simulateTypingMs: 1000,
        overrideConfig: body.overrideConfig
      });
    }

    return json({
      ok: true,
      senderPhone: normalizeBrazilPhone(senderPhone),
      matchedOrg: orgNome,
      matchedScore: matchedLead?.score || null,
      matchedUf: matchedLead?.osc?.uf || null,
      matchedEditalId: matchedLead?.edital_id || null,
      incomingText,
      sdrResult: parsed,
      autoReplyDispatch,
      angelaAlertDispatch
    });
  } catch (error: any) {
    console.error('Erro no Webhook WhatsApp IA SDR:', error);
    return json({ ok: false, error: error.message || 'Erro interno no Webhook WhatsApp.' }, { status: 500 });
  }
}
