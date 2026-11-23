import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { normalizeBrazilPhone, sendWhatsAppText } from '$lib/server/whatsapp-gateway';
import { logWhatsAppWebhookEvent, upsertFavorableContactToSheet } from '$lib/server/whatsapp-monitor';
import { detectOptOutCommand, isPhoneOptedOut, recordOptOutPhone } from '$lib/server/whatsapp-optout';
import dailyLeadsData from '../../../../data/daily_outbound_leads.json';
import editaisData from '../../../../data/editais_prosas.json';
import mondayQueueData from '../../../../data/monday_followup_queue.json';
import diagnosticoCampaignLeadsData from '../../../../data/diagnostico_campaign_leads.json';
import {
  DEFAULT_DIAGNOSTICO_BASE_URL,
  DIAGNOSTICO_CLARIFICATION_REPLY,
  DIAGNOSTICO_OPT_OUT_REPLY,
  buildDiagnosticoLinkReplyMessage,
  classifyDiagnosticoReply,
  findDiagnosticoCampaignLead,
  hasClarificationAlreadyBeenSent,
  hasLinkAlreadyBeenSent,
  markClarificationSent,
  markLinkSent,
  type DiagnosticoCampaignLead
} from '$lib/server/diagnostico-whatsapp';

const MONDAY_APPROVED_EDITAL_OVERRIDES: Record<
  number,
  { editalId: string | null; editalTitulo: string; editalValor?: string; editalPrazo?: string; editalResumo: string }
> = {
  1: {
    editalId: '19405',
    editalTitulo: 'PDRSX 01/2026 (Desenvolvimento Regional Sustentável do Xingu)',
    editalValor: 'R$ 300 mil até R$ 2 milhões (estruturante) ou até R$ 300 mil (pequeno porte)',
    editalPrazo: '30/11/2026',
    editalResumo: 'PDRSX 01/2026 (Xingu), contrapartida mínima de 10%, 2 anos de atuação comprovada na região do Xingu, Plano de Trabalho e Cronograma obrigatórios na inscrição.'
  },
  2: {
    editalId: '19405',
    editalTitulo: 'PDRSX 01/2026 (Desenvolvimento Regional Sustentável do Xingu)',
    editalValor: 'R$ 300 mil até R$ 2 milhões (estruturante) ou até R$ 300 mil (pequeno porte)',
    editalPrazo: '30/11/2026',
    editalResumo: 'Contato indicado pelo Instituto Bepotire Xikrin (assessora Marcelia). Edital PDRSX 01/2026 (Xingu), contrapartida mínima de 10%, 2 anos de atuação na região.'
  },
  3: {
    editalId: '19405',
    editalTitulo: 'PDRSX 01/2026 (Desenvolvimento Regional Sustentável do Xingu)',
    editalValor: 'R$ 300 mil até R$ 2 milhões (estruturante) ou até R$ 300 mil (pequeno porte)',
    editalPrazo: '30/11/2026',
    editalResumo: 'Contato principal do Instituto Bepotire Xikrin que indicou a assessora Marcelia para tratar do PDRSX 01/2026.'
  },
  4: {
    editalId: '19405',
    editalTitulo: 'PDRSX 01/2026 (Desenvolvimento Regional Sustentável do Xingu)',
    editalValor: 'R$ 300 mil até R$ 2 milhões (estruturante) ou até R$ 300 mil (pequeno porte)',
    editalPrazo: '30/11/2026',
    editalResumo: 'ASSEEFA (Anapu/PA) — apoio técnico na planilha de orçamento, cronograma físico-financeiro e documentos do PDRSX 01/2026.'
  },
  5: {
    editalId: '19405',
    editalTitulo: 'PDRSX 01/2026 (Desenvolvimento Regional Sustentável do Xingu)',
    editalValor: 'R$ 300 mil até R$ 2 milhões (estruturante) ou até R$ 300 mil (pequeno porte)',
    editalPrazo: '30/11/2026',
    editalResumo: 'IPA (Porto de Moz/PA — município incluído no PDRSX 01/2026). Contrapartida mínima de 10%, 2 anos de atuação na região.'
  },
  6: {
    editalId: '19461',
    editalTitulo: 'Recaatingar 001/2026 (FBDS, Iniciativa Floresta Viva)',
    editalValor: 'Sem teto de valor por projeto',
    editalPrazo: '14/12/2026 às 18h',
    editalResumo: 'Recuperação de áreas degradadas da Caatinga (50 a 100 ha). Pão de Açúcar não consta na lista oficial, mas Piranhas, Carneiros, Olivença e São José da Tapera constam.'
  },
  7: {
    editalId: '19461',
    editalTitulo: 'Recaatingar 001/2026 (FBDS) + Chamada Cultural Equatorial Alagoas',
    editalValor: 'Sem teto de valor (Recaatingar)',
    editalPrazo: '14/12/2026 às 18h',
    editalResumo: 'Duas frentes em Alagoas: Recaatingar 001/2026 (Coruripe não consta na lista, mas há municípios elegíveis em AL) e Chamada Cultural Equatorial Alagoas (regras 2026 em conferência).'
  },
  8: {
    editalId: '19461',
    editalTitulo: 'Recaatingar 001/2026 (FBDS) + Chamada Cultural Equatorial Alagoas',
    editalValor: 'Sem teto de valor (Recaatingar)',
    editalPrazo: '14/12/2026 às 18h',
    editalResumo: 'Piranhas/AL está na lista oficial de municípios elegíveis do Recaatingar 001/2026 (50 a 100 ha na Caatinga, CAR ou posse, CNPJ 2+ anos). Também verificando Equatorial Alagoas.'
  },
  9: {
    editalId: '19697',
    editalTitulo: 'Edital Amabio 002/2026 (Banco da Amazônia)',
    editalValor: 'Até R$ 300 mil por projeto',
    editalPrazo: '18/12/2026 às 23h59 (Pipefy)',
    editalResumo: 'Substituiu o edital estadual do Pará (exclusivo para órgãos públicos). Amabio 002/2026 exige CNPJ ativo e matriz na Amazônia Legal constituída até 31/12/2025, bioeconomia amazônica e receita/captação mínima em 2025.'
  },
  10: {
    editalId: '19688',
    editalTitulo: 'Edital de Seleção de Projetos nº 01/2026 — TJPE (Prestações Pecuniárias)',
    editalValor: 'Bloco I até ~R$ 667 mil | Bloco II até ~R$ 95 mil',
    editalPrazo: '30/11/2026 às 23h59 (CadPrest + PJe)',
    editalResumo: 'Entidade privada com finalidade social constituída há mais de 1 ano, projeto executado em Pernambuco (Bloco I Pena Justa ou Bloco II social/educação/saúde).'
  },
  11: {
    editalId: '19289',
    editalTitulo: 'Chamamento Público nº 010/2026 — Prefeitura de Joinville (Infância e Adolescência)',
    editalValor: 'Até R$ 200 mil por projeto (até 2 projetos/OSC)',
    editalPrazo: '13/01/2027 às 23h59 (ou até esgotar recursos)',
    editalResumo: 'Exige registro no CMDCA de Joinville anterior à publicação do edital, execução em Joinville e envio pela aba Autosserviço.'
  },
  12: {
    editalId: null,
    editalTitulo: 'Acompanhamento de novos editais para Manaus/AM (Fundo iFood Chega Junto encerrado)',
    editalValor: 'A mapear conforme perfil da OSC',
    editalPrazo: 'Acompanhamento contínuo',
    editalResumo: 'Fundo iFood Chega Junto teve última janela encerrada em agosto de 2026. Buscando outras oportunidades abertas para Manaus conforme área de atuação, valor e tempo de CNPJ.'
  },
  13: {
    editalId: '19461',
    editalTitulo: 'Recaatingar 001/2026 (FBDS) — Município de Uauá/BA',
    editalValor: 'Sem teto de valor por projeto',
    editalPrazo: '14/12/2026 às 18h (inscrição da associação só entre 03/12 e 14/12)',
    editalResumo: 'PNAB Audiovisual 09/2024 já encerrou. Uauá está na lista oficial do Recaatingar com prioridade muito alta; CNPJ completa 2 anos em 03/12/2026.'
  },
  14: {
    editalId: null,
    editalTitulo: 'Acompanhamento de editais municipais da PNAB e chamadas culturais/sociais em Salvador/BA',
    editalValor: 'A mapear conforme perfil da OSC',
    editalPrazo: 'Acompanhamento contínuo',
    editalResumo: 'PNAB Audiovisual 09/2024 já encerrou. Acompanhando próximas chamadas culturais e sociais adequadas para Salvador/BA.'
  },
  15: {
    editalId: null,
    editalTitulo: 'Acompanhamento de editais municipais da PNAB em Camaçari/BA e chamadas de cultura/capoeira/esporte',
    editalValor: 'A mapear conforme perfil da OSC',
    editalPrazo: 'Acompanhamento contínuo',
    editalResumo: 'PNAB Audiovisual 09/2024 já encerrou. Acompanhando editais adequados para Camaçari/BA e Bahia (cultura, capoeira e esporte).'
  },
  16: {
    editalId: '19289',
    editalTitulo: 'Chamamento Público nº 010/2026 — Prefeitura de Joinville (Infância e Adolescência)',
    editalValor: 'Até R$ 200 mil por projeto',
    editalPrazo: '13/01/2027 às 23h59 (ou até esgotar recursos)',
    editalResumo: 'Verificando se atua com infância/adolescência e possui registro no CMDCA de Joinville anterior ao edital, ou se o foco é estritamente cultural.'
  },
  17: {
    editalId: '19289',
    editalTitulo: 'Chamamento Público nº 010/2026 — Prefeitura de Joinville (Encerramento cordial)',
    editalValor: 'Até R$ 200 mil por projeto',
    editalPrazo: '13/01/2027',
    editalResumo: 'Caso sensível (Instituto P.A.R.E. tem foco ambiental). Mensagem de transparência e encerramento cordial sem novos contatos.'
  }
};

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

interface SharedContactInfo {
  name: string;
  phone: string;
}

type ExtractedMediaType = 'audio' | 'contact' | 'image' | 'video' | 'document' | 'sticker' | 'text' | null;

function parseSharedContacts(rawItems: any[]): SharedContactInfo[] {
  const results: SharedContactInfo[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const vcard = String(item.vcard || '');
    const fnMatch = vcard.match(/^FN[^:]*:(.+)$/im);
    const name =
      (typeof item.name === 'string' ? item.name : item.name?.formatted_name) ||
      item.displayName ||
      (fnMatch ? fnMatch[1].trim() : '') ||
      'Contato';

    const waidMatch = vcard.match(/waid=(\d+)/i);
    const telMatch = vcard.match(/TEL[^:]*:([+\d\s()-]+)/i);
    const arrayPhone =
      (Array.isArray(item.phones) && (item.phones[0]?.phone || item.phones[0]?.wa_id)) ||
      item.phone ||
      item.wa_id ||
      '';
    const rawPhone = String((waidMatch && waidMatch[1]) || (telMatch && telMatch[1]) || arrayPhone || '');
    const phone = rawPhone.replace(/\D/g, '');
    results.push({ name: String(name).trim() || 'Contato', phone });
  }
  return results;
}

function formatSharedContactsSummary(contacts: SharedContactInfo[]): string | null {
  if (!contacts.length) return null;
  return contacts
    .map((c) => `[Contato compartilhado: ${c.name}${c.phone ? ` - Tel: ${c.phone}` : ''}]`)
    .join(' | ');
}

function extractIncomingPayload(body: any): {
  senderPhone: string | null;
  rawChatId?: string | null;
  incomingText: string | null;
  fromMe: boolean;
  senderName?: string;
  mediaType?: ExtractedMediaType;
  sharedContacts?: SharedContactInfo[];
} {
  // 1. Direct / UI Simulator payload (only when explicit incomingText is provided)
  if (body?.incomingText) {
    return {
      senderPhone:
        body.phone ||
        body.lead?.contatos_encontrados?.whatsapp ||
        body.lead?.osc?.official_contacts?.ddd_telefone_1 ||
        '5511999999999',
      rawChatId: null,
      incomingText: String(body.incomingText),
      fromMe: false,
      senderName: body.lead?.osc?.nome || body.senderName,
      mediaType: 'text'
    };
  }

  // 2. Whapi.cloud webhook format (messages array)
  if (Array.isArray(body?.messages) && body.messages[0]) {
    const msg = body.messages[0];
    const chatId = msg.chat_id || msg.from || '';
    const msgType = String(msg.type || '').toLowerCase();

    const rawContacts = [
      ...(msg.contact ? [msg.contact] : []),
      ...(Array.isArray(msg.contacts) ? msg.contacts : []),
      ...(Array.isArray(msg.contact_list) ? msg.contact_list : []),
      ...(Array.isArray(msg.contact_list?.list) ? msg.contact_list.list : [])
    ];
    const sharedContacts = parseSharedContacts(rawContacts);
    const contactSummary = formatSharedContactsSummary(sharedContacts);

    const audioObj = msg.voice || msg.audio || msg.ptt;
    let incomingText: string | null = msg.text?.body || msg.voice?.caption || msg.audio?.caption || null;
    let mediaType: ExtractedMediaType = incomingText ? 'text' : null;

    if (contactSummary) {
      incomingText = contactSummary;
      mediaType = 'contact';
    } else if (!incomingText && (audioObj || msgType === 'voice' || msgType === 'audio' || msgType === 'ptt')) {
      const seconds = audioObj?.seconds || audioObj?.duration || null;
      const link = audioObj?.link || audioObj?.url || null;
      const caption = audioObj?.caption || msg.caption || null;
      incomingText = `[Áudio recebido${seconds ? ` (${seconds}s)` : ''}${link ? ` — ${link}` : ' — ouvir no WhatsApp'}${caption ? ` | Legenda: ${caption}` : ''}]`;
      mediaType = 'audio';
    } else if (!incomingText && (msg.image || msgType === 'image')) {
      const caption = msg.image?.caption || msg.caption || null;
      incomingText = caption || '[Imagem recebida — ver no WhatsApp]';
      mediaType = 'image';
    } else if (!incomingText && (msg.video || msgType === 'video')) {
      const caption = msg.video?.caption || msg.caption || null;
      incomingText = caption || '[Vídeo recebido — ver no WhatsApp]';
      mediaType = 'video';
    } else if (!incomingText && (msg.document || msgType === 'document')) {
      const caption = msg.document?.caption || msg.caption || null;
      const filename = msg.document?.filename || msg.document?.file_name || null;
      incomingText = caption || `[Documento recebido${filename ? `: ${filename}` : ''} — ver no WhatsApp]`;
      mediaType = 'document';
    } else if (!incomingText && (msg.sticker || msgType === 'sticker')) {
      incomingText = '[Figurinha recebida]';
      mediaType = 'sticker';
    }

    return {
      senderPhone: chatId.split('@')[0],
      rawChatId: chatId,
      incomingText,
      fromMe: !!msg.from_me,
      senderName: msg.from_name,
      mediaType,
      sharedContacts: sharedContacts.length ? sharedContacts : undefined
    };
  }

  // 3. Evolution API v1/v2 webhook format (messages.upsert)
  if (body?.data?.key?.remoteJid) {
    const jid: string = body.data.key.remoteJid;
    const fromMe = !!body.data.key.fromMe;
    const senderPhone = jid.split('@')[0];
    const msgObj = body.data.message || {};

    const rawContacts = [
      ...(msgObj.contactMessage ? [{ name: msgObj.contactMessage.displayName, vcard: msgObj.contactMessage.vcard }] : []),
      ...(Array.isArray(msgObj.contactsArrayMessage?.contacts) ? msgObj.contactsArrayMessage.contacts : [])
    ];
    const sharedContacts = parseSharedContacts(rawContacts);
    const contactSummary = formatSharedContactsSummary(sharedContacts);

    let text: string | null =
      msgObj.conversation ||
      msgObj.extendedTextMessage?.text ||
      msgObj.audioMessage?.caption ||
      msgObj.imageMessage?.caption ||
      msgObj.documentMessage?.caption ||
      body.data?.body ||
      null;
    let mediaType: ExtractedMediaType = text ? 'text' : null;

    if (contactSummary) {
      text = contactSummary;
      mediaType = 'contact';
    } else if (!text && msgObj.audioMessage) {
      const seconds = msgObj.audioMessage.seconds || null;
      text = `[Áudio recebido${seconds ? ` (${seconds}s)` : ''} — ouvir no WhatsApp]`;
      mediaType = 'audio';
    } else if (!text && msgObj.imageMessage) {
      text = '[Imagem recebida — ver no WhatsApp]';
      mediaType = 'image';
    } else if (!text && msgObj.documentMessage) {
      const fname = msgObj.documentMessage.fileName || '';
      text = `[Documento recebido${fname ? `: ${fname}` : ''} — ver no WhatsApp]`;
      mediaType = 'document';
    }

    return {
      senderPhone,
      rawChatId: jid,
      incomingText: text,
      fromMe,
      senderName: body.data.pushName,
      mediaType,
      sharedContacts: sharedContacts.length ? sharedContacts : undefined
    };
  }

  // 4. Z-API webhook format
  if (body?.phone && (body?.text?.message || body?.audio?.audioUrl || body?.contact || body?.image || body?.document)) {
    const sharedContacts = body.contact ? parseSharedContacts([body.contact]) : [];
    const contactSummary = formatSharedContactsSummary(sharedContacts);
    let text: string | null = body.text?.message || null;
    let mediaType: ExtractedMediaType = text ? 'text' : null;
    if (contactSummary) {
      text = contactSummary;
      mediaType = 'contact';
    } else if (!text && body.audio?.audioUrl) {
      text = `[Áudio recebido — ${body.audio.audioUrl}]`;
      mediaType = 'audio';
    } else if (!text && body.image) {
      text = body.image.caption || '[Imagem recebida — ver no WhatsApp]';
      mediaType = 'image';
    } else if (!text && body.document) {
      text = body.document.caption || '[Documento recebido — ver no WhatsApp]';
      mediaType = 'document';
    }
    return {
      senderPhone: body.phone,
      rawChatId: body.chatId || null,
      incomingText: text,
      fromMe: !!body.fromMe,
      senderName: body.senderName,
      mediaType,
      sharedContacts: sharedContacts.length ? sharedContacts : undefined
    };
  }

  // 5. Green-API webhook format
  if (body?.senderData?.chatId && body?.messageData) {
    const msgData = body.messageData;
    const sharedContacts = msgData.contactMessageData ? parseSharedContacts([msgData.contactMessageData]) : [];
    const contactSummary = formatSharedContactsSummary(sharedContacts);
    let text: string | null =
      msgData.textMessageData?.textMessage ||
      msgData.extendedTextMessageData?.text ||
      msgData.fileMessageData?.caption ||
      null;
    let mediaType: ExtractedMediaType = text ? 'text' : null;
    if (contactSummary) {
      text = contactSummary;
      mediaType = 'contact';
    } else if (!text && msgData.typeMessage === 'audioMessage') {
      text = `[Áudio recebido${msgData.fileMessageData?.downloadUrl ? ` — ${msgData.fileMessageData.downloadUrl}` : ' — ouvir no WhatsApp'}]`;
      mediaType = 'audio';
    }
    return {
      senderPhone: body.senderData.chatId.split('@')[0],
      rawChatId: body.senderData.chatId,
      incomingText: text,
      fromMe: body.typeWebhook === 'outgoingMessageReceived' || body.typeWebhook === 'outgoingAPIMessageReceived',
      senderName: body.senderData.senderName,
      mediaType,
      sharedContacts: sharedContacts.length ? sharedContacts : undefined
    };
  }

  // 6. Meta Official WhatsApp Cloud API format
  const metaChange = body?.entry?.[0]?.changes?.[0]?.value;
  if (metaChange?.messages?.[0]) {
    const msg = metaChange.messages[0];
    const sharedContacts = Array.isArray(msg.contacts) ? parseSharedContacts(msg.contacts) : [];
    const contactSummary = formatSharedContactsSummary(sharedContacts);
    let text: string | null = msg.text?.body || msg.image?.caption || msg.document?.caption || null;
    let mediaType: ExtractedMediaType = text ? 'text' : null;
    if (contactSummary) {
      text = contactSummary;
      mediaType = 'contact';
    } else if (!text && msg.type === 'audio') {
      text = '[Áudio recebido — ouvir no WhatsApp]';
      mediaType = 'audio';
    }
    return {
      senderPhone: msg.from,
      rawChatId: msg.from,
      incomingText: text,
      fromMe: false,
      senderName: metaChange.contacts?.[0]?.profile?.name,
      mediaType,
      sharedContacts: sharedContacts.length ? sharedContacts : undefined
    };
  }

  return { senderPhone: null, rawChatId: null, incomingText: null, fromMe: false, mediaType: null };
}

function findMatchingMondayContact(rawPhone: string | null) {
  if (!rawPhone) return null;
  const normalizedTarget = normalizeBrazilPhone(rawPhone);
  if (!normalizedTarget) return null;
  const last8 = normalizedTarget.slice(-8);

  const queueArray = Array.isArray(mondayQueueData) ? mondayQueueData : [];
  for (const item of queueArray) {
    const normCandidate = normalizeBrazilPhone((item as any).phone);
    if (normCandidate && normCandidate.slice(-8) === last8) {
      return item as { order: number; org: string; phone: string; message: string };
    }
  }
  return null;
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
  let mondayMatch: { order: number; org: string; phone: string; message: string } | null = null;
  let effectiveEditalId: string | null = null;
  let normalizedSender: string | null = null;

  // Opção A (Segunda 16/11): Bot em modo somente análise + log (WhatsApp_Log) para revisão manual.
  // Respostas automáticas de IA para ONGs ficam pausadas; Opt-Out (PARAR) continua gravando na aba Opt_Out.
  const isAutoReplyActive = false;

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
    mondayMatch = !parsedBody.lead ? findMatchingMondayContact(senderPhone) : null;
    const mondayOverride = mondayMatch ? MONDAY_APPROVED_EDITAL_OVERRIDES[mondayMatch.order] : null;
    effectiveEditalId = mondayOverride
      ? mondayOverride.editalId
      : matchedLead?.edital_id
        ? String(matchedLead.edital_id)
        : null;
    normalizedSender = normalizeBrazilPhone(senderPhone);
    const earlyOrgNome = mondayMatch?.org || matchedLead?.osc?.nome || senderName || 'Organização';

    // Bloqueio permanente: se já está em Opt-Out (PARAR) ou CESAR, ignora imediatamente
    const existingOptOut = await isPhoneOptedOut(normalizedSender || senderPhone);
    if (existingOptOut.blocked) {
      if (!isSimulator) {
        await logWhatsAppWebhookEvent({
          eventType: 'ignored',
          isSimulator,
          phone: normalizedSender || senderPhone,
          orgNome: earlyOrgNome,
          editalId: effectiveEditalId,
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

    // Fluxo determinístico SIM / NÃO exclusivo da campanha /diagnostico (sem IA e sem trabalho manual)
    const diagnosticoLead = findDiagnosticoCampaignLead(
      senderPhone,
      (Array.isArray(diagnosticoCampaignLeadsData) ? diagnosticoCampaignLeadsData : []) as DiagnosticoCampaignLead[],
      parsedBody.mode === 'diagnostico' ? parsedBody.diagnosticoLead : null
    );

    if (diagnosticoLead) {
      const isDiagnosticoAutoReplyEnabled =
        (env.DIAGNOSTICO_AUTOREPLY_ENABLED || process.env.DIAGNOSTICO_AUTOREPLY_ENABLED || 'true').toLowerCase() !==
        'false';
      const canSendNow =
        !isSimulator && isDiagnosticoAutoReplyEnabled && parsedBody.autoSendReply !== false && Boolean(senderPhone);
      const classification = classifyDiagnosticoReply(incomingText);
      const diagOrgNome = diagnosticoLead.nome || earlyOrgNome;
      const diagPhoneKey = normalizedSender || senderPhone || diagnosticoLead.phone;

      if (classification.intent === 'no') {
        const optOutRecord = !isSimulator
          ? await recordOptOutPhone({
              phone: diagPhoneKey,
              orgNome: diagOrgNome,
              reason: `Autodiagnóstico NÃO: ${incomingText}`
            })
          : { ok: true, recordedToSheets: false };

        let replyDispatch: any = null;
        if (canSendNow && senderPhone) {
          replyDispatch = await sendWhatsAppText(senderPhone, DIAGNOSTICO_OPT_OUT_REPLY, {
            simulateTypingMs: 2000,
            overrideConfig: parsedBody.overrideConfig,
            bypassOptOutCheck: true
          });
        }

        const monitor = await logWhatsAppWebhookEvent({
          eventType: 'opt_out',
          isSimulator,
          phone: diagPhoneKey,
          orgNome: diagOrgNome,
          editalId: 'AUTODIAGNOSTICO',
          intent: 'diagnostico_nao',
          crmStatus: 'archived',
          incomingText,
          replyMessage: replyDispatch?.ok ? DIAGNOSTICO_OPT_OUT_REPLY : `[Opt-Out registrado] ${DIAGNOSTICO_OPT_OUT_REPLY}`,
          detail: `${classification.reason} | Sheets Opt_Out: ${optOutRecord.recordedToSheets}`
        });

        return json({
          ok: true,
          mode: 'diagnostico',
          intent: 'no',
          optOutRecorded: true,
          recordedToSheets: optOutRecord.recordedToSheets,
          matchedOrg: diagOrgNome,
          replyMessage: DIAGNOSTICO_OPT_OUT_REPLY,
          autoReplyDispatch: replyDispatch,
          monitor
        });
      }

      if (classification.intent === 'bot_or_ura') {
        await logWhatsAppWebhookEvent({
          eventType: 'ignored',
          isSimulator,
          phone: diagPhoneKey,
          orgNome: diagOrgNome,
          editalId: 'AUTODIAGNOSTICO',
          intent: 'diagnostico_bot',
          incomingText,
          detail: classification.reason
        });
        return json({
          ok: true,
          mode: 'diagnostico',
          ignored: true,
          intent: 'bot_or_ura',
          reason: classification.reason
        });
      }

      if (classification.intent === 'yes') {
        if (!isSimulator && hasLinkAlreadyBeenSent(diagPhoneKey)) {
          return json({
            ok: true,
            mode: 'diagnostico',
            ignored: true,
            intent: 'yes',
            reason: 'Link personalizado do /diagnostico já enviado recentemente para este número.'
          });
        }

        const baseUrl = (env.PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || '').trim() || DEFAULT_DIAGNOSTICO_BASE_URL;
        const linkReply = buildDiagnosticoLinkReplyMessage(
          { ...diagnosticoLead, phone: diagPhoneKey },
          baseUrl
        );

        let replyDispatch: any = null;
        if (canSendNow && senderPhone) {
          replyDispatch = await sendWhatsAppText(senderPhone, linkReply, {
            simulateTypingMs: 2500,
            overrideConfig: parsedBody.overrideConfig
          });
          if (replyDispatch?.ok) {
            markLinkSent(diagPhoneKey);
          }
        }

        const monitor = await logWhatsAppWebhookEvent({
          eventType: 'processed',
          isSimulator,
          phone: diagPhoneKey,
          orgNome: diagOrgNome,
          editalId: 'AUTODIAGNOSTICO',
          intent: 'diagnostico_sim',
          crmStatus: 'contacted',
          incomingText,
          replyMessage: linkReply,
          detail: `${classification.reason} | AutoReply: ${isDiagnosticoAutoReplyEnabled}`
        });

        return json({
          ok: true,
          mode: 'diagnostico',
          intent: 'yes',
          matchedOrg: diagOrgNome,
          replyMessage: linkReply,
          autoReplyDispatch: replyDispatch,
          monitor
        });
      }

      // Outras mensagens (perguntas abertas / áudio / texto fora de SIM/NÃO): no máximo 1 lembrete automático
      if (!isSimulator && (hasLinkAlreadyBeenSent(diagPhoneKey) || hasClarificationAlreadyBeenSent(diagPhoneKey))) {
        await logWhatsAppWebhookEvent({
          eventType: 'ignored',
          isSimulator,
          phone: diagPhoneKey,
          orgNome: diagOrgNome,
          editalId: 'AUTODIAGNOSTICO',
          intent: 'diagnostico_other_muted',
          incomingText,
          detail: 'Orientação automática SIM/NÃO ou link já enviado anteriormente (anti-loop).'
        });
        return json({
          ok: true,
          mode: 'diagnostico',
          ignored: true,
          intent: 'other',
          reason: 'Orientação SIM/NÃO ou link já enviado anteriormente.'
        });
      }

      let clarificationDispatch: any = null;
      if (canSendNow && senderPhone) {
        clarificationDispatch = await sendWhatsAppText(senderPhone, DIAGNOSTICO_CLARIFICATION_REPLY, {
          simulateTypingMs: 2000,
          overrideConfig: parsedBody.overrideConfig
        });
        if (clarificationDispatch?.ok) {
          markClarificationSent(diagPhoneKey);
        }
      }

      const monitor = await logWhatsAppWebhookEvent({
        eventType: 'processed',
        isSimulator,
        phone: diagPhoneKey,
        orgNome: diagOrgNome,
        editalId: 'AUTODIAGNOSTICO',
        intent: 'diagnostico_other',
        crmStatus: 'contacted',
        incomingText,
        replyMessage: DIAGNOSTICO_CLARIFICATION_REPLY,
        detail: `${classification.reason} | Enviado 1 lembrete SIM/NÃO`
      });

      return json({
        ok: true,
        mode: 'diagnostico',
        intent: 'other',
        matchedOrg: diagOrgNome,
        replyMessage: DIAGNOSTICO_CLARIFICATION_REPLY,
        autoReplyDispatch: clarificationDispatch,
        monitor
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

      let optOutReplyDispatch: any = null;
      if (!isSimulator && isAutoReplyActive && parsedBody.autoSendReply !== false && senderPhone) {
        optOutReplyDispatch = await sendWhatsAppText(senderPhone, optOutReply, {
          simulateTypingMs: 2500,
          overrideConfig: parsedBody.overrideConfig,
          bypassOptOutCheck: true // envia apenas esta última confirmação de remoção
        });
      }

      const angelaPhone = env.ANGELA_NOTIFY_PHONE || process.env.ANGELA_NOTIFY_PHONE;
      if (!isSimulator && isAutoReplyActive && angelaPhone) {
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
        editalId: effectiveEditalId,
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
          should_auto_reply: false,
          should_notify_angela: true,
          reply_message: optOutReply,
          analysis: 'Contato respondeu PARAR e foi gravado na aba Opt_Out para bloqueio definitivo.'
        },
        autoReplyDispatch: optOutReplyDispatch,
        monitor
      });
    }

    if (!isSimulator && !matchedLead && !mondayMatch) {
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
          orgNome: earlyOrgNome,
          editalId: effectiveEditalId,
          incomingText,
          detail: rateCheck.reason
        });
        return json({ ok: true, ignored: true, reason: rateCheck.reason });
      }
    }

    const editaisArray = Array.isArray(editaisData) ? editaisData : [];
    const matchedEdital: any = effectiveEditalId
      ? editaisArray.find((e: any) => String(e.id) === String(effectiveEditalId))
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

    const orgNome = earlyOrgNome;
    const orgCidade = matchedLead?.osc?.municipio ? `${matchedLead.osc.municipio}/${matchedLead.osc.uf}` : 'Brasil';
    const rawEditalValor =
      matchedLead?.edital_valor ||
      matchedEdital?.attributes?.valor_total ||
      matchedEdital?.deep_metadata?.financeiro?.valor_maximo_ou_global_reais ||
      matchedEdital?.deep_metadata?.financeiro?.valor_total_edital ||
      null;
    const editalValorText = mondayOverride?.editalValor || formatEditalValorPtBr(rawEditalValor);
    const editalPrazo =
      mondayOverride?.editalPrazo ||
      matchedLead?.edital_prazo ||
      matchedEdital?.deep_metadata?.prazo_de_inscricao ||
      matchedEdital?.attributes?.data_fim ||
      'inscrições abertas';
    const editalTitulo =
      mondayOverride?.editalTitulo ||
      matchedLead?.edital_titulo ||
      matchedEdital?.attributes?.nome ||
      matchedEdital?.titulo ||
      'Edital de Fomento';
    const editalId = effectiveEditalId || '';
    const editalResumo =
      mondayOverride?.editalResumo ||
      matchedEdital?.deep_metadata?.resumo_objetivo ||
      matchedLead?.motivo_match ||
      'Edital voltado para projetos de impacto social.';
    const editalLink =
      matchedEdital?.deep_metadata?.drive_pdf_link ||
      matchedEdital?.public_url ||
      '';
    const conversationHistory =
      Array.isArray(parsedBody.history) && parsedBody.history.length > 0
        ? parsedBody.history.map((h: any) => `${h.role === 'ong' ? 'ONG' : 'Triade'}: ${h.text}`).join('\n')
        : mondayMatch?.message
          ? `Triade: ${mondayMatch.message}`
          : '';

    const sdrPrompt = `
Você é o Assistente de Triagem e Captação da consultora sênior **Maria Angela Bonifacio**, da **Triade ACR (Assessoria em Captação de Recursos)** no WhatsApp.

CONTEXTO DO LEAD (ONG QUE ESTÁ RESPONDENDO):
- Nome da ONG: ${orgNome} (${orgCidade})
- Motivo do Match com a ONG: ${mondayOverride ? mondayOverride.editalResumo : matchedLead?.motivo_match || 'Atuação compatível com o edital'}
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
   - Fale SEMPRE como o **assistente / equipe da Maria Angela Bonifacio, da Tríade ACR** (NUNCA diga "Aqui é a Maria Angela" em 1ª pessoa). Tom humano, caloroso, profissional, curto (máximo 3 parágrafos curtos, sem asteriscos duplos de negrito) e em português brasileiro.
7. DETECÇÃO DE BOT / URA / ASSUNTO NÃO RELACIONADO:
   - Se a mensagem recebida parecer um robô/URA automático, menu numérico ("Digite 1 para...", "Opção inválida", "Protocolo", "Fatura", "Claro", "Vivo", "Banco", "Assistente virtual") ou assunto sem relação com captação de recursos/editais, classifique OBRIGATORIAMENTE como "unrelated_or_bot", defina "should_auto_reply": false, "should_notify_angela": false e "reply_message": "".
8. OCUPADO / REAGENDAMENTO / INDICAÇÃO DE CONTATO:
   - Se a ONG disser que está ocupada e pedir retorno outro dia útil, confirme de forma curta que retornaremos em dia útil (SEM repetir o pitch e SEM cravar hora exata!) e defina "should_notify_angela": true.
   - Se a ONG enviar um contato ("[Contato compartilhado: ...]") ou indicar outra pessoa ("Esse é o número da minha assessora/coordenadora"), agradeça brevemente, confirme que nossa equipe entrará em contato em dia útil com a pessoa indicada (SEM repetir o pitch!), classifique como "human_handoff", defina "crm_status": "negotiating", "should_notify_angela": true e inclua nome e telefone indicado dentro de "angela_alert".
9. ÁUDIO E MÍDIA RECEBIDA:
   - Se a mensagem recebida for um áudio ("[Áudio recebido ...]") ou mídia enviada por um lead abordado, NUNCA classifique como "unrelated_or_bot". Classifique como "human_handoff", defina "crm_status": "negotiating", "should_notify_angela": true, "should_auto_reply": false e oriente em "analysis" e "angela_alert" a ouvir o áudio diretamente no WhatsApp.

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

    // Garantia determinística: áudio ou cartão de contato de um lead nunca deve virar "unrelated_or_bot"
    if (extracted.mediaType === 'audio' && parsed?.intent === 'unrelated_or_bot') {
      parsed.intent = 'human_handoff';
      parsed.intent_label = '🎙️ Áudio Recebido (Ouvir no WhatsApp)';
      parsed.crm_status = 'negotiating';
      parsed.should_auto_reply = false;
      parsed.should_notify_angela = true;
      parsed.analysis = parsed.analysis || 'ONG enviou um áudio no WhatsApp; requer escuta manual pela Maria Angela.';
    }
    if ((extracted.mediaType === 'contact' || extracted.sharedContacts?.length) && parsed?.intent === 'unrelated_or_bot') {
      parsed.intent = 'human_handoff';
      parsed.intent_label = '🤝 Contato Compartilhado';
      parsed.crm_status = 'negotiating';
      parsed.should_auto_reply = false;
      parsed.should_notify_angela = true;
    }

    let autoReplyDispatch = null;
    let angelaAlertDispatch = null;

    const allowAutoSend =
      isAutoReplyActive &&
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
      isAutoReplyActive &&
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

    const angelaStatusNote = !isAutoReplyActive
      ? 'Modo somente análise (Opção A): auto-resposta pausada'
      : !angelaPhone
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
      editalId: effectiveEditalId,
      intent: parsed?.intent || null,
      crmStatus: parsed?.crm_status || null,
      incomingText,
      replyMessage: autoReplyDispatch?.ok ? parsed?.reply_message : parsed?.reply_message ? `[Não enviado] ${parsed.reply_message}` : '',
      detail: `${autoReplyDispatch?.error || parsed?.analysis || ''} | ${angelaStatusNote}`.trim()
    });

    const isFavorableOrHandoff =
      parsed?.intent === 'interested' ||
      parsed?.intent === 'human_handoff' ||
      extracted.mediaType === 'audio' ||
      !!(extracted.sharedContacts && extracted.sharedContacts.length > 0);

    let favorableContactsSynced = 0;
    if (isFavorableOrHandoff) {
      const editalLabel = editalId ? `${editalTitulo} (${editalId})` : editalTitulo;
      const primarySynced = await upsertFavorableContactToSheet({
        isSimulator,
        contactName: senderName || 'Contato principal',
        orgNome,
        phone: normalizedSender || senderPhone || '',
        editalLabel,
        statusNote: parsed?.intent_label || parsed?.intent || 'Retorno favorável',
        observation: parsed?.analysis || incomingText.slice(0, 140)
      });
      if (primarySynced) favorableContactsSynced += 1;

      if (extracted.sharedContacts?.length) {
        for (const sc of extracted.sharedContacts) {
          if (!sc.phone && !sc.name) continue;
          const scSynced = await upsertFavorableContactToSheet({
            isSimulator,
            contactName: `${sc.name || 'Contato'} (Indicação)`,
            orgNome,
            phone: sc.phone || '',
            editalLabel,
            statusNote: 'Contato compartilhado para continuidade',
            observation: `Indicado por +${normalizedSender || senderPhone || ''}`
          });
          if (scSynced) favorableContactsSynced += 1;
        }
      }
    }

    return json({
      ok: true,
      autoReplyEnabled: isAutoReplyActive,
      senderPhone: normalizedSender,
      matchedOrg: orgNome,
      matchedScore: matchedLead?.score || null,
      matchedUf: matchedLead?.osc?.uf || null,
      matchedEditalId: effectiveEditalId,
      mondayBatchOrder: mondayMatch?.order || null,
      mediaType: extracted.mediaType || 'text',
      sharedContacts: extracted.sharedContacts || [],
      incomingText,
      sdrResult: parsed,
      autoReplyDispatch,
      angelaAlertDispatch,
      favorableContactsSynced,
      monitor
    });
  } catch (error: any) {
    console.error('Erro no Webhook WhatsApp IA SDR:', error);
    const errMsg = error?.message || 'Erro interno no Webhook WhatsApp.';

    // Trava 4: Pedir desculpa imediatamente (< 5 min) apenas se o auto-atendimento estiver ativo
    let fallbackApologyDispatch: any = null;

    if (
      isAutoReplyActive &&
      !isSimulator &&
      !fromMe &&
      incomingText &&
      senderPhone &&
      (matchedLead || mondayMatch) &&
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
        const orgLabel = mondayMatch?.org || matchedLead?.osc?.nome || senderName || normalizedSender || 'ONG';
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
      orgNome: mondayMatch?.org || matchedLead?.osc?.nome || senderName || null,
      editalId: effectiveEditalId,
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