import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { normalizeBrazilPhone, sendWhatsAppText } from '$lib/server/whatsapp-gateway';
import { logWhatsAppWebhookEvent } from '$lib/server/whatsapp-monitor';
import { detectOptOutCommand, isPhoneOptedOut, recordOptOutPhone } from '$lib/server/whatsapp-optout';
import dailyLeadsData from '../../../../data/daily_outbound_leads.json';
import editaisData from '../../../../data/editais_prosas.json';

const REPLY_COOLDOWN_MS = 60_000;
const MAX_REPLIES_WINDOW_MS = 30 * 60_000;
const MAX_REPLIES_PER_WINDOW = 3;
const recentRepliesByPhone = new Map<string, number[]>();

function isRateLimitedOrLooped(normalizedPhone: string | null): { blocked: boolean; reason?: string } {
  if (!normalizedPhone) return { blocked: true, reason: 'Telefone inválido.' };
  const now = Date.now();
  const timestamps = (recentRepliesByPhone.get(normalizedPhone) || []).filter(
    (ts) => now - ts < MAX_REPLIES_WINDOW_MS
  );
  recentRepliesByPhone.set(normalizedPhone, timestamps);

  const lastReply = timestamps[timestamps.length - 1];
  if (lastReply && now - lastReply < REPLY_COOLDOWN_MS) {
    return { blocked: true, reason: `Cooldown ativo (${Math.ceil((REPLY_COOLDOWN_MS - (now - lastReply)) / 1000)}s restantes).` };
  }
  if (timestamps.length >= MAX_REPLIES_PER_WINDOW) {
    return { blocked: true, reason: `Limite anti-loop atingido (${MAX_REPLIES_PER_WINDOW} respostas nos últimos 30 min).` };
  }
  return { blocked: false };
}

function recordAutoReply(normalizedPhone: string | null) {
  if (!normalizedPhone) return;
  const now = Date.now();
  const timestamps = (recentRepliesByPhone.get(normalizedPhone) || []).filter(
    (ts) => now - ts < MAX_REPLIES_WINDOW_MS
  );
  timestamps.push(now);
  recentRepliesByPhone.set(normalizedPhone, timestamps);
}

function extractIncomingPayload(body: any): {
  senderPhone: string | null;
  rawChatId?: string | null;
  incomingText: string | null;
  fromMe: boolean;
  senderName?: string;
} {
  // 1. Direct / UI Simulator payload
  if (body?.simulator || body?.incomingText) {
    return {
      senderPhone: body.phone || body.lead?.contatos_encontrados?.whatsapp || body.lead?.osc?.official_contacts?.ddd_telefone_1 || '5511999999999',
      rawChatId: null,
      incomingText: body.incomingText,
      fromMe: false,
      senderName: body.lead?.osc?.nome || body.senderName
    };
  }

  // 2. Whapi.cloud webhook format (messages array)
  if (Array.isArray(body?.messages) && body.messages[0]) {
    const msg = body.messages[0];
    const chatId = msg.chat_id || msg.from || '';
    let contactSummary: string | null = null;
    const contactObj = msg.contact || (Array.isArray(msg.contacts) ? msg.contacts[0] : null);
    if (contactObj) {
      const cName = contactObj.name || 'Contato';
      const vcard = String(contactObj.vcard || '');
      const waidMatch = vcard.match(/waid=(\d+)/i) || vcard.match(/TEL[^:]*:([+\d\s()-]+)/i);
      const cPhone = waidMatch ? waidMatch[1].replace(/\D/g, '') : '';
      contactSummary = `[Contato compartilhado: ${cName}${cPhone ? ` - Tel: ${cPhone}` : ''}]`;
    }
    return {
      senderPhone: chatId.split('@')[0],
      rawChatId: chatId,
      incomingText: msg.text?.body || msg.voice?.caption || contactSummary || null,
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
      rawChatId: jid,
      incomingText: text,
      fromMe,
      senderName: body.data.pushName
    };
  }

  // 4. Z-API webhook format
  if (body?.phone && (body?.text?.message || body?.audio?.audioUrl)) {
    return {
      senderPhone: body.phone,
      rawChatId: body.chatId || null,
      incomingText: body.text?.message || null,
      fromMe: !!body.fromMe,
      senderName: body.senderName
    };
  }

  // 5. Green-API webhook format
  if (body?.senderData?.chatId && body?.messageData) {
    return {
      senderPhone: body.senderData.chatId.split('@')[0],
      rawChatId: body.senderData.chatId,
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
      rawChatId: msg.from,
      incomingText: msg.text?.body || null,
      fromMe: false,
      senderName: metaChange.contacts?.[0]?.profile?.name
    };
  }

  return { senderPhone: null, rawChatId: null, incomingText: null, fromMe: false };
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

const SYSTEM_FAILURE_APOLOGY_MSG =
  'Olá! Aqui é da equipe da Maria Angela Bonifácio, da Tríade ACR. Tivemos uma instabilidade momentânea no nosso sistema de atendimento agora e peço desculpas! Já registramos sua mensagem e nossa consultora retornará em breve por aqui em horário comercial (dias úteis).';

function formatEditalValorPtBr(rawValor: unknown): string {
  if (typeof rawValor === 'number' && Number.isFinite(rawValor) && rawValor > 0) {
    if (rawValor >= 1_000_000) {
      return `R$ ${(rawValor / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} milhões`;
    }
    if (rawValor >= 1_000) {
      return `R$ ${(rawValor / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
    }
    return `R$ ${rawValor.toLocaleString('pt-BR')}`;
  }
  if (typeof rawValor === 'string' && rawValor.trim()) {
    const trimmed = rawValor.trim();
    return trimmed.startsWith('R$') ? trimmed : `R$ ${trimmed}`;
  }
  return 'valor expressivo';
}

function parseGeminiJsonResponse(rawText: string): any {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

export async function POST({ request }) {
  let parsedBody: any = null;
  let senderPhone: string | null = null;
  let rawChatId: string | null | undefined = null;
  let incomingText: string | null = null;
  let fromMe = false;
  let senderName: string | undefined;
  let isSimulator = false;
  let matchedLead: any = null;
  let normalizedSender: string | null = null;

  try {
    parsedBody = await request.json();
    const extracted = extractIncomingPayload(parsedBody);
    senderPhone = extracted.senderPhone;
    rawChatId = extracted.rawChatId;
    incomingText = extracted.incomingText;
    fromMe = extracted.fromMe;
    senderName = extracted.senderName;

    if (fromMe) {
      return json({ ok: true, ignored: true, reason: 'Mensagem enviada pelo próprio número (fromMe).' });
    }

    if (
      rawChatId &&
      (rawChatId.includes('@g.us') ||
        rawChatId.includes('@broadcast') ||
        rawChatId.includes('@newsletter') ||
        rawChatId.includes('status@'))
    ) {
      return json({ ok: true, ignored: true, reason: 'Mensagem de grupo, canal ou status ignorada.' });
    }

    if (!incomingText) {
      return json({ ok: true, ignored: true, reason: 'Nenhum texto de mensagem identificado no evento.' });
    }

    isSimulator = !!parsedBody.simulator;
    matchedLead = findMatchingLeadByPhone(senderPhone, parsedBody.lead);
    normalizedSender = normalizeBrazilPhone(senderPhone);
    const earlyOrgNome = matchedLead?.osc?.nome || senderName || 'Organização';

    // Bloqueio permanente: se já está em Opt-Out (PARAR) ou CESAR, ignora imediatamente
    const existingOptOut = await isPhoneOptedOut(normalizedSender || senderPhone);
    if (existingOptOut.blocked) {
      if (!isSimulator) {
        await logWhatsAppWebhookEvent({
          eventType: 'ignored',
          isSimulator,
          phone: normalizedSender || senderPhone,
          orgNome: earlyOrgNome,
          editalId: matchedLead?.edital_id || null,
          incomingText,
          detail: existingOptOut.reason
        });
      }
      return json({
        ok: true,
        ignored: true,
        blockedByOptOut: true,
        reason: existingOptOut.reason
      });
    }

    // Tratamento determinístico de PARAR (Opt-Out permanente)
    if (detectOptOutCommand(incomingText)) {
      const optOutRecord = !isSimulator
        ? await recordOptOutPhone({
            phone: normalizedSender || senderPhone,
            orgNome: earlyOrgNome,
            reason: incomingText
          })
        : { ok: true, recordedToSheets: false };

      const optOutReply =
        'Combinado! Já registramos seu pedido (PARAR) e bloqueamos seu número para não receber novas mensagens da Tríade ACR (@triade_acr). Desejamos muito sucesso ao trabalho de vocês!';

      const envAutoReplyEnabled =
        (env.WHATSAPP_AUTOREPLY_ENABLED || process.env.WHATSAPP_AUTOREPLY_ENABLED || 'true').toLowerCase() !== 'false';

      let optOutReplyDispatch: any = null;
      if (!isSimulator && envAutoReplyEnabled && parsedBody.autoSendReply !== false && senderPhone) {
        optOutReplyDispatch = await sendWhatsAppText(senderPhone, optOutReply, {
          simulateTypingMs: 2500,
          overrideConfig: parsedBody.overrideConfig,
          bypassOptOutCheck: true // envia apenas esta última confirmação de remoção
        });
      }

      const angelaPhone = env.ANGELA_NOTIFY_PHONE || process.env.ANGELA_NOTIFY_PHONE;
      if (!isSimulator && envAutoReplyEnabled && angelaPhone) {
        await sendWhatsAppText(
          angelaPhone,
          `🛑 OPT-OUT (PARAR): ${earlyOrgNome} (+${normalizedSender || senderPhone}) respondeu "${incomingText}" e foi bloqueado permanentemente na aba Opt_Out.`,
          { simulateTypingMs: 1000, overrideConfig: parsedBody.overrideConfig }
        ).catch(() => {});
      }

      const monitor = await logWhatsAppWebhookEvent({
        eventType: 'opt_out',
        isSimulator,
        phone: normalizedSender || senderPhone,
        orgNome: earlyOrgNome,
        editalId: matchedLead?.edital_id || null,
        intent: 'opt_out',
        crmStatus: 'archived',
        incomingText,
        replyMessage: optOutReplyDispatch?.ok ? optOutReply : `[Opt-Out registrado] ${optOutReply}`,
        detail: `PARAR detectado | Sheets Opt_Out: ${optOutRecord.recordedToSheets}`
      });

      return json({
        ok: true,
        optOutRecorded: true,
        recordedToSheets: optOutRecord.recordedToSheets,
        senderPhone: normalizedSender,
        matchedOrg: earlyOrgNome,
        incomingText,
        sdrResult: {
          intent: 'opt_out',
          intent_label: '🛑 Opt-Out Permanente (PARAR)',
          crm_status: 'archived',
          should_auto_reply: true,
          should_notify_angela: true,
          reply_message: optOutReply,
          analysis: 'Contato respondeu PARAR e foi gravado na aba Opt_Out para bloqueio definitivo.'
        },
        autoReplyDispatch: optOutReplyDispatch,
        monitor
      });
    }

    if (!isSimulator && !matchedLead) {
      const reason = 'Remetente não está na lista de leads abordados (ex: contato pessoal, Claro/operadora ou número desconhecido).';
      await logWhatsAppWebhookEvent({
        eventType: 'ignored',
        isSimulator,
        phone: normalizedSender || senderPhone,
        orgNome: senderName || null,
        incomingText,
        detail: reason
      });
      return json({
        ok: true,
        ignored: true,
        reason
      });
    }

    if (!isSimulator) {
      const rateCheck = isRateLimitedOrLooped(normalizedSender);
      if (rateCheck.blocked) {
        await logWhatsAppWebhookEvent({
          eventType: 'ignored',
          isSimulator,
          phone: normalizedSender || senderPhone,
          orgNome: matchedLead?.osc?.nome || senderName || null,
          editalId: matchedLead?.edital_id || null,
          incomingText,
          detail: rateCheck.reason
        });
        return json({ ok: true, ignored: true, reason: rateCheck.reason });
      }
    }

    const editaisArray = Array.isArray(editaisData) ? editaisData : [];
    const matchedEdital: any = matchedLead
      ? editaisArray.find((e: any) => String(e.id) === String(matchedLead.edital_id))
      : null;

    const apiKey = env.GEMINI_API_KEY || (env as any).GENINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GENINI_API_KEY;
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
    const rawEditalValor =
      matchedLead?.edital_valor ||
      matchedEdital?.attributes?.valor_total ||
      matchedEdital?.deep_metadata?.financeiro?.valor_maximo_ou_global_reais ||
      matchedEdital?.deep_metadata?.financeiro?.valor_total_edital ||
      null;
    const editalValorText = formatEditalValorPtBr(rawEditalValor);
    const editalPrazo =
      matchedLead?.edital_prazo ||
      matchedEdital?.deep_metadata?.prazo_de_inscricao ||
      matchedEdital?.attributes?.data_fim ||
      'inscrições abertas';
    const editalTitulo =
      matchedLead?.edital_titulo ||
      matchedEdital?.attributes?.nome ||
      matchedEdital?.titulo ||
      'Edital de Fomento';
    const editalId = matchedLead?.edital_id || matchedEdital?.id || '';
    const editalResumo =
      matchedEdital?.deep_metadata?.resumo_objetivo ||
      matchedLead?.motivo_match ||
      'Edital voltado para projetos de impacto social.';
    const editalLink =
      matchedEdital?.deep_metadata?.drive_pdf_link ||
      matchedEdital?.public_url ||
      '';
    const conversationHistory = Array.isArray(parsedBody.history)
      ? parsedBody.history.map((h: any) => `${h.role === 'ong' ? 'ONG' : 'Triade'}: ${h.text}`).join('\n')
      : '';

    const sdrPrompt = `
Você é o Assistente de Triagem e Captação da consultora sênior **Maria Angela Bonifacio**, da **Triade ACR (Assessoria em Captação de Recursos)** no WhatsApp.

CONTEXTO DO LEAD (ONG QUE ESTÁ RESPONDENDO):
- Nome da ONG: ${orgNome} (${orgCidade})
- Motivo do Match com a ONG: ${matchedLead?.motivo_match || 'Atuação compatível com o edital'}
- Dossiê da ONG: ${matchedLead?.dossieText || 'N/A'}

DADOS DO EDITAL MAPEADO:
- ID do Edital: ${editalId || 'N/A'}
- Nome Oficial do Edital: ${editalTitulo}
- Valor Global do Edital: ${editalValorText}
- Prazo de Inscrição: ${editalPrazo}
- Resumo e Requisitos: ${editalResumo}
- Link de Referência: ${editalLink || 'Disponível com a consultora'}

HISTÓRICO ANTERIOR DA CONVERSA:
${conversationHistory || '(Primeiro retorno da ONG após nossa mensagem inicial)'}

MENSAGEM QUE A ONG ACABOU DE ENVIAR NO WHATSAPP:
"${incomingText}"

REGRAS E TRAVAS OBRIGATÓRIAS DA TRIADE ACR:
1. CITAR O EDITAL QUANDO PERGUNTAREM (TRANSPARÊNCIA):
   - Na abordagem inicial ou se a ONG apenas pedir o resumo geral, foque nos pontos principais (${editalValorText}, prazo ${editalPrazo}, aderência com ${orgCidade}).
   - PORÉM, SE A ONG PERGUNTAR EXPLICITAMENTE QUAL É O EDITAL, o órgão/patrocinador, ou mencionar um nome para confirmar (ex: "Qual é o edital?", "Vocês estão falando do PDRSX?", "Vocês têm o edital 2026?"), CITE COM TRANSPARÊNCIA o nome oficial do edital ("${editalTitulo}"${editalId ? `, código Prosas ${editalId}` : ''}), o prazo (${editalPrazo}) e o valor (${editalValorText})${editalLink ? `, e se ajudar pode compartilhar o link (${editalLink})` : ''}. Nunca invente outro edital se não tiver certeza.
2. NÃO AFIRMAR HORÁRIO NEM FECHAR AGENDA SOZINHO (TRAVA DE AGENDA + DIAS ÚTEIS):
   - NUNCA confirme, prometa ou "feche" um horário exato de reunião/ligação (PROIBIDO dizer "Já deixei agendado para às 9h", "Confirmado amanhã às 14h" ou similar).
   - Sugira atendimento EXCLUSIVAMENTE em dias úteis (segunda a sexta, horário comercial) perguntando a preferência de turno (manhã ou tarde).
   - Se a ONG sugerir um horário específico (ex: "Pode ser amanhã às 9h"), responda gentilmente que anotou a preferência de horário e que a consultora sênior Maria Angela Bonifacio confirmará diretamente a disponibilidade na agenda dela. Defina "should_notify_angela": true e registre o horário sugerido em "angela_alert".
3. NÃO PROMETER PERCENTUAL (TRAVA DE PROBABILIDADE):
   - NUNCA mencione, afirme ou prometa nenhum número percentual ("%") na mensagem à ONG — proibido dizer "95% de alinhamento", "100% elegível", "80% de chance" ou percentuais de aprovação/taxa. Use apenas descrições qualitativas (ex: "forte alinhamento", "ótima aderência").
4. PEDIDO DE RESUMO / INTERESSE:
   - Se a ONG responder que aceita o resumo ("Pode sim!", "Manda aí", "Como funciona?"), envie os detalhes claros (${editalValorText}, prazo ${editalPrazo}, foco compatível com a atuação deles em ${orgCidade}, e explique que a Triade ACR cuida da elaboração técnica) e convide para um bate-papo rápido de 10 minutos em dia útil (manhã ou tarde) a confirmar com a Maria Angela.
5. FALTA DE INTERESSE:
   - Se a ONG demonstrar falta de interesse clara ("Não temos interesse", "Pare de mandar mensagem"), agradeça educadamente, deseje sucesso aos projetos da instituição e encerre sem insistir.
6. IDENTIDADE E TOM:
   - Fale SEMPRE como o **assistente / equipe da Maria Angela Bonifacio, da Tríade ACR** (NUNCA diga "Aqui é a Maria Angela" em 1ª pessoa). Tom humano, caloroso, profissional, curto (máximo 3 parágrafos curtos, sem asteriscos duplos `**`) e em português brasileiro.
7. DETECÇÃO DE BOT / URA / ASSUNTO NÃO RELACIONADO:
   - Se a mensagem recebida parecer um robô/URA automático, menu numérico ("Digite 1 para...", "Opção inválida", "Protocolo", "Fatura", "Claro", "Vivo", "Banco", "Assistente virtual") ou assunto sem relação com captação de recursos/editais, classifique OBRIGATORIAMENTE como "unrelated_or_bot", defina "should_auto_reply": false, "should_notify_angela": false e "reply_message": "".
8. OCUPADO / REAGENDAMENTO / INDICAÇÃO DE CONTATO:
   - Se a ONG disser que está ocupada e pedir retorno outro dia útil, confirme de forma curta que retornaremos em dia útil (SEM repetir o pitch e SEM cravar hora exata!) e defina "should_notify_angela": true.
   - Se a ONG enviar um contato ("[Contato compartilhado: ...]") ou indicar outra pessoa ("Esse é o número da minha assessora/coordenadora"), agradeça brevemente, confirme que nossa equipe entrará em contato em dia útil com a pessoa indicada (SEM repetir o pitch!), classifique como "human_handoff", defina "crm_status": "negotiating", "should_notify_angela": true e inclua nome e telefone indicado dentro de "angela_alert".

Responda ESTRITAMENTE em JSON com esta estrutura:
{
  "intent": "interested" | "question" | "asking_grant_name" | "not_interested" | "human_handoff" | "unrelated_or_bot",
  "intent_label": "Rótulo curto em português (ex: '🔥 Interesse Confirmado', '❓ Dúvida sobre Prazo/Como funciona', '📋 Perguntou Nome do Edital', '🛑 Sem Interesse', '🤝 Indicou Contato / Reagendou', '🤖 Bot/Assunto Não Relacionado')",
  "confidence": (número de 0 a 100),
  "analysis": "Explicação curta de 1 frase para a Maria Angela sobre o que a mensagem diz e qual o próximo passo",
  "crm_status": "negotiating" | "contacted" | "archived",
  "should_auto_reply": true | false,
  "should_notify_angela": true | false,
  "reply_message": "Texto exato da resposta para enviar à ONG no WhatsApp (ou string vazia se should_auto_reply for false)",
  "angela_alert": "Resumo curto para notificar o WhatsApp pessoal da Maria Angela (ou string vazia se should_notify_angela for false)"
}
`;

    const aiRes = await sdrModel.generateContent(sdrPrompt);
    const parsed = parseGeminiJsonResponse(aiRes.response.text());

    let autoReplyDispatch = null;
    let angelaAlertDispatch = null;

    const envAutoReplyEnabled =
      (env.WHATSAPP_AUTOREPLY_ENABLED || process.env.WHATSAPP_AUTOREPLY_ENABLED || 'true').toLowerCase() !== 'false';
    const allowAutoSend =
      envAutoReplyEnabled &&
      parsedBody.autoSendReply !== false &&
      parsed.intent !== 'unrelated_or_bot';

    if (allowAutoSend && parsed.should_auto_reply && parsed.reply_message && senderPhone && !isSimulator) {
      autoReplyDispatch = await sendWhatsAppText(senderPhone, parsed.reply_message, {
        simulateTypingMs: 4000,
        overrideConfig: parsedBody.overrideConfig
      });
      if (autoReplyDispatch?.ok) {
        recordAutoReply(normalizedSender);
      }
    }

    const angelaPhone = env.ANGELA_NOTIFY_PHONE || process.env.ANGELA_NOTIFY_PHONE;
    if (
      envAutoReplyEnabled &&
      angelaPhone &&
      parsed.intent !== 'unrelated_or_bot' &&
      parsed.should_notify_angela &&
      parsed.angela_alert &&
      !isSimulator
    ) {
      angelaAlertDispatch = await sendWhatsAppText(angelaPhone, parsed.angela_alert, {
        simulateTypingMs: 1000,
        overrideConfig: parsedBody.overrideConfig
      });
    }

    const angelaStatusNote = !angelaPhone
      ? 'Angela: ANGELA_NOTIFY_PHONE não configurada'
      : angelaAlertDispatch?.ok
        ? 'Angela: alerta enviado'
        : angelaAlertDispatch?.error
          ? `Angela: erro (${angelaAlertDispatch.error})`
          : 'Angela: sem alerta nesta msg';

    const monitor = await logWhatsAppWebhookEvent({
      eventType: autoReplyDispatch?.ok ? 'auto_replied' : 'analyzed_only',
      isSimulator,
      phone: normalizedSender || senderPhone,
      orgNome,
      editalId: matchedLead?.edital_id || null,
      intent: parsed?.intent || null,
      crmStatus: parsed?.crm_status || null,
      incomingText,
      replyMessage: autoReplyDispatch?.ok ? parsed?.reply_message : parsed?.reply_message ? `[Não enviado] ${parsed.reply_message}` : '',
      detail: `${autoReplyDispatch?.error || parsed?.analysis || ''} | ${angelaStatusNote}`.trim()
    });

    return json({
      ok: true,
      autoReplyEnabled: envAutoReplyEnabled,
      senderPhone: normalizedSender,
      matchedOrg: orgNome,
      matchedScore: matchedLead?.score || null,
      matchedUf: matchedLead?.osc?.uf || null,
      matchedEditalId: matchedLead?.edital_id || null,
      incomingText,
      sdrResult: parsed,
      autoReplyDispatch,
      angelaAlertDispatch,
      monitor
    });
  } catch (error: any) {
    console.error('Erro no Webhook WhatsApp IA SDR:', error);
    const errMsg = error?.message || 'Erro interno no Webhook WhatsApp.';

    // Trava 4: Pedir desculpa imediatamente (< 5 min) se o sistema falhar durante atendimento real
    let fallbackApologyDispatch: any = null;
    const envAutoReplyEnabled =
      (env.WHATSAPP_AUTOREPLY_ENABLED || process.env.WHATSAPP_AUTOREPLY_ENABLED || 'true').toLowerCase() !== 'false';

    if (
      !isSimulator &&
      !fromMe &&
      incomingText &&
      senderPhone &&
      matchedLead &&
      envAutoReplyEnabled &&
      parsedBody?.autoSendReply !== false &&
      !isRateLimitedOrLooped(normalizedSender).blocked
    ) {
      fallbackApologyDispatch = await sendWhatsAppText(senderPhone, SYSTEM_FAILURE_APOLOGY_MSG, {
        simulateTypingMs: 2000,
        overrideConfig: parsedBody?.overrideConfig
      }).catch((sendErr: any) => ({ ok: false, error: sendErr?.message || 'Falha no fallback' }));

      if (fallbackApologyDispatch?.ok) {
        recordAutoReply(normalizedSender);
      }

      const angelaPhone = env.ANGELA_NOTIFY_PHONE || process.env.ANGELA_NOTIFY_PHONE;
      if (angelaPhone) {
        const orgLabel = matchedLead?.osc?.nome || senderName || normalizedSender || 'ONG';
        await sendWhatsAppText(
          angelaPhone,
          `⚠️ Falha momentânea no robô ao responder ${orgLabel} (+${normalizedSender || senderPhone}). Enviamos pedido de desculpas automático; confira a conversa. Erro: ${errMsg.slice(0, 120)}`,
          { simulateTypingMs: 1000, overrideConfig: parsedBody?.overrideConfig }
        ).catch(() => {});
      }
    }

    await logWhatsAppWebhookEvent({
      eventType: 'error',
      isSimulator,
      phone: normalizedSender || senderPhone,
      orgNome: matchedLead?.osc?.nome || senderName || null,
      editalId: matchedLead?.edital_id || null,
      incomingText,
      replyMessage: fallbackApologyDispatch?.ok ? SYSTEM_FAILURE_APOLOGY_MSG : '',
      detail: `${errMsg}${fallbackApologyDispatch?.ok ? ' | Fallback de desculpas enviado' : ''}`
    }).catch(() => {});

    return json(
      {
        ok: false,
        error: errMsg,
        fallbackApologySent: !!fallbackApologyDispatch?.ok
      },
      { status: 500 }
    );
  }
}