import { detectOptOutCommand } from '$lib/server/whatsapp-optout';

export const DEFAULT_DIAGNOSTICO_BASE_URL = 'https://triade-matchmaker-ui.vercel.app';

export type DiagnosticoOpenerVariant = 'A' | 'B';

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
  variant?: DiagnosticoOpenerVariant;
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

const PT_LOWERCASE_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'em',
  'na',
  'no',
  'nas',
  'nos',
  'a',
  'o',
  'as',
  'os',
  'com',
  'para',
  'por',
  'ao',
  'aos',
  'a',
  'às'
]);

const PT_ACCENT_MAP: Record<string, string> = {
  associacao: 'Associação',
  associacoes: 'Associações',
  federacao: 'Federação',
  organizacao: 'Organização',
  organizacoes: 'Organizações',
  coordenacao: 'Coordenação',
  fundacao: 'Fundação',
  uniao: 'União',
  protecao: 'Proteção',
  secao: 'Seção',
  municipio: 'Município',
  indigena: 'Indígena',
  indigenas: 'Indígenas',
  agricola: 'Agrícola',
  amazonia: 'Amazônia',
  varzea: 'Várzea',
  sao: 'São',
  antonio: 'Antônio',
  ica: 'Içá',
  tefe: 'Tefé',
  alvaraes: 'Alvarães',
  vitoria: 'Vitória',
  regia: 'Régia',
  mae: 'Mãe',
  cancer: 'Câncer',
  artistico: 'Artístico',
  cidadao: 'Cidadão',
  sustentavel: 'Sustentável',
  perolas: 'Pérolas',
  belem: 'Belém',
  solimoes: 'Solimões',
  comunitaria: 'Comunitária',
  esperanca: 'Esperança',
  nucleo: 'Núcleo',
  nao: 'Não',
  governamental: 'Governamental',
  pesca: 'Pesca',
  pescadores: 'Pescadores',
  mulheres: 'Mulheres',
  etnocultural: 'Etnocultural',
  educacao: 'Educação',
  saude: 'Saúde',
  assistencia: 'Assistência',
  infancia: 'Infância',
  adolescencia: 'Adolescência',
  promocao: 'Promoção',
  integracao: 'Integração',
  atuacao: 'Atuação',
  acao: 'Ação',
  preservacao: 'Preservação',
  recuperacao: 'Recuperação',
  instituicao: 'Instituição',
  regiao: 'Região',
  articulacao: 'Articulação',
  amazonidas: 'Amazônidas',
  solidaria: 'Solidária',
  solidarios: 'Solidários',
  solidario: 'Solidário',
  franca: 'França',
  recomecar: 'Recomeçar',
  arvore: 'Árvore',
  amazonico: 'Amazônico',
  inclusao: 'Inclusão',
  deficiencia: 'Deficiência',
  referencia: 'Referência',
  satere: 'Sateré',
  mawe: 'Mawé',
  joao: 'João',
  jose: 'José',
  colonia: 'Colônia',
  maues: 'Maués',
  celia: 'Célia'
};

const KNOWN_ACRONYMS = new Set([
  'ONG',
  'OSC',
  'AM',
  'UBM',
  'OIKAM',
  'APROAM',
  'AASCAM',
  'APAMAAM',
  'AIEA',
  'AMEA',
  'ADACAIBS',
  'APPROSC',
  'ASIPTEAM',
  'ECOCID',
  'ASPREAM',
  'AIETUM',
  'AEATCEB',
  'SGC',
  'IPA',
  'PET',
  'ISMA',
  'IMBA',
  'ASPROAMA',
  'ISANF',
  'IAS',
  'IAFES',
  'ISNB',
  'APRA',
  'CMULHER',
  'COLPESCA'
]);

/**
 * Converte a Razão Social em caixa alta da Receita Federal para um nome curto,
 * natural e legível em português para uso em mensagens humanas de WhatsApp.
 */
export function humanizeOrgName(rawName: string | null | undefined): string {
  let clean = String(rawName || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/g, '')
    .trim();
  if (!clean) return 'sua organização';

  // Remove sufixos burocráticos longos quando o nome excede 42 caracteres
  if (clean.length > 42) {
    clean = clean
      .replace(/\s+(NO|DO)\s+ESTADO\s+DO\s+AMAZONAS(\s*-\s*AM)?$/i, '')
      .replace(/\s+DO\s+MUNICIPIO\s+DE\s+[^-]+$/i, '')
      .replace(/\s*-\s*(AM|AMAZONAS)$/i, '')
      .replace(/\s*-\s*$/g, '')
      .trim();
  }

  // Substitui "ORGANIZACAO NAO GOVERNAMENTAL " por "ONG " para soar natural
  clean = clean.replace(/^ORGANIZACAO\s+NAO\s+GOVERNAMENTAL\s+/i, 'ONG ');

  const words = clean.split(' ');
  const formatted = words.map((word, idx) => {
    if (word === '-' || word === '—') return word;
    const upper = word.toUpperCase();
    const stripped = upper.replace(/[^A-Z]/g, '');
    if (KNOWN_ACRONYMS.has(stripped)) {
      return upper;
    }

    const lower = word.toLowerCase();
    const norm = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (idx > 0 && PT_LOWERCASE_WORDS.has(norm)) {
      return lower;
    }
    if (PT_ACCENT_MAP[norm]) {
      return PT_ACCENT_MAP[norm];
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });

  let result = formatted.join(' ').replace(/\s*-\s*$/, '').trim();

  const trimDanglingPrep = (str: string) =>
    str.replace(/\s+(de|da|do|das|dos|e|em|a|ao|aos|para|com|no|na|nos|nas)$/i, '').trim();

  // Limite visual amigável para não parecer texto colado de banco de dados
  if (result.length > 58) {
    // Se tiver sigla após hífen (ex: "... - UBM"), tenta manter apenas a parte mais limpa
    const dashParts = result.split(' - ');
    if (dashParts.length >= 2 && dashParts[dashParts.length - 1].length <= 12) {
      const sigla = dashParts[dashParts.length - 1].trim();
      const prefix = trimDanglingPrep(dashParts[0].slice(0, 44).replace(/\s+\S*$/, '').trim());
      result = `${prefix} (${sigla})`;
    } else {
      result = trimDanglingPrep(result.slice(0, 56).replace(/\s+\S*$/, '').trim());
    }
  }

  return trimDanglingPrep(result) || 'sua organização';
}

export function getOrgArticle(orgName: string): 'do' | 'da' {
  const firstWord = normalizeText(orgName).split(/\s+/)[0] || '';
  if (
    /^(instituto|centro|conselho|movimento|sindicato|grupo|projeto|forum|fundo|nucleo|coletivo|clube|observatorio|comite|espaco|programa|sistema|servicos|servico)$/.test(
      firstWord
    )
  ) {
    return 'do';
  }
  return 'da';
}

export function humanizeTemaLabel(tema?: string): string {
  const norm = normalizeText(tema);
  if (norm.includes('mulher')) return 'fortalecimento de mulheres';
  if (norm.includes('agro') || norm.includes('rural') || norm.includes('pesca')) {
    return 'agricultura familiar e produção rural';
  }
  if (norm.includes('tradicion') || norm.includes('indigen') || norm.includes('ribeirinh')) {
    return 'povos indígenas e comunidades tradicionais';
  }
  if (norm.includes('animal')) return 'proteção animal e meio ambiente';
  return 'impacto social e desenvolvimento comunitário';
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
      origem: overrideLead.origem || 'Lista',
      variant: overrideLead.variant
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

export function buildDiagnosticoOpenerMessage(
  lead: Pick<DiagnosticoCampaignLead, 'nome' | 'tema' | 'municipio' | 'uf' | 'variant'>
): string {
  const orgName = humanizeOrgName(lead?.nome);
  const orgArt = getOrgArticle(orgName);
  const temaLabel = humanizeTemaLabel(lead?.tema);
  const municipio = (lead?.municipio || '').trim();
  const uf = (lead?.uf || '').trim().toUpperCase();
  const regiao = uf === 'AM' ? 'no Amazonas' : uf ? `em ${uf}` : '';
  const localMunicipio = municipio ? ` em ${municipio}` : regiao ? ` ${regiao}` : '';

  if (lead?.variant === 'B') {
    return (
      `Olá, pessoal ${orgArt} ${orgName}! Aqui é a Maria Angela, da Tríade Captação de Recursos (@triade_acr).\n\n` +
      `Vimos o trabalho de vocês${localMunicipio} com ${temaLabel} e temos editais abertos hoje compatíveis com a instituição.\n\n` +
      `Posso te mandar por aqui um diagnóstico gratuito (3 min) já com os editais abertos para vocês?`
    );
  }

  return (
    `Olá, pessoal ${orgArt} ${orgName}! Tudo bem?\n\n` +
    `Aqui é a Maria Angela, da Tríade Captação de Recursos (@triade_acr). Mapeamos editais abertos nesta semana para projetos de ${temaLabel}${regiao ? ` ${regiao}` : ''} e preparamos uma ferramenta gratuita (3 min) que mostra na hora quais editais combinam com a instituição de vocês.\n\n` +
    `Posso enviar o acesso por aqui? (Caso prefira não receber mensagens, é só responder NÃO.)`
  );
}

export function buildDiagnosticoLinkReplyMessage(
  lead: Pick<DiagnosticoCampaignLead, 'cnpj' | 'nome' | 'origem' | 'campanha_tag' | 'ref'>,
  baseUrl = DEFAULT_DIAGNOSTICO_BASE_URL
): string {
  const orgName = humanizeOrgName(lead?.nome);
  const orgArt = getOrgArticle(orgName);
  const url = buildDiagnosticoUrl(lead, baseUrl);
  return (
    `Prontinho! Aqui está o acesso gratuito do diagnóstico ${orgArt} ${orgName} (já preenchido):\n\n` +
    `${url}\n\n` +
    `É só abrir pelo celular — leva cerca de 3 minutos e o resultado com a nota (0 a 100), checklist documental e editais abertos compatíveis sai na hora.`
  );
}

export const DIAGNOSTICO_OPT_OUT_REPLY =
  'Combinado! Já registramos sua preferência e bloqueamos este número para não receber novas mensagens da Tríade Captação de Recursos (@triade_acr). Desejamos muito sucesso ao trabalho de vocês!';

export const DIAGNOSTICO_WRONG_NUMBER_REPLY =
  'Peço desculpas pelo engano! Encontramos este telefone nos dados públicos da Receita Federal, mas já removemos e bloqueamos seu número para que não receba novas mensagens da Tríade Captação de Recursos (@triade_acr). Obrigado por avisar!';

export const DIAGNOSTICO_CLARIFICATION_REPLY =
  'Este canal é automático para envio do diagnóstico gratuito de editais da Tríade Captação de Recursos (Instagram: @triade_acr). Responda *SIM* para receber o acesso (onde mostramos editais abertos compatíveis) ou *NÃO* para não receber novas mensagens.';

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
    /\b(digite\s+\d|opcao invalida|protocolo|fatura|atendimento automatico|mensagem automatica|assistente virtual|fora do horario|horario de atendimento|obrigado por entrar em contato|agradecemos seu contato|agradecemos o contato|agradece seu contato|agradece o contato|agradecemos sua mensagem|agradecemos a mensagem|nao estamos disponiveis|responderemos assim que possivel|em breve retornaremos|assim que possivel retornaremos|escolha uma opcao|menu principal)\b/i.test(
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
      /^(sim|s|si|siim+|siiim+|ss|ok|okay|1|claro|com certeza|pode|pode sim|pode enviar|pode mandar|pode manda|manda|manda sim|mande|envia|envia sim|envie|quero|quero sim|queremos|gostaria|gostaria sim|aceito|por favor|pfv|beleza|blz|joia|show|perfeito|otimo|legal|bora|vamos)[\s.,!?;:]*$/i.test(
        norm
      ) ||
      (/^(sim|pode enviar|pode mandar|pode sim|quero sim|quero receber|quero o link|manda o link|mande o link|envia o link|envie o link|claro|com certeza|ok pode|sim por favor|sim,? pode)\b.*$/i.test(
        norm
      ) &&
        norm.length <= 60) ||
      (/\b(sim|siim+|pode mandar|pode enviar|pode sim|quero receber|quero sim|manda sim|envia sim|claro que sim|por favor pode|com certeza)\b/i.test(
        norm
      ) &&
        norm.length <= 90) ||
      (/\b(tenho interesse|temos interesse|estou interessad[oa]|estamos interessad[oa]s|gostaria de conhecer|gostariamos de conhecer|quero conhecer|queremos conhecer|gostaria de receber|gostaria de acessar|quero acessar|me envia|me manda|pode nos enviar|pode me enviar|pode me mandar)\b/i.test(
        norm
      ) &&
        norm.length <= 180) ||
      (/^(ola|oi|bom dia|boa tarde|boa noite|tudo bem|tudo bom|tudo otimo)\b.*\b(sim|pode|claro|quero|gostaria|manda|mande|envia|envie|ok|por favor|interesse)\b/i.test(
        norm
      ) &&
        norm.length <= 140) ||
      raw.includes('👍') ||
      raw.includes('✅')
    ) {
      return { intent: 'yes', reason: 'Confirmação positiva (SIM).' };
    }
  }

  // 5. Pergunta livre ou texto ambíguo
  return { intent: 'other', reason: 'Resposta fora do padrão SIM/NÃO.' };
}
