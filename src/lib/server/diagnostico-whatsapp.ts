import { detectOptOutCommand } from '$lib/server/whatsapp-optout';

export const DEFAULT_DIAGNOSTICO_BASE_URL = 'https://triade-matchmaker-ui.vercel.app';

export interface DiagnosticoCampaignLead {
  cnpj: string;
  nome: string;
  phone: string;
  uf?: string;
  municipio?: string;
  tema?: string;
  ref?: string;
  campanha_tag?: string;
  origem?: 'Lista' | 'Indicacao' | 'Organico';
}

export type DiagnosticoReplyIntent = 'yes' | 'no' | 'wrong_number' | 'bot_or_ura' | 'other';

export interface DiagnosticoReplyClassification {
  intent: DiagnosticoReplyIntent;
  reason: string;
}

const runtimeSentLeads = new Map<string, DiagnosticoCampaignLead>();
const clarificationSentByPhone = new Map<string, number>();
const linkSentByPhone = new Map<string, number>();
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizePhoneDigits(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return `55${digits}`;
}

function normalizeText(text: string | null | undefined): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

export function registerRuntimeDiagnosticoLead(lead: DiagnosticoCampaignLead): void {
  const norm = normalizePhoneDigits(lead.phone);
  if (!norm) return;
  runtimeSentLeads.set(norm, { ...lead, phone: norm });
}

export function findDiagnosticoCampaignLead(
  senderPhone: string | null | undefined,
  staticLeads: DiagnosticoCampaignLead[],
  overrideLead?: Partial<DiagnosticoCampaignLead> | null
): DiagnosticoCampaignLead | null {
  if (overrideLead && overrideLead.cnpj) {
    return {
      cnpj: String(overrideLead.cnpj).replace(/\D/g, ''),
      nome: overrideLead.nome || 'Organização',
      phone: normalizePhoneDigits(overrideLead.phone || senderPhone),
      uf: overrideLead.uf,
      municipio: overrideLead.municipio,
      tema: overrideLead.tema,
      ref: overrideLead.ref,
      campanha_tag: overrideLead.campanha_tag,
      origem: overrideLead.origem || 'Lista'
    };
  }

  const norm = normalizePhoneDigits(senderPhone);
  if (!norm) return null;
  const last8 = norm.slice(-8);

  const fromRuntime = runtimeSentLeads.get(norm);
  if (fromRuntime) return fromRuntime;

  for (const item of runtimeSentLeads.values()) {
    if (item.phone.slice(-8) === last8) return item;
  }

  for (const item of staticLeads) {
    const itemNorm = normalizePhoneDigits(item.phone);
    if (!itemNorm) continue;
    if (itemNorm === norm || itemNorm.slice(-8) === last8) {
      return { ...item, phone: itemNorm };
    }
  }

  return null;
}

export function hasLinkAlreadyBeenSent(phone: string | null | undefined): boolean {
  const norm = normalizePhoneDigits(phone);
  if (!norm) return false;
  const ts = linkSentByPhone.get(norm);
  if (!ts) return false;
  if (Date.now() - ts > STATE_TTL_MS) {
    linkSentByPhone.delete(norm);
    return false;
  }
  return true;
}

export function markLinkSent(phone: string | null | undefined): void {
  const norm = normalizePhoneDigits(phone);
  if (norm) linkSentByPhone.set(norm, Date.now());
}

export function hasClarificationAlreadyBeenSent(phone: string | null | undefined): boolean {
  const norm = normalizePhoneDigits(phone);
  if (!norm) return false;
  const ts = clarificationSentByPhone.get(norm);
  if (!ts) return false;
  if (Date.now() - ts > STATE_TTL_MS) {
    clarificationSentByPhone.delete(norm);
    return false;
  }
  return true;
}

export function markClarificationSent(phone: string | null | undefined): void {
  const norm = normalizePhoneDigits(phone);
  if (norm) clarificationSentByPhone.set(norm, Date.now());
}

/**
 * Constrói o link personalizado do /diagnostico SEM incluir telefone pessoal na URL (LGPD).
 * Usa apenas CNPJ (dado público PJ), origem, campanha e código opaco de referência (ref).
 */
export function buildDiagnosticoUrl(
  lead: Pick<DiagnosticoCampaignLead, 'cnpj' | 'origem' | 'campanha_tag' | 'ref'>,
  baseUrl = DEFAULT_DIAGNOSTICO_BASE_URL
): string {
  const cleanBase = (baseUrl || DEFAULT_DIAGNOSTICO_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams();
  const cleanCnpj = String(lead.cnpj || '').replace(/\D/g, '');
  if (cleanCnpj.length === 14) {
    params.set('cnpj', cleanCnpj);
  }
  params.set('origem', lead.origem || 'Lista');
  if (lead.campanha_tag) {
    params.set('campanha', lead.campanha_tag);
  }
  if (lead.ref) {
    params.set('ref', lead.ref);
  }
  return `${cleanBase}/diagnostico?${params.toString()}`;
}

export function buildDiagnosticoOpenerMessage(lead: Pick<DiagnosticoCampaignLead, 'nome'>): string {
  const orgName = (lead?.nome || 'sua organização').trim();
  return (
    `Olá, equipe da ${orgName}! Aqui é da Tríade Captação de Recursos (Instagram: @triade_acr).\n\n` +
    `Preparamos um autodiagnóstico gratuito (leva cerca de 3 minutos) que mostra o nível de prontidão documental da organização e editais abertos hoje para o seu CNPJ — sem compromisso e sem promessa de aprovação.\n\n` +
    `Deseja receber o link personalizado da ${orgName} por aqui?\n` +
    `Responda *SIM* para receber ou *NÃO* caso prefira não receber mensagens.`
  );
}

export function buildDiagnosticoLinkReplyMessage(
  lead: Pick<DiagnosticoCampaignLead, 'cnpj' | 'nome' | 'origem' | 'campanha_tag' | 'ref'>,
  baseUrl = DEFAULT_DIAGNOSTICO_BASE_URL
): string {
  const orgName = (lead?.nome || 'sua organização').trim();
  const url = buildDiagnosticoUrl(lead, baseUrl);
  return (
    `Prontinho! Aqui está o link personalizado do autodiagnóstico da ${orgName} (já com o CNPJ preenchido):\n\n` +
    `${url}\n\n` +
    `É só abrir pelo celular — leva cerca de 3 minutos e o resultado com a nota (0 a 100), checklist documental e editais compatíveis sai na hora.`
  );
}

export const DIAGNOSTICO_OPT_OUT_REPLY =
  'Combinado! Já registramos sua preferência e bloqueamos este número para não receber novas mensagens da Tríade Captação de Recursos (@triade_acr). Desejamos muito sucesso ao trabalho de vocês!';

export const DIAGNOSTICO_WRONG_NUMBER_REPLY =
  'Peço desculpas pelo engano! Encontramos este telefone nos dados públicos da Receita Federal, mas já removemos e bloqueamos seu número para que não receba novas mensagens da Tríade Captação de Recursos (@triade_acr). Obrigado por avisar!';

export const DIAGNOSTICO_CLARIFICATION_REPLY =
  'Este canal é automático para envio do autodiagnóstico gratuito da Tríade Captação de Recursos (Instagram: @triade_acr). Responda *SIM* para receber o link personalizado (onde explicamos tudo e mostramos editais abertos) ou *NÃO* para não receber novas mensagens.';

/**
 * Classificador determinístico (sem IA) para respostas do funil SIM / NÃO do /diagnostico.
 * Prioridade:
 * 1. Número errado / contador / não é da OSC (bloqueio permanente imediato)
 * 2. Opt-out / NÃO (segurança e LGPD sempre vêm primeiro)
 * 3. Bots / URA / mensagens automáticas de ausência (evita loop entre robôs)
 * 4. SIM / confirmação positiva (envia link personalizado sem telefone na URL)
 * 5. Outros (envia no máximo 1 mensagem curta de orientação SIM/NÃO)
 */
export function classifyDiagnosticoReply(rawText: string | null | undefined): DiagnosticoReplyClassification {
  const raw = String(rawText || '').trim();
  const norm = normalizeText(raw);

  if (!norm) {
    return { intent: 'other', reason: 'Mensagem vazia.' };
  }

  // 1. Número errado / contador / não pertence à OSC
  if (
    /\b(numero errado|engano|sou contador|sou contadora|contabilidade|escritorio contabil|nao sou dessa|nao somos dessa|nao e dessa|nao pertence|nao conheco essa|nao trabalho mais|sai da associacao|ex presidente|antigo numero)\b/i.test(
      norm
    )
  ) {
    return { intent: 'wrong_number', reason: 'Número não pertence à OSC / telefone de contador.' };
  }

  // 2. Opt-out / NÃO (checado antes do SIM para nunca confundir "não quero" com "quero")
  if (detectOptOutCommand(raw)) {
    return { intent: 'no', reason: 'Comando de opt-out detectado.' };
  }

  if (
    /^(nao|n|no|nop|nope|2)[\s.,!?;:]*$/i.test(norm) ||
    /^(nao|no)[\s.,!?;:-]+(obrigad[oa]|obg|valeu|precisa|tenho interesse|temos interesse|quero|queremos|gostaria|desejo|pode|mande|envie|agora)[\s.,!?;:]*$/i.test(
      norm
    ) ||
    /\b(nao temos interesse|nao tenho interesse|sem interesse|dispenso|nao precisa|nao queremos|nao desejamos|nao autorizo|nao pode enviar|nao mande)\b/i.test(
      norm
    ) ||
    raw.includes('👎')
  ) {
    return { intent: 'no', reason: 'Recusa explícita (NÃO).' };
  }

  // 3. Detecção de robô / URA / resposta automática de WhatsApp Business
  if (
    /\b(digite\s+\d|opcao invalida|protocolo|fatura|atendimento automatico|mensagem automatica|assistente virtual|fora do horario|horario de atendimento|obrigado por entrar em contato|agradecemos seu contato|agradecemos o contato|em breve retornaremos|assim que possivel retornaremos|escolha uma opcao|menu principal)\b/i.test(
      norm
    )
  ) {
    return { intent: 'bot_or_ura', reason: 'Resposta automática / URA detectada.' };
  }

  // 4. SIM / aceitação clara (garantindo ausência de negação e ausência de pergunta aberta)
  const hasNegation = /\b(nao|nunca|jamais|sem|nem)\b/i.test(norm);
  const looksLikeQuestion =
    raw.includes('?') ||
    /\b(quem|como funciona|quanto custa|e pago|custa|cobra|conseguiram|pegaram|explicar|explica|golpe|fraude|duvida|o que e)\b/i.test(
      norm
    );

  if (!hasNegation && !looksLikeQuestion) {
    if (
      /^(sim|s|si|siim+|siiim+|ss|ok|okay|1|claro|com certeza|pode|pode sim|pode enviar|pode mandar|pode manda|manda|mande|envia|envie|quero|quero sim|queremos|gostaria|aceito|por favor|pfv|beleza|blz|joia|show|perfeito|otimo|legal|bora|vamos)[\s.,!?;:]*$/i.test(
        norm
      ) ||
      (/^(sim|pode enviar|pode mandar|quero sim|quero receber|quero o link|manda o link|mande o link|envia o link|envie o link|claro|com certeza|ok pode|sim por favor|sim,? pode)\b.*$/i.test(
        norm
      ) &&
        norm.length <= 50) ||
      raw.includes('👍') ||
      raw.includes('✅')
    ) {
      return { intent: 'yes', reason: 'Confirmação positiva (SIM).' };
    }
  }

  // 5. Pergunta livre ou texto ambíguo
  return { intent: 'other', reason: 'Resposta fora do padrão SIM/NÃO.' };
}
